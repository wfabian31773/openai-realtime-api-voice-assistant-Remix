/**
 * v250 — A PATIENT'S REQUEST THAT LEAVES PCP SUPPORT CARRIES THEIR DATE OF
 * BIRTH, OR SAYS IT WAS NOT GIVEN.
 *
 * THE CORPUS: every PCP agent ticket on the patient path since v235, from
 * 2026-11-16 17:23 to 2026-11-19 00:15 UTC. 42 tickets, 7 with no date of
 * birth, each read against its call's `tool_call_payloads`:
 *
 *   rescued    VA-87036  service_inquiry, the caller is the patient, routed to
 *                        Optical; the intake asked no date of birth.
 *              VA-87143  the same shape, routed to Technicians.
 *   controls   VA-85628, VA-85760  practice questions; stayed in PCP Support
 *                        with nothing asked, and need no chart.
 *              VA-85576  asked, not given; stayed in PCP Support.
 *              VA-86859  asked, not given; routed to Technicians.
 *              VA-87032  asked, not given; routed to Surgery.
 *
 * Fixtures are synthetic. The SIDs and ticket numbers are the real calls;
 * nothing a caller said is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Not the lunch hour: transfers are off 12:00-12:59 Pacific.
const NOT_LUNCH = new Date('2026-11-18T17:00:00Z');
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
const { pcpDirector, OWN_DOB_PROMPT } = await import('./director');
const { RECORDS_ASK_BATCH_MS } = await import('./recordsIntakeGate');
const { ownDobBeforeAnotherTeam } = await import('./ownDobBeforeAnotherTeam');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function agentFor(sid: string) {
  const callId = `${sid}-${++n}`;
  return {
    callId,
    agent: createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }) as never, {
      callId,
      callSid: sid,
      callerPhone: '+15005550006',
    } as never),
  };
}

const DOB = '1950-02-03';
const OPTICAL = 'Patient is calling to check on the status of the glasses order from the last visit.';
const TECH = 'Patient says the eye drops prescribed last week are not at the pharmacy.';
const SURGERY = 'Patient wants to know if they need a follow-up for the cataract surgery date that was scheduled.';
const PRACTICE = 'Patient asked whether the practice is open on Saturdays.';
const GAP = "NOT CAPTURED ON THE CALL: the patient's date of birth.";

function later(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** The intake as the corpus calls ran it: a service inquiry, the caller is the patient. */
async function serviceInquiryFromThePatient(agent: any) {
  const done = await call(agent, 'record_pcp_intake', {
    callPurpose: 'service_inquiry', callerIsThePatient: true, callerName: 'Test Patient',
  });
  // The shape of both calls: the intake had nothing left to ask.
  expect(done.nextQuestion?.field).not.toBe('patientDob');
  return done;
}

beforeEach(() => {
  vi.setSystemTime(NOT_LUNCH);
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90000' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90100' });
});

const RESCUED: Array<[string, string, string, number]> = [
  ['VA-87036', 'CAd9ee28ab3a9ed39218c5ef7c43302ccc', OPTICAL, 1],
  ['VA-87143', 'CAd12f2d4bf5b151fc0a4508c0fa008963', TECH, 3],
];

