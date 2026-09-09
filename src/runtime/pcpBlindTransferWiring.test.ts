/**
 * PCP GOES BLIND, EVERY OTHER LANE STAYS WARM — proved through the real
 * composition, not through the pieces.
 *
 * blindTransfer.test.ts proves the mechanism and blindTransferDialResult.test.ts
 * proves the callback. Neither can prove they are WIRED, and that is exactly
 * the failure mode CLAUDE.md #10 names: a suite that asserts against the last
 * component in a chain proves the chain has an end, not that it is connected.
 *
 * So everything here runs through `createRuntimeTransfer` — the same object
 * `voiceRuntime` mounts — and asserts on what Twilio was asked to do and what
 * the outcome store ended up holding.
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * PIN THE CLOCK — this file was red for exactly one hour every weekday.
 *
 * `PcpDirector` reads the Pacific wall clock: `isLunchClosure()` is true when
 * the local hour is 12 on a weekday, and `eligibleByAsk` is
 * `askedForAPerson && !handoffFailed && !lunchClosure`. So between 12:00 and
 * 12:59 Pacific an explicit ask stops being eligible, the agent files a
 * CREATE_TASK instead of dialling, and every test here that expects a transfer
 * fails. Measured 2026-09-09: green at 11:54 PDT, all 33 tests across the six
 * affected files red from 12:01 PDT, green again with `isLunchClosure` forced
 * off.
 *
 * The director is a module singleton, so its `lunchClosure` injection seam is
 * not reachable from here. Pinning the clock to a weekday MORNING keeps the
 * real closure logic in the path — it is exercised, and correctly returns
 * false — rather than mocking it away. Lunch closure itself is covered by
 * `lunchClosure.test.ts`.
 *
 * Only `Date` is faked; timers stay real, so anything awaiting a timeout still
 * resolves. Same trap as `.agents/memory/measurement-traps.md`: "a test that
 * reads the wall clock is wrong at a predictable time."
 */
const NOT_LUNCH = new Date('2026-09-09T17:00:00Z'); // Wed 10:00 PDT
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOT_LUNCH);
});
afterAll(() => {
  vi.useRealTimers();
});
import twilio from "twilio";
import {
  createRuntimeTransfer,
  transferModeFor,
  TRANSFER_DIAL_RESULT_PATH,
} from "./runtimeTransfer";
import type { TransferTwilioOps } from "./warmTransfer";
import { peekRuntimeTransferOutcome, clearRuntimeTransferOutcomes } from "./transferOutcomeLog";
import { escalationDetailsMap } from "../services/escalationStore";

import type { RuntimeTransferOutcome } from "./transferOutcomeLog";
import type { WebhookRequest } from "./voiceWebhook";

/**
 * The outcome writer, injected rather than module-mocked.
 *
 * `createRuntimeTransfer` takes `persistOutcome` for exactly this: the two
 * call sites that write (the settle, and the dial-result callback) are the
 * thing under test here, and a module mock could not be made to intercept
 * both reliably — which would have left the dial-result write unproven while
 * the suite looked green.
 */
const persisted: Array<{ sid: string; outcome: RuntimeTransferOutcome }> = [];

const AUTH_TOKEN = "test-auth-token";
const DOMAIN = "runtime.example.test";
const ENV = {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_PHONE_NUMBER: "+15550000000",
  HUMAN_AGENT_NUMBER: "+18185551234",
  PCP_HUMAN_AGENT_NUMBER: "+17149564300",
};
const META = {
  callSid: "CApcp",
  callId: "CApcp",
  callerPhone: "+15551234567",
  dialedNumber: "+15559876543",
};

function fakeOps() {
  const calls: string[] = [];
  const queued: Array<{ callerCallSid: string; destination: string; actionUrl: string }> = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async () => {
      calls.push("createOfficeLeg");
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async () => {
      calls.push("redirectCallerToConference");
    },
    endCall: async () => {
      calls.push("endCall");
    },
    redirectCallerToQueue: async ({ callerCallSid, destination, actionUrl }) => {
      calls.push("redirectCallerToQueue");
      queued.push({ callerCallSid, destination, actionUrl });
    },
  };
  return { ops, calls, queued };
}

function transferWith(ops: TransferTwilioOps, env: Record<string, string | undefined> = ENV) {
  return createRuntimeTransfer({
    env,
    ops,
    domain: DOMAIN,
    persistOutcome: (sid, outcome) => void persisted.push({ sid, outcome }),
    log: () => undefined,
  });
}

