import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:5432/unused";
  process.env.OPENAI_API_KEY ||= "synthetic-key";
});
// Only the socket boundary is replaced. The mounted handlers, stream gate,
// lane resolver, agent, provider session, bridge, tools and teardown are real.
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, WebSocketServer: class extends EventEmitter {
    handleUpgrade(_req: unknown, socket: unknown, _head: unknown, done: (ws: unknown) => void) { done(socket); }
  } };
});
import { EventEmitter } from "node:events";
import http from "node:http";
import twilio from "twilio";
import type { Express, RequestHandler } from "express";
import { mountVoiceRuntime, type RuntimeTransport } from "./voiceRuntime";
import { MemoryPluginStore } from "../plugin/store";
import { FakeOutboundStore } from "./outbound/store.testkit";
import { OPERATOR_SLUG } from "../plugin/operatorLine";
import { OPERATOR_INBOUND_PATH } from "./operatorInboundWebhook";
import { createOperatorLineAgent, operatorLinePolicy, OPERATOR_INBOUND_GREETING } from "../agents/operatorLineAgent";
import type { LaneConfig } from "./laneRegistry";

class FakeProvider implements RuntimeTransport {
  sent: any[] = [];
  closed = false;
  private receive: ((raw: string) => void) | undefined;
  private buffered: string[] = [];
  private committed = false;
  async connect() { this.emit({ type: "session.created" }); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  onMessage(cb: (raw: string) => void) { this.receive = cb; }
  onError(_cb: (error: Error) => void) {}
  onClose(_cb: () => void) {}
  emit(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    if (this.committed) this.receive?.(raw); else this.buffered.push(raw);
  }
  commitBuffered() { this.committed = true; for (const raw of this.buffered.splice(0)) this.receive?.(raw); }
  async waitForFirstEvent() { return true; }
  detachAndClose() { this.close(); }
}
class FakeTwilioSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { if (this.readyState === 1) { this.readyState = 3; this.emit("close"); } }
  frame(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
}
const sockets: FakeTwilioSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); });
const AUTH = "synthetic-auth-token";
const PHONE = "+15555550123";
const TO = "+15555550100";

function boot(enabled = true, env: Record<string, string | undefined> = {}) {
  const store = new MemoryPluginStore();
  const outbound = new FakeOutboundStore();
  const notify = vi.fn().mockResolvedValue(undefined);
  const fetchPrecontext = vi.fn();
  const resolveGreeting = vi.fn();
  const startRecording = vi.fn().mockResolvedValue("started");
  const persistCall = vi.fn().mockResolvedValue(true);
  const sweepCall = vi.fn().mockResolvedValue(undefined);
  const sweepPcpFloor = vi.fn().mockResolvedValue(undefined);
  const fileSetupFailure = vi.fn().mockResolvedValue(undefined);
  const gradeCall = vi.fn().mockResolvedValue(undefined);
  const routes: Array<{ method: string; path: string; handler: RequestHandler }> = [];
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (path: string, handler: RequestHandler) => routes.push({ method, path, handler })])) as unknown as Express;
  const server = http.createServer();
  const provider = new FakeProvider();
  const config: LaneConfig = { id: OPERATOR_SLUG, enabled, agentType: "outbound", outbound: operatorLinePolicy,
    factory: createOperatorLineAgent as unknown as LaneConfig["factory"] };
  const registry = mountVoiceRuntime(app, server, {
    env: { TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "synthetic-key", DATABASE_URL: "postgres://unused",
      OPERATOR_LINE_FROM_NUMBER: TO, OPERATOR_LINE_INBOUND_ENABLED: "true", ...env },
    laneSource: { getAgentConfig: (slug) => slug === OPERATOR_SLUG ? config : undefined },
    operatorInboundStore: store, operatorInboundNotifier: notify, outboundStore: outbound,
    fetchPrecontext, resolveGreeting, startRecording, persistCall, sweepCall, sweepPcpFloor, fileSetupFailure, gradeCall,
    createTransport: () => provider, openCallRow: async () => undefined, stampBuild: async () => true,
    persistTurns: async () => {}, logCallerAudio: async () => {},
  });
  async function post(path: string, body: Record<string, string>, valid = true) {
    const route = routes.find((r) => r.method === "post" && r.path === path)!;
    const req = { body, originalUrl: path, headers: { host: "fleet.example", "x-forwarded-proto": "https",
      "x-twilio-signature": valid ? twilio.getExpectedTwilioSignature(AUTH, `https://fleet.example${path}`, body) : "invalid" } };
    const response = { status: 200, body: "" };
    const res = { status(code: number) { response.status = code; return res; }, type(_type: string) { return res; },
      send(body: string) { response.body = body; return res; } };
    await route.handler(req as never, res as never, () => {});
    return response;
  }
  function stream(callSid: string, token: string) {
    const socket = new FakeTwilioSocket(); sockets.push(socket);
    server.emit("upgrade", { url: "/voice/stream" }, socket, Buffer.alloc(0));
    socket.frame({ event: "start", streamSid: "MZ-test", start: { streamSid: "MZ-test", callSid,
      customParameters: { callSid, token, host: "fleet.example" } } });
    return socket;
  }
  return { store, outbound, notify, provider, registry, post, stream, fetchPrecontext, resolveGreeting, startRecording,
    persistCall, sweepCall, sweepPcpFloor, fileSetupFailure, gradeCall };
}

