/**
 * Dead-air watchdog tests. The centrepiece is call 438e06f8 (2026-08-04 09:41):
 * one agent line, then twenty minutes of nothing, while the caller redialled and
 * started a second call. Clock is injected so the 20 minutes cost no wall time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeadAirWatchdog,
  deadAirTimeoutMs,
  isActivityEvent,
} from './deadAirWatchdog';

let now: number;
let d: DeadAirWatchdog;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  d = new DeadAirWatchdog(() => now);
});

/** Advance the injected clock AND the timers that poll it. */
function advance(ms: number) {
  const step = 1_000;
  for (let i = 0; i < ms; i += step) {
    now += step;
    vi.advanceTimersByTime(step);
  }
}

describe('deadAirTimeoutMs', () => {
  it('defaults to 120s — clears the worst observed warm transfer (71.5s)', () => {
    expect(deadAirTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000);
  });

  it('is tunable, and 0 disables', () => {
    expect(deadAirTimeoutMs({ DEAD_AIR_TIMEOUT_MS: '45000' } as any)).toBe(45_000);
    expect(deadAirTimeoutMs({ DEAD_AIR_TIMEOUT_MS: '0' } as any)).toBe(0);
  });

  it('falls back to the default on nonsense', () => {
    expect(deadAirTimeoutMs({ DEAD_AIR_TIMEOUT_MS: 'soon' } as any)).toBe(120_000);
    expect(deadAirTimeoutMs({ DEAD_AIR_TIMEOUT_MS: '-5' } as any)).toBe(120_000);
  });
});

describe('isActivityEvent', () => {
  it('counts caller transcripts, agent transcripts and tool traffic', () => {
    for (const t of [
      'conversation.item.input_audio_transcription.completed',
      'response.output_audio_transcript.done',
      'response.audio_transcript.done',
      'response.function_call_arguments.done',
    ]) {
      expect(isActivityEvent(t), t).toBe(true);
    }
  });

  it('does NOT count the events a dead session keeps emitting', () => {
    // This is the whole point: a stalled session still streams audio deltas and
    // keepalives, so counting them would make the watchdog never fire.
    //
    // The last three were REMOVED from the list on 2026-08-05, after call
    // 822f7347 ran the full 20-minute cap on four turns. A line with nobody on
    // it keeps opening conversation items on ambient noise, and response.done
    // fires for empty and cancelled responses — none of it is evidence that
    // anyone spoke.
    for (const t of [
      'response.output_audio.delta',
      'response.audio.delta',
      'input_audio_buffer.speech_started',
      'session.updated',
      'conversation.item.created',
      'conversation.item.truncated',
      'response.done',
      undefined,
      null,
    ]) {
      expect(isActivityEvent(t), String(t)).toBe(false);
    }
  });
});

describe('call 438e06f8 — one line, then twenty minutes of nothing', () => {
  it('closes the session instead of burning the 20-minute agent cap', () => {
    const onDeadAir = vi.fn();
    d.arm('z1', onDeadAir, 120_000);
    // The single agent line the real call produced.
    d.touch('z1');
    advance(119_000);
    expect(onDeadAir).not.toHaveBeenCalled();
    advance(6_000);
    expect(onDeadAir).toHaveBeenCalledTimes(1);
    expect(onDeadAir.mock.calls[0][0]).toBeGreaterThanOrEqual(120_000);
  });

  it('fires at most once, however long the silence runs', () => {
    const onDeadAir = vi.fn();
    d.arm('z2', onDeadAir, 120_000);
    advance(20 * 60_000); // the real call's full duration
    expect(onDeadAir).toHaveBeenCalledTimes(1);
  });
});

describe('does not cut live calls', () => {
  it('a warm transfer at the worst observed latency survives', () => {
    // transfer_to_office averaged 28s and was observed at 71.5s with no
    // transcript in between. That must never look like dead air.
    const onDeadAir = vi.fn();
    d.arm('t1', onDeadAir, 120_000);
    advance(71_600);
    d.touch('t1'); // transfer returns, agent speaks
    advance(71_600);
    expect(onDeadAir).not.toHaveBeenCalled();
  });

  it('an ordinary conversation never trips it', () => {
    const onDeadAir = vi.fn();
    d.arm('t2', onDeadAir, 120_000);
    for (let i = 0; i < 20; i++) {
      advance(20_000);
      d.touch('t2');
    }
    expect(onDeadAir).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('release stops the watch and the timer', () => {
    const onDeadAir = vi.fn();
    d.arm('r1', onDeadAir, 120_000);
    expect(d.isWatching('r1')).toBe(true);
    d.release('r1');
    expect(d.isWatching('r1')).toBe(false);
    advance(10 * 60_000);
    expect(onDeadAir).not.toHaveBeenCalled();
  });

  it('a timeout of 0 disables the watchdog', () => {
    const onDeadAir = vi.fn();
    d.arm('r2', onDeadAir, 0);
    expect(d.isWatching('r2')).toBe(false);
    advance(10 * 60_000);
    expect(onDeadAir).not.toHaveBeenCalled();
  });

  it('arming twice does not leave a stray timer', () => {
    const first = vi.fn();
    const second = vi.fn();
    d.arm('r3', first, 120_000);
    d.arm('r3', second, 120_000);
    advance(130_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a throwing callback never escapes the watchdog', () => {
    d.arm('r4', () => { throw new Error('transport already gone'); }, 120_000);
    expect(() => advance(130_000)).not.toThrow();
  });

  it('touch and release on an unknown call are harmless', () => {
    expect(() => { d.touch('nope'); d.release('nope'); d.release(undefined); }).not.toThrow();
    expect(d.idleMs('nope')).toBeNull();
  });
});

/**
 * REGRESSION: call 822f7347 (2026-08-05 18:16, azul-scheduling) ran 1201s — the
 * 20-minute cap to the second — on FOUR turns. The transcript ends on the agent
 * asking "¿cuál es su fecha de nacimiento?" and nothing follows.
 *
 * The watchdog was armed and the hangup was correct by then. What kept it alive
 * was the activity list: an open line with nobody on it goes on producing
 * conversation items and empty responses indefinitely.
 */
describe('call 822f7347 — a line with nobody on it', () => {
  it('is not kept alive by item/response churn on a silent line', () => {
    const onDeadAir = vi.fn();
    d.arm('sil', onDeadAir, 120_000);
    // Four real turns, then silence — with the churn a dead line keeps emitting.
    for (const t of ['response.audio_transcript.done', 'conversation.item.input_audio_transcription.completed']) {
      if (isActivityEvent(t)) d.touch('sil');
    }
    for (let i = 0; i < 40; i++) {
      advance(30_000); // 20 minutes total
      for (const t of ['conversation.item.created', 'response.done', 'conversation.item.truncated', 'response.audio.delta']) {
        if (isActivityEvent(t)) d.touch('sil');
      }
    }
    expect(onDeadAir).toHaveBeenCalledTimes(1);
    // Fired in the first ~2 minutes, not at the 20-minute cap.
    expect(onDeadAir.mock.calls[0][0]).toBeLessThan(180_000);
  });
});
