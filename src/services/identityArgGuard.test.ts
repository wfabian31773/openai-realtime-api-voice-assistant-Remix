import { describe, it, expect, beforeEach } from 'vitest';
import {
  spokenDates,
  callerSpeech,
  checkDob,
  checkRetry,
  surnameDisagrees,
  guardIdentityArgs,
  releaseIdentityGuard,
  lastIdentityAttempt,
} from './identityArgGuard';

/**
 * Fixtures come from call 817162bf (2026-07-31, 12 minutes, no match): the
 * caller said "8/29/1952", the tool was told "1929-09-19", and the retry
 * changed only the surname. Caller-ID pre-context had matched her number to a
 * different patient, so the first attempt also carried a surname she never
 * said.
 */

const KOLTERMAN_TRANSCRIPT = [
  'AGENT: Thanks for calling Azul Vision — am I speaking with Paula?',
  'CALLER: Yes, this is Paula.',
  'AGENT: Great, and your date of birth?',
  'CALLER: 8/29/1952.',
  'AGENT: Got it — one moment.',
].join('\n');

describe('callerSpeech — only the caller counts as evidence', () => {
  it('keeps caller lines and drops the agent', () => {
    const said = callerSpeech(KOLTERMAN_TRANSCRIPT);
    expect(said).toContain('8/29/1952');
    expect(said).not.toContain('Azul Vision');
  });

  it('does not let the agent\'s own mis-heard read-back count as spoken', () => {
    const t = 'AGENT: So that\'s 9/19/1929?\nCALLER: No, 8/29/1952.';
    expect(spokenDates(callerSpeech(t))).toEqual(['1952-08-29']);
  });

  it('is empty for an absent transcript', () => {
    expect(callerSpeech(undefined)).toBe('');
  });
});

describe('spokenDates', () => {
  it('reads slashed dates', () => {
    expect(spokenDates('my birthday is 8/29/1952')).toEqual(['1952-08-29']);
  });

  it('reads two-digit years as 19xx for plausible birth years', () => {
    expect(spokenDates('3-17-73')).toEqual(['1973-03-17']);
  });

  it('reads worded dates with and without ordinals', () => {
    expect(spokenDates('August 29th, 1952')).toEqual(['1952-08-29']);
    expect(spokenDates('March 17 1973')).toEqual(['1973-03-17']);
  });

  it('rejects impossible months and days', () => {
    expect(spokenDates('13/45/1952')).toEqual([]);
  });

  it('returns nothing when no date was spoken', () => {
    expect(spokenDates('I need to reschedule my appointment')).toEqual([]);
  });
});

describe('checkDob', () => {
  it('flags the 817162bf scramble', () => {
    const r = checkDob('1929-09-19', callerSpeech(KOLTERMAN_TRANSCRIPT));
    expect(r.conflict).toBe(true);
    expect(r.callerSaid).toBe('1952-08-29');
    expect(r.reason).toContain('1952-08-29');
  });

  it('passes the date the caller actually said', () => {
    expect(checkDob('1952-08-29', callerSpeech(KOLTERMAN_TRANSCRIPT)).conflict).toBe(false);
  });

  it('never blocks on silence — a false block costs the whole call', () => {
    expect(checkDob('1952-08-29', '').conflict).toBe(false);
    expect(checkDob('1952-08-29', 'I want to cancel Thursday').conflict).toBe(false);
  });

  it('accepts a date spoken in words', () => {
    expect(checkDob('1952-08-29', 'August 29th, 1952').conflict).toBe(false);
  });

  it('takes the LATEST spoken date, so a caller correction wins', () => {
    const said = 'CALLER: 8/29/1952\nCALLER: sorry, 8/29/1953';
    const r = checkDob('1952-08-29', callerSpeech(said));
    expect(r.conflict).toBe(true);
    expect(r.callerSaid).toBe('1953-08-29');
  });

  it('ignores appointment dates — only plausible birth dates are evidence about a birth date', () => {
    const t = 'CALLER: 8/29/1952\nCALLER: can you do 8/14/2026?';
    expect(checkDob('1952-08-29', callerSpeech(t)).conflict).toBe(false);
  });

  it('rejects malformed and implausible dates outright', () => {
    expect(checkDob('29-08-1952', '').conflict).toBe(true);
    expect(checkDob('1852-08-29', '').conflict).toBe(true);
  });
});

