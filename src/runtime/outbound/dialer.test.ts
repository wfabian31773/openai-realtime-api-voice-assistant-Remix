import { afterEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import {
  DEFAULT_INFRA_RETRY_MINUTES,
  DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES,
  MAX_INFRA_RETRY_MINUTES,
  REFUSAL_STREAK_WINDOW_MS,
  resolvedInfraRetryMinutes,
  resolvedMaxConsecutiveInfraRetries,
} from "./campaign";
import {
  CALLBACK_ROUTE_TTL_MS,
  STALE_CLAIM_MS,
  answerUrl,
  callbackRoutingProblem,
  isClearTwilioRefusal,
  nextLookAt,
  reapNextAttemptAt,
  runCampaignTick,
  statusUrl,
  type OutboundTwilio,
} from "./dialer";
import { handleOutboundStatus } from "./outboundWebhook";
import { NOT_PLACED } from "./store";
import { FakeOutboundStore } from "./store.testkit";
import { getTool } from "../../tools/registry";
import { RECORD_OUTCOME_TOOL_NAME, setOutboundToolStoreForTests } from "../../tools/outboundTools";
import type { WebhookRequest } from "../voiceWebhook";

/** The Twilio SDK's RestException: `name` is the class, `status` is HTTP. */
function restException(status: number, message = "refused"): Error & { status: number } {
  const err = Object.assign(new Error(message), { status });
  err.name = "RestException";
  return err;
}

// Tuesday 10 AM Pacific.
const NOW = new Date("2041-03-05T18:00:00Z");
const ON = { RUNTIME_OUTBOUND_DIALING: "1", OUTBOUND_CAMPAIGN_TEST: "1", OUTBOUND_TEST_FROM: "+15555550100" };

const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 2,
  greeting: () => "Hello, this is an automated assistant calling for Azul Vision. This call is recorded.",
  voicemail: () => "Hello, this is Azul Vision.",
};

function setup(env: Record<string, string> = ON) {
  const store = new FakeOutboundStore(() => NOW);
  let n = 0;
  const createCall = vi.fn(async () => ({ sid: `CA${String(++n).padStart(32, "0")}` }));
  // The caller ID's Voice URL points back at the lane, as production's must.
  const voiceUrlFor = vi.fn(async (_n: string): Promise<string | null> => "https://voice.example.test/voice/test-lane");
  const twilio: OutboundTwilio = { createCall, voiceUrlFor };
  const deps = { store, twilio, env, host: "voice.example.test", now: () => NOW, log: () => undefined };
  return { store, createCall, voiceUrlFor, deps };
}

