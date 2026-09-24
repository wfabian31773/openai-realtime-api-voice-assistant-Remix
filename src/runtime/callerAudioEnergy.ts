/**
 * DID THE CALLER'S AUDIO ACTUALLY REACH US? — the control nothing could run.
 *
 * Measured 2026-09-24 over 09-17..09-23 on the runtime, `duration >= 30`,
 * CALLER: lines counted from the transcript:
 *
 *   optical  435 substantive, 59 with ZERO caller lines (13.6%)
 *   surgery  518 substantive, 40 (7.7%)
 *   tech     808 substantive, 67 (8.3%)
 *
 * Optical's whole excess is the ZERO bucket — its "heard exactly once" share
 * is the LOWEST of the three (4.8% against 6.0% and 5.3%) — so this was never
 * the VAD losing a caller mid-call, and dropping `RUNTIME_VAD_THRESHOLD`
 * again would not have touched it. Four causes are ruled out with controls:
 * robocalls (51 distinct numbers behind 59 calls, 1.16 calls/number, the same
 * as tech), a wrong IVR option (2 of 59 are later heard on another lane),
 * greeting length (CLAUDE.md, and optical's is the shortest) and greeting
 * shape (all three lanes end "How can I help you today?"). And 15 of the 59
 * rang optical BACK within 24h and were heard, so they are not all dead air.
 *
 * What no query can answer is the one that splits the remaining two causes:
 *
 *   frames arrived, none voiced      -> an open line nobody spoke into
 *   frames arrived, plenty voiced,
 *     and no transcript              -> WE did not hear real speech
 *
 * `handleTwilioFrame`'s media case is `session.appendAudio(payload)` and
 * nothing else — caller audio has never been counted anywhere, which is why
 * this number has survived three attempts at it. An INSTRUMENT, not a fix,
 * deliberately: v47, v48, v58 and v61 are all this move, and v61 records a
 * fix written and REVERTED for shipping onto an unmeasurable population.
 *
 * WHY FRAME COUNT ALONE WILL NOT DO. Twilio sends a 20ms μ-law frame
 * continuously once the call is up, whether or not anybody is speaking, so
 * "frames arrived" is true on every call and discriminates nothing. Comfort
 * noise also rules out a simple non-silence byte test: on a real line almost
 * every frame carries some. What separates speech from an open line is
 * LOUDNESS, and μ-law encodes that directly in its exponent.
 *
 * μ-law is sign-magnitude and INVERTED on the wire: after `~b`, bits 4-6 are
 * the exponent and 0-3 the mantissa, and a HIGHER exponent is a louder
 * sample. Comfort noise and line hiss sit at exponent 0-1; speech peaks well
 * above it. So a frame counts as voiced when its LOUDEST sample reaches
 * `VOICED_EXPONENT`, which is integer work over 160 bytes and no decoding.
 */

/**
 * The exponent a frame's loudest sample must reach to count as speech.
 *
 * 4 of 7 is a judgement, not a measurement, and it is deliberately well
 * clear of the 0-1 band where comfort noise lives rather than tuned to a
 * corpus we do not have yet. The counts it produces are what will say
 * whether it wants moving — which is the whole point of shipping it as an
 * instrument first.
 */
export const VOICED_EXPONENT = 4;

/** μ-law bytes per 20ms Twilio frame at 8kHz. Not enforced, documented. */
export const FRAME_BYTES = 160;

/**
 * Is this string canonical base64?
 *
 * DECODE AND RE-ENCODE, rather than a pattern. Node's decoder is permissive in
 * three independent ways and a hand-written predicate was wrong about two of
 * them on two successive review rounds (#327):
 *
 *   - the ALPHABET: invalid characters are silently skipped, never thrown on,
 *     so `not@@base64!!` decoded to six bytes and read voiced;
 *   - the LENGTH: `AA=` and `AAAA=` are not valid quanta but decode anyway, to
 *     `00` and `00 00 00` — and `0x00` is maximum amplitude in μ-law, so both
 *     read voiced;
 *   - the TRAILING BITS: `AAB=` is the right length with the right padding and
 *     is still not canonical, because the final data character's low bits must
 *     be zero. A brute force over 3,906 strings found 60 such cases that an
 *     anchored alphabet-plus-length predicate accepts and this test rejects.
 *
 * The round trip is exact by construction and cannot be wrong about one of the
 * three while being right about the others. Measured cost: 0.12 µs per frame
 * on top of a 0.33 µs decode-and-scan — 2.4 ms of CPU per second at 20,000
 * frames per second, or 0.24% of one core. Correctness is worth that here,
 * because the verdict this guards decides whether we accuse our own speech
 * recognition.
 */
function isCanonicalBase64(s: string): boolean {
  return Buffer.from(s, "base64").toString("base64") === s;
}

/**
 * Does this μ-law frame's loudest sample reach speech loudness?
 *
 * Takes the base64 payload exactly as Twilio delivers it. A payload that is
 * empty or undecodable is not voiced and is not an error — a malformed frame
 * must never cost a live call anything, and this is telemetry.
 *
 * THE PAYLOAD IS VALIDATED RATHER THAN THE DECODE TRUSTED (Codex P2, #327
 * rounds 2 and 3). `Buffer.from(s, "base64")` does NOT throw on invalid input —
 * it silently skips what it cannot read — so the `try/catch` this used to rely
 * on was dead code and the sentence above it was false. See
 * `isCanonicalBase64` for the three ways it is permissive and why the test is
 * a round trip rather than a pattern.
 *
 * THE DIRECTION IS WHY THIS IS WORTH A REGEX. `voiced` on a call with no
 * transcript is the verdict that accuses our own speech recognition, and
 * `silent_line` is the one that says nobody spoke — they call for opposite
 * fixes. A malformed frame must never be allowed to pick the accusing one,
 * which is the same reasoning that makes the missing-counts default
 * `no_frames`.
 */
export function frameIsVoiced(payloadBase64: string): boolean {
  if (!isCanonicalBase64(payloadBase64)) return false;
  const buf = Buffer.from(payloadBase64, "base64");
  for (let i = 0; i < buf.length; i += 1) {
    // Invert (μ-law is stored inverted), then read the exponent: bits 4-6.
    const exponent = (~buf[i] >> 4) & 0x07;
    if (exponent >= VOICED_EXPONENT) return true;
  }
  return false;
}

export interface CallerAudioCounts {
  /** Every media frame Twilio delivered from the caller. */
  frames: number;
  /** Those whose loudest sample reached speech loudness. */
  voiced: number;
}

/**
 * Per-call accumulator. Two integers — it runs on every inbound frame, so it
 * allocates nothing and branches once.
 */
export class CallerAudioMeter {
  private framesSeen = 0;
  private voicedSeen = 0;

  note(payloadBase64: string): void {
    this.framesSeen += 1;
    if (frameIsVoiced(payloadBase64)) this.voicedSeen += 1;
  }

  counts(): CallerAudioCounts {
    return { frames: this.framesSeen, voiced: this.voicedSeen };
  }
}
