/**
 * A CALLER TOLD THEIR REQUEST IS RECORDED KEEPS IT, EVEN IF THEY HANG UP.
 *
 * Operator, 2026-10-19: "yes, build the readback exemption for the hang-up
 * withdrawal." The withdrawal (v100) went live that afternoon and withdrew six
 * PCP tickets by 21:20 UTC; on four of them the caller had already heard that
 * the request was recorded. RULE THREE: those calls are the test. Their real
 * SIDs are below with the SHAPE of each; the words are synthetic stand-ins,
 * because transcripts stay on disk and in call_logs, never in git.
 *
 *   CA50d11c65cda76504450e4a94e1fed2a9  ticket number read, then "anything
 *                                       else?", then the caller hung up  KEEP
 *   CA7aafe2bd35a016c34fb9620f4517d271  refused transfer's "I've taken this
 *                                       down", then the caller hung up   KEEP
 *   CA7122a5500e2219b618bde2f07a2824eb  the same                          KEEP
 *   CAb651aef19a2763e3d2cb61e8d95cf5ef  "taken this down", then the email
 *                                       question, then the caller hung up KEEP
 *   CAe52d08dca2e650a6f5c3cad0cd740faa  office hours read out, no claim
 *                                       of a record, caller hung up      WITHDRAW
 *
 * (The sixth, CA0fc953048ba93d2223ec20f9cf2aae8b, went to the queue and was
 * withdrawn at the dial result — not this arm, and unchanged.)
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

const NOT_LUNCH = new Date('2026-09-09T17:00:00Z'); // Wed 10:00 PDT
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
  createPcpTicket: vi.fn(async () => ({ success: true, ticketNumber: 'PCP-90001' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-1' })),
  withdrawPcpTickets: vi.fn(async () => ({ success: true, withdrawn: ['PCP-90001'], kept: [] })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent, sweepPcpUnfiledCall, markPcpCallEnded } = await import('../agents/pcpAgent');
const { toldTheCallerItWasRecorded } = await import('./toldItWasRecorded');
const { PCP_REFUSALS } = await import('./refusals');

const TAKEN_DOWN = PCP_REFUSALS.handoff_not_eligible_task_created.say!;

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CAtold${++n}`;
  const agent = createPcpAgent((async () => ({ ok: true })) as never, { callId } as never);
  return { agent, callId };
}

/** A caller who said who they are and why, and gave no patient. Synthetic. */
const INTAKE = {
  callerName: 'referral coordinator',
  callerOrganization: 'Northside Primary Care',
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};
const NARRATIVE = { narrative: 'Coordinator wants to speak with someone about a referral.' };

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.withdrawPcpTickets.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({ success: true, ticketNumber: 'PCP-90001' }));
});

async function hungUp(callId: string, transcript: string) {
  markPcpCallEnded(callId);
  await sweepPcpUnfiledCall(callId, { outcome: 'caller_hangup', transcript });
}

describe('what counts as telling the caller it is recorded', () => {
  it.each([
    ['the literal number', "AGENT: I've logged your request on ticket PCP-90001. Is there anything else?"],
    ['spelled out, the way grok-voice-3.0 reads it', 'AGENT: Your ticket number is P-C-P-nine-zero-zero-zero-one.'],
    ['spaced letters and digits', 'AGENT: That is P C P 9 0 0 0 1.'],
    ['digits and words mixed', 'AGENT: Ticket P C P nine 0 0 zero one, and the team will follow up.'],
    ['a barge-in cut the line short', "AGENT: Your ticket number is P-C-P-nine-zero-zero-zero-one. The team will [interrupted]"],
  ])('%s', (_label, line) => {
    expect(toldTheCallerItWasRecorded(`CALLER: Representative.\n${line}`, ['PCP-90001'])).toBe(true);
  });

  it("the refused transfer's own claim counts, in the words refusals.ts gives it", () => {
    expect(toldTheCallerItWasRecorded(`AGENT: ${TAKEN_DOWN}`, [])).toBe(true);
  });

  it('its failure siblings make no claim and do not count', () => {
    for (const key of ['handoff_not_eligible', 'handoff_not_eligible_no_callback'] as const) {
      const say = PCP_REFUSALS[key].say;
      expect(say, `${key} has a spoken line`).toBeTruthy();
      expect(toldTheCallerItWasRecorded(`AGENT: ${say}`, ['PCP-90001']), key).toBe(false);
    }
  });

  it('a number this call did not file is not this request', () => {
    expect(toldTheCallerItWasRecorded('AGENT: I see an earlier ticket, PCP-80123, from last week.', ['PCP-90001'])).toBe(false);
  });

  it('the caller saying the number is not the agent telling them', () => {
    expect(toldTheCallerItWasRecorded('CALLER: Is it PCP-90001?\nCALLER: I have taken this down.', ['PCP-90001'])).toBe(false);
  });

  it('digit words inside other words are left alone', () => {
    // "someone", "tone", "often" must not fold into digits.
    expect(toldTheCallerItWasRecorded('AGENT: Someone from the team, often within a day, will call.', ['PCP-1010'])).toBe(false);
  });

  it('a number too short to be distinctive is never matched', () => {
    expect(toldTheCallerItWasRecorded('AGENT: Office 12 is open at nine.', ['PCP-129'])).toBe(false);
  });

  it('an empty transcript, or none at all, tells nobody anything', () => {
    expect(toldTheCallerItWasRecorded('', ['PCP-90001'])).toBe(false);
  });
});

