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
 * by construction, and pin WHERE THE COUNTING HAPPENS — at the socket, never
 * in the bridge — because a helper test proves the helper and not that
 * anything calls it (failure mode 10, and v20 is the worked example where both
 * ends had tests and the links between them did not). The behaviour itself,
 * one row on every exit that writes a `call_logs` row, is driven at the real
 * runtime in `voiceRuntime.test.ts`.
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
    //
    // AND THIS TEST USED TO ASSERT THE WRONG HALF OF ITS OWN TITLE (Codex P2,
    // round 2). It checked only `.not.toThrow()` on the malformed payload and
    // never that the answer was `false` — so "as not voiced" went untested,
    // and it was in fact returning TRUE. `Buffer.from(s, 'base64')` does not
    // throw on invalid input, it silently skips what it cannot read, so the
    // no-throw half could never fail and the half that mattered was absent.
    expect(frameIsVoiced('')).toBe(false);
    expect(() => frameIsVoiced('not@@base64!!')).not.toThrow();
    expect(frameIsVoiced('not@@base64!!')).toBe(false);
  });

  it('refuses a malformed payload rather than measuring whatever it decodes to', () => {
    // `voiced` on a call with no transcript is the verdict that accuses our own
    // speech recognition, while `silent_line` says nobody spoke. They call for
    // OPPOSITE fixes, so a malformed frame must never be able to pick the
    // accusing one — and `0x00` is MAXIMUM amplitude in μ-law, so a payload
    // that decodes to zero bytes reads voiced. Each row below did.
    const bad = [
      'not@@base64!!', // bad ALPHABET: decoded to 6 bytes, exponents 6 7 2 1 3 4
      'AAAA AAAA', //     a space is not in the alphabet
      '####', //          nothing in the alphabet
      'AA=A', //          padding before data
      'AAAA=AAAA', //     padding mid-string
      'AA=', //           bad LENGTH: decodes to 00        -> was voiced
      'AAAA=', //         bad LENGTH: decodes to 00 00 00  -> was voiced
      'AAA', //           bad LENGTH: decodes to 00 00     -> was voiced
      'AAAAA', //         bad LENGTH
      'AAB=', //          non-canonical TRAILING BITS: right length, right
      //                  padding, and the final char's low bits are not zero,
      //                  so re-encoding gives 'AAA='     -> was voiced
      'AB==',
      'A+B=',
    ];
    for (const s of bad) expect(frameIsVoiced(s), s).toBe(false);
  });

  it('accepts exactly what canonical base64 accepts, proven rather than reasoned', () => {
    // THIS TEST EXISTS BECAUSE I GOT THE PREDICATE WRONG TWICE BY REASONING
    // ABOUT IT. An anchored alphabet-and-padding pattern let three bad lengths
    // through (round 3); adding `length % 4 === 0` still let 60 non-canonical
    // trailing-bit strings through, which a brute force found and my
    // enumeration had not. So the property is asserted against the canonical
    // definition over every short string, not against a list I thought of.
    const alphabet = ['A', 'B', '+', '/', '='];
    const canonical = (s: string) => Buffer.from(s, 'base64').toString('base64') === s;
    const seen: string[] = [];
    const walk = (prefix: string, len: number) => {
      if (prefix.length === len) return void seen.push(prefix);
      for (const c of alphabet) walk(prefix + c, len);
    };
    for (let len = 0; len <= 4; len += 1) walk('', len);
    expect(seen.length).toBeGreaterThan(700);
    for (const s of seen) {
      // A canonical payload is measured; a non-canonical one is never voiced.
      if (!canonical(s)) expect(frameIsVoiced(s), `non-canonical: ${s}`).toBe(false);
    }
  });

  it('accepts every real μ-law frame length, so it cannot fail closed', () => {
    // A guard that rejects too much reads EVERY call as `silent_line` — the
    // same defect pointed the other way. Twilio sends 160-byte frames; this
    // walks every length up to 200 at an amplitude that must read voiced.
    for (let len = 1; len <= 200; len += 1) {
      const payload = Buffer.alloc(len, 0x00).toString('base64');
      expect(frameIsVoiced(payload), `len ${len}`).toBe(true);
    }
  });

  it('still measures well-formed payloads, padded or not', () => {
    // The guard must not reject what Twilio actually sends: the standard
    // alphabet with padding only at the end. A guard that refuses everything
    // reads every call as silent, which is the same defect pointed the other
    // way.
    expect(frameIsVoiced(Buffer.alloc(160, 0x00).toString('base64'))).toBe(true);
    expect(frameIsVoiced(Buffer.alloc(160, 0xff).toString('base64'))).toBe(false);
    // Lengths 1 and 2 pad to '==' and '=', so both forms are exercised.
    expect(frameIsVoiced(Buffer.from([0x00]).toString('base64'))).toBe(true);
    expect(frameIsVoiced(Buffer.from([0x00, 0x00]).toString('base64'))).toBe(true);
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
    const ev = callerAudioEvent({ frames: 0, voiced: 0 }, 'caller_hangup');
    expect(ev).not.toBeNull();
    expect(ev.data.verdict).toBe('no_frames');
  });

  it('a call carrying NO counts reads no_frames, never voiced', () => {
    // MUTATION TESTING CAUGHT THIS GAP: every other assertion here passes
    // counts explicitly, so the `??` default was never exercised and a
    // mutation to `{ frames: 1, voiced: 1 }` survived. That default is load
    // bearing — a caller that cannot say what arrived must read "we know
    // nothing", never "the caller was speaking", because `voiced` on a
    // zero-caller-line call is what accuses our own STT.
    const ev = callerAudioEvent(undefined, 'caller_hangup');
    expect(ev.data.verdict).toBe('no_frames');
    expect(ev.data.frames).toBe(0);
    expect(ev.data.voiced).toBe(0);
  });

  it('warns only on no_frames — a silent line is ordinary on a business number', () => {
    expect(callerAudioEvent({ frames: 0, voiced: 0 }, 'caller_hangup').level).toBe('warn');
    expect(callerAudioEvent({ frames: 900, voiced: 0 }, 'caller_hangup').level).toBe('info');
    expect(callerAudioEvent({ frames: 900, voiced: 90 }, 'caller_hangup').level).toBe('info');
  });

  it('carries the share, so a long call and a short one are comparable', () => {
    expect(callerAudioEvent({ frames: 200, voiced: 50 }, 'x').data.voicedPct).toBe(25);
    // Never divides by zero.
    expect(callerAudioEvent({ frames: 0, voiced: 0 }, 'x').data.voicedPct).toBe(0);
  });

  it('carries no audio and no transcript — counts and a verdict only', () => {
    const ev = callerAudioEvent({ frames: 10, voiced: 2 }, 'x');
    expect(Object.keys(ev.data).sort()).toEqual(
      ['frames', 'outcome', 'verdict', 'voiced', 'voicedPct'],
    );
  });
});

