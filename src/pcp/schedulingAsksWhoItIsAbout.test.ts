/**
 * v200 — A PCP SCHEDULING REQUEST ASKS WHO IT IS ABOUT BEFORE IT FILES.
 *
 * Operator, 2026-11-11: "Staff are working too hard chasing down the right
 * person for the tickets and without the proper information on the tickets,
 * it makes it that much harder."
 *
 * THE CORPUS is the 25 PCP scheduling tickets of 2026-11-10 (Pacific day)
 * that the HVA Hub sent back to PCP Support. On 24 of them the ticket named no
 * patient; on 21 the transcript shows nobody was ever asked who the request
 * was about, because the director left the patient questions off any purpose
 * that allows a transfer. Over the 21 days to 2026-11-11 the Hub sent back
 * 284 of 287 such tickets that named no patient, 29 of 83 that named one,
 * and 6 of 24 that also carried a date of birth.
 *
 * Fixtures are synthetic. The SIDs are the real calls; nothing a caller said
 * is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Not the lunch hour: `eligibleByAsk` is off 12:00-12:59 Pacific.
const NOT_LUNCH = new Date('2026-11-11T17:00:00Z');
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

const { createPcpAgent, SCHEDULING_KEPT_FOR_NO_PATIENT_NOTE, dobColumns } = await import('../agents/pcpAgent');
const { pcpDirector, SCHEDULING_PURPOSES } = await import('./director');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function agentFor(callId: string) {
  return createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
    callId,
    callSid: callId,
    callerPhone: '+15005550006',
  } as never);
}

/** The 2026-11-10 tickets the Hub sent back, by who was calling. */
const PROFESSIONAL_SIDS = [
  'CA91d4361c532e871a4616f1eb4cd06915', 'CA5ea91d3b0c0eff19167357f322c84045',
  'CA6a4288b8ed37ba1b78dbc4e8166c1652', 'CAf3034c284e1cf540868fdaaed1081e64',
  'CAd92728d053fb7e70694b2a48e21d310d', 'CA41cc049dabf12bcb047bfd30d974baaa',
  'CA27aa240188b5f51e7d51c676de821f08', 'CAf69c7bbf6e30b76d650b12e75c8ed1d2',
  'CA6c8818d1cd867d474f2eb3372f907dc4', 'CAc02f70570320a6e40d22a53d848befbe',
  'CA152a7c25f86f2418d82277ee5fe983a1', 'CAf54643df40d9f3b8d0be0b3239957edb',
  'CA840ea25d0a4496f9b4ac9c2effc23985', 'CA2e135f952f60f64d885d8a6e0662b45d',
  'CA3d392cddefa7351d0496e47225f432e1', 'CA8e6cd218b985f27e4183a6a92e68387e',
  'CA54fcd970619f4dcc6571c09b0b11109e', 'CAf92ed8a88b67f722333720e45ed4cf92',
  'CAe250d68079ee75c6007b93b9d2dc302c',
  // Who was calling is not clear from the call, or another business.
  'CAdf3749d2fc5b93a9633ec18c974b844d', 'CAc542c8e41c9ca9eb59416ac84ad247cd',
  'CA7edd6237315df6bab3d3b39d15f3219d',
];
/** The patients themselves: their own name is the caller's name. */
const PATIENT_SIDS = [
  'CAef3199b400b088e0bfffea3a1080be63', 'CA8899929b33ff698e032c847dc74f0575',
  'CA13053091d5886aa1a0da336fc5e2a714',
];

/** A medical assistant at a referring office. Synthetic. */
const OFFICE = {
  callerName: 'Test Assistant',
  callerOrganization: 'Example Family Practice',
  callbackNumber: '5005550006',
};

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90000' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90100' });
});

describe('the corpus: a referring office booking a patient is asked who it is about', () => {
  it.each(PROFESSIONAL_SIDS)('%s is asked the patient\'s name, then the date of birth', async (sid) => {
    const agent = agentFor(sid);
    const first = await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'schedule_appointment' });
    expect(first.nextQuestion?.field).toBe('patientFirstName');
    const second = await call(agent, 'record_pcp_intake', { patientFirstName: 'Test', patientLastName: 'Patient' });
    expect(second.nextQuestion?.field).toBe('patientDob');
    expect(second.nextQuestion?.prompt).toMatch(/month, then the day, then the year/);
    const third = await call(agent, 'record_pcp_intake', { patientDob: '1950-02-03' });
    expect(third.nextQuestion).toBeUndefined();
    pcpDirector.clear(sid);
  });

  // v235, operator 2026-11-14: a patient calling for themselves is the
  // patient, so their own date of birth is asked (in their words), and never
  // "the patient's name".
  it.each(PATIENT_SIDS)('%s, the patient calling for themselves, is asked their own date of birth only', (sid) => {
    pcpDirector.update(sid, { ...OFFICE, callerIsThePatient: true, callPurpose: 'schedule_appointment' });
    const next = pcpDirector.next(sid);
    expect(next.nextQuestion?.field).not.toBe('patientFirstName');
    expect(next.nextQuestion?.field).toBe('patientDob');
    expect(next.nextQuestion?.prompt).toMatch(/your date of birth, starting with the month/);
    pcpDirector.clear(sid);
  });

  it('covers all three scheduling purposes', () => {
    expect([...SCHEDULING_PURPOSES].sort()).toEqual(
      ['cancel_appointment', 'reschedule_appointment', 'schedule_appointment'],
    );
    for (const purpose of SCHEDULING_PURPOSES) {
      const callId = `CAv200purpose${purpose}`;
      pcpDirector.update(callId, { ...OFFICE, callPurpose: purpose as never });
      expect(pcpDirector.next(callId).nextQuestion?.field, purpose).toBe('patientFirstName');
      pcpDirector.clear(callId);
    }
  });
});

