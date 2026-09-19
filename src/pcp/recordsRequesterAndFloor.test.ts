/**
 * TWO WAYS THE MEDICAL RECORDS ROUTE WAS WRONG ON ITS FIRST DAY.
 *
 * Both found by Codex on #296, both verified against the code before being
 * accepted, and both about the same lane: PCP, where 31.8% of all traffic is a
 * records request and the modal caller is a medical assistant or coordinator
 * at a doctor's office.
 *
 * 1. EVERY PROFESSIONAL CALLER WAS FILED AS THE PATIENT'S PERSONAL
 *    REPRESENTATIVE. `statedRelationship` is collected by the question *"What
 *    is your PROFESSIONAL relationship to this patient?"* (director.ts), so a
 *    clinic answers it with "primary care provider" — and the requester
 *    ternary mapped any non-empty answer to `personal_representative`. That is
 *    the `roa_patient` pathway with the statutory clock running, on a request
 *    that is not going back to the patient. `resolveRequesterType` cannot save
 *    it: its guard is one-directional by design, so a stated ON-clock value
 *    beats an off-clock `provider` read from the prose.
 *
 * 2. A LIBRARY REFUSAL DID NOT ADVANCE THE STRIKE BUDGET, so PCP's floor was
 *    unreachable and the request filed NOWHERE. `record_pcp_intake` accepts a
 *    7-digit callback (`z.string().min(7)`); `file_records_ticket` refuses
 *    under ten. Neither of PCP's own gates fires on such a call — the intake
 *    is complete and the destination is captured — so `ticketBlocksUsed` stays
 *    at zero, every retry returns the identical refusal, and `floorReached`
 *    never becomes true. Before this route existed the same call left a PCP
 *    ticket. "PCP records tickets that file NOWHERE must not rise" is the
 *    guard #296 named for itself.
 *
 * Both are asserted on the AGENT path, not the library's, because both live in
 * the arguments PCP builds — testing `file_records_ticket` directly would pass
 * under either bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-58100' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-58200' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAreqfloor${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

/** The patient's own details are the same in every case; only WHO IS ASKING moves. */
const PATIENT = { patientFirstName: 'A', patientLastName: 'B', patientDob: '1973-03-17' };
const DELIVERY = { recordsDeliveryMethod: 'fax' as const, recordsDeliveryDestination: '9095550199' };

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-58100' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-58200' });
});

/** What PCP actually sent to the ticketing app on the records route. */
const filedPayload = () => (ticketing.createTicket.mock.calls as any[])[0][0];

describe('who the record says was asking', () => {
  it('files a clinic as a PROVIDER, off the clock — not as the patient\'s personal representative', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_medical_records_request',
      callerName: 'Dr Joseph Perez',
      callerRole: 'primary care provider',
      callerOrganization: 'De La Pena Family Medicine',
      callerFacilityType: 'pcp_office',
      statedRelationship: 'primary care provider',
      ...PATIENT,
      ...DELIVERY,
    });

    const filed = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Records request for a mutual patient, to be faxed.',
    });
    expect(filed.success, 'the clinic\'s request must still file').toBe(true);

    const payload = filedPayload();
    expect(payload.requestorType).toBe('provider');
    expect(payload.requestPathway).toBe('third_party_treatment');
    // The CAP clock is the patient's right-of-access deadline. A clinic asking
    // for a mutual patient's chart does not start one, and inventing it puts a
    // false statutory date on a record the CAP report reads.
    expect(payload.capClockApplies, 'a provider request is not on the patient clock').toBe(false);
    // "medical assistant OF THE PATIENT" is not a relationship anyone has.
    expect(String(payload.requestorName)).not.toMatch(/of the patient/i);
  });

  it('still files a family member as a personal representative, ON the clock', async () => {
    // THE CONTROL. The ternary this replaces existed for a real defect — a
    // daughter filing as the patient — and the fix must not undo it. Her
    // relationship classifies as nothing professional, so she keeps the
    // previous answer and the clock keeps running.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_medical_records_request',
      callerName: 'Maria Reyes',
      statedRelationship: 'daughter',
      ...PATIENT,
      ...DELIVERY,
    });

    const filed = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'I need a copy of my mother\'s records, to be faxed.',
    });
    // Guard the fixture: a narrative that does not classify as a records
    // request never reaches the route at all, and this assertion would then be
    // measuring the PCP fallback while claiming to measure the pathway.
    expect(filed.recordsPathwayUsed, 'the fixture must actually reach Medical Records').not.toBe(false);

    const payload = filedPayload();
    expect(payload.requestorType).toBe('personal_representative');
    expect(payload.requestPathway).toBe('roa_patient');
    expect(payload.capClockApplies, 'operator, 2026-09-13: personal rep stands in for the patient').toBe(true);
  });

  it('keeps a caller who says they ARE the patient on the clock, whatever relationship they also gave', async () => {
    // THE DANGEROUS DIRECTION, and the reason the professional read is gated
    // on `callerIsThePatient`. "I'm the patient — I'm also a nurse here" must
    // not become a provider request: that is a right-of-access deadline
    // silently switched off, which is the failure the whole CAP exists over.
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_medical_records_request',
      callerName: 'A B',
      callerIsThePatient: true,
      statedRelationship: 'primary care provider',
      ...PATIENT,
      ...DELIVERY,
    });

    await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'I need a copy of my records, faxed over.',
    });

    expect(filedPayload().capClockApplies, 'the patient\'s own clock cannot be switched off by a job title').toBe(true);
  });

  it('still files the patient themselves as the patient, ON the clock', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_medical_records_request',
      callerName: 'A B',
      callerIsThePatient: true,
      ...PATIENT,
      ...DELIVERY,
    });

    await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'I need a copy of my own records, faxed over.',
    });

    const payload = filedPayload();
    expect(payload.requestorType).toBe('patient');
    expect(payload.capClockApplies).toBe(true);
  });
});

describe('a library refusal the caller cannot fix must still land somewhere', () => {
  /**
   * The call this reproduces: intake complete, destination captured, and a
   * callback number the two systems disagree about. PCP's own gates have
   * nothing to spend a strike on, so before the fix the budget stayed at zero
   * for the life of the call.
   */
  const SHORT_CALLBACK_INTAKE = {
    callPurpose: 'patient_medical_records_request' as const,
    callerName: 'A B',
    callerIsThePatient: true,
    callbackNumber: '7605551', // seven digits: record_pcp_intake accepts it, the library will not
    ...PATIENT,
    ...DELIVERY,
  };

  it('refuses the first time, so the agent can ask — the library working', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', SHORT_CALLBACK_INTAKE);

    const first = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'I need a copy of my records, faxed over.',
    });
    expect(first.success).toBe(false);
    expect(ticketing.createPcpTicket, 'the floor must not fire on the first refusal').not.toHaveBeenCalled();
  });

  it('files the PCP fallback once the strike budget is spent, instead of refusing forever', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', SHORT_CALLBACK_INTAKE);

    const results: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await call(agent, 'handle_patient_medical_records_request', {
        narrative: 'I need a copy of my records, faxed over.',
      }));
    }

    // Medical Records is the preference and it never accepted this one.
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    // Never losing the request is the rule.
    expect(
      ticketing.createPcpTicket,
      'three refusals the caller cannot answer must fall back to a PCP ticket, not loop',
    ).toHaveBeenCalled();
    expect(results[results.length - 1].success).toBe(true);
  });
});
