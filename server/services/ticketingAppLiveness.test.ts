/**
 * Replaying 2026-09-25 against the alarm that did not exist that afternoon.
 *
 * Next froze at 20:09:52 UTC. Last successful create-ticket log 20:08:54.
 * Nothing wrote. The in-process monitor did not run. Wayne republished
 * after the hang. A last heartbeat at 20:09 UTC must fire stale by 20:13.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assessTicketingAppLiveness,
  nextLivenessAction,
  STALE_MS,
  HEAP_LIMIT_RATIO,
  RSS_VM_RATIO,
  EVENT_LOOP_P99_MS,
  NEXT_SERVICE,
  GATEWAY_SERVICE,
  type HeartbeatReading,
  type LivenessSnapshot,
} from './ticketingAppLiveness';

const LAST_BEAT = Date.parse('2026-09-25T20:09:00.000Z');
const FIRE_BY = Date.parse('2026-09-25T20:13:00.000Z');

function beat(over: Partial<HeartbeatReading> = {}): HeartbeatReading {
  return {
    service: NEXT_SERVICE,
    instanceId: 'boot-2026-09-25',
    recordedAtMs: LAST_BEAT,
    rssMb: 700,
    heapUsedMb: 400,
    heapTotalMb: 600,
    heapLimitMb: 1400,
    vmLimitMb: 2048,
    eventLoopDelayP99Ms: 12,
    uptimeSeconds: 36_000,
    ...over,
  };
}

function snapshot(over: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    readings: [beat()],
    nowMs: FIRE_BY,
    ...over,
  };
}

describe('2026-09-25 hang — stale by 20:13', () => {
  it('does not fire two minutes after the last beat', () => {
    const v = assessTicketingAppLiveness(snapshot({ nowMs: LAST_BEAT + 2 * 60_000 }));
    expect(v.alerting).toBe(false);
    expect(v.conditions).not.toContain('stale');
  });

  it('fires at the 3-minute boundary', () => {
    const v = assessTicketingAppLiveness(snapshot({ nowMs: LAST_BEAT + STALE_MS }));
    expect(v.alerting).toBe(true);
    expect(v.conditions).toContain('stale');
  });

  it('fires by 20:13 UTC on a last beat at 20:09 UTC', () => {
    const v = assessTicketingAppLiveness(snapshot({ nowMs: FIRE_BY }));
    expect(v.alerting).toBe(true);
    expect(v.conditions).toContain('stale');
    expect(v.minutesSinceLastBeat).toBe(4);
    expect(v.reason).toMatch(/4 minutes stale/);
    expect(v.reason).toMatch(/2026-09-25T20:09:00.000Z/);
    expect(v.details.lastRecordedAt).toBe('2026-09-25T20:09:00.000Z');
    expect(v.details.heapUsedMb).toBe(400);
    expect(v.details.rssMb).toBe(700);
  });

  it('a live gateway row does not hide a dead Next — that is how 20:09 presented', () => {
    const v = assessTicketingAppLiveness(
      snapshot({
        readings: [
          beat({
            service: GATEWAY_SERVICE,
            recordedAtMs: FIRE_BY - 15_000,
            instanceId: 'gateway-still-up',
          }),
          beat(),
        ],
      }),
    );
    expect(v.alerting).toBe(true);
    expect(v.conditions).toContain('stale');
    expect(v.details.gatewayMinutesSinceLastBeat).toBe(0);
  });

  it('no Next rows at all is stale — silence is the signal', () => {
    const v = assessTicketingAppLiveness({ readings: [], nowMs: FIRE_BY });
    expect(v.alerting).toBe(true);
    expect(v.conditions).toEqual(['stale']);
  });
});

describe('(a) heap and RSS ceilings', () => {
  it('fires when heap used is 80% of the V8 limit', () => {
    const v = assessTicketingAppLiveness(
      snapshot({
        nowMs: LAST_BEAT + 30_000,
        readings: [beat({ heapUsedMb: 1120, heapLimitMb: 1400 })],
      }),
    );
    expect(1120 / 1400).toBeGreaterThanOrEqual(HEAP_LIMIT_RATIO);
    expect(v.conditions).toContain('heap_high');
    expect(v.details.heapPct).toBe(80);
  });

  it('does not fire heap at 79%', () => {
    const v = assessTicketingAppLiveness(
      snapshot({
        nowMs: LAST_BEAT + 30_000,
        readings: [beat({ heapUsedMb: 1105, heapLimitMb: 1400 })],
      }),
    );
    expect(v.conditions).not.toContain('heap_high');
  });

  it('fires when RSS is 80% of the known VM limit', () => {
    const v = assessTicketingAppLiveness(
      snapshot({
        nowMs: LAST_BEAT + 30_000,
        readings: [beat({ rssMb: 1639, vmLimitMb: 2048 })],
      }),
    );
    expect(1639 / 2048).toBeGreaterThanOrEqual(RSS_VM_RATIO);
    expect(v.conditions).toContain('rss_high');
  });

  it('does not invent an RSS alarm when the VM limit is unknown', () => {
    const v = assessTicketingAppLiveness(
      snapshot({
        nowMs: LAST_BEAT + 30_000,
        readings: [beat({ rssMb: 3000, vmLimitMb: null })],
      }),
    );
    expect(v.conditions).not.toContain('rss_high');
  });
});

describe('(b) memory rising for 15 minutes', () => {
  function risingSeries(startMb: number, step: number, count: number): HeartbeatReading[] {
    const rows: HeartbeatReading[] = [];
    for (let i = 0; i < count; i++) {
      const recordedAtMs = LAST_BEAT - (count - 1 - i) * 60_000;
      rows.push(beat({ recordedAtMs, heapUsedMb: startMb + i * step, rssMb: 700 }));
    }
    return rows.reverse(); // newest first
  }

  it('fires when heap climbs for 15 minutes by more than 20 MB', () => {
    const v = assessTicketingAppLiveness({
      readings: risingSeries(400, 20, 16),
      nowMs: LAST_BEAT + 30_000,
    });
    expect(v.conditions).toContain('memory_rising');
  });

  it('does not fire on a 10-minute climb', () => {
    const v = assessTicketingAppLiveness({
      readings: risingSeries(400, 20, 10),
      nowMs: LAST_BEAT + 30_000,
    });
    expect(v.conditions).not.toContain('memory_rising');
  });

  it('does not fire when heap dips in the window', () => {
    const rows = risingSeries(400, 20, 16);
    rows[5] = { ...rows[5], heapUsedMb: 200 };
    const v = assessTicketingAppLiveness({ readings: rows, nowMs: LAST_BEAT + 30_000 });
    expect(v.conditions).not.toContain('memory_rising');
  });
});

describe('(d) event-loop delay p99 over 1s for 3 minutes', () => {
  function delaySeries(p99: number, count: number): HeartbeatReading[] {
    const rows: HeartbeatReading[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(
        beat({
          recordedAtMs: LAST_BEAT - i * 60_000,
          eventLoopDelayP99Ms: p99,
        }),
      );
    }
    return rows;
  }

  it('fires when p99 stays over 1s across 3 minutes', () => {
    const v = assessTicketingAppLiveness({
      readings: delaySeries(EVENT_LOOP_P99_MS + 50, 4),
      nowMs: LAST_BEAT + 30_000,
    });
    expect(v.conditions).toContain('event_loop_delay');
  });

  it('does not fire on a single slow sample', () => {
    const v = assessTicketingAppLiveness({
      readings: delaySeries(EVENT_LOOP_P99_MS + 50, 1),
      nowMs: LAST_BEAT + 30_000,
    });
    expect(v.conditions).not.toContain('event_loop_delay');
  });

  it('does not fire when a recent sample is healthy', () => {
    const rows = delaySeries(EVENT_LOOP_P99_MS + 50, 4);
    rows[0] = { ...rows[0], eventLoopDelayP99Ms: 20 };
    const v = assessTicketingAppLiveness({ readings: rows, nowMs: LAST_BEAT + 30_000 });
    expect(v.conditions).not.toContain('event_loop_delay');
  });
});

describe('debounce and recovery', () => {
  const alerting = assessTicketingAppLiveness(snapshot());
  const healthy = assessTicketingAppLiveness(snapshot({ nowMs: LAST_BEAT + 30_000 }));

  it('alerts on the first enter, then stays quiet on the same conditions', () => {
    expect(nextLivenessAction([], alerting)).toBe('alert');
    expect(nextLivenessAction(alerting.conditions, alerting)).toBe('quiet');
  });

  it('sends a recovery note when the conditions clear', () => {
    expect(nextLivenessAction(alerting.conditions, healthy)).toBe('recover');
    expect(nextLivenessAction([], healthy)).toBe('quiet');
  });

  it('re-alerts when a new condition appears while already alerting', () => {
    const heapAndStale = assessTicketingAppLiveness(
      snapshot({
        readings: [beat({ heapUsedMb: 1200, heapLimitMb: 1400 })],
      }),
    );
    expect(heapAndStale.conditions).toEqual(expect.arrayContaining(['stale', 'heap_high']));
    expect(nextLivenessAction(['stale'], heapAndStale)).toBe('alert');
  });
});

describe('the reader stays off HTTP', () => {
  it('reads TICKETING_APP_DATABASE_URL and app_heartbeat, not a health URL', () => {
    const src = readFileSync(new URL('./ticketingAppLiveness.ts', import.meta.url), 'utf8');
    const reader = src.slice(src.indexOf('export async function readTicketingAppLivenessSnapshot'));
    expect(reader).toMatch(/TICKETING_APP_DATABASE_URL/);
    expect(reader).toMatch(/FROM app_heartbeat/);
    expect(reader).not.toMatch(/fetch\(/);
    expect(reader).not.toMatch(/\/api\/health/);
  });
});
