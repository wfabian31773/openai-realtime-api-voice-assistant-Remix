/**
 * The after-hours transfer's on-call path (v268), driven through the REAL
 * `createRuntimeTransfer` with only Twilio, the store, the rotation, the text
 * sender and the runner faked. A helper test proves the helper; this proves
 * the transfer calls it, dials the number it chose and hands the outcome on.
 *
 * Every phone is a 555 number and every name is made up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import {
  createRuntimeTransfer,
  ON_CALL_LANES,
  ON_CALL_SECOND_REQUEST_HELD,
  rotationMayTakeTheDial,
  TRANSFER_ACCEPT_PATH,
  TRANSFER_STATUS_PATH,
  transferModeFor,
  urgentTextRotationNote,
  ringOutDialTarget,
  type OnCallTransferWiring,
} from "./runtimeTransfer";
import type { TransferTwilioOps } from "./warmTransfer";
import type { UrgentTransferAlerts } from "./urgentTransferAlerts";
import type { WebhookRequest } from "./voiceWebhook";
import { escalationDetailsMap } from "../services/escalationStore";
import { readOnCallConfig } from "./onCall/config";
import { createFakeOnCallStore, type FakeOnCallStore } from "./onCall/store.fake";
import { provider, syntheticRotation, IE_DIRECTOR } from "./onCall/testRotation";
import { levelLabel, type RotationData } from "./onCall/rotation";
import type { InCallTransferResult } from "./onCall/runner";

/**
 * A switch on the REAL `performWarmTransfer`: off, every test runs it as it
 * is; on, the dial answers UNAVAILABLE (nothing dialled) the way it does for
 * an empty destination. Only the test of a rotation dial that answers
 * UNAVAILABLE turns it on (review of #514).
 */
const warm = vi.hoisted(() => ({ unavailable: false, throws: false }));
vi.mock("./warmTransfer", async (importOriginal) => {
  const real = await importOriginal<typeof import("./warmTransfer")>();
  return {
    ...real,
    performWarmTransfer: (async (...args: Parameters<typeof real.performWarmTransfer>) => {
      if (warm.throws) throw new Error("twilio blew up");
      return warm.unavailable
        ? { ok: false, status: "UNAVAILABLE", reason: "transfer_destination_not_configured" }
        : real.performWarmTransfer(...args);
    }) as typeof real.performWarmTransfer,
  };
});

/**
 * The call event log, so the default held-request sink can be seen writing
 * its row without a database (the real module pulls in server/db).
 */
const events = vi.hoisted(() => ({ emitted: [] as unknown[][] }));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...args: unknown[]) => void events.emitted.push(args),
}));

const AUTH_TOKEN = "test-auth-token";
const DOMAIN = "runtime.example.test";
const ENV = {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_PHONE_NUMBER: "+15550000000",
  HUMAN_AGENT_NUMBER: "+18185551234",
  PCP_HUMAN_AGENT_NUMBER: "+17149564300",
};
const META = { callSid: "CAcaller", callId: "CAcaller", callerPhone: "+15551234567", dialedNumber: "+15559876543" };
const ROTATION_CALLER_ID = "+15550001111";
const TEST_PHONES = ["+15550002222", "+15550003333"];

/** Tuesday 2026-12-01, 6:00 PM Pacific: the first on-call hour of provider 1's week. */
const AFTER_HOURS = new Date("2026-12-02T02:00:00Z");
/** Wednesday 2026-12-02, 10:00 AM Pacific: weekday daytime, not on call. */
const WEEKDAY_DAYTIME = new Date("2026-12-02T18:00:00Z");

afterEach(() => {
  escalationDetailsMap.clear();
  warm.unavailable = false;
  warm.throws = false;
});

function fakeOps() {
  const dialed: Array<{ to: string; from: string; twiml: string }> = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async ({ to, from, twiml }) => {
      dialed.push({ to, from, twiml });
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async () => undefined,
    endCall: async () => undefined,
    redirectCallerToQueue: async () => undefined,
  };
  return { ops, dialed };
}

function signed(path: string, body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: DOMAIN,
      "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://${DOMAIN}${path}`, body),
    },
    body,
    originalUrl: path,
  };
}

interface Built {
  wiring: OnCallTransferWiring;
  store: FakeOnCallStore;
  texts: Array<{ to: string; from: string; body: string; at: number }>;
  handed: InCallTransferResult[];
  order: string[];
  held: Array<{ callSid: string; why: string; slug: string }>;
}

