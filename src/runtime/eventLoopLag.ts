/**
 * How late this process's event loop has been running, for the provider-close
 * diagnostics (v259).
 *
 * WHY: runtime calls drop in groups, every open xAI socket closing 1006 within
 * a second of the others, on a ~100 s grid (2026-11-21). A stall in our own
 * process would do that: no frame read or written for long enough that a peer
 * or a proxy gives up on every socket at once. So would a network path
 * resetting them. This module answers the first half: was the loop stalled
 * when the sockets closed?
 *
 * Two readings, because each misses a case the other catches:
 *   - `maxLagMs`: the worst delay `monitorEventLoopDelay` recorded over the
 *     last minute (twelve 5 s windows). It sees a stall that has ENDED.
 *   - `msSinceLastTick`: how long since a 1 s heartbeat last ran. A close
 *     handled straight after a stall can run before the histogram's own
 *     timer has recorded that stall; the heartbeat's age still shows it.
 *
 * Counts only; nothing about a call. Started once, unref'd, so it never holds
 * the process open.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const TICK_MS = 1_000;
const TICKS_PER_WINDOW = 5;
const WINDOWS = 12;

let histogram: IntervalHistogram | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let windows: number[] = [];
let ticks = 0;
let lastTickAt: number | null = null;

function currentWindowMaxMs(): number {
  if (!histogram) return 0;
  const max = histogram.max;
  return Number.isFinite(max) && max > 0 ? max / 1e6 : 0;
}

/** Start watching. Idempotent; a platform without the histogram leaves it off. */
export function startEventLoopWatch(): void {
  if (timer) return;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }
  lastTickAt = Date.now();
  timer = setInterval(() => {
    lastTickAt = Date.now();
    ticks += 1;
    if (ticks % TICKS_PER_WINDOW === 0) {
      windows.push(currentWindowMaxMs());
      if (windows.length > WINDOWS) windows.shift();
      histogram?.reset();
    }
  }, TICK_MS);
  timer.unref?.();
}

export interface EventLoopSnapshot {
  /** Worst loop delay in the last minute, ms. Null when the watch is off. */
  maxLagMs: number | null;
  /** Age of the 1 s heartbeat, ms. Null when the watch is off. */
  msSinceLastTick: number | null;
}

export function eventLoopSnapshot(now: number = Date.now()): EventLoopSnapshot {
  if (lastTickAt === null) return { maxLagMs: null, msSinceLastTick: null };
  const max = histogram ? Math.max(currentWindowMaxMs(), ...windows) : null;
  return {
    maxLagMs: max === null ? null : Math.round(max),
    msSinceLastTick: Math.max(0, now - lastTickAt),
  };
}

/** Tests only: stop the watch and forget every reading. */
export function resetEventLoopWatchForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
  windows = [];
  ticks = 0;
  lastTickAt = null;
}