/** The side channel the PCP agent writes before invoking the handoff. */
function pcpEscalation(over: Record<string, unknown> = {}) {
  escalationDetailsMap.set(META.callId, {
    agentSlug: "pcp",
    callerType: "outside_referral_status",
    callerRequestedHuman: true,
    reason: "Referral coordinator asking to speak with a representative",
    briefingGaps: ["callerRole"],
    askedBeforeDial: true,
    ...over,
  } as never);
}

function signedDialResult(body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: DOMAIN,
      "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        `https://${DOMAIN}${TRANSFER_DIAL_RESULT_PATH}`,
        body,
      ),
    },
    body,
    originalUrl: TRANSFER_DIAL_RESULT_PATH,
  };
}

beforeEach(() => {
  clearRuntimeTransferOutcomes();
  persisted.length = 0;
});
afterEach(() => {
  escalationDetailsMap.clear();
});

describe("which lane gets which shape", () => {
  it("PCP is blind by default and every other lane is warm", () => {
    expect(transferModeFor("pcp", {})).toBe("blind");
    for (const slug of ["no-ivr", "no-ivr-v2", "dev-no-ivr", "azul-scheduling"]) {
      expect(transferModeFor(slug, {})).toBe("warm");
    }
  });

  /**
   * A live behaviour change on the busiest lane needs a revert that does not
   * need a code change — the operator republishes from Replit and an env var
   * is the only lever that acts at that speed.
   */
  it("RUNTIME_TRANSFER_MODE overrides both directions, and nothing else does", () => {
    expect(transferModeFor("pcp", { RUNTIME_TRANSFER_MODE: "warm" })).toBe("warm");
    expect(transferModeFor("no-ivr", { RUNTIME_TRANSFER_MODE: "blind" })).toBe("blind");
    // Garbage falls back to the per-lane default rather than to one of them.
    expect(transferModeFor("pcp", { RUNTIME_TRANSFER_MODE: "sideways" })).toBe("blind");
    expect(transferModeFor("no-ivr", { RUNTIME_TRANSFER_MODE: "sideways" })).toBe("warm");
  });
});

describe("a PCP transfer dials nobody and moves the caller", () => {
  it("redirects the caller to the queue instead of creating an office leg", async () => {
    const { ops, calls, queued } = fakeOps();
    const transfer = transferWith(ops);
    pcpEscalation();

    const outcome = await transfer.handoffFor("pcp", META)();

    // The whole shape in one assertion: no office leg was dialled, no
    // conference was built, and the caller went straight to the queue.
    expect(calls).toEqual(["redirectCallerToQueue"]);
    expect(queued[0]).toEqual({
      callerCallSid: "CApcp",
      destination: "+17149564300",
      actionUrl: `https://${DOMAIN}${TRANSFER_DIAL_RESULT_PATH}`,
    });
    // And the PCP tool is told it was HANDED OVER, not connected — the flag
    // that keeps `CONNECTED` off a ticket nobody has proven.
    expect(outcome).toEqual({
      ok: true,
      destination: "+17149564300",
      handedToQueue: true,
    });
  });

  it("no-ivr still dials an office leg and waits for a keypress", async () => {
    const { ops, calls } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CApcp", {
      agentSlug: "no-ivr",
      callerType: "patient_urgent",
      reason: "Sudden vision loss",
    } as never);

    // Abandoning settles the wait immediately; the point is only that the
    // office leg was created at all, which the blind path never does.
    const promise = transfer.handoffFor("no-ivr", META)().catch(() => undefined);
    await Promise.resolve();
    transfer.abandonFor("CApcp");
    await promise;

    expect(calls).toContain("createOfficeLeg");
    expect(calls).not.toContain("redirectCallerToQueue");
  });
});

