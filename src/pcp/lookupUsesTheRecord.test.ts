/**
 * THE PCP LINE ASKS THE PERSON BASE, NOT ONLY THE APPOINTMENT BOOK.
 *
 * Operator, 2026-09-13, after calling the line and being found:
 *
 *   "When I called the pcp line it was able to find me, probably still using
 *    the old schedule table. We absolutely must get this on the zero rule.
 *    especially with our CAP on medical records."
 *
 * He was right about the cause. `lookup_patient_appointments` called
 * `scheduleLookupService.lookupByNameAndDOB` — ONE rung, the Operations Hub
 * appointment book, matched on name and date-of-birth STRINGS. Everything
 * #292 built (the `patients_master` rung and the `PersonID` join) lives in
 * `lookupPatient`, a different method this lane never called. So PCP was the
 * only lane on the fleet still outside RULE ZERO.
 *
 * WHY IT MATTERS MOST HERE. Measured over all 217 PCP tickets on 2026-09-13:
 * `patient_medical_records_request` is **69 of them — 31.8% of the line**, and
 * `check_patient_scheduled` / `check_patient_kept_appointment` /
 * `outside_referral_status` / `notify_referral_approval` add 32 more. Nearly
 * half this line's traffic is a lookup about somebody who is not on the phone,
 * and a records request that identifies the wrong person is a CAP problem, not
 * an inconvenience.
 *
 * These tests pin three things that can quietly undo it: that the lane reaches
 * the Rule Zero path at all, that it never keys the lookup on the CALLER's
 * phone, and that the subject's name and date of birth stay out of the console.
 *
 * Every fixture is invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupPatient = vi.fn();
const lookupByNameAndDOB = vi.fn();

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient, lookupByNameAndDOB },
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

let n = 0;
const freshCall = () => `pcp-rule-zero-${++n}`;

const call = async (agent: any, name: string, args: unknown) => {
  const t = agent.tools.find((tool: any) => tool.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  const raw = await t.invoke({} as any, JSON.stringify(args));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed?.result ?? parsed;
};

/** The caller is a professional at a clinic; the PATIENT is someone else. */
const CALLER_PHONE = '+17605550100';
const PATIENT = {
  patientFirstName: 'Rosalind',
  patientLastName: 'Ashgrove',
  patientDob: '1948-02-11',
};

const build = (callId: string) =>
  createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), {
    callId,
    callSid: `CA${callId}`,
    callerPhone: CALLER_PHONE,
  });

/** Get the director past the purpose gate onto a scheduling-sourced purpose. */
async function readyForLookup(agent: any, callId: string) {
  pcpDirector.update(callId, {
    callPurpose: 'check_patient_scheduled',
    callerName: 'Dana Okafor',
    callerRole: 'Referral coordinator',
    callerOrganization: 'North County Medical Group',
    callerFacilityType: 'ipa_medical_group',
    callbackNumber: CALLER_PHONE,
  });
}

const found = {
  patientFound: true,
  upcomingAppointments: [],
  pastAppointments: [],
  totalAppointmentsFound: 0,
};

beforeEach(() => {
  lookupPatient.mockReset().mockResolvedValue(found);
  lookupByNameAndDOB.mockReset().mockResolvedValue(found);
});

describe('PCP runs on the record, not only on the appointment book', () => {
  it('reaches lookupPatient — the rung that falls through to patients_master', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await readyForLookup(agent, callId);

    const result = await call(agent, 'lookup_patient_appointments', PATIENT);

    expect(result.success).toBe(true);
    expect(lookupPatient).toHaveBeenCalledTimes(1);
    // The single-rung book call is what this replaced. If it comes back, the
    // lane has silently dropped off Rule Zero again and nothing else here fails.
    expect(lookupByNameAndDOB).not.toHaveBeenCalled();
  });

  it("never keys the lookup on the CALLER's phone — the subject is a third party", async () => {
    const callId = freshCall();
    const agent = build(callId);
    await readyForLookup(agent, callId);

    await call(agent, 'lookup_patient_appointments', PATIENT);

    const [params] = lookupPatient.mock.calls[0];
    /**
     * The whole reason this lane is different. `lookupPatient` accepts a
     * phone and will happily identify whoever owns it — and on THIS line the
     * phone belongs to a medical assistant asking about a patient. A coordinator
     * who is also an Azul patient would match HERSELF, and we would answer a
     * question about the wrong person's chart. Only the patient's own identity
     * may key this.
     */
    expect(params.phone).toBeUndefined();
    expect(params).toMatchObject({
      firstName: PATIENT.patientFirstName,
      lastName: PATIENT.patientLastName,
      dateOfBirth: PATIENT.patientDob,
    });
  });

  it("keeps the subject's name and date of birth out of the console", async () => {
    const callId = freshCall();
    const agent = build(callId);
    await readyForLookup(agent, callId);

    await call(agent, 'lookup_patient_appointments', PATIENT);

    // The book rungs log `<first> <last> (DOB: <dob>)` unless told not to, and
    // `lookupPatient` forwards this flag to both of them. The call it replaced
    // passed `logIdentifiers: false`; dropping it would start writing a third
    // party's date of birth to the logs.
    expect(lookupPatient.mock.calls[0][0].logIdentifiers).toBe(false);
  });

  it('still reports a miss as a miss rather than inventing a patient', async () => {
    const callId = freshCall();
    const agent = build(callId);
    await readyForLookup(agent, callId);
    lookupPatient.mockResolvedValue({
      patientFound: false,
      upcomingAppointments: [],
      pastAppointments: [],
    });

    const result = await call(agent, 'lookup_patient_appointments', PATIENT);

    expect(result.success).toBe(true);
    expect(result.patientFound).toBe(false);
  });
});
