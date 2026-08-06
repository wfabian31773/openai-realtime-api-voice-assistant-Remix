import { describe, it, expect } from 'vitest';
import { isLunchClosure } from '../utils/timeAware';
import { resolveHandoffDestination } from './handoffPolicy';
import { PcpDirector } from '../pcp/director';

/**
 * Operator directive 2026-08-06: the practice is closed 12:00-13:00 Pacific for
 * lunch (si_locations.lunch_window is '12:00-13:00' at every location), so calls
 * in that window get a callback or follow-up rather than a transfer attempt.
 *
 * Two layers, deliberately: the DIRECTOR downgrades the disposition so the agent
 * never promises "one moment while I connect you", and the POLICY refuses the
 * dial as the backstop if anything reaches it anyway.
 */

const MON = 'Mon';

describe('isLunchClosure', () => {
  it('is true for the noon hour on a weekday', () => {
    expect(isLunchClosure({ hour: 12, shortDay: MON })).toBe(true);
    expect(isLunchClosure({ hour: 12, shortDay: 'Fri' })).toBe(true);
  });

  it('is false on either side of the window', () => {
    expect(isLunchClosure({ hour: 11, shortDay: MON })).toBe(false);
    expect(isLunchClosure({ hour: 13, shortDay: MON })).toBe(false);
  });

  it('is false at the weekend — that is closed, not at lunch', () => {
    // Reporting "lunch" for a Saturday noon would be the wrong reason on the
    // ticket and would mislead whoever reads it.
    expect(isLunchClosure({ hour: 12, shortDay: 'Sat' })).toBe(false);
    expect(isLunchClosure({ hour: 12, shortDay: 'Sun' })).toBe(false);
  });
});

describe('handoffPolicy — PCP dial refused at lunch', () => {
  const base = { agentSlug: 'pcp', callerType: 'peer_to_peer', pcpNumber: '+17149564300' };

  it('refuses the PCP dial during lunch', () => {
    expect(resolveHandoffDestination({ ...base, lunchClosure: true }))
      .toEqual({ allowed: false, reason: 'pcp_lunch_closure' });
  });

  it('allows the PCP dial outside lunch', () => {
    expect(resolveHandoffDestination({ ...base, lunchClosure: false }))
      .toEqual({ allowed: true, destination: '+17149564300', policy: 'pcp' });
  });

  it('NEVER blocks an urgent clinical transfer at lunch', () => {
    // The whole point of the carve-out: a patient with an urgent medical
    // problem at 12:30 must still reach a person.
    for (const callerType of ['patient_urgent', 'patient_urgent_medical', 'patient_unresponsive', 'healthcare_provider']) {
      expect(resolveHandoffDestination({ callerType, clinicalNumber: '+17143990670', lunchClosure: true }))
        .toEqual({ allowed: true, destination: '+17143990670', policy: 'clinical' });
    }
  });
});

describe('PcpDirector — disposition downgraded before anything is promised', () => {
  const atLunch = new PcpDirector({ lunchClosure: () => true });
  const notLunch = new PcpDirector({ lunchClosure: () => false });

  /** A complete professional caller whose purpose defaults to HAND_OFF. */
  const seed = (d: PcpDirector, callId: string) => {
    d.update(callId, {
      callerName: 'Dana Reed',
      callerRole: 'referral coordinator',
      callerOrganization: 'Valley Medical Group',
      callerFacilityType: 'ipa_medical_group',
      callbackNumber: '+15625551234',
      callPurpose: 'peer_to_peer',
      statedRelationship: 'Treating physician',
      patientFirstName: 'Ada',
      patientLastName: 'Lovelace',
      patientDob: '1965-03-02',
    });
    return d.next(callId);
  };

  it('offers a task instead of a handoff during lunch', () => {
    const decision = seed(atLunch, 'lunch-call');
    expect(decision.handoffEligible).toBe(false);
    expect(decision.disposition).toBe('CREATE_TASK');
  });

  it('still hands off outside lunch — the gate is the clock, not the caller', () => {
    const decision = seed(notLunch, 'normal-call');
    expect(decision.disposition).toBe('HAND_OFF');
    expect(decision.handoffEligible).toBe(true);
  });
});
