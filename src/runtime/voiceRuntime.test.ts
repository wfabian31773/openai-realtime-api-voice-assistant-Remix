/**
 * One whole call, end to end, with no phone and no xAI account.
 *
 * This is the test the standing rule asks for: "a failing call goes into a
 * replay test BEFORE any code changes — show red then green offline; do not
 * ask him to dial to find out whether a guess was right." Everything below
 * the Twilio socket and above the Grok socket is real code — the webhook,
 * the token gate, the lane resolution, the agent binding, the session's
 * wire handling, the bridge's barge-in and teardown, the outcome the
 * post-stream TwiML reads. Only the two sockets are fakes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { z } from "zod";
import twilio from "twilio";
import WebSocket from "ws";
import { mountVoiceRuntime, type RuntimeTransport } from "./voiceRuntime";
import { CallSessionRegistry } from "./sessionRegistry";
import type { GrokServerEvent } from "./wireTypes";
import type { LaneConfig, LaneSource } from "./laneRegistry";

const AUTH_TOKEN = "test-auth-token";
const ENV = {
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  XAI_API_KEY: "xai-key",
  DATABASE_URL: "postgres://x",
};

/** A fake Grok socket: records what the runtime sends and lets the test
 * play server events back in wire order. */
class FakeGrokTransport implements RuntimeTransport {
  public sent: Array<Record<string, unknown>> = [];
  public closed = false;
  private onMsg: ((data: string) => void) | null = null;
  private onErr: ((err: Error) => void) | null = null;
  private onCls: (() => void) | null = null;

  /** True when connect() ran AFTER close(). A `closed` flag alone cannot
   * see this: teardown closes the transport, then a connect behind it
   * opens a provider socket with every timer already cleared and nobody
   * owning it. The order is the defect, so the fake records the order. */
  public connectedAfterClose = false;

  /** Set to stall: connect resolves but the handshake never completes,
   * which is the failure the setup deadline exists for. */
  public stallHandshake = false;

