/**
 * The latency clock, tested against the ORDER OF EVENTS A REAL CALL PRODUCES.
 *
 * Shipped 2026-08-13, measured the next morning on its first live night:
 * 51 of 51 agent turns carried `transcriberMs` and `endpointingMs`, and
 * `modelFirstAudioMs`, `voiceMs` and `callerWaitMs` were blank on every one.
 *
 * Two independent causes, both invisible to the unit test I did not write:
 *
 *   1. `first_audio` was pinned to two guessed event names that this SDK's
 *      transport never emits, so the mark never fired.
 *   2. the snapshot is taken on `response.audio_transcript.done`, which fires
 *      BEFORE `response.done` — so `responseDoneAt` was always unset and
 *      `voiceMs` could never compute.
 *
 * Neither is findable by reading the module: both are facts about the
 * sequence the transport hands us. So this file asserts the sequence, not the
 * arithmetic.
 */
import { describe, it, expect, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
const { markLatency, turnLatencySnapshot, releaseCallEvents } = await import('./callEventLog');

const CALL = 'test-latency-call';

beforeEach(() => releaseCallEvents(CALL));

/** The event order a real conversational turn produces, in order. */
function playTurn(opts: { withFirstAudio?: boolean; withResponseDone?: boolean } = {}) {
  const { withFirstAudio = true, withResponseDone = false } = opts;
  markLatency(CALL, 'speech_stopped');
  markLatency(CALL, 'transcript_done');
  markLatency(CALL, 'response_created');
  if (withFirstAudio) markLatency(CALL, 'first_audio');
  if (withResponseDone) markLatency(CALL, 'response_done');
}

describe('a full conversational turn', () => {
  it('populates every component, including the three that were blank in production', () => {
    playTurn();
    // Snapshot taken where the real one is: at transcript-done, BEFORE
    // response.done. This is the exact condition that blanked voiceMs.
    const l = turnLatencySnapshot(CALL);
    expect(l).toBeTruthy();
    for (const key of ['transcriberMs', 'endpointingMs', 'modelFirstAudioMs', 'voiceMs', 'callerWaitMs'] as const) {
      expect(l![key], `${key} must be present on a complete turn`).toBeTypeOf('number');
    }
  });

  it('closes voiceMs at the caller-facing moment when response.done has not landed yet', () => {
    playTurn({ withResponseDone: false });
    const l = turnLatencySnapshot(CALL, Date.now() + 500);
    expect(l!.voiceMs).toBeGreaterThanOrEqual(500);
  });

  it('prefers the real response.done when it HAS landed', () => {
    playTurn({ withResponseDone: true });
    // A far-future atMs must not inflate a span we actually measured.
    const l = turnLatencySnapshot(CALL, Date.now() + 60_000);
    expect(l!.voiceMs).toBeLessThan(1_000);
  });
});

describe('the greeting turn', () => {
  it('reports nothing rather than a fake number', () => {
    // No caller speech precedes the greeting, so there is no wait to measure.
    // Production showed `null` here and that was correct — locking it so a
    // later "fix" does not invent a zero.
    markLatency(CALL, 'response_created');
    markLatency(CALL, 'first_audio');
    const l = turnLatencySnapshot(CALL);
    expect(l?.transcriberMs).toBeUndefined();
    expect(l?.callerWaitMs).toBeUndefined();
  });
});

describe('the marks that never fired', () => {
  it('leaves model and wait blank when no delta arrives — the production symptom', () => {
    playTurn({ withFirstAudio: false });
    const l = turnLatencySnapshot(CALL);
    expect(l!.transcriberMs).toBeTypeOf('number');
    expect(l!.endpointingMs).toBeTypeOf('number');
    // Exactly the shape observed live. If a future change makes these numbers
    // appear without a delta, they are invented.
    expect(l!.modelFirstAudioMs).toBeUndefined();
    expect(l!.callerWaitMs).toBeUndefined();
  });

  it('records only the FIRST delta of a reply', async () => {
    markLatency(CALL, 'speech_stopped');
    markLatency(CALL, 'transcript_done');
    markLatency(CALL, 'response_created');
    markLatency(CALL, 'first_audio');
    const first = turnLatencySnapshot(CALL)!.callerWaitMs!;
    await new Promise((r) => setTimeout(r, 25));
    markLatency(CALL, 'first_audio'); // the other few hundred deltas
    expect(turnLatencySnapshot(CALL)!.callerWaitMs).toBe(first);
  });
});

describe('turn boundaries', () => {
  it('a new caller turn resets the clock rather than accumulating', async () => {
    playTurn();
    await new Promise((r) => setTimeout(r, 30));
    markLatency(CALL, 'speech_stopped'); // caller speaks again
    const l = turnLatencySnapshot(CALL);
    // The previous turn's spans must be gone, not carried forward.
    expect(l?.transcriberMs).toBeUndefined();
    expect(l?.modelFirstAudioMs).toBeUndefined();
  });

  it('returns null for a call it has never seen', () => {
    expect(turnLatencySnapshot('no-such-call')).toBeNull();
  });
});