function buildWiring(over: {
  env?: Record<string, string>;
  at?: Date;
  rotation?: RotationData;
  available?: boolean;
} = {}): Built {
  const at = over.at ?? AFTER_HOURS;
  const rotation = over.rotation ?? syntheticRotation();
  const store = createFakeOnCallStore(rotation, () => at);
  if (over.available === false) store.tablesPresent = false;
  const texts: Built["texts"] = [];
  const handed: InCallTransferResult[] = [];
  const order: string[] = [];
  const held: Built["held"] = [];
  const wiring: OnCallTransferWiring = {
    runner: {
      // Opens the chain's row the way the real runner does, and closes it on a
      // pickup, so the transfer's one-chain-per-call check reads a real row.
      afterInCallTransfer: async (r) => {
        handed.push(r);
        const row = await store.openEscalation({
          callSid: r.callSid,
          mode: r.mode,
          routing: r.routing,
          plan: r.plan,
          details: r.details,
          callerNumber: r.callerNumber,
          nextAt: at,
          levelStartedAt: r.levelStartedAt,
          attemptNo: 2,
        });
        if (row && r.warm.outcome === "accepted") {
          return store.closeEscalation(row.id, row.version, { status: "accepted" });
        }
        return row;
      },
    },
    config: readOnCallConfig(
      over.env ?? {
        ON_CALL_ROTATION_MODE: "test",
        ON_CALL_CALLER_ID: ROTATION_CALLER_ID,
        ON_CALL_TEST_PHONES: TEST_PHONES.join(","),
      },
    ),
    store,
    rotation: { get: async () => rotation },
    consoleQuery: null,
    personIdFor: () => undefined,
    sendSms: async (input) => {
      order.push(`sms:${input.to}`);
      texts.push({ ...input, at: Date.now() });
      return { sid: `SM${texts.length}` };
    },
    now: () => at,
    noteHeldRequest: (callSid, data) => void held.push({ callSid, ...data }),
  };
  return { wiring, store, texts, handed, order, held };
}

function recordingAlerts(): { alerts: UrgentTransferAlerts; beforeDial: unknown[]; tickets: unknown[] } {
  const beforeDial: unknown[] = [];
  const tickets: unknown[] = [];
  return {
    alerts: {
      smsBeforeDial: (input) => void beforeDial.push(input),
      fallbackTicket: (input) => void tickets.push(input),
    },
    beforeDial,
    tickets,
  };
}

function transferWith(
  ops: TransferTwilioOps,
  onCall: OnCallTransferWiring | undefined,
  alerts = recordingAlerts().alerts,
  over: { env?: Record<string, string>; log?: (line: string) => void } = {},
) {
  return createRuntimeTransfer({
    env: { ...ENV, ...over.env },
    ops,
    domain: DOMAIN,
    onCall,
    urgentAlerts: alerts,
    persistOutcome: () => undefined,
    log: over.log ?? (() => undefined),
  });
}

function urgent(slug = "no-ivr") {
  escalationDetailsMap.set("CAcaller", {
    agentSlug: slug,
    callerType: "patient_urgent",
    reason: "Sudden loss of vision in the left eye",
  });
}

