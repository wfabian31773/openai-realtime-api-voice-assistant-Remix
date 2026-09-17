/**
 * THE FOLLOW-UP SUMMARY REACHES `call_events` — v55, task #146.
 *
 * One row per call that ever owed the model a turn after a tool, PHI-free:
 * how many were owed, how many requested, how many function-call events
 * arrived after their response's done, and whether the last request was
 * ever answered. `call_events` has existed since 2026-08-13 and the runtime
 * never wrote to it; this is its first runtime writer, chosen over a console
 * line because a console line is what left this class unmeasurable.
 *
 *   SELECT data->>'lastUnanswered', data->>'toolCallsAfterDone', count(*)
 *   FROM call_events WHERE category = 'model' AND message = 'follow_up_summary'
 *   GROUP BY 1, 2;
 *
 * Telemetry: after the row, after the sweep, never awaited by teardown, and
 * a failure is one console line — with the buffer kept for a retry, never
 * deleted on the failure that made it worth keeping.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";

export const FOLLOW_UP_EVENT = "follow_up_summary";

export interface FollowUpEvent {
  level: "info" | "warn";
  data: Record<string, unknown>;
}

/** Null when the call never owed a follow-up — nothing to say. */
export function followUpEvent(record: Pick<VoiceCallRecord, "followUps" | "outcome">): FollowUpEvent | null {
  const f = record.followUps;
  if (!f || f.owed === 0) return null;
  const suspicious = f.lastUnanswered || f.toolCallsAfterDone > 0;
  return {
    level: suspicious ? "warn" : "info",
    data: {
      owed: f.owed,
      requested: f.requested,
      toolCallsAfterDone: f.toolCallsAfterDone,
      lastUnanswered: f.lastUnanswered,
      outcome: record.outcome,
    },
  };
}

export async function logRuntimeFollowUps(
  record: VoiceCallRecord,
  ids: { callLogId?: string } = {},
  opts: { backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const ev = followUpEvent(record);
  if (!ev) return false;
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(record.callSid, ev.level, "model", FOLLOW_UP_EVENT, ev.data, {
    callSid: record.callSid,
    callLogId: ids.callLogId,
    agentSlug: record.slug,
  });
  /**
   * The buffer is released ONLY once the row is on disk. `flushCallEvents`
   * swallows a failed insert and hands the events back for a retry, so an
   * unconditional release here deleted the only copy of the summary on
   * precisely the calls a database blip had made unmeasurable (Codex P2,
   * #321 round 9) — the shape round 4 fixed in the turn writer. A summary
   * still unflushed after the last attempt is left for the 2h reaper, which
   * flushes once more before it forgets.
   */
  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let durable = false;
  for (let attempt = 0; ; attempt++) {
    durable = await flushCallEvents(record.callSid);
    if (durable || attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  if (durable) releaseCallEvents(record.callSid);
  else
    console.error(
      `[CALL-EVENTS] follow_up_summary for ${record.callSid} not durable after ${backoff.length + 1} attempt(s) — buffer left for the reaper`,
    );
  return durable;
}
