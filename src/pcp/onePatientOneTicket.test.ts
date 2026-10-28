/**
 * ONE TICKET PER PATIENT, NOT ONE PER CALL — operator, 2026-10-16: "go ahead
 * and build the one-ticket-per-patient fix."
 *
 * THE CORPUS: CA5f202de2ca35a920f33ab07fd2fc08e5, PCP, 2026-10-16 15:51 UTC,
 * 356 s. A clinic asked about nine patients — eight confirmations and one
 * cancellation. The v87 latch treated every `create_pcp_task` after the first
 * as a re-file of the first: thirteen POSTs, twelve answered `cached` on
 * PCP-72764, and the agent told the caller eight times "I've added this to
 * ticket PCP-72764". Over 2026-10-02..10-16, 11 of 1,850 substantive PCP calls
 * named more than one patient.
 *
 * What these tests hold: a SECOND PATIENT is a second request. It runs the
 * routing doors as a first filing, so a records request for them reaches
 * Medical Records and a call that first filed through create-ticket does not
 * answer them with the first patient's ticket number. The SAME patient is
 * still the v87 re-file and is still latched — those tests live beside this
 * one in oneCallOneTicket.test.ts and pass unchanged.
 *
 * Synthetic patients only. The SID above is the real call; its words are on
 * disk, never here (RULE THREE).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-72764' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-70002' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent, sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
const { patientScope } = await import('../tools/medicalRecordsTools');
const { pcpDirector } = await import('./director');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAonepatient${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callSid: `CA${String(9000 + n).padStart(32, '0')}`,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

// The caller oneCallOneTicket.test.ts uses: identifiable as a professional
// by title alone, which is what lets the records route take them.
const CLINIC = {
  callerName: 'Pat Example',
  callerOrganization: 'Regional Care Partners',
  callerRole: 'medical assistant',
  callPurpose: 'service_inquiry' as const,
  callbackNumber: '9095550123',
};
const ANA = { patientFirstName: 'Ana', patientLastName: 'Rivera', patientDob: '1950-03-04' };
const BO = { patientFirstName: 'Bo', patientLastName: 'Kim', patientDob: '1962-11-02' };
const RECORDS_FOR_BO = {
  ...BO,
  callPurpose: 'patient_medical_records_request' as const,
  recordsDeliveryMethod: 'fax' as const,
  recordsDeliveryDestination: '9095550199',
};

beforeEach(() => {
  ticketing.createPcpTicket.mockReset();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-72764' });
  ticketing.createTicket.mockReset();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-70002' });
});

describe('a second patient on the call is a second request', () => {
  /**
   * THE DISCRIMINATING CASE. Under the v87 latch the second filing skipped
   * every door and re-POSTed to the PCP endpoint as enrichment of the first
   * ticket — so Bo's records request would have landed on Ana's PCP-72764.
   */
  it('a records request for the second patient reaches Medical Records, not the first patient’s ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...ANA });
    const first = await call(agent, 'create_pcp_task', { narrative: 'Confirm an upcoming visit for the first patient.' });
    expect(first.ticketNumber).toBe('PCP-72764');

    await call(agent, 'record_pcp_intake', RECORDS_FOR_BO);
    const second = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a second mutual patient, to be faxed.' });

    expect(second.routed_to, JSON.stringify(second)).toBe('Medical Records');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CREATE-TICKET DOOR. That endpoint has no upsert, so v87 POSTs nothing
   * after it and hands the number back — which, for a different patient, told
   * the caller a request was filed when nothing had been.
   */
  it('after a create-ticket filing, the second patient is filed, not handed the first patient’s number', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...RECORDS_FOR_BO });
    const first = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' });
    expect(first.routed_to).toBe('Medical Records');

    await call(agent, 'record_pcp_intake', { ...ANA, callPurpose: 'service_inquiry' });
    ticketing.createPcpTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'PCP-72765' });
    const second = await call(agent, 'create_pcp_task', { narrative: 'Question about a second patient.' });

    expect(second.alreadyFiled, JSON.stringify(second)).toBeUndefined();
    expect(second.ticketNumber).toBe('PCP-72765');
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(payload.patientFirstName).toBe('Ana');
  });

  it('control: the SAME patient after a create-ticket filing is still handed back, not filed twice', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...RECORDS_FOR_BO });
    await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' });

    const again = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' });

    expect(again.alreadyFiled).toBe(true);
    expect(again.ticketNumber).toBe('VA-70002');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
  });

  it('the records tool for a second patient files to Medical Records, not onto the first patient’s ticket', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...ANA });
    await call(agent, 'create_pcp_task', { narrative: 'Confirm an upcoming visit for the first patient.' });

    await call(agent, 'record_pcp_intake', RECORDS_FOR_BO);
    const r = await call(agent, 'handle_patient_medical_records_request', {
      narrative: 'Requesting a copy of the records for a second mutual patient, to be faxed.',
    });

    expect(r.alreadyFiled, JSON.stringify(r)).toBeUndefined();
    expect(ticketing.createTicket, 'Bo’s records request reached Medical Records').toHaveBeenCalledTimes(1);
    expect(ticketing.createPcpTicket, 'and did not re-POST onto Ana’s PCP ticket').toHaveBeenCalledTimes(1);
  });

  it('coming back to the first patient finds the first patient’s filing again', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...RECORDS_FOR_BO });
    await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' });
    await call(agent, 'record_pcp_intake', { ...ANA, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Question about Ana.' });

    await call(agent, 'record_pcp_intake', { ...RECORDS_FOR_BO });
    const backToBo = await call(agent, 'handle_patient_medical_records_request', { narrative: 'Bo again.' });

    expect(backToBo.alreadyFiled).toBe(true);
    expect(backToBo.ticketNumber).toBe('VA-70002');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
  });
});

