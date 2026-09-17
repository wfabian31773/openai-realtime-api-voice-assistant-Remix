/**
 * src/runtime/runtimeGrading.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * GRADE A RUNTIME CALL WHEN IT ENDS — the way the old core has always done.
 *
 * MEASURED 2026-09-17. The old core calls `callGradingService.gradeCall` at
 * teardown (`voiceAgentRoutes.ts`, "Grade the call if we have a substantive
 * transcript"). The runtime never did: nothing under src/runtime/ imports the
 * grader, so every runtime call was graded ONLY by the five-minute backfill,
 * five rows per cycle, newest first — 60 an hour against 90–98 substantive
 * calls an hour at peak. On 2026-09-16 the average gap from hangup to grade
 * was 3.5 minutes at 15:00 UTC and 161–203 minutes from 16:00 to 18:00, and
 * the hourly fleet watch — which reads `agent_outcome` — alarmed on a third
 * of the fleet reading NULL (task #139). It was a queue, not a failure; but
 * a queue that lags the fleet watch by three hours is a fleet watch that
 * cannot see the last three hours.
 *
 * So the runtime grades at teardown, AFTER the row and AFTER the sweep and
 * never awaited, with the old core's own threshold (a transcript over 200
 * characters — greeting-only calls are not worth an LLM call). The backfill
 * stays, for the calls this misses.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";

/** The old core's threshold, verbatim: `finalTranscript.length > 200`. */
export const GRADE_TRANSCRIPT_MIN_CHARS = 200;

export function shouldGradeAtTeardown(record: Pick<VoiceCallRecord, "transcript">): boolean {
  return (record.transcript ?? "").length > GRADE_TRANSCRIPT_MIN_CHARS;
}

export type TeardownGrade = "graded" | "skipped" | "failed";

export async function gradeRuntimeCall(
  record: VoiceCallRecord,
  ids: { callLogId?: string },
): Promise<TeardownGrade> {
  if (!ids.callLogId || !shouldGradeAtTeardown(record)) return "skipped";
  // Lazy, like every database-touching import on the runtime: the grader
  // pulls in server/storage, which validates DATABASE_URL at load.
  const { callGradingService } = await import("../services/callGradingService");
  const result = await callGradingService.gradeCall(ids.callLogId, record.transcript);
  return result ? "graded" : "failed";
}
