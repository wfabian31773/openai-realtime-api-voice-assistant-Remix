/**
 * A patient who reaches the professional line has a path.
 *
 * WHAT THIS FIXES, measured over PCP's only two full days (2026-08-06/07,
 * 419 calls): 117 callers asked for a person or an operator, and the
 * transcripts are full of patients — "I want to call the doctor office and I
 * want the refer some my eye doctor medicine", "My doctor requested a
 * pharmacy", "Operator." "Representatives."
 *
 * The prompt opened "this line is for healthcare professionals", the intake
 * asked for a role, an organisation and a facility type, and handoffPolicy
 * refused a transfer for any caller type that is not a PCP one. A patient had
 * nowhere to go, and the calls died in the intake.
 *
 * The fix deliberately adds no new tools and no new transfer path. It is one
 * purpose, a shorter question list, and the cross-queue routing that is
 * already live on four other queues.
 */
import { describe, it, expect } from 'vitest';
import { PcpDirector } from './director';
import { PCP_CALL_PURPOSES, getPcpCallPurpose } from './policy';
import { resolveHandoffDestination } from '../services/handoffPolicy';

const noLunch = () => false;

describe('a patient is never dialled into the PCP queue', () => {
  it('the purpose does not allow HAND_OFF', () => {
    // PCP_CALLER_TYPES in handoffPolicy is DERIVED from the purposes that
    // allow HAND_OFF. Leaving it off that list is what excludes it, so nobody
    // has to remember to write an exclusion.
    const p = getPcpCallPurpose('patient_caller');
    expect(p.allowedDispositions).not.toContain('HAND_OFF');
    expect(p.defaultDisposition).toBe('CREATE_TASK');
  });

  it('handoffPolicy refuses the dial for a patient caller', () => {
    const r = resolveHandoffDestination({
      agentSlug: 'pcp',
      callerType: 'patient_caller',
      callerRequestedHuman: false,
    } as never);
    expect(r.allowed).toBe(false);
  });

  it('asking for a person does NOT make a patient handoff-eligible', () => {
    // The director grants handoff on an explicit ask alone, no purpose
    // required — right for a clinic, wrong here. The destination is a queue
    // staffed to talk to clinics.
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('c1', { callPurpose: 'patient_caller', callerName: 'Maria Lopez', callbackNumber: '9095551234' });
    d.markCallerRequestedHuman('c1');

    const decision = d.next('c1');
    expect(decision.handoffEligible).toBe(false);
    expect(decision.disposition).toBe('CREATE_TASK');
  });

  it('still grants it on an explicit ask from a clinic', () => {
    // The guard must be about being a patient, not about asking.
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('c2', { callPurpose: 'outside_referral_status' });
    d.markCallerRequestedHuman('c2');

    expect(d.next('c2').handoffEligible).toBe(true);
  });
});

describe('a patient is not asked professional questions', () => {
  it('never asks for a role, an organisation or a facility type', () => {
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('c3', { callPurpose: 'patient_caller' });

    const asked: string[] = [];
    // Walk the intake to exhaustion, answering whatever it asks.
    for (let i = 0; i < 12; i += 1) {
      const q = d.next('c3').nextQuestion;
      if (!q) break;
      asked.push(String(q.field));
      d.update('c3', { [q.field]: 'answer' } as never);
    }

    expect(asked).not.toContain('callerRole');
    expect(asked).not.toContain('callerOrganization');
    expect(asked).not.toContain('callerFacilityType');
    expect(asked).not.toContain('statedRelationship');
  });

  it('asks only for a name, a number and what they need', () => {
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('c4', { callPurpose: 'patient_caller' });

    expect(d.next('c4').nextQuestion?.field).toBe('callerName');
    d.update('c4', { callerName: 'Maria Lopez' });
    expect(d.next('c4').nextQuestion?.field).toBe('callbackNumber');
    d.update('c4', { callbackNumber: '9095551234' });
    expect(d.next('c4').nextQuestion, 'still asking after name + number + purpose').toBeUndefined();
  });

  it('still runs the full professional intake for a clinic', () => {
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('c5', { callPurpose: 'outside_referral_status', callerName: 'Dana' });
    expect(d.next('c5').nextQuestion?.field).toBe('callerRole');
  });
});

