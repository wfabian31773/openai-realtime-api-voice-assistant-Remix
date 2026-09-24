/**
 * THE OPTICAL BARELY-HEARD INSTRUMENT.
 *
 * `callerAudioEnergy.ts` carries the measurement this exists for. The short
 * version: optical's excess barely-heard is entirely the ZERO-caller-line
 * bucket (13.6% against surgery 7.7% and tech 8.3% over 09-17..09-23), its
 * heard-exactly-once share is the LOWEST of the three, and four causes are
 * ruled out with controls. What remained unanswerable is whether the caller's
 * audio ever reached us — because `handleTwilioFrame` passed it straight to
 * the session and counted nothing.
 *
 * These tests pin the μ-law arithmetic against bytes whose loudness is known
 * by construction, and pin the COUNTING AT THE BRIDGE, because a helper test
 * proves the helper and not that anything calls it (failure mode 10, and v20
 * is the worked example where both ends had tests and the links between them
 * did not).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  frameIsVoiced,
  CallerAudioMeter,
  VOICED_EXPONENT,
} from './callerAudioEnergy';
import { callerAudioEvent, callerAudioVerdict } from './callerAudioTelemetry';

const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');
/** μ-law digital silence: +0 and -0. Exponent 0 by construction. */
const SILENCE = b64(new Array(160).fill(0xff));
const NEG_SILENCE = b64(new Array(160).fill(0x7f));
/** Line hiss: the smallest magnitude steps, still exponent 0. */
const HISS = b64(Array.from({ length: 160 }, (_, i) => (i % 2 ? 0xfe : 0x7e)));
/** Speech-loud: 0x00/0x80 are the loudest samples in μ-law, exponent 7. */
const LOUD = b64(new Array(160).fill(0x00));
/** One loud sample in an otherwise silent frame — a peak measure must catch it. */
const ONE_PEAK = b64([...new Array(159).fill(0xff), 0x80]);

describe('the μ-law energy probe', () => {
  it('reads digital silence as not voiced, both signs', () => {
    expect(frameIsVoiced(SILENCE)).toBe(false);
    expect(frameIsVoiced(NEG_SILENCE)).toBe(false);
  });

  it('reads line hiss as not voiced — this is why a non-silence BYTE test will not do', () => {
    // Every byte here differs from digital silence, so "any non-silence byte"
    // would call this voiced on a real line and the instrument would report
    // every call as voiced, discriminating nothing.
    expect(frameIsVoiced(HISS)).toBe(false);
  });

  it('reads speech-loud audio as voiced', () => {
    expect(frameIsVoiced(LOUD)).toBe(true);
  });

  it('is a PEAK measure, so one loud sample in a quiet frame counts', () => {
    expect(frameIsVoiced(ONE_PEAK)).toBe(true);
  });

  it('treats an empty or undecodable payload as not voiced, never as an error', () => {
    // Telemetry must never cost a live call anything.
    expect(frameIsVoiced('')).toBe(false);
    expect(() => frameIsVoiced('not@@base64!!')).not.toThrow();
  });

  it('keeps the threshold clear of the band where comfort noise lives', () => {
    // 0-1 is hiss; the threshold must sit above it or every call reads voiced.
    expect(VOICED_EXPONENT).toBeGreaterThan(1);
    expect(VOICED_EXPONENT).toBeLessThanOrEqual(7);
  });
});

describe('the per-call meter', () => {
  it('counts every frame and only the voiced ones', () => {
    const m = new CallerAudioMeter();
    m.note(SILENCE);
    m.note(HISS);
    m.note(LOUD);
    m.note(SILENCE);
    expect(m.counts()).toEqual({ frames: 4, voiced: 1 });
  });

  it('starts at zero so a call with no media reads no_frames', () => {
    expect(new CallerAudioMeter().counts()).toEqual({ frames: 0, voiced: 0 });
  });
});

describe('the verdict splits the two causes this was built to separate', () => {
  it('no media at all is no_frames', () => {
    expect(callerAudioVerdict({ frames: 0, voiced: 0 })).toBe('no_frames');
  });

  it('an open line nobody spoke into is silent_line', () => {
    expect(callerAudioVerdict({ frames: 1500, voiced: 0 })).toBe('silent_line');
  });

  it('speech-loud audio is voiced — and on a zero-caller-line call that means WE missed it', () => {
    expect(callerAudioVerdict({ frames: 1500, voiced: 300 })).toBe('voiced');
  });
});

