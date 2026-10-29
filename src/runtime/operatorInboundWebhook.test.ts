import { describe, expect, it, vi } from "vitest";
import twilio from "twilio";
import { MemoryPluginStore } from "../plugin/store";
import { FakeOutboundStore } from "./outbound/store.testkit";
import { CallSessionRegistry } from "./sessionRegistry";
import { OPERATOR_INBOUND_PATH, OperatorInboundWebhook } from "./operatorInboundWebhook";
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
  it.each(["inbound", "status", "after"] as const)("rejects missing, invalid and altered signatures on %s", async (method) => {
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
    expect(record).toMatchObject({ direction: "inbound", callerNumber: PHONE, requestSummary: null });
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

  it("saves the confirmed summary and transcript once, before notifying", async () => {
    const h = boot(); await h.service.inbound(signed());
    const tools = h.service.tools(CALL_SID);
    expect(tools.map((t) => t.name)).toEqual(["end_call", "record_call_outcome", "opt_out_of_calls"]);
    const recordTool = tools.find((t) => t.name === "record_call_outcome")!;
    expect(await recordTool.invoke!({}, JSON.stringify({ confirmed: false, request_summary: "Arrange a meeting" }))).toMatchObject({ success: false });
    expect((await h.store.getOperatorInboundCall(CALL_SID))!.requestSummary).toBeNull();
    await recordTool.invoke!({}, JSON.stringify({ confirmed: true, request_summary: "Arrange a meeting" }));
    const turns = [{ role: "caller" as const, text: "Yes, that is correct.", atMs: Date.now() }];
    await Promise.all([h.service.complete(CALL_SID, turns, "caller_hangup"), h.service.complete(CALL_SID, [], "completed")]);
    expect(await h.store.getOperatorInboundCall(CALL_SID)).toMatchObject({ requestSummary: "Arrange a meeting", turns, endedAt: expect.any(Date) });
    expect(h.notifier).toHaveBeenCalledTimes(1);
    expect(h.notifier.mock.calls[0][0].turns).toEqual(turns);
    await h.service.status(signed({ CallStatus: "completed" }, `${OPERATOR_INBOUND_PATH}/status`));
    expect(h.notifier).toHaveBeenCalledTimes(1);
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

  it("ends setup failures politely without promising a patient office follow-up", async () => {
    const h = boot(); await h.service.inbound(signed());
    h.registry.recordOutcome(CALL_SID, "provider_failure");
    const response = h.service.after(signed({}, `${OPERATOR_INBOUND_PATH}/after`));
    expect(response.body).toMatch(/unavailable.*<Hangup\/>/);
    expect(response.body).not.toMatch(/office|follow up/i);
    expect(h.registry.get(CALL_SID)).toBeUndefined();
  });
});
