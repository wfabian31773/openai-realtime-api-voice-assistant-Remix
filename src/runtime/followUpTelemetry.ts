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
 * a failure is one console line.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";

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
  try {
    await flushCallEvents(record.callSid);
  } finally {
    releaseCallEvents(record.callSid);
  }
  return true;
}
