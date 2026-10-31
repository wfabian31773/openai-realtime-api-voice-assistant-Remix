/**
 * THE SCRIPT, FROM prepare_operator_call TO THE WIRE (v159).
 *
 * Live test 2026-10-31 09:08 ET: a callerScript opening "Opening: ..." and the
 * call still spoke OPERATOR_GREETING. operatorCallerScript.test.ts proves the
 * helpers; this drives every real link between them with only Twilio's and
 * xAI's sockets faked: prepare, commit, the signed answer webhook, the stream,
 * lane resolution and the session the provider receives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:5432/unused";
  process.env.OPENAI_API_KEY ||= "synthetic-key";
});
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
import { mountPluginApi } from "../plugin/routes";
import { LiveCallRegistry } from "../plugin/liveSessions";
import { bindPluginStore } from "../plugin/bindings";
import { FakeOutboundStore } from "./outbound/store.testkit";
import { OPERATOR_SLUG } from "../plugin/operatorLine";
import { createOperatorLineAgent, operatorLinePolicy, OPERATOR_GREETING } from "../agents/operatorLineAgent";
import type { LaneConfig } from "./laneRegistry";

class FakeProvider implements RuntimeTransport {
  sent: any[] = [];
  private receive: ((raw: string) => void) | undefined;
  private buffered: string[] = [];
  private committed = false;
  async connect() { this.emit({ type: "session.created" }); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() {}
  onMessage(cb: (raw: string) => void) { this.receive = cb; }
  onError(_cb: (error: Error) => void) {}
  onClose(_cb: () => void) {}
  emit(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    if (this.committed) this.receive?.(raw); else this.buffered.push(raw);
  }
  commitBuffered() { this.committed = true; for (const raw of this.buffered.splice(0)) this.receive?.(raw); }
  async waitForFirstEvent() { return true; }
  detachAndClose() {}
}
class FakeTwilioSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { if (this.readyState === 1) { this.readyState = 3; this.emit("close"); } }
  frame(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
}

const AUTH = "synthetic-auth-token";
const FROM = "+15555550100";
const PHONE = "+15555550123";
const CALL_SID = `CA${"a".repeat(32)}`;
const OPENING = "Hi, this is Benchmark Tester running a voice benchmark. Do you have two minutes?";
const SCRIPT = `Opening: ${OPENING}\nYou are Benchmark Tester, a friendly QA caller.\nAsk what time the Covina office opens.`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  bindPluginStore(null);
  vi.restoreAllMocks();
});

async function placeCall(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const store = new MemoryPluginStore();
  const outbound = new FakeOutboundStore();
  outbound.channelDnc = store.channelDnc;
  const liveCalls = new LiveCallRegistry();
  cleanups.push(() => liveCalls.clear());
  const env: Record<string, string | undefined> = {
    TWILIO_AUTH_TOKEN: AUTH, XAI_API_KEY: "synthetic-key", DATABASE_URL: "postgres://unused",
    OPERATOR_LINE_FROM_NUMBER: FROM, OPERATOR_LINE_INBOUND_ENABLED: "true", PLUGIN_WRITES_ENABLED: "true",
    SI_ASSISTANT_NUMBER: "+19092553213", DOMAIN: "fleet.example", APP_ENV: "production", ...extraEnv,
  };
  const sender = {
    createCall: vi.fn().mockResolvedValue({ sid: CALL_SID }),
    voiceUrlFor: vi.fn().mockResolvedValue(null),
    endCall: vi.fn().mockResolvedValue({}),
  };
  const routes: Array<{ method: string; path: string; handlers: RequestHandler[] }> = [];
  const app = Object.fromEntries(["get", "post"].map((method) => [method,
    (path: string, ...handlers: RequestHandler[]) => routes.push({ method, path, handlers }),
  ])) as unknown as Express;
  const bot = store.mint(["fleet:read", "operator:call"]);
  mountPluginApi(app, { store, outboundStore: outbound, agents: { getAllAgents: () => [] }, env,
    liveCalls, liveCallSender: sender, smsSender: { send: vi.fn() } } as never);
  async function api(path: string, body: unknown) {
    const pathname = `/api/plugin/v1${path}`;
    const route = routes.find((r) => r.method === "post" && r.path === pathname)!;
    const req = { method: "POST", route: { path: pathname }, path: pathname, originalUrl: pathname, params: {}, query: {}, body,
      headers: { authorization: `Bearer ${bot.plaintext}` } };
    const out = { status: 200, body: undefined as any };
    const res = { setHeader() {}, status(code: number) { out.status = code; return res; }, json(value: unknown) { out.body = value; return res; } };
    async function run(index: number): Promise<void> {
      const handler = route.handlers[index];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as never, res as never, () => { next = run(index + 1); });
      await next;
    }
    await run(0);
    return out;
  }
  const prepared = await api("/prepare_operator_call", { phone: PHONE, purpose: "Run the benchmark.", ...payload });
  expect(prepared.status).toBe(201);
  const opening = prepared.body.opening as { source: string; text: string };
  const committed = await api("/commit_call_live", { confirmToken: prepared.body.confirmToken });
  expect(committed.status).toBe(200);

  const provider = new FakeProvider();
  const server = http.createServer();
  const config: LaneConfig = { id: OPERATOR_SLUG, enabled: true, agentType: "outbound", outbound: operatorLinePolicy,
    factory: createOperatorLineAgent as unknown as LaneConfig["factory"] };
  mountVoiceRuntime(app, server, {
    env, liveCalls, laneSource: { getAgentConfig: (slug) => slug === OPERATOR_SLUG ? config : undefined },
    operatorInboundStore: store, outboundStore: outbound, createTransport: () => provider,
    fetchPrecontext: vi.fn().mockResolvedValue(null), resolveGreeting: vi.fn().mockResolvedValue(null), startRecording: vi.fn().mockResolvedValue("started"),
    persistCall: vi.fn().mockResolvedValue(true), sweepCall: vi.fn().mockResolvedValue(undefined),
    sweepPcpFloor: vi.fn().mockResolvedValue(undefined), fileSetupFailure: vi.fn().mockResolvedValue(undefined),
    gradeCall: vi.fn().mockResolvedValue(undefined), openCallRow: async () => undefined, stampBuild: async () => true,
    persistTurns: async () => {}, logCallerAudio: async () => {},
  });

  // Twilio answers the URL the commit dialled with.
  const url = new URL(sender.createCall.mock.calls[0][0].url);
  const body = { CallSid: CALL_SID, From: FROM, To: PHONE, AnsweredBy: "human" };
  const route = routes.find((r) => r.method === "post" && r.path === "/voice/:slug")!;
  const answer = { body: "" };
  const res = { status() { return res; }, type() { return res; }, send(text: string) { answer.body = text; return res; } };
  await route.handlers[0]({ params: { slug: OPERATOR_SLUG }, query: Object.fromEntries(url.searchParams), body,
    originalUrl: url.pathname + url.search,
    headers: { host: "fleet.example", "x-forwarded-proto": "https",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH, url.toString(), body) } } as never, res as never, () => {});
  const token = answer.body.match(/name="token" value="([^"]+)"/)![1];

  const socket = new FakeTwilioSocket();
  cleanups.push(() => socket.close());
  server.emit("upgrade", { url: "/voice/stream" }, socket, Buffer.alloc(0));
  socket.frame({ event: "start", streamSid: "MZ-test", start: { streamSid: "MZ-test", callSid: CALL_SID,
    customParameters: { callSid: CALL_SID, token, host: "fleet.example" } } });
  await vi.waitFor(() => expect(provider.sent.some((event) => event.type === "session.update")).toBe(true));
  provider.emit({ type: "session.updated" });
  await vi.waitFor(() => expect(provider.sent.some((event) => event.type === "conversation.item.create")).toBe(true));
  return {
    opening,
    instructions: provider.sent.find((event) => event.type === "session.update").session.instructions as string,
    spoken: provider.sent.find((event) => event.type === "conversation.item.create").item.content[0].text as string,
  };
}

describe("v159: the operator script reaches the wire", () => {
  it("speaks the script's Opening line and puts the script in the session instructions", async () => {
    const { instructions, spoken, opening } = await placeCall({ callerScript: SCRIPT });
    expect(opening).toEqual({ source: "callerScript", text: OPENING });
    expect(spoken).toBe(OPENING);
    expect(instructions).toContain("You are Benchmark Tester");
    expect(instructions).toContain(OPENING);
    expect(instructions).not.toContain(OPERATOR_GREETING);
    expect(instructions).not.toContain("You are Grok Bot");
  });

  it("an explicit openingLine wins over the script", async () => {
    const { instructions, spoken } = await placeCall({ callerScript: SCRIPT, openingLine: "Hey, quick test call." });
    expect(spoken).toBe("Hey, quick test call.");
    expect(instructions).toContain("Hey, quick test call.");
  });

  it("with no script the default greeting stands", async () => {
    const { spoken, opening } = await placeCall({});
    expect(opening).toEqual({ source: "default", text: OPERATOR_GREETING });
    expect(spoken).toBe(OPERATOR_GREETING);
  });
    expect(isTestCall({ callSid: CALL_SID }, {})).toBe(true);
  });
});
