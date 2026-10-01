/**
 * ONE CALL, ONE TICKET — operator, 2026-10-01: "fix the PCP double ticket."
 *
 * MEASURED FIRST, the PCP calls of 2026-09-17..10-01 in the Support Center:
 * 61 of 793 calls with an agent ticket carried two or more, 72 surplus tickets,
 * and NOT ONE was a queue transfer (the pcp-ticket endpoint upserts on callSid,
 * so every transfer write lands on one row). Three shapes, one cause: every
 * later filing call re-ran every routing door and could leave through another.
 *
 *   35  PCP ticket, then Medical Records   CA3eec2c7d, CAe3d1fbed, CA0bd7f87d
 *   11  PCP ticket, then create-ticket     CA60a4bd3b
 *   15  the patient path, again and again  CA743da180 (ten, four seconds apart)
 *
 * The first shape is the enrichment re-file v37 asks for: the title arrives
 * after the first filing, the title is what identifies a professional records
 * requester, so the SECOND call took the records door. Two fixes, both here:
 * the latch (a later filing enriches the PCP row or hands back the number, and
 * never opens a ticket through another door) and the ordering (on a records
 * request the title is asked BEFORE filing, so the one ticket lands in
 * Medical Records where the operator ruled records go).
 *
 * Synthetic callers only. The SIDs above are the real calls; their words are
 * on disk, never here (RULE THREE).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-70001' })),
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
  const callId = `CAoneticket${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callSid: `CA${String(n).padStart(32, '0')}`,
    callerPhone: '+19095550123',
  } as never);
  return { agent, callId };
}

/**
 * A professional records request whose caller cannot yet be identified: no
 * title, no facility type, and an organisation the classifier cannot read
 * (`Regional Care Partners`, the unnameable one professionalRecords… uses).
 */
const UNIDENTIFIED_CLINIC = {
  callerName: 'Pat Example',
  callerOrganization: 'Regional Care Partners',
  callPurpose: 'patient_medical_records_request' as const,
  patientFirstName: 'A',
  patientLastName: 'B',
  patientDob: '1973-03-17',
  callbackNumber: '9095550123',
  recordsDeliveryMethod: 'fax' as const,
  recordsDeliveryDestination: '9095550199',
};
const RECORDS = { narrative: 'Requesting a copy of the records for a mutual patient, to be faxed.' };

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-70001' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-70002' });
});

describe('a PCP ticket is enriched, never joined by a second one', () => {
  /**
   * THE 35-CALL SHAPE. The control first: the title DOES route this request to
   * Medical Records when it is known before the first filing — so the second
   * call below would really have taken that door without the latch.
   */
  it('control: with the title known first, the one ticket goes to Medical Records', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...UNIDENTIFIED_CLINIC, callerRole: 'medical assistant' });

    const filed = await call(agent, 'create_pcp_task', RECORDS);

    expect(filed.routed_to, JSON.stringify(filed)).toBe('Medical Records');
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('the title arriving after a PCP filing enriches that ticket instead of opening a records one', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', UNIDENTIFIED_CLINIC);
    const first = await call(agent, 'create_pcp_task', RECORDS);
    expect(first.ticketNumber).toBe('PCP-70001');

    await call(agent, 'record_pcp_intake', { callerRole: 'medical assistant' });
    const second = await call(agent, 'create_pcp_task', RECORDS);

    expect(second.success).toBe(true);
    expect(ticketing.createTicket, 'the double ticket: a Medical Records row beside the PCP one').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(2);
    const [a, b] = (ticketing.createPcpTicket.mock.calls as any[]).map((c) => c[0]);
    expect(b.callSid, 'the app upserts on callSid — same SID is the same row').toBe(a.callSid);
    expect(b.callerRole ?? b.pcpCallerRole ?? JSON.stringify(b)).toMatch(/medical assistant/);
  });

  /** THE 11-CALL SHAPE: a PCP filing, then the patient branch on the next call. */
  it('a caller latched as the patient after a PCP filing does not open a create-ticket row', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { ...UNIDENTIFIED_CLINIC, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Caller asking about an order.' });
    pcpDirector.update(callId, { callerIsThePatient: true } as never);

    await call(agent, 'create_pcp_task', { narrative: 'Caller asking about an order, and they are the patient.' });

    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(2);
  });

  it('the records tool after a PCP filing enriches it too', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...UNIDENTIFIED_CLINIC, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Caller asking about a chart.' });

    await call(agent, 'handle_patient_medical_records_request', RECORDS);

    expect(ticketing.createTicket).not.toHaveBeenCalled();
  });
});