describe("nothing dials unless it is switched on", () => {
  it("needs the fleet switch", async () => {
    const { store, createCall, deps } = setup({ ...ON, RUNTIME_OUTBOUND_DIALING: "0" });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toBe("disabled");
    expect(createCall).not.toHaveBeenCalled();
  });

  it("needs the campaign's own switch", async () => {
    const { store, createCall, deps } = setup({ ...ON, OUTBOUND_CAMPAIGN_TEST: "" });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toBe("disabled");
    expect(createCall).not.toHaveBeenCalled();
  });

  it("needs a caller ID", async () => {
    const { store, createCall, deps } = setup({ ...ON, OUTBOUND_TEST_FROM: "" });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toMatch(/caller ID/);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("claims nobody without a public host", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, { ...deps, host: "" });
    expect(r.skipped).toBe("no public host");
    expect(store.contacts.get("c1")!.status).toBe("pending");
    expect(store.attempts).toHaveLength(0);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("claims nobody outside the window", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    const night = { ...deps, now: () => new Date("2041-03-06T06:00:00Z") };
    expect((await runCampaignTick("test-lane", policy, night)).skipped).toBe("outside_hours");
    expect(store.contacts.get("c1")!.status).toBe("pending");
    expect(createCall).not.toHaveBeenCalled();
  });
});

describe("a dial", () => {
  it("asks Twilio for machine detection and points the call back at this lane", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.dialled).toBe(1);
    const attempt = store.attempts[0];
    expect(createCall).toHaveBeenCalledWith({
      to: "+15555550111",
      from: "+15555550100",
      url: answerUrl("voice.example.test", "test-lane", "c1", attempt.id),
      method: "POST",
      timeout: 25,
      machineDetection: "DetectMessageEnd",
      machineDetectionTimeout: 30,
      statusCallback: statusUrl("voice.example.test", "test-lane", "c1", attempt.id),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed"],
    });
    expect(attempt.callSid).toMatch(/^CA/);
    expect(store.contacts.get("c1")!.status).toBe("calling");
    expect(store.contacts.get("c1")!.attempts).toBe(1);
    expect(store.contacts.get("c1")!.contacted).toBe(true);
  });

  it("names the contact and the attempt in the query Twilio signs", () => {
    expect(answerUrl("h.test", "lane", "c 1", "a1")).toBe("https://h.test/voice/outbound/lane?contact=c+1&attempt=a1");
    expect(statusUrl("h.test", "lane", "c1", "a1")).toBe("https://h.test/voice/outbound/lane/status?contact=c1&attempt=a1");
  });

  it("rings a person once even when two ticks race for them", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    const [a, b] = await Promise.all([
      runCampaignTick("test-lane", policy, deps),
      runCampaignTick("test-lane", policy, deps),
    ]);
    expect(a.dialled + b.dialled).toBe(1);
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("never rings a number on the do-not-contact list, and settles it", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "(555) 555-0111" });
    await store.stampDoNotContact("+15555550111", "voice:other-campaign");
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(r.held).toEqual({ do_not_contact: 1 });
    expect(store.contacts.get("c1")!.status).toBe("do_not_call");
  });

  it("refuses an unreadable number rather than dialling it", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "anonymous" });
    await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("stops for good at the total cap", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail" });
    for (const at of ["2041-01-01", "2041-01-10", "2041-01-20"]) {
      store.attempts.push({ id: at, contactId: "c1", campaignId: "campaign-1", attemptNumber: 1, at: new Date(`${at}T18:00:00Z`) });
    }
    await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.status).toBe("max_attempts");
  });

  it("hands a capped row back with the status it had, and tomorrow's opening", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail" });
    store.attempts.push({ id: "a0", contactId: "c1", campaignId: "campaign-1", attemptNumber: 1, at: new Date("2041-03-05T17:05:00Z") });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(r.held).toEqual({ daily_cap: 1 });
    const c = store.contacts.get("c1")!;
    expect(c.status).toBe("voicemail");
    // 9 AM Pacific tomorrow (PST, UTC-8).
    expect(c.nextAttemptAt?.toISOString()).toBe("2041-03-06T17:00:00.000Z");
  });

  it("records a Twilio refusal as not placed and hands the row back as it was", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw restException(400, "Invalid 'To' phone number");
    });
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.held).toEqual({ twilio_refused: 1 });
    // Kept for the audit trail, under a status no cap reads.
    expect(store.attempts[0].finish?.status).toBe(NOT_PLACED);
    expect(store.attempts[0].endedAt).toBeDefined();
    // Nobody was rung, so nothing about the person changed: not contacted,
    // not an attempt, and the next look is the short infrastructure retry
    // rather than the 20-hour person cooldown (Codex round 5, #357).
    const c = store.contacts.get("c1")!;
    expect(c.status).toBe("voicemail");
    expect(c.attempts).toBe(0);
    expect(c.contacted).toBe(false);
    expect(c.nextAttemptAt?.toISOString()).toBe(
      new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000).toISOString(),
    );
  });

  it("dials a number stored in any spelling as E.164", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "(555) 555-0111" });
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(1);
    expect(createCall).toHaveBeenCalledWith(expect.objectContaining({ to: "+15555550111" }));
  });

  it("never hands back a call Twilio accepted when its CallSid cannot be saved (Codex round 3, #357)", async () => {
    const { store, createCall, deps } = setup();
    const lines: string[] = [];
    store.setAttemptCallSid = async () => {
      throw new Error("connection reset");
    };
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, { ...deps, log: (l: string) => lines.push(l) });
    // The phone is ringing: the call counts as placed, nothing is held.
    expect(r.dialled).toBe(1);
    expect(r.held).toEqual({});
    expect(store.contacts.get("c1")!.status).toBe("calling");
    expect(store.contacts.get("c1")!.attempts).toBe(1);
    expect(store.contacts.get("c1")!.contacted).toBe(true);
    expect(store.attempts[0].finish).toBeUndefined();
    expect(lines.some((l) => l.includes("placed but its CallSid could not be saved"))).toBe(true);
    // And the next tick does not ring them again.
    await runCampaignTick("test-lane", policy, deps);
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("starts no more calls than the campaign's concurrency", async () => {
    const { store, createCall, deps } = setup();
    for (let i = 1; i <= 5; i++) store.addContact({ id: `c${i}`, phone: `+1555555011${i}` });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.dialled).toBe(2);
    expect(createCall).toHaveBeenCalledTimes(2);
    // and the next tick, with both still ringing, starts none
    const again = await runCampaignTick("test-lane", policy, deps);
    expect(again.skipped).toBe("at concurrency");
  });

  it("keeps a call's slot while it is connected, even after a tool settled the contact", async () => {
    // The agent can record an outcome or an opt-out before the call ends;
    // only Twilio's terminal status frees the slot (Codex round 2, #357).
    const { store, createCall, deps } = setup();
    const one = { ...policy, concurrency: 1 };
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "+15555550112" });
    expect((await runCampaignTick("test-lane", one, deps)).dialled).toBe(1);
    const first = store.attempts[0];
    await store.settleContact(first.contactId, "callback_scheduled");
    expect((await runCampaignTick("test-lane", one, deps)).skipped).toBe("at concurrency");
    expect(createCall).toHaveBeenCalledTimes(1);
    await store.finishAttempt(first.id, { status: "completed" });
    expect((await runCampaignTick("test-lane", one, deps)).dialled).toBe(1);
    expect(createCall).toHaveBeenCalledTimes(2);
  });

  it("stops counting a call nobody ever closed once the stale window has passed", async () => {
    const { store, deps } = setup();
    const one = { ...policy, concurrency: 1 };
    store.addContact({ id: "c1", phone: "+15555550111" });
    await runCampaignTick("test-lane", one, deps);
    store.attempts[0].at = new Date(NOW.getTime() - 31 * 60 * 1000);
    store.addContact({ id: "c2", phone: "+15555550112" });
    expect((await runCampaignTick("test-lane", one, deps)).dialled).toBe(1);
  });

  it("hands back a claim stuck in 'calling' from a process that died", async () => {
    const { store, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "calling" });
    store.contacts.get("c1")!.updatedAt = new Date(NOW.getTime() - 31 * 60 * 1000);
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.reaped).toBe(1);
    expect(store.contacts.get("c1")!.status).toBe("no_answer");
    expect(store.contacts.get("c1")!.nextAttemptAt?.toISOString()).toBe(
      reapNextAttemptAt(NOW, policy).toISOString(),
    );
  });

  it("does nothing for a lane with no agents row", async () => {
    const { store, createCall, deps } = setup();
    store.agentRowMissing = true;
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toMatch(/agents row/);
    expect(createCall).not.toHaveBeenCalled();
  });
});

