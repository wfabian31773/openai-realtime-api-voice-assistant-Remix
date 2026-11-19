/**
 * A DIALLED CALL TWILIO REPORTS `completed` WITH NO ANSWERING-MACHINE VERDICT
 * IS A PICK-UP NOBODY HEARD (v249, operator 2026-11-18: "build the no-answer
 * fix in tonight's pass").
 *
 * The dialler asks for synchronous answering-machine detection, and Twilio
 * requests the answer URL only once detection has decided. A call that ends
 * first never reaches the answer webhook: no greeting, no stream, no call
 * row. Its terminal status arrives with no `AnsweredBy`, and the status
 * webhook marked the contact `answered`, which the dialler never rings again.
 *
 * Measured, npx-outreach, every outbound attempt Twilio reported `completed`
 * to 2026-11-19 02:41 UTC (614): 246 with no verdict, none with a call row;
 * 368 with a verdict, 365 of them with a call row. 233 of the 246 still read `answered`.
 * The corpus: the 18 of 2026-11-17..19 (Pacific), each with its real
 * duration and attempt number. Synthetic contacts stand in for the patients.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import twilio from "twilio";
import { OPERATOR_SLUG } from "../../plugin/operatorLine";
import { SI_ASSISTANT_SLUG } from "../../plugin/siAssistantConstants";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { statusUrl } from "./dialer";
import { handleOutboundStatus, pickupNobodyHeard } from "./outboundWebhook";
import { FakeOutboundStore } from "./store.testkit";
import type { WebhookRequest } from "../voiceWebhook";

const NOW = new Date("2041-03-05T18:00:00Z");
const AUTH_TOKEN = "test-auth-token";
const HOST = "runtime.example.com";
const ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN };
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: (c) => `Hello, this is an automated assistant calling for Azul Vision. May I speak with ${c.firstName}?`,
  voicemail: () => "Hello, this is Azul Vision.",
};

/** [CallSid, Twilio's CallDuration, which attempt on the phone it was]. */
const CORPUS: Array<[string, number, number]> = [
  ["CAd75e7f4f3bd0fe14a2c5812def1d0f50", 11, 1],
  ["CA854e663bf438cb6c78698dc76f6e9792", 30, 1],
  ["CAc9597f96ba3f5464b6a06c4e9c8e1020", 8, 1],
  ["CAe478b44cd223c30070e3344863b5075c", 20, 2],
  ["CA92a86b9ad7b6391ef1794d3ec4c1ffa9", 20, 3],
  ["CAb65f5b56db800af74916beecf5d7325b", 30, 3],
  ["CAc7e80f7dea823dbb3b902bfd389bb864", 3, 3],
  ["CAbd138081b18ec24eac0f77e0a980a860", 12, 3],
  ["CA44860aeeb2bfb27daa6308ed73533801", 7, 3],
  ["CAbc5b2a6cc0123837546024d5f5922e12", 18, 3],
  ["CA1fe033b34f698e2fbba901e1a1b5aba7", 6, 3],
  ["CA6c27b6956f2395838389dad320bad328", 20, 3],
  ["CA50260c17c390f20575b0147b9312c6e3", 2, 3],
  ["CAb6d56f775e8466176a62f4b16460d525", 20, 3],
  ["CAc30f028c627dff841ce0388a1f42e35e", 20, 1],
  ["CAa84d729c82c91a0d843bf34370d74baf", 5, 3],
  ["CA6b3a27ee6af90ec017b62940351d07da", 16, 1],
  ["CA176e0008bbcabe336b7fddf2bb6ebcf1", 23, 2],
];

/** A contact on its Nth dial, held `calling` by that dial. */
async function setup(attemptNumber = 1) {
  const store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: "c1", phone: "+15555550111", firstName: "Testa" });
  await store.claimContact("c1", NOW);
  let attemptId = "";
  for (let n = 1; n <= attemptNumber; n++) attemptId = await store.startAttempt("c1", "campaign-1", n);
  const deps = {
    env: ENV,
    registry: undefined as never,
    store,
    policyFor: async (slug: string) => (slug === "test-lane" || slug === SI_ASSISTANT_SLUG || slug === OPERATOR_SLUG ? policy : null),
    now: () => NOW,
  };
  return { store, deps, attemptId };
}

function signed(url: string, body: Record<string, string>): WebhookRequest {
  const sig = (
    twilio as unknown as { getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string }
  ).getExpectedTwilioSignature(AUTH_TOKEN, url, body);
  const u = new URL(url);
  return { headers: { host: u.host, "x-forwarded-proto": "https", "x-twilio-signature": sig }, body, originalUrl: `${u.pathname}${u.search}` };
}

/** Twilio's terminal status for the corpus shape: completed, no AnsweredBy. */
const noVerdict = (attemptId: string, callSid: string, duration: number, slug = "test-lane", query = "") =>
  signed(`${statusUrl(HOST, slug, "c1", attemptId)}${query}`, {
    CallSid: callSid,
    CallStatus: "completed",
    CallDuration: String(duration),
  });