describe("an urgent after-hours call with the rotation on", () => {
  it("texts the full details to the week's on-call provider, then dials them from the rotation's caller ID", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const order = built.order;
    const wrapped: TransferTwilioOps = {
      ...ops,
      createOfficeLeg: async (input) => {
        order.push(`dial:${input.to}`);
        return ops.createOfficeLeg(input);
      },
    };
    const transfer = transferWith(wrapped, built.wiring);
    urgent();

    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    // Test mode: level 0 rings the first test phone, never a real provider.
    expect(dialed).toHaveLength(1);
    expect(dialed[0].to).toBe(TEST_PHONES[0]);
    expect(dialed[0].from).toBe(ROTATION_CALLER_ID);
    // The text went first, to the same phone, with the details in it.
    expect(order).toEqual([`sms:${TEST_PHONES[0]}`, `dial:${TEST_PHONES[0]}`]);
    expect(built.texts[0].from).toBe(ROTATION_CALLER_ID);
    expect(built.texts[0].body).toContain("Sudden loss of vision in the left eye");
    expect(built.texts[0].body).toContain("[TEST MODE]");

    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    const h = built.handed[0];
    expect(h.warm.outcome).toBe("accepted");
    expect(h.warm.dialedTo).toBe(TEST_PHONES[0]);
    expect(h.warm.providerCallSid).toBe("CAoffice");
    expect(h.mode).toBe("test");
    expect(h.callSid).toBe("CAcaller");
    expect(h.callerNumber).toBe(META.callerPhone);
    expect(h.preDialSms?.ok).toBe(true);
    // Provider 1 (Inland Empire), then the region's director, then the final director.
    expect(h.plan.levels.map((l) => l.role)).toEqual(["on_call", "region_director", "final"]);
    expect(h.plan.levels[0].providerId).toBe(1);
    expect(h.plan.levels[1].providerId).toBe(IE_DIRECTOR);
    expect(h.routing.reason).toBe("on_call");
  });

  it("times level 0's call from when its outcome arrived, not from when the text's record settled", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    let clock = AFTER_HOURS;
    built.wiring.now = () => clock;
    let release: () => void = () => undefined;
    built.wiring.sendSms = (input) => {
      built.texts.push({ ...input, at: Date.now() });
      return new Promise((resolve) => {
        release = () => resolve({ sid: "SM1" });
      });
    };
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    // The route waits for the text up to its own bound, then dials anyway.
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1), { timeout: 5_000 });
    const answered = new Date(AFTER_HOURS.getTime() + 40_000);
    clock = answered;
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    // The chain is handed over before the text's record is in (round 15).
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].preDialSms ?? null).toBeNull();
    // The text's record settles nine seconds later and reaches the runner late.
    clock = new Date(answered.getTime() + 9_000);
    release();
    expect(built.handed[0].warm.endedAt.getTime()).toBe(answered.getTime());
    expect((await built.handed[0].preDialSmsLate)?.ok).toBe(true);
  });

  // Review of #514, round 15: the hand-off waited up to 10 s for the text's
  // record before it opened the chain, so a slow send made the agent's 2 s
  // read miss a chain the runner opened a few seconds later.
  it("says the team is being paged when the text to level 0 never answers", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.handoffResultWaitMs = 300;
    built.wiring.sendSms = (input) => {
      built.texts.push({ ...input, at: Date.now() });
      return new Promise(() => undefined);
    };
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1), { timeout: 5_000 });
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    expect(rec.tickets[0]).toMatchObject({ onCallChain: true });
    expect(built.handed).toHaveLength(1);
    expect(built.handed[0].preDialSms ?? null).toBeNull();
    expect(built.handed[0].preDialSmsLate).toBeInstanceOf(Promise);
  });

  // Review of #514, round 9: a dial that threw after the rotation took it
  // reached the agent as the raw error, and no urgent ticket was filed.
  it("treats a dial that throws after the rotation took it as a failed first call", async () => {
    warm.throws = true;
    const { ops } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const lines: string[] = [];
    const transfer = transferWith(ops, built.wiring, rec.alerts, { log: (l) => void lines.push(l) });
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    expect(built.handed).toHaveLength(1);
    expect(built.handed[0].warm.outcome).toBe("failed");
    expect(built.handed[0].warm.providerCallSid).toBeNull();
    expect(rec.tickets).toHaveLength(1);
    expect(rec.tickets[0]).toMatchObject({ why: "Transfer dial failed: transfer_threw", onCallChain: true });
    expect(lines.join("\n")).toMatch(/the in-call dial threw after the rotation took it \(twilio blew up\)/);
  });

  it("lets a dial that throws with no rotation run reach the agent as it always has", async () => {
    warm.throws = true;
    const { ops } = fakeOps();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, undefined, rec.alerts);
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow("twilio blew up");
    expect(rec.tickets).toHaveLength(0);
  });

  it("hands a declined transfer to the runner as declined, and still tells the agent it failed", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("declined");
    // The office leg was dialled, so its call sid is logged even though it was not taken.
    expect(built.handed[0].warm.providerCallSid).toBe("CAoffice");
  });

  it("hands a ring-out to the runner as no answer, not as a failure (spec b)", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("no_answer");
    expect(built.handed[0].warm.providerCallSid).toBe("CAoffice");
  });

  it("files the ring-out ticket saying the rotation is still calling", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    expect(rec.tickets).toHaveLength(1);
    expect(rec.tickets[0]).toMatchObject({ onCallChain: true });
    // In test mode the phone that rang was a test number, and the ticket says
    // so: it names the level it stood in for, never a number (review of #514,
    // round 6).
    const level = built.handed[0].plan.levels[0];
    const dialTarget = String((rec.tickets[0] as { dialTarget?: unknown }).dialTarget);
    expect(dialTarget).toBe(`[TEST MODE] a test number, standing in for ${levelLabel(level)}`);
    expect(dialTarget).not.toContain(level.phone);
    expect(dialTarget).not.toMatch(/\d{7}/);
  });

  it("in live mode, names who was rung on the ring-out ticket, never their phone", async () => {
    const { ops } = fakeOps();
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: ROTATION_CALLER_ID } });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    const level = built.handed[0].plan.levels[0];
    const dialTarget = String((rec.tickets[0] as { dialTarget?: unknown }).dialTarget);
    expect(dialTarget).toBe(levelLabel(level));
    expect(dialTarget).toContain(level.name);
    expect(dialTarget).not.toContain("[TEST MODE]");
    expect(dialTarget).not.toContain(level.phone);
    expect(dialTarget).not.toMatch(/\d{7}/);
  });

  it("files the urgent ticket when a dial the rotation took over answers UNAVAILABLE, because the provider was texted", async () => {
    warm.unavailable = true;
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    // Nothing was dialled, but the provider was texted and the chain is open,
    // so this is not a refusal that rang nobody: the ticket goes out.
    expect(dialed).toHaveLength(0);
    expect(built.texts).toHaveLength(1);
    expect(built.handed[0].warm.outcome).toBe("failed");
    expect(rec.tickets).toHaveLength(1);
    expect(rec.tickets[0]).toMatchObject({ onCallChain: true, handoff: { status: "FAILED" } });
    expect((rec.tickets[0] as { dialTarget?: unknown }).dialTarget).toBe(
      `[TEST MODE] a test number, standing in for ${levelLabel(built.handed[0].plan.levels[0])}`,
    );
  });

  it("still files nothing for an UNAVAILABLE dial the rotation did not take", async () => {
    warm.unavailable = true;
    const { ops } = fakeOps();
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/^handoff_failed:UNAVAILABLE$/);
    expect(built.handed).toHaveLength(0);
    expect(rec.tickets).toHaveLength(0);
  });

  it("does not say the team is being paged when the runner opened no chain", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.runner = { afterInCallTransfer: async () => null };
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    expect(rec.tickets).toHaveLength(1);
    expect(rec.tickets[0]).not.toHaveProperty("onCallChain");
  });

  it("does not say the team is being paged when the runner answers with a chain that is no longer active", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const inner = built.wiring.runner.afterInCallTransfer;
    built.wiring.runner = {
      afterInCallTransfer: async (r) => {
        const row = await inner(r);
        return row ? { ...row, status: "exhausted" } : row;
      },
    };
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    expect(rec.tickets[0]).not.toHaveProperty("onCallChain");
  });

  it("does not say the team is being paged when the runner throws", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.runner = {
      afterInCallTransfer: async () => {
        throw new Error("runner broke");
      },
    };
    const lines: string[] = [];
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { log: (l) => void lines.push(l) });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    expect(rec.tickets[0]).not.toHaveProperty("onCallChain");
    expect(lines.some((l) => l.includes("could not hand the chain to the runner"))).toBe(true);
  });

  it("waits for a hand-off that answers inside the wait, and then says the team is being paged", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.handoffResultWaitMs = 1_000;
    const inner = built.wiring.runner.afterInCallTransfer;
    built.wiring.runner = {
      afterInCallTransfer: async (r) => {
        await new Promise((ok) => setTimeout(ok, 50));
        return inner(r);
      },
    };
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    expect(rec.tickets[0]).toMatchObject({ onCallChain: true });
  });

  it("reads a hand-off slower than the wait as not confirmed, and says so in the log", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.handoffResultWaitMs = 20;
    const inner = built.wiring.runner.afterInCallTransfer;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (finish = ok));
    built.wiring.runner = {
      afterInCallTransfer: async (r) => {
        await gate;
        return inner(r);
      },
    };
    const lines: string[] = [];
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { log: (l) => void lines.push(l) });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    expect(rec.tickets[0]).not.toHaveProperty("onCallChain");
    expect(lines.some((l) => l.includes("the hand-off had not answered after 20 ms"))).toBe(true);
    finish();
  });

  it("does not wait for the hand-off when the transfer was taken", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (finish = ok));
    built.wiring.runner = {
      afterInCallTransfer: async () => {
        await gate;
        return null;
      },
    };
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    finish();
  });

  it("keeps today's heads-up text to the urgent notification number, unchanged", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(rec.beforeDial).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("marks that heads-up text in test mode: the rotation is ringing test numbers, not the provider", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(rec.beforeDial).toHaveLength(1);
    const input = rec.beforeDial[0] as { note?: string; escalationDetails?: { reason?: string } };
    expect(input.note).toBe("[TEST MODE] The on-call rotation is ringing test numbers, not the provider.");
    // The patient's details are still in the text, never behind a link.
    expect(input.escalationDetails?.reason).toBe("Sudden loss of vision in the left eye");
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("names whose phone is ringing on that heads-up text in live mode", async () => {
    const { ops } = fakeOps();
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: ROTATION_CALLER_ID } });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    await vi.waitFor(() => expect(built.texts).toHaveLength(1));
    const input = rec.beforeDial[0] as { note?: string };
    const first = syntheticRotation().providers.find((p) => p.id === 1)!;
    expect(input.note).toBe(`The on-call rotation is ringing ${levelLabel({ role: "on_call", name: first.fullName })}.`);
    expect(input.note).not.toContain("[TEST MODE]");
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("times the ring-out ticket's ring from the dial, not from the dial plus the hand-off wait", async () => {
    const { ops } = fakeOps();
    const built = buildWiring();
    built.wiring.handoffResultWaitMs = 1_100;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (finish = ok));
    const inner = built.wiring.runner.afterInCallTransfer;
    built.wiring.runner = {
      afterInCallTransfer: async (r) => {
        await gate;
        return inner(r);
      },
    };
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    // The dial rang out at once; the 1.1 s spent waiting on the hand-off is not ringing.
    expect((rec.tickets[0] as { handoff: { ringSeconds: number } }).handoff.ringSeconds).toBe(0);
    finish();
  });

  it("never starts a second chain for one call: a second escalation dials nobody", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);

    urgent();
    // Its own slug: the chain is still paging, which is not "could not be placed".
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_RUNNING$/);
    expect(dialed).toHaveLength(1);
    expect(built.texts).toHaveLength(1);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    // The held request leaves one trace, since it writes no transfer outcome
    // (review of #514, round 11): the reason and the lane, nothing about the patient.
    expect(built.held).toEqual([{ callSid: "CAcaller", why: "active", slug: "no-ivr" }]);
  });

  it("covers the after-hours line only: the v2 agents do not know CHAIN_RUNNING", () => {
    expect([...ON_CALL_LANES]).toEqual(["no-ivr"]);
  });

  it("turns off whenever the after-hours line's transfer would be blind (review of #514, round 8)", () => {
    // The config reads RUNTIME_TRANSFER_MODE itself, so the boot line and
    // /voice/health say why; it must give the answer transferModeFor gives.
    for (const value of [undefined, "", "warm", "blind", " Blind ", "BLIND", "blindly", "cold"]) {
      const env = { TWILIO_PHONE_NUMBER: "+15550000001", ON_CALL_ROTATION_MODE: "live", RUNTIME_TRANSFER_MODE: value };
      for (const lane of ON_CALL_LANES) {
        const blind = transferModeFor(lane, env) === "blind";
        expect(readOnCallConfig(env).mode === "off", `RUNTIME_TRANSFER_MODE=${String(value)}`).toBe(blind);
      }
    }
  });
});

