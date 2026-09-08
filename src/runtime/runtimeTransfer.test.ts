import { describe, it, expect, vi, afterEach } from "vitest";
import twilio from "twilio";
import {
  briefingFor,
  createRuntimeTransfer,
  transferUnavailableReason,
  TRANSFER_ACCEPT_PATH,
  TRANSFER_STATUS_PATH,
} from "./runtimeTransfer";
import { ACCEPT_WINDOW_MS, conferenceNameFor, type TransferTwilioOps } from "./warmTransfer";
import {
  peekRuntimeTransferOutcome,
  clearRuntimeTransferOutcomes,
} from "./transferOutcomeLog";
import { escalationDetailsMap } from "../services/escalationStore";
import type { WebhookRequest } from "./voiceWebhook";

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
  callSid: "CAcaller",
  callId: "CAcaller",
  callerPhone: "+15551234567",
  dialedNumber: "+15559876543",
};

afterEach(() => {
  escalationDetailsMap.clear();
});

function fakeOps() {
  const dialed: Array<{ to: string; twiml: string }> = [];
  const redirected: Array<{ callerCallSid: string; conferenceName: string }> = [];
  const ended: string[] = [];
  const ops: TransferTwilioOps = {
    createOfficeLeg: async ({ to, twiml }) => {
      dialed.push({ to, twiml });
      return { sid: "CAoffice" };
    },
    redirectCallerToConference: async ({ callerCallSid, conferenceName }) => {
      redirected.push({ callerCallSid, conferenceName });
    },
    endCall: async (sid) => void ended.push(sid),
  };
  return { ops, dialed, redirected, ended };
}

function signedAccept(body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: DOMAIN,
      "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        `https://${DOMAIN}${TRANSFER_ACCEPT_PATH}`,
        body,
      ),
    },
    body,
    originalUrl: TRANSFER_ACCEPT_PATH,
  };
}

function signedStatus(body: Record<string, string>): WebhookRequest {
  return {
    headers: {
      host: DOMAIN,
      "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        `https://${DOMAIN}${TRANSFER_STATUS_PATH}`,
        body,
      ),
    },
    body,
    originalUrl: TRANSFER_STATUS_PATH,
  };
}

function transferWith(ops: TransferTwilioOps) {
  return createRuntimeTransfer({ env: ENV, ops, domain: DOMAIN, log: () => undefined });
}

describe("the whole transfer, side channel to bridge", () => {
  it("dials the destination the agent's escalation earned, and bridges on the keypress", async () => {
    const { ops, dialed, redirected } = fakeOps();
    const transfer = transferWith(ops);

    // The agent's escalate tool writes this before invoking the callback —
    // pcpAgent, noIvrAgent, noIvrAgentV2 and azulSchedulingAgent all do,
    // unchanged. 'patient_urgent' takes the clinical branch, which has no
    // lunch-closure gate, so this test never reads the wall clock.
    escalationDetailsMap.set("CAcaller", {
      agentSlug: "no-ivr",
      callerType: "patient_urgent",
      reason: "Sudden vision loss, needs the on-call team",
    });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    // The office hears why before deciding.
    expect(dialed[0].to).toBe("+18185551234");
    expect(dialed[0].twiml).toContain("Sudden vision loss");

    const res = transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    expect(res.body).toContain(conferenceNameFor("CAcaller"));

    await outcome; // resolves only because a human accepted
    expect(redirected).toEqual([
      { callerCallSid: "CAcaller", conferenceName: conferenceNameFor("CAcaller") },
    ]);
  });

  it("refuses — and dials nothing — when the agent earned no escalation", async () => {
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops);
    // No side-channel entry: the policy's clinical branch refuses the
    // caller type, so the destination is withheld.
    const handoff = transfer.handoffFor("no-ivr", META);
    await expect(handoff()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(dialed).toEqual([]);
  });

  it("declines cleanly when the office presses nothing, and the caller keeps the agent", async () => {
    const { ops, redirected, ended } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    const res = transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "" }));
    expect(res.body).not.toContain("<Conference");

    await expect(outcome).rejects.toThrow(/handoff_failed:DECLINED/);
    expect(redirected).toEqual([]);
    expect(ended).toEqual(["CAoffice"]); // the leg the caller never joined
  });

  it("drops the office-conference mapping after the wait, win or lose", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    // A second press on the same leg finds nothing to bridge into.
    const replay = transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    expect(replay.body).not.toContain("<Conference");

    // And the mapping itself is gone — not merely masked by the pending
    // check. Without the cleanup this map grows by one entry per transfer
    // for the life of the process (a mutation removing the .finally
    // survived the behavioural assertions above; this is the one that
    // catches it).
    expect(transfer.pendingConferences()).toBe(0);
  });

  it("reads the side channel at invoke time, not at agent-build time", async () => {
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops);
    // Built BEFORE the escalation exists — as in real life: the factory runs
    // at call start, the escalate tool fires minutes in.
    const handoff = transfer.handoffFor("no-ivr", META);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const outcome = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(dialed).toHaveLength(1);
  });
});

