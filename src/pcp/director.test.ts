/**
 * THE CLOCK IS PINNED IN EVERY DIRECTOR BUILT HERE.
 *
 * PcpDirector reads the real Pacific clock for the 12:00-13:00 lunch closure
 * unless `lunchClosure` is injected, and at lunch it downgrades HAND_OFF to
 * CREATE_TASK. Four tests here asserted handoff eligibility without pinning
 * it, so they failed for one hour a day and passed the other twenty-three.
 * Lunch behaviour is covered on purpose in `services/lunchClosure.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PcpDirector } from './director';

const professional = {
  callerName: 'Alex Kim',
  callerRole: 'Referral coordinator',
  callerOrganization: 'North County Medical Group',
  callerFacilityType: 'ipa_medical_group' as const,
  callbackNumber: '+17605550100',
};

describe('PcpDirector', () => {
  it('asks exactly one deterministic next question and never re-asks stored fields', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    // callPurpose leads — it gates four tools, and collecting it last is what
    // produced 180 `call_purpose_required` refusals in a single day (08-07).
    expect(director.next('call-1').nextQuestion?.field).toBe('callPurpose');
    director.update('call-1', { callPurpose: 'peer_to_peer' });
    expect(director.next('call-1').nextQuestion?.field).toBe('callerName');
    director.update('call-1', { callerName: 'Alex Kim' });
    expect(director.next('call-1').nextQuestion?.field).toBe('callerRole');
  });

  it('collects patient context for patient-specific purposes', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-2', { ...professional, callPurpose: 'check_patient_scheduled' });
    expect(director.next('call-2').nextQuestion?.field).toBe('statedRelationship');
    director.update('call-2', { statedRelationship: 'Referring provider for this patient' });
    expect(director.next('call-2').nextQuestion?.field).toBe('patientFirstName');
  });

  it('routes explicit patient medical-record requests to a task, never peer-to-peer handoff', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('records-1', {
      ...professional,
      callPurpose: 'patient_medical_records_request',
      statedRelationship: 'Mutual treating provider',
      patientFirstName: 'Pat', patientLastName: 'Lee', patientDob: '1980-01-02',
    });
    expect(director.next('records-1')).toMatchObject({ disposition: 'CREATE_TASK', handoffEligible: false });
  });

  it('allows hotline schedule lookup while post-call staff verification is pending', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-3', {
      ...professional,
      callPurpose: 'check_patient_scheduled',
      statedRelationship: 'Referring provider',
      patientFirstName: 'Pat',
      patientLastName: 'Lee',
      patientDob: '1980-01-02',
      verificationStatus: 'pending',
    });
    const decision = director.next('call-3');
    expect(decision.phiDisclosureAllowed).toBe(true);
    expect(decision.authoritativeToolAllowed).toBe(true);
    expect(decision.disposition).toBe('AUTOMATE');
  });

  it('makes peer-to-peer eligible for handoff after minimum professional identity', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-4', { ...professional, callPurpose: 'peer_to_peer' });
    const decision = director.next('call-4');
    expect(decision.disposition).toBe('HAND_OFF');
    expect(decision.handoffEligible).toBe(true);
  });

  /**
   * THESE THREE ASSERTED THE OPPOSITE UNTIL 2026-09-14, and the history is
   * worth keeping because both versions were right for their own ruling.
   *
   * They were written when scheduling defaulted to CREATE_TASK and so could
   * never be connected to anyone — 8 of the first 10 PCP tickets were
   * `schedule_appointment` with handoff NOT_REQUESTED. Flipping the default to
   * HAND_OFF fixed that, and then bought very little: measured over all 217
   * PCP tickets, 56 of the 75 scheduling ones attempted a transfer and **10
   * connected, 17.9%**, while ZERO reached the team that actually schedules.
   *
   * The operator withdrew auto-transfer on 2026-09-04 — "never auto-transfer;
   * transfer only when the caller ASKS and is an entity" — so the second arm
   * of `handoffEligible` no longer fires for these purposes. What replaces it
   * is not a task in department 18: `create_pcp_task` routes the request to
   * the HVA Hub (standing instruction 10). The original complaint, that a
   * scheduling caller reached nobody, is answered by the destination rather
   * than by the dial.
   */
  it('does NOT dial a scheduling caller who never asked for a person', () => {
    for (const purpose of ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment'] as const) {
      const director = new PcpDirector({ lunchClosure: () => false });
      director.update(purpose, {
        ...professional,
        callPurpose: purpose,
        statedRelationship: 'Referring provider',
        patientFirstName: 'Pat',
        patientLastName: 'Lee',
        patientDob: '1980-01-02',
      });
      expect(director.next(purpose)).toMatchObject({ disposition: 'CREATE_TASK', handoffEligible: false });
    }
  });

  it('but connects the same caller the moment they ask — the ask was never the problem', () => {
    for (const purpose of ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment'] as const) {
      const director = new PcpDirector({ lunchClosure: () => false });
      director.update(`ask-${purpose}`, {
        ...professional,
        callPurpose: purpose,
        callerRequestedHuman: true,
      });
      expect(director.next(`ask-${purpose}`)).toMatchObject({ disposition: 'HAND_OFF', handoffEligible: true });
    }
  });

  /**
   * THE INTAKE DID NOT LENGTHEN, and this is the half of the old test that
   * still has to hold.
   *
   * The transfer must not wait on a DOB the caller may not have to hand, and
   * neither must the FILING: `connectsToHuman` is what keeps PATIENT_FIELDS —
   * whose first question is "What is your professional relationship to this
   * patient?" — off a scheduling intake. It now reads `allowedDispositions`
   * rather than the default, precisely so that flipping the default above did
   * not quietly add four questions to a live call.
   */
  it('still asks a scheduling caller nothing beyond professional identity', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('sched-minimal', { ...professional, callPurpose: 'schedule_appointment' });
    expect(director.next('sched-minimal').nextQuestion).toBeUndefined();
  });

  /**
   * Moved onto `peer_to_peer` deliberately. This guards the SECOND arm of
   * `handoffEligible` — a complete intake on a HAND_OFF purpose — and after
   * the ruling above that arm is unreachable from a scheduling slug, so asking
   * it there would pass for the wrong reason and protect nothing.
   */
  it('still requires full professional identity before an unasked-for handoff', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('p2p-anon', { callPurpose: 'peer_to_peer', callerName: 'Dr. Lee' });
    const decision = director.next('p2p-anon');
    expect(decision.handoffEligible).toBe(false);
    expect(decision.nextQuestion).toBeDefined();
  });

  it('converts an unavailable handoff into a durable task fallback', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-5', { ...professional, callPurpose: 'peer_to_peer' });
    director.recordHandoffResult('call-5', { status: 'HANDOFF_UNAVAILABLE', reason: 'destination_missing' });
    const decision = director.next('call-5');
    expect(decision.disposition).toBe('CREATE_TASK');
    expect(decision.mustCreateFallbackTicket).toBe(true);
  });

  it('keeps pharmaceutical callers as tasks unless the explicit handoff flag is enabled', () => {
    const safeDefault = new PcpDirector({ lunchClosure: () => false });
    safeDefault.update('pharma-1', { ...professional, callPurpose: 'pharmaceutical_representative' });
    expect(safeDefault.next('pharma-1').disposition).toBe('CREATE_TASK');

    const enabled = new PcpDirector({ pharmaHandoffEnabled: true, lunchClosure: () => false });
    enabled.update('pharma-2', { ...professional, callPurpose: 'pharmaceutical_representative' });
    expect(enabled.next('pharma-2')).toMatchObject({ disposition: 'HAND_OFF', handoffEligible: true });
  });

  it('stops retrying a failed tool after two attempts and requires a task', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-6', { ...professional, callPurpose: 'provider_information' });
    director.recordToolFailure('call-6', 'knowledge_base');
    director.recordToolFailure('call-6', 'knowledge_base');
    const decision = director.next('call-6');
    expect(decision.disposition).toBe('CREATE_TASK');
    expect(decision.authoritativeToolAllowed).toBe(false);
  });

  it('does not permit termination until the selected disposition is durably recorded', () => {
    const director = new PcpDirector({ lunchClosure: () => false });
    director.update('call-7', { ...professional, callPurpose: 'service_inquiry' });
    expect(director.next('call-7').mayTerminate).toBe(false);
    director.recordDisposition('call-7', 'AUTOMATE');
    expect(director.next('call-7').mayTerminate).toBe(true);
  });
});
