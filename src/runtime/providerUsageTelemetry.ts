/**
 * WHAT xAI REPORTED FOR THE CALL REACHES `call_events` (v273).
 *
 * Operator, 2026-11-25, after v272 found the conversation id had never been
 * kept: "Makes me wonder what else we are not tracking appropriately that is
 * made available from xai." The answer, read off a test socket and the
 * deployment log the same day:
 *
 * - `response.done` carries `response.usage` with `input_tokens`,
 *   `output_tokens` and `total_tokens` only, and a top-level `usage` with
 *   `output_audio_seconds` and `billable_audio_seconds`. The reader looked
 *   for a text/audio breakdown xAI never sends and logged "in 0 ... out 0"
 *   on every call; the top-level block was never read at all.
 * - Each response's `status` and `status_details`, and its id.
 *
 * One PHI-free row per call that finished at least one response: counts,
 * sums and short provider codes, never a transcript.
 *
 *   SELECT date_trunc('day', created_at) d, count(*),
 *          sum((data->>'billableAudioSeconds')::numeric) billable_s,
 *          sum((data->>'outputAudioSeconds')::numeric) audio_out_s
 *   FROM call_events WHERE message = 'provider_usage_summary' GROUP BY 1;
 *
 * Telemetry only: it changes nothing a caller hears, and a write that does
 * not land is one console line with the buffer left for the reaper.
 */
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";
import type { ProviderUsageSummary } from "./tokenUsage";

export const PROVIDER_USAGE_EVENT = "provider_usage_summary";

export interface ProviderUsageEvent {
  level: "info" | "warn";
  data: Record<string, unknown>;
}

/**
 * Null when no response finished on the call: there is nothing xAI reported.
 * Warns when a response ended other than completed, cancelled or
 * in progress (a failed or incomplete response is the provider's account of
 * something going wrong).
 */
export function providerUsageEvent(
  summary: ProviderUsageSummary | undefined,
  outcome: string,
): ProviderUsageEvent | null {
  if (!summary) return null;
  const unusual = Object.keys(summary.statuses).some(
    (s) => s !== "completed" && s !== "cancelled",
  );
  return {
    level: unusual ? "warn" : "info",
    data: {
      responses: summary.responses,
      statuses: summary.statuses,
      statusReasons: summary.statusReasons,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens,
      outputAudioSeconds: summary.outputAudioSeconds,
      billableAudioSeconds: summary.billableAudioSeconds,
      lastResponseId: summary.lastResponseId,
      outcome,
    },
  };
}

export async function logProviderUsage(
  call: { callSid: string; outcome: string },
  summary: ProviderUsageSummary | undefined,
  ids: { callLogId?: string } = {},
  opts: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** A predecessor writing to the SAME per-SID buffer: emit first, wait
     * only before flushing (the caller-audio writer's discipline). */
    after?: Promise<unknown>;
  } = {},
): Promise<boolean> {
  const ev = providerUsageEvent(summary, call.outcome);
  if (!ev) {
    if (opts.after) await opts.after.catch(() => undefined);
    return false;
  }
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(call.callSid, ev.level, "model", PROVIDER_USAGE_EVENT, ev.data, {
    callSid: call.callSid,
    callLogId: ids.callLogId,
  });
  if (opts.after) await opts.after.catch(() => undefined);

  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCallEvents(call.callSid)) {
      releaseCallEvents(call.callSid);
      return true;
    }
    if (attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  console.warn(
    `[TOKENS] the ${PROVIDER_USAGE_EVENT} row did not land for ${call.callSid} — left for the reaper`,
  );
  return false;
}
