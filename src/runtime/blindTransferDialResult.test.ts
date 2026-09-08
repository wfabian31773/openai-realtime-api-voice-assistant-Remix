/**
 * DID THE PCP QUEUE ACTUALLY ANSWER? — the only place a blind transfer can say.
 *
 * The warm path learns a human is present from a keypress. This path has none,
 * so without the `<Dial action>` callback every blind transfer would stop at
 * `handed_to_queue` and the question would be unanswerable from our own data.
 * That is the same blindness that made this week's PCP forensic impossible
 * (`transfer_outcome` NULL on every runtime call), so it is guarded here as a
 * property rather than left to be noticed later.
 *
 * The distinction this file exists to protect: **an ACD answering is not a
 * human speaking.** `DialCallStatus: completed` means the queue picked up; the
 * caller may have spent all of it in hold music. It records as
 * `queue_answered` with `talkSeconds` beside it, never as `accepted`, which
 * stays reserved for a keypress. A query that cannot tell those apart cannot
 * answer the operator's real question about queue capacity.
 */
import { describe, it, expect } from "vitest";
import twilio from "twilio";
import {
  classifyDialStatus,
  handleBlindDialResult,
  type DialResultDeps,
  type PendingBlindDial,
} from "./blindTransferDialResult";
import type { RuntimeTransferOutcome } from "./transferOutcomeLog";
import type { WebhookRequest } from "./voiceWebhook";

const AUTH_TOKEN = "test-auth-token";
const HOST = "example.test";
const PATH = "/voice/transfer-dial-result";

function req(body: Record<string, string>, sign = true): WebhookRequest {
  const signature = sign
    ? twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://${HOST}${PATH}`, body)
    : "not-a-real-signature";
  return {
    headers: { host: HOST, "x-forwarded-proto": "https", "x-twilio-signature": signature },
    body,
    originalUrl: PATH,
  };
}

const PENDING: PendingBlindDial = {
  attemptId: 7,
  destination: "+17149564300",
  redirectedAtMs: 1_000_000,
  briefingGaps: ["callerRole"],
  askedBeforeDial: true,
};

type Written = {
  callerCallSid: string;
  outcome: Omit<RuntimeTransferOutcome, "pipeline" | "attempt" | "at">;
  attemptId: number;
};

function harness(over: { pending?: PendingBlindDial | undefined; nowMs?: number } = {}) {
  const written: Written[] = [];
  const forgotten: string[] = [];
  const pending = "pending" in over ? over.pending : PENDING;
  const deps: DialResultDeps = {
    env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
    pendingFor: () => pending,
    forget: (sid) => void forgotten.push(sid),
    record: (callerCallSid, outcome, attemptId) =>
      void written.push({ callerCallSid, outcome, attemptId }),
    now: () => over.nowMs ?? 1_000_000 + 95_000,
    log: () => undefined,
  };
  return { deps, written, forgotten };
}

describe("an ACD answering is not a human speaking", () => {
  it("records completed as queue_answered, NEVER as accepted", () => {
    const { deps, written } = harness();
    handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "completed", DialCallDuration: "62" }),
      deps,
    );
    expect(written[0].outcome.outcome).toBe("queue_answered");
    // `accepted` is the warm path's word for a keypress. If this ever becomes
    // `accepted`, every "reached a human" figure silently absorbs every caller
    // who gave up in hold music.
    expect(written[0].outcome.outcome).not.toBe("accepted");
    expect(written[0].outcome.acceptMethod).toBe("dial_answered");
    expect(written[0].outcome.talkSeconds).toBe(62);
  });

  /**
   * Ring is what is LEFT after the bridge: Twilio calls the action URL when
   * the dial ENDS, so the elapsed span covers ringing plus talking. Getting
   * this backwards would report a 62-second conversation as 62 seconds of
   * ringing, which is the opposite reading of the same call.
   */
  it("separates ring from talk instead of reporting the whole span as ring", () => {
    const { deps, written } = harness({ nowMs: 1_000_000 + 95_000 });
    handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "completed", DialCallDuration: "62" }),
      deps,
    );
    expect(written[0].outcome.ringSeconds).toBe(33);
  });

  it("never reports a negative ring when the two clocks disagree", () => {
    const { deps, written } = harness({ nowMs: 1_000_000 + 1_000 });
    handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "completed", DialCallDuration: "62" }),
      deps,
    );
    expect(written[0].outcome.ringSeconds).toBe(0);
  });
});