describe("one person on two rows (Codex round 3, #357)", () => {
  // An import can carry one phone on two contact rows; the caps are per
  // person, so the attempts are counted over the phone, not the row.
  const loose: OutboundLanePolicy = {
    ...policy,
    caps: { perDay: 5, perWeek: 10, total: 10, minHoursBetween: 0 },
  };

  it("spends the total cap once across both rows", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "(555) 555-0111" });
    for (let i = 1; i <= 3; i++) {
      store.attempts.push({
        id: `a${i}`,
        contactId: "c1",
        campaignId: "campaign-1",
        attemptNumber: i,
        at: new Date(`2041-02-0${i}T18:00:00Z`),
        endedAt: new Date(`2041-02-0${i}T18:01:00Z`),
      });
    }
    store.contacts.get("c1")!.status = "max_attempts";
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(r.held).toEqual({ total_cap: 1 });
    expect(store.contacts.get("c2")!.status).toBe("max_attempts");
  });

  it("spends the daily cap once across both rows", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail" });
    store.addContact({ id: "c2", phone: "15555550111" });
    store.attempts.push({
      id: "a1",
      contactId: "c1",
      campaignId: "campaign-1",
      attemptNumber: 1,
      at: new Date("2041-03-05T17:00:00Z"),
      endedAt: new Date("2041-03-05T17:01:00Z"),
    });
    store.contacts.get("c1")!.nextAttemptAt = new Date("2041-03-06T17:00:00Z");
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(r.held).toEqual({ daily_cap: 1 });
  });

  it("never rings the same phone twice at once, even inside the caps", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "+1 555-555-0111" });
    const r = await runCampaignTick("test-lane", loose, deps);
    expect(r.dialled).toBe(1);
    expect(r.held).toEqual({ call_in_progress: 1 });
    expect(createCall).toHaveBeenCalledTimes(1);
    const second = [...store.contacts.values()].find((c) => c.status !== "calling")!;
    expect(second.status).toBe("pending");
    // Once the first call has ended, the second row may ring.
    await store.finishAttempt(store.attempts[0].id, { status: "completed" });
    expect((await runCampaignTick("test-lane", loose, deps)).dialled).toBe(1);
    expect(createCall).toHaveBeenCalledTimes(2);
  });

  it("keeps a different phone's rows apart", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "+15555550112" });
    expect((await runCampaignTick("test-lane", loose, deps)).dialled).toBe(2);
    expect(createCall).toHaveBeenCalledTimes(2);
  });
});

describe("a dial Twilio refused spends none of the person's attempts (Codex round 4, #357)", () => {
  const refuseThen = (refusals: number) => {
    let n = 0;
    return vi.fn(async () => {
      if (++n <= refusals) throw restException(400, "service unavailable");
      return { sid: `CA${String(n).padStart(32, "0")}` };
    });
  };

  it("rings them after an outage as long as the outage lasted", async () => {
    const { store, deps } = setup();
    const noGap: OutboundLanePolicy = {
      ...policy,
      caps: { ...DEFAULT_ATTEMPT_CAPS, minHoursBetween: 0 },
    };
    deps.twilio.createCall = refuseThen(DEFAULT_ATTEMPT_CAPS.total);
    store.addContact({ id: "c1", phone: "+15555550111" });
    let now = NOW;
    for (let i = 0; i < DEFAULT_ATTEMPT_CAPS.total; i++) {
      expect((await runCampaignTick("test-lane", noGap, { ...deps, now: () => now })).held).toEqual({
        twilio_refused: 1,
      });
      expect(store.contacts.get("c1")!.status).toBe("pending");
      now = new Date(now.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000);
    }
    // As many refusals as the total cap, and the person is still dialled.
    expect((await runCampaignTick("test-lane", noGap, { ...deps, now: () => now })).dialled).toBe(1);
    expect(store.contacts.get("c1")!.status).toBe("calling");
    expect(await store.priorAttempts("c1")).toHaveLength(1);
  });

  it("does not spend the daily cap on a refusal", async () => {
    const { store, deps } = setup();
    const oncePerDay: OutboundLanePolicy = {
      ...policy,
      caps: { perDay: 1, perWeek: 3, total: 3, minHoursBetween: 0 },
    };
    deps.twilio.createCall = refuseThen(1);
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", oncePerDay, deps)).held).toEqual({ twilio_refused: 1 });
    const later = new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000);
    expect((await runCampaignTick("test-lane", oncePerDay, { ...deps, now: () => later })).dialled).toBe(1);
  });
});