describe('checkRetry', () => {
  it('blocks an identical resend', () => {
    const r = checkRetry({ lastName: 'Kolterman', dateOfBirth: '1929-09-19' }, { lastName: 'Kolterman', dateOfBirth: '1929-09-19' });
    expect(r.blocked).toBe(true);
  });

  it('allows the first attempt', () => {
    expect(checkRetry(undefined, { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }).blocked).toBe(false);
  });

  it('warns — but does not block — when only the name changed', () => {
    const r = checkRetry({ lastName: 'Haberkern', dateOfBirth: '1929-09-19' }, { lastName: 'Kolterman', dateOfBirth: '1929-09-19' });
    expect(r.blocked).toBe(false);
    expect(r.reason).toContain('SAME date of birth');
  });

  it('allows a corrected date', () => {
    expect(
      checkRetry({ lastName: 'Kolterman', dateOfBirth: '1929-09-19' }, { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }).blocked,
    ).toBe(false);
  });
});

describe('surnameDisagrees', () => {
  it('catches the wrong-patient pre-context match', () => {
    expect(surnameDisagrees('Haberkern', '[Lookup] KOLTERMAN,PAULA')).toBe(true);
  });

  it('agrees in either carrier name order', () => {
    expect(surnameDisagrees('Kolterman', '[Lookup] KOLTERMAN,PAULA')).toBe(false);
    expect(surnameDisagrees('Ward', '[Lookup] JO WARD')).toBe(false);
  });

  it('stays silent when either side is missing', () => {
    expect(surnameDisagrees(undefined, '[Lookup] KOLTERMAN,PAULA')).toBe(false);
    expect(surnameDisagrees('Kolterman', undefined)).toBe(false);
  });

  it('does not treat a carrier placeholder as a contradiction', () => {
    expect(surnameDisagrees('Kolterman', '[Lookup] WIRELESS CALLER')).toBe(false);
  });
});

describe('guardIdentityArgs', () => {
  beforeEach(() => releaseIdentityGuard('call-1'));

  it('blocks the mangled date and tells the model to read it back', () => {
    const v = guardIdentityArgs('call-1', { lastName: 'Haberkern', firstName: 'Paula', dateOfBirth: '1929-09-19' }, KOLTERMAN_TRANSCRIPT);
    expect(v.blocked).toBe(true);
    expect(v.telemetry.dobConflict).toBe(true);
    expect(v.instruction).toContain('Read the date of birth back');
  });

  it('does not remember a blocked attempt — the corrected retry must go through', () => {
    guardIdentityArgs('call-1', { lastName: 'Haberkern', dateOfBirth: '1929-09-19' }, KOLTERMAN_TRANSCRIPT);
    expect(lastIdentityAttempt('call-1')).toBeUndefined();
    const ok = guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, KOLTERMAN_TRANSCRIPT);
    expect(ok.blocked).toBe(false);
  });

  it('blocks the second identical send', () => {
    const t = 'CALLER: Kolterman, 8/29/1952';
    expect(guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, t).blocked).toBe(false);
    const second = guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, t);
    expect(second.blocked).toBe(true);
    expect(second.telemetry.retryBlocked).toBe(true);
  });

  it('passes a name-only correction through with a note attached', () => {
    const t = 'CALLER: my birthday is 8/29/1952';
    guardIdentityArgs('call-1', { lastName: 'Haberkern', dateOfBirth: '1952-08-29' }, t);
    const v = guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, t);
    expect(v.blocked).toBe(false);
    expect(v.note).toContain('SAME date of birth');
  });

  it('is inert without a transcript or a callId', () => {
    const v = guardIdentityArgs(undefined, { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, undefined);
    expect(v.blocked).toBe(false);
    expect(v.note).toBeUndefined();
  });

  it('releases per-call state', () => {
    const t = 'CALLER: 8/29/1952';
    guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, t);
    releaseIdentityGuard('call-1');
    expect(lastIdentityAttempt('call-1')).toBeUndefined();
    expect(guardIdentityArgs('call-1', { lastName: 'Kolterman', dateOfBirth: '1952-08-29' }, t).blocked).toBe(false);
  });
});