describe("a dial that never connected", () => {
  it.each([
    ["no-answer", "no_answer"],
    ["busy", "no_answer"],
    ["failed", "failed"],
    ["canceled", "failed"],
  ])("records %s as %s and claims no answer method", (dialStatus, expected) => {
    const { deps, written } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: dialStatus }), deps);
    expect(written[0].outcome.outcome).toBe(expected);
    expect(written[0].outcome.acceptMethod).toBeUndefined();
    expect(written[0].outcome.talkSeconds).toBeUndefined();
  });

  /**
   * The caller is holding a line whose agent died with the redirect. This
   * response is the only voice left, and #265 governs what it may say — see
   * blindTransfer.test.ts for the copy guard.
   */
  it("speaks to the caller and hangs up, rather than leaving them in silence", () => {
    const { deps } = harness();
    const res = handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "no-answer" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("<Say");
    expect(res.body).toContain("recorded and the team will follow up with you");
    expect(res.body).toContain("<Hangup/>");
  });

  it("says nothing when the legs DID talk — there is nobody left to say it to", () => {
    const { deps } = harness();
    const res = handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "completed", DialCallDuration: "62" }),
      deps,
    );
    expect(res.body).not.toContain("<Say");
    expect(res.body).toContain("<Hangup/>");
  });
});

describe("the record lands on the right attempt, carrying the right telemetry", () => {
  /**
   * The attempt id is what makes this an UPDATE of the redirect's own record
   * rather than a competing row. Losing it would let a dial result overwrite a
   * LATER attempt on the same call — the exact rewrite `transferOutcomeLog`'s
   * attempt tracking exists to prevent.
   */
  it("writes against the attempt the redirect stored", () => {
    const { deps, written } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: "no-answer" }), deps);
    expect(written[0].attemptId).toBe(7);
    expect(written[0].callerCallSid).toBe("CAcaller");
  });

  /**
   * "Build it and the telemetry" — the operator, approving the one-round
   * intake. The side channel holding these two fields is DELETED when the
   * transfer attempt finishes, minutes before this callback arrives, so they
   * survive only because the redirect snapshotted them.
   */
  it("carries the briefing gaps and the intake round forward from the redirect", () => {
    const { deps, written } = harness();
    handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "completed", DialCallDuration: "5" }),
      deps,
    );
    expect(written[0].outcome.briefingGaps).toEqual(["callerRole"]);
    expect(written[0].outcome.askedBeforeDial).toBe(true);
    expect(written[0].outcome.method).toBe("blind");
    expect(written[0].outcome.dialedNumber).toBe("+17149564300");
  });

  it("drops the pending entry once it has settled, so a process cannot leak them", () => {
    const { deps, forgotten } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: "completed" }), deps);
    expect(forgotten).toEqual(["CAcaller"]);
  });

  /**
   * A redeploy mid-call loses the map. Writing anyway would attribute the dial
   * to attempt zero of a call this process never redirected; the caller still
   * gets the correct TwiML, which is what they are owed either way.
   */
  it("writes nothing it cannot attribute, and still answers the caller", () => {
    const { deps, written } = harness({ pending: undefined });
    const res = handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "no-answer" }),
      deps,
    );
    expect(written).toHaveLength(0);
    expect(res.body).toContain("<Say");
  });
});

describe("the provider's own word is kept beside our reading of it", () => {
  it("stores DialCallStatus verbatim, so a wrong reading is still traceable", () => {
    const { deps, written } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: "no-answer" }), deps);
    expect(written[0].outcome.status).toBe("NO-ANSWER");
  });

  /**
   * A Twilio value we have never seen must not be laundered into a plausible
   * `no_answer`. It records as `failed` with the unknown word attached, so it
   * shows up as a named surprise in the data.
   */
  it("an unrecognised status is a named surprise, not a fake no-answer", () => {
    const { deps, written } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: "quantum" }), deps);
    expect(written[0].outcome.outcome).toBe("failed");
    expect(written[0].outcome.status).toBe("QUANTUM");
    expect(classifyDialStatus("quantum")).toEqual({ outcome: "failed", connected: false });
  });

  it("a missing status says so rather than looking like a real one", () => {
    const { deps, written } = harness();
    handleBlindDialResult(req({ CallSid: "CAcaller" }), deps);
    expect(written[0].outcome.status).toBe("NO_DIAL_STATUS");
  });
});

describe("the gate fails closed", () => {
  it("writes nothing for an unsigned request", () => {
    const { deps, written } = harness();
    const res = handleBlindDialResult(
      req({ CallSid: "CAcaller", DialCallStatus: "no-answer" }, false),
      deps,
    );
    expect(written).toHaveLength(0);
    // 200 with controlled TwiML, never a 5xx: Twilio plays its own error
    // handling on any 5xx regardless of content (server/index.ts:93).
    expect(res.status).toBe(200);
    expect(res.body).toContain("<Hangup/>");
    expect(res.body).not.toContain("<Say");
  });

  it("writes nothing when no auth token is configured", () => {
    const { deps, written } = harness();
    const res = handleBlindDialResult(req({ CallSid: "CAcaller", DialCallStatus: "completed" }), {
      ...deps,
      env: {},
    });
    expect(written).toHaveLength(0);
    expect(res.status).toBe(200);
  });
});