describe('the counting happens at the SOCKET, not in the bridge', () => {
  /**
   * Read from source. The behaviour — every exit writing a row with the
   * socket's counts — is driven for real at the runtime in
   * `voiceRuntime.test.ts`, because a helper test proves the helper and not
   * that anything calls it (failure mode 10). What source can say, and a
   * behavioural test cannot, is that nothing counts in the WRONG place.
   */
  const bridge = readFileSync(join(process.cwd(), 'src/runtime/mediaStreamBridge.ts'), 'utf8');
  const runtime = readFileSync(join(process.cwd(), 'src/runtime/voiceRuntime.ts'), 'utf8');

  it('the bridge counts nothing — it never sees the frames the hold discarded', () => {
    // Codex P2, #327: `PRE_BRIDGE_FRAME_CAP` drops its OLDEST frame, so a
    // caller who spoke during a slow start and went quiet afterwards would
    // have been counted `silent_line` by a bridge-side meter — audio that
    // reached this server, reported as its opposite.
    expect(bridge).not.toContain('CallerAudioMeter');
    expect(bridge).not.toContain('callerAudio');
  });

  it('the socket notes every inbound media frame', () => {
    expect(runtime).toContain('new CallerAudioMeter()');
    expect(runtime).toContain('callerAudio.note(frame.media.payload)');
  });

  it('counts AFTER the claim and BEFORE both branches that can drop a frame', () => {
    // REWRITTEN, NOT LOOSENED (Codex P2, #327 round 2). The count used to sit
    // above the `start` arm, which metered an UNAUTHENTICATED socket: until a
    // valid `start` arrives the claim deadline is still running, the parser
    // accepts a payload up to the 64 KiB message limit, and there is no rate
    // limit — so an anonymous client could spend the shared event loop on
    // base64 decodes and byte scans. Those frames were not this call's anyway:
    // the identity arrives IN the `start` frame.
    //
    // The property that matters is unchanged and is still asserted — nothing
    // that can LOSE a frame runs before the count.
    const handler = runtime.slice(runtime.indexOf('ws.on("message"'));
    const note = handler.indexOf('callerAudio.note(');
    expect(note).toBeGreaterThan(-1);
    // The claim is established first, so unauthenticated traffic is never scanned.
    expect(handler.indexOf('registry.claimStream(')).toBeLessThan(note);
    expect(handler.indexOf('claimed = true;')).toBeLessThan(note);
    // And both branches that can lose a frame still come after it.
    expect(handler.indexOf('pendingFrames.push(')).toBeGreaterThan(note);
    expect(handler.indexOf('PRE_BRIDGE_FRAME_CAP')).toBeGreaterThan(note);
    expect(handler.indexOf('bridge.handleTwilioFrame(')).toBeGreaterThan(note);
  });

  it('gates the count on the CLAIM, not on `starting`', () => {
    // `starting` is set BEFORE `claimStream` is tested and stays true on a
    // refused claim, so it cannot gate work that must never run for an
    // unauthenticated client — frames still in flight when the socket is
    // closed would be scanned anyway.
    expect(runtime).toContain('if (frame.event === "media" && claimed)');
    const handler = runtime.slice(runtime.indexOf('ws.on("message"'));
    const refused = handler.indexOf('refused a stream with no valid claim');
    expect(handler.indexOf('claimed = true;')).toBeGreaterThan(refused);
  });

  it('is never awaited by teardown — telemetry must not delay a hangup', () => {
    const at = runtime.indexOf('logAudio(record');
    expect(at).toBeGreaterThan(-1);
    const before = runtime.slice(Math.max(0, at - 60), at);
    expect(before).not.toContain('await ');
    expect(runtime.slice(at, at + 260)).toContain('.catch(() => undefined)');
  });
});
