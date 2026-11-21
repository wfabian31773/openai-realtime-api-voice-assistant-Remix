/**
 * v259: the REAL WebSocketGrokTransport against a local server, because the
 * defect is in what `ws` does and does not report. Once a connection is open,
 * `ws` 8 swallows the TCP socket's own error: a reset and an orderly close
 * both reach the WebSocket as a bare `close 1006`. Every runtime drop of
 * 2026-11-21 read exactly that. These tests prove the raw socket's signal now
 * reaches the diagnostics, and that nothing about a call does.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { GrokVoiceSession, WebSocketGrokTransport, type GrokTransport, type ProviderCloseDiagnostics } from "./grokSession";
import { resetEventLoopWatchForTests } from "./eventLoopLag";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    for (const c of s.clients) c.terminate();
    await new Promise<void>((r) => s.close(() => r()));
  }
  resetEventLoopWatchForTests();
  vi.restoreAllMocks();
});

/** A server that hands each connection to `onConnect`. */
async function server(
  onConnect: (socket: WebSocket, req: IncomingMessage) => void,
): Promise<string> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", (socket, req) => {
    socket.send(JSON.stringify({ type: "session.created" }));
    onConnect(socket, req);
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`;
}

async function open(url: string): Promise<{ t: WebSocketGrokTransport; closed: Promise<void> }> {
  const t = new WebSocketGrokTransport("key", "model", url);
  const closed = new Promise<void>((r) => t.onClose(() => r()));
  await t.connect();
  await t.waitForFirstEvent(1_000);
  return { t, closed };
}

describe("why an xAI socket ended (v259)", () => {
  it("records a TCP reset that ws reports only as close 1006", async () => {
    const url = await server((_s, req) => setTimeout(() => req.socket.resetAndDestroy(), 50));
    const { t, closed } = await open(url);
    t.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "" }));
    await closed;
    const d = t.closeDiagnostics();
    expect(d.closeCode).toBe(1006);
    expect(d.firstSignal).toBe("socket_error");
    expect(d.socketErrorCode).toBe("ECONNRESET");
    expect(d.socketEndReceived).toBe(false);
    expect(d.closedByUs).toBe(false);
    expect(d.wsErrorMessage).toBeNull();
  });

  it("records a FIN with no close frame, which also reads only as 1006", async () => {
    const url = await server((_s, req) => setTimeout(() => req.socket.end(), 50));
    const { t, closed } = await open(url);
    await closed;
    const d = t.closeDiagnostics();
    expect(d.closeCode).toBe(1006);
    expect(d.firstSignal).toBe("socket_fin");
    expect(d.socketEndReceived).toBe(true);
    expect(d.socketErrorCode).toBeNull();
  });

  it("records the peer's close frame, code and reason", async () => {
    const url = await server((s) => setTimeout(() => s.close(1001, "going away"), 50));
    const { t, closed } = await open(url);
    await closed;
    const d = t.closeDiagnostics();
    expect(d.closeCode).toBe(1001);
    expect(d.closeReason).toBe("going away");
    expect(d.closedByUs).toBe(false);
  });

  it("says when we closed it first", async () => {
    const url = await server(() => undefined);
    const { t, closed } = await open(url);
    t.close();
    await closed;
    const d = t.closeDiagnostics();
    expect(d.closedByUs).toBe(true);
    expect(d.firstSignal).toBe("client_close");
  });

  it("times the last event each way and the time open, and carries the peer address", async () => {
    const url = await server((_s, req) => setTimeout(() => req.socket.resetAndDestroy(), 120));
    const { t, closed } = await open(url);
    t.send("{}");
    await closed;
    const d = t.closeDiagnostics();
    expect(d.openForMs).toBeGreaterThanOrEqual(100);
    expect(d.msSinceServerEvent).not.toBeNull();
    expect(d.msSinceClientSend).not.toBeNull();
    expect(d.msSinceClientSend!).toBeLessThanOrEqual(d.openForMs!);
    expect(d.remoteAddress).toBe("127.0.0.1");
    expect(d.bufferedAmount).toBe(0);
  });

  it("counts the sockets open in this process when one closes, and uncounts a closed one", async () => {
    const resets: Array<() => void> = [];
    const url = await server((_s, req) => resets.push(() => req.socket.resetAndDestroy()));
    const a = await open(url);
    const b = await open(url);
    resets.forEach((r) => r());
    await Promise.all([a.closed, b.closed]);
    const counts = [a.t.closeDiagnostics().openSockets, b.t.closeDiagnostics().openSockets].sort();
    expect(counts).toEqual([1, 2]);
    // Both are gone: a new socket sees only itself.
    const c = await open(url);
    resets[2]();
    await c.closed;
    expect(c.t.closeDiagnostics().openSockets).toBe(1);
  });

  it("uncounts a socket the first-event retry detached, whose close never fires", async () => {
    const resets: Array<() => void> = [];
    const url = await server((_s, req) => resets.push(() => req.socket.resetAndDestroy()));
    const stalled = await open(url);
    stalled.t.detachAndClose();
    expect(stalled.t.closeDiagnostics()).toMatchObject({ firstSignal: "client_close", closedByUs: true });
    const live = await open(url);
    resets[1]();
    await live.closed;
    expect(live.t.closeDiagnostics().openSockets).toBe(1);
  });

  it("records a fatal provider error's type and code from the session, never its message", async () => {
    const said = "the caller said something private";
    const url = await server((s) =>
      setTimeout(
        () =>
          s.send(
            JSON.stringify({ type: "error", error: { type: "server_error", code: "internal", message: said } }),
          ),
        50,
      ),
    );
    const t = new WebSocketGrokTransport("key", "model", url);
    await t.connect();
    // The session takes the transport's one close handler, so the close is
    // awaited through the session's own.
    let closedNow!: () => void;
    const closed = new Promise<void>((r) => (closedNow = r));
    const failed = new Promise<void>((r) => {
      new GrokVoiceSession(t as GrokTransport, { instructions: "", tools: [] } as never, {
        onError: () => r(),
        onClosed: () => closedNow(),
      } as never);
    });
    t.commitBuffered();
    await failed;
    const d = t.closeDiagnostics();
    expect(d.firstSignal).toBe("provider_error_event");
    expect(d.providerErrorType).toBe("server_error");
    expect(d.providerErrorCode).toBe("internal");
    expect(JSON.stringify(d)).not.toContain(said);
    t.close();
    await closed;
  });

  it("logs the close with its signal, and no call content", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void lines.push(String(m)));
    const url = await server((_s, req) => setTimeout(() => req.socket.resetAndDestroy(), 50));
    const { closed } = await open(url);
    await closed;
    const close = lines.find((l) => l.startsWith("[SESSION] closed code=1006"));
    expect(close).toContain("first=socket_error");
    expect(close).toContain("socketError=ECONNRESET");
    expect(close).toContain("by=peer");
    expect(close).toContain("sockets=1");
    expect(close).toMatch(/loopMax=\d+ms/);
    expect(lines.some((l) => l.startsWith("[SESSION] socket error code=ECONNRESET"))).toBe(true);
  });

  it("keeps every field it reports to the connection", () => {
    const fields: Array<keyof ProviderCloseDiagnostics> = [
      "firstSignal", "closeCode", "closeReason", "socketErrorCode", "socketErrorMessage",
      "socketEndReceived", "wsErrorMessage", "providerErrorType", "providerErrorCode",
      "closedByUs", "openForMs", "msSinceServerEvent", "msSinceClientSend", "bufferedAmount",
      "openSockets", "remoteAddress", "eventLoopMaxMs", "msSinceLoopTick", "xTraceId", "cfRay",
    ];
    const d = new WebSocketGrokTransport("key", "model").closeDiagnostics();
    expect(Object.keys(d).sort()).toEqual([...fields].sort());
  });
});