describe("one chain per call, read from the chain's own row", () => {
  it("refuses a second escalation that arrives while the first is still being routed", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = built.wiring.rotation.get;
    const wiring: OnCallTransferWiring = {
      ...built.wiring,
      rotation: { get: async () => (await gate, realGet()) },
    };
    const transfer = transferWith(ops, wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    urgent();
    // The first is still being routed: its own slug, which claims neither way
    // whether the chain is paging (review of #514).
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_PENDING$/);
    expect(dialed).toHaveLength(0);
    expect(built.held).toEqual([{ callSid: "CAcaller", why: "pending", slug: "no-ivr" }]);
    expect(events.emitted).toEqual([]);

    release();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await first;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
  });

  it("writes the held request to the call's event log by default, with the reason and nothing about the patient", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = built.wiring.rotation.get;
    const { noteHeldRequest: _injected, ...rest } = built.wiring;
    const wiring: OnCallTransferWiring = { ...rest, rotation: { get: async () => (await gate, realGet()) } };
    const transfer = transferWith(ops, wiring);
    const handoff = transfer.handoffFor("no-ivr", META);
    events.emitted.length = 0;

    urgent();
    const first = handoff();
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_PENDING$/);
    await vi.waitFor(() => expect(events.emitted).toHaveLength(1));
    expect(events.emitted[0]).toEqual([
      "CAcaller",
      "warn",
      "handoff",
      ON_CALL_SECOND_REQUEST_HELD,
      { why: "pending" },
      { callSid: "CAcaller", agentSlug: "no-ivr" },
    ]);

    release();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await first;
    // The first escalation's own path writes no held-request event.
    expect(events.emitted).toHaveLength(1);
  });

  it("takes today's path for an escalation after this call's chain has finished", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await first;
    await vi.waitFor(() => expect([...built.store.escalations.values()][0]?.status).toBe("accepted"));

    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    expect(dialed[1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[1].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    expect(built.texts).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    expect(built.handed).toHaveLength(1);

    // And the call is not left claimed by that read: a third escalation
    // reads the finished row again and rings the fixed number too.
    urgent();
    const third = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(3);
    expect(dialed[2].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await third;
    expect(built.handed).toHaveLength(1);
  });

  it("routes a second escalation again when the runner could not open a row for the first", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    built.store.failWrites = true;
    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    // No row was opened, so nothing is paging: the agent hears that nobody answered.
    await expect(first).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    built.store.failWrites = false;

    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    expect(dialed[1].to).toBe(TEST_PHONES[0]);
    expect(built.texts).toHaveLength(2);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    await vi.waitFor(() => expect(built.handed).toHaveLength(2));
  });

  it("lets only one of two same-tick escalations start a chain once the first chain is over", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    built.store.failWrites = true;
    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    // No row was opened, so nothing is paging: the agent hears that nobody answered.
    await expect(first).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    built.store.failWrites = false;

    urgent();
    const second = handoff();
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_PENDING$/);
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    await vi.waitFor(() => expect(built.handed).toHaveLength(2));
  });

  it("takes today's path when the chain's row cannot be read", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const lines: string[] = [];
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));

    built.store.getEscalationByCall = async () => {
      throw new Error("hub unreachable");
    };
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(built.texts).toHaveLength(1);
    expect(lines.some((l) => l.includes("could not read this call's escalation"))).toBe(true);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;
    expect(built.handed).toHaveLength(1);
  });

  it("does not leave the call claimed after its record could not be read", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));

    const realGet = built.store.getEscalationByCall.bind(built.store);
    built.store.getEscalationByCall = async () => {
      throw new Error("hub unreachable");
    };
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;

    // The record can be read again, and this call's chain has since ended.
    built.store.getEscalationByCall = realGet;
    const row = [...built.store.escalations.values()][0];
    row.status = "exhausted";
    urgent();
    const third = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(3);
    expect(dialed[2].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await third;
  });

  it("takes today's path when the chain's row read never answers, and leaves the call unclaimed", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    built.wiring.chainReadWaitMs = 10;
    const lines: string[] = [];
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));

    // A Hub read that never answers (the pools carry no statement timeout).
    const realGet = built.store.getEscalationByCall.bind(built.store);
    built.store.getEscalationByCall = () => new Promise(() => {});
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(lines.some((l) => l.includes("could not be read within 10 ms"))).toBe(true);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await second;

    // The hung read gave the claim back: with the record readable again and the
    // chain over, a third escalation takes today's path, not "still being handed over".
    built.store.getEscalationByCall = realGet;
    const row = [...built.store.escalations.values()][0];
    row.status = "exhausted";
    urgent();
    const third = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(3);
    expect(dialed[2].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await third;
    expect(built.handed).toHaveLength(1);
  });

  it("releases the call's claim when the hand-off never answers, and a late answer does not undo a later claim", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    built.wiring.handoffResultWaitMs = 10;
    // Long enough that the second hand-off is still inside its bound when the
    // third escalation arrives, so the guard on the late release is what decides.
    built.wiring.handoffSettleMs = 400;
    const inner = built.wiring.runner.afterInCallTransfer;
    let calls = 0;
    let finishFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((ok) => (finishFirst = ok));
    let finishSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((ok) => (finishSecond = ok));
    built.wiring.runner = {
      afterInCallTransfer: async (r) => {
        const n = ++calls;
        // Neither hand-off answers until its gate is lifted, and the first opens no row.
        await (n === 1 ? firstGate : secondGate);
        return n === 1 ? null : inner(r);
      },
    };
    const lines: string[] = [];
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    const handoff = transfer.handoffFor("no-ivr", META);

    urgent();
    const first = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(first).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);

    // While the first hand-off is stuck, a second escalation is refused, and
    // told the hand-off is still under way, not that the chain is paging: the
    // runner may yet open nothing (review of #514).
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_PENDING$/);

    // Past the bound the claim is released, so the next escalation routes again.
    await vi.waitFor(() => expect(lines.some((l) => l.includes("releasing this call's chain claim"))).toBe(true), {
      timeout: 3_000,
    });
    urgent();
    const second = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed).toHaveLength(2);
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(second).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);

    // The first hand-off answers late. It must not release the second's claim.
    finishFirst();
    await new Promise((ok) => setTimeout(ok, 5));
    urgent();
    await expect(handoff()).rejects.toThrow(/^handoff_failed:CHAIN_PENDING$/);
    expect(dialed).toHaveLength(2);
    finishSecond();
  });

  it("hands the chain to the runner as failed when the dial throws after the provider was texted", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const alerts: UrgentTransferAlerts = {
      smsBeforeDial: () => {
        throw new Error("alert sender broke");
      },
      fallbackTicket: () => undefined,
    };
    const transfer = transferWith(ops, built.wiring, alerts);
    urgent();
    // Since round 9 of the review the agent hears what the chain is doing, not
    // the raw error: the provider was texted, so the runner carries on.
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/^handoff_failed:CHAIN_STARTED$/);
    expect(dialed).toHaveLength(0);
    expect(built.texts).toHaveLength(1);
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].warm.outcome).toBe("failed");
    expect(built.handed[0].warm.providerCallSid).toBeNull();
  });
});