describe("one person in two campaigns (Codex round 4, #357)", () => {
  const otherCampaignContact = (store: FakeOutboundStore, attempt: Partial<{ at: Date; endedAt: Date }>) => {
    store.addContact({ id: "x1", phone: "(555) 555-0111", campaignId: "campaign-2" });
    store.attempts.push({ id: "x-a1", contactId: "x1", campaignId: "campaign-2", attemptNumber: 1, at: NOW, ...attempt });
  };

  it("never rings a phone another campaign has on the line", async () => {
    const { store, createCall, deps } = setup();
    otherCampaignContact(store, { at: new Date(NOW.getTime() - 60 * 1000) });
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.held).toEqual({ call_in_progress: 1 });
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.status).toBe("pending");
  });

  it("stops holding the phone once the other campaign's call has ended", async () => {
    const { store, deps } = setup();
    otherCampaignContact(store, { at: new Date(NOW.getTime() - 60 * 1000), endedAt: NOW });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(1);
  });

  it("stops holding the phone past the stale window, like the concurrency count", async () => {
    const { store, deps } = setup();
    otherCampaignContact(store, { at: new Date(NOW.getTime() - 31 * 60 * 1000) });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(1);
  });

  it("keeps the caps per campaign: another campaign's attempts spend none of this one's", async () => {
    const { store, deps } = setup();
    store.addContact({ id: "x1", phone: "+15555550111", campaignId: "campaign-2" });
    for (let i = 1; i <= DEFAULT_ATTEMPT_CAPS.total; i++) {
      store.attempts.push({
        id: `x-a${i}`,
        contactId: "x1",
        campaignId: "campaign-2",
        attemptNumber: i,
        at: new Date(`2041-02-0${i}T18:00:00Z`),
        endedAt: new Date(`2041-02-0${i}T18:01:00Z`),
      });
    }
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(1);
  });
});

describe("nextLookAt", () => {
  it("puts a daily-capped row at the window's opening tomorrow, across DST", () => {
    // 2041-03-09 is the spring-forward Saturday night into Sunday 2041-03-10.
    const sat = new Date("2041-03-09T19:00:00Z"); // 11 AM PST
    expect(nextLookAt(sat, "daily_cap", policy).toISOString()).toBe("2041-03-10T16:00:00.000Z"); // 9 AM PDT
  });

  it("retries a Twilio refusal in fifteen minutes, not the person cooldown (Codex round 5, #357)", () => {
    expect(nextLookAt(NOW, "twilio_refused", policy).toISOString()).toBe(
      new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000).toISOString(),
    );
    expect(nextLookAt(NOW, "too_soon", policy).toISOString()).toBe(
      new Date(NOW.getTime() + DEFAULT_ATTEMPT_CAPS.minHoursBetween * 60 * 60 * 1000).toISOString(),
    );
  });

  it("lets a campaign set a shorter infrastructure retry", () => {
    expect(nextLookAt(NOW, "twilio_refused", { ...policy, infraRetryMinutes: 5 }).toISOString()).toBe(
      new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
    );
  });

  it("falls back to the default when infraRetryMinutes is not a positive number", () => {
    const expected = new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000).toISOString();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        nextLookAt(NOW, "twilio_refused", { ...policy, infraRetryMinutes: bad }).toISOString(),
        String(bad),
      ).toBe(expected);
    }
    expect(
      nextLookAt(NOW, "twilio_refused", { ...policy, infraRetryMinutes: "15" as unknown as number }).toISOString(),
    ).toBe(expected);
    expect(resolvedInfraRetryMinutes({ infraRetryMinutes: 0 })).toBe(DEFAULT_INFRA_RETRY_MINUTES);
    expect(resolvedInfraRetryMinutes({ infraRetryMinutes: 7 })).toBe(7);
  });

  it("clamps a huge infraRetryMinutes so nextLookAt stays a real date", () => {
    expect(resolvedInfraRetryMinutes({ infraRetryMinutes: 1e20 })).toBe(MAX_INFRA_RETRY_MINUTES);
    expect(resolvedInfraRetryMinutes({ infraRetryMinutes: MAX_INFRA_RETRY_MINUTES + 1 })).toBe(
      MAX_INFRA_RETRY_MINUTES,
    );
    const next = nextLookAt(NOW, "twilio_refused", { ...policy, infraRetryMinutes: 1e20 });
    expect(Number.isNaN(next.getTime())).toBe(false);
    expect(next.toISOString()).toBe(
      new Date(NOW.getTime() + MAX_INFRA_RETRY_MINUTES * 60 * 1000).toISOString(),
    );
  });
});

describe("a refused dial is not a contact and is retried shortly (Codex round 5, #357)", () => {
  it("does not count or mark a contact when Twilio refuses the dial", async () => {
    const { store, deps } = setup();
    const refuse = vi.fn(async () => {
      throw restException(400, "service unavailable");
    });
    deps.twilio.createCall = refuse;
    store.addContact({ id: "c1", phone: "+15555550111" });
    await runCampaignTick("test-lane", policy, deps);
    const c = store.contacts.get("c1")!;
    expect(c.attempts).toBe(0);
    expect(c.contacted).toBe(false);
    expect(c.status).toBe("pending");
    expect(refuse).toHaveBeenCalledTimes(1);
    // The attempt row is kept for the audit, but it is not a placed call.
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].finish?.status).toBe(NOT_PLACED);
  });

  it("holds the row for the infrastructure retry, then rings once Twilio accepts", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw restException(400, "service unavailable");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_refused: 1 });
    // Same instant: still inside the 15-minute retry, so nobody is claimed.
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(0);
    expect(store.contacts.get("c1")!.attempts).toBe(0);
    expect(store.contacts.get("c1")!.contacted).toBe(false);

    const later = new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000);
    deps.twilio.createCall = vi.fn(async () => ({ sid: `CA${"1".repeat(32)}` }));
    const after = await runCampaignTick("test-lane", policy, { ...deps, now: () => later });
    expect(after.dialled).toBe(1);
    expect(store.contacts.get("c1")!.status).toBe("calling");
    expect(store.contacts.get("c1")!.attempts).toBe(1);
    expect(store.contacts.get("c1")!.contacted).toBe(true);
  });

  it("still marks a contact when the CallSid cannot be saved after Twilio accepts", async () => {
    const { store, deps } = setup();
    store.setAttemptCallSid = async () => {
      throw new Error("connection reset");
    };
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).dialled).toBe(1);
    expect(store.contacts.get("c1")!.attempts).toBe(1);
    expect(store.contacts.get("c1")!.contacted).toBe(true);
  });
});

