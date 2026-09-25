/**
 * THE ALARM THAT WOULD HAVE MADE 2026-09-25 A FOUR-MINUTE OUTAGE.
 *
 * Ticketing-app Next froze at 20:09:52 UTC. The in-process monitor's
 * SELECT 1 never ran. GET /api/health kept serving a cached 200. The
 * gateway's /_health/live stayed green because it does not talk to Next.
 * Filing recovered only when Wayne republished.
 *
 * This module lives HERE, next to ticketFilingHealth.ts, and it reads
 * ticketing-app's app_heartbeat table on TICKETING_APP_DATABASE_URL.
 * HTTP to Next would fail the same way the health probe did — if Next
 * is hung, the answer is silence, and silence is the signal.
 *
 * Thresholds Wayne asked for, 2026-09-25:
 *
 *   (a) heap used ≥ 80% of V8 heap_size_limit, or RSS ≥ 80% of the VM
 *       memory limit when that limit is known
 *   (b) memory rising steadily for 15 minutes (early warning)
 *   (c) newest Next heartbeat ≥ 3 minutes old (frozen or dead)
 *   (d) event-loop delay p99 > 1s for 3 minutes
 *
 * THE STALE THRESHOLD IS THE OUTAGE. Last beat 20:09 UTC → this fires
 * by 20:13. That is the regression at the bottom of the test file.
 *
 * Debounce is edge-triggered in nextLivenessAction: one email on enter,
 * quiet while the same conditions hold, one recovery email on leave.
 * sendAlert still applies its 5-minute cooldown and 10/hour cap.
 */

import type { Client } from 'pg';

export const NEXT_SERVICE = 'ticketing-next';
export const GATEWAY_SERVICE = 'voice-gateway';

export const HEAP_LIMIT_RATIO = 0.8;
export const RSS_VM_RATIO = 0.8;
export const STALE_MS = 3 * 60 * 1000;
export const EVENT_LOOP_P99_MS = 1000;
export const EVENT_LOOP_HOLD_MS = 3 * 60 * 1000;
export const RISE_WINDOW_MS = 15 * 60 * 1000;
export const RISE_MIN_MB = 20;
export const RISE_MIN_RATIO = 0.05;

export type LivenessCondition =
  | 'heap_high'
  | 'rss_high'
  | 'memory_rising'
  | 'stale'
  | 'event_loop_delay'
  | 'read_failed';

/** Consecutive failed reads before the watcher itself is an outage. */
export const READ_FAILURE_THRESHOLD = 3;

export interface HeartbeatReading {
  service: string;
  instanceId: string;
  recordedAtMs: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
  vmLimitMb: number | null;
  eventLoopDelayP99Ms: number;
  uptimeSeconds: number;
}

export interface LivenessSnapshot {
  /** Newest first. */
  readings: HeartbeatReading[];
  nowMs: number;
}

export interface LivenessDetails {
  service: string;
  conditions: string;
  minutesSinceLastBeat: number | null;
  lastRecordedAt: string;
  instanceId: string;
  heapUsedMb: number;
  heapLimitMb: number;
  heapPct: number;
  rssMb: number;
  vmLimitMb: number | null;
  rssPct: number | null;
  eventLoopDelayP99Ms: number;
  uptimeSeconds: number;
  gatewayMinutesSinceLastBeat: number | null;
}

export interface LivenessVerdict {
  alerting: boolean;
  conditions: LivenessCondition[];
  reason: string | null;
  recoveryReason: string;
  latest: HeartbeatReading | null;
  minutesSinceLastBeat: number | null;
  details: LivenessDetails;
}

export type LivenessAction = 'alert' | 'recover' | 'quiet';

function forService(snapshot: LivenessSnapshot, service: string): HeartbeatReading[] {
  return snapshot.readings.filter((r) => r.service === service);
}

function newest(readings: HeartbeatReading[]): HeartbeatReading | null {
  return readings[0] ?? null;
}

function minutesSince(nowMs: number, recordedAtMs: number): number {
  return Math.round((nowMs - recordedAtMs) / 60_000);
}

function heapPct(row: HeartbeatReading): number {
  if (row.heapLimitMb <= 0) return 0;
  return Math.round((row.heapUsedMb / row.heapLimitMb) * 100);
}

function rssPct(row: HeartbeatReading): number | null {
  if (row.vmLimitMb === null || row.vmLimitMb <= 0) return null;
  return Math.round((row.rssMb / row.vmLimitMb) * 100);
}

function steadilyRising(values: number[]): boolean {
  if (values.length < 2) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
  }
  const first = values[0];
  const last = values[values.length - 1];
  const minGain = Math.max(RISE_MIN_MB, Math.round(first * RISE_MIN_RATIO));
  return last - first >= minGain;
}