describe('moving on to another patient forgets the last one — Codex P1, #351', () => {
  /**
   * THE DEFECT. `update` merged, so naming Bo Kim after Ana Rivera left Ana's
   * date of birth and MRN in the state, and `buildPayload` put them on Bo's
   * ticket. With one ticket per patient that is a wrong birthday on a separate
   * record. Driven through the real agent, asserted on the payload that leaves.
   */
  it('a second patient named without a birthday does not carry the first patient’s', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...ANA, patientMrn: 'MRN-ANA' });
    await call(agent, 'create_pcp_task', { narrative: 'Confirm an upcoming visit for the first patient.' });

    await call(agent, 'record_pcp_intake', { patientFirstName: 'Bo', patientLastName: 'Kim' });
    ticketing.createPcpTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'PCP-72765' });
    await call(agent, 'create_pcp_task', { narrative: 'Confirm a visit for the second patient.' });

    const second = (ticketing.createPcpTicket.mock.calls as any[])[1][0];
    expect(second.patientFirstName).toBe('Bo');
    expect(second.patientDob, 'Bo’s ticket must not carry Ana’s birthday').toBeUndefined();
    expect(second.patientMrn, 'or Ana’s MRN').toBeUndefined();
  });

  it('a new first name alone forgets the old surname, and the surname may be asked again', () => {
    const callId = `CAswitch${++n}`;
    pcpDirector.update(callId, ANA as never);
    pcpDirector.noteAsked(callId, 'patientLastName');
    pcpDirector.noteAsked(callId, 'patientLastName');
    pcpDirector.update(callId, { patientFirstName: 'Bo' });

    const s = pcpDirector.get(callId);
    expect([s.patientFirstName, s.patientLastName, s.patientDob]).toEqual(['Bo', undefined, undefined]);
    expect(s.askCounts?.patientLastName, 'a question about somebody new').toBe(0);
  });

  it('a new surname alone forgets the old first name — Codex P1, round 4', () => {
    const callId = `CAsurnameSwitch${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Ana', patientLastName: 'Rivera' });
    pcpDirector.update(callId, { patientLastName: 'Kim' });
    const s = pcpDirector.get(callId);
    expect([s.patientFirstName, s.patientLastName], 'never “Ana Kim”').toEqual([undefined, 'Kim']);
  });

  it('a new birthday on the same name keeps the name — father and son', () => {
    const callId = `CAson${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Luis', patientLastName: 'Ortega', patientDob: '1940-01-01', patientMrn: 'MRN-1' });
    pcpDirector.update(callId, { patientDob: '1975-06-30' });

    const s = pcpDirector.get(callId);
    expect([s.patientFirstName, s.patientLastName, s.patientDob, s.patientMrn]).toEqual(['Luis', 'Ortega', '1975-06-30', undefined]);
  });

  it('control: filling in the same patient forgets nothing', () => {
    const callId = `CAfill${++n}`;
    pcpDirector.update(callId, { patientDob: '1950-03-04' });
    pcpDirector.update(callId, { patientFirstName: 'Ana', patientMrn: 'MRN-ANA' });
    pcpDirector.update(callId, { patientLastName: 'Rivera' });
    // A corrected surname, vouched for by the same first name and birthday.
    pcpDirector.update(callId, { patientLastName: 'Riviera' });

    const s = pcpDirector.get(callId);
    expect([s.patientFirstName, s.patientLastName, s.patientDob, s.patientMrn]).toEqual(['Ana', 'Riviera', '1950-03-04', 'MRN-ANA']);
  });
});

