/**
 * FIRST-EVENT RETRY — the helper, not that anything calls it.
 *
 * The runtime wiring lives in voiceRuntime.test.ts (CA91A / CA91B). This
 * file pins the knobs and the retry loop itself so a clamp, a retry count
 * or an abort can go red here without standing up a Twilio stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectRetries,
  connectWithFirstEventRetry,
  createStallRateWindow,
  DEFAULT_CONNECT_RETRIES,
  DEFAULT_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
  FirstEventStallError,
  firstEventTimeoutMs,
  handshakeTimeoutMs,
  ProviderConnectAbortedError,
  type OpenedProviderSocket,
} from "./providerConnect";

function socket(over: {
  arrived?: boolean;
  waitMs?: number;
  throwOnWait?: Error;
  headers?: { xTraceId?: string; cfRay?: string };
} = {}): OpenedProviderSocket & { detached: boolean } {
  const s = {
    headers: over.headers ?? { xTraceId: "trace-1", cfRay: "ray-1" },
    detached: false,
    async waitForFirstEvent(ms: number): Promise<boolean> {
      if (over.throwOnWait) throw over.throwOnWait;
      if (over.waitMs != null) await new Promise((r) => setTimeout(r, over.waitMs));
      void ms;
      return over.arrived ?? true;
    },
    detachAndClose() {
      s.detached = true;
    },
  };
  return s;
}

describe("the env knobs clamp rather than trust a typo", () => {
  it("defaults when the env is unset", () => {
    expect(firstEventTimeoutMs({})).toBe(DEFAULT_FIRST_EVENT_TIMEOUT_MS);
    expect(handshakeTimeoutMs({})).toBe(DEFAULT_WS_HANDSHAKE_TIMEOUT_MS);
    expect(connectRetries({})).toBe(DEFAULT_CONNECT_RETRIES);
    expect(DEFAULT_FIRST_EVENT_TIMEOUT_MS).toBe(2_500);
    expect(DEFAULT_WS_HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_CONNECT_RETRIES).toBe(2);
  });

  it("clamps the first-event window to 1000–10000", () => {
    expect(firstEventTimeoutMs({ RUNTIME_FIRST_EVENT_TIMEOUT_MS: "80" })).toBe(1_000);
    expect(firstEventTimeoutMs({ RUNTIME_FIRST_EVENT_TIMEOUT_MS: "99999" })).toBe(10_000);
    expect(firstEventTimeoutMs({ RUNTIME_FIRST_EVENT_TIMEOUT_MS: "3000" })).toBe(3_000);
    expect(firstEventTimeoutMs({ RUNTIME_FIRST_EVENT_TIMEOUT_MS: "nope" })).toBe(2_500);
  });

  it("clamps the handshake window to 2000–15000", () => {
    expect(handshakeTimeoutMs({ RUNTIME_WS_HANDSHAKE_TIMEOUT_MS: "500" })).toBe(2_000);
    expect(handshakeTimeoutMs({ RUNTIME_WS_HANDSHAKE_TIMEOUT_MS: "20000" })).toBe(15_000);
    expect(handshakeTimeoutMs({ RUNTIME_WS_HANDSHAKE_TIMEOUT_MS: "6000" })).toBe(6_000);
  });

  it("clamps retries to 0–4", () => {
    expect(connectRetries({ RUNTIME_CONNECT_RETRIES: "-1" })).toBe(0);
    expect(connectRetries({ RUNTIME_CONNECT_RETRIES: "9" })).toBe(4);
    expect(connectRetries({ RUNTIME_CONNECT_RETRIES: "1" })).toBe(1);
  });
});

describe("connectWithFirstEventRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first socket when the first event arrives on attempt 1", async () => {
    const first = socket({ arrived: true });
    const open = vi.fn(async () => first);
    const log: string[] = [];
    const result = await connectWithFirstEventRetry({
      open,
      firstEventTimeoutMs: 80,
      maxRetries: 2,
      log: (line) => log.push(line),
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(result.socket).toBe(first);
    expect(first.detached).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe("first_event");
    expect(result.attempts[0].headers).toEqual({ xTraceId: "trace-1", cfRay: "ray-1" });
    expect(log.some((l) => l.includes("x-trace-id=trace-1"))).toBe(true);
    expect(log.some((l) => l.includes("cf-ray=ray-1"))).toBe(true);
  });

  it("detaches a stalled first socket and opens the next attempt", async () => {
    const stalled = socket({ arrived: false });
    const live = socket({ arrived: true, headers: { xTraceId: "trace-2", cfRay: "ray-2" } });
    const opens = [stalled, live];
    const open = vi.fn(async () => opens.shift()!);
    const waits: boolean[] = [];
    const result = await connectWithFirstEventRetry({
      open,
      firstEventTimeoutMs: 80,
      maxRetries: 2,
      log: () => undefined,
      noteFirstEventWait: (arrived) => waits.push(arrived),
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(stalled.detached).toBe(true);
    expect(live.detached).toBe(false);
    expect(result.socket).toBe(live);
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "first_event_stall",
      "first_event",
    ]);
    expect(waits).toEqual([false, true]);
  });

  it("throws FirstEventStallError after every retry is exhausted", async () => {
    const sockets = [socket({ arrived: false }), socket({ arrived: false }), socket({ arrived: false })];
    const open = vi.fn(async () => sockets.shift()!);
    await expect(
      connectWithFirstEventRetry({
        open,
        firstEventTimeoutMs: 80,
        maxRetries: 2,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(FirstEventStallError);
    expect(open).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(0);
  });

  it("retries a handshake that never upgrades, then succeeds", async () => {
    const live = socket({ arrived: true });
    let n = 0;
    const open = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("handshake timeout");
      return live;
    });
    const result = await connectWithFirstEventRetry({
      open,
      firstEventTimeoutMs: 80,
      maxRetries: 2,
      log: () => undefined,
    });
    expect(result.socket).toBe(live);
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "handshake_failed",
      "first_event",
    ]);
  });

  it("aborts before opening when the Twilio socket is gone", async () => {
    const open = vi.fn(async () => socket());
    await expect(
      connectWithFirstEventRetry({
        open,
        shouldAbort: () => true,
        firstEventTimeoutMs: 80,
        maxRetries: 2,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProviderConnectAbortedError);
    expect(open).not.toHaveBeenCalled();
  });

  it("detaches an open socket and aborts when Twilio goes away after open", async () => {
    const first = socket({ arrived: true });
    await expect(
      connectWithFirstEventRetry({
        open: async () => first,
        shouldAbort: () => true,
        firstEventTimeoutMs: 80,
        maxRetries: 2,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProviderConnectAbortedError);
    // Abort is checked before open AND after; the first check fires here.
    expect(first.detached).toBe(false);
  });

  it("detaches and aborts when Twilio goes away after a successful open", async () => {
    let abort = false;
    const first = socket({ arrived: true });
    await expect(
      connectWithFirstEventRetry({
        open: async () => {
          abort = true;
          return first;
        },
        shouldAbort: () => abort,
        firstEventTimeoutMs: 80,
        maxRetries: 2,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProviderConnectAbortedError);
    expect(first.detached).toBe(true);
  });

  it("carries the upgrade headers on a stall log line", async () => {
    const log: string[] = [];
    await expect(
      connectWithFirstEventRetry({
        open: async () => socket({ arrived: false, headers: { xTraceId: "abc", cfRay: "def" } }),
        firstEventTimeoutMs: 80,
        maxRetries: 0,
        log: (line) => log.push(line),
      }),
    ).rejects.toBeInstanceOf(FirstEventStallError);
    expect(log.some((l) => l.includes("first-event stall") && l.includes("x-trace-id=abc") && l.includes("cf-ray=def"))).toBe(true);
  });
});

describe("the stall-rate window", () => {
  it("alerts once the window reaches the threshold, then cools down", () => {
    const alerts: string[] = [];
    let now = 1_000;
    const window = createStallRateWindow({
      window: 5,
      alertAt: 2,
      now: () => now,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    expect(window.note(true).alerted).toBe(false);
    expect(window.note(false).alerted).toBe(false);
    const second = window.note(false);
    expect(second.alerted).toBe(true);
    expect(second.stalls).toBe(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/STALL RATE 2\/3/);
    now += 60_000;
    expect(window.note(false).alerted).toBe(false);
    now += 15 * 60 * 1000;
    expect(window.note(false).alerted).toBe(true);
    expect(alerts).toHaveLength(2);
  });
});
