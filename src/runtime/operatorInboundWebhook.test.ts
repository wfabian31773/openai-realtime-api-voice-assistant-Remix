import { describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { MemoryPluginStore } from "../plugin/store";
import { createOperatorInboundNotifier } from "../plugin/operatorInboundNotifier";
import { FakeOutboundStore } from "./outbound/store.testkit";
import { CallSessionRegistry } from "./sessionRegistry";
import { OPERATOR_INBOUND_PATH, OPERATOR_SMS_PATH, OPERATOR_FALLBACK_PATH, OPERATOR_VOICEMAIL_PATH, OperatorInboundWebhook } from "./operatorInboundWebhook";
import type { WebhookRequest } from "./voiceWebhook";

const CALL_SID = `CA${"b".repeat(32)}`;
const PHONE = "+15555550123";
const TO = "+15555550100";
const AUTH = "synthetic-twilio-token";
function signed(body: Record<string, string> = {}, path = OPERATOR_INBOUND_PATH): WebhookRequest {
  const params = { CallSid: CALL_SID, From: PHONE, To: TO, ...body };
  return { body: params, originalUrl: path, headers: {
    host: "private.internal", "x-forwarded-host": "fleet.example", "x-forwarded-proto": "https",
    "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH, `https://fleet.example${path}`, params),
  } };
}
function boot(over: Record<string, string | undefined> = {}) {
  const store = new MemoryPluginStore();
  const outbound = new FakeOutboundStore();
  const registry = new CallSessionRegistry();
  const notifier = vi.fn().mockResolvedValue(undefined);
  const service = new OperatorInboundWebhook({ env: { TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "synthetic-key", DATABASE_URL: "postgres://unused",
    OPERATOR_LINE_FROM_NUMBER: TO, OPERATOR_LINE_INBOUND_ENABLED: "true", ...over }, registry, store: () => store,
    outbound: async () => outbound, notifier, now: () => new Date("2026-10-29T15:00:00Z") });
  return { service, store, outbound, registry, notifier };
}

describe("signed operator inbound admission and completion", () => {
  it("notifies once when media-stream completion races the signed status callback", async () => {
    const h = boot();
    await h.service.inbound(signed());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finish = h.store.finishOperatorInboundCall.bind(h.store);
    const writes = vi.spyOn(h.store, "finishOperatorInboundCall").mockImplementation(async (...args) => {
      await gate;
      return finish(...args);
    });
    const turns = [{ role: "caller" as const, text: "A synthetic final turn", atMs: 1 }];
    // The media-stream close path calls complete() with its final transcript.
    const close = h.service.complete(CALL_SID, turns, "caller_hangup");
    const status = h.service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`));
    release();
    await Promise.all([close, status]);
    expect(writes).toHaveBeenCalledOnce();
    expect(h.notifier).toHaveBeenCalledOnce();
    expect(await h.store.getOperatorInboundCall(CALL_SID)).toMatchObject({ endedAt: expect.any(Date), turns });
    await h.service.complete(CALL_SID, [], "completed");
    expect(h.notifier).toHaveBeenCalledOnce();
  });

  it.each(["inbound", "status", "after", "sms", "fallback", "voicemail"] as const)("rejects missing, invalid and altered signatures on %s", async (method) => {
    const { service, registry } = boot();
    for (const mutate of [
      (req: WebhookRequest) => { delete req.headers["x-twilio-signature"]; },
      (req: WebhookRequest) => { req.headers["x-twilio-signature"] = "invalid"; },
      (req: WebhookRequest) => { req.body.To = "+15555550999"; },
    ]) {
      const req = signed({}, method === "inbound" ? OPERATOR_INBOUND_PATH : `${OPERATOR_INBOUND_PATH}/${method}`);
      mutate(req);
      expect((await service[method](req)).status).toBe(403);
    }
    expect(registry.activeCount()).toBe(0);
  });

  it("applies the persisted staff switch, the env hard off and storage failures to inbound", async () => {
    const h = boot();
    await h.store.setOperatorLineEnabled(false, "staff");
    expect((await h.service.inbound(signed())).body).toContain("<Hangup/>");
    expect(h.store.operatorInboundCalls.size).toBe(0);
    await h.store.setOperatorLineEnabled(true, "staff");
    expect((await h.service.inbound(signed())).body).toContain("<Stream");
    const disabled = boot({ OPERATOR_LINE_INBOUND_ENABLED: "false" });
    await disabled.store.setOperatorLineEnabled(true, "staff");
    expect((await disabled.service.inbound(signed())).body).not.toContain("<Stream");
    vi.spyOn(h.store, "getOperatorLineEnabled").mockRejectedValue(new Error("private database error"));
    expect((await h.service.inbound(signed())).body).not.toContain("<Stream");
  });

  it("has NO daily cap and NO peak window on inbound operator admission", async () => {
    const h = boot({ OUTBOUND_DAILY_CAP: "0", OUTBOUND_CAMPAIGN_WAYNE_OPERATOR: "0" });
    const service = new OperatorInboundWebhook({ env: { TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "synthetic-key", DATABASE_URL: "postgres://unused",
      OPERATOR_LINE_FROM_NUMBER: TO, OPERATOR_LINE_INBOUND_ENABLED: "true" }, registry: h.registry,
      store: () => h.store, outbound: async () => h.outbound, now: () => new Date("2026-11-01T08:00:00Z") });
    // Early Sunday morning Pacific; neither daily usage nor time of day gates it.
    for (let i = 1; i <= 12; i++) {
      expect((await service.inbound(signed({ CallSid: `CA${i.toString(16).padStart(32, "0")}` }))).body).toContain("<Stream");
    }
    expect(h.store.operatorInboundCalls.size).toBe(12);
  });

  it("persists inbound SMS once, acknowledges with empty TwiML and notifies only after storage", async () => {
    const h = boot();
    const messageSid = `SM${"a".repeat(32)}`;
    const req = signed({ MessageSid: messageSid, Body: "PRIVATE message" }, OPERATOR_SMS_PATH);
    const response = await h.service.sms(req);
    expect(response).toMatchObject({ status: 200, contentType: "text/xml" });
    expect(response.body).not.toMatch(/Say|Message|PRIVATE/);
    expect(await h.store.getOperatorSms(messageSid)).toMatchObject({ body: "PRIVATE message", callerNumber: PHONE,
      fetchUrl: `https://fleet.example/api/plugin/v1/operator-line/sms/${messageSid}` });
    expect(h.notifier).toHaveBeenCalledOnce();
    await h.service.sms(req);
    expect(h.notifier).toHaveBeenCalledOnce();
    const anonymous = signed({ MessageSid: `SM${"c".repeat(32)}`, Body: "private", From: "anonymous" }, OPERATOR_SMS_PATH);
    await h.service.sms(anonymous);
    expect((await h.store.getOperatorSms(anonymous.body.MessageSid))!.callerNumber).toBeNull();
  });

  it.each(["switch", "env", "number"])("ignores SMS and refuses voicemail fallback when disabled by %s", async (mode) => {
    const h = boot(mode === "env" ? { OPERATOR_LINE_INBOUND_ENABLED: "false" } : mode === "number" ? { OPERATOR_LINE_FROM_NUMBER: "+15555550999" } : {});
    if (mode === "switch") await h.store.setOperatorLineEnabled(false, "staff");
    expect((await h.service.sms(signed({ MessageSid: `SM${"a".repeat(32)}`, Body: "private" }, OPERATOR_SMS_PATH))).body).not.toContain("Message");
    expect(h.store.operatorSms.size).toBe(0);
    expect(h.notifier).not.toHaveBeenCalled();
    expect((await h.service.fallback(signed({}, OPERATOR_FALLBACK_PATH))).body).not.toContain("<Record");
    expect(h.store.operatorInboundCalls.size).toBe(0);
  });

  it("returns a retryable failure if SMS persistence fails, without a notification", async () => {
    const h = boot();
    vi.spyOn(h.store, "saveOperatorSms").mockRejectedValue(new Error("private storage failure"));
    expect((await h.service.sms(signed({ MessageSid: `SM${"a".repeat(32)}`, Body: "private" }, OPERATOR_SMS_PATH))).status).toBe(503);
    expect(h.notifier).not.toHaveBeenCalled();
  });

  it("returns a retryable SMS error when the setting cannot be read, instead of treating storage failure as a staff kill", async () => {
    const h = boot();
    vi.spyOn(h.store, "getOperatorLineEnabled").mockRejectedValue(new Error("private storage error"));
    expect((await h.service.sms(signed({ MessageSid: `SM${"a".repeat(32)}`, Body: "private" }, OPERATOR_SMS_PATH))).status).toBe(503);
    expect(h.notifier).not.toHaveBeenCalled();
    expect(h.store.operatorSms.size).toBe(0);
  });

  it("offers recording when realtime is unavailable and from the signed Voice Fallback URL", async () => {
    const h = boot({ XAI_API_KEY: undefined });
    for (const response of [await h.service.inbound(signed()), await h.service.fallback(signed({}, OPERATOR_FALLBACK_PATH))]) {
      expect(response.body).toContain(`<Record action="${OPERATOR_VOICEMAIL_PATH}"`);
      expect(response.body).toContain(`transcribeCallback="${OPERATOR_VOICEMAIL_PATH}"`);
      expect(response.body).toContain(`recordingStatusCallback="${OPERATOR_VOICEMAIL_PATH}"`);
      expect(response.body).not.toContain("<Stream");
    }
    expect(h.store.operatorInboundCalls.size).toBe(1);
    expect(h.registry.activeCount()).toBe(0);
  });

  it.each([false, true])("merges recording/transcription callbacks in either order, deduplicates and saves accepted recordings after a kill (%s)", async (transcriptFirst) => {
    const h = boot();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    h.notifier.mockImplementation(createOperatorInboundNotifier({ OPERATOR_INBOUND_NOTIFIER: "webhook",
      OPERATOR_INBOUND_WEBHOOK_URL: "https://bot.example/handoff", OPERATOR_INBOUND_WEBHOOK_SECRET: "synthetic-secret" },
    { fetch: request, store: () => h.store, log: vi.fn() }));
    await h.service.fallback(signed({}, OPERATOR_FALLBACK_PATH));
    await h.store.setOperatorLineEnabled(false, "staff");
    const recordingSid = `RE${"a".repeat(32)}`;
    const recording = signed({ RecordingSid: recordingSid, RecordingUrl: "https://api.twilio.com/private-recording" }, OPERATOR_VOICEMAIL_PATH);
    const transcript = signed({ RecordingSid: recordingSid, TranscriptionText: "PRIVATE transcript", TranscriptionStatus: "completed" }, OPERATOR_VOICEMAIL_PATH);
    for (const req of transcriptFirst ? [transcript, recording] : [recording, transcript]) {
      expect((await h.service.voicemail(req)).status).toBe(200);
      await h.notifier.mock.results[h.notifier.mock.results.length - 1].value;
    }
    expect(await h.store.getOperatorVoicemail(recordingSid)).toMatchObject({ callSid: CALL_SID, recordingSid,
      recordingUrl: recording.body.RecordingUrl, transcript: "PRIVATE transcript", transcriptionStatus: "completed" });
    expect(h.notifier).toHaveBeenCalledTimes(2);
    const phases = transcriptFirst ? ["transcript", "recording"] : ["recording", "transcript"];
    expect(request.mock.calls.map(([, init]) => JSON.parse(init!.body as string).event_id)).toEqual(
      phases.map((phase) => `opline:vm:${recordingSid}:${phase}`),
    );
    await h.service.voicemail(recording); await h.service.voicemail(transcript);
    expect(h.notifier).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects unrelated or malformed voicemail callbacks and retries storage failures", async () => {
    const h = boot();
    const req = signed({ RecordingSid: `RE${"a".repeat(32)}` }, OPERATOR_VOICEMAIL_PATH);
    expect((await h.service.voicemail(req)).status).toBe(404);
    expect((await h.service.voicemail(signed({ RecordingSid: "bad" }, OPERATOR_VOICEMAIL_PATH))).status).toBe(400);
    await h.service.fallback(signed({}, OPERATOR_FALLBACK_PATH));
    vi.spyOn(h.store, "saveOperatorVoicemail").mockRejectedValue(new Error("private database failure"));
    expect((await h.service.voicemail(req)).status).toBe(503);
    expect(h.notifier).not.toHaveBeenCalled();
  });

  it("uses forwarded public URL reconstruction and the existing single-use stream gate", async () => {
    const h = boot();
    const response = await h.service.inbound(signed({}, `${OPERATOR_INBOUND_PATH}?source=twilio`));
    expect(response.status).toBe(200);
    expect(response.body).toContain('url="wss://fleet.example/voice/stream"');
    expect(response.body).toContain(`statusCallback="https://fleet.example${OPERATOR_INBOUND_PATH}/status"`);
    expect(response.body).toContain(`${OPERATOR_INBOUND_PATH}/after`);
    const token = response.body.match(/name="token" value="([^"]+)"/)![1];
    expect(h.registry.claimStream(CALL_SID, token)).toMatchObject({ slug: "wayne-operator", operatorInbound: true });
    expect(h.registry.claimStream(CALL_SID, token)).toBeNull();
    const record = await h.store.getOperatorInboundCall(CALL_SID);
    expect(record).toMatchObject({ direction: "inbound", callerNumber: PHONE, queuedRequests: [] });
    expect(response.body).not.toContain(PHONE);
  });

  it.each([undefined, "false", "1", "TRUE"])("speaks a polite hangup when the flag is %s", async (flag) => {
    const h = boot({ OPERATOR_LINE_INBOUND_ENABLED: flag });
    const response = await h.service.inbound(signed());
    expect(response.body).toMatch(/<Say>.*unavailable.*<\/Say><Hangup\/>/);
    expect(h.store.operatorInboundCalls.size).toBe(0);
    expect(h.registry.activeCount()).toBe(0);
  });

  it.each([undefined, "+15555550999", "invalid"])("refuses a different or unconfigured To number (%#)", async (to) => {
    const h = boot({ OPERATOR_LINE_FROM_NUMBER: to });
    expect((await h.service.inbound(signed())).body).not.toContain("<Stream");
    expect(h.store.operatorInboundCalls.size).toBe(0);
  });

  it("requires signatures even when disabled or the legacy bypass is set", async () => {
    const h = boot({ OPERATOR_LINE_INBOUND_ENABLED: "false", BYPASS_TWILIO_VALIDATION: "true" });
    const req = signed(); req.headers["x-twilio-signature"] = "bad";
    expect((await h.service.inbound(req)).status).toBe(403);
    expect((await boot({ TWILIO_AUTH_TOKEN: undefined }).service.inbound(signed())).status).toBe(403);
  });

  it("fails closed without a database/readiness or durable admission", async () => {
    expect((await boot({ DATABASE_URL: undefined }).service.inbound(signed())).body).not.toContain("<Stream");
    const h = boot();
    vi.spyOn(h.store, "startOperatorInboundCall").mockRejectedValue(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await h.service.inbound(signed())).body).not.toContain("<Stream"); }
    finally { log.mockRestore(); }
    expect(h.registry.activeCount()).toBe(0);
  });

  it("keeps webhook retries idempotent and refuses a CallSid already bound to another lane", async () => {
    const h = boot();
    const first = await h.service.inbound(signed());
    const id = (await h.store.getOperatorInboundCall(CALL_SID))!.callId;
    expect((await h.service.inbound(signed())).body).toBe(first.body);
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.callId).toBe(id);
    const other = boot();
    other.registry.register({ callSid: CALL_SID, slug: "optical", callerPhone: PHONE, dialedNumber: TO });
    expect((await other.service.inbound(signed())).body).not.toContain("<Stream");
  });

  it("retains long operator calls without changing the patient session expiry", async () => {
    let now = Date.now();
    const registry = new CallSessionRegistry(undefined, () => now);
    const h = boot();
    const service = new OperatorInboundWebhook({ env: { TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "synthetic-key", DATABASE_URL: "postgres://unused",
      OPERATOR_LINE_FROM_NUMBER: TO, OPERATOR_LINE_INBOUND_ENABLED: "true", OPERATOR_LINE_MAX_CALL_MINUTES: "90" }, registry,
      store: () => h.store, outbound: async () => h.outbound, notifier: h.notifier });
    await service.inbound(signed());
    registry.register({ callSid: "CA-patient", slug: "optical", callerPhone: PHONE, dialedNumber: TO });
    now += 61 * 60_000;
    expect(registry.get(CALL_SID)).toMatchObject({ operatorInbound: true });
    expect(registry.get("CA-patient")).toBeUndefined();
    expect((await service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`))).status).toBe(204);
    expect(h.notifier).toHaveBeenCalledOnce();
  });

  it("queues multiple requests without waiting for notifier delivery, and sends one final summary", async () => {
    const h = boot(); await h.service.inbound(signed());
    // A notifier that never settles must not hold a tool response or hangup.
    h.notifier.mockImplementation(() => new Promise(() => {}));
    const tools = h.service.tools(CALL_SID);
    expect(tools.map((t) => t.name)).toEqual(["end_call", "queue_request_for_grok_bot", "opt_out_of_calls"]);
    const queue = tools.find((t) => t.name === "queue_request_for_grok_bot")!;
    expect(await queue.invoke!({}, JSON.stringify({ request: "" }))).toMatchObject({ success: false });
    const results = await Promise.all(["Arrange a meeting", "Send the agenda"].map((request) => queue.invoke!({}, JSON.stringify({ request }))));
    expect(results).toEqual([expect.objectContaining({ success: true, status: "queued", request_id: expect.any(String) }), expect.objectContaining({ success: true, status: "queued" })]);
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.endedAt).toBeNull();
    const requests = (await h.store.getOperatorInboundCall(CALL_SID))!.queuedRequests;
    expect(requests.map((request) => request.text)).toEqual(["Arrange a meeting", "Send the agenda"]);
    expect(h.notifier).toHaveBeenCalledTimes(2);
    expect(h.notifier.mock.calls[0][1]).toBe(requests[0].id);
    const turns = [{ role: "caller" as const, text: "Let's keep talking.", atMs: Date.now() }];
    await Promise.all([h.service.complete(CALL_SID, turns, "caller_hangup"), h.service.complete(CALL_SID, [], "completed")]);
    expect(await h.store.getOperatorInboundCall(CALL_SID)).toMatchObject({ queuedRequests: requests, turns, endedAt: expect.any(Date) });
    expect(h.notifier).toHaveBeenCalledTimes(3);
    expect(h.notifier.mock.calls[2]).toEqual([expect.objectContaining({ queuedRequests: requests, turns })]);
    expect(await queue.invoke!({}, JSON.stringify({ request: "Too late" }))).toMatchObject({ success: false });
    await h.service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`));
    expect(h.notifier).toHaveBeenCalledTimes(3);
  });

  it("does not notify or claim a queue success when durable storage fails", async () => {
    const h = boot(); await h.service.inbound(signed());
    vi.spyOn(h.store, "appendOperatorInboundRequest").mockRejectedValue(new Error("unavailable"));
    const queue = h.service.tools(CALL_SID).find((tool) => tool.name === "queue_request_for_grok_bot")!;
    await expect(queue.invoke!({}, JSON.stringify({ request: "A request" }))).rejects.toThrow("unavailable");
    expect(h.notifier).not.toHaveBeenCalled();
  });

  it("lets the claimed stream own its transcript while completing an unclaimed call from signed status", async () => {
    const h = boot(); const response = await h.service.inbound(signed());
    h.registry.claimStream(CALL_SID, response.body.match(/name="token" value="([^"]+)"/)![1]);
    await h.service.status(signed({ StreamEvent: "stream-stopped" }, `${OPERATOR_INBOUND_PATH}/status`));
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.endedAt).toBeNull();
    const noStream = boot(); await noStream.service.inbound(signed());
    expect((await noStream.service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`))).status).toBe(204);
    expect((await noStream.store.getOperatorInboundCall(CALL_SID))!.endedAt).toBeInstanceOf(Date);
    expect((await noStream.service.inbound(signed())).body).not.toContain("<Stream");
  });

  it.each<Record<string, string>>([
    { CallStatus: "completed" }, { CallStatus: "failed" }, { CallStatus: "busy" },
    { CallStatus: "no-answer" }, { CallStatus: "canceled" },
    { StreamEvent: "stream-stopped" }, { StreamEvent: "stream-error" },
  ])("protects a claimed transcript after /after removes the entry (%j)", async (status) => {
    const h = boot();
    const response = await h.service.inbound(signed());
    h.registry.claimStream(CALL_SID, response.body.match(/name="token" value="([^"]+)"/)![1]);
    h.registry.recordOutcome(CALL_SID, "caller_hangup");
    await h.service.after(signed({}, `${OPERATOR_INBOUND_PATH}/after`));
    expect(h.registry.get(CALL_SID)).toBeUndefined();

    // The redirect and terminal status beat the bridge's persistence call.
    await h.service.status(signed(status, `${OPERATOR_INBOUND_PATH}/status`));
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.endedAt).toBeNull();
    expect(h.notifier).not.toHaveBeenCalled();
    const turns = [{ role: "caller" as const, text: "Please keep this conversation.", atMs: Date.now() }];
    expect(await h.service.complete(CALL_SID, turns, "caller_hangup")).toBe(true);
    expect(await h.store.getOperatorInboundCall(CALL_SID)).toMatchObject({ turns, status: "caller_hangup", endedAt: expect.any(Date) });
    expect(h.registry.hasPendingOperatorInboundStream(CALL_SID)).toBe(false);
    await h.service.status(signed(status, `${OPERATOR_INBOUND_PATH}/status`));
    expect(h.notifier).toHaveBeenCalledOnce();
    expect(h.notifier.mock.calls[0][0].turns).toEqual(turns);
  });

  it("keeps transcript ownership after a failed write until a retry persists it", async () => {
    const h = boot();
    const response = await h.service.inbound(signed());
    h.registry.claimStream(CALL_SID, response.body.match(/name="token" value="([^"]+)"/)![1]);
    h.registry.recordOutcome(CALL_SID, "caller_hangup");
    await h.service.after(signed({}, `${OPERATOR_INBOUND_PATH}/after`));
    const finish = vi.spyOn(h.store, "finishOperatorInboundCall").mockRejectedValueOnce(new Error("unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const turns = [{ role: "caller" as const, text: "Save this after the outage.", atMs: Date.now() }];
    try {
      expect(await h.service.complete(CALL_SID, turns, "caller_hangup")).toBe(false);
      await h.service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`));
      expect(finish).toHaveBeenCalledTimes(1);
      expect((await h.store.getOperatorInboundCall(CALL_SID))!.endedAt).toBeNull();
      expect(await h.service.complete(CALL_SID, turns, "caller_hangup")).toBe(true);
      expect(await h.store.getOperatorInboundCall(CALL_SID)).toMatchObject({ turns });
      expect(h.registry.hasPendingOperatorInboundStream(CALL_SID)).toBe(false);
      expect(h.notifier).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it.each([PHONE, "+442079460123"])("uses the outbound DNC mechanism for opt-out (%#)", async (phone) => {
    const h = boot(); await h.service.inbound(signed({ From: phone }));
    const optOut = h.service.tools(CALL_SID).find((t) => t.name === "opt_out_of_calls")!;
    expect(await optOut.invoke!({}, "{}")).toMatchObject({ success: true });
    if (phone === PHONE) expect(await h.outbound.isDoNotContact(phone)).toBe(true);
    else expect(await h.store.isOperatorOptedOut(phone)).toBe(true);
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.optedOut).toBe(true);
  });

  it("keeps anonymous caller numbers null and refuses to promise an opt-out was saved", async () => {
    const h = boot(); await h.service.inbound(signed({ From: "anonymous" }));
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.callerNumber).toBeNull();
    expect(await h.service.tools(CALL_SID).find((t) => t.name === "opt_out_of_calls")!.invoke!({}, "{}")).toMatchObject({ success: false });
  });

  it("offers voicemail after setup failures without promising a patient office follow-up", async () => {
    const h = boot(); await h.service.inbound(signed());
    h.registry.recordOutcome(CALL_SID, "provider_failure");
    const response = await h.service.after(signed({}, `${OPERATOR_INBOUND_PATH}/after`));
    expect(response.body).toContain("<Record ");
    expect(response.body).toContain('transcribe="true"');
    expect(response.body).not.toMatch(/office|follow up/i);
    expect(h.registry.get(CALL_SID)).toBeUndefined();
  });
});
