/**
 * THE PER-CALL EVENT LOG — every notable thing that happened, timestamped,
 * in one table a UI can replay.
 *
 * Operator, 2026-08-13, looking at Vapi's per-call view: "I want something
 * more like vapi has... If we are not doing something now that prevents us
 * from getting this grain of detailed data then I want it implemented as part
 * of the build."
 *
 * What Vapi shows per call that we did not capture:
 *   - a LOG STREAM (their Logs tab): session lifecycle, transcriber events,
 *     model turns, tool calls, errors — each with level + category + time
 *   - PER-TURN LATENCY COMPONENTS (their Latency Summary): how long the
 *     transcriber took, how long the model took to first token, how long the
 *     voice took — not just one end-to-end number
 *
 * We had the raw signals all along: every one of these moments already passes
 * through the `session.transport.on('*')` handler. They went to console.log
 * and died there. This module gives them a table.
 *
 * DESIGN RULES, inherited from turnLog/toolTimeline and non-negotiable:
 *   - Buffered in memory, flushed at teardown AND incrementally. This sits
 *     beside a live call and must never add latency to it.
 *   - Never throws. Losing an event must never affect the call.
 *   - PHI-SAFE: event messages carry SHAPES (char counts, tool names, codes),
 *     never transcript text. The words live in call_turns, which has its own
 *     handling. An event log is the one most likely to be eyeballed casually.
 *   - CREATE TABLE IF NOT EXISTS on first flush: this ships as code, and the
 *     table must exist whether or not anyone remembered `npm run db:push`.
 *     A missing table would otherwise silently eat every flush — the exact
 *     "zero means not instrumented" trap this system keeps refinding.
 */

import { db } from '../../server/db';
import { sql } from 'drizzle-orm';

export type EventLevel = 'info' | 'warn' | 'error';
export type EventCategory =
  | 'session'
  | 'vad'
  | 'transcriber'
  | 'model'
  | 'tool'
  | 'director'
  | 'transcript'
  | 'handoff'
  | 'system';

interface CallEvent {
  at: string;
  level: EventLevel;
  category: EventCategory;
  message: string;
  data: Record<string, unknown> | null;
}

interface EventBuffer {
  events: CallEvent[];
  callSid?: string;
  callLogId?: string;
  agentSlug?: string;
  startedAt: number;
  flushedCount: number;
  /** True once we have dropped events on the cap, so the UI can say so. */
  truncated: boolean;
}

const buffers = new Map<string, EventBuffer>();

/** A stuck 3-hour session must not buffer without bound. 600 rows is roughly
 *  a 20-minute call at full chatter; beyond that we keep errors only. */
const MAX_EVENTS = 600;

/** Flush this many pending rows without waiting for teardown. Restarts are the
 *  documented killer: on 2026-08-13, 11–17% of real calls had a full
 *  transcript and ZERO turn rows, because Wayne republished mid-day and every
 *  in-flight per-process buffer died with the old process. */
const INCREMENTAL_FLUSH_AT = 25;

function bufferFor(callId: string, ids?: { callSid?: string; callLogId?: string; agentSlug?: string }): EventBuffer {
  let b = buffers.get(callId);
  if (!b) {
    b = { events: [], startedAt: Date.now(), flushedCount: 0, truncated: false };
    buffers.set(callId, b);
  }
  if (ids?.callSid) b.callSid = ids.callSid;
  if (ids?.callLogId) b.callLogId = ids.callLogId;
  if (ids?.agentSlug) b.agentSlug = ids.agentSlug;
  return b;
}

/** Record one event. Never throws, never awaits — called from the live path. */
export function emitCallEvent(
  callId: string | undefined,
  level: EventLevel,
  category: EventCategory,
  message: string,
  data?: Record<string, unknown> | null,
  ids?: { callSid?: string; callLogId?: string; agentSlug?: string },
): void {
  try {
    if (!callId) return;
    const b = bufferFor(callId, ids);
    if (b.events.length >= MAX_EVENTS) {
      // Keep errors — the cap must never hide the reason a call died.
      if (level !== 'error') {
        if (!b.truncated) {
          b.truncated = true;
          b.events.push({
            at: new Date().toISOString(),
            level: 'warn',
            category: 'system',
            message: `event cap reached (${MAX_EVENTS}) — further non-error events dropped`,
            data: null,
          });
        }
        return;
      }
    }
    b.events.push({ at: new Date().toISOString(), level, category, message, data: data ?? null });
    if (b.events.length - b.flushedCount >= INCREMENTAL_FLUSH_AT) void flushCallEvents(callId);
  } catch (e) {
    console.error('[CALL-EVENTS] emit failed:', e);
  }
}