describe("per-lane handoff contracts (Codex, PR #230)", () => {
  it("pcp resolves a STRUCTURED success — createPcpAgent reads outcome.ok, and a void resolve records a connected caller as FAILED", async () => {
    // Pin the clock to 10:00 Pacific: the pcp policy branch has a
    // wall-clock lunch-closure gate, and this test is about the outcome
    // shape, not the hour.
    vi.useFakeTimers({ now: new Date("2026-08-30T17:00:00Z"), toFake: ["Date"] });
    try {
      const { ops, redirected } = fakeOps();
      const transfer = transferWith(ops);
      escalationDetailsMap.set("CAcaller", {
        agentSlug: "pcp",
        callerRequestedHuman: true,
        providerInfo: "Care coordinator at Optum Clinic",
        reason: "Peer to peer",
      });
      const outcome = transfer.handoffFor("pcp", META)();
      await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
      transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
      await expect(outcome).resolves.toMatchObject({
        ok: true,
        destination: "+17149564300",
      });
      expect(redirected).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pcp gets a failure as DATA, never a throw — a throw skips the post-dial ticket update", async () => {
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops);
    // No side-channel entry: the pcp policy refuses, nothing is dialled,
    // and the tool still needs the structured refusal to record.
    const outcome = await transfer.handoffFor("pcp", META)();
    expect(outcome).toMatchObject({ ok: false, status: "HANDOFF_UNAVAILABLE" });
    expect(dialed).toEqual([]);
  });

  it("clears the escalation side channel after the attempt, win or lose", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    // Lose: the policy refuses, and the entry is still cleared — call IDs
    // are unique, so a kept entry retains name, DOB, callback number and
    // symptoms in a process-wide map forever (Codex, PR #230).
    escalationDetailsMap.set("CAcaller", { reason: "kept PHI" });
    await expect(transfer.handoffFor("no-ivr", META)()).rejects.toThrow(/handoff_failed/);
    expect(escalationDetailsMap.has("CAcaller")).toBe(false);

    // Win: cleared after the bridge too.
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });
    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(escalationDetailsMap.has("CAcaller")).toBe(false);
  });
});

describe("the attempt tells the bridge how long it may run (Codex, PR #230 round 3)", () => {
  it("announces the accept-window budget BEFORE dialing, and settles after a failure", async () => {
    // Without this the bridge's dead-air watchdog holds the handoff to
    // the 45-second tool budget and tears the caller down while an
    // office that answered late is still hearing the briefing.
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    const events: Array<string | number> = [];
    const handoff = transfer.handoffFor(
      "no-ivr",
      META,
      {
        onAttemptStarting: (waitMs) => events.push("starting", waitMs),
        onAttemptSettled: () => events.push("settled"),
      },
    );
    // No escalation entry -> UNAVAILABLE; the hooks still bracket the
    // attempt so the widened window never outlives it.
    await expect(handoff()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);
    expect(events).toEqual(["starting", ACCEPT_WINDOW_MS, "settled"]);
  });

  it("settles the budget after a success too — the bracket holds on every path", async () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    const events: string[] = [];
    escalationDetailsMap.set("CAcaller", {
      agentSlug: "no-ivr",
      callerType: "patient_urgent",
      reason: "Sudden vision loss",
    });
    const outcome = transfer.handoffFor("no-ivr", META, {
      onAttemptStarting: () => events.push("starting"),
      onAttemptSettled: () => events.push("settled"),
    })();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    expect(events).toEqual(["starting"]); // still open while the office rings
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;
    expect(events).toEqual(["starting", "settled"]);
  });
});