function isMemoryRising(readingsOldestFirst: HeartbeatReading[]): boolean {
  if (readingsOldestFirst.length < 2) return false;
  const first = readingsOldestFirst[0];
  const last = readingsOldestFirst[readingsOldestFirst.length - 1];
  if (last.recordedAtMs - first.recordedAtMs < RISE_WINDOW_MS) return false;
  return (
    steadilyRising(readingsOldestFirst.map((r) => r.heapUsedMb)) ||
    steadilyRising(readingsOldestFirst.map((r) => r.rssMb))
  );
}

function isEventLoopHeld(readingsNewestFirst: HeartbeatReading[], nowMs: number): boolean {
  const streak: HeartbeatReading[] = [];
  for (const row of readingsNewestFirst) {
    if (row.eventLoopDelayP99Ms <= EVENT_LOOP_P99_MS) break;
    streak.push(row);
  }
  if (streak.length < 2) return false;
  const newestAt = streak[0].recordedAtMs;
  const oldestAt = streak[streak.length - 1].recordedAtMs;
  // The hold is about the last three minutes of delay, not a historical streak.
  if (nowMs - newestAt > STALE_MS) return false;
  return newestAt - oldestAt >= EVENT_LOOP_HOLD_MS;
}

function buildDetails(
  latest: HeartbeatReading | null,
  conditions: LivenessCondition[],
  minutesSinceLastBeat: number | null,
  gatewayMinutes: number | null,
): LivenessDetails {
  return {
    service: latest?.service ?? NEXT_SERVICE,
    conditions: conditions.join(',') || 'none',
    minutesSinceLastBeat,
    lastRecordedAt: latest ? new Date(latest.recordedAtMs).toISOString() : '',
    instanceId: latest?.instanceId ?? '',
    heapUsedMb: latest?.heapUsedMb ?? 0,
    heapLimitMb: latest?.heapLimitMb ?? 0,
    heapPct: latest ? heapPct(latest) : 0,
    rssMb: latest?.rssMb ?? 0,
    vmLimitMb: latest?.vmLimitMb ?? null,
    rssPct: latest ? rssPct(latest) : null,
    eventLoopDelayP99Ms: latest?.eventLoopDelayP99Ms ?? 0,
    uptimeSeconds: latest?.uptimeSeconds ?? 0,
    gatewayMinutesSinceLastBeat: gatewayMinutes,
  };
}

function reasonFor(conditions: LivenessCondition[], latest: HeartbeatReading | null, minutes: number | null): string {
  if (conditions.includes('stale')) {
    return minutes === null
      ? 'no heartbeat from ticketing-next — the process has not written since this watch started'
      : `ticketing-next heartbeat is ${minutes} minutes stale (last ${latest ? new Date(latest.recordedAtMs).toISOString() : 'unknown'}). Frozen or dead.`;
  }
  if (conditions.includes('heap_high') && latest) {
    return `heap used is ${heapPct(latest)}% of the V8 limit (${latest.heapUsedMb} / ${latest.heapLimitMb} MB)`;
  }
  if (conditions.includes('rss_high') && latest) {
    return `RSS is ${rssPct(latest)}% of the VM limit (${latest.rssMb} / ${latest.vmLimitMb} MB)`;
  }
  if (conditions.includes('memory_rising')) {
    return 'memory has been rising steadily for 15 minutes';
  }
  if (conditions.includes('event_loop_delay') && latest) {
    return `event-loop delay p99 has been over 1s for 3 minutes (now ${latest.eventLoopDelayP99Ms} ms)`;
  }
  if (conditions.includes('read_failed')) {
    return 'could not read app_heartbeat — the watcher is dark (URL, permissions, or table missing)';
  }
  return 'ticketing-app liveness alarm';
}

/**
 * The reader returned null. After three consecutive failures the watch
 * itself is the outage — a permanently dark watcher is how 20:09 happened
 * with no email. Unset URL and a refused connection look the same from
 * here; both stay dark until a person sets the URL or the table exists.
 */
export function assessReadFailure(consecutiveFailures: number): LivenessVerdict | null {
  if (consecutiveFailures < READ_FAILURE_THRESHOLD) return null;
  return {
    alerting: true,
    conditions: ['read_failed'],
    reason: reasonFor(['read_failed'], null, null),
    recoveryReason: 'app_heartbeat is readable again',
    latest: null,
    minutesSinceLastBeat: null,
    details: buildDetails(null, ['read_failed'], null, null),
  };
}

