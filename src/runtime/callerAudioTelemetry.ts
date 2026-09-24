/**
 * THE CALLER-AUDIO SUMMARY REACHES `call_events` — the optical barely-heard
 * instrument. See `callerAudioEnergy.ts` for the measurement that motivated
 * it and the four causes already ruled out.
 *
 * One row per call, PHI-free: frame counts and a verdict, never a byte of
 * audio and never a transcript. It answers the one question no query could,
 * because nothing on the runtime counted caller audio at all:
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
 * AND "EVERY CALL" MEANS THE FOUR EXITS, NOT JUST THE TEARDOWN (Codex P2,
 * #327). `voiceRuntime` persists a `call_logs` row on three paths that never
 * reach a bridge — an unknown or disabled lane, a caller who hangs up while
 * the agent is being built, and a setup failure before the bridge exists —
 * and the first version of this wrote from the bridge's teardown only. Those
 * three are PART OF the no-audio population this exists to size, so a claim
 * of one row per call that skipped exactly them would have been measuring the
 * calls least likely to be the problem.
 *
 * THE COUNTS COME FROM THE SOCKET, NOT FROM THE BRIDGE, for the same reason
 * and one more (Codex P2, #327): `voiceRuntime` holds up to
 * `PRE_BRIDGE_FRAME_CAP` frames while the agent is built and DISCARDS THE
 * OLDEST past that, so a caller who spoke during a slow start and went quiet
 * afterwards would have been counted `silent_line` — audio that reached this
 * server, reported as a line nobody spoke into, by the instrument built to
 * tell those two apart. Counting at ingress also means the three bridgeless
 * exits have counts to write.
 *
 * AN INSTRUMENT, NOT A FIX. It changes no gate, no tool, no spoken line and
 * nothing a caller can hear. That is deliberate and it is this repo's own
 * pattern for a number that has resisted several attempts (v47, v48, v58,
 * v61) — and v61 records a fix written and REVERTED for shipping onto a
 * population nobody could count.
 */
import { PERSIST_RETRY_BACKOFF_MS } from "./callRecord";
import type { CallerAudioCounts } from "./callerAudioEnergy";

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
  counts: CallerAudioCounts | undefined,
  outcome: string,
): CallerAudioEvent {
  // THE DEFAULT IS LOAD BEARING and mutation testing is what said so: a call
  // whose counts we do not have must read `no_frames` and never `voiced`,
  // because `voiced` on a zero-caller-line call is what accuses our own STT.
  const c = counts ?? { frames: 0, voiced: 0 };
  const verdict = callerAudioVerdict(c);
  return {
    level: verdict === "no_frames" ? "warn" : "info",
    data: {
      verdict,
      frames: c.frames,
      voiced: c.voiced,
      // The share is what makes two calls comparable when one ran four times
      // as long as the other. Integer percent — no false precision.
      voicedPct: c.frames > 0 ? Math.round((c.voiced * 100) / c.frames) : 0,
      outcome,
    },
  };
}

export async function logCallerAudio(
  /**
   * The call, by the two things this row names it with. Deliberately NOT a
   * `VoiceCallRecord`: three of the four exits that write a `call_logs` row
   * never build one, and they are part of the population being measured.
   */
  call: { callSid: string; outcome: string },
  /** What the SOCKET counted — see the module doc on why not the bridge. */
  counts: CallerAudioCounts | undefined,
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
  const ev = callerAudioEvent(counts, call.outcome);
  // Lazy, like every database-touching import on the runtime: callEventLog
  // pulls in server/db, which validates DATABASE_URL at load.
  const { emitCallEvent, flushCallEvents, releaseCallEvents } = await import("../services/callEventLog");
  emitCallEvent(call.callSid, ev.level, "vad", CALLER_AUDIO_EVENT, ev.data, {
    callSid: call.callSid,
    callLogId: ids.callLogId,
  });
  if (opts.after) await opts.after.catch(() => undefined);

  const backoff = opts.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The round-9 rule: release only on a flush that LANDED, so a database blip
  // cannot delete the only copy of the row it just made worth keeping. An
  // unflushed buffer is left for the 2h reaper.
  for (let attempt = 0; ; attempt += 1) {
    if (await flushCallEvents(call.callSid)) {
      releaseCallEvents(call.callSid);
      return true;
    }
    if (attempt >= backoff.length) break;
    await sleep(backoff[attempt]);
  }
  console.warn(
    `[CALLER AUDIO] the ${CALLER_AUDIO_EVENT} row did not land for ${call.callSid} — left for the reaper`,
  );
  return false;
}
