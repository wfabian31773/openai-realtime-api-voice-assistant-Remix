/**
 * Shadow observability (Checkpoint 20): counters, gauges, JSON logs, and the
 * operational report. Sensitive values never reach these surfaces — inputs are
 * already redacted upstream.
 */

class Metrics {
  counters = new Map<string, number>();
  gauges = new Map<string, number>();
  labeled = new Map<string, Map<string, number>>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }
  setLabeled(name: string, label: string, by = 1, increment = false): void {
    let m = this.labeled.get(name);
    if (!m) {
      m = new Map();
      this.labeled.set(name, m);
    }
    m.set(label, increment ? (m.get(label) ?? 0) + by : by);
  }
  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      labeled: Object.fromEntries([...this.labeled].map(([k, v]) => [k, Object.fromEntries(v)])),
    };
  }
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.labeled.clear();
  }
}

export const metrics = new Metrics();

export function shadowLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), component: 'shadow', level, event, ...fields });
    if (level === 'error') console.error(`[SHADOW] ${line}`);
    else if (level === 'warn') console.warn(`[SHADOW] ${line}`);
    else console.info(`[SHADOW] ${line}`);
  } catch {
    /* logging must never throw */
  }
}

export interface OperationalReportInput {
  tapCounters: { emitted: number; sampledOut: number; dropped: number; consumerErrors: number; invalid: number };
  activeSessions: number;
  reviewQueueDepth: number;
  budgetSnapshot: Record<string, unknown>;
  verdictCounts: Record<string, number>;
}

/** Answers the Checkpoint 20 operational questions from current counters. */
export function buildOperationalReport(input: OperationalReportInput): Record<string, unknown> {
  const c = metrics.counters;
  const g = metrics.gauges;
  const started = c.get('sessions_started') ?? 0;
  const completed = c.get('sessions_completed') ?? 0;
  const turns = c.get('turns_compared') ?? 0;
  const review = c.get('turns_review_required') ?? 0;
  return {
    generatedAt: new Date().toISOString(),
    healthy:
      (c.get('pipeline_errors') ?? 0) < Math.max(10, turns * 0.05) &&
      input.tapCounters.dropped < Math.max(10, input.tapCounters.emitted * 0.05),
    ingestion: {
      eventsIngested: c.get('events_ingested') ?? 0,
      duplicatesIgnored: c.get('duplicate_events_ignored') ?? 0,
      dropped: input.tapCounters.dropped,
      lagMs: g.get('event_lag_ms') ?? 0,
      queueDepthNow: 0,
    },
    coverage: {
      sessionsStarted: started,
      sessionsCompleted: completed,
      captureNote: 'capture % is config-driven; sampledOut counts non-captured emits',
      sampledOut: input.tapCounters.sampledOut,
    },
    quality: {
      turnsCompared: turns,
      reviewRequiredPct: turns ? Math.round((review / turns) * 100) : 0,
      verdicts: input.verdictCounts,
      loopSignals: c.get('loop_signals') ?? 0,
      modelTiers: Object.fromEntries(metrics.labeled.get('model_tier_selected') ?? []),
      pipelineErrors: c.get('pipeline_errors') ?? 0,
      spoolErrors: c.get('spool_errors') ?? 0,
    },
    n8n: input.budgetSnapshot,
    reviewQueueDepth: input.reviewQueueDepth,
    activeSessions: input.activeSessions,
  };
}