describe("the caller ending abandons the office leg (Codex, PR #230 round 2)", () => {
  it("hangs up an office leg still ringing when the caller's call ends", async () => {
    const { ops, ended, redirected } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    // The caller hung up. Without this, the office keeps ringing for the
    // whole window and can even accept into a completed leg.
    transfer.abandonFor("CAcaller");
    await expect(outcome).rejects.toThrow(/handoff_failed/);
    expect(ended).toEqual(["CAoffice"]);
    expect(redirected).toEqual([]);
    expect(transfer.pendingAccepts()).toBe(0);
    expect(transfer.pendingConferences()).toBe(0);
  });

  it("a caller that ends while the office leg is still being created abandons it on registration", async () => {
    // The teardown can win the race against calls.create(): at that
    // moment nothing is registered, so abandonFor alone is a no-op and
    // the leg that materializes afterwards would ring toward a dead call
    // for the full window (Codex, PR #230 round 5).
    let resolveCreate!: (v: { sid: string }) => void;
    const created = new Promise<{ sid: string }>((r) => (resolveCreate = r));
    const ended: string[] = [];
    const ops: TransferTwilioOps = {
      createOfficeLeg: async () => created,
      redirectCallerToConference: async () => {
        throw new Error("must not redirect");
      },
      endCall: async (sid) => void ended.push(sid),
    };
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", {
      agentSlug: "no-ivr",
      callerType: "patient_urgent",
      reason: "Sudden vision loss",
    });
    const outcome = transfer.handoffFor("no-ivr", META)();
    await Promise.resolve(); // let the attempt enter createOfficeLeg
    transfer.abandonFor("CAcaller"); // teardown — nothing registered yet
    resolveCreate({ sid: "CAoffice" });
    await expect(outcome).rejects.toThrow(/handoff_failed:NO_ANSWER/);
    expect(ended).toEqual(["CAoffice"]);
    expect(transfer.pendingAccepts()).toBe(0);
    expect(transfer.pendingConferences()).toBe(0);
  });

  it("abandoning a caller with nothing pending is a no-op", () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    expect(() => transfer.abandonFor("CAnobody")).not.toThrow();
  });

  it("a terminal office status settles a dial that died without accepting", async () => {
    // no-answer/busy/failed never post the Gather action, so without the
    // status webhook the wait ran out the whole widened window before the
    // caller's agent learned anything.
    const { ops, ended } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const outcome = transfer.handoffFor("no-ivr", META)();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));

    const res = transfer.handleStatus(
      signedStatus({ CallSid: "CAoffice", CallStatus: "no-answer" }),
    );
    expect(res.status).toBe(200);
    await expect(outcome).rejects.toThrow(/handoff_failed/);
    expect(ended).toEqual(["CAoffice"]);
  });

  it("refuses a forged status post", () => {
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    const res = transfer.handleStatus({
      headers: { host: DOMAIN, "x-forwarded-proto": "https" },
      body: { CallSid: "CAoffice", CallStatus: "completed" },
      originalUrl: "/voice/transfer-status",
    });
    expect(res.status).toBe(403);
  });
});

describe("availability is decided by configuration, not hope", () => {
  it("names every missing piece", () => {
    const reason = transferUnavailableReason({}, { hasInjectedOps: false });
    expect(reason).toContain("TWILIO_ACCOUNT_SID");
    expect(reason).toContain("TWILIO_AUTH_TOKEN");
    expect(reason).toContain("TWILIO_PHONE_NUMBER");
    expect(reason).toContain("DOMAIN");
  });

  it("is satisfied by injected ops plus the auth token, a number and a domain", () => {
    expect(
      transferUnavailableReason(
        { TWILIO_PHONE_NUMBER: "+15550000000", TWILIO_AUTH_TOKEN: AUTH_TOKEN },
        { hasInjectedOps: true, domain: DOMAIN },
      ),
    ).toBeNull();
  });

  it("requires the auth token EVEN WITH injected ops — the accept webhook verifies signatures with it", () => {
    // Injected ops replace the dialing client, not the webhook secret:
    // without the token every office keypress gets the expired-transfer
    // hangup, so a transfer offered in this configuration always times
    // out or declines after a human already pressed a key (Codex,
    // PR #230 round 4). Refusing up front keeps the lanes on their
    // honest side-channel message instead.
    expect(
      transferUnavailableReason(
        { TWILIO_PHONE_NUMBER: "+15550000000" },
        { hasInjectedOps: true, domain: DOMAIN },
      ),
    ).toContain("TWILIO_AUTH_TOKEN");
  });

  it("still requires credentials when no ops are injected", () => {
    expect(
      transferUnavailableReason(
        { TWILIO_PHONE_NUMBER: "+15550000000" },
        { hasInjectedOps: false, domain: DOMAIN },
      ),
    ).toContain("TWILIO_ACCOUNT_SID");
  });
});

