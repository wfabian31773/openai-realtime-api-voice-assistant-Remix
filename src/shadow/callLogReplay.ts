/**
 * Replay a STORED production call (call_logs row) through the shadow engine.
 *
 * Powers the "Shadow Agent Review" card on the call-details page: any past
 * call with a transcript can be analyzed retroactively, even before live
 * shadow capture was enabled. Observation-only — reads the stored row it is
 * given; performs no I/O of its own.
 *
 * Fidelity notes (surfaced to the UI as `approximations`):
 *  - transcript lines carry no timestamps, so tool-timeline events are
 *    attributed to caller turns proportionally by their timestamp within the
 *    call window (fallback: appended before completion);
 *  - n8n gateway request/response pairs are not stored on call_logs, so n8n
 *    comparison is skipped for stored-call replays.
 */
import { replayEvents, fixtureToEvents, type FixtureSession, type ReplayResult } from './replayHarness';

/** The subset of a call_logs row the replay needs (camelCase, as served by storage). */
export interface StoredCallLogLike {
  id: string | number;
  agentUsed?: string | null;
  agentId?: string | null;
  transcript?: string | null;
  toolTimeline?: unknown;
  createdAt?: string | Date | null;
  duration?: number | null;
  status?: string | null;
}

const KNOWN_SLUGS = new Set([
  'no-ivr', 'dev-no-ivr', 'after-hours', 'answering-service', 'azul-scheduling',
  'appointment-confirmation', 'drs-scheduler', 'fantasy-football',
]);

/** Mirror production's slug coercion (routes :1390-1399) incl. the ticket vocabulary. */
export function normalizeAgentSlug(raw: string | null | undefined): string {
  const slug = (raw ?? '').trim();
  if (slug === 'urgent-triage') return 'after-hours';
  if (KNOWN_SLUGS.has(slug)) return slug;
  return 'after-hours';
}

interface TimelineEvent {
  at?: string;
  tool?: string;
  args?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  ms?: number;
}

function extractTimelineEvents(toolTimeline: unknown): TimelineEvent[] {
  if (!toolTimeline) return [];
  const raw = toolTimeline as Record<string, unknown> | TimelineEvent[];
  const events = Array.isArray(raw) ? raw : (raw.events as TimelineEvent[] | undefined) ?? [];
  return events.filter((e) => e && typeof e.tool === 'string');
}

export interface CallLogFixtureResult {
  fixture: FixtureSession;
  approximations: string[];
}

/** Convert a stored call log into the replay fixture format. */
export function callLogToFixture(log: StoredCallLogLike): CallLogFixtureResult | null {
  const transcript = log.transcript ?? '';
  if (transcript.trim().length === 0) return null;
  const approximations: string[] = [];

  // Parse CALLER:/AGENT: lines; continuation lines attach to the previous speaker.
  const turns: FixtureSession['turns'] = [];
  let last: { kind: 'caller' | 'agent'; text: string } | null = null;
  const flush = () => {
    if (!last) return;
    turns.push(last.kind === 'caller' ? { caller: last.text } : { agent: last.text });
    last = null;
  };
  for (const line of transcript.split('\n')) {
    const m = line.match(/^\s*(CALLER|AGENT):\s?(.*)$/);
    if (m) {
      flush();
      last = { kind: m[1] === 'CALLER' ? 'caller' : 'agent', text: m[2] };
    } else if (last && line.trim()) {
      last.text += ' ' + line.trim();
    }
  }
  flush();
  if (!turns.some((t) => 'caller' in t)) return null;

  // Interleave tool events by proportional timestamp within the call window.
  const timeline = extractTimelineEvents(log.toolTimeline);
  if (timeline.length > 0) {
    const startMs = log.createdAt ? new Date(log.createdAt).getTime() : NaN;
    const durationMs = (log.duration ?? 0) * 1000;
    const callerPositions: number[] = [];
    turns.forEach((t, i) => {
      if ('caller' in t) callerPositions.push(i);
    });
    const placeable = Number.isFinite(startMs) && durationMs > 0 && callerPositions.length > 0;
    if (!placeable) {
      approximations.push('tool events appended at end (no usable call timing)');
    } else {
      approximations.push('tool events attributed to turns proportionally by timestamp');
    }
    // Insert from the last event backwards so earlier indices stay valid.
    const withTargets = timeline.map((e) => {
      let ordinal = callerPositions.length - 1;
      if (placeable && e.at) {
        const t = new Date(e.at).getTime();
        if (Number.isFinite(t)) {
          const frac = Math.min(1, Math.max(0, (t - startMs) / durationMs));
          ordinal = Math.min(callerPositions.length - 1, Math.floor(frac * callerPositions.length));
        }
      }
      return { e, ordinal };
    });
    for (const { e, ordinal } of withTargets.reverse()) {
      const failed = Boolean(e.outcome && (e.outcome as Record<string, unknown>).error);
      const insertAt = (callerPositions[ordinal] ?? turns.length - 1) + 1;
      turns.splice(Math.min(insertAt, turns.length), 0, {
        tool: e.tool as string,
        args: e.args ?? {},
        result: e.outcome ?? (failed ? { error: 'failed' } : { ok: true }),
        failed,
        ms: e.ms ?? 0,
      });
    }
  } else {
    approximations.push('no tool timeline stored for this call (pre-2026-08-01 calls lack fleet-wide timelines)');
  }
  approximations.push('n8n gateway traffic is not stored on call logs; n8n comparison skipped');

  return {
    fixture: {
      sessionId: `calllog-${log.id}`,
      agentId: normalizeAgentSlug(log.agentUsed ?? log.agentId),
      turns,
      outcome: log.status ?? 'completed',
    },
    approximations,
  };
}

export interface CallLogReplayResult extends ReplayResult {
  approximations: string[];
}

export async function replayCallLog(log: StoredCallLogLike): Promise<CallLogReplayResult | null> {
  const converted = callLogToFixture(log);
  if (!converted) return null;
  const result = await replayEvents(fixtureToEvents(converted.fixture));
  return { ...result, approximations: converted.approximations };
}
