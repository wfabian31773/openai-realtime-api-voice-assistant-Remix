/**
 * v272: xAI's conversation id is kept for every socket, so a dropped call
 * can be handed to xAI support (ticket T-L27235) by the id they look it up by.
 *
 * Before: `session.created` was read for `conversation.id`, which it never
 * carries, and `conversation.created` was ignored. The three drops of
 * 2026-11-25 03:01..03:18 UTC (CA598d6de517249b2c85874c961260cb0e,
 * CA3aaf9d0a6eeb2dd227364c9e4d88c596, CA638dc9053463a6f44b8e0e2d6b7eeb41) all
 * logged `[SESSION] created session=none conversation=none`.
 *
 * The event shapes below are xAI's own, read off a test socket on 2026-11-25
 * (ids replaced).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import {
  GrokVoiceSession,
  WebSocketGrokTransport,
  buildSessionConfig,
  providerIdText,
  providerIdsInFrame,
} from "./grokSession";
import type { GrokTransport } from "./grokSession";
import { loadGrokRuntimeVoiceConfig } from "./config";
import { providerCloseEvent } from "./providerCloseTelemetry";

const XAI_SESSION_CREATED = {
  type: "session.created",
  event_id: "evt-1",
  session: { id: "sess_abc123", type: "realtime", object: "realtime.session" },
};
const XAI_CONVERSATION_CREATED = {
  type: "conversation.created",
  event_id: "evt-2",
  conversation: { id: "conv_def456", object: "realtime.conversation" },
};

class IdTransport implements GrokTransport {
  public ids: Array<{ sessionId?: unknown; conversationId?: unknown }> = [];
  private messageHandler: ((data: string) => void) | null = null;
  send(): void {}
  close(): void {}
  onMessage(cb: (data: string) => void): void {
    this.messageHandler = cb;
  }
  onError(): void {}
  onClose(): void {}
  upgradeHeaders() {
    return { xTraceId: "trace-1", cfRay: "ray-1" };
  }
  noteProviderIds(ids: { sessionId?: unknown; conversationId?: unknown }): void {
    this.ids.push(ids);
  }
  emit(event: unknown): void {
    this.messageHandler?.(JSON.stringify(event));
  }
}

function makeSession() {
  const transport = new IdTransport();
  const config = loadGrokRuntimeVoiceConfig({});
  const session = new GrokVoiceSession(
    transport,
    buildSessionConfig(config, "instructions", []),
    { onToolCall: () => {} },
  );
  return { transport, session };
}

const servers: WebSocketServer[] = [];

afterEach(async () => {
  while (servers.length) {
    const wss = servers.pop()!;
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
  vi.restoreAllMocks();
});

async function server(onConnect: (socket: WebSocket) => void): Promise<string> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", onConnect);
  await new Promise<void>((r) => wss.once("listening", () => r()));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`;
}

describe("the session reads xAI's ids where xAI puts them", () => {
  it("takes the session id from session.created's session", () => {
    const { transport, session } = makeSession();
    transport.emit(XAI_SESSION_CREATED);
    expect(session.getSessionId()).toBe("sess_abc123");
    expect(transport.ids).toContainEqual({ sessionId: "sess_abc123" });
  });

  it("takes the conversation id from conversation.created", () => {
    const { transport } = makeSession();
    transport.emit(XAI_SESSION_CREATED);
    transport.emit(XAI_CONVERSATION_CREATED);
    expect(transport.ids).toContainEqual({ conversationId: "conv_def456" });
  });

  it("logs the conversation id beside the session id and the upgrade's trace id", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { transport } = makeSession();
    transport.emit(XAI_SESSION_CREATED);
    transport.emit(XAI_CONVERSATION_CREATED);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[SESSION] created session=sess_abc123 trace=trace-1");
    expect(lines).toContain(
      "[SESSION] conversation=conv_def456 session=sess_abc123 trace=trace-1",
    );
  });

  it("keeps a session that never names an id working, and reads none", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created" });
    transport.emit({ type: "conversation.created" });
    expect(session.getState()).toBe("connected");
    expect(session.getSessionId()).toBeNull();
    expect(transport.ids).toEqual([{ sessionId: null }, { conversationId: null }]);
  });

  it("never keeps an id that is not text", () => {
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", session: { id: { nested: true } } });
    transport.emit({ type: "conversation.created", conversation: { id: ["x"] } });
    expect(session.getSessionId()).toBeNull();
    expect(transport.ids).toEqual([{ sessionId: null }, { conversationId: null }]);
  });
});

describe("the transport carries the ids onto the close row and the close line", () => {
  it("returns both ids in its close diagnostics", () => {
    const t = new WebSocketGrokTransport("key", "model");
    t.noteProviderIds({ sessionId: "sess_abc123" });
    t.noteProviderIds({ conversationId: "conv_def456" });
    const d = t.closeDiagnostics();
    expect(d.providerSessionId).toBe("sess_abc123");
    expect(d.providerConversationId).toBe("conv_def456");
  });

  it("does not let a later empty note erase an id it holds", () => {
    const t = new WebSocketGrokTransport("key", "model");
    t.noteProviderIds({ conversationId: "conv_def456" });
    t.noteProviderIds({ conversationId: null, sessionId: undefined });
    expect(t.closeDiagnostics().providerConversationId).toBe("conv_def456");
  });

  it("caps an id at 100 characters", () => {
    const t = new WebSocketGrokTransport("key", "model");
    t.noteProviderIds({ conversationId: "c".repeat(300) });
    expect(t.closeDiagnostics().providerConversationId!.length).toBeLessThanOrEqual(101);
  });

  it("reads none before xAI has named either id", () => {
    const d = new WebSocketGrokTransport("key", "model").closeDiagnostics();
    expect(d.providerSessionId).toBeNull();
    expect(d.providerConversationId).toBeNull();
  });

  it("puts the conversation id on the provider_close_summary row", () => {
    const t = new WebSocketGrokTransport("key", "model");
    t.noteProviderIds({ sessionId: "sess_abc123", conversationId: "conv_def456" });
    const row = providerCloseEvent("provider_failure", t.closeDiagnostics(), { uptimeSec: 1 });
    expect(row?.data).toMatchObject({
      providerSessionId: "sess_abc123",
      providerConversationId: "conv_def456",
    });
  });

  it("names the conversation id on the [SESSION] closed line", () => {
    const src = readFileSync(join(__dirname, "grokSession.ts"), "utf8");
    const closeLine = src.slice(src.indexOf("private closeLine(): string"));
    expect(closeLine.slice(0, 1500)).toContain("`conversation=${d.providerConversationId ?? \"?\"}`");
  });
});

describe("the ids are the socket's, read before the session takes the buffer (#521 review)", () => {
  it("keeps both ids when xAI closes before commitBuffered() ever runs", async () => {
    const url = await server((socket) => {
      socket.send(JSON.stringify(XAI_SESSION_CREATED));
      socket.send(JSON.stringify(XAI_CONVERSATION_CREATED));
      setTimeout(() => socket.terminate(), 50);
    });
    const t = new WebSocketGrokTransport("key", "model", url);
    const closed = new Promise<void>((r) => t.onClose(() => r()));
    await t.connect();
    await closed;
    // Nothing committed the buffer, so no session ever read these events.
    const d = t.closeDiagnostics();
    expect(d.providerSessionId).toBe("sess_abc123");
    expect(d.providerConversationId).toBe("conv_def456");
  });

  it("stops reading frames for ids once it holds both, so a later frame changes nothing", async () => {
    const url = await server((socket) => {
      socket.send(JSON.stringify(XAI_SESSION_CREATED));
      socket.send(JSON.stringify(XAI_CONVERSATION_CREATED));
      socket.send(JSON.stringify({ ...XAI_SESSION_CREATED, session: { id: "sess_late" } }));
      setTimeout(() => socket.terminate(), 50);
    });
    const t = new WebSocketGrokTransport("key", "model", url);
    const closed = new Promise<void>((r) => t.onClose(() => r()));
    await t.connect();
    await closed;
    expect(t.closeDiagnostics().providerSessionId).toBe("sess_abc123");
  });

  it("reads the id off session.created and conversation.created frames only", () => {
    expect(providerIdsInFrame(JSON.stringify(XAI_SESSION_CREATED))).toEqual({
      sessionId: "sess_abc123",
    });
    expect(providerIdsInFrame(JSON.stringify(XAI_CONVERSATION_CREATED))).toEqual({
      conversationId: "conv_def456",
    });
    expect(
      providerIdsInFrame(JSON.stringify({ type: "response.output_audio.delta", delta: "AAAA" })),
    ).toBeNull();
    // A transcript that only mentions the event name is not that event.
    expect(
      providerIdsInFrame(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          delta: 'said "conversation.created" aloud',
          conversation: { id: "conv_from_text" },
        }),
      ),
    ).toBeNull();
    // A quoted event name inside JSON text is escaped, so the prefilter skips
    // it; a field whose VALUE is the event name gets parsed, and the type
    // still decides.
    expect(
      providerIdsInFrame(
        JSON.stringify({
          type: "conversation.item.added",
          after: "conversation.created",
          session: { id: "sess_other" },
          conversation: { id: "conv_other" },
        }),
      ),
    ).toBeNull();
    expect(providerIdsInFrame('{"type":"conversation.created",')).toBeNull();
  });

  it("does not parse a frame that names neither event", () => {
    const parse = vi.spyOn(JSON, "parse");
    providerIdsInFrame(JSON.stringify({ type: "response.output_audio.delta", delta: "AAAA" }));
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("an id that is not text is never kept (#521 review)", () => {
  it("refuses a number or a boolean as an id", () => {
    expect(providerIdText(123)).toBeNull();
    expect(providerIdText(false)).toBeNull();
    expect(providerIdText(true)).toBeNull();
    expect(providerIdText("conv_def456")).toBe("conv_def456");
  });

  it("logs none and notes none for a numeric or boolean id from xAI", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { transport, session } = makeSession();
    transport.emit({ type: "session.created", session: { id: false } });
    transport.emit({ type: "conversation.created", conversation: { id: 123 } });
    expect(session.getSessionId()).toBeNull();
    expect(transport.ids).toEqual([{ sessionId: null }, { conversationId: null }]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("session=false") || l.includes("conversation=123"))).toBe(false);
  });

  it("keeps none on the transport for a numeric or boolean id", () => {
    const t = new WebSocketGrokTransport("key", "model");
    t.noteProviderIds({ sessionId: false, conversationId: 123 });
    const d = t.closeDiagnostics();
    expect(d.providerSessionId).toBeNull();
    expect(d.providerConversationId).toBeNull();
    expect(providerIdsInFrame(JSON.stringify({ type: "conversation.created", conversation: { id: 123 } }))).toEqual({
      conversationId: null,
    });
  });
});

describe("a reconnecting call keeps the ids of the socket in use", () => {
  it("passes the ids through the reconnect wrapper's transport", () => {
    const src = readFileSync(join(__dirname, "reconnectingSession.ts"), "utf8");
    const proxy = src.slice(src.indexOf("private guardedTransport("));
    expect(proxy.slice(0, 1500)).toContain(
      "noteProviderIds: (ids) => transport.noteProviderIds?.(ids)",
    );
  });
});