describe("the briefing", () => {
  it("uses the PCP professional wording on the pcp lane", () => {
    const text = briefingFor("pcp", META, {
      providerInfo: "Care coordinator at Optum Clinic",
      reason: "Peer to peer",
    });
    expect(text).toContain("PCP support assistant");
    expect(text).toContain("Optum Clinic");
  });

  it("gives other lanes the caller's last four and the reason, never the full number", () => {
    const text = briefingFor("no-ivr", META, { reason: "Urgent symptom" });
    expect(text).toContain("ending 4567");
    expect(text).toContain("Urgent symptom");
    expect(text).not.toContain("+15551234567");
  });

  it("still says something usable with no side channel at all", () => {
    const text = briefingFor("no-ivr", { ...META, callerPhone: "" }, undefined);
    expect(text).toContain("Azul Vision");
  });
});

/**
 * THE ACCEPT HAS TO BE ON RECORD BEFORE THE CALLER IS MOVED. Codex P1, PR #273.
 *
 * `redirectCallerToConference` ends the media stream, and the resulting close
 * can beat the redirect's own resolution — that race is why
 * `onCallerRedirectStarting` exists at all. Teardown starts on the close and
 * synchronously builds the `call_logs` row, so an outcome recorded only when
 * `attempt()` resolves can arrive AFTER the row is written: the one transfer
 * unambiguously worth logging, dropped, with the record left in the map until
 * eviction.
 *
 * TESTED THROUGH THE REAL REDIRECT, not against the store. Mutation testing is
 * why: reverting the hook wiring failed nothing, because every assertion I had
 * written exercised the store — which cannot see WHEN the store was written.
 * Third time today that testing the sink instead of the source hid a defect.
 */