  async connect(): Promise<void> {
    if (this.closed) this.connectedAfterClose = true;
    if (this.stallHandshake) return;
    // The handshake the real wire performs on open.
    queueMicrotask(() => this.emit({ type: "session.created" } as GrokServerEvent));
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(cb: (data: string) => void): void {
    this.onMsg = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.onErr = cb;
  }
  onClose(cb: () => void): void {
    this.onCls = cb;
  }
  emit(event: GrokServerEvent): void {
    this.onMsg?.(JSON.stringify(event));
  }
  emitError(err: Error): void {
    this.onErr?.(err);
  }
  emitClose(): void {
    this.onCls?.();
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((e) => e.type === type);
  }
}

const filedTickets: Array<Record<string, unknown>> = [];

function laneSource(over: Partial<LaneConfig> = {}): LaneSource {
  const config: LaneConfig = {
    id: "optical",
    enabled: true,
    voice: "sage",
    version: "v1.4.0",
    factory: (async () => ({
      instructions: "You are the optical queue agent. Take the request and file it.",
      tools: [
        {
          name: "create_ticket",
          description: "File a callback request.",
          parameters: z.object({ reason: z.string(), callback_number: z.string() }),
          invoke: async (_ctx: unknown, input: string) => {
            filedTickets.push(JSON.parse(input));
            return { ticket_number: "VA-51121" };
          },
        },
      ],
    })) as unknown as LaneConfig["factory"],
    ...over,
  };
  return { getAgentConfig: (id) => (id === config.id ? config : undefined) };
}

interface Harness {
  openedRows: Array<Record<string, unknown>>;
  persisted: Array<Record<string, unknown>>;
  base: string;
  wsUrl: string;
  registry: CallSessionRegistry;
  transports: FakeGrokTransport[];
  close: () => Promise<void>;
}

const open: Harness[] = [];
/** Every client socket a test opened. An upgraded WebSocket is detached
 * from the HTTP server, so closeAllConnections() cannot reach it and
 * server.close() would wait on it forever. */
const clients: WebSocket[] = [];

async function harness(
  over: {
    laneSource?: LaneSource;
    stallHandshake?: boolean;
    providerSetupDeadlineMs?: number;
    fetchPrecontext?: (phone: string) => Promise<unknown>;
    openCallRow?: (row: unknown) => Promise<void>;
  } = {},
): Promise<Harness> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const server = http.createServer(app);
  const registry = new CallSessionRegistry();
  const transports: FakeGrokTransport[] = [];
  const openedRows: Array<Record<string, unknown>> = [];
  const persisted: Array<Record<string, unknown>> = [];
  mountVoiceRuntime(app, server, {
    env: ENV,
    // Short so the deadline test does not wait on a production-length one.
    streamClaimDeadlineMs: 300,
    registry,
    laneSource: over.laneSource ?? laneSource(),
    createTransport: () => {
      const t = new FakeGrokTransport();
      t.stallHandshake = over.stallHandshake ?? false;
      transports.push(t);
      return t;
    },
    providerSetupDeadlineMs: over.providerSetupDeadlineMs,
    fetchPrecontext: over.fetchPrecontext,
    openCallRow:
      over.openCallRow ??
      (async (row) => void openedRows.push(row as unknown as Record<string, unknown>)),
    persistCall: async (record) => {
      persisted.push(record as unknown as Record<string, unknown>);
      return true;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const h: Harness = {
    openedRows,
    persisted,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/voice/stream`,
    registry,
    transports,
    close: () =>
      new Promise<void>((resolve) => {
        // A media stream left open would hold server.close() forever —
        // which is exactly what a real hung call does, and not what this
        // hook is for.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (clients.length) clients.pop()!.terminate();
  while (open.length) await open.pop()!.close();
  filedTickets.length = 0;
});

/** POST a genuinely signed Twilio webhook. */
async function post(
  h: Harness,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const url = `${h.base}${path}`;
  const sig = (
    twilio as unknown as {
      getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
    }
  ).getExpectedTwilioSignature(AUTH_TOKEN, url, body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": sig,
      "x-forwarded-proto": "http",
    },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, text: await res.text() };
}

function tokenFrom(twiml: string): string {
  return twiml.match(/name="token" value="([^"]+)"/)![1];
}

/** Open the media stream and send the start frame Twilio would send. */
async function openStream(
  h: Harness,
  callSid: string,
  token: string,
): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(h.wsUrl);
  clients.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: {
        streamSid: "MZ1",
        callSid,
        customParameters: { callSid, token },
      },
    }),
  );
  return { ws, frames };
}

/** Let the event loop drain — the runtime builds the agent asynchronously. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 5));
}

describe("one whole call, end to end, offline", () => {
  it("answers, configures the session with the agent's own prompt and tools, and files a ticket", async () => {
    const h = await harness();

    // 1. Twilio's Voice webhook.
    const answered = await post(h, "/voice/optical", {
      CallSid: "CA1",
      From: "+15551234567",
      To: "+15559876543",
    });
    expect(answered.status).toBe(200);
    expect(answered.text).toContain("<Connect><Stream");

    // 2. The media stream, with the token the webhook minted.
    const { ws } = await openStream(h, "CA1", tokenFrom(answered.text));
    await settle();
    expect(h.transports).toHaveLength(1);
    const grok = h.transports[0];

    // 2b. The call's row exists BEFORE any tool can fire — the agents' own
    //     telemetry updates it by call_sid and a flush landing on no row
    //     marks itself done anyway, losing the timeline for good.
    expect(h.openedRows).toHaveLength(1);
    expect(h.openedRows[0]).toMatchObject({
      callSid: "CA1",
      status: "in_progress",
      agentUsed: "optical",
      direction: "inbound",
    });

    // 3. The session handshake: config BEFORE any audio (the rule that
    //    cost a whole line when it was the other way round).
    grok.emit({ type: "session.created" } as GrokServerEvent);
    await settle();
    const update = grok.ofType("session.update")[0] as {
      session: { instructions: string; voice: string; tools: Array<{ name: string }> };
    };
    // The lane registers `voice: 'sage'` — an OpenAI voice. Grok must be
    // configured with a Grok voice, or session setup fails on every lane.
    expect(update.session.voice).not.toBe("sage");
    expect(update.session.voice).toBe("eve");
    // The agent's own words, and the practice knowledge in front of them.
    expect(update.session.instructions).toContain("You are the optical queue agent");
    expect(update.session.instructions).toContain("YOU WORK FOR AZUL VISION");
    // The agent's own tool, with its own schema and no strict mode.
    expect(update.session.tools.map((t) => t.name)).toEqual(["create_ticket"]);
    expect(JSON.stringify(update.session.tools)).not.toContain('"strict"');

    // 4. Caller audio reaches Grok untouched.
    ws.send(
      JSON.stringify({ event: "media", streamSid: "MZ1", media: { payload: "QUJDRA==" } }),
    );
    await settle();
    grok.emit({ type: "session.updated" } as GrokServerEvent);
    await settle();
    expect(grok.ofType("input_audio_buffer.append").map((e) => e.audio)).toContain("QUJDRA==");

    // The opening turn is asked for with NO per-response instructions, so
    // the caller's first sentence is generated from the session's
    // instructions — the agent's prompt with the knowledge pack in front.
    // `response.instructions` overrides those, so a single word here would
    // silently switch both off for exactly that sentence.
    const opening = grok.ofType("response.create") as Array<{ response: Record<string, unknown> }>;
    expect(opening).toHaveLength(1);
    expect(opening[0].response).toEqual({});

    // 5. The model calls the agent's tool, and the agent's own code runs.
    grok.emit({ type: "response.created" } as GrokServerEvent);
    grok.emit({
      type: "response.function_call_arguments.done",
      call_id: "fc1",
      name: "create_ticket",
      arguments: JSON.stringify({ reason: "lens remake", callback_number: "+15551234567" }),
    } as GrokServerEvent);
    await settle();
    expect(filedTickets).toEqual([
      { reason: "lens remake", callback_number: "+15551234567" },
    ]);
    // Every tool call is answered, or the turn stalls forever.
    const answer = grok.ofType("conversation.item.create").pop() as {
      item: { type: string; call_id: string; output: string };
    };
    expect(answer.item.type).toBe("function_call_output");
    expect(answer.item.call_id).toBe("fc1");
    // `ok` is the wire layer's own flag; the tool's answer rides beside it.
    expect(JSON.parse(answer.item.output)).toEqual({ ok: true, ticket_number: "VA-51121" });

    ws.close();
    await settle();
  });

  it("plays the agent's audio to the caller and records what was actually heard", async () => {
    const h = await harness();
    const answered = await post(h, "/voice/optical", {
      CallSid: "CA2",
      From: "+15551234567",
      To: "+15559876543",
    });
    const { ws, frames } = await openStream(h, "CA2", tokenFrom(answered.text));
    await settle();
    const grok = h.transports[0];
    grok.emit({ type: "session.created" } as GrokServerEvent);
    grok.emit({ type: "session.updated" } as GrokServerEvent);
    grok.emit({ type: "response.created" } as GrokServerEvent);
    grok.emit({
      type: "response.output_audio_transcript.delta",
      delta: "Thanks for calling Azul Vision optical.",
    } as GrokServerEvent);
    grok.emit({
      type: "response.output_audio.delta",
      delta: Buffer.alloc(800, 0x7f).toString("base64"),
    } as GrokServerEvent);
    await settle();

    const media = frames.filter((f) => f.event === "media");
    expect(media).toHaveLength(1);
    expect((media[0] as { media: { payload: string } }).media.payload).toBe(
      Buffer.alloc(800, 0x7f).toString("base64"),
    );

    grok.emit({
      type: "response.output_audio_transcript.done",
      transcript: "Thanks for calling Azul Vision optical.",
    } as GrokServerEvent);
    await settle();
    const mark = frames.find((f) => f.event === "mark") as { mark: { name: string } };
    expect(mark).toBeTruthy();

    // Twilio confirms the audio played. Only now is the line committed.
    ws.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: mark.mark.name } }));
    await settle();
    ws.send(JSON.stringify({ event: "stop", streamSid: "MZ1" }));
    await settle();
    expect(h.registry.consumeOutcome("CA2")).toBe("caller_hangup");
  });

  it("barges in with BOTH signals when the caller talks over the agent", async () => {
    const h = await harness();
    const answered = await post(h, "/voice/optical", {
      CallSid: "CA3",
      From: "+1",
      To: "+2",
    });
    const { ws, frames } = await openStream(h, "CA3", tokenFrom(answered.text));
    await settle();
    const grok = h.transports[0];
    grok.emit({ type: "session.created" } as GrokServerEvent);
    grok.emit({ type: "session.updated" } as GrokServerEvent);
    grok.emit({ type: "response.created" } as GrokServerEvent);
    grok.emit({
      type: "response.output_audio.delta",
      delta: Buffer.alloc(400, 0x7f).toString("base64"),
    } as GrokServerEvent);
    await settle();
    grok.emit({ type: "input_audio_buffer.speech_started" } as GrokServerEvent);
    await settle();

    expect(grok.ofType("response.cancel")).toHaveLength(1);
    expect(frames.filter((f) => f.event === "clear")).toHaveLength(1);
    ws.close();
    await settle();
  });

  it("survives Grok rejecting the cancel — the failure that used to hang up on a healthy caller", async () => {
    const h = await harness();
    const answered = await post(h, "/voice/optical", { CallSid: "CA4", From: "+1", To: "+2" });
    const { ws } = await openStream(h, "CA4", tokenFrom(answered.text));
    await settle();
    const grok = h.transports[0];
    grok.emit({ type: "session.created" } as GrokServerEvent);
    grok.emit({ type: "session.updated" } as GrokServerEvent);
    grok.emit({ type: "response.created" } as GrokServerEvent);
    grok.emit({
      type: "response.output_audio.delta",
      delta: Buffer.alloc(400, 0x7f).toString("base64"),
    } as GrokServerEvent);
    await settle();
    grok.emit({ type: "input_audio_buffer.speech_started" } as GrokServerEvent);
    await settle();
    // Grok finished the response first, so it rejects the cancel. That is
    // the missing response.done, not a fault.
    grok.emit({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "cancellation failed: no active response found",
      },
    } as GrokServerEvent);
    await settle();
    // The call is still up: no outcome recorded, socket not closed.
    expect(h.registry.get("CA4")!.outcome).toBeNull();
    ws.close();
    await settle();
  });

  it("abandons setup when the caller hangs up while the agent is still being built", async () => {
    // Building an agent takes real time. If Twilio disconnects during it,
    // the continuation must not go on to open a Grok session against a
    // socket that is already gone — that is a provider connection nobody
    // owns and nobody closes (Codex review, PR #227).
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LaneSource = {
      getAgentConfig: () => ({
        id: "optical",
        enabled: true,
        factory: (async () => {
          await blocked;
          return {
            instructions: "You are the optical queue agent.",
            tools: [],
          };
        }) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({ laneSource: slow });
    const answered = await post(h, "/voice/optical", { CallSid: "CA8", From: "+1", To: "+2" });
    const { ws } = await openStream(h, "CA8", tokenFrom(answered.text));
    await settle(2);
    // The caller hangs up mid-setup.
    ws.close();
    await settle(4);
    release();
    await settle(6);
    expect(h.transports).toHaveLength(0);
    expect(h.registry.get("CA8")?.outcome ?? h.registry.consumeOutcome("CA8")).toBe(
      "caller_hangup",
    );
  });

  it("a stop frame queued during setup closes the provider socket instead of orphaning it", async () => {
    // Twilio can send `stop` while the agent is still being built. That
    // frame is held, and replaying it tears the bridge down — so it must be
    // replayed only AFTER the provider socket exists, or teardown closes a
    // transport that is then opened behind it and left live with every
    // timer already cleared (Codex review, PR #227).
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LaneSource = {
      getAgentConfig: () => ({
        id: "optical",
        enabled: true,
        agentType: "inbound",
        factory: (async () => {
          await blocked;
          return { instructions: "You are the optical queue agent.", tools: [] };
        }) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({ laneSource: slow });
    const answered = await post(h, "/voice/optical", { CallSid: "CA9", From: "+1", To: "+2" });
    const { ws } = await openStream(h, "CA9", tokenFrom(answered.text));
    await settle(2);
    ws.send(JSON.stringify({ event: "stop", streamSid: "MZ1" }));
    await settle(2);
    release();
    await settle(8);
    expect(h.transports).toHaveLength(1);
    // Opened, then closed by teardown — and crucially NOT opened behind a
    // teardown that had already closed it.
    expect(h.transports[0].connectedAfterClose).toBe(false);
    expect(h.transports[0].closed).toBe(true);
    expect(h.registry.consumeOutcome("CA9")).toBe("caller_hangup");
  });

  it("refuses a lane whose factory contract the runtime does not model", async () => {
    // createAfterHoursAgent(handoff, recordPatientInfoCallback, metadata) —
    // calling it with the uniform two-argument shape puts the metadata in
    // the callback slot, so the agent loses caller context and later tries
    // to CALL that object (Codex review, PR #227).
    const afterHours: LaneSource = {
      getAgentConfig: () => ({
        id: "after-hours",
        enabled: true,
        agentType: "inbound",
        // A perfectly good agent: the ONLY reason this lane is refused is
        // its factory's argument layout. A stub returning undefined would
        // fail binding anyway and prove nothing about the contract check.
        factory: (async () => ({
          instructions: "You are the after-hours agent.",
          tools: [],
        })) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({ laneSource: afterHours });
    const answered = await post(h, "/voice/after-hours", {
      CallSid: "CA10",
      From: "+1",
      To: "+2",
    });
    await openStream(h, "CA10", tokenFrom(answered.text));
    await settle();
    expect(h.transports).toHaveLength(0);
    const after = await post(h, "/voice/after-hours/after", { CallSid: "CA10" });
    expect(after.text).toContain("technical trouble");
  });

  it("closes a socket that never claims a stream, so an anonymous client cannot accumulate them", async () => {
    // /voice/stream accepts an upgrade before any token is seen — the gate
    // runs on the start frame. Without a deadline a remote client can open
    // sockets and send nothing, holding descriptors indefinitely (Codex
    // review, PR #227).
    const h = await harness();
    const ws = new WebSocket(h.wsUrl);
    clients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2500))]);
    expect(ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED).toBe(true);
  });

  it("gives up on a provider that connects but never completes its handshake", async () => {
    // The dead-air watchdog is armed by onConfigured, so nothing covered
    // the window before it: the caller sat in billed silence to the
    // ten-minute ceiling and it was recorded as a clean max_duration rather
    // than the provider failure it was (Codex review, PR #227).
    const h = await harness({ stallHandshake: true, providerSetupDeadlineMs: 200 });
    const answered = await post(h, "/voice/optical", { CallSid: "CA11", From: "+1", To: "+2" });
    await openStream(h, "CA11", tokenFrom(answered.text));
    await settle(2);
    expect(h.transports).toHaveLength(1);
    expect(h.registry.get("CA11")?.outcome ?? null).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    expect(h.registry.consumeOutcome("CA11")).toBe("provider_failure");
  });

  it("does NOT fire the setup deadline on a healthy handshake", async () => {
    const h = await harness({ providerSetupDeadlineMs: 200 });
    const answered = await post(h, "/voice/optical", { CallSid: "CA12", From: "+1", To: "+2" });
    await openStream(h, "CA12", tokenFrom(answered.text));
    await settle(2);
    h.transports[0].emit({ type: "session.created" } as GrokServerEvent);
    h.transports[0].emit({ type: "session.updated" } as GrokServerEvent);
    await new Promise((r) => setTimeout(r, 350));
    expect(h.registry.get("CA12")?.outcome ?? null).toBeNull();
  });

  it("hands the agent the caller-ID pre-context, bounded so it cannot hold the call open", async () => {
    // The queue agents choose their opening from metadata.precontext: with
    // a unique match they confirm rather than ask cold, which is what the
    // SIP path already gives all four lanes.
    const seen: Array<Record<string, unknown>> = [];
    const laneSourceCapturing: LaneSource = {
      getAgentConfig: () => ({
        id: "optical",
        enabled: true,
        agentType: "inbound",
        factory: ((_h: unknown, metadata: Record<string, unknown>) => {
          seen.push(metadata);
          return Promise.resolve({ instructions: "optical agent", tools: [] });
        }) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({
      laneSource: laneSourceCapturing,
      fetchPrecontext: async () => ({ matched: true, firstName: "Wayne" }),
    });
    const answered = await post(h, "/voice/optical", {
      CallSid: "CA13",
      From: "+15551234567",
      To: "+2",
    });
    await openStream(h, "CA13", tokenFrom(answered.text));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].precontext).toEqual({ matched: true, firstName: "Wayne" });
  });

  it("proceeds without pre-context rather than waiting on a slow lookup", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const laneSourceCapturing: LaneSource = {
      getAgentConfig: () => ({
        id: "optical",
        enabled: true,
        agentType: "inbound",
        factory: ((_h: unknown, metadata: Record<string, unknown>) => {
          seen.push(metadata);
          return Promise.resolve({ instructions: "optical agent", tools: [] });
        }) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({
      laneSource: laneSourceCapturing,
      // Never settles: a caller must not listen to silence for it.
      fetchPrecontext: () => new Promise(() => {}),
    });
    const answered = await post(h, "/voice/optical", { CallSid: "CA14", From: "+1", To: "+2" });
    await openStream(h, "CA14", tokenFrom(answered.text));
    await new Promise((r) => setTimeout(r, 1800));
    expect(seen).toHaveLength(1);
    expect(seen[0].precontext).toBeUndefined();
  });

  it("does not let a wedged database hold the caller in silence", async () => {
    // openRuntimeCall is documented as never blocking the call, but an
    // awaited insert that never settles blocks setup before the bridge
    // exists and before the provider deadline is armed — try/catch only
    // covers rejection (Codex review, PR #227).
    const h = await harness({ openCallRow: () => new Promise<void>(() => {}) });
    const answered = await post(h, "/voice/optical", { CallSid: "CA15", From: "+1", To: "+2" });
    await openStream(h, "CA15", tokenFrom(answered.text));
    await new Promise((r) => setTimeout(r, 2500));
    // Setup went on without the row rather than waiting on it.
    expect(h.transports).toHaveLength(1);
  });

  it("finalizes a row it opened when the caller hangs up during setup", async () => {
    // The row is opened before the socketGone check, so an early hangup
    // used to leave it `in_progress` until the 30-minute stale sweep
    // classified it stale_reaped instead of caller_hangup.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LaneSource = {
      getAgentConfig: () => ({
        id: "optical",
        enabled: true,
        agentType: "inbound",
        factory: (async () => {
          await blocked;
          return { instructions: "You are the optical queue agent.", tools: [] };
        }) as unknown as LaneConfig["factory"],
      }),
    };
    const h = await harness({ laneSource: slow });
    const answered = await post(h, "/voice/optical", { CallSid: "CA16", From: "+1", To: "+2" });
    const { ws } = await openStream(h, "CA16", tokenFrom(answered.text));
    await settle(2);
    ws.close();
    await settle(4);
    release();
    await settle(8);
    expect(h.openedRows).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({ callSid: "CA16", outcome: "caller_hangup" });
  });

  it("refuses a stream whose token was not minted by the webhook", async () => {
    const h = await harness();
    await post(h, "/voice/optical", { CallSid: "CA5", From: "+1", To: "+2" });
    const { ws } = await openStream(h, "CA5", "not-the-token");
    await settle();
    // No session was ever opened for it.
    expect(h.transports).toHaveLength(0);
    expect(ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED).toBe(true);
  });

  it("refuses a SECOND stream for a call that already has one", async () => {
    const h = await harness();
    const answered = await post(h, "/voice/optical", { CallSid: "CA6", From: "+1", To: "+2" });
    const token = tokenFrom(answered.text);
    await openStream(h, "CA6", token);
    await settle();
    expect(h.transports).toHaveLength(1);
    await openStream(h, "CA6", token);
    await settle();
    expect(h.transports).toHaveLength(1);
  });

  it("ends a call whose lane turns out to be disabled, and explains it to the caller", async () => {
    const h = await harness({ laneSource: laneSource({ enabled: false }) });
    const answered = await post(h, "/voice/optical", { CallSid: "CA7", From: "+1", To: "+2" });
    // The webhook accepted an unseen slug rather than awaiting the agent
    // tree on Twilio's clock; the stream is where it is resolved.
    expect(answered.text).toContain("<Stream");
    await openStream(h, "CA7", tokenFrom(answered.text));
    await settle();
    expect(h.transports).toHaveLength(0);
    const after = await post(h, "/voice/optical/after", { CallSid: "CA7" });
    expect(after.text).toContain("technical trouble");
  });

  it("serves the deploy marker, which is how a stale build is caught", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/voice/health`);
    const body = (await res.json()) as {
      marker: string;
      knowledgePack: string;
      liveReady: boolean;
      missing: string[];
    };
    expect(body.marker).toMatch(/^voice-runtime-/);
    expect(body.liveReady).toBe(true);
    expect(body.missing).toEqual([]);
    // The shared cache prefix's version, so a cache-rate change can be
    // attributed to a prefix change instead of guessed at.
    expect(body.knowledgePack).toMatch(/^v\d+$/);
  });
});