describe('the row', () => {
  it('writes on EVERY call, because "no caller audio" is the finding', () => {
    // Unlike follow_up_summary, which returns null and skips. A skip here
    // would hide exactly the population being measured.
    const ev = callerAudioEvent({ callerAudio: { frames: 0, voiced: 0 }, outcome: 'caller_hangup' } as never);
    expect(ev).not.toBeNull();
    expect(ev.data.verdict).toBe('no_frames');
  });

  it('a record carrying NO counts reads no_frames, never voiced', () => {
    // MUTATION TESTING CAUGHT THIS GAP: every other assertion here passes
    // `callerAudio` explicitly, so the `??` default was never exercised and a
    // mutation to `{ frames: 1, voiced: 1 }` survived. That default is load
    // bearing — an older fixture, or a bridge that stopped setting the field,
    // must read as "we know nothing", never as "the caller was speaking",
    // because `voiced` on a zero-caller-line call is what accuses our own STT.
    const ev = callerAudioEvent({ outcome: 'caller_hangup' } as never);
    expect(ev.data.verdict).toBe('no_frames');
    expect(ev.data.frames).toBe(0);
    expect(ev.data.voiced).toBe(0);
  });

  it('warns only on no_frames — a silent line is ordinary on a business number', () => {
    expect(callerAudioEvent({ callerAudio: { frames: 0, voiced: 0 }, outcome: 'caller_hangup' } as never).level)
      .toBe('warn');
    expect(callerAudioEvent({ callerAudio: { frames: 900, voiced: 0 }, outcome: 'caller_hangup' } as never).level)
      .toBe('info');
    expect(callerAudioEvent({ callerAudio: { frames: 900, voiced: 90 }, outcome: 'caller_hangup' } as never).level)
      .toBe('info');
  });

  it('carries the share, so a long call and a short one are comparable', () => {
    expect(callerAudioEvent({ callerAudio: { frames: 200, voiced: 50 }, outcome: 'x' } as never).data.voicedPct)
      .toBe(25);
    // Never divides by zero.
    expect(callerAudioEvent({ callerAudio: { frames: 0, voiced: 0 }, outcome: 'x' } as never).data.voicedPct)
      .toBe(0);
  });

  it('carries no audio and no transcript — counts and a verdict only', () => {
    const ev = callerAudioEvent({ callerAudio: { frames: 10, voiced: 2 }, outcome: 'x' } as never);
    expect(Object.keys(ev.data).sort()).toEqual(
      ['frames', 'outcome', 'verdict', 'voiced', 'voicedPct'],
    );
  });
});

describe('the bridge actually counts, and the runtime actually writes', () => {
  // Read from source: these are the two links that a helper test cannot see,
  // and the pair v20 records as both-ends-covered-middle-uncovered.
  const bridge = readFileSync(join(process.cwd(), 'src/runtime/mediaStreamBridge.ts'), 'utf8');
  const runtime = readFileSync(join(process.cwd(), 'src/runtime/voiceRuntime.ts'), 'utf8');

  it('notes every inbound media frame', () => {
    const media = bridge.slice(bridge.indexOf('case "media":'));
    const arm = media.slice(0, media.indexOf('break;'));
    expect(arm).toContain('this.callerAudio.note(frame.media.payload)');
  });

  it('counts AFTER handing the audio to the model, never before', () => {
    const media = bridge.slice(bridge.indexOf('case "media":'));
    const arm = media.slice(0, media.indexOf('break;'));
    expect(arm.indexOf('appendAudio')).toBeLessThan(arm.indexOf('callerAudio.note'));
  });

  it('puts the counts on the record', () => {
    expect(bridge).toContain('callerAudio: this.callerAudio.counts()');
  });

  it('the runtime writes the row at teardown, chained after its predecessor', () => {
    expect(runtime).toContain('logCallerAudio(record, { callLogId }, { after: identityWritten })');
  });

  it('is never awaited by teardown — telemetry must not delay a hangup', () => {
    const site = runtime.slice(runtime.indexOf('logCallerAudio(record'));
    expect(runtime.slice(runtime.indexOf('void logCallerAudio'), runtime.indexOf('void logCallerAudio') + 20))
      .toContain('void');
    expect(site.slice(0, 200)).toContain('.catch(');
  });
});
