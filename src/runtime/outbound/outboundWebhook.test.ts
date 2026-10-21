import { describe, expect, it } from "vitest";
import twilio from "twilio";
import { CallSessionRegistry } from "../sessionRegistry";
import { VOICE_STREAM_PATH, xmlEscape, type WebhookRequest } from "../voiceWebhook";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { answerUrl, statusUrl } from "./dialer";
import {
  OUTBOUND_UNAVAILABLE_LINE,
  handleOutboundAnswer,
  handleOutboundStatus,
  type OutboundWebhookDeps,
} from "./outboundWebhook";
import { FakeOutboundStore } from "./store.testkit";

const AUTH_TOKEN = "test-auth-token";
const HOST = "runtime.example.com";
const LIVE_ENV = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, XAI_API_KEY: "k", DATABASE_URL: "postgres://x" };
const NOW = new Date("2041-03-05T18:00:00Z");
const PATIENT = "+15555550111";
const OURS = "+15555550100";

const VOICEMAIL = "Hello, this is Azul Vision calling. Please call us back. Goodbye.";
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: (c) => `Hello, this is an automated assistant calling for Azul Vision. This call is recorded. Am I speaking with ${c.firstName}?`,
  voicemail: () => VOICEMAIL,
};

/** Signed exactly as Twilio signs, over the full URL including the query. */
function signed(url: string, body: Record<string, string>): WebhookRequest {
  const sig = (
    twilio as unknown as {
      getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
    }
  ).getExpectedTwilioSignature(AUTH_TOKEN, url, body);
  const u = new URL(url);
  return {
    headers: { host: u.host, "x-forwarded-proto": "https", "x-twilio-signature": sig },
    body,
    originalUrl: `${u.pathname}${u.search}`,
  };
}

async function setup() {
  const store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: "c1", phone: PATIENT, firstName: "Testa" });
  await store.claimContact("c1", NOW);
  const attemptId = await store.startAttempt("c1", "campaign-1", 1);
  const registry = new CallSessionRegistry();
  const deps: OutboundWebhookDeps = {
    env: LIVE_ENV,
    registry,
    store,
    policyFor: async (slug) => (slug === "test-lane" ? policy : null),
    now: () => NOW,
  };
  return { store, registry, deps, attemptId };
}

const answered = (attemptId: string, extra: Record<string, string> = {}) =>
  signed(answerUrl(HOST, "test-lane", "c1", attemptId), {
    CallSid: "CA00000000000000000000000000000001",
    From: OURS,
    To: PATIENT,
    Direction: "outbound-api",
    ...extra,
  });

