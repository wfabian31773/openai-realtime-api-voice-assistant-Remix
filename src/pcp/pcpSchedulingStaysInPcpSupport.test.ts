/**
 * v236 — A PCP-LINE SCHEDULING REQUEST FROM AN OFFICE STAYS IN PCP SUPPORT.
 *
 * Operator, 2026-11-14, asked whether these should keep going to the HVA Hub
 * or stay where they are worked: "Keep in PCP Support." An exception to
 * standing instruction 10 for this line's professional callers.
 *
 * THE CORPUS is the Daybook's two close-to-close days, 2026-11-12/13 (01:00 to
 * 01:00 UTC): every professional scheduling ticket the PCP agent filed to the
 * HVA Hub (department 9), 24 of them, 22 asking for a new appointment and 2 to
 * reschedule. Staff moved all 24 to PCP Support (department 18). Over the 14
 * days to 2026-11-14 it was 200 of 202.
 *
 * Fixtures are synthetic. The SIDs and ticket numbers are the real calls;
 * nothing a caller said is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Not the lunch hour: transfers are off 12:00-12:59 Pacific.
const NOT_LUNCH = new Date('2026-11-13T17:00:00Z');
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOT_LUNCH);
});
afterAll(() => {
  vi.useRealTimers();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-90000' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-90100' })),
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

const OFFICE = {
  callerName: 'Test Coordinator',
  callerOrganization: 'Example Family Practice',
  callerFacilityType: 'pcp_office' as const,
  callbackNumber: '5005550006',
};
const PATIENT = { patientFirstName: 'Test', patientLastName: 'Patient', patientDob: '1950-02-03' };

/** [ticket, call SID, purpose the agent filed it under]. The Hub reason read 146 (new) or 147 (reschedule). */
const CORPUS: Array<[string, string, 'schedule_appointment' | 'reschedule_appointment']> = [
  ['VA-84238', 'CAc3694b56dad35f1cd3553b688f2362a7', 'reschedule_appointment'],
  ['VA-84264', 'CA29a6fc1b88f06ffd22193377139b23e1', 'reschedule_appointment'],
  ['VA-84267', 'CA804b6513a525a60e6f62c298f322c398', 'schedule_appointment'],
  ['VA-84275', 'CA4f34709a651a7b44960936ec1aeaa84b', 'schedule_appointment'],
  ['VA-84306', 'CA99a38d497fe4f1bef37ef4ff66689d9f', 'schedule_appointment'],
  ['VA-84396', 'CA0405d6e46aca8868f127071cde333d63', 'schedule_appointment'],
  ['VA-84402', 'CA357a872963ec5eb10cd09bf4d5624d0c', 'schedule_appointment'],
  ['VA-84409', 'CA5a8d21ca4d2c4a74570b3bbf1a3be967', 'schedule_appointment'],
  ['VA-84455', 'CA911c8e0a071f2e9a6a6aefe0510fd5ff', 'schedule_appointment'],
  ['VA-84497', 'CAe00908bf983c42d39fa83be4a4fe6bec', 'schedule_appointment'],
  ['VA-84513', 'CA1747eb4681fc1f73dff21d4ed6d97b59', 'schedule_appointment'],
  ['VA-84608', 'CAa49fe88c1e921d18207bc8fa2333d1d9', 'schedule_appointment'],
  ['VA-84610', 'CA94f01aa80325b76f00f99d81b766b7f9', 'schedule_appointment'],
  ['VA-84625', 'CAfb6a3599687131dc6fb99103fb232df9', 'schedule_appointment'],
  ['VA-84666', 'CA442b8cb4549da706b3a9da79acadfd58', 'schedule_appointment'],
  ['VA-84714', 'CA0851c4faa590f5621d5aa2db058646fa', 'schedule_appointment'],
  ['VA-84934', 'CA48033ba89b9407935fce03aa3590a6b5', 'schedule_appointment'],
  ['VA-85120', 'CA2f0aca3be5e0353099a7b8d0b1360de9', 'schedule_appointment'],
  ['VA-85141', 'CA2f1c3e3ff667a3ef79f218d4a64dbbf5', 'schedule_appointment'],
  ['VA-85204', 'CA7a9b4d43235ad1cb9e90d04b35196118', 'schedule_appointment'],
  ['VA-85223', 'CA9bf0a1f1be940686d0252f01d4ccaae7', 'schedule_appointment'],
  ['VA-85241', 'CAcd14bcd6490ca448778aa418cd58264b', 'schedule_appointment'],
  ['VA-85299', 'CAf8f051e76bfab8ef0cd89a51d3bf867f', 'schedule_appointment'],
  ['VA-85319', 'CAe3fd4b5a0854d581000bce31266111e9', 'schedule_appointment'],
];

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createTicket.mockClear();
});