describe('the ticket leaves department 18', () => {
  it('routes a patient request by its words, not by the line it arrived on', async () => {
    // create_pcp_task files a patient through the same cross-queue routing
    // every other queue uses. These are the destinations it will pick.
    const { detectCrossQueue } = await import('../tools/queueRouting');
    const PCP = 18;

    expect(detectCrossQueue('I need a refill on my eye drops', PCP)?.departmentId).toBe(3);
    expect(detectCrossQueue('my glasses broke at the hinge', PCP)?.departmentId).toBe(1);
    expect(detectCrossQueue('I need to reschedule my appointment', PCP)?.departmentId).toBe(9);
    expect(detectCrossQueue('a question about my cataract surgery', PCP)?.departmentId).toBe(2);
  });

  it('falls to department 18\'s own catch-all when nothing matches', async () => {
    const { detectCrossQueue } = await import('../tools/queueRouting');
    const { otherReasonFor } = await import('../tools/otherReason');

    expect(detectCrossQueue('I just had a general question', 18)).toBeNull();
    const home = otherReasonFor(18);
    expect(home?.requestTypeId).toBe(80);
    expect(home?.requestReasonId).toBe(550);
  });
});

describe('the purpose table stays coherent', () => {
  it('patient_caller is the only purpose that is CREATE_TASK-only and PHI-bearing without patient context', () => {
    const p = getPcpCallPurpose('patient_caller');
    expect(p.patientContextRequired).toBe(false);
    expect(p.containsPhi).toBe(true);
    expect(p.authoritativeSource).toBeNull();
  });

  it('has no duplicate slugs', () => {
    const slugs = PCP_CALL_PURPOSES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/**
 * A patient asking the PCP line for their own records goes to Medical Records,
 * and onto the clock. Operator ruling, 2026-08-13: "yes to patients routing
 * to 16".
 *
 * Nothing ELSE routes into department 16 — a records team is not somewhere to
 * send a call on a keyword, and a request arriving without a known requester
 * lets the ticketing app default the mr_cases pathway to `roa_patient`, which
 * is the defect that put all 470 existing cases on a 15-day statutory clock.
 *
 * This path is the exception because it is the one place we KNOW: the purpose
 * IS patient_caller, so the requester is stated rather than inferred.
 */
describe('a patient\'s records request leaves the PCP line for department 16', () => {
  it('recognises the records language the taxonomy already knows', async () => {
    const { classifyRecords } = await import('../tools/medicalRecordsTaxonomy');

    expect(classifyRecords('I need a copy of my records')?.requestReasonId).toBe(500);
    expect(classifyRecords('can you send my chart to my new doctor')?.requestReasonId).toBe(502);
    expect(classifyRecords("I need a doctor's note for work")?.requestReasonId).toBe(504);
  });

  it('puts a patient on the clock under the right-of-access pathway', async () => {
    const { determineCapClock } = await import('../tools/medicalRecordsTaxonomy');
    const cap = determineCapClock('patient');

    expect(cap.onClock).toBe(true);
    expect(cap.pathway).toBe('roa_patient');
    expect(cap.note).toMatch(/CAP reportable/i);
  });

  it('still leaves a non-records patient request to cross-queue routing', async () => {
    // The records branch must not swallow everything. A refill is a refill.
    const { classifyRecords } = await import('../tools/medicalRecordsTaxonomy');
    const { detectCrossQueue } = await import('../tools/queueRouting');

    expect(classifyRecords('I need a refill on my eye drops')).toBeNull();
    expect(detectCrossQueue('I need a refill on my eye drops', 18)?.departmentId).toBe(3);
  });
});
