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

const { createPcpAgent } = await import('../agents/pcpAgent');
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