/** Pure: no clock, no database, so the 20:09 hang can be replayed against it. */
export function assessTicketingAppLiveness(snapshot: LivenessSnapshot): LivenessVerdict {
  const nextReadings = forService(snapshot, NEXT_SERVICE);
  const gatewayReadings = forService(snapshot, GATEWAY_SERVICE);
  const latest = newest(nextReadings);
  const latestGateway = newest(gatewayReadings);

  const minutesSinceLastBeat = latest ? minutesSince(snapshot.nowMs, latest.recordedAtMs) : null;
  const gatewayMinutes = latestGateway ? minutesSince(snapshot.nowMs, latestGateway.recordedAtMs) : null;

  const conditions: LivenessCondition[] = [];

  if (!latest || snapshot.nowMs - latest.recordedAtMs >= STALE_MS) {
    conditions.push('stale');
  }

  if (latest) {
    if (latest.heapLimitMb > 0 && latest.heapUsedMb / latest.heapLimitMb >= HEAP_LIMIT_RATIO) {
      conditions.push('heap_high');
    }
    if (latest.vmLimitMb !== null && latest.vmLimitMb > 0 && latest.rssMb / latest.vmLimitMb >= RSS_VM_RATIO) {
      conditions.push('rss_high');
    }
    const window = [...nextReadings]
      .filter((r) => snapshot.nowMs - r.recordedAtMs <= RISE_WINDOW_MS + 60_000)
      .reverse();
    if (isMemoryRising(window)) conditions.push('memory_rising');
    if (isEventLoopHeld(nextReadings, snapshot.nowMs)) conditions.push('event_loop_delay');
  }

  const alerting = conditions.length > 0;
  const details = buildDetails(latest, conditions, minutesSinceLastBeat, gatewayMinutes);

  return {
    alerting,
    conditions,
    reason: alerting ? reasonFor(conditions, latest, minutesSinceLastBeat) : null,
    recoveryReason: 'heartbeat is fresh and memory / event-loop are back inside limits',
    latest,
    minutesSinceLastBeat,
    details,
  };
}

/**
 * One email on enter, quiet while the same set holds, one recovery on leave.
 * A newly added condition while already alerting is a new enter.
 */
export function nextLivenessAction(
  previous: readonly LivenessCondition[],
  verdict: LivenessVerdict,
): LivenessAction {
  const prev = new Set(previous);
  if (verdict.alerting) {
    const grew = verdict.conditions.some((c) => !prev.has(c));
    return previous.length === 0 || grew ? 'alert' : 'quiet';
  }
  return previous.length > 0 ? 'recover' : 'quiet';
}

const LOOKBACK_MINUTES = 20;

function parseReading(row: {
  service: string;
  instance_id: string;
  recorded_ms: string | number;
  rss_mb: string | number;
  heap_used_mb: string | number;
  heap_total_mb: string | number;
  heap_limit_mb: string | number;
  vm_limit_mb: string | number | null;
  event_loop_delay_p99_ms: string | number;
  uptime_seconds: string | number;
}): HeartbeatReading {
  const vm = row.vm_limit_mb;
  return {
    service: String(row.service),
    instanceId: String(row.instance_id),
    recordedAtMs: Number(row.recorded_ms),
    rssMb: Number(row.rss_mb),
    heapUsedMb: Number(row.heap_used_mb),
    heapTotalMb: Number(row.heap_total_mb),
    heapLimitMb: Number(row.heap_limit_mb),
    vmLimitMb: vm === null || vm === undefined || vm === '' ? null : Number(vm),
    eventLoopDelayP99Ms: Number(row.event_loop_delay_p99_ms),
    uptimeSeconds: Number(row.uptime_seconds),
  };
}

let loggedUnconfigured = false;
let loggedReadFailure = false;

/**
 * Reads ticketing-app's database. Never the Ops Hub pool — those are
 * different Supabase projects. Never HTTP. Never throws.
 */
export async function readTicketingAppLivenessSnapshot(): Promise<LivenessSnapshot | null> {
  const url = process.env.TICKETING_APP_DATABASE_URL?.trim();
  if (!url) {
    if (!loggedUnconfigured) {
      loggedUnconfigured = true;
      console.warn(
        '[TICKETING APP LIVENESS] Not watching: set TICKETING_APP_DATABASE_URL to the ticketing-app Postgres URL. ' +
          'HTTP to Next is not a substitute — that is what stayed green at 20:09.',
      );
    }
    return null;
  }

  let client: Client | null = null;
  try {
    const pg = await import('pg');
    client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 4000,
      query_timeout: 4000,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    const result = await client.query(
      `SELECT service,\n              instance_id,\n              (EXTRACT(EPOCH FROM recorded_at) * 1000)::bigint AS recorded_ms,\n              rss_mb, heap_used_mb, heap_total_mb, heap_limit_mb, vm_limit_mb,\n              event_loop_delay_p99_ms, uptime_seconds\n         FROM app_heartbeat\n        WHERE recorded_at > NOW() - ($1 * INTERVAL '1 minute')\n        ORDER BY recorded_at DESC`,
      [LOOKBACK_MINUTES],
    );
    return {
      readings: (result.rows as Parameters<typeof parseReading>[0][]).map(parseReading),
      nowMs: Date.now(),
    };
  } catch (err) {
    if (!loggedReadFailure) {
      loggedReadFailure = true;
      console.error(
        '[TICKETING APP LIVENESS] Could not read app_heartbeat (will retry; this line is once):',
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