describe("which dials the rotation may take", () => {
  it("never takes a PCP dial, which goes to the PCP queue", () => {
    expect(rotationMayTakeTheDial({ allowed: true, destination: "+15550004300", policy: "pcp" })).toBe(false);
    expect(rotationMayTakeTheDial({ allowed: true, destination: "+15550004300", policy: "clinical" })).toBe(true);
    expect(rotationMayTakeTheDial({ allowed: false, reason: "pcp_destination_not_configured" })).toBe(false);
    expect(rotationMayTakeTheDial({ allowed: false, reason: "clinical_destination_not_configured" })).toBe(true);
  });

  it("rings the rotation's level 0 when HUMAN_AGENT_NUMBER is not set", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { env: { HUMAN_AGENT_NUMBER: "" } });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(TEST_PHONES[0]);
    expect(dialed[0].from).toBe(ROTATION_CALLER_ID);
    expect(rec.beforeDial).toHaveLength(1);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
  });

  it("dials nobody when HUMAN_AGENT_NUMBER is not set and the rotation is off, as today", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts, { env: { HUMAN_AGENT_NUMBER: "" } });
    urgent();
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(dialed).toHaveLength(0);
    expect(rec.beforeDial).toHaveLength(0);
    expect(built.texts).toHaveLength(0);
  });

  it("leaves a caller type the policy does not transfer refused, without reading the rotation", async () => {
    const { ops, dialed } = fakeOps();
    const built = buildWiring();
    const get = vi.fn(built.wiring.rotation.get);
    const transfer = transferWith(ops, { ...built.wiring, rotation: { get } });
    escalationDetailsMap.set("CAcaller", { agentSlug: "no-ivr", callerType: "general_inquiry", reason: "Office hours" });
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(dialed).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
    expect(built.texts).toHaveLength(0);
  });
});