describe('the 2026-10-19 corpus, through the real sweep', () => {
  /** Synthetic stand-ins with each call's shape. */
  const CORPUS: Array<[sid: string, shape: string, transcript: string, withdrawn: boolean]> = [
    [
      'CA50d11c65cda76504450e4a94e1fed2a9',
      'ticket number read, then anything else',
      "CALLER: I'm calling from a clinic about a referral.\nAGENT: I've logged your request on ticket PCP-90001. Is there anything else I can help you with?",
      false,
    ],
    ['CA7aafe2bd35a016c34fb9620f4517d271', 'taken this down after a refused transfer', `CALLER: Representative.\nAGENT: ${TAKEN_DOWN}`, false],
    ['CA7122a5500e2219b618bde2f07a2824eb', 'taken this down after a refused transfer', `CALLER: Can I talk to someone?\nAGENT: ${TAKEN_DOWN}`, false],
    [
      'CAb651aef19a2763e3d2cb61e8d95cf5ef',
      'taken this down, then the email question',
      `CALLER: Representative.\nAGENT: ${TAKEN_DOWN}\nAGENT: And what is the best email address to send this to?`,
      false,
    ],
    [
      'CAe52d08dca2e650a6f5c3cad0cd740faa',
      'office hours read out, no claim of a record',
      'CALLER: Where is your office?\nAGENT: The office is open Monday through Friday, 8 to 5, closed for lunch from',
      true,
    ],
  ];

  it.each(CORPUS)('%s — %s', async (_sid, _shape, transcript, withdrawn) => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    expect((await call(agent, 'create_pcp_task', NARRATIVE)).success).toBe(true);
    await hungUp(callId, transcript);
    if (withdrawn) {
      expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
    } else {
      expect(ticketing.withdrawPcpTickets, 'the caller was told it is recorded').not.toHaveBeenCalled();
    }
    expect(ticketing.createPcpTicket.mock.calls, 'and nothing new is filed behind the caller').toHaveLength(1);
  });
});

describe('the decision is made on what was filed by the time the app is asked', () => {
  it('a filing that lands inside the wait has its number read', async () => {
    let release!: () => void;
    ticketing.createPcpTicket.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ success: true, ticketNumber: 'PCP-90002' }); }) as never,
    );
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    const filing = call(agent, 'create_pcp_task', NARRATIVE);
    await vi.waitFor(() => expect(ticketing.createPcpTicket).toHaveBeenCalled());

    const swept = hungUp(callId, 'AGENT: Your ticket number is P-C-P-nine-zero-zero-zero-two.');
    release();
    await filing;
    await swept;
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
  });

  it('a number nobody filed on this call does not hold back the withdrawal', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', NARRATIVE);
    await hungUp(callId, 'AGENT: Your earlier request was PCP-80123.');
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });

  it('a caller who was told, and whose second filing lands after the call, is not withdrawn then either', async () => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', NARRATIVE);
    let release!: () => void;
    ticketing.createPcpTicket.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ success: true, ticketNumber: 'PCP-90001' }); }) as never,
    );
    const late = call(agent, 'create_pcp_task', NARRATIVE);
    await vi.waitFor(() => expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(2));

    await hungUp(callId, `AGENT: ${TAKEN_DOWN}`); // returns at the bound
    release();
    await late;
    await new Promise((r) => setTimeout(r, 20));
    expect(ticketing.withdrawPcpTickets).not.toHaveBeenCalled();
  }, 15_000);
});

describe('the wiring', () => {
  it('the hang-up sweep reads the transcript after waiting for in-flight filings, and before it asks', () => {
    const src = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');
    const arm = src.slice(src.indexOf("if (ctx.outcome === 'caller_hangup') {"));
    const wait = arm.indexOf('await settleWithin(inFlight');
    const told = arm.indexOf('toldTheCallerItWasRecorded(ctx.transcript');
    const ask = arm.indexOf("await submitPcpWithdrawal(callId, 'caller_hung_up')");
    expect(wait).toBeGreaterThan(-1);
    expect(told, 'read after the wait, so a filing that landed in it is on the list').toBeGreaterThan(wait);
    expect(ask, 'and the app is asked only after').toBeGreaterThan(told);
  });
});
