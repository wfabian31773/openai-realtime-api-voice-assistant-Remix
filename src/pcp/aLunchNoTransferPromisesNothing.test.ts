/**
 * v215 — WHEN NO ONE CAN BE PUT THROUGH, A CALLER WHO ASKED ONLY FOR A PERSON
 * IS ASKED WHAT THEY NEED, NOT TOLD IT WAS TAKEN DOWN.
 *
 * THE CORPUS is the PCP calls since v205 (2026-11-11..12) on which an office
 * asked for a person during the lunch closure (12:00–12:59 Pacific), heard
 * "I'm not able to put you through from this line, but I'll take this down
 * and the right team will call you back.", and left with no ticket of any
 * provenance: 3 of 171 substantive PCP calls in the window.
 *
 * Two links, both read from the calls' tool timelines:
 *
 *   1. The done-intake reply (`intakeNextStep.ts`) handed the model that line
 *      for any caller who asked for a person when no transfer could be
 *      granted, whether or not they had said what they needed. v204 files
 *      nothing for a request that is only an ask for a person, so on all 3
 *      the promise was spoken and nothing could be filed behind it.
 *   2. `create_pcp_task`'s v204 ask (`no_request_stated`) tells the model to
 *      call `handoff_to_pcp` for an office. At lunch that tool can only refuse
 *      again, and a second refusal outside the batch window spends the one
 *      ask: on CAc976c6fb the call could then end with the caller never asked
 *      what they needed.
 *
 * Fixtures are synthetic. The SIDs are the real calls; nothing a caller said
 * is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

vi.mock('../../server/db', () => ({ db: {} }));

const ticketing = vi.hoisted(() => ({
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-90500' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-90500' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector, NO_REQUEST_BATCH_WINDOW_MS } = await import('./director');
const refusals = await import('./refusals');
const { NO_TRANSFER_LINE } = await import('./intakeNextStep');

/** The line, written out here so a build without the constant fails on it rather than on undefined. */
const ASK_LINE =
  "I'm not able to put you through from this line, but I can take a message for the team. What can I help you with today?";
const PROMISE = /taken this down|take this down|call you back/i;

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

/** Pacific wall-clock time on 2026-11-11 (PST, UTC-8). */
const at = (pt: string) => new Date(`2026-11-11T${pt}:00-08:00`);

const OFFICE = { callerName: 'Test Assistant', callerOrganization: 'Example Family Practice' };
const PATIENT = { callerName: 'Test Caller', callerIsThePatient: true };
const ONLY_A_PERSON = 'Caller asked to speak with someone in the office.';

/** The 3 lunch-closure calls of 2026-11-11 (read from the Support Center and the timelines). */
const CORPUS = [
  { sid: 'CA1b5de861049a1ae8b9a77f9ca5338a70', pt: '12:07' },
  { sid: 'CAb1573aff406998c2f7b0e7e515375757', pt: '12:44' },
  { sid: 'CAc976c6fb800635db975cdecbeff3d44b', pt: '12:51' },
] as const;

async function intakeToTheEnd(sid: string, pt: string, fields: Record<string, unknown> = OFFICE) {
  vi.setSystemTime(at(pt));
  const agent = agentFor(sid);
  const first = await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });
  expect(first.nextQuestion?.field, `${sid}: the first reply asks who is calling`).toBe('callerName');
  const done = await call(agent, 'record_pcp_intake', fields);
  return { agent, done };
}

const CONTROL_SIDS = [
  'CAhf00000000000000000000000000215',
  'CAnl00000000000000000000000000215',
  'CApt00000000000000000000000000215',
  'CAst00000000000000000000000000215',
];

beforeEach(() => {
  // A test that fails half way must not leave its call's state for the next.
  for (const sid of [...CORPUS.map((r) => r.sid), ...CONTROL_SIDS]) pcpDirector.clear(sid);
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90500' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90500' });
});

describe('the ask line is one copy', () => {
  it('the refusals table exports it, and both refusals that ask speak it', () => {
    expect(refusals.NO_TRANSFER_ASK_LINE).toBe(ASK_LINE);
    expect(refusals.PCP_REFUSALS.handoff_not_eligible_no_request.say).toBe(ASK_LINE);
    expect(refusals.PCP_REFUSALS.no_request_stated_no_transfer?.say).toBe(ASK_LINE);
  });
});

