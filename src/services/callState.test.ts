/**
 * Call-state projection tests.
 *
 * The centrepiece replays the operator's scenario: a caller is verified by the
 * Eye Care service, and the agent then asks "Are you a new or existing patient?"
 * That must be a NAMED violation, not a judgement call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CallStateStore,
  INVARIANTS,
  checkAsk,
  nextExpectedAction,
  prohibitedQuestions,
  redactState,
  stateLogLine,
} from './callState';

let clock: number;
let d: CallStateStore;

beforeEach(() => {
  clock = Date.parse('2026-08-05T09:41:00.000Z');
  d = new CallStateStore(() => new Date((clock += 1000)).toISOString());
});

const CALL = 'rtc_test';
const SLUG = 'azul-scheduling';
const apply = (ev: Parameters<CallStateStore['apply']>[2]) => d.apply(CALL, SLUG, ev)!;

describe('the identity fact arrives once, from the service', () => {
  it('IDENTITY_VERIFIED sets the whole identity block', () => {
    const s = apply({
      type: 'IDENTITY_VERIFIED',
      patientType: 'existing',
      personVerified: true,
      name: 'Fabian',
      dob: '1973-03-17',
    });
    expect(s.identity.personVerified).toBe(true);
    expect(s.identity.identityVerified).toBe(true);
    expect(s.identity.patientType).toBe('existing');
    expect(s.identity.verifiedAt).toBeTruthy();
  });

  it('is not re-derived from the transcript — nothing else can set it', () => {
    // Supplying name and DOB is NOT verification. Only the service's verdict is.
    apply({ type: 'FIELD_SUPPLIED', field: 'last name', value: 'Fabian' });
    const s = apply({ type: 'FIELD_SUPPLIED', field: 'date of birth', value: '1973-03-17' });
    expect(s.identity.identityVerified).toBe(false);
    expect(s.identity.patientType).toBe('unknown');
  });
});

describe('invariants close the settled questions', () => {
  const verify = () =>
    apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true });

  it('lists nothing as prohibited before verification', () => {
    const s = apply({ type: 'CALL_STARTED', agentSlug: SLUG });
    expect(prohibitedQuestions(s)).toEqual([]);
    expect(checkAsk(s, 'existing patient')).toBeNull();
  });

  it('closes patient type, DOB and name once verified', () => {
    const s = verify();
    for (const t of ['existing patient', 'date of birth', 'last name', 'first name', 'full name']) {
      expect(s.director.prohibitedQuestions, t).toContain(t);
      expect(checkAsk(s, t), t).not.toBeNull();
    }
  });

  it('leaves the questions the call still needs OPEN', () => {
    const s = verify();
    for (const t of ['location', 'time preference', 'reason for visit', 'insurance']) {
      expect(s.director.prohibitedQuestions, t).not.toContain(t);
      expect(checkAsk(s, t), t).toBeNull();
    }
  });

  it('reopens them ONLY on explicit invalidation', () => {
    verify();
    const s = apply({ type: 'IDENTITY_INVALIDATED', reason: 'caller is not the patient' });
    expect(s.identity.identityVerified).toBe(false);
    expect(s.director.prohibitedQuestions).not.toContain('date of birth');
    expect(s.identity.invalidatedReason).toBe('caller is not the patient');
  });

  it('every invariant has a stable id and an explanation', () => {
    for (const inv of INVARIANTS) {
      expect(inv.id).toMatch(/^[a-z0-9_]+$/);
      expect(inv.because.length).toBeGreaterThan(20);
      expect(inv.prohibits.length).toBeGreaterThan(0);
    }
  });
});

describe("the operator's scenario, replayed turn by turn", () => {
  it('records patient_type re-asked after verification as a violation', () => {
    apply({ type: 'CALL_STARTED', agentSlug: SLUG });
    apply({ type: 'CALLER_MATCHED', phoneMatched: true, matchedName: 'Wayne Fabian' });
    apply({ type: 'AGENT_ASKED', topic: 'last name' });
    apply({ type: 'FIELD_SUPPLIED', field: 'last name', value: 'Fabian' });
    apply({ type: 'AGENT_ASKED', topic: 'date of birth' });
    apply({ type: 'FIELD_SUPPLIED', field: 'date of birth', value: '1973-03-17' });
    apply({ type: 'TOOL_RESULT', tool: 'verify_patient_identity', status: 'success', detail: 'verified' });
    apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true });

    // The turn the whole design exists to catch.
    const s = apply({
      type: 'AGENT_ASKED',
      topic: 'existing patient',
      line: 'Are you a new or existing patient?',
    });

    expect(s.violations).toHaveLength(1);
    expect(s.violations[0].invariant).toBe('identity_reasked_after_verification');
    expect(s.violations[0].topic).toBe('existing patient');

    // And the panel the operator asked for reads straight off the state.
    expect(s.caller.phoneMatched).toBe(true);
    expect(s.caller.matchedName).toBe('Wayne Fabian');
    expect(s.identity.nameSupplied).toBe('Fabian');
    expect(s.identity.dobSupplied).toBe('1973-03-17');
    expect(s.identity.patientType).toBe('existing');
    expect(s.tools['verify_patient_identity'].status).toBe('success');
    expect(s.conversation.askCounts['last name']).toBe(1);
    expect(s.conversation.askCounts['date of birth']).toBe(1);
    expect(s.conversation.askCounts['existing patient']).toBe(1);
  });

  it('gives a per-turn timeline with the state that produced each line', () => {
    apply({ type: 'FIELD_SUPPLIED', field: 'last name', value: 'Fabian' });
    apply({ type: 'TOOL_RESULT', tool: 'verify_patient_identity', status: 'success', detail: 'verified' });
    apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true });
    apply({ type: 'AGENT_ASKED', topic: 'existing patient', line: 'Are you a new or existing patient?' });

    const snaps = d.snapshots(CALL);
    expect(snaps.map((s) => s.source)).toEqual(['caller', 'tool', 'tool', 'agent']);
    expect(snaps[2].state.identity.identityVerified).toBe(true);
    // The violation is attached to the turn that caused it.
    expect(snaps[3].violation?.invariant).toBe('identity_reasked_after_verification');
    // Earlier turns carry no violation.
    expect(snaps.slice(0, 3).every((s) => s.violation === null)).toBe(true);
  });
});

describe('nextExpectedAction', () => {
  it('walks the identity ladder, then the intent', () => {
    let s = apply({ type: 'CALL_STARTED', agentSlug: SLUG });
    expect(nextExpectedAction(s)).toBe('collect last name');
    s = apply({ type: 'FIELD_SUPPLIED', field: 'last name', value: 'Fabian' });
    expect(nextExpectedAction(s)).toBe('collect date of birth');
    s = apply({ type: 'FIELD_SUPPLIED', field: 'date of birth', value: '1973-03-17' });
    expect(nextExpectedAction(s)).toBe('call verify_patient_identity');
    s = apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true });
    expect(nextExpectedAction(s)).toBe('establish what the caller wants');
    s = apply({ type: 'INTENT_SET', intent: 'schedule appointment' });
    s = apply({ type: 'AGENT_ASKED', topic: 'location' });
    expect(nextExpectedAction(s)).toBe('awaiting location');
  });
});

describe('bookkeeping', () => {
  it('an answered field clears the pending ask', () => {
    apply({ type: 'AGENT_ASKED', topic: 'location' });
    expect(d.get(CALL)!.conversation.pendingAsk).toBe('location');
    const s = apply({ type: 'FIELD_SUPPLIED', field: 'location', value: 'Encinitas' });
    expect(s.conversation.pendingAsk).toBeNull();
  });

  it('seq advances on every event so a client can skip unchanged polls', () => {
    const a = apply({ type: 'CALL_STARTED', agentSlug: SLUG });
    const b = apply({ type: 'INTENT_SET', intent: 'cancel appointment' });
    expect(b.seq).toBe(a.seq + 1);
  });

  it('the reducer does not mutate the previous state', () => {
    const first = apply({ type: 'AGENT_ASKED', topic: 'last name' });
    const before = JSON.stringify(first);
    apply({ type: 'AGENT_ASKED', topic: 'last name' });
    expect(JSON.stringify(first)).toBe(before);
  });

  it('release frees the call', () => {
    apply({ type: 'CALL_STARTED', agentSlug: SLUG });
    expect(d.activeCallIds()).toContain(CALL);
    d.release(CALL);
    expect(d.get(CALL)).toBeNull();
    expect(d.snapshots(CALL)).toEqual([]);
  });

  it('a bad event never throws into the call', () => {
    expect(() => d.apply('', SLUG, { type: 'CALL_STARTED', agentSlug: SLUG })).not.toThrow();
    expect(d.apply('', SLUG, { type: 'CALL_STARTED', agentSlug: SLUG })).toBeNull();
  });
});

describe('PHI', () => {
  it('redactState keeps the shape and drops the values', () => {
    apply({ type: 'CALLER_MATCHED', phoneMatched: true, matchedName: 'Wayne Fabian' });
    apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true, name: 'Fabian', dob: '1973-03-17' });
    const r = redactState(d.get(CALL)!);
    expect(r.identity.nameSupplied).toBe('[REDACTED]');
    expect(r.identity.dobSupplied).toBe('[REDACTED]');
    expect(r.caller.matchedName).toBe('[REDACTED]');
    // The facts a reviewer needs survive redaction.
    expect(r.identity.identityVerified).toBe(true);
    expect(r.identity.patientType).toBe('existing');
    expect(r.caller.phoneMatched).toBe(true);
  });

  it('the log line carries no values at all', () => {
    apply({ type: 'CALLER_MATCHED', phoneMatched: true, matchedName: 'Wayne Fabian' });
    apply({ type: 'IDENTITY_VERIFIED', patientType: 'existing', personVerified: true, name: 'Fabian', dob: '1973-03-17' });
    const line = stateLogLine(d.get(CALL)!);
    expect(line).not.toContain('Fabian');
    expect(line).not.toContain('1973');
    expect(line).toContain('verified=true');
    expect(line).toContain('type=existing');
  });
});