describe("operator inbound live runtime, in process", () => {
  it.each([undefined, "90"])("enforces the inbound safety maximum (%s minutes, default 60)", async (minutes) => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const h = boot(true, { OPERATOR_LINE_MAX_CALL_MINUTES: minutes, OPERATOR_OWNER_NUMBER: PHONE });
    const callSid = `CA${"f".repeat(32)}`;
    const answer = await h.post(OPERATOR_INBOUND_PATH, { CallSid: callSid, From: PHONE, To: TO });
    h.stream(callSid, answer.body.match(/name="token" value="([^"]+)"/)![1]);
    await vi.waitFor(() => expect(h.provider.sent.some((event) => event.type === "session.update")).toBe(true));
    h.provider.emit({ type: "session.updated" });
    expect(h.provider.sent.find((event) => event.type === "session.update").session.instructions).toContain("full owner persona");
    const deadline = timers.mock.calls.find(([, ms]) => ms === Number(minutes ?? 60) * 60_000)!;
    expect(deadline).toBeDefined();
    expect((await h.store.getOperatorInboundCall(callSid))!.endedAt).toBeNull();
    (deadline[0] as () => void)();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject({ status: "max_duration", endedAt: expect.any(Date) });
  });

  it("keeps talking past 100 caller turns and the shared forty-tool ceiling", async () => {
    const h = boot();
    const callSid = `CA${"a".repeat(32)}`;
    const answer = await h.post(OPERATOR_INBOUND_PATH, { CallSid: callSid, From: PHONE, To: TO });
    const socket = h.stream(callSid, answer.body.match(/name="token" value="([^"]+)"/)![1]);
    await vi.waitFor(() => expect(h.provider.sent.some((event) => event.type === "session.update")).toBe(true));
    h.provider.emit({ type: "session.updated" });
    // Identical requests also exceed the patient lanes' ten-success ceiling.
    for (let index = 0; index < 45; index++) {
      h.provider.emit({ type: "response.created" });
      h.provider.emit({ type: "response.function_call_arguments.done", call_id: `request-${index}`,
        name: "queue_request_for_grok_bot", arguments: JSON.stringify({ request: "Please queue another reminder" }) });
      h.provider.emit({ type: "response.done" });
    }
    for (let index = 0; index < 101; index++) {
      h.provider.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: `turn-${index}`, transcript: `Continue topic ${index}` });
    }
    await vi.waitFor(async () => expect((await h.store.getOperatorInboundCall(callSid))!.queuedRequests).toHaveLength(45));
    expect(h.notify).toHaveBeenCalledTimes(45);
    expect((await h.store.getOperatorInboundCall(callSid))!.endedAt).toBeNull();
    expect(h.provider.closed).toBe(false);
    socket.close();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(46));
    const final = (await h.store.getOperatorInboundCall(callSid))!;
    expect(final.turns.filter((turn) => turn.role === "caller")).toHaveLength(101);
    expect(h.notify.mock.calls[45][0].queuedRequests).toHaveLength(45);
  });

  it.each([false, true])("records the live conversation without patient work (opt-out=%s)", async (optOut) => {
    const h = boot();
    const callSid = `CA${(optOut ? "d" : "c").repeat(32)}`;
    const body = { CallSid: callSid, From: PHONE, To: TO };
    expect((await h.post(OPERATOR_INBOUND_PATH, body, false)).status).toBe(403);
    const answer = await h.post(OPERATOR_INBOUND_PATH, body);
    const token = answer.body.match(/name="token" value="([^"]+)"/)![1];
    const socket = h.stream(callSid, token);
    await vi.waitFor(() => expect(h.provider.sent.some((e) => e.type === "session.update")).toBe(true));
    const update = h.provider.sent.find((e) => e.type === "session.update");
    expect(update.session.instructions).toContain("You are Grok Bot");
    expect(update.session.tools.map((tool: any) => tool.name)).toEqual(["end_call", "queue_request_for_grok_bot", "opt_out_of_calls"]);
    expect(update.session.instructions).not.toMatch(/Business Facts|Caller script\/persona|identify_callback_caller/);
    expect(h.fetchPrecontext).not.toHaveBeenCalled();
    expect(h.resolveGreeting).not.toHaveBeenCalled();
    expect(h.startRecording).toHaveBeenCalledWith(callSid, "fleet.example");
    h.provider.emit({ type: "session.updated" });
    expect(JSON.stringify(h.provider.sent.filter((e) => e.type === "conversation.item.create"))).toContain(OPERATOR_INBOUND_GREETING);
    const text = optOut ? "Please do not call me again." : "Yes, please arrange a meeting.";
    h.provider.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "operator-caller", transcript: text });
    h.provider.emit({ type: "response.created" });
    h.provider.emit({ type: "response.function_call_arguments.done", call_id: "operator-result",
      name: optOut ? "opt_out_of_calls" : "queue_request_for_grok_bot",
      arguments: JSON.stringify(optOut ? {} : { request: "Arrange a meeting" }) });
    await vi.waitFor(async () => expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject(
      optOut ? { optedOut: true } : { queuedRequests: [expect.objectContaining({ text: "Arrange a meeting" })] }));
    socket.close();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(optOut ? 1 : 2));
    const saved = await h.store.getOperatorInboundCall(callSid);
    expect(saved).toMatchObject({ callerNumber: PHONE, direction: "inbound", optedOut: optOut, endedAt: expect.any(Date), queuedRequests: optOut ? [] : [expect.objectContaining({ text: "Arrange a meeting" })] });
    expect(saved!.turns).toContainEqual(expect.objectContaining({ role: "caller", text }));
    if (optOut) expect(await h.outbound.isDoNotContact(PHONE)).toBe(true);
    expect(h.persistCall).toHaveBeenCalledWith(expect.objectContaining({ transcript: "", turns: [], toolEvents: [] }));
    for (const hook of [h.sweepCall, h.sweepPcpFloor, h.fileSetupFailure, h.gradeCall]) expect(hook).not.toHaveBeenCalled();
    await h.post(`${OPERATOR_INBOUND_PATH}/after`, body);
    await h.post(`${OPERATOR_INBOUND_PATH}/status`, { ...body, CallStatus: "completed" });
    expect(h.notify).toHaveBeenCalledTimes(optOut ? 1 : 2);
  });

  it("persists failed setup without creating a patient ticket", async () => {
    const h = boot(false);
    const callSid = `CA${"e".repeat(32)}`;
    const answer = await h.post(OPERATOR_INBOUND_PATH, { CallSid: callSid, From: PHONE, To: TO });
    h.stream(callSid, answer.body.match(/name="token" value="([^"]+)"/)![1]);
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject({ status: "provider_failure", endedAt: expect.any(Date) });
    expect(h.fileSetupFailure).not.toHaveBeenCalled();
    const fallback = await h.post(`${OPERATOR_INBOUND_PATH}/after`, { CallSid: callSid, From: PHONE, To: TO });
    expect(fallback.body).toContain("<Record ");
  });

  it("checks the staff switch again between TwiML admission and provider setup", async () => {
    const h = boot();
    const callSid = `CA${"a".repeat(32)}`;
    const body = { CallSid: callSid, From: PHONE, To: TO };
    const response = await h.post(OPERATOR_INBOUND_PATH, body);
    await h.store.setOperatorLineEnabled(false, "staff");
    const socket = h.stream(callSid, response.body.match(/name="token" value="([^"]+)"/)![1]);
    await vi.waitFor(() => expect(h.registry.get(callSid)?.outcome).toBe("provider_failure"));
    expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject({ status: "operator_line_disabled", endedAt: expect.any(Date) });
    expect(h.provider.sent).toEqual([]);
    expect((await h.post(`${OPERATOR_INBOUND_PATH}/after`, body)).body).not.toContain("<Record");
    socket.close();
  });
});
