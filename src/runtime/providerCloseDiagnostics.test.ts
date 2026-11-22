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

  it("records the peer's close code and the reason's length, never its text", async () => {
    // A close reason is whatever the peer sends, and this row is durable, so
    // only its length is kept (#507 review).
    const url = await server((s) => setTimeout(() => s.close(1001, "going away"), 50));
    const { t, closed } = await open(url);
    await closed;
    const d = t.closeDiagnostics();
    expect(d.closeCode).toBe(1001);
    expect(d.closeReasonLength).toBe("going away".length);
    expect(JSON.stringify(d)).not.toContain("going away");
    expect(d.closedByUs).toBe(false);
  });

  it("reads a close with no reason as length 0", async () => {
    const url = await server((_s, req) => setTimeout(() => req.socket.resetAndDestroy(), 50));
    const { t, closed } = await open(url);
    await closed;
    expect(t.closeDiagnostics().closeReasonLength).toBe(0);
  });

  it("keeps an error code that arrives as a number, drops an object, and still fails the call", async () => {
    // Provider events are parsed JSON with no runtime check. A number used to
    // reach .replace() and throw before onError ran (#507 review, P1).
    for (const [code, kept] of [[400, "400"], [{ nested: true }, null]] as const) {
      const url = await server((s) =>
        setTimeout(() => s.send(JSON.stringify({ type: "error", error: { type: 7, code } })), 50),
      );
      const t = new WebSocketGrokTransport("key", "model", url);
      await t.connect();
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
      expect(d.providerErrorType).toBe("7");
      expect(d.providerErrorCode).toBe(kept);
      t.close();
      await closed;
    }
  });

  it("reaches the call's failure handling when recording the provider error throws", async () => {
    const url = await server((s) =>
      setTimeout(() => s.send(JSON.stringify({ type: "error", error: { type: "server_error" } })), 50),
    );
    const t = new WebSocketGrokTransport("key", "model", url);
    t.noteProviderError = () => {
      throw new Error("telemetry broke");
    };
    await t.connect();
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
    t.close();
    await closed;
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

  it("has a refused handshake's close recorded by the time connect rejects", async () => {
    // The setup-failure row reads the diagnostics in the runtime's catch, so
    // they must already hold the close when connect's rejection is handled
    // (#508 review). `ws` emits close straight after the handshake error.
    const http = await import("node:http");
    const srv = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const t = new WebSocketGrokTransport("key", "model", `ws://127.0.0.1:${port}/realtime`);
    const failure = await t.connect().then(() => null, (e: Error) => e);
    const d = t.closeDiagnostics();
    await new Promise<void>((r) => srv.close(() => r()));
    expect(failure).not.toBeNull();
    expect(d.closeCode).toBe(1006);
    expect(d.wsErrorMessage).toContain("503");
    // `ws` emits the handshake error before the close, so the error is what
    // ended it first (v262; v259 and v260 read socket_close here).
    expect(d.firstSignal).toBe("ws_error");
    expect(d.closedByUs).toBe(false);
  });

  it("has final diagnostics at the detach, because no later close can reach them", async () => {
    // A first-event stall detaches the socket: every listener is removed
    // before it is closed, so reading the diagnostics later changes nothing.
    const url = await server(() => undefined);
    const { t } = await open(url);
    t.detachAndClose();
    const atDetach = JSON.stringify(t.closeDiagnostics());
    await new Promise((r) => setTimeout(r, 100));
    // The timings and the loop reading included: they are measured at the
    // detach, not when the setup row is written (#508 review).
    expect(JSON.stringify(t.closeDiagnostics())).toBe(atDetach);
    expect(t.closeDiagnostics()).toMatchObject({ firstSignal: "client_close", closedByUs: true, bufferedAmount: 0 });
    expect(t.closeDiagnostics().openSockets).toBeGreaterThanOrEqual(1);
    expect(t.closeDiagnostics().msSinceLoopTick).not.toBeNull();
  });

  it("keeps a close the peer made before the first event when the retry detaches the socket", async () => {
    // The provider accepts the upgrade and resets the connection before it
    // sends anything; the retry then detaches the dead socket. The row must
    // still say the peer ended it (#508 review).
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    wss.on("connection", (_s, req) => setTimeout(() => req.socket.resetAndDestroy(), 20));
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const t = new WebSocketGrokTransport("key", "model", `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`);
    t.onClose(() => undefined);
    await t.connect();
    expect(await t.waitForFirstEvent(1_000)).toBe(false);
    const beforeDetach = t.closeDiagnostics();
    t.detachAndClose();
    const d = t.closeDiagnostics();
    expect(d.closedByUs).toBe(false);
    expect(d.closeCode).toBe(1006);
    expect(d.firstSignal).not.toBe("client_close");
    expect(JSON.stringify(d)).toBe(JSON.stringify(beforeDetach));
  });

  /** A server that sends nothing first, then a frame with a reserved opcode. */
  async function protocolBreaker(delayMs: number, greetFirst = false): Promise<string> {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    wss.on("connection", (s, req) => {
      if (greetFirst) s.send(JSON.stringify({ type: "session.created" }));
      // FIN + opcode 3: reserved, so the client's `ws` refuses the frame,
      // starts the close itself (1002) and emits an error.
      setTimeout(() => req.socket.write(Buffer.from([0x83, 0x00])), delayMs);
    });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`;
  }

  it("keeps a protocol error before the first event as the peer's, when the retry detaches the socket", async () => {
    // The error wakes the first-event wait while `ws` is still closing; the
    // retry detaches before the close event, which then never arrives. The row
    // must still say the provider broke the connection (#508 review, v262).
    const url = await protocolBreaker(20);
    const t = new WebSocketGrokTransport("key", "model", url);
    t.onClose(() => undefined);
    await t.connect();
    expect(await t.waitForFirstEvent(1_000)).toBe(false);
    t.detachAndClose();
    const d = t.closeDiagnostics();
    expect(d.firstSignal).toBe("ws_error");
    expect(d.closedByUs).toBe(false);
    expect(d.wsErrorMessage).toContain("invalid opcode 3");
    // Final at the detach, as before.
    const atDetach = JSON.stringify(d);
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(t.closeDiagnostics())).toBe(atDetach);
    expect(t.closeDiagnostics().openSockets).toBeGreaterThanOrEqual(1);
  });

  it("does not call a close ours when the teardown follows a protocol error mid-call", async () => {
    const url = await protocolBreaker(50, true);
    const t = new WebSocketGrokTransport("key", "model", url);
    const closed = new Promise<void>((r) => t.onClose(() => r()));
    t.onError(() => t.close());
    await t.connect();
    expect(await t.waitForFirstEvent(1_000)).toBe(true);
    await closed;
    const d = t.closeDiagnostics();
    expect(d.firstSignal).toBe("ws_error");
    expect(d.closedByUs).toBe(false);
    expect(d.closeCode).not.toBeNull();
  });

  it("still calls a detach ours when nothing went wrong on the socket first", async () => {
    // The control for the guard: a healthy socket that only stalled.
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const t = new WebSocketGrokTransport("key", "model", `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`);
    t.onClose(() => undefined);
    await t.connect();
    expect(await t.waitForFirstEvent(50)).toBe(false);
    t.detachAndClose();
    expect(t.closeDiagnostics()).toMatchObject({ firstSignal: "client_close", closedByUs: true, wsErrorMessage: null });
  });

  it("leaves a reset after the detach to ws's own handler, so nothing goes unhandled", async () => {
    const resets: Array<() => void> = [];
    const url = await server((_s, req) => resets.push(() => req.socket.resetAndDestroy()));
    const { t } = await open(url);
    const unhandled: unknown[] = [];
    const onUncaught = (e: unknown) => void unhandled.push(e);
    process.on("uncaughtException", onUncaught);
    t.detachAndClose();
    resets[0]();
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onUncaught);
    expect(unhandled).toEqual([]);
    expect(t.closeDiagnostics().socketErrorCode).toBeNull();
  });

  it("keeps every field it reports to the connection", () => {
    const fields: Array<keyof ProviderCloseDiagnostics> = [
      "firstSignal", "closeCode", "closeReasonLength", "socketErrorCode", "socketErrorMessage",
      "socketEndReceived", "wsErrorMessage", "providerErrorType", "providerErrorCode",
      "closedByUs", "openForMs", "msSinceServerEvent", "msSinceClientSend", "bufferedAmount",
      "openSockets", "remoteAddress", "eventLoopMaxMs", "msSinceLoopTick", "xTraceId", "cfRay",
    ];
    const d = new WebSocketGrokTransport("key", "model").closeDiagnostics();
    expect(Object.keys(d).sort()).toEqual([...fields].sort());
  });
});