/** Live view for the call-detail page while the call is still up. */
export function getCallEvents(callId: string): CallEvent[] {
  return buffers.get(callId)?.events ?? [];
}

// ---------------------------------------------------------------- latency

/**
 * PER-TURN LATENCY CLOCKS.
 *
 * The realtime stream tells us every boundary; we just never kept the
 * timestamps. Marks per call, reset as each response cycle completes:
 *
 *   speech_stopped   caller stopped talking (VAD)
 *   transcript_done  their words became text        → transcriber time
 *   response_created model started thinking
 *   first_audio      first audio byte of the reply  → model time-to-first-sound
 *   response_done    reply finished                 → voice/streaming time
 *
 * Named for what they MEASURE on our stack, not for Vapi's six boxes — we are
 * one websocket to OpenAI, so "From Transport / To Transport" have no honest
 * equivalent here and are deliberately absent rather than invented.
 */
interface LatencyClock {
  speechStoppedAt?: number;
  transcriptDoneAt?: number;
  responseCreatedAt?: number;
  firstAudioAt?: number;
  responseDoneAt?: number;
}

const clocks = new Map<string, LatencyClock>();

export function markLatency(
  callId: string,
  mark: 'speech_stopped' | 'transcript_done' | 'response_created' | 'first_audio' | 'response_done',
): void {
  try {
    let c = clocks.get(callId);
    if (!c) {
      c = {};
      clocks.set(callId, c);
    }
    const now = Date.now();
    if (mark === 'speech_stopped') {
      // A new caller turn restarts the cycle.
      clocks.set(callId, { speechStoppedAt: now });
    } else if (mark === 'transcript_done') c.transcriptDoneAt = now;
    else if (mark === 'response_created') {
      c.responseCreatedAt = now;
      c.firstAudioAt = undefined;
      c.responseDoneAt = undefined;
    } else if (mark === 'first_audio') {
      if (!c.firstAudioAt) c.firstAudioAt = now;
    } else if (mark === 'response_done') c.responseDoneAt = now;
  } catch {
    /* never the call's problem */
  }
}

export interface TurnLatency {
  /** speech_stopped → transcript_done. What the caller waits through first. */
  transcriberMs?: number;
  /** transcript_done → response_created. Endpointing + our plumbing. */
  endpointingMs?: number;
  /** response_created → first audio byte. The model, to first sound. */
  modelFirstAudioMs?: number;
  /** first audio → response_done. Voice generation and streaming. */
  voiceMs?: number;
  /** speech_stopped → first audio. The silence the caller actually hears. */
  callerWaitMs?: number;
}

const span = (a?: number, b?: number): number | undefined =>
  a !== undefined && b !== undefined && b >= a ? b - a : undefined;

/**
 * The components for the turn that just finished. Reads without clearing —
 * a response.done and the transcript.done that follows both want it.
 *
 * `atMs` is the moment the caller ACTUALLY heard the reply complete. The
 * snapshot for a turn is taken on `response.audio_transcript.done`, which
 * fires BEFORE `response.done` — so `responseDoneAt` is still unset at that
 * point and `voiceMs` came back empty on every single turn of the first live
 * night. Measured 2026-08-14: 51 of 51 agent turns had transcriber and
 * endpointing populated and voice/model/callerWait blank.
 *
 * Passing the call site's own clock closes it honestly: the transcript
 * finishing IS when the spoken reply finished being produced.
 */