describe("isClearTwilioRefusal", () => {
  it("accepts only a RestException with an HTTP 4xx status", () => {
    expect(isClearTwilioRefusal(restException(400))).toBe(true);
    expect(isClearTwilioRefusal(restException(404))).toBe(true);
    expect(isClearTwilioRefusal(restException(422))).toBe(true);
    expect(isClearTwilioRefusal(restException(499))).toBe(true);
  });

  it("rejects a 5xx RestException, a network error, and a bare 4xx-shaped object", () => {
    expect(isClearTwilioRefusal(restException(500))).toBe(false);
    expect(isClearTwilioRefusal(restException(503))).toBe(false);
    expect(isClearTwilioRefusal(new Error("socket hang up"))).toBe(false);
    expect(isClearTwilioRefusal({ status: 400 })).toBe(false);
    expect(isClearTwilioRefusal({ name: "RestException", status: "400" })).toBe(false);
    expect(isClearTwilioRefusal(null)).toBe(false);
  });

  it("accepts a real SDK RestException that does not set name", () => {
    const RestException = (
      twilio as unknown as {
        RestException: new (response: { statusCode: number; body: unknown }) => Error & { status: number };
      }
    ).RestException;
    const err = new RestException({
      statusCode: 400,
      body: { message: "Invalid 'To' phone number", code: 21211 },
    });
    expect(err.name).not.toBe("RestException");
    expect(err.constructor.name).toBe("RestException");
    expect(isClearTwilioRefusal(err)).toBe(true);
  });
});

describe("an ambiguous createCall throw is not a refusal (stand-in review of 652e777 / 50ac955)", () => {
  const AUTH = "test-auth-token";
  const LIVE = { TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "k", DATABASE_URL: "postgres://x" };

  function signed(url: string, body: Record<string, string>): WebhookRequest {
    const sig = (
      twilio as unknown as {
        getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
      }
    ).getExpectedTwilioSignature(AUTH, url, body);
    const u = new URL(url);
    return {
      headers: { host: u.host, "x-forwarded-proto": "https", "x-twilio-signature": sig },
      body,
      originalUrl: `${u.pathname}${u.search}`,
    };
  }

  afterEach(() => setOutboundToolStoreForTests(null));

  it("leaves the attempt open and the contact in calling on a socket reset", async () => {
    const { store, deps } = setup();
    const fail = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    deps.twilio.createCall = fail;
    store.addContact({ id: "c1", phone: "+15555550111", status: "voicemail" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.held).toEqual({ twilio_uncertain: 1 });
    expect(fail).toHaveBeenCalledTimes(1);
    // The attempt is still on the line: ended_at stays unset so
    // callOpenOnPhone can see a call Twilio may already have created.
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].finish).toBeUndefined();
    expect(store.attempts[0].endedAt).toBeUndefined();
    const c = store.contacts.get("c1")!;
    // Still 'calling': the status callback and record_call_outcome both
    // require that, and releasing here would drop a real call's outcome.
    expect(c.status).toBe("calling");
    expect(c.attempts).toBe(0);
    expect(c.contacted).toBe(false);
  });

  it("treats a RestException 5xx the same way — Twilio may have accepted", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw restException(503, "service unavailable");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_uncertain: 1 });
    expect(store.attempts[0].finish).toBeUndefined();
    expect(store.attempts[0].endedAt).toBeUndefined();
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });

  it("does not ring again while the claim is still in calling", async () => {
    const { store, deps } = setup();
    const first = vi.fn(async () => {
      throw new Error("read ECONNRESET");
    });
    deps.twilio.createCall = first;
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_uncertain: 1 });
    expect(first).toHaveBeenCalledTimes(1);

    const in15 = new Date(NOW.getTime() + DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000);
    const later = vi.fn(async () => ({ sid: `CA${"2".repeat(32)}` }));
    deps.twilio.createCall = later;
    const again = await runCampaignTick("test-lane", policy, { ...deps, now: () => in15 });
    expect(again.dialled).toBe(0);
    expect(later).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });

  it("lets a completed status callback settle the contact after an ambiguous throw", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_uncertain: 1 });
    const attemptId = store.attempts[0]!.id;
    const url = statusUrl("voice.example.test", "test-lane", "c1", attemptId);
    const body = {
      CallSid: "CA00000000000000000000000000000001",
      CallStatus: "completed",
      CallDuration: "42",
    };
    await handleOutboundStatus("test-lane", signed(url, body), {
      env: LIVE,
      registry: { register: () => ({ streamToken: "t" }) } as never,
      store,
      policyFor: () => policy,
      now: () => NOW,
    });
    expect(store.contacts.get("c1")!.status).toBe("answered");
    expect(store.attempts[0]!.finish?.status).toBe("completed");
    expect(store.attempts[0]!.endedAt).toBeDefined();
  });

  it("lets record_call_outcome stick after an ambiguous throw", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_uncertain: 1 });
    expect(store.contacts.get("c1")!.status).toBe("calling");
    setOutboundToolStoreForTests(store);
    const r = await getTool(RECORD_OUTCOME_TOOL_NAME)!.handler({
      outbound_contact_id: "c1",
      outbound_phone: "+15555550111",
      outbound_campaign: "test-campaign",
      outcome: "not_interested",
    });
    expect(r).toMatchObject({ success: true, recorded: "not_interested" });
    expect(store.contacts.get("c1")!.status).toBe("declined");
  });

  it("reaps a stale ambiguous claim with a next look, so it is not dialled on the same tick", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).held).toEqual({ twilio_uncertain: 1 });
    const later = new Date(NOW.getTime() + 31 * 60 * 1000);
    store.contacts.get("c1")!.updatedAt = NOW;
    store.attempts[0]!.at = NOW;
    const accept = vi.fn(async () => ({ sid: `CA${"9".repeat(32)}` }));
    deps.twilio.createCall = accept;
    const r = await runCampaignTick("test-lane", policy, { ...deps, now: () => later });
    expect(r.reaped).toBe(1);
    expect(r.dialled).toBe(0);
    expect(accept).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.status).toBe("no_answer");
    expect(store.contacts.get("c1")!.nextAttemptAt?.toISOString()).toBe(
      reapNextAttemptAt(later, policy).toISOString(),
    );
  });

  it("floors the reaper's next look at the stale window when the person cooldown is 0", () => {
    const zero: OutboundLanePolicy = {
      ...policy,
      caps: { ...DEFAULT_ATTEMPT_CAPS, minHoursBetween: 0 },
    };
    expect(reapNextAttemptAt(NOW, zero).toISOString()).toBe(
      new Date(NOW.getTime() + STALE_CLAIM_MS).toISOString(),
    );
  });
});

