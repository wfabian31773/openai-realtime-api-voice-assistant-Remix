/**
 * THE TURN TABLE — one row per turn, everything about that turn side by side.
 *
 * Operator, 2026-08-05: "If we were debugging this sitting next to each other,
 * I just want a table for every turn: raw transcript, final transcript,
 * structured state, director's decision, model output. When a call goes
 * sideways, you open that table, scroll to turn 7, and you can see where it
 * went wrong. You're not missing intelligence, you're missing instrumentation.
 * Without that, every fix is just a guess."
 *
 * That is exactly right, and it is what the last three days demonstrated. Every
 * defect found since Monday was found by reading transcript prose and inferring
 * what the system must have believed — the identity chimera, the disclosure
 * false positives, the 219 dead calls. Each took hours of queries to establish
 * something a single row would have shown at a glance.
 *
 * The specific gap: what the system BELIEVED at a given turn was recorded
 * nowhere. call_logs.transcript has the words. tool_timeline has the tool
 * calls. tool_timeline.director has the rulings. None of them are aligned to
 * each other and none carry the state, so "at turn 7, did we think we knew this
 * caller's name?" was unanswerable after the fact.
 *
 * CONVERSATION CONSTANTS. The state column carries the fields that persist for
 * the whole call and that every downstream gate keys on — first name, last
 * name, date of birth, intent, identity verification — as PRESENCE and FLAGS,
 * never values. Whether we have a surname is the debugging question; what the
 * surname is lives in the transcript columns and nowhere else.
 *
 * Buffered in memory and written at call end, like toolTimeline: this sits
 * beside a live conversation and must never add latency to it.
 */

import { db } from '../../server/db';
import { callTurns } from '../../shared/schema';

export interface TurnState {
  /** Identity fields the system believes it has. NAMES ONLY, never values. */
  known: string[];
  /** verify_patient_identity returned verified:true. The authoritative flag. */
  identityVerified: boolean;
  /** How many identity questions have been asked. The 219 died here. */
  identityAsks: number;
  /** Running intent, as classified. */
  intent?: string | null;
}

export interface TurnRecord {
  turnIndex: number;
  role: 'caller' | 'agent';
  at: string;
  rawTranscript: string;
  finalTranscript: string;
  state: TurnState;
  directorDecision: Record<string, unknown> | null;
  modelOutput: Record<string, unknown> | null;
  sincePrevMs: number | null;
}

interface CallBuffer {
  turns: TurnRecord[];
  callSid?: string;
  callLogId?: string;
  agentSlug?: string;
  lastAt: number;
  startedAt: number;
  flushedCount: number;
}

const buffers = new Map<string, CallBuffer>();

/** Hard ceiling per call. A stuck session must not grow without bound — the
 *  longest call on record ran 3h16m and would have buffered thousands. */
const MAX_TURNS = 400;

function bufferFor(callId: string, ids?: { callSid?: string; callLogId?: string; agentSlug?: string }): CallBuffer {
  let b = buffers.get(callId);
  if (!b) {
    b = { turns: [], lastAt: Date.now(), startedAt: Date.now(), flushedCount: 0 };
    buffers.set(callId, b);
  }
  if (ids?.callSid) b.callSid = ids.callSid;
  if (ids?.callLogId) b.callLogId = ids.callLogId;
  if (ids?.agentSlug) b.agentSlug = ids.agentSlug;
  return b;
}

/**
 * Record one turn. Never throws, never awaits anything — this is called from
 * the transcript handlers while a caller is on the line.
 */
export function recordTurn(
  callId: string,
  role: 'caller' | 'agent',
  transcript: string,
  extra: {
    state: TurnState;
    directorDecision?: Record<string, unknown> | null;
    modelOutput?: Record<string, unknown> | null;
    callSid?: string;
    callLogId?: string;
    agentSlug?: string;
  },
): void {
  try {
    if (!callId) return;
    const b = bufferFor(callId, extra);
    if (b.turns.length >= MAX_TURNS) return;
    const now = Date.now();
    b.turns.push({
      turnIndex: b.turns.length + 1,
      role,
      at: new Date(now).toISOString(),
      rawTranscript: transcript,
      // Equal today. The column exists so that when transcript correction is
      // added, the two can be compared rather than one silently replacing the
      // other — which is how the 'Amani' mis-transcription became a keyword.
      finalTranscript: transcript,
      state: extra.state,
      directorDecision: extra.directorDecision ?? null,
      modelOutput: extra.modelOutput ?? null,
      sincePrevMs: b.turns.length === 0 ? null : now - b.lastAt,
    });
    b.lastAt = now;

    /**
     * INCREMENTAL FLUSH — added 2026-08-13, after measuring what "write at
     * call end" actually cost.
     *
     * 11–17% of that day's real calls (45s+, full transcript in call_logs)
     * had ZERO rows in this table. The transcript survives because the
     * coordinator persists it incrementally; the turns buffered in THIS
     * process and the operator republished four times that day. Every
     * restart silently discarded every in-flight buffer — and the grader
     * reads turns, so those calls looked empty to every downstream check
     * ("transcript_coverage" flagged 16% of calls that were fine).
     *
     * A fire-and-forget insert every few turns adds no latency to the call
     * path — flushTurns is already idempotent by count, so the teardown
     * flush writes only what is new.
     */
    if (b.turns.length - b.flushedCount >= 6) void flushTurns(callId);
  } catch (e) {
    console.error('[TURN-LOG] record failed:', e);
  }
}

/** Live view, for the call-detail page and for tests. */
export function getTurns(callId: string): TurnRecord[] {
  return buffers.get(callId)?.turns ?? [];
}

/**
 * Write the buffered turns. Idempotent by count, like flushAzulTimeline: a
 * second flush after late turns arrive writes only what is new.
 */
export async function flushTurns(callIdOrSid: string): Promise<void> {
  let key = callIdOrSid;
  let b = buffers.get(key);
  if (!b) {
    for (const [k, v] of buffers.entries()) {
      if (v.callSid === callIdOrSid || v.callLogId === callIdOrSid) { key = k; b = v; break; }
    }
  }
  if (!b || b.turns.length === b.flushedCount) return;

  const pending = b.turns.slice(b.flushedCount);
  try {
    await db.insert(callTurns).values(
      pending.map((t) => ({
        callLogId: b!.callLogId ?? null,
        callSid: b!.callSid ?? null,
        agentSlug: b!.agentSlug ?? null,
        turnIndex: t.turnIndex,
        role: t.role,
        at: new Date(t.at),
        rawTranscript: t.rawTranscript,
        finalTranscript: t.finalTranscript,
        state: t.state as unknown as Record<string, unknown>,
        directorDecision: t.directorDecision,
        modelOutput: t.modelOutput,
        sincePrevMs: t.sincePrevMs,
      })),
    );
    b.flushedCount = b.turns.length;
    console.info(`[TURN-LOG] wrote ${pending.length} turn(s) for ${b.callLogId ?? b.callSid ?? key}`);
  } catch (e) {
    // Losing the debugging record must never affect the call.
    console.error('[TURN-LOG] flush failed:', e);
  }
}

export function releaseTurns(callId: string | undefined): void {
  if (callId) buffers.delete(callId);
}

/** Reaper: anything older than 2h that never flushed. Mirrors toolTimeline. */
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, b] of buffers.entries()) {
    if (b.startedAt >= cutoff) continue;
    if (b.flushedCount === b.turns.length) buffers.delete(callId);
    else void flushTurns(callId).finally(() => buffers.delete(callId));
  }
}, 15 * 60 * 1000).unref?.();