describe("live mode: a level with no phone", () => {
  const LIVE = { ON_CALL_ROTATION_MODE: "live", ON_CALL_CALLER_ID: ROTATION_CALLER_ID };

  it("names the level actually rung on the heads-up text, not the one with no phone", async () => {
    const base = syntheticRotation();
    const rotation: RotationData = {
      ...base,
      providers: base.providers.map((p) => (p.id === 1 ? provider(1, "Inland Empire", { phone: "" }) : p)),
    };
    const { ops } = fakeOps();
    const built = buildWiring({ env: LIVE, rotation });
    const rec = recordingAlerts();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    const director = base.providers.find((p) => p.id === IE_DIRECTOR)!;
    const skipped = base.providers.find((p) => p.id === 1)!;
    expect((rec.beforeDial[0] as { note?: string }).note).toBe(
      `The on-call rotation is ringing ${levelLabel({ role: "region_director", name: director.fullName })}. ` +
        `${levelLabel({ role: "on_call", name: skipped.fullName })} has no dialable number on file and was not called.`,
    );
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("skips a first level with no phone and rings the next level", async () => {
    const base = syntheticRotation();
    const rotation: RotationData = {
      ...base,
      providers: base.providers.map((p) => (p.id === 1 ? provider(1, "Inland Empire", { phone: "" }) : p)),
    };
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: LIVE, rotation });
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    const director = base.providers.find((p) => p.id === IE_DIRECTOR)!;
    expect(dialed[0].to).toBe(director.phone);
    expect(built.texts[0].to).toBe(director.phone);
    expect(built.texts[0].body).not.toContain("[TEST MODE]");
    // The first provider's text says who was passed over and why, so they
    // know the chain started with them (review of #514, round 10).
    const skipped = base.providers.find((p) => p.id === 1)!;
    const skipLine = `${levelLabel({ role: "on_call", name: skipped.fullName })} has no dialable number on file and was not called.`;
    expect(built.texts[0].body).toContain(skipLine);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].plan.levels[0].role).toBe("region_director");
    expect(built.handed[0].plan.notes).toContain("first_level_no_phone:on_call:1");
    // Every later text in the chain carries it too.
    expect(built.handed[0].routing.note).toContain(skipLine);
  });

  it("says nothing about a skipped level when none was skipped", async () => {
    const { ops } = fakeOps();
    const built = buildWiring({ env: LIVE });
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(built.texts[0].body).not.toContain("no dialable number");
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    await vi.waitFor(() => expect(built.handed).toHaveLength(1));
    expect(built.handed[0].routing.note ?? "").not.toContain("no dialable number");
  });

  it("takes today's path when no level has a phone", async () => {
    const base = syntheticRotation();
    const rotation: RotationData = { ...base, providers: base.providers.map((p) => ({ ...p, phone: "" })) };
    const { ops, dialed } = fakeOps();
    const built = buildWiring({ env: LIVE, rotation });
    const transfer = transferWith(ops, built.wiring);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[0].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    expect(built.texts).toHaveLength(0);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(built.handed).toHaveLength(0);
  });
});