let n = 0;
function agentFor(sid: string) {
  const callId = `${sid}-${++n}`;
  const agent = createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callSid: sid,
    callerPhone: '+15005550006',
  } as never);
  return { agent, callId };
}

describe('the 24 Hub tickets of 2026-11-12/13 file in PCP Support', () => {
  it('the corpus is the two days, 22 new and 2 reschedule', () => {
    expect(CORPUS).toHaveLength(24);
    expect(CORPUS.filter((c) => c[2] === 'reschedule_appointment')).toHaveLength(2);
    expect(new Set(CORPUS.map((c) => c[1])).size).toBe(24);
  });

  it.each(CORPUS)('%s (%s, %s) files on the PCP endpoint and never to the HVA Hub', async (_ticket, sid, purpose) => {
    const { agent, callId } = agentFor(sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: purpose, ...PATIENT });
    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Office calling to get a mutual patient seen.',
      callerStatedARequest: true,
    });
    expect(filed.success, `must file: ${JSON.stringify(filed)}`).toBe(true);
    expect(ticketing.createTicket, 'no HVA Hub ticket').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(payload.callPurpose).toBe(purpose);
    expect(payload).toMatchObject({ patientFirstName: 'Test', patientLastName: 'Patient', patientDob: '1950-02-03' });
    // The line the Hub ticket carried about whose number it is comes with it.
    expect(payload.narrative).toMatch(/Callback 5005550006 reaches the requesting office, not the patient\. Given by the caller\./);
    pcpDirector.clear(callId);
  });
});

describe('what does not change', () => {
  it('a cancel request from an office stays in PCP Support too', async () => {
    const { agent, callId } = agentFor('CAv236cancel');
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'cancel_appointment', ...PATIENT });
    await call(agent, 'create_pcp_task', { narrative: 'Office cancelling a mutual patient.', callerStatedARequest: true });
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    pcpDirector.clear(callId);
  });

  it("a patient's own scheduling request on this line still reaches the HVA Hub (v128)", async () => {
    const { agent, callId } = agentFor('CAv236patient');
    await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_caller',
      callerName: 'Test Patient',
      callbackNumber: '5005550006',
      callerIsThePatient: true,
      patientDob: '1950-02-03',
    });
    const filed = await call(agent, 'create_pcp_task', { narrative: 'I need to reschedule my eye exam.', callerStatedARequest: true });
    expect(filed.routed_to).toBe('HVA Hub');
    expect((ticketing.createTicket.mock.calls as any[])[0][0].departmentId).toBe(9);
    pcpDirector.clear(callId);
  });

  it('the office is still asked who the request is about, then the date of birth, before it files (v200, v235)', async () => {
    const { agent, callId } = agentFor('CAv236asks');
    const first = await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'schedule_appointment' });
    expect(first.nextQuestion?.field).toBe('patientFirstName');
    const second = await call(agent, 'record_pcp_intake', { patientFirstName: 'Test', patientLastName: 'Patient' });
    expect(second.nextQuestion?.field).toBe('patientDob');
    pcpDirector.clear(callId);
  });
});
