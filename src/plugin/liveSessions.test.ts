import { describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { LiveCallRegistry, LIVE_RETENTION_MS } from "./liveSessions";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { CallSessionRegistry } from "../runtime/sessionRegistry";
import { handleOutboundAnswer, handleOutboundStatus } from "../runtime/outbound/outboundWebhook";
import { siAssistantPolicy } from "../agents/siAssistantAgent";

async function setup() {
  const store = new FakeOutboundStore();
  store.addContact({ id: "contact", phone: "+15555550111", customData: { plugin_live: true } });
  await store.claimContact("contact", new Date());
  const attemptId = await store.startAttempt("contact", store.campaignId, 1);
  const liveCalls = new LiveCallRegistry();
  const session = liveCalls.create({ approvalId: "approval", tokenJti: "bot", contactId: "contact", attemptId });
  const registry = new CallSessionRegistry();
  const env = { TWILIO_AUTH_TOKEN: "test-auth", DATABASE_URL: "postgres://test", XAI_API_KEY: "test-unused" };
  const deps = { store, registry, env, liveCalls, policyFor: () => siAssistantPolicy };
  const query = `contact=contact&attempt=${attemptId}&liveSession=${session.sessionId}`;
  function request(path: string, body: Record<string, string>) {
    return { originalUrl: path, body, headers: { host: "fleet.example", "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, `https://fleet.example${path}`, body) } };
  }
  return { ...deps, deps, session, query, request };
}

describe("signed live call webhooks and memory retention", () => {
  it("binds an early callback before createCall returns, and carries the attempt into the voice lane", async () => {
    const h = await setup();
    try {
      const path = `/voice/si-assistant?${h.query}`;
      const body = { CallSid: "CA-early", From: "+19092553213", To: "+15555550111", AnsweredBy: "human" };
      const bad = h.request(path, body); bad.headers["x-twilio-signature"] = "invalid";
      expect((await handleOutboundAnswer("si-assistant", bad, h.deps)).status).toBe(403);
      expect(h.session.callSid).toBeNull();
      const answer = await handleOutboundAnswer("si-assistant", h.request(path, body), h.deps);
      expect(answer.body).toContain("<Connect><Stream");
      expect(h.session.callSid).toBe("CA-early");
      expect(h.registry.get("CA-early")).toMatchObject({ slug: "si-assistant", liveSessionId: h.session.sessionId, callerPhone: body.To, dialedNumber: body.From,
        outbound: { campaignKey: "si-assistant", contactId: "contact", attemptId: h.session.attemptId } });
      // A different attempt or SID must not take over this session.
      const wrong = path.replace("contact=contact", "contact=another");
      expect((await handleOutboundAnswer("si-assistant", h.request(wrong, body), h.deps)).body).toContain("<Hangup/>");
      const wrongSid = { ...body, CallSid: "CA-another" };
      expect((await handleOutboundAnswer("si-assistant", h.request(path, wrongSid), h.deps)).body).toContain("<Hangup/>");
    } finally { h.liveCalls.clear(); }
  });

  it.each(["completed", "no-answer", "busy", "failed", "canceled"])("tracks %s and ends its campaign attempt", async (status) => {
    const h = await setup();
    try {
      const path = `/voice/outbound/si-assistant/status?${h.query}`;
      await handleOutboundStatus("si-assistant", h.request(path, { CallSid: "CA-status", CallStatus: "ringing" }), h.deps);
      expect(h.session.status).toBe("ringing");
      const end = vi.fn();
      h.liveCalls.attach("CA-status", { turns: () => [{ role: "caller", text: "private words", atMs: 1000 }], instruct: () => {}, end });
      await handleOutboundStatus("si-assistant", h.request(path, { CallSid: "CA-status", CallStatus: "ringing" }), h.deps);
      expect(h.session.status).toBe("in_progress");
      await handleOutboundStatus("si-assistant", h.request(path, { CallSid: "CA-status", CallStatus: status }), h.deps);
      expect(h.session.status).toBe(status === "completed" ? "completed" : ["busy", "no-answer"].includes(status) ? "no_answer" : "failed");
      expect(h.session.endedAt).not.toBeNull();
      expect(h.store.attempts[0].endedAt).toBeDefined();
      expect(end).toHaveBeenCalledOnce();
      expect(h.liveCalls.view(h.session).transcript).toEqual([{ role: "caller", text: "private words", at: new Date(1000).toISOString() }]);
      expect(h.session.controls).toBeUndefined();
      expect(await h.store.dialableContacts(h.store.campaignId, new Date(Date.now() + 86_400_000), 10)).toEqual([]);
    } finally { h.liveCalls.clear(); }
  });

  it("still settles the campaign attempt when the live session was lost (restart)", async () => {
    const h = await setup();
    try {
      const path = `/voice/outbound/si-assistant/status?${h.query}`;
      h.liveCalls.clear();
      const res = await handleOutboundStatus("si-assistant", h.request(path, { CallSid: "CA-lost", CallStatus: "completed", CallDuration: "12" }), h.deps);
      expect(res.status).toBe(204);
      expect(h.store.attempts[0].endedAt).toBeDefined();
      expect(await h.store.dialableContacts(h.store.campaignId, new Date(Date.now() + 86_400_000), 10)).toEqual([]);
    } finally { h.liveCalls.clear(); }
  });

  it("drops retained transcript buffers by timer even when nobody polls", () => {
    vi.useFakeTimers();
    try {
      const sessions = new LiveCallRegistry();
      const session = sessions.create({ approvalId: "a", tokenJti: "bot", contactId: "c", attemptId: "d" });
      sessions.bindCall(session.sessionId, "CA-timer");
      sessions.attach("CA-timer", { turns: () => [{ role: "agent", text: "in memory only", atMs: Date.now() }], instruct: () => {}, end: () => {} });
      sessions.setStatus(session.sessionId, "completed");
      expect(session.turns).toHaveLength(1);
      vi.advanceTimersByTime(LIVE_RETENTION_MS);
      expect(session.turns).toEqual([]);
      expect(sessions.get(session.sessionId)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
