/**
 * THE CALLER-AUDIO SUMMARY REACHES `call_events` — the optical barely-heard
 * instrument. See `callerAudioEnergy.ts` for the measurement that motivated
 * it and the four causes already ruled out.
 *
 * One row per call, PHI-free: frame counts and a verdict, never a byte of
 * audio and never a transcript. It answers the one question no query could,
 * because `handleTwilioFrame` passed caller audio straight through without
 * counting it:
 *
 *   SELECT data->>'verdict', count(*)
 *   FROM call_events
 *   WHERE category = 'vad' AND message = 'caller_audio_summary'
 *   GROUP BY 1;
 *
 * and, joined to the lane, the thing that actually splits optical from tech:
 *
 *   -- of the calls whose transcript held NO caller line, how many were an
 *   -- open line nobody spoke into, and how many did we simply not hear?
 *   SELECT c.agent_used, e.data->>'verdict', count(*)
 *   FROM call_events e JOIN call_logs c ON c.call_sid = e.call_sid
 *   WHERE e.message = 'caller_audio_summary' AND c.duration >= 30
 *     AND (length(c.transcript) - length(replace(c.transcript,'CALLER:','')))/7 = 0
 *   GROUP BY 1, 2 ORDER BY 1, 3 DESC;
 *
 * EVERY CALL WRITES A ROW, unlike `follow_up_summary` which skips a call that
 * owed nothing. Here "there was no caller audio at all" IS the finding, so a
 * skip would hide exactly the population being measured — the v58 identity
 * summary made the same choice for the same reason.
 *
 * AN INSTRUMENT, NOT A FIX. It changes no gate, no tool, no spoken line and
 * nothing a caller can hear. That is deliberate and it is this repo's own
 * pattern for a number that has resisted several attempts (v47, v48, v58,
 * v61) — and v61 records a fix written and REVERTED for shipping onto a
 * population nobody could count.
 */
import type { VoiceCallRecord } from "./mediaStreamBridge";
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";

export const CALLER_AUDIO_EVENT = "caller_audio_summary";

/**
 * What the counts say happened to the caller's side of the call.
 *
 * - `no_frames`      Twilio delivered no caller media at all. The leg never
 *                    really carried audio; nothing about our STT is implied.
 * - `silent_line`    Frames arrived and none reached speech loudness. An open
 *                    line nobody spoke into — a muted caller, an abandoned
 *                    leg, an auto-dialer that never played anything.
 * - `voiced`         Frames arrived carrying speech-loud audio. Whether we
 *                    TRANSCRIBED it is a separate column on `call_logs`, and
 *                    the join above is the whole point: `voiced` on a call
 *                    with zero CALLER: lines means WE did not hear a caller
 *                    who was speaking.
 */
export type CallerAudioVerdict = "no_frames" | "silent_line" | "voiced";

export interface CallerAudioEvent {
  level: "info" | "warn";
  data: Record<string, unknown>;
}

export function callerAudioVerdict(counts: { frames: number; voiced: number }): CallerAudioVerdict {
  if (counts.frames === 0) return "no_frames";
  return counts.voiced > 0 ? "voiced" : "silent_line";
}

/**
 * Never null: every call has an answer here, including "no audio arrived".
 *
 * `no_frames` warns because a media stream that carried nothing is a
 * transport question rather than a caller's choice. `silent_line` is info —
 * on a business line it is ordinary and common.
 */
export function callerAudioEvent(
  record: Pick<VoiceCallRecord, "callerAudio" | "outcome">,
): CallerAudioEvent {
  const counts = record.callerAudio ?? { frames: 0, voiced: 0 };
  const verdict = callerAudioVerdict(counts);
  return {
    level: verdict === "no_frames" ? "warn" : "info",
    data: {
      verdict,
      frames: counts.frames,
      voiced: counts.voiced,
      // The share is what makes two calls comparable when one ran four times
      // as long as the other. Integer percent — no false precision.
      voicedPct: counts.frames > 0 ? Math.round((counts.voiced * 100) / counts.frames) : 0,
      outcome: record.outcome,
    },
  };
}

export async function logCallerAudio(
  record: VoiceCallRecord,
  ids: { callLogId?: string } = {},
  opts: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /**
     * A predecessor writing to the SAME per-SID buffer. Emit FIRST and wait
     * only before flushing — the identity writer's discipline (#322 round 3
     * and round 4), and for its reasons: a wedged pool must not stop this row
     * being BUFFERED, because the 2h reaper can recover what is emitted and
     * can never recover what was never emitted at all; and two writers must
     * not flush and release one buffer at once.
     */
    after?: Promise<unknown>;
  } = {},
): Promise<boolean> {
  const ev = callerAudioEvent(record);
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(record.callSid, ev.level, "vad", CALLER_AUDIO_EVENT, ev.data, {
    callSid: record.callSid,
    callLogId: ids.callLogId,
  });
  if (opts.after) await opts.after.catch(() => undefined);

  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The round-9 rule: release only on a flush that LANDED, so a database blip
  // cannot delete the only copy of the row it just made worth keeping. An
  // unflushed buffer is left for the 2h reaper.
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCallEvents(record.callSid)) {
      releaseCallEvents(record.callSid);
      return true;
    }
    if (attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  console.warn(
    `[CALLER AUDIO] the ${CALLER_AUDIO_EVENT} row did not land for ${record.callSid} — left for the reaper`,
  );
  return false;
}