describe('a filing learns who it is about — Codex P1, #351', () => {
  it('a birthday learned after filing keeps the son off the father’s ticket', () => {
    const callId = `CAlearn${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Luis', patientLastName: 'Ortega' });
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, { patientDob: '1940-01-01' });
    expect(pcpDirector.get(callId).ticketsFiled![0].patient.dob).toBe('1940-01-01');

    pcpDirector.update(callId, { patientDob: '1975-06-30' });
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
  });

  it('a surname learned after filing keeps a second patient with the same first name apart', () => {
    const callId = `CAsurname${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Ana' });
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, { patientLastName: 'Rivera' });

    pcpDirector.update(callId, { patientFirstName: 'Ana', patientLastName: 'Kim' });
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
    expect(pcpDirector.get(callId).ticketsFiled![0].patient).toEqual({ firstName: 'Ana', lastName: 'Rivera', dob: undefined });
  });

  it('a filing made before anyone was named belongs to the first patient named, even if they never re-file', () => {
    const callId = `CAclaimAtName${++n}`;
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, ANA as never);
    pcpDirector.update(callId, BO as never);
    expect(pcpDirector.filedForCurrentPatient(callId), 'Bo is a new patient, not the owner of Ana’s filing').toBeUndefined();
  });

  it('fills what the filing lacks and never replaces what it holds', () => {
    const callId = `CAnoreplace${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Ana', patientLastName: 'Riviera', patientDob: '1950-03-04' });
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, { patientLastName: 'Rivera' });
    expect(pcpDirector.get(callId).ticketsFiled![0].patient.lastName).toBe('Riviera');
    expect(pcpDirector.filedForCurrentPatient(callId)?.ticketNumber).toBe('PCP-1');
  });
});

describe('each patient gets their own idempotency key — Codex P1, #351', () => {
  /**
   * THE DEFECT. Both create-ticket doors keyed their POST on the call, so a
   * second patient through the same door sent the first patient's key and the
   * app answered with the first patient's ticket as a retry, which the agent
   * then read out for the second patient.
   */
  it('two patients’ records requests send two keys, and the first keeps the call’s own', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...RECORDS_FOR_BO });
    await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' });

    await call(agent, 'record_pcp_intake', { ...ANA, callPurpose: 'patient_medical_records_request' });
    ticketing.createTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-70003' });
    const second = await call(agent, 'create_pcp_task', { narrative: 'Requesting a copy of the records for a second mutual patient, to be faxed.' });

    const keys = (ticketing.createTicket.mock.calls as any[]).map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^call-CA\d{32}$/);
    expect(keys[1]).toBe(`${keys[0]}-p1`);
    expect(second.ticketNumber).toBe('VA-70003');
  });

  it('two patients’ bookings send two Hub keys', async () => {
    const { agent } = freshCall();
    const coordinator = {
      callerName: 'Test Coordinator',
      callerRole: 'referral coordinator',
      callerOrganization: 'Example Family Practice',
      callerFacilityType: 'pcp_office' as const,
      callPurpose: 'schedule_appointment' as const,
      callbackNumber: '5005550006',
    };
    await call(agent, 'record_pcp_intake', { ...coordinator, ...ANA });
    const first = await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants their patient booked in.' });
    expect(first.routed_to).toBe('HVA Hub');

    await call(agent, 'record_pcp_intake', { patientFirstName: 'Bo', patientLastName: 'Kim' });
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants a second patient booked in.' });

    const keys = (ticketing.createTicket.mock.calls as any[]).map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([expect.stringMatching(/-scheduling-hub$/), expect.stringMatching(/-scheduling-hub-p1$/)]);
  });

  it('nothing but the count can reach a key', () => {
    expect(patientScope('-p2')).toBe('-p2');
    expect(patientScope('Rivera')).toBe('');
    expect(patientScope('-p1-Rivera')).toBe('');
    expect(patientScope(undefined)).toBe('');
  });
});

describe('the disposition belongs to its patient — Codex P1, #351', () => {
  it('a switch to somebody new leaves nothing on record; coming back restores the first patient’s', () => {
    const callId = `CAdisposition${++n}`;
    pcpDirector.update(callId, ANA as never);
    pcpDirector.recordDisposition(callId, 'CREATE_TASK');
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    expect(pcpDirector.next(callId).mayTerminate).toBe(true);

    pcpDirector.update(callId, BO as never);
    expect(pcpDirector.get(callId).dispositionRecorded).toBeUndefined();
    expect(pcpDirector.next(callId).mayTerminate, 'Bo’s request is not on record yet').toBe(false);

    pcpDirector.update(callId, ANA as never);
    expect(pcpDirector.get(callId).dispositionRecorded).toBe('CREATE_TASK');
    expect(pcpDirector.next(callId).mayTerminate).toBe(true);
  });

  it('a disposition recorded after the filing — the pre-dial handoff write — is the one restored', () => {
    const callId = `CAlateDisposition${++n}`;
    pcpDirector.update(callId, ANA as never);
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.recordDisposition(callId, 'HAND_OFF');
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');

    pcpDirector.update(callId, BO as never);
    pcpDirector.update(callId, ANA as never);
    expect(pcpDirector.get(callId).dispositionRecorded).toBe('HAND_OFF');
  });

  it('a lookup for one patient does not let the next be marked resolved without one — Codex P1, round 3', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...ANA, callPurpose: 'check_patient_scheduled' });
    pcpDirector.recordToolSuccess(callId, 'scheduling');
    pcpDirector.recordToolSuccess(callId, 'knowledge_base');
    pcpDirector.recordToolFailure(callId, 'scheduling');

    await call(agent, 'record_pcp_intake', BO);
    const s = pcpDirector.get(callId);
    expect(s.completedTools, 'Ana’s lookup is not Bo’s').not.toContain('scheduling');
    expect(s.completedTools, 'the public knowledge base is nobody’s').toContain('knowledge_base');
    expect(s.toolFailures.scheduling).toBeUndefined();

    const r = await call(agent, 'record_automated_resolution', { narrative: 'Confirmed the second patient’s visit.' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain('authoritative_tool_success_required');
  });

  it('the caller cannot still be the patient once the call is about somebody else', () => {
    const callId = `CAcallerIsPatient${++n}`;
    pcpDirector.update(callId, { ...ANA, callerIsThePatient: true } as never);
    pcpDirector.update(callId, BO as never);
    expect(pcpDirector.get(callId).callerIsThePatient).toBeUndefined();

    pcpDirector.update(callId, { ...ANA, callerIsThePatient: true } as never);
    expect(pcpDirector.get(callId).callerIsThePatient, 'restated with the switch, it stands').toBe(true);
  });

  it('control: the records destination is the caller’s and carries to the next patient', () => {
    const callId = `CAdestination${++n}`;
    pcpDirector.update(callId, { ...RECORDS_FOR_BO } as never);
    pcpDirector.update(callId, ANA as never);
    const s = pcpDirector.get(callId);
    expect([s.recordsDeliveryMethod, s.recordsDeliveryDestination]).toEqual(['fax', '9095550199']);
  });

  it('the teardown floor files a second patient whose request was never filed', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { ...CLINIC, ...ANA });
    await call(agent, 'create_pcp_task', { narrative: 'Confirm an upcoming visit for the first patient.' });
    await call(agent, 'record_pcp_intake', { patientFirstName: 'Bo', patientLastName: 'Kim' });

    ticketing.createPcpTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'PCP-72765' });
    await sweepPcpUnfiledCall(callId);

    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(2);
    expect((ticketing.createPcpTicket.mock.calls as any[])[1][0].patientFirstName).toBe('Bo');
  });
});

describe('the director keeps one filing per patient', () => {
  it('records each patient once, first write wins, oldest first', () => {
    const callId = `CAlist${++n}`;
    pcpDirector.update(callId, ANA as never);
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.markTicketFiled(callId, 'create_ticket', 'VA-9');
    pcpDirector.update(callId, BO as never);
    pcpDirector.markTicketFiled(callId, 'create_ticket', 'VA-2');

    const filed = pcpDirector.get(callId).ticketsFiled!;
    expect(filed.map((f) => [f.door, f.ticketNumber])).toEqual([['pcp', 'PCP-1'], ['create_ticket', 'VA-2']]);
    expect(pcpDirector.get(callId).ticketFiled?.ticketNumber).toBe('PCP-1');
    expect(pcpDirector.filedForCurrentPatient(callId)?.ticketNumber).toBe('VA-2');
  });

  it('a father and a son with one name are two patients — the birthday is part of who it is', () => {
    const callId = `CAsameName${++n}`;
    pcpDirector.update(callId, { patientFirstName: 'Luis', patientLastName: 'Ortega', patientDob: '1940-01-01' } as never);
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, { patientDob: '1975-06-30' } as never);
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
  });

  it('a filing made before the patient was named is claimed by them, so the next patient is new', () => {
    const callId = `CAclaim${++n}`;
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    pcpDirector.update(callId, ANA as never);
    expect(pcpDirector.filedForCurrentPatient(callId)?.ticketNumber).toBe('PCP-1');
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-1');
    expect(pcpDirector.get(callId).ticketsFiled![0].patient.firstName).toBe('Ana');

    pcpDirector.update(callId, BO as never);
    expect(pcpDirector.filedForCurrentPatient(callId)).toBeUndefined();
  });
});
