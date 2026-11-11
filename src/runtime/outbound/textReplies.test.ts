/**
 * v211: a STOP texted back to the campaign's number writes an `sms_stop`
 * do-not-contact row, which blocks texts and calls; START deletes only that
 * row. Signed by Twilio or refused. Synthetic numbers only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import twilio from "twilio";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { SMS_DNC_SOURCE } from "./channelDnc";
import { OUTBOUND_PATH_PREFIX } from "./dialer";
import { handleTextReply, textReplyPath } from "./textReplies";
import { FakeOutboundStore } from "./store.testkit";
import type { WebhookRequest } from "../voiceWebhook";

const AUTH_TOKEN = "test-auth-token";
const PERSON = "+15555550111";
const URL_ = "https://voice.example.test/voice/outbound/test-lane/sms";

const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "X",
  callerIdEnv: "Y",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: () => "Hello.",
  voicemail: () => "Hello.",
  textOutreach: { enableEnv: "Z", perTick: 1, body: (l) => l },
};

function signed(body: Record<string, string>, token = AUTH_TOKEN): WebhookRequest {
  const sig = (
    twilio as unknown as { getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string }
  ).getExpectedTwilioSignature(token, URL_, body);
  const u = new URL(URL_);
  return { headers: { host: u.host, "x-forwarded-proto": "https", "x-twilio-signature": sig }, body, originalUrl: u.pathname };
}

function setup(p: OutboundLanePolicy | null = policy) {
  const store = new FakeOutboundStore();
  const lines: string[] = [];
  const deps = {
    env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
    store: async () => store,
    policyFor: async (slug: string) => (slug === "test-lane" ? p : null),
    log: (l: string) => lines.push(l),
  };
  return { store, deps, lines };
}

describe("a text back to the campaign's number", () => {
  it("is served on the lane's own path", () => {
    expect(textReplyPath(OUTBOUND_PATH_PREFIX, "npx-outreach")).toBe("/voice/outbound/npx-outreach/sms");
  });

  it.each(["STOP", "stop", "Stop.", "UNSUBSCRIBE", "cancel", "end", "quit", "stopall"])("%s writes an sms_stop row", async (word) => {
    const { store, deps } = setup();
    const r = await handleTextReply("test-lane", signed({ From: PERSON, Body: word }), deps);
    expect(r).toEqual({ status: 200, contentType: "text/xml", body: "<Response/>" });
    expect(store.channelDnc.sms.has("5555550111")).toBe(true);
    // Any row blocks both calls and texts.
    expect(await store.isDoNotContact(PERSON)).toBe(true);
  });

  it("START deletes only the sms_stop row, never a voice opt-out", async () => {
    const { store, deps } = setup();
    await store.stampDoNotContact(PERSON, SMS_DNC_SOURCE);
    await handleTextReply("test-lane", signed({ From: PERSON, Body: "START" }), deps);
    expect(store.channelDnc.sms.has("5555550111")).toBe(false);
    await store.stampDoNotContact(PERSON, "voice_opt_out");
    await store.stampDoNotContact(PERSON, SMS_DNC_SOURCE);
    await handleTextReply("test-lane", signed({ From: PERSON, Body: "start" }), deps);
    expect(await store.isDoNotContact(PERSON)).toBe(true);
  });

  it("anything else writes nothing", async () => {
    const { store, deps } = setup();
    for (const body of ["What is this?", "HELP", "Book me in", ""]) {
      await handleTextReply("test-lane", signed({ From: PERSON, Body: body }), deps);
    }
    expect(await store.isDoNotContact(PERSON)).toBe(false);
  });

  it("logs the keyword and the campaign, never the number or the words", async () => {
    const { deps, lines } = setup();
    await handleTextReply("test-lane", signed({ From: PERSON, Body: "Can you call me at 555 555 0111?" }), deps);
    await handleTextReply("test-lane", signed({ From: PERSON, Body: "STOP" }), deps);
    expect(lines).toEqual(["[outbound] test-campaign: text reply — other", "[outbound] test-campaign: text reply — stop"]);
    expect(lines.join(" ")).not.toMatch(/555/);
  });

  it("refuses a request Twilio did not sign", async () => {
    const { store, deps } = setup();
    const r = await handleTextReply("test-lane", signed({ From: PERSON, Body: "STOP" }, "wrong-token"), deps);
    expect(r.status).toBe(403);
    expect(await store.isDoNotContact(PERSON)).toBe(false);
  });

  it("writes nothing without the auth token to check the signature with", async () => {
    const { store, deps } = setup();
    const r = await handleTextReply("test-lane", signed({ From: PERSON, Body: "STOP" }), { ...deps, env: {} });
    expect(r.status).toBe(200);
    expect(await store.isDoNotContact(PERSON)).toBe(false);
  });

  it("writes nothing for a lane that does not text", async () => {
    const { store, deps } = setup({ ...policy, textOutreach: undefined });
    await handleTextReply("test-lane", signed({ From: PERSON, Body: "STOP" }), deps);
    expect(await store.isDoNotContact(PERSON)).toBe(false);
  });
});

describe("the runtime serves it, the booking page and the texts", () => {
  const SRC = readFileSync("src/runtime/voiceRuntime.ts", "utf8");

  it("mounts the reply webhook, the page and its steps", () => {
    expect(SRC).toContain("app.post(textReplyPath(OUTBOUND_PATH_PREFIX, \":slug\")");
    expect(SRC).toContain("app.get(`${BOOKING_PATH_PREFIX}/:token`");
    expect(SRC).toContain("app.post(`${BOOKING_PATH_PREFIX}/:token/:step`");
    expect(SRC).toContain("handleBookingStep(String(req.params.token");
  });

  it("hands the scheduler the Twilio SMS sender", () => {
    expect(SRC).toContain("sms: options.outboundSms ?? (async () => createTwilioSmsSender(env)),");
  });
});