describe("today's path, byte for byte", () => {
  async function ringsTheFixedNumber(onCall: OnCallTransferWiring | undefined, slug = "no-ivr") {
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, onCall);
    urgent(slug);
    const outcome = transfer.handoffFor(slug, META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(dialed[0].from).toBe(ENV.TWILIO_PHONE_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  }

  it("with no on-call wiring at all", async () => {
    await ringsTheFixedNumber(undefined);
  });

  it("with the rotation switched off", async () => {
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("with the rotation switched off, the heads-up text carries no rotation line", async () => {
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    const rec = recordingAlerts();
    const { ops } = fakeOps();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(rec.beforeDial).toHaveLength(1);
    expect(rec.beforeDial[0]).not.toHaveProperty("note");
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
  });

  it("with the rotation switched off, never reads the rotation or the caller's identity and logs nothing about it", async () => {
    const built = buildWiring({ env: { ON_CALL_ROTATION_MODE: "off" } });
    const personIdFor = vi.fn(() => undefined);
    const get = vi.fn(built.wiring.rotation.get);
    const wiring = { ...built.wiring, personIdFor, rotation: { get } };
    const lines: string[] = [];
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, wiring, recordingAlerts().alerts, { log: (l) => void lines.push(l) });
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(personIdFor).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes("[ON-CALL]"))).toEqual([]);
  });

  it("when the deployment forces a blind transfer on the after-hours lane, which the chain cannot follow", async () => {
    const built = buildWiring();
    const queued: string[] = [];
    const { ops, dialed } = fakeOps();
    ops.redirectCallerToQueue = async (input) => {
      queued.push(input.destination);
    };
    const transfer = transferWith(ops, built.wiring, recordingAlerts().alerts, { env: { RUNTIME_TRANSFER_MODE: "blind" } });
    urgent();
    await transfer.handoffFor("no-ivr", META)();
    expect(dialed).toHaveLength(0);
    expect(queued).toEqual([ENV.HUMAN_AGENT_NUMBER]);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("in weekday daytime hours, which are not on call", async () => {
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("in weekday daytime hours, a ring-out still tells the agent nobody answered, and its ticket names no chain", async () => {
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    const rec = recordingAlerts();
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, built.wiring, rec.alerts);
    urgent();
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(dialed[0].to).toBe(ENV.HUMAN_AGENT_NUMBER);
    transfer.handleStatus(signed(TRANSFER_STATUS_PATH, { CallSid: "CAoffice", CallStatus: "no-answer" }));
    await expect(outcome).rejects.toThrow(/^handoff_failed:NO_ANSWER$/);
    expect(rec.tickets).toHaveLength(1);
    expect(rec.tickets[0]).not.toHaveProperty("onCallChain");
    // Off the rotation the ticket still names the number it rang, as before.
    expect((rec.tickets[0] as { dialTarget?: unknown }).dialTarget).toBe(ENV.HUMAN_AGENT_NUMBER);
    expect(built.handed).toHaveLength(0);
  });

  it("in weekday daytime hours, for every escalation on the call, not only the first", async () => {
    const built = buildWiring({ at: WEEKDAY_DAYTIME });
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops, built.wiring);
    const handoff = transfer.handoffFor("no-ivr", META);
    for (const n of [1, 2]) {
      urgent();
      const outcome = handoff();
      await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
      expect(dialed).toHaveLength(n);
      expect(dialed[n - 1].to).toBe(ENV.HUMAN_AGENT_NUMBER);
      transfer.handleAccept(signed(TRANSFER_ACCEPT_PATH, { CallSid: "CAoffice", Digits: "1" }));
      await outcome;
    }
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("when the rotation tables are not there yet (the migration not applied)", async () => {
    const built = buildWiring({ available: false });
    await ringsTheFixedNumber(built.wiring);
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });

  it("on a lane that is not the after-hours family", async () => {
    const built = buildWiring();
    await ringsTheFixedNumber(built.wiring, "answering-service");
    expect(built.texts).toHaveLength(0);
    expect(built.handed).toHaveLength(0);
  });
});

describe("the rotation line on the urgent heads-up text", () => {
  const plan = {
    levels: [
      { role: "surgeon" as const, providerId: 7, name: "Dr. Example Surgeon", phone: "+15550777777" },
      { role: "final" as const, providerId: 9, name: "Dr. Example Final", phone: "+15550999999" },
    ],
    notes: [],
  };

  it("in live mode names the first level the chain rings, by role", () => {
    expect(urgentTextRotationNote(plan, "live")).toBe(
      "The on-call rotation is ringing Dr. Example Surgeon (the patient's surgeon).",
    );
  });

  it("in test mode says the rotation is ringing test numbers, and names nobody", () => {
    const note = urgentTextRotationNote(plan, "test")!;
    expect(note).toBe("[TEST MODE] The on-call rotation is ringing test numbers, not the provider.");
    expect(note).not.toContain("Example");
  });

  it("says nothing for a plan with no level", () => {
    expect(urgentTextRotationNote({ levels: [], notes: [] }, "live")).toBeUndefined();
  });
});

describe("who the urgent ring-out ticket says was rung", () => {
  const plan = {
    levels: [{ role: "on_call" as const, providerId: 3, name: "Dr. Example On Call", phone: "+15550333333" }],
    notes: [],
  };

  it("in live mode names the level, by role, and no number", () => {
    expect(ringOutDialTarget(plan, "live")).toBe(levelLabel(plan.levels[0]));
  });

  it("in test mode says a test number rang in the level's place", () => {
    const target = ringOutDialTarget(plan, "test")!;
    expect(target).toBe(`[TEST MODE] a test number, standing in for ${levelLabel(plan.levels[0])}`);
    expect(target).not.toContain("+1555");
  });

  it("says nothing for a plan with no level, so the ticket keeps the dial's own target", () => {
    expect(ringOutDialTarget({ levels: [], notes: [] }, "live")).toBeUndefined();
  });
});
