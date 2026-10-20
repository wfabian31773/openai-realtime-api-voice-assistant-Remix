import { describe, expect, it, vi } from "vitest";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { answerUrl, nextLookAt, runCampaignTick, statusUrl, type OutboundTwilio } from "./dialer";
import { FakeOutboundStore } from "./store.testkit";

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
  const twilio: OutboundTwilio = { createCall };
  const deps = { store, twilio, env, host: "voice.example.test", now: () => NOW, log: () => undefined };
  return { store, createCall, deps };
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

  it("settles a Twilio refusal as a failed attempt and tries again later", async () => {
    const { store, deps } = setup();
    deps.twilio.createCall = vi.fn(async () => {
      throw new Error("21217 invalid number");
    });
    store.addContact({ id: "c1", phone: "+15555550111" });
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.held).toEqual({ twilio_refused: 1 });
    expect(store.attempts[0].finish?.status).toBe("failed");
    expect(store.contacts.get("c1")!.status).toBe("no_answer");
    expect(store.contacts.get("c1")!.nextAttemptAt).not.toBeNull();
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

  it("hands back a claim stuck in 'calling' from a process that died", async () => {
    const { store, deps } = setup();
    store.addContact({ id: "c1", phone: "+15555550111", status: "calling" });
    store.contacts.get("c1")!.updatedAt = new Date(NOW.getTime() - 31 * 60 * 1000);
    const r = await runCampaignTick("test-lane", policy, deps);
    expect(r.reaped).toBe(1);
  });

  it("does nothing for a lane with no agents row", async () => {
    const { store, createCall, deps } = setup();
    store.agentRowMissing = true;
    store.addContact({ id: "c1", phone: "+15555550111" });
    expect((await runCampaignTick("test-lane", policy, deps)).skipped).toMatch(/agents row/);
    expect(createCall).not.toHaveBeenCalled();
  });
});

describe("nextLookAt", () => {
  it("puts a daily-capped row at the window's opening tomorrow, across DST", () => {
    // 2041-03-09 is the spring-forward Saturday night into Sunday 2041-03-10.
    const sat = new Date("2041-03-09T19:00:00Z"); // 11 AM PST
    expect(nextLookAt(sat, "daily_cap", policy).toISOString()).toBe("2041-03-10T16:00:00.000Z"); // 9 AM PDT
  });
});