describe("the accepted outcome is recorded before the redirect", () => {
  it("WHAT TEARDOWN WOULD PERSIST MID-REDIRECT is not a claim that anyone connected", async () => {
    /**
     * Codex P1 round 3, PR #273 — and the window my previous test missed.
     *
     * That test observed `endCall`, which runs in the redirect's CATCH, i.e.
     * after the await has already rejected. It therefore proved the correction
     * beats the SETTLE, and said nothing about teardown, which can run while
     * the redirect promise is still pending. A caller who hangs up in that
     * window gets teardown, a snapshot, a durable write and an ack — and any
     * later correction has no teardown left to persist it.
     *
     * So the assertion point is INSIDE the redirect, before it settles either
     * way: whatever is in the store at that instant is what the database can
     * end up holding forever, and it must be true on its own.
     */
    clearRuntimeTransferOutcomes();
    const seenMidRedirect: Array<string | undefined> = [];
    const { ops } = fakeOps();
    const watched: TransferTwilioOps = {
      ...ops,
      redirectCallerToConference: async (input) => {
        // Teardown's snapshot, taken here rather than after the await.
        seenMidRedirect.push(peekRuntimeTransferOutcome("CAcaller")?.outcome);
        return ops.redirectCallerToConference(input);
      },
    };
    const transfer = transferWith(watched);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    expect(
      seenMidRedirect,
      "a record written before the move completes must not say the move completed",
    ).toEqual(["redirecting"]);
    expect(seenMidRedirect[0], "and above all not this").not.toBe("accepted");
  });

  it("becomes accepted once the caller actually lands", async () => {
    // The control: `redirecting` must be a transient state, not the end of the
    // story, or the column would never record a completed transfer at all.
    clearRuntimeTransferOutcomes();
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff();
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    expect(peekRuntimeTransferOutcome("CAcaller")?.outcome).toBe("accepted");
  });

  it("corrects a failed redirect SYNCHRONOUSLY, not when the attempt settles", async () => {
    /**
     * Mutation testing found this gap: removing the synchronous correction
     * failed NOTHING, because the settle records the same failure a moment
     * later and the test below only reads the end state. But the window is the
     * whole point — teardown starts on the stream close, so a correction that
     * waits for the settle can arrive after the row is written, and the row
     * then says a caller reached a human who never did.
     *
     * `endQuietly` runs AFTER `onCallerRedirectFailed` and BEFORE the attempt
     * resolves, so a fake `endCall` is the one place the difference is
     * visible. Fifth time on this PR that asserting the end state hid a
     * timing requirement.
     */
    clearRuntimeTransferOutcomes();
    const seenAtCleanup: Array<string | undefined> = [];
    const { ops } = fakeOps();
    const failing: TransferTwilioOps = {
      ...ops,
      redirectCallerToConference: async () => {
        throw new Error("twilio said no");
      },
      endCall: async (sid) => {
        seenAtCleanup.push(peekRuntimeTransferOutcome("CAcaller")?.outcome);
        return ops.endCall(sid);
      },
    };
    const transfer = transferWith(failing);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff().catch(() => undefined);
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    expect(
      seenAtCleanup,
      "the provisional accept must already be corrected before the attempt resolves",
    ).toEqual(["failed"]);
  });

  it("and a redirect that then FAILS corrects it — the caller never moved", async () => {
    /**
     * The half that makes the early record safe. Without the attempt id, the
     * "an accepted transfer is never overwritten" rule would pin a transfer
     * that did not happen: the office pressed a key, the redirect threw, and
     * the caller stayed with the agent.
     */
    clearRuntimeTransferOutcomes();
    const { ops } = fakeOps();
    const failing: TransferTwilioOps = {
      ...ops,
      redirectCallerToConference: async () => {
        throw new Error("twilio said no");
      },
    };
    const transfer = transferWith(failing);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff().catch(() => undefined);
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "1" }));
    await outcome;

    const stored = peekRuntimeTransferOutcome("CAcaller");
    expect(stored?.outcome, "nobody was transferred").not.toBe("accepted");
    expect(stored?.attempt, "and it is still one attempt").toBe(1);
  });
});

describe("what never dialled is never recorded", () => {
  /**
   * Codex P2, PR #273. `performWarmTransfer` returns UNAVAILABLE BEFORE
   * `createOfficeLeg` when no destination is configured or policy withheld
   * one — its own comment says "nothing was attempted". Recording it writes a
   * non-null `transfer_outcome` for a call where no number was ever rung,
   * which breaks the meaning the column was just given and makes reporting
   * count configuration refusals as dials.
   *
   * THROUGH THE REAL TRANSFER, because the test that was supposed to cover
   * this read an untouched store and passed without exercising any wiring.
   */
  it("a policy refusal leaves the column NULL", async () => {
    clearRuntimeTransferOutcomes();
    const { ops, dialed } = fakeOps();
    const transfer = transferWith(ops);
    // No side-channel entry: the clinical branch withholds the destination.
    const handoff = transfer.handoffFor("no-ivr", META);

    await expect(handoff()).rejects.toThrow(/handoff_failed:UNAVAILABLE/);

    expect(dialed, "nothing was rung").toEqual([]);
    expect(
      peekRuntimeTransferOutcome("CAcaller"),
      "NULL has to keep meaning 'no transfer was attempted'",
    ).toBeUndefined();
  });

  it("but a dial that RANG OUT is still recorded", async () => {
    // The control. Without it, "record nothing" could be satisfied by
    // recording nothing ever.
    clearRuntimeTransferOutcomes();
    const { ops } = fakeOps();
    const transfer = transferWith(ops);
    escalationDetailsMap.set("CAcaller", { callerType: "patient_urgent" });

    const handoff = transfer.handoffFor("no-ivr", META);
    const outcome = handoff().catch(() => undefined);
    await vi.waitFor(() => expect(transfer.pendingAccepts()).toBe(1));
    transfer.handleAccept(signedAccept({ CallSid: "CAoffice", Digits: "" }));
    await outcome;

    expect(peekRuntimeTransferOutcome("CAcaller")?.outcome).toBeTruthy();
  });
});