describe("a pick-up that ended before detection decided", () => {
  for (const [callSid, duration, attemptNumber] of CORPUS) {
    const spent = attemptNumber >= DEFAULT_ATTEMPT_CAPS.total;
    it(`${callSid} (${duration} s, dial ${attemptNumber}): ${spent ? "max_attempts" : "back in the queue"}, never 'answered'`, async () => {
      const { store, deps, attemptId } = await setup(attemptNumber);
      const r = await handleOutboundStatus("test-lane", noVerdict(attemptId, callSid, duration), deps);
      expect(r.status).toBe(204);
      const c = store.contacts.get("c1")!;
      expect(c.status).toBe(spent ? "max_attempts" : "no_answer");
      expect(c.nextAttemptAt).not.toBeNull();
      // The attempt still carries Twilio's own status and duration.
      const attempt = store.attempts.find((a) => a.id === attemptId)!;
      expect(attempt.finish?.status).toBe("completed");
      expect(attempt.finish?.durationSeconds).toBe(duration);
      expect(attempt.finish?.answeredBy ?? null).toBeNull();
    });
  }

  it("a contact put back as no_answer can be claimed by the dialler again", async () => {
    const [callSid, duration] = CORPUS[0];
    const { store, deps, attemptId } = await setup(1);
    await handleOutboundStatus("test-lane", noVerdict(attemptId, callSid, duration), deps);
    const later = new Date(store.contacts.get("c1")!.nextAttemptAt!.getTime() + 1_000);
    expect(await store.claimContact("c1", later)).not.toBeNull();
  });

  it("an empty or blank AnsweredBy is no verdict", () => {
    for (const AnsweredBy of ["", "   "]) {
      const req = signed(statusUrl(HOST, "test-lane", "c1", "a1"), { CallSid: CORPUS[0][0], CallStatus: "completed", AnsweredBy });
      expect(pickupNobodyHeard("test-lane", req)).toBe(true);
    }
  });
});

describe("a call somebody heard stays answered", () => {
  it("a verdict of human or unknown: the answer webhook ran and the stream opened", async () => {
    for (const AnsweredBy of ["human", "unknown"]) {
      const { store, deps, attemptId } = await setup(1);
      const req = signed(statusUrl(HOST, "test-lane", "c1", attemptId), {
        CallSid: CORPUS[0][0],
        CallStatus: "completed",
        CallDuration: "41",
        AnsweredBy,
      });
      await handleOutboundStatus("test-lane", req, deps);
      expect(store.contacts.get("c1")!.status).toBe("answered");
    }
  });

  it("no verdict, but the call has a call row: the stream opened, so it stays answered", async () => {
    const [callSid, duration] = CORPUS[1];
    const { store, deps, attemptId } = await setup(1);
    store.callRows.add(callSid);
    await handleOutboundStatus("test-lane", noVerdict(attemptId, callSid, duration), deps);
    expect(store.contacts.get("c1")!.status).toBe("answered");
  });

  it("a call-row read that fails counts as heard: a database blip never rings a person again", async () => {
    const [callSid, duration] = CORPUS[2];
    const { store, deps, attemptId } = await setup(1);
    store.callRowExists = async () => {
      throw new Error("db down");
    };
    await handleOutboundStatus("test-lane", noVerdict(attemptId, callSid, duration), deps);
    expect(store.contacts.get("c1")!.status).toBe("answered");
  });

  it("not the SI Assistant or the operator line, and not a live session", async () => {
    const [callSid, duration] = CORPUS[3];
    for (const [slug, query] of [
      [SI_ASSISTANT_SLUG, ""],
      [OPERATOR_SLUG, ""],
      ["test-lane", "&liveSession=s1"],
    ] as const) {
      const req = noVerdict("a1", callSid, duration, slug, query);
      expect(pickupNobodyHeard(slug, req)).toBe(false);
    }
    const { store, deps, attemptId } = await setup(1);
    await handleOutboundStatus(SI_ASSISTANT_SLUG, noVerdict(attemptId, callSid, duration, SI_ASSISTANT_SLUG), deps);
    expect(store.contacts.get("c1")!.status).toBe("answered");
  });

  it("only a completed call: any other status is the ring-out branch's already", () => {
    const req = signed(statusUrl(HOST, "test-lane", "c1", "a1"), { CallSid: CORPUS[0][0], CallStatus: "no-answer" });
    expect(pickupNobodyHeard("test-lane", req)).toBe(false);
  });
});

describe("what the call recorded still outranks it", () => {
  it("never replaces an outcome the call recorded", async () => {
    const [callSid, duration] = CORPUS[4];
    for (const status of ["voicemail", "do_not_call", "callback_scheduled", "declined", "completed", "wrong_number"] as const) {
      const { store, deps, attemptId } = await setup(1);
      await store.settleContact("c1", status);
      await handleOutboundStatus("test-lane", noVerdict(attemptId, callSid, duration), deps);
      expect(store.contacts.get("c1")!.status).toBe(status);
    }
  });

  it("a late callback for an older attempt does not settle the newer call", async () => {
    const [callSid, duration] = CORPUS[5];
    const { store, deps, attemptId: first } = await setup(1);
    store.contacts.get("c1")!.status = "no_answer";
    await store.claimContact("c1", NOW);
    await store.startAttempt("c1", "campaign-1", 2);
    await handleOutboundStatus("test-lane", noVerdict(first, callSid, duration), deps);
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });
});

describe("the production store", () => {
  const SRC = readFileSync("src/runtime/outbound/store.ts", "utf8");
  it("reads the call row by CallSid on the unique index", () => {
    const start = SRC.indexOf("async callRowExists(");
    expect(start).toBeGreaterThan(0);
    const body = SRC.slice(start, SRC.indexOf("\n    async ", start + 1));
    expect(body).toContain("SELECT EXISTS (SELECT 1 FROM call_logs WHERE call_sid = ${callSid}::varchar) AS found");
    expect(body).toContain("return found[0]?.found === true;");
  });
});

describe("a status with no CallSid", () => {
  it("cannot be checked for a call row, so it counts as heard and stays answered", async () => {
    const { store, deps, attemptId } = await setup(1);
    const req = signed(statusUrl(HOST, "test-lane", "c1", attemptId), { CallStatus: "completed", CallDuration: "12" });
    await handleOutboundStatus("test-lane", req, deps);
    expect(store.contacts.get("c1")!.status).toBe("answered");
  });
});