export function turnLatencySnapshot(callId: string, atMs: number = Date.now()): TurnLatency | null {
  const c = clocks.get(callId);
  if (!c) return null;
  const doneAt = c.responseDoneAt ?? atMs;
  const out: TurnLatency = {
    transcriberMs: span(c.speechStoppedAt, c.transcriptDoneAt),
    endpointingMs: span(c.transcriptDoneAt, c.responseCreatedAt),
    modelFirstAudioMs: span(c.responseCreatedAt, c.firstAudioAt),
    voiceMs: span(c.firstAudioAt, doneAt),
    callerWaitMs: span(c.speechStoppedAt, c.firstAudioAt),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

// ---------------------------------------------------------------- persistence

let tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS call_events (
      id BIGSERIAL PRIMARY KEY,
      call_log_id VARCHAR,
      call_sid VARCHAR,
      agent_slug VARCHAR,
      at TIMESTAMP NOT NULL,
      level VARCHAR(8) NOT NULL,
      category VARCHAR(24) NOT NULL,
      message TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS call_events_call_sid_idx ON call_events (call_sid)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS call_events_call_log_id_idx ON call_events (call_log_id)`);
  tableEnsured = true;
}

/**
 * Write pending events. Idempotent by count, like flushTurns. Resolves TRUE
 * once nothing is left unflushed for this call. A failed insert is caught
 * here, the events handed back for a retry, and FALSE returned, so the caller
 * can choose between retrying and leaving the buffer for the reaper — a
 * caller that released on the old void return deleted the only copy of what
 * it had just failed to write (Codex P2, #321 round 9).
 */
export async function flushCallEvents(callIdOrSid: string): Promise<boolean> {
  let key = callIdOrSid;
  let b = buffers.get(key);
  if (!b) {
    for (const [k, v] of buffers.entries()) {
      if (v.callSid === callIdOrSid || v.callLogId === callIdOrSid) {
        key = k;
        b = v;
        break;
      }
    }
  }
  if (!b || b.events.length === b.flushedCount) return true;

  const pending = b.events.slice(b.flushedCount);
  const claimedFrom = b.flushedCount;
  // Claim before the await so a concurrent incremental flush cannot write the
  // same rows twice; roll back on failure so teardown retries them.
  b.flushedCount = b.events.length;
  try {
    await ensureTable();
    const values = pending
      .map(
        (e) =>
          sql`(${b!.callLogId ?? null}, ${b!.callSid ?? null}, ${b!.agentSlug ?? null}, ${e.at}::timestamptz AT TIME ZONE 'UTC', ${e.level}, ${e.category}, ${e.message}, ${e.data ? JSON.stringify(e.data) : null}::jsonb)`,
      )
      .reduce((acc, v) => (acc ? sql`${acc}, ${v}` : v), null as ReturnType<typeof sql> | null);
    await db.execute(
      sql`INSERT INTO call_events (call_log_id, call_sid, agent_slug, at, level, category, message, data) VALUES ${values}`,
    );
    return true;
  } catch (e) {
    b.flushedCount = claimedFrom;
    console.error('[CALL-EVENTS] flush failed:', e);
    return false;
  }
}

/**
 * Forget a finished call's buffer — but NEVER the events nobody has written.
 *
 * THIS DELETED UNFLUSHED EVENTS, AND THE SECOND TEARDOWN WRITER MADE THAT A
 * SILENT LOSS ON THE COMMON CASE (Codex P1, #322 round 4). `buffers.delete`
 * took the WHOLE per-SID buffer, including events appended after the caller's
 * own flush had already claimed its slice — and `flushCallEvents` answers TRUE
 * for a call it cannot find, because from its side nothing is left unflushed.
 * So on every runtime call that owed a follow-up: the follow-up writer flushed
 * its own row, released the buffer, and took the `identity_summary` row that
 * had been emitted a microtask later with it; the identity writer's own flush
 * then found no buffer, reported durable, and the row was gone for good.
 *
 * Round 3's reply to that race said the reaper would recover the event, which
 * is true only of the predecessor that FAILS — a predecessor that SUCCEEDS
 * deleted the entry before any reaper could see it.
 *
 * A buffer with unwritten events is therefore kept: the next flush writes
 * them, and failing that the 2h reaper flushes once more before it forgets.
 * Indices are deliberately NOT trimmed — a flush in flight rolls `flushedCount`
 * back to the index it claimed from, and re-basing the array here would point
 * that rollback at the wrong events.
 *
 * ONE NARROWER CASE IS NOT CLOSED AND IS NOT THIS PR'S: a release that races a
 * flush already IN FLIGHT sees `events.length === flushedCount` (the claim is
 * taken before the await) and deletes the buffer, so a rollback on that
 * statement's failure lands on an object no longer in the map. It is
 * unreachable on the runtime — a runtime call emits two events, both at
 * teardown, and `INCREMENTAL_FLUSH_AT` is 25, so nothing else is ever flushing
 * — and on the old core it predates both teardown writers. Closing it needs an
 * in-flight count on the buffer, which is a change to every flush path.
 */
export function releaseCallEvents(callId: string | undefined): void {
  if (!callId) return;
  const b = buffers.get(callId);
  if (b && b.events.length > b.flushedCount) {
    // The latency marks are the call's and the call is over; the events are
    // the only thing that must outlive it.
    clocks.delete(callId);
    return;
  }
  buffers.delete(callId);
  clocks.delete(callId);
}

/** Reaper, mirroring turnLog: flush-and-drop anything stale. */
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, b] of buffers.entries()) {
    if (b.startedAt >= cutoff) continue;
    if (b.flushedCount === b.events.length) buffers.delete(callId);
    else void flushCallEvents(callId).finally(() => buffers.delete(callId));
  }
}, 15 * 60 * 1000).unref?.();