describe('a create-ticket filing is never repeated', () => {
  const PATIENT = {
    callerName: 'Sam Example',
    callPurpose: 'patient_caller' as const,
    callerIsThePatient: true,
    patientFirstName: 'Sam',
    patientLastName: 'Example',
    callbackNumber: '9095550123',
  };

  /** THE 15-CALL SHAPE, CA743da180 — ten tickets in forty seconds. */
  it('the patient path files once and hands the same number back after that', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PATIENT);

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await call(agent, 'create_pcp_task', { narrative: 'Patient asking about a refill.' }));
    }

    expect(ticketing.createTicket, 'one POST to an endpoint with no upsert').toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.ticketNumber).toBe('VA-70002');
    }
    expect(results[1].alreadyFiled, 'the guard firing is countable on the timeline').toBe(true);
    expect(results[1].guidance).toMatch(/must not file it again/);
  });

  it('the records tool after a create-ticket filing posts nothing', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PATIENT);
    await call(agent, 'create_pcp_task', { narrative: 'Patient asking about a refill.' });
    ticketing.createTicket.mockClear();

    const r = await call(agent, 'handle_patient_medical_records_request', RECORDS);

    expect(r.alreadyFiled).toBe(true);
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  /** A refusal files nothing, so it must not latch — the next call still files. */
  it('a failed first filing does not latch', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', PATIENT);
    ticketing.createTicket.mockResolvedValueOnce({ success: false, error: 'timeout' } as never);
    await call(agent, 'create_pcp_task', { narrative: 'Patient asking about a refill.' });

    const r = await call(agent, 'create_pcp_task', { narrative: 'Patient asking about a refill.' });

    expect(r.alreadyFiled).toBeUndefined();
    expect(ticketing.createTicket).toHaveBeenCalledTimes(2);
  });
});

describe('every create-ticket door latches, and the first door wins', () => {
  /** Medical Records is a create-ticket door: a second call must not re-file it. */
  it('a Medical Records filing is handed back, not filed twice', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', { ...UNIDENTIFIED_CLINIC, callerRole: 'medical assistant' });
    const first = await call(agent, 'create_pcp_task', RECORDS);
    expect(first.routed_to).toBe('Medical Records');

    const second = await call(agent, 'create_pcp_task', RECORDS);

    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(second.alreadyFiled).toBe(true);
    expect(second.ticketNumber).toBe('VA-70002');
  });

  const COORDINATOR = {
    callerName: 'Test Coordinator',
    callerRole: 'referral coordinator',
    callerOrganization: 'Example Family Practice',
    callerFacilityType: 'pcp_office' as const,
    callPurpose: 'schedule_appointment' as const,
    callbackNumber: '5005550006',
    patientFirstName: 'Test',
    patientLastName: 'Patient',
  };

  /** The HVA Hub is a create-ticket door too. */
  it('a Hub filing is handed back, not filed twice', async () => {
    const { agent } = freshCall();
    await call(agent, 'record_pcp_intake', COORDINATOR);
    const first = await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants their patient booked in.' });
    expect(first.routed_to).toBe('HVA Hub');

    const second = await call(agent, 'create_pcp_task', { narrative: 'Coordinator wants their patient booked in.' });

    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    expect(second.alreadyFiled).toBe(true);
  });

  /** And a PCP filing is not joined by a Hub ticket when the purpose moves later. */
  it('a purpose that turns into scheduling after a PCP filing enriches the PCP row', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', { ...COORDINATOR, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Coordinator asking about a mutual patient.' });
    pcpDirector.update(callId, { callPurpose: 'schedule_appointment' } as never);

    await call(agent, 'create_pcp_task', { narrative: 'Coordinator now wants the patient booked in.' });

    expect(ticketing.createTicket, 'no Hub ticket beside the PCP one').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(2);
  });

  /**
   * FIRST WRITE WINS. A create-ticket filing followed by any PCP write must not
   * re-label the call as enrichable on the PCP endpoint — that would turn the
   * next filing into a PCP- ticket beside the VA- one.
   */
  it('a later PCP write cannot re-label a create-ticket call', () => {
    const callId = `CAlatch${++n}`;
    pcpDirector.markTicketFiled(callId, 'create_ticket', 'VA-1');
    pcpDirector.markTicketFiled(callId, 'pcp', 'PCP-2');
    expect(pcpDirector.get(callId).ticketFiled).toEqual({ door: 'create_ticket', ticketNumber: 'VA-1' });
  });
});

describe('on a records request the title is asked before filing', () => {
  /**
   * The ordering half. The intake stops naming fields when it is done, and the
   * model files when it runs out of questions — so the title has to be one of
   * the questions BEFORE the disposition exists, or the first filing cannot
   * identify the caller and lands in PCP Support.
   */
  it('a professional records request is asked for the title before a disposition exists', () => {
    const callId = `CAorder${++n}`;
    pcpDirector.update(callId, UNIDENTIFIED_CLINIC as never);
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('callerRole');
  });

  it('any other purpose still holds the title until after filing (v37)', () => {
    const callId = `CAorder${++n}`;
    pcpDirector.update(callId, { ...UNIDENTIFIED_CLINIC, callPurpose: 'service_inquiry' } as never);
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('callerRole');
  });

  it('the email is still never asked on a records request', () => {
    const callId = `CAorder${++n}`;
    pcpDirector.update(callId, { ...UNIDENTIFIED_CLINIC, callerRole: 'medical assistant' } as never);
    pcpDirector.recordDisposition(callId, 'CREATE_TASK');
    expect(pcpDirector.next(callId).nextQuestion?.field).not.toBe('callerEmail');
  });
});
