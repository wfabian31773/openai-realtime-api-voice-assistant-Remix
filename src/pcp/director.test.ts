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
    const director = new PcpDirector();
    expect(director.next('call-1').nextQuestion?.field).toBe('callerName');
    director.update('call-1', { callerName: 'Alex Kim' });
    expect(director.next('call-1').nextQuestion?.field).toBe('callerRole');
  });

  it('collects patient context for patient-specific purposes', () => {
    const director = new PcpDirector();
    director.update('call-2', { ...professional, callPurpose: 'check_patient_scheduled' });
    expect(director.next('call-2').nextQuestion?.field).toBe('statedRelationship');
    director.update('call-2', { statedRelationship: 'Referring provider for this patient' });
    expect(director.next('call-2').nextQuestion?.field).toBe('patientFirstName');
  });

  it('routes explicit patient medical-record requests to a task, never peer-to-peer handoff', () => {
    const director = new PcpDirector();
    director.update('records-1', {
      ...professional,
      callPurpose: 'patient_medical_records_request',
      statedRelationship: 'Mutual treating provider',
      patientFirstName: 'Pat', patientLastName: 'Lee', patientDob: '1980-01-02',
    });
    expect(director.next('records-1')).toMatchObject({ disposition: 'CREATE_TASK', handoffEligible: false });
  });

  it('allows hotline schedule lookup while post-call staff verification is pending', () => {
    const director = new PcpDirector();
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
    const director = new PcpDirector();
    director.update('call-4', { ...professional, callPurpose: 'peer_to_peer' });
    const decision = director.next('call-4');
    expect(decision.disposition).toBe('HAND_OFF');
    expect(decision.handoffEligible).toBe(true);
  });

  /**
   * Scheduling was the dominant PCP purpose in production and defaulted to CREATE_TASK,
   * so handoffEligible was never true and handoff_to_pcp refused before dialing —
   * 8 of the first 10 PCP tickets were schedule_appointment with handoff NOT_REQUESTED.
   */
  it('makes scheduling requests eligible for handoff once patient context is known', () => {
    for (const purpose of ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment'] as const) {
      const director = new PcpDirector();
      director.update(purpose, {
        ...professional,
        callPurpose: purpose,
        statedRelationship: 'Referring provider',
        patientFirstName: 'Pat',
        patientLastName: 'Lee',
        patientDob: '1980-01-02',
      });
      expect(director.next(purpose)).toMatchObject({ disposition: 'HAND_OFF', handoffEligible: true });
    }
  });

  /**
   * The transfer must not wait on a DOB the caller may not have to hand. This line
   * cannot schedule at all, so the staffer who takes the call collects what they need;
   * gating the connection on patient context is how a scheduling request silently
   * became a task instead of a transfer.
   */
  it('offers the scheduling handoff on professional identity alone', () => {
    const director = new PcpDirector();
    director.update('sched-minimal', { ...professional, callPurpose: 'schedule_appointment' });
    const decision = director.next('sched-minimal');
    expect(decision.handoffEligible).toBe(true);
    expect(decision.nextQuestion).toBeUndefined();
  });

  it('still requires full professional identity before any scheduling handoff', () => {
    const director = new PcpDirector();
    director.update('sched-anon', { callPurpose: 'schedule_appointment', callerName: 'Dr. Lee' });
    const decision = director.next('sched-anon');
    expect(decision.handoffEligible).toBe(false);
    expect(decision.nextQuestion).toBeDefined();
  });

  it('converts an unavailable handoff into a durable task fallback', () => {
    const director = new PcpDirector();
    director.update('call-5', { ...professional, callPurpose: 'peer_to_peer' });
    director.recordHandoffResult('call-5', { status: 'HANDOFF_UNAVAILABLE', reason: 'destination_missing' });
    const decision = director.next('call-5');
    expect(decision.disposition).toBe('CREATE_TASK');
    expect(decision.mustCreateFallbackTicket).toBe(true);
  });

  it('keeps pharmaceutical callers as tasks unless the explicit handoff flag is enabled', () => {
    const safeDefault = new PcpDirector();
    safeDefault.update('pharma-1', { ...professional, callPurpose: 'pharmaceutical_representative' });
    expect(safeDefault.next('pharma-1').disposition).toBe('CREATE_TASK');

    const enabled = new PcpDirector({ pharmaHandoffEnabled: true });
    enabled.update('pharma-2', { ...professional, callPurpose: 'pharmaceutical_representative' });
    expect(enabled.next('pharma-2')).toMatchObject({ disposition: 'HAND_OFF', handoffEligible: true });
  });

  it('stops retrying a failed tool after two attempts and requires a task', () => {
    const director = new PcpDirector();
    director.update('call-6', { ...professional, callPurpose: 'provider_information' });
    director.recordToolFailure('call-6', 'knowledge_base');
    director.recordToolFailure('call-6', 'knowledge_base');
    const decision = director.next('call-6');
    expect(decision.disposition).toBe('CREATE_TASK');
    expect(decision.authoritativeToolAllowed).toBe(false);
  });

  it('does not permit termination until the selected disposition is durably recorded', () => {
    const director = new PcpDirector();
    director.update('call-7', { ...professional, callPurpose: 'service_inquiry' });
    expect(director.next('call-7').mayTerminate).toBe(false);
    director.recordDisposition('call-7', 'AUTOMATE');
    expect(director.next('call-7').mayTerminate).toBe(true);
  });
});
