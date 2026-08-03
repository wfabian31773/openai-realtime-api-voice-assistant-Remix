/**
 * Identity grounding — regression tests for call afb1e688 (2026-08-03).
 * Caller-ID said "Wayne Fabian"; the caller said "Ferreras, Pedro"; the agent
 * sent firstName "Wayne" + lastName "Herreras" and looped until the caller
 * gave up. That combination must be detectable.
 */
import { describe, expect, it } from 'vitest';
import { checkIdentityGrounding } from './identityGrounding';

const PC = { firstName: 'Wayne', lastNameOnFile: 'Fabian' };

describe('checkIdentityGrounding', () => {
  it('flags the afb1e688 chimera: caller-ID first name + caller-supplied last name', () => {
    const caller = 'Ferreras, Pedro birth 5/10/1983.\nNo, ten months, first day, 1983.';
    const f = checkIdentityGrounding({ firstName: 'Wayne', lastName: 'Herreras' }, caller, PC);
    expect(f.code).toBe('chimera_mixed_sources');
    expect(f.review).toBe(true);
    expect(f.firstNameSource).toBe('precontext');
    expect(f.detail).toMatch(/cannot verify|identifies nobody/);
  });

  it('passes the normal recognized-caller case (both names on file, caller confirms)', () => {
    const caller = 'Yes, this is Wayne Fabian, born January second 1970.';
    const f = checkIdentityGrounding({ firstName: 'Wayne', lastName: 'Fabian' }, caller, PC);
    expect(f.code).toBe('grounded');
    expect(f.review).toBe(false);
  });

  it('passes when the caller-ID matched the wrong person and BOTH names come from the caller', () => {
    const caller = 'Ferreras, Pedro birth October fifth 1983.';
    const f = checkIdentityGrounding({ firstName: 'Pedro', lastName: 'Ferreras' }, caller, PC);
    expect(f.code).toBe('grounded');
    expect(f.firstNameSource).toBe('caller');
    expect(f.lastNameSource).toBe('caller');
  });

  it('flags a surname that appears nowhere (mis-transcription) even when the first name is right', () => {
    const caller = 'This is Pedro, last name Ferreras.';
    const f = checkIdentityGrounding({ firstName: 'Pedro', lastName: 'Herreras' }, caller, PC);
    expect(f.code).toBe('ungrounded_last_name');
    expect(f.review).toBe(true);
  });

  it('flags a first name invented from nowhere', () => {
    const caller = 'Last name Ferreras, first name Pedro.';
    const f = checkIdentityGrounding({ firstName: 'Miguel', lastName: 'Ferreras' }, caller, undefined);
    expect(f.code).toBe('ungrounded_first_name');
    expect(f.review).toBe(true);
  });

  it('stays quiet with no caller speech yet (nothing to ground against)', () => {
    const f = checkIdentityGrounding({ firstName: 'Wayne', lastName: 'Fabian' }, '', PC);
    expect(f.code).toBe('no_caller_speech');
    expect(f.review).toBe(false);
  });

  it('never reports names as sources it cannot justify', () => {
    const f = checkIdentityGrounding({ firstName: 'Pedro', lastName: 'Ferreras' }, 'Pedro Ferreras', PC);
    expect(f.firstNameSource).toBe('caller');
    expect(f.lastNameSource).toBe('caller');
  });
});
