/**
 * Local tool-gate tests, replaying the two refusals that cost live pilot calls:
 * `appointment_reference_unknown` (15 blocked calls, sage_reschedule burning 34
 * invocations across 9) and `identity_required` on sage_handoff (24 refusals,
 * one call firing seven in 34 seconds).
 */
import { describe, expect, it } from 'vitest';
import {
  checkAppointmentOrdinal,
  checkHandoffIdentity,
  handoffIdentity,
  refusalJson,
} from './azulToolGuards';

describe('checkAppointmentOrdinal', () => {
  it('blocks when the appointment list was never fetched', () => {
    const r = checkAppointmentOrdinal(null, 1);
    expect(r).not.toBeNull();
    expect(r!.error).toBe('appointment_reference_unknown');
    expect(r!.agent_instruction).toContain('get_patient_appointments');
  });

  it('blocks when the caller has no appointments, and says not to retry', () => {
    const r = checkAppointmentOrdinal(0, 1);
    expect(r).not.toBeNull();
    expect(r!.agent_instruction).toMatch(/NO appointments/);
    expect(r!.agent_instruction).toMatch(/Do not retry/);
  });

  it('blocks an ordinal outside the list and names the valid range', () => {
    const r = checkAppointmentOrdinal(2, 3);
    expect(r).not.toBeNull();
    expect(r!.agent_instruction).toContain('numbered 1 to 2');
  });

  it('gets the singular right for a one-appointment list', () => {
    // appointmentCount:1 was the most common outcome in the pilot (31 calls).
    expect(checkAppointmentOrdinal(1, 2)!.agent_instruction).toContain('1 appointment,');
  });

  it('allows a valid ordinal', () => {
    expect(checkAppointmentOrdinal(1, 1)).toBeNull();
    expect(checkAppointmentOrdinal(5, 5)).toBeNull();
    expect(checkAppointmentOrdinal(4, 2)).toBeNull();
  });

  it('rejects nonsense ordinals rather than passing them to the service', () => {
    for (const bad of [0, -1, 1.5, 'two', null, undefined, NaN]) {
      expect(checkAppointmentOrdinal(3, bad), String(bad)).not.toBeNull();
    }
  });
});

describe('checkHandoffIdentity', () => {
  it('allows the FIRST attempt even with nothing — the server may still route it', () => {
    // We must not become stricter than the service: a refusal noted in
    // patientResponse is a legitimate anonymous handoff.
    expect(checkHandoffIdentity({ verified: false, name: null, priorRefusals: 0 })).toBeNull();
  });

  it('blocks the SECOND identical anonymous attempt', () => {
    const r = checkHandoffIdentity({ verified: false, name: null, priorRefusals: 1 });
    expect(r).not.toBeNull();
    expect(r!.error).toBe('identity_required');
    expect(r!.agent_instruction).toMatch(/Retrying cannot succeed/);
  });

  it('allows a retry once there IS a name — that is new information', () => {
    expect(checkHandoffIdentity({ verified: false, name: 'Irma Allen', priorRefusals: 3 })).toBeNull();
  });

  it('never blocks a verified call', () => {
    expect(checkHandoffIdentity({ verified: true, name: null, priorRefusals: 7 })).toBeNull();
  });

  it('treats whitespace as no name', () => {
    expect(checkHandoffIdentity({ verified: false, name: '   ', priorRefusals: 1 })).not.toBeNull();
  });
});

describe('handoffIdentity', () => {
  it('sends NOTHING for a verified caller — the server injects the personId', () => {
    expect(handoffIdentity({
      verified: true,
      attempt: { firstName: 'Irma', lastName: 'Allen', dateOfBirth: '1944-11-17' },
    })).toEqual({});
  });

  it('falls back to what the caller already said when unverified', () => {
    // The name the caller gave failed to MATCH a record; it is not unknown.
    // This is the exact case call 2a602292 kept being refused for.
    expect(handoffIdentity({
      verified: false,
      attempt: { firstName: 'Irma', lastName: 'Allen', dateOfBirth: '1944-11-17' },
    })).toEqual({ name: 'Irma Allen', dob: '1944-11-17' });
  });

  it('prefers an explicit argument over the fallback', () => {
    expect(handoffIdentity({
      verified: false,
      patientName: 'Maria Ramirez',
      attempt: { firstName: 'Irma', lastName: 'Allen' },
    }).name).toBe('Maria Ramirez');
  });

  it('copes with a partial attempt', () => {
    expect(handoffIdentity({ verified: false, attempt: { lastName: 'Allen' } })).toEqual({ name: 'Allen' });
    expect(handoffIdentity({ verified: false, attempt: { dateOfBirth: '1944-11-17' } })).toEqual({ dob: '1944-11-17' });
  });

  it('returns nothing when there is genuinely nothing', () => {
    expect(handoffIdentity({ verified: false, attempt: null })).toEqual({});
    expect(handoffIdentity({ verified: false })).toEqual({});
  });
});

describe('refusalJson', () => {
  it('matches the envelope the agent already parses', () => {
    // The service wraps everything as {tool, result}; a local refusal must look
    // the same or the agent's own unwrapping misses it.
    const parsed = JSON.parse(refusalJson('sage_handoff', {
      error: 'identity_required',
      decision: 'blocked_locally',
      agent_instruction: 'do the thing',
    }));
    expect(parsed.tool).toBe('sage_handoff');
    expect(parsed.result.ok).toBe(false);
    expect(parsed.result.error).toBe('identity_required');
    expect(parsed.result.agent_instruction).toBe('do the thing');
  });
});