describe('a caller headed for a person is not held on the patient', () => {
  it('asked for a person: the transfer is granted and the patient is not asked', () => {
    const callId = 'CAv200headed1';
    pcpDirector.update(callId, { ...OFFICE, callPurpose: 'schedule_appointment', callerRequestedHuman: true });
    const next = pcpDirector.next(callId);
    expect(next.handoffEligible).toBe(true);
    expect(next.nextQuestion?.field).not.toBe('patientFirstName');
    expect(next.nextQuestion?.field).not.toBe('patientDob');
    pcpDirector.clear(callId);
  });

  it('declined the queue: the request will be filed, so the patient is asked', () => {
    const callId = 'CAv200headed2';
    pcpDirector.update(callId, { ...OFFICE, callPurpose: 'schedule_appointment', callerRequestedHuman: true });
    pcpDirector.markCallerDeclinedTheQueue(callId);
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientFirstName');
    pcpDirector.clear(callId);
  });

  it('a failed transfer: the request will be filed, so the patient is asked', () => {
    const callId = 'CAv200headed3';
    pcpDirector.update(callId, {
      ...OFFICE, callPurpose: 'schedule_appointment', callerRequestedHuman: true, handoffStatus: 'NO_ANSWER',
    } as never);
    expect(pcpDirector.next(callId).nextQuestion?.field).toBe('patientFirstName');
    pcpDirector.clear(callId);
  });
});

describe('the ticket', () => {
  it('a scheduling request that still names no patient stays in PCP Support, and says why', async () => {
    const sid = 'CAv200nameless1';
    const agent = agentFor(sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'reschedule_appointment' });
    const filed = await call(agent, 'create_pcp_task', { narrative: 'Wants the patient moved to next week.' });
    expect(ticketing.createTicket, 'no Hub ticket for a request naming no patient').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createPcpTicket.mock.calls as any[])[0][0];
    expect(JSON.stringify(payload)).toContain('kept in PCP Support');
    expect(filed.ticketNumber).toBe('PCP-90000');
    pcpDirector.clear(sid);
  });

  it('a named request reaches the Hub with the date of birth in its own columns', async () => {
    const sid = 'CAv200named1';
    const agent = agentFor(sid);
    await call(agent, 'record_pcp_intake', {
      ...OFFICE, callPurpose: 'schedule_appointment',
      patientFirstName: 'Test', patientLastName: 'Patient', patientDob: '1950-02-03',
    });
    await call(agent, 'create_pcp_task', { narrative: 'Wants the patient booked in.' });
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const hub = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(hub.departmentId).toBe(9);
    expect(hub.patientFirstName).toBe('Test');
    expect(hub).toMatchObject({ patientBirthYear: '1950', patientBirthMonth: '02', patientBirthDay: '03' });
    pcpDirector.clear(sid);
  });

  it('a named request with no date of birth still reaches the Hub, with no birth columns', async () => {
    const sid = 'CAv200named2';
    const agent = agentFor(sid);
    await call(agent, 'record_pcp_intake', {
      ...OFFICE, callPurpose: 'schedule_appointment', patientFirstName: 'Test', patientLastName: 'Patient',
    });
    await call(agent, 'create_pcp_task', { narrative: 'Wants the patient booked in.' });
    const hub = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(hub.departmentId).toBe(9);
    expect(hub.patientBirthYear).toBeUndefined();
    pcpDirector.clear(sid);
  });

  it('the note names what staff need from the office', () => {
    expect(SCHEDULING_KEPT_FOR_NO_PATIENT_NOTE).toMatch(/no patient name/);
    expect(SCHEDULING_KEPT_FOR_NO_PATIENT_NOTE).toMatch(/date of birth/);
  });

  it('reads only a whole YYYY-MM-DD date of birth', () => {
    expect(dobColumns('1950-02-03')).toEqual({ patientBirthYear: '1950', patientBirthMonth: '02', patientBirthDay: '03' });
    expect(dobColumns('02/03/1950')).toEqual({});
    expect(dobColumns(undefined)).toEqual({});
    expect(dobColumns('1950-2-3')).toEqual({});
  });
});
