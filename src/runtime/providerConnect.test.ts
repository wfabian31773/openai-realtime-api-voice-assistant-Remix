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
  connectFailureKind,
  DROPPED_AFTER_OPEN,
  SILENT_STALL,
  trackConnect,
  type ConnectOutcome,
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
    expect(alerts[0]).toMatch(/CONNECT FAILURES 2\/3 attempts/);
    now += 60_000;
    expect(window.note(false).alerted).toBe(false);
    now += 15 * 60 * 1000;
    expect(window.note(false).alerted).toBe(true);
    expect(alerts).toHaveLength(2);
  });
});

/**
 * THE ALERT SAYS WHAT FAILED — 2026-10-19 18:34–18:49 UTC.
 *
 * It read "STALL RATE 11/30 (37%) — reconnecting is not absorbing it". The
 * deployment log said ten of the eleven were xAI answering the upgrade with
 * HTTP 503 and one was a handshake timeout: nothing stalled, and seven of
 * the eight calls behind them reconnected on a retry. These pin the words,
 * the per-attempt kinds the retry loop hands over, and the call outcomes —
 * and that WHEN it fires did not move.
 */
describe("the connect-failure alert names the failure and counts the calls", () => {
  it("reads the ws library's own handshake messages", () => {
    expect(connectFailureKind("Unexpected server response: 503")).toBe("HTTP 503");
    expect(connectFailureKind("Unexpected server response: 429")).toBe("HTTP 429");
    expect(connectFailureKind("Opening handshake has timed out")).toBe("handshake timeout");
    expect(connectFailureKind("getaddrinfo ENOTFOUND api.x.ai")).toBe("handshake error");
  });

  it("hands each attempt's failure kind to the counter, and the attempt that connects carries the outcome", async () => {
    const queue: Array<() => OpenedProviderSocket> = [
      () => { throw new Error("Unexpected server response: 503"); },
      () => socket({ arrived: false }),
      () => socket({ throwOnWait: new Error("socket closed") }),
      () => socket({ arrived: true }),
    ];
    const waits: Array<[boolean, string | undefined, ConnectOutcome | undefined]> = [];
    const settled: ConnectOutcome[] = [];
    await connectWithFirstEventRetry({
      open: async () => queue.shift()!(),
      firstEventTimeoutMs: 80,
      maxRetries: 3,
      log: () => undefined,
      noteFirstEventWait: (arrived, failure, settles) => waits.push([arrived, failure, settles]),
      noteConnectSettled: (outcome) => settled.push(outcome),
    });
    expect(waits).toEqual([
      [false, "HTTP 503", undefined],
      [false, SILENT_STALL, undefined],
      [false, DROPPED_AFTER_OPEN, undefined],
      [true, undefined, "connected"],
    ]);
    // The outcome rode on the attempt; nothing was left to settle separately.
    expect(settled).toEqual([]);
  });

  it.each([
    ["a handshake failure", () => { throw new Error("Opening handshake has timed out"); }],
    ["a silent socket", () => socket({ arrived: false })],
    ["a socket that drops after open", () => socket({ throwOnWait: new Error("closed") })],
  ])("the last attempt carries the call as lost when it is %s", async (_label, last) => {
    const queue: Array<() => OpenedProviderSocket> = [
      () => { throw new Error("Unexpected server response: 503"); },
      last as () => OpenedProviderSocket,
    ];
    const settles: Array<ConnectOutcome | undefined> = [];
    await expect(
      connectWithFirstEventRetry({
        open: async () => queue.shift()!(),
        firstEventTimeoutMs: 80,
        maxRetries: 1,
        log: () => undefined,
        noteFirstEventWait: (_arrived, _failure, settles_) => settles.push(settles_),
      }),
    ).rejects.toBeInstanceOf(FirstEventStallError);
    // Only the deciding attempt carries it; the first one decided nothing.
    expect(settles).toEqual([undefined, "lost"]);
  });

  // Every abort path, each after a first attempt that failed — the shape that
  // left a call reading "still connecting" until it aged out of the window.
  type Gone = { gone: boolean };
  it.each<[string, (g: Gone) => OpenedProviderSocket]>([
    ["before the next attempt", () => socket()], // gone is set by the first note, below
    ["during the handshake", () => { throw new ProviderConnectAbortedError(); }],
    ["right after the socket opens", (g) => { g.gone = true; return socket(); }],
    ["during the first-event wait", () => socket({ throwOnWait: new ProviderConnectAbortedError() })],
    ["right after the first-event wait", (g) => {
      const s = socket({ arrived: false });
      const wait = s.waitForFirstEvent.bind(s);
      s.waitForFirstEvent = async (ms) => { const r = await wait(ms); g.gone = true; return r; };
      return s;
    }],
  ])("settles a call the Twilio side abandoned %s as abandoned (Codex P2, #354)", async (label, second) => {
    const g: Gone = { gone: false };
    let opens = 0;
    const settled: ConnectOutcome[] = [];
    const noted: boolean[] = [];
    await expect(
      connectWithFirstEventRetry({
        open: async () => {
          opens += 1;
          if (opens === 1) throw new Error("Unexpected server response: 503");
          return second(g);
        },
        shouldAbort: () => g.gone,
        firstEventTimeoutMs: 80,
        maxRetries: 2,
        log: () => undefined,
        noteFirstEventWait: (arrived) => {
          noted.push(arrived);
          if (label === "before the next attempt") g.gone = true;
        },
        noteConnectSettled: (outcome) => settled.push(outcome),
      }),
    ).rejects.toBeInstanceOf(ProviderConnectAbortedError);
    expect(noted).toEqual([false]);
    expect(settled).toEqual(["abandoned"]);
  });

  it("the 2026-10-19 shape: names 503s and the timeout, counts rescued, dropped and in-flight calls", () => {
    const alerts: string[] = [];
    const window = createStallRateWindow({
      window: 30,
      alertAt: 11,
      now: () => 1_000,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    // Call 1 drops: three 503s, every retry — the last attempt carries it.
    window.note(false, "HTTP 503", 1);
    window.note(false, "HTTP 503", 1);
    window.note(false, "HTTP 503", 1, "lost");
    // Calls 2–7 each take one 503 and reconnect on the retry.
    for (let call = 2; call <= 7; call++) {
      window.note(false, "HTTP 503", call);
      window.note(true, undefined, call, "connected");
    }
    // Call 8 takes a handshake timeout and reconnects.
    window.note(false, "handshake timeout", 8);
    window.note(true, undefined, 8, "connected");
    expect(alerts).toEqual([]);
    // Call 9's 503 is the eleventh failure; it is still mid-retry when this fires.
    window.note(false, "HTTP 503", 9);
    expect(alerts).toHaveLength(1);
    const text = alerts[0];
    expect(text).toContain("CONNECT FAILURES 11/18 attempts (61%)");
    expect(text).toContain("HTTP 503 x10, handshake timeout x1.");
    expect(text).toContain(
      "Calls affected: 9 (7 reconnected on a retry, 1 dropped after every retry, 1 still connecting).",
    );
    expect(text).not.toMatch(/stall|not absorbing/i);
  });

  it("counts the call dropped BY the attempt that fires the alert as dropped, not still connecting (Codex P2, #354)", () => {
    const alerts: string[] = [];
    const window = createStallRateWindow({
      window: 30,
      alertAt: 3,
      now: () => 1_000,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    window.note(false, "HTTP 503", 1);
    window.note(false, "HTTP 503", 1);
    window.note(false, "HTTP 503", 1, "lost");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Calls affected: 1 (1 dropped after every retry).");
    expect(alerts[0]).not.toContain("still connecting");
  });

  it("names a call the caller abandoned mid-retry instead of calling it still connecting (Codex P2, #354)", () => {
    const alerts: string[] = [];
    let now = 1_000;
    const window = createStallRateWindow({
      window: 30,
      alertAt: 2,
      now: () => now,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    window.note(false, "HTTP 503", 1);
    window.settle(1, "abandoned");
    now += 15 * 60 * 1000;
    window.note(false, "HTTP 503", 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Calls affected: 2 (none dropped, 1 hung up while reconnecting, 1 still connecting).");
  });

  it('says "none dropped" when every affected call reconnected', () => {
    const alerts: string[] = [];
    const window = createStallRateWindow({
      window: 30,
      alertAt: 2,
      now: () => 1_000,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    window.note(false, SILENT_STALL, 1);
    window.note(true, undefined, 1, "connected");
    window.note(false, SILENT_STALL, 2);
    expect(alerts[0]).toContain(`${SILENT_STALL} x2.`);
    expect(alerts[0]).toContain("Calls affected: 2 (1 reconnected on a retry, none dropped, 1 still connecting).");
  });

  it("forgets a call once its attempts leave the window", () => {
    const alerts: string[] = [];
    const window = createStallRateWindow({
      window: 3,
      alertAt: 2,
      now: () => 1_000,
      alert: (text) => alerts.push(text),
      log: () => undefined,
    });
    window.note(false, "HTTP 503", 1);
    window.settle(1, "lost");
    // Three attempts from call 2 push call 1 out entirely.
    window.note(true, undefined, 2);
    window.note(true, undefined, 2);
    window.note(true, undefined, 2);
    window.settle(2, "connected");
    // A settle for a call no longer in the window records nothing.
    window.settle(1, "lost");
    window.note(false, "HTTP 503", 3);
    window.note(false, "HTTP 503", 4);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Calls affected: 2 (none dropped, 2 still connecting).");
  });

  it("fires on exactly the attempt it always did", () => {
    // Same window, same threshold, same cooldown as the pre-2026-10-19 test:
    // the words changed, the moment did not.
    const fired: number[] = [];
    let now = 1_000;
    const window = createStallRateWindow({
      window: 5,
      alertAt: 2,
      now: () => now,
      alert: () => undefined,
      log: () => undefined,
    });
    const script = [true, false, false, false, true];
    script.forEach((ok, i) => {
      if (window.note(ok, ok ? undefined : "HTTP 503").alerted) fired.push(i);
    });
    now += 15 * 60 * 1000;
    // A SUCCESS after the cooldown still fires while the window holds enough
    // failures — unchanged, deliberately.
    if (window.note(true).alerted) fired.push(5);
    expect(fired).toEqual([2, 5]);
  });
});

describe("the runtime hands every call its own counter", () => {
  it("voiceRuntime spreads trackConnect() into the retry, so attempts and the outcome share a call id", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("await connectWithFirstEventRetry({"));
    const opts = call.slice(0, call.indexOf("});"));
    expect(opts).toContain("...trackConnect(),");
    // The bare module-level counter would drop the call id and the outcome.
    expect(src).not.toMatch(/^\s*noteFirstEventWait,\s*$/m);
  });
});

describe("the production counter", () => {
  it("gives each call its own id on the process's window, so two calls read as two", () => {
    // The only test in this file that touches the module-level window, so its
    // first alert is this one. SMS is skipped under VITEST; the log line is not.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const a = trackConnect();
      const b = trackConnect();
      a.noteFirstEventWait!(false, "HTTP 503");
      b.noteFirstEventWait!(false, "HTTP 503");
      a.noteFirstEventWait!(true, undefined, "connected");
      b.noteFirstEventWait!(false, "HTTP 503");
      b.noteFirstEventWait!(false, "handshake timeout");
      const lines = warn.mock.calls.map((c) => String(c[0]));
      const alert = lines.find((l) => l.includes("CONNECT FAILURES"));
      expect(alert).toBeDefined();
      expect(alert).toContain("HTTP 503 x3, handshake timeout x1.");
      expect(alert).toContain("Calls affected: 2 (1 reconnected on a retry, none dropped, 1 still connecting).");
    } finally {
      warn.mockRestore();
    }
  });
});