describe('rescued: a request leaving PCP Support asks the patient their own date of birth first', () => {
  it.each(RESCUED)('%s (%s) is asked before it files, and the date reaches the ticket', async (_t, sid, narrative, dept) => {
    const { agent, callId } = agentFor(sid);
    await serviceInquiryFromThePatient(agent);

    const asked = await call(agent, 'create_pcp_task', { narrative, callerStatedARequest: true });
    expect(asked.success).toBe(false);
    expect(asked.error).toBe('missing_required_field:patientDob');
    expect(asked.say).toBe(OWN_DOB_PROMPT);
    expect(asked.guidance).toMatch(/record_pcp_intake/);
    expect(asked.guidance).toMatch(/patientDob/);
    expect(asked.guidance).toContain(dept === 1 ? 'Optical Support' : 'Clinical Tech Support');
    expect(ticketing.createTicket).not.toHaveBeenCalled();

    later(5_000);
    await call(agent, 'record_pcp_intake', { patientDob: DOB });
    const filed = await call(agent, 'create_pcp_task', { narrative, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload.departmentId).toBe(dept);
    expect(payload).toMatchObject({ patientBirthYear: '1950', patientBirthMonth: '02', patientBirthDay: '03' });
    expect(payload.description).not.toContain(GAP);
    pcpDirector.clear(callId);
  });

  it.each(RESCUED)('%s (%s): a caller who does not give it is filed once, with the gap written', async (_t, sid, narrative, dept) => {
    const { agent, callId } = agentFor(sid);
    await serviceInquiryFromThePatient(agent);
    await call(agent, 'create_pcp_task', { narrative, callerStatedARequest: true });
    later(RECORDS_ASK_BATCH_MS + 1_000);
    const filed = await call(agent, 'create_pcp_task', { narrative, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload.departmentId).toBe(dept);
    expect(payload.patientBirthYear).toBeUndefined();
    expect(payload.description).toContain(GAP);
    // The ask was charged to the call's one date-of-birth budget.
    expect(pcpDirector.get(callId).askCounts?.patientDob).toBe(1);
    pcpDirector.clear(callId);
  });

  it('a sibling call inside the batch window gets the same question and spends nothing', async () => {
    const { agent, callId } = agentFor(RESCUED[0][1]);
    await serviceInquiryFromThePatient(agent);
    const first = await call(agent, 'create_pcp_task', { narrative: OPTICAL, callerStatedARequest: true });
    later(RECORDS_ASK_BATCH_MS - 500);
    const sibling = await call(agent, 'create_pcp_task', { narrative: OPTICAL, callerStatedARequest: true });
    expect(first.error).toBe('missing_required_field:patientDob');
    expect(sibling.error).toBe('missing_required_field:patientDob');
    expect(sibling.say).toBe(OWN_DOB_PROMPT);
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(pcpDirector.get(callId).askCounts?.patientDob).toBe(1);
    // Past the window the ask is spent and the request files.
    later(1_000);
    const filed = await call(agent, 'create_pcp_task', { narrative: OPTICAL, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    pcpDirector.clear(callId);
  });

  it('a date of birth the call already holds is not asked (RULE ZERO step 5)', async () => {
    const { agent, callId } = agentFor(RESCUED[1][1]);
    await serviceInquiryFromThePatient(agent);
    pcpDirector.update(callId, { patientDob: DOB });
    const filed = await call(agent, 'create_pcp_task', { narrative: TECH, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload).toMatchObject({ patientBirthYear: '1950' });
    expect(payload.description).not.toContain(GAP);
    pcpDirector.clear(callId);
  });
});

describe('controls: practice questions that stay in PCP Support are asked nothing', () => {
  it.each([
    ['VA-85628', 'CAae82de53a12d0173796a237d41e1c01a'],
    ['VA-85760', 'CA0f3b922be63f2e0299430aaa4ba5e73a'],
  ])('%s (%s) files at once in PCP Support with no gap line', async (_t, sid) => {
    const { agent, callId } = agentFor(sid);
    await serviceInquiryFromThePatient(agent);
    const filed = await call(agent, 'create_pcp_task', { narrative: PRACTICE, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload.departmentId).toBe(18);
    expect(payload.description).not.toContain(GAP);
    pcpDirector.clear(callId);
  });
});

describe('controls: a caller the intake already asked is not asked again', () => {
  it.each([
    ['VA-85576', 'CAe993e7f6919dd51d951867af08def77a', PRACTICE, 18, false],
    ['VA-86859', 'CA0bee453201e4f72eb805990c26c732b2', TECH, 3, true],
    ['VA-87032', 'CA8e0f203486a891099669a454844a5768', SURGERY, 2, true],
  ] as const)('%s (%s) files at once', async (_t, sid, narrative, dept, gapLine) => {
    const { agent, callId } = agentFor(sid);
    const first = await call(agent, 'record_pcp_intake', {
      callPurpose: 'patient_caller', callerIsThePatient: true, callerName: 'Test Patient',
    });
    expect(first.nextQuestion?.field).toBe('patientDob');
    // The caller gives no date: the intake moves on with the ask spent.
    const second = await call(agent, 'record_pcp_intake', { requestIsAboutAPatient: true });
    expect(second.nextQuestion?.field).not.toBe('patientDob');
    later(5_000);
    const filed = await call(agent, 'create_pcp_task', { narrative, callerStatedARequest: true });
    expect(filed.success).toBe(true);
    expect(ticketing.createTicket).toHaveBeenCalledTimes(1);
    const payload = (ticketing.createTicket.mock.calls as any[])[0][0];
    expect(payload.departmentId).toBe(dept);
    expect(payload.description.includes(GAP)).toBe(gapLine);
    pcpDirector.clear(callId);
  });
});

describe('the rule', () => {
  const base = { callPurpose: 'service_inquiry', callerIsThePatient: true } as any;
  it('asks only for a request leaving PCP Support with no date of birth and the ask unspent', () => {
    const none = new Map<string, number>();
    expect(ownDobBeforeAnotherTeam(base, undefined, none, 0)).toEqual({ ask: false });
    expect(ownDobBeforeAnotherTeam({ ...base, patientDob: DOB }, 'Optical Support', none, 0)).toEqual({ ask: false });
    expect(ownDobBeforeAnotherTeam({ ...base, askCounts: { patientDob: 1 } }, 'Optical Support', none, 0)).toEqual({ ask: false });
    expect(ownDobBeforeAnotherTeam(base, 'Optical Support', none, 0)).toMatchObject({ ask: true, spends: true, prompt: OWN_DOB_PROMPT });
  });

  it('keys the ask on the patient, so a later patient on the call is a new ask', () => {
    const asked = new Map<string, number>([['patientDob:0', 1_000]]);
    expect(ownDobBeforeAnotherTeam(base, 'Optical Support', asked, 1_500)).toMatchObject({ ask: true, spends: false });
    expect(ownDobBeforeAnotherTeam({ ...base, patientOrdinal: 1 }, 'Optical Support', asked, 1_500)).toMatchObject({ ask: true, spends: true });
  });

  it('the window closes at the batch interval', () => {
    const asked = new Map<string, number>([['patientDob:0', 1_000]]);
    const spent = { ...base, askCounts: { patientDob: 1 } };
    expect(ownDobBeforeAnotherTeam(spent, 'Optical Support', asked, 1_000 + RECORDS_ASK_BATCH_MS - 1)).toMatchObject({ ask: true, spends: false });
    expect(ownDobBeforeAnotherTeam(spent, 'Optical Support', asked, 1_000 + RECORDS_ASK_BATCH_MS)).toEqual({ ask: false });
  });
});