describe("consecutive Twilio refusals fall back to the person cooldown", () => {
  const retryMs = DEFAULT_INFRA_RETRY_MINUTES * 60 * 1000;
  const cooldownMs = DEFAULT_ATTEMPT_CAPS.minHoursBetween * 60 * 60 * 1000;

  it("uses the short retry for the first three refusals, then the person cooldown", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw restException(400, "The phone number is not valid");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    let now = NOW;
    for (let i = 1; i <= DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES; i++) {
      expect((await runCampaignTick("test-lane", policy, { ...deps, now: () => now })).held).toEqual({
        twilio_refused: 1,
      });
      expect(store.contacts.get("c1")!.nextAttemptAt?.getTime()).toBe(now.getTime() + retryMs);
      now = new Date(now.getTime() + retryMs);
    }
    expect((await runCampaignTick("test-lane", policy, { ...deps, now: () => now })).held).toEqual({
      twilio_refused: 1,
    });
    expect(store.contacts.get("c1")!.nextAttemptAt?.getTime()).toBe(now.getTime() + cooldownMs);
    expect(store.contacts.get("c1")!.attempts).toBe(0);
    expect(await store.consecutiveRefusedAttempts("c1", new Date(NOW.getTime() - REFUSAL_STREAK_WINDOW_MS))).toBe(
      DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES + 1,
    );
  });

  it("resets the streak after a call Twilio accepted", async () => {
    const { store, deps } = setup();
    let n = 0;
    deps.twilio.createCall = vi.fn(async () => {
      n += 1;
      if (n === 3) return { sid: `CA${"3".repeat(32)}` };
      throw restException(400);
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    const loose: OutboundLanePolicy = {
      ...policy,
      caps: { ...DEFAULT_ATTEMPT_CAPS, perDay: 5, minHoursBetween: 0 },
    };
    let now = NOW;
    expect((await runCampaignTick("test-lane", loose, { ...deps, now: () => now })).held).toEqual({
      twilio_refused: 1,
    });
    now = new Date(now.getTime() + retryMs);
    expect((await runCampaignTick("test-lane", loose, { ...deps, now: () => now })).held).toEqual({
      twilio_refused: 1,
    });
    now = new Date(now.getTime() + retryMs);
    expect((await runCampaignTick("test-lane", loose, { ...deps, now: () => now })).dialled).toBe(1);
    await store.finishAttempt(store.attempts[store.attempts.length - 1]!.id, { status: "completed" });
    expect(await store.consecutiveRefusedAttempts("c1", new Date(NOW.getTime() - REFUSAL_STREAK_WINDOW_MS))).toBe(0);
  });

  it("does not count refusals older than the streak window", async () => {
    const { store } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.attempts.push({
      id: "old",
      contactId: "c1",
      campaignId: "campaign-1",
      attemptNumber: 1,
      at: new Date(NOW.getTime() - REFUSAL_STREAK_WINDOW_MS - 1000),
      finish: { status: NOT_PLACED },
      endedAt: NOW,
    });
    expect(
      await store.consecutiveRefusedAttempts("c1", new Date(NOW.getTime() - REFUSAL_STREAK_WINDOW_MS)),
    ).toBe(0);
  });

  it("falls back to the default cap when the policy value is not a positive number", () => {
    expect(resolvedMaxConsecutiveInfraRetries({})).toBe(DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES);
    expect(resolvedMaxConsecutiveInfraRetries({ maxConsecutiveInfraRetries: 0 })).toBe(
      DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES,
    );
    expect(resolvedMaxConsecutiveInfraRetries({ maxConsecutiveInfraRetries: -1 })).toBe(
      DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES,
    );
    expect(resolvedMaxConsecutiveInfraRetries({ maxConsecutiveInfraRetries: Number.NaN })).toBe(
      DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES,
    );
    expect(resolvedMaxConsecutiveInfraRetries({ maxConsecutiveInfraRetries: 2 })).toBe(2);
  });
});


/**
 * A CALL BACK TO THE CALLER ID MUST REACH THIS LANE (v106). Operator,
 * 2026-10-21: "There is no redirect. If a patient calls back, like we expect
 * them to, the voice agent has to handle that call as well." So nothing is
 * dialled until the caller-ID number's own Voice URL points at this lane, on
 * this deployment.
 */
describe("the caller ID takes the calls back", () => {
  it("is confirmed only for this lane's path on this deployment's host", () => {
    expect(callbackRoutingProblem("https://voice.example.test/voice/test-lane", "voice.example.test", "test-lane")).toBeNull();
    expect(callbackRoutingProblem("https://VOICE.example.test/voice/test-lane/", "voice.example.test", "test-lane")).toBeNull();
    expect(callbackRoutingProblem("https://voice.example.test/voice/records", "voice.example.test", "test-lane")).toMatch(
      /reach \/voice\/records, not \/voice\/test-lane/,
    );
    expect(callbackRoutingProblem("https://workspace.example.dev/voice/test-lane", "voice.example.test", "test-lane")).toMatch(
      /not this deployment/,
    );
    expect(callbackRoutingProblem(null, "voice.example.test", "test-lane")).toMatch(/not on this Twilio account/);
    expect(callbackRoutingProblem("", "voice.example.test", "test-lane")).toMatch(/no usable Voice URL/);
  });

  it.each([
    ["another line", "https://voice.example.test/voice/records"],
    ["a workspace process", "https://workspace.example.dev/voice/test-lane"],
    ["nowhere on this account", null],
  ])("dials nobody — and claims nobody — when callbacks would reach %s", async (_what, url) => {
    const { store, createCall, voiceUrlFor, deps } = setup();
    voiceUrlFor.mockResolvedValue(url);
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.skipped).toBeTruthy();
    expect(createCall).not.toHaveBeenCalled();
    expect(store.contacts.get("c1")!.status).toBe("pending");
    expect(store.attempts).toHaveLength(0);
  });

  it("fails closed when Twilio cannot say where the number points", async () => {
    const { store, createCall, voiceUrlFor, deps } = setup();
    voiceUrlFor.mockRejectedValue(new Error("Twilio down"));
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toMatch(/could not read/);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("asks Twilio about the caller ID itself", async () => {
    const { store, voiceUrlFor, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    await runCampaignTick("test-lane", policy, deps);
    expect(voiceUrlFor).toHaveBeenCalledWith("+15555550100");
  });

  it("trusts a confirmed route for a while, and logs a wrong one once rather than every minute", async () => {
    const { store, voiceUrlFor, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111" });
    const lines: string[] = [];
    const routeCache = new Map();
    const t = { ...deps, routeCache, log: (l: string) => lines.push(l) };
    await runCampaignTick("test-lane", policy, t);
    await runCampaignTick("test-lane", policy, t);
    expect(voiceUrlFor).toHaveBeenCalledTimes(1);

    voiceUrlFor.mockResolvedValue("https://voice.example.test/voice/records");
    const later = { ...t, now: () => new Date(NOW.getTime() + CALLBACK_ROUTE_TTL_MS + 1) };
    await runCampaignTick("test-lane", policy, later);
    await runCampaignTick("test-lane", policy, later);
    expect(voiceUrlFor).toHaveBeenCalledTimes(3);
    expect(lines.filter((l) => l.includes("NOT dialling"))).toHaveLength(1);
  });

  it("is checked only inside the calling window, so Twilio is not asked overnight", async () => {
    const { voiceUrlFor, deps } = setup();
    const night = { ...deps, now: () => new Date("2041-03-05T08:00:00Z") }; // midnight Pacific
    await runCampaignTick("test-lane", policy, night);
    expect(voiceUrlFor).not.toHaveBeenCalled();
  });
});

/**
 * A CAMPAIGN FED LIVE FROM A SOURCE (v107): the queue follows the source, and
 * each person is re-checked against it at the moment of the dial. Operator,
 * 2026-10-21: "create a direct connection to the eye care patient console
 * where the movable list is located so it is always fresh."
 */
describe("a campaign fed live from a source", () => {
  type SC = import("./campaign").SourceContact;
  type RC = import("./campaign").SourceRecheck;
  const person = (ref: string, phone: string | null = "+15555550111", data: Record<string, unknown> = {}): SC => ({
    externalRef: ref,
    phone,
    firstName: "Testa",
    lastName: "Synthetic",
    data: { date_of_birth: "1950-01-02", ...data },
  });
  function sourced(listed: SC[], recheck: (ref: string) => Promise<RC> = async (ref) => ({ state: "current", contact: listed.find((p) => p.externalRef === ref) ?? person(ref) })) {
    const reads = { list: 0, recheck: 0 };
    const source: import("./campaign").ContactSource = {
      name: "test source",
      refreshEveryMs: 15 * 60 * 1000,
      parkMs: 60 * 60 * 1000,
      list: async () => {
        reads.list += 1;
        return listed;
      },
      recheck: async (ref) => {
        reads.recheck += 1;
        return recheck(ref);
      },
    };
    return { source, reads, policy: { ...policy, source: async () => source } };
  }

  it("queues the source's people as pending rows keyed on the source's id, and dials them", async () => {
    const { store, createCall, deps } = setup();
    const { policy: p } = sourced([person("appt-1")]);
    const r = await runCampaignTick("test-lane", p, { ...deps, sourceRefreshedAt: new Map() });
    expect(r.refreshed).toEqual({ written: 1, parked: 0, listed: 1 });
    const row = [...store.contacts.values()][0];
    expect(row).toMatchObject({ externalRef: "appt-1", phone: "+15555550111" });
    expect(row.customData).toMatchObject({ date_of_birth: "1950-01-02" });
    expect(createCall).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most once per interval, and a quiet refresh writes nothing", async () => {
    const { store, deps } = setup();
    const { policy: p, reads } = sourced([person("appt-1")]);
    const cache = new Map<string, number>();
    await runCampaignTick("test-lane", p, { ...deps, sourceRefreshedAt: cache });
    await runCampaignTick("test-lane", p, { ...deps, sourceRefreshedAt: cache });
    expect(reads.list).toBe(1);
    const later = { ...deps, sourceRefreshedAt: cache, now: () => new Date(NOW.getTime() + 16 * 60 * 1000) };
    await runCampaignTick("test-lane", p, later);
    expect(reads.list).toBe(2);
    expect(store.upserts).toEqual([1]); // the unchanged second read wrote nothing
  });

  it("follows the source's phone and fields, and never its status", async () => {
    const { store, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1", status: "voicemail", customData: { date_of_birth: "1950-01-02" }, firstName: "Testa", lastName: "Synthetic" });
    const { policy: p } = sourced([person("appt-1", "+15555550133")], async () => ({ state: "off_list" }));
    await runCampaignTick("test-lane", p, { ...deps, sourceRefreshedAt: new Map() });
    expect(store.contacts.get("c1")).toMatchObject({ phone: "+15555550133", status: "voicemail" });
  });

  it("parks a row that left the list until the next rebuild — dialable rows only — and never deletes it", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-gone", status: "no_answer" });
    store.addContact({ id: "c2", phone: "+15555550112", externalRef: "appt-done", status: "completed" });
    const { policy: p } = sourced([]);
    const r = await runCampaignTick("test-lane", p, { ...deps, sourceRefreshedAt: new Map() });
    expect(r.refreshed).toMatchObject({ parked: 1 });
    expect(store.contacts.get("c1")!.nextAttemptAt!.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);
    expect(store.contacts.get("c2")!.nextAttemptAt).toBeNull();
    expect(createCall).not.toHaveBeenCalled();
  });

  it("dials nobody when the source is not available in this process", async () => {
    const { store, createCall, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1" });
    const r = await runCampaignTick("test-lane", { ...policy, source: async () => null }, deps);
    expect(r.skipped).toBe("contact source not available");
    expect(createCall).not.toHaveBeenCalled();
  });

  it("writes and parks nothing when the list cannot be read", async () => {
    const { store, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1", status: "no_answer" });
    const { source } = sourced([]);
    source.list = async () => Promise.reject(new Error("console down"));
    const r = await runCampaignTick("test-lane", { ...policy, source: async () => source }, { ...deps, sourceRefreshedAt: new Map() });
    expect(r.refreshed).toBeUndefined();
    expect(store.contacts.get("c1")!.nextAttemptAt).toBeNull();
  });

  describe("the re-check at the dial", () => {
    it("settles a row whose appointment is over and rings nobody", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1" });
      const { policy: p } = sourced([person("appt-1")], async () => ({ state: "gone" }));
      const r = await runCampaignTick("test-lane", p, deps);
      expect(r.held).toEqual({ source_gone: 1 });
      expect(store.contacts.get("c1")!.status).toBe("rescheduled");
      expect(createCall).not.toHaveBeenCalled();
    });

    it("parks a row that is off the list right now, keeping its status", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1", status: "voicemail" });
      const { policy: p } = sourced([person("appt-1")], async () => ({ state: "off_list" }));
      expect((await runCampaignTick("test-lane", p, deps)).held).toEqual({ off_list: 1 });
      expect(store.contacts.get("c1")).toMatchObject({ status: "voicemail" });
      expect(store.contacts.get("c1")!.nextAttemptAt!.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);
      expect(createCall).not.toHaveBeenCalled();
    });

    it("rings nobody when the source cannot answer — fail closed", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1", status: "voicemail" });
      const { policy: p } = sourced([person("appt-1")], async () => Promise.reject(new Error("console down")));
      expect((await runCampaignTick("test-lane", p, deps)).held).toEqual({ source_unavailable: 1 });
      expect(store.contacts.get("c1")!.status).toBe("voicemail");
      expect(createCall).not.toHaveBeenCalled();
    });

    it("rings today's number from the source, after checking it against the do-not-contact list", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1" });
      const { policy: p } = sourced([person("appt-1")], async () => ({ state: "current", contact: person("appt-1", "+15555550144") }));
      await runCampaignTick("test-lane", p, deps);
      expect(store.contacts.get("c1")!.phone).toBe("+15555550144");
      expect(createCall).toHaveBeenCalledWith(expect.objectContaining({ to: "+15555550144" }));
    });

    it("refuses today's number when it is on the do-not-contact list", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111", externalRef: "appt-1" });
      store.dnc.set("5555550144", "voice:test");
      const { policy: p } = sourced([person("appt-1")], async () => ({ state: "current", contact: person("appt-1", "+15555550144") }));
      expect((await runCampaignTick("test-lane", p, deps)).held).toEqual({ do_not_contact: 1 });
      expect(createCall).not.toHaveBeenCalled();
    });

    it("never dials a row on a source-fed campaign that the source did not write", async () => {
      const { store, createCall, deps } = setup();
      store.addContact({ id: "c1", phone: "+15555550111" });
      const { policy: p } = sourced([]);
      expect((await runCampaignTick("test-lane", p, deps)).held).toEqual({ not_from_source: 1 });
      expect(createCall).not.toHaveBeenCalled();
    });
  });
});