describe("the record says what is known, then what happened", () => {
  it("stops at handed_to_queue at the redirect — nothing has answered yet", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    pcpEscalation();

    await transfer.handoffFor("pcp", META)();

    const record = peekRuntimeTransferOutcome("CApcp");
    expect(record).toMatchObject({
      outcome: "handed_to_queue",
      status: "HANDED_TO_QUEUE",
      dialedNumber: "+17149564300",
      method: "blind",
      pipeline: "grok",
      attempt: 1,
      // "Build it and the telemetry" — the operator, on the one-round intake.
      briefingGaps: ["callerRole"],
      askedBeforeDial: true,
    });
    // Nothing was accepted, so nothing claims to have been.
    expect(record?.acceptMethod).toBeUndefined();
    expect(record?.officeCallSid).toBeUndefined();
  });

  /**
   * THE CHAIN THIS FILE EXISTS FOR. The redirect stores the attempt id and the
   * gaps; the dial result — a separate HTTP request, minutes later, after the
   * side channel has been deleted — has to find both. If the pending map is
   * not wired, this test sees the redirect's record unchanged.
   */
  it("upgrades that record when Twilio reports the queue answered", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    pcpEscalation();
    await transfer.handoffFor("pcp", META)();
    // The agent's own side channel is gone by now — the attempt's `finally`
    // clears it so a caller's name and callback number do not sit in a
    // process-wide map. The telemetry below can only come from the snapshot.
    expect(escalationDetailsMap.has(META.callId)).toBe(false);

    const res = transfer.handleDialResult(
      signedDialResult({
        CallSid: "CApcp",
        DialCallStatus: "completed",
        DialCallDuration: "84",
      }),
    );

    expect(res.status).toBe(200);
    const record = peekRuntimeTransferOutcome("CApcp");
    expect(record).toMatchObject({
      outcome: "queue_answered",
      acceptMethod: "dial_answered",
      talkSeconds: 84,
      method: "blind",
      briefingGaps: ["callerRole"],
      askedBeforeDial: true,
      // The SAME attempt, updated — not a second attempt appended.
      attempt: 1,
    });
  });

  it("downgrades it to no_answer when the queue never picked up", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    pcpEscalation();
    await transfer.handoffFor("pcp", META)();

    transfer.handleDialResult(
      signedDialResult({ CallSid: "CApcp", DialCallStatus: "no-answer" }),
    );

    expect(peekRuntimeTransferOutcome("CApcp")).toMatchObject({
      outcome: "no_answer",
      status: "NO-ANSWER",
      attempt: 1,
    });
  });

  /**
   * THE ROW IS WRITTEN TWICE, AND BOTH WRITES MATTER.
   *
   * The redirect's write is what stops `transfer_outcome` being NULL when the
   * dial result never arrives (a redeploy, a lost callback) — the honest floor.
   * The dial result's write is what turns that floor into an answer. A build
   * that took the first and dropped the second would look correct in the store
   * on a happy path and go silent on every real question about the queue.
   */
  it("writes the row once at the redirect and again when the dial result lands", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    pcpEscalation();
    await transfer.handoffFor("pcp", META)();
    transfer.handleDialResult(
      signedDialResult({ CallSid: "CApcp", DialCallStatus: "completed", DialCallDuration: "3" }),
    );

    expect(persisted.map((p) => p.sid)).toEqual(["CApcp", "CApcp"]);
    expect(persisted.map((p) => p.outcome.outcome)).toEqual([
      "handed_to_queue",
      "queue_answered",
    ]);
    // The SECOND write carries the attempt the FIRST one opened — it is an
    // update of one transfer, not two competing rows.
    expect(persisted[0].outcome.attempt).toBe(1);
    expect(persisted[1].outcome.attempt).toBe(1);
  });
});

describe("a blind transfer that never left the ground", () => {
  it("records nothing when policy withheld a destination — no dial was attempted", async () => {
    const { ops, calls } = fakeOps();
    // PCP's number unset: resolveHandoffDestination refuses, and
    // performBlindTransfer returns UNAVAILABLE before touching the caller.
    const transfer = transferWith(ops, { ...ENV, PCP_HUMAN_AGENT_NUMBER: undefined });
    pcpEscalation();

    const outcome = await transfer.handoffFor("pcp", META)();

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, status: "HANDOFF_UNAVAILABLE" });
    // NULL means "no transfer was attempted", and that meaning is the whole
    // value of the column (Codex P2, PR #273).
    expect(peekRuntimeTransferOutcome("CApcp")).toBeUndefined();
  });

  it("records a failed redirect, because that one really was attempted", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith({
      ...ops,
      redirectCallerToQueue: async () => {
        throw new Error("twilio said no");
      },
    });
    pcpEscalation();

    const outcome = await transfer.handoffFor("pcp", META)();

    expect(outcome).toMatchObject({ ok: false, status: "FAILED" });
    expect(peekRuntimeTransferOutcome("CApcp")).toMatchObject({
      outcome: "failed",
      reason: "caller_redirect_failed",
      dialedNumber: "+17149564300",
      method: "blind",
    });
  });
});