describe("the answer webhook", () => {
  it("refuses an unsigned request", async () => {
    const { deps, attemptId } = await setup();
    const req = answered(attemptId, { AnsweredBy: "human" });
    req.headers["x-twilio-signature"] = "forged";
    expect((await handleOutboundAnswer("test-lane", req, deps)).status).toBe(403);
  });

  it("refuses a request whose query was changed after Twilio signed it", async () => {
    const { deps, attemptId } = await setup();
    const req = answered(attemptId, { AnsweredBy: "human" });
    req.originalUrl = req.originalUrl.replace("contact=c1", "contact=c2");
    expect((await handleOutboundAnswer("test-lane", req, deps)).status).toBe(403);
  });

  it("fails closed with no auth token", async () => {
    const { deps, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId), { ...deps, env: {} });
    expect(r.status).toBe(200);
    expect(r.body).toContain(xmlEscape(OUTBOUND_UNAVAILABLE_LINE));
    expect(r.body).not.toContain("<Connect>");
  });

  it("connects a person to the stream, carrying who we called", async () => {
    const { deps, registry, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "human" }), deps);
    expect(r.body).toContain(`<Stream url="wss://${HOST}${VOICE_STREAM_PATH}">`);
    expect(r.body).toContain('<Redirect method="POST">/voice/test-lane/after</Redirect>');
    const entry = registry.get("CA00000000000000000000000000000001")!;
    expect(entry.outbound).toEqual({ campaignKey: "test-campaign", contactId: "c1", attemptId });
    // The person rang is the "caller" every downstream reader means.
    expect(entry.callerPhone).toBe(PATIENT);
    expect(entry.dialedNumber).toBe(OURS);
  });

  it("treats an unknown answer as a person, not a machine", async () => {
    const { deps, registry, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "unknown" }), deps);
    expect(r.body).toContain("<Connect>");
    expect(registry.activeCount()).toBe(1);
  });

  it("leaves the voicemail line for a machine and never builds the agent", async () => {
    const { deps, registry, store, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "machine_end_beep" }), deps);
    expect(r.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${VOICEMAIL}</Say><Hangup/></Response>`);
    expect(registry.activeCount()).toBe(0);
    expect(store.attempts[0].finish?.status).toBe("voicemail");
    const c = store.contacts.get("c1")!;
    expect(c.status).toBe("voicemail");
    expect(c.nextAttemptAt).not.toBeNull();
  });

  it("hangs up on a fax and marks the number wrong", async () => {
    const { deps, registry, store, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "fax" }), deps);
    expect(r.body).toContain("<Hangup/>");
    expect(store.attempts[0].endedAt).toBeUndefined(); // the status callback ends it
    expect(registry.activeCount()).toBe(0);
    expect(store.contacts.get("c1")!.status).toBe("wrong_number");
  });

  it("hangs up on a slug that is not a registered outbound lane", async () => {
    const { deps, registry, attemptId } = await setup();
    const req = signed(answerUrl(HOST, "optical", "c1", attemptId), { CallSid: "CA1", From: OURS, To: PATIENT, AnsweredBy: "human" });
    const r = await handleOutboundAnswer("optical", req, deps);
    expect(r.body).toContain("<Hangup/>");
    expect(registry.activeCount()).toBe(0);
  });

  it("does not stream a call this process cannot run", async () => {
    const { deps, store, attemptId } = await setup();
    const r = await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "human" }), {
      ...deps,
      env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
    });
    expect(r.body).toContain(xmlEscape(OUTBOUND_UNAVAILABLE_LINE));
    expect(r.body).not.toContain("<Connect>");
    expect(store.contacts.get("c1")!.status).toBe("no_answer");
  });
});

describe("the status webhook", () => {
  const finished = (attemptId: string, body: Record<string, string>) =>
    signed(statusUrl(HOST, "test-lane", "c1", attemptId), { CallSid: "CA1", ...body });

  it("puts a no-answer back in the queue for a later try", async () => {
    const { deps, store, attemptId } = await setup();
    const r = await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "no-answer" }), deps);
    expect(r.status).toBe(204);
    expect(store.attempts[0].finish?.status).toBe("no-answer");
    const c = store.contacts.get("c1")!;
    expect(c.status).toBe("no_answer");
    expect(c.nextAttemptAt).not.toBeNull();
  });

  it("does not ring a person again after they answered and the call ended unsettled", async () => {
    const { deps, store, attemptId } = await setup();
    await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "completed", CallDuration: "41", AnsweredBy: "human" }), deps);
    expect(store.contacts.get("c1")!.status).toBe("answered");
    expect(store.attempts[0].finish?.durationSeconds).toBe(41);
  });

  it("never overwrites an outcome the call already recorded", async () => {
    const { deps, store, attemptId } = await setup();
    await store.settleContact("c1", "do_not_call");
    await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "completed" }), deps);
    expect(store.contacts.get("c1")!.status).toBe("do_not_call");
  });

  it("keeps a voicemail verdict when the completed status follows it", async () => {
    const { deps, store, attemptId } = await setup();
    await handleOutboundAnswer("test-lane", answered(attemptId, { AnsweredBy: "machine_end_silence" }), deps);
    // The voicemail line is still playing: the attempt holds its slot.
    expect(store.attempts[0].endedAt).toBeUndefined();
    await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "completed", CallDuration: "22" }), deps);
    expect(store.attempts[0].endedAt).toBeDefined();
    expect(store.attempts[0].finish?.status).toBe("voicemail");
    expect(store.contacts.get("c1")!.status).toBe("voicemail");
  });

  it("stops at the total cap instead of queueing another try", async () => {
    const { deps, store, attemptId } = await setup();
    await store.startAttempt("c1", "campaign-1", 2);
    await store.startAttempt("c1", "campaign-1", 3);
    await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "busy" }), deps);
    expect(store.contacts.get("c1")!.status).toBe("max_attempts");
  });

  it("ignores progress events", async () => {
    const { deps, store, attemptId } = await setup();
    await handleOutboundStatus("test-lane", finished(attemptId, { CallStatus: "ringing" }), deps);
    expect(store.attempts[0].finish).toBeUndefined();
    expect(store.contacts.get("c1")!.status).toBe("calling");
  });

  it("refuses an unsigned status", async () => {
    const { deps, attemptId } = await setup();
    const req = finished(attemptId, { CallStatus: "completed" });
    req.headers["x-twilio-signature"] = "forged";
    expect((await handleOutboundStatus("test-lane", req, deps)).status).toBe(403);
  });
});
