import { describe, it, expect, vi, afterEach } from "vitest";
import twilio from "twilio";
import {
  briefingFor,
  createRuntimeTransfer,
  transferUnavailableReason,
  TRANSFER_ACCEPT_PATH,
} from "./runtimeTransfer";
import { conferenceNameFor, type TransferTwilioOps } from "./warmTransfer";
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

describe("availability is decided by configuration, not hope", () => {
  it("names every missing piece", () => {
    const reason = transferUnavailableReason({}, { hasInjectedOps: false });
    expect(reason).toContain("TWILIO_ACCOUNT_SID");
    expect(reason).toContain("TWILIO_AUTH_TOKEN");
    expect(reason).toContain("TWILIO_PHONE_NUMBER");
    expect(reason).toContain("DOMAIN");
  });

  it("is satisfied by injected ops plus a number and a domain", () => {
    expect(
      transferUnavailableReason(
        { TWILIO_PHONE_NUMBER: "+15550000000" },
        { hasInjectedOps: true, domain: DOMAIN },
      ),
    ).toBeNull();
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
