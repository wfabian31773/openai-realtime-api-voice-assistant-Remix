/**
 * v259: the provider-close row and the event-loop watch behind it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProviderCloseDiagnostics } from "./grokSession";

const log = vi.hoisted(() => ({
  emitted: [] as unknown[][],
  flushed: [] as string[],
  released: [] as Array<string | undefined>,
  flushOk: [] as boolean[],
}));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...a: unknown[]) => void log.emitted.push(a),
  flushCallEvents: async (id: string) => {
    log.flushed.push(id);
    return log.flushOk.length ? (log.flushOk.shift() as boolean) : true;
  },
  releaseCallEvents: (id?: string) => void log.released.push(id),
}));

const { providerCloseEvent, logProviderClose, PROVIDER_CLOSE_EVENT } = await import("./providerCloseTelemetry");
const { startEventLoopWatch, eventLoopSnapshot, resetEventLoopWatchForTests } = await import("./eventLoopLag");

const SID = "CA00000000000000000000000000000259";
const DIAG = {
  firstSignal: "socket_error",
  closeCode: 1006,
  socketErrorCode: "ECONNRESET",
  socketEndReceived: false,
  openSockets: 4,
  eventLoopMaxMs: 12,
  msSinceLoopTick: 300,
  xTraceId: "trace-1",
  cfRay: "ray-1",
} as unknown as ProviderCloseDiagnostics;

beforeEach(() => {
  log.emitted.length = 0;
  log.flushed.length = 0;
  log.released.length = 0;
  log.flushOk.length = 0;
});

describe("the provider-close row (v259)", () => {
  it("is written only for a call that ended on the provider", () => {
    for (const outcome of ["caller_hangup", "transferred", "agent_ended", "dead_air", "goodbye_grace"]) {
      expect(providerCloseEvent(outcome, DIAG)).toBeNull();
    }
    const ev = providerCloseEvent("provider_failure", DIAG, { uptimeSec: 3600 });
    expect(ev?.level).toBe("warn");
    expect(ev?.data).toMatchObject({
      outcome: "provider_failure",
      diagnostics: "present",
      socketErrorCode: "ECONNRESET",
      openSockets: 4,
      uptimeSec: 3600,
    });
  });

  it("says the diagnostics are absent rather than reading as a clean close", () => {
    expect(providerCloseEvent("provider_failure", undefined, { uptimeSec: 1 })?.data).toEqual({
      outcome: "provider_failure",
      diagnostics: "absent",
      uptimeSec: 1,
    });
  });

  it("emits one session row and releases the buffer on a flush that landed", async () => {
    const ok = await logProviderClose({ callSid: SID, outcome: "provider_failure" }, DIAG, { callLogId: "row-1" });
    expect(ok).toBe(true);
    expect(log.emitted).toHaveLength(1);
    const [callId, level, category, message, data, ids] = log.emitted[0];
    expect([callId, level, category, message]).toEqual([SID, "warn", "session", PROVIDER_CLOSE_EVENT]);
    expect(data).toMatchObject({ socketErrorCode: "ECONNRESET", cfRay: "ray-1" });
    expect(ids).toEqual({ callSid: SID, callLogId: "row-1" });
    expect(log.released).toEqual([SID]);
  });

  it("writes nothing at all for a call that did not end on the provider", async () => {
    expect(await logProviderClose({ callSid: SID, outcome: "caller_hangup" }, DIAG)).toBe(false);
    expect(log.emitted).toHaveLength(0);
    expect(log.flushed).toHaveLength(0);
  });

  it("emits before its predecessor settles and flushes only after it", async () => {
    let release!: () => void;
    const after = new Promise<void>((r) => (release = r));
    const done = logProviderClose({ callSid: SID, outcome: "provider_failure" }, DIAG, {}, { after });
    await new Promise((r) => setTimeout(r, 5));
    expect(log.emitted).toHaveLength(1);
    expect(log.flushed).toHaveLength(0);
    release();
    await done;
    expect(log.flushed).toEqual([SID]);
  });

  it("retries a flush that failed and leaves the buffer for the reaper when none lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    log.flushOk.push(false, false, false);
    const ok = await logProviderClose({ callSid: SID, outcome: "provider_failure" }, DIAG, {}, {
      backoffMs: [1, 1],
      sleep: async () => undefined,
    });
    expect(ok).toBe(false);
    expect(log.flushed).toHaveLength(3);
    expect(log.released).toHaveLength(0);
  });
});

describe("the event-loop watch (v259)", () => {
  afterEach(() => resetEventLoopWatchForTests());

  it("reads nothing until it is started", () => {
    expect(eventLoopSnapshot()).toEqual({ maxLagMs: null, msSinceLastTick: null });
  });

  it("is idempotent", () => {
    startEventLoopWatch();
    const first = eventLoopSnapshot();
    startEventLoopWatch();
    expect(eventLoopSnapshot().msSinceLastTick).toBeGreaterThanOrEqual(first.msSinceLastTick!);
  });

  it("shows a stall while it is still under way, and after it has ended", async () => {
    startEventLoopWatch();
    // The histogram measures a delay against its previous sample, so it needs
    // to have sampled once; in production it starts at the first call. Past a
    // second, the heartbeat has run, so an unblocked loop reads young.
    await new Promise((r) => setTimeout(r, 1_100));
    expect(eventLoopSnapshot().msSinceLastTick).toBeLessThan(900);
    const start = Date.now();
    while (Date.now() - start < 1_300) {
      // Block the loop: nothing else can run, the heartbeat included.
    }
    expect(eventLoopSnapshot().msSinceLastTick).toBeGreaterThanOrEqual(1_200);
    await new Promise((r) => setTimeout(r, 60));
    expect(eventLoopSnapshot().maxLagMs).toBeGreaterThanOrEqual(1_000);
  });
});
