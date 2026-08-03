/**
 * Identity guard — first-name chimera block and the attempt ceiling.
 * Both from call afb1e688 (2026-08-03): four verification attempts over ten
 * minutes on a name assembled from two different people.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_IDENTITY_ATTEMPTS,
  firstNameContradicted,
  guardIdentityArgs,
  releaseIdentityGuard,
} from './identityArgGuard';

const T = (lines: string[]) => lines.map((l) => `CALLER: ${l}`).join('\n');

afterEach(() => {
  for (const id of ['c1', 'c2', 'c3', 'c4']) releaseIdentityGuard(id);
});

describe('firstNameContradicted', () => {
  it('catches the caller-ID first name when the caller gave a different one', () => {
    const r = firstNameContradicted('Wayne', 'Ferreras, Pedro birth 5/10/1983.');
    expect(r.conflict).toBe(true);
    expect(r.callerSaid).toBe('PEDRO');
  });

  it('accepts a first name the caller actually said', () => {
    expect(firstNameContradicted('Pedro', 'my name is Pedro Ferreras').conflict).toBe(false);
  });

  it('stays quiet when the caller never offered a name at all', () => {
    expect(firstNameContradicted('Wayne', 'uh, I need an appointment').conflict).toBe(false);
  });
});

describe('guardIdentityArgs — chimera', () => {
  it('blocks the afb1e688 combination and names the correction', () => {
    const v = guardIdentityArgs(
      'c1',
      { firstName: 'Wayne', lastName: 'Herreras', dateOfBirth: '1983-10-05' },
      T(['Ferreras, Pedro birth 5/10/1983.', 'No, October 5th, 1983.']),
    );
    expect(v.blocked).toBe(true);
    expect(v.telemetry.firstNameConflict).toBe(true);
    expect(v.instruction).toMatch(/PEDRO/i);
  });

  it('lets the corrected combination through', () => {
    const v = guardIdentityArgs(
      'c2',
      { firstName: 'Pedro', lastName: 'Ferreras', dateOfBirth: '1983-10-05' },
      T(['Ferreras, Pedro birth October 5th 1983.']),
    );
    expect(v.blocked).toBe(false);
  });
});

describe('guardIdentityArgs — attempt ceiling', () => {
  it(`stops after ${MAX_IDENTITY_ATTEMPTS} real attempts and directs a handoff`, () => {
    const said = T(['Ferreras, Pedro, October fifth 1983']);
    // Distinct args each time so the repeat-detector isn't what blocks us.
    for (let i = 0; i < MAX_IDENTITY_ATTEMPTS; i++) {
      const v = guardIdentityArgs('c3', { firstName: 'Pedro', lastName: `Ferreras${i}`, dateOfBirth: '1983-10-05' }, said);
      expect(v.blocked, `attempt ${i + 1} should reach the service`).toBe(false);
    }
    const capped = guardIdentityArgs('c3', { firstName: 'Pedro', lastName: 'Ferrera', dateOfBirth: '1983-10-05' }, said);
    expect(capped.blocked).toBe(true);
    expect(capped.telemetry.attemptsExhausted).toBe(true);
    expect(capped.instruction).toMatch(/sage_handoff/);
    expect(capped.instruction).toMatch(/patient_identity_uncertain/);
  });

  it('warns on the final permitted attempt so the model can plan the handoff', () => {
    const said = T(['Ferreras, Pedro, October fifth 1983']);
    for (let i = 0; i < MAX_IDENTITY_ATTEMPTS - 1; i++) {
      guardIdentityArgs('c4', { firstName: 'Pedro', lastName: `Ferreras${i}`, dateOfBirth: '1983-10-05' }, said);
    }
    const last = guardIdentityArgs('c4', { firstName: 'Pedro', lastName: 'Ferreraz', dateOfBirth: '1983-10-05' }, said);
    expect(last.blocked).toBe(false);
    expect(last.note).toMatch(/attempt 3 of 3|do NOT ask again/i);
  });

  it('releasing the call resets the ceiling', () => {
    const said = T(['Ferreras, Pedro, October fifth 1983']);
    for (let i = 0; i < MAX_IDENTITY_ATTEMPTS; i++) {
      guardIdentityArgs('c3', { firstName: 'Pedro', lastName: `X${i}`, dateOfBirth: '1983-10-05' }, said);
    }
    expect(guardIdentityArgs('c3', { firstName: 'Pedro', lastName: 'Y', dateOfBirth: '1983-10-05' }, said).blocked).toBe(true);
    releaseIdentityGuard('c3');
    expect(guardIdentityArgs('c3', { firstName: 'Pedro', lastName: 'Y', dateOfBirth: '1983-10-05' }, said).blocked).toBe(false);
  });
});
