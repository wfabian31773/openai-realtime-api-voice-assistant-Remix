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

function boot(enabled = true) {
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
      OPERATOR_LINE_FROM_NUMBER: TO, OPERATOR_LINE_INBOUND_ENABLED: "true" },
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
    expect(update.session.instructions).toContain("You answer Wayne Fabian's operator line");
    expect(update.session.tools.map((tool: any) => tool.name)).toEqual(["end_call", "record_call_outcome", "opt_out_of_calls"]);
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
      name: optOut ? "opt_out_of_calls" : "record_call_outcome",
      arguments: JSON.stringify(optOut ? {} : { confirmed: true, request_summary: "Arrange a meeting" }) });
    await vi.waitFor(async () => expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject(
      optOut ? { optedOut: true } : { requestSummary: "Arrange a meeting" }));
    socket.close();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    const saved = await h.store.getOperatorInboundCall(callSid);
    expect(saved).toMatchObject({ callerNumber: PHONE, direction: "inbound", optedOut: optOut, endedAt: expect.any(Date), requestSummary: optOut ? null : "Arrange a meeting" });
    expect(saved!.turns).toContainEqual(expect.objectContaining({ role: "caller", text }));
    if (optOut) expect(await h.outbound.isDoNotContact(PHONE)).toBe(true);
    expect(h.persistCall).toHaveBeenCalledWith(expect.objectContaining({ transcript: "", turns: [], toolEvents: [] }));
    for (const hook of [h.sweepCall, h.sweepPcpFloor, h.fileSetupFailure, h.gradeCall]) expect(hook).not.toHaveBeenCalled();
    await h.post(`${OPERATOR_INBOUND_PATH}/after`, body);
    await h.post(`${OPERATOR_INBOUND_PATH}/status`, { ...body, CallStatus: "completed" });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("persists failed setup without creating a patient ticket", async () => {
    const h = boot(false);
    const callSid = `CA${"e".repeat(32)}`;
    const answer = await h.post(OPERATOR_INBOUND_PATH, { CallSid: callSid, From: PHONE, To: TO });
    h.stream(callSid, answer.body.match(/name="token" value="([^"]+)"/)![1]);
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(await h.store.getOperatorInboundCall(callSid)).toMatchObject({ status: "provider_failure", endedAt: expect.any(Date) });
    expect(h.fileSetupFailure).not.toHaveBeenCalled();
  });
});