describe('the corpus: at lunch, the done-intake reply promises nothing to a caller who asked only for a person', () => {
  it.each(CORPUS)('$sid ($pt): the ask line, and the promise only behind a stated request', async ({ sid, pt }) => {
    const { done } = await intakeToTheEnd(sid, pt);
    expect(done.nextQuestion).toBeUndefined();
    expect(done.transferOnAsk).toBe(false);
    expect(done.transferClosed).toBe(true);
    expect(done.nextStep).toBe('connect_answer_or_file');
    const g = String(done.guidance);
    expect(g).toContain('do not call handoff_to_pcp');
    expect(g, 'a caller who asked only for a person is asked what they need').toContain(ASK_LINE);
    expect(g).toContain('do not say it was taken down');
    // The promise is still there, but only for a caller who has said what they need.
    const promiseAt = g.indexOf(NO_TRANSFER_LINE);
    expect(promiseAt).toBeGreaterThan(-1);
    const before = g.slice(0, promiseAt);
    expect(before.slice(before.lastIndexOf('If ')), 'the promise is behind a stated request').toMatch(/has said what they need/);
    expect(g).toContain('callerStatedARequest: true');
    pcpDirector.clear(sid);
  });

  it.each(CORPUS)('$sid ($pt): a filing with no request is answered by the ask, not sent to handoff_to_pcp', async ({ sid, pt }) => {
    const { agent } = await intakeToTheEnd(sid, pt);
    const first = await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    expect(first.success).toBe(false);
    expect(first.error).toBe('no_request_stated_no_transfer');
    expect(first.refused).toBe('no_request_stated');
    expect(first.noRequestAsk).toBe('ask');
    expect(first.say).toBe(ASK_LINE);
    expect(String(first.say)).not.toMatch(PROMISE);
    const g = String(first.guidance);
    expect(g, 'handoff_to_pcp can only refuse again here, and would spend the ask').not.toMatch(/call handoff_to_pcp with their words/);
    expect(g).toContain('do not call handoff_to_pcp');
    expect(g).toContain('callerStatedARequest: true');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(pcpDirector.next(sid).mayTerminate, 'the ask is owed before the call may end').toBe(false);
    pcpDirector.clear(sid);
  });

  it.each(CORPUS)('$sid ($pt): once the caller says what it is about, it files', async ({ sid, pt }) => {
    const { agent } = await intakeToTheEnd(sid, pt);
    await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    vi.setSystemTime(new Date(at(pt).getTime() + NO_REQUEST_BATCH_WINDOW_MS + 5_000));
    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Caller asked about a referral status for a mutual patient.',
      callerStatedARequest: true,
    });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    expect(ticketing.createPcpTicket.mock.calls.length + ticketing.createTicket.mock.calls.length).toBe(1);
    pcpDirector.clear(sid);
  });

  it.each(CORPUS)('$sid ($pt): still nothing stated after the ask, nothing is filed and the call may end', async ({ sid, pt }) => {
    const { agent } = await intakeToTheEnd(sid, pt);
    await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    vi.setSystemTime(new Date(at(pt).getTime() + NO_REQUEST_BATCH_WINDOW_MS + 5_000));
    const second = await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    expect(second.error).toBe('no_request_stated_spent');
    expect(String(second.say)).not.toMatch(PROMISE);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(pcpDirector.next(sid).mayTerminate).toBe(true);
    pcpDirector.clear(sid);
  });
});

describe('the director says when no one can be put through', () => {
  it('closed at lunch and after a failed transfer, open otherwise', async () => {
    const lunch = await intakeToTheEnd('CAst00000000000000000000000000215', '12:30');
    expect(lunch.done.transferClosed).toBe(true);
    const open = await intakeToTheEnd('CAnl00000000000000000000000000215', '10:15');
    expect(open.done.transferClosed).toBe(false);
    pcpDirector.update('CAnl00000000000000000000000000215', { handoffStatus: 'NO_ANSWER' } as never);
    expect(pcpDirector.next('CAnl00000000000000000000000000215').transferClosed).toBe(true);
  });
});

describe('after a failed transfer the same: no one can be put through', () => {
  it('outside lunch, an office whose transfer failed is asked, not sent back to handoff_to_pcp', async () => {
    const sid = 'CAhf00000000000000000000000000215';
    const { agent } = await intakeToTheEnd(sid, '10:15');
    pcpDirector.update(sid, { handoffStatus: 'NO_ANSWER' } as never);
    const r = await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    expect(r.error).toBe('no_request_stated_no_transfer');
    expect(r.say).toBe(ASK_LINE);
    pcpDirector.clear(sid);
  });
});

describe('controls: outside lunch nothing changes', () => {
  it('an office that asked only for a person is sent to the transfer, nothing filed or spent', async () => {
    const sid = 'CAnl00000000000000000000000000215';
    const { agent, done } = await intakeToTheEnd(sid, '10:15');
    expect(done.transferOnAsk).toBe(true);
    expect(String(done.guidance)).toContain('If the caller asked to speak to a person, call handoff_to_pcp now');
    expect(String(done.guidance)).not.toContain(ASK_LINE);
    const r = await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    expect(r.error).toBe('no_request_try_handoff');
    expect(r.noRequestAsk).toBe('handoff');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    pcpDirector.clear(sid);
  });

  it('a patient outside lunch gets the v204 ask as before', async () => {
    const sid = 'CApt00000000000000000000000000215';
    const { agent } = await intakeToTheEnd(sid, '10:15', PATIENT);
    const r = await call(agent, 'create_pcp_task', { narrative: ONLY_A_PERSON, callerStatedARequest: false });
    expect(r.error).toBe('no_request_stated');
    expect(r.noRequestAsk).toBe('ask');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    pcpDirector.clear(sid);
  });

  it('a stated request at lunch files on the first call, the promise and all', async () => {
    const sid = 'CAst00000000000000000000000000215';
    const { agent } = await intakeToTheEnd(sid, '12:30');
    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Caller asked about a referral status for a mutual patient.',
      callerStatedARequest: true,
    });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    expect(ticketing.createPcpTicket.mock.calls.length + ticketing.createTicket.mock.calls.length).toBe(1);
    pcpDirector.clear(sid);
  });
});
