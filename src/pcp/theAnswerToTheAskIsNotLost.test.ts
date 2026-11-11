/**
 * v205 — THE ANSWER TO "WHAT CAN I HELP YOU WITH?" IS NOT LOST, AND A
 * DOCUMENT IS NOT A PERSON.
 *
 * Wayne, 2026-11-11, on v204 (#452):
 *
 *   1. The agent asks a caller who only asked for a person what they need.
 *      If the caller answers and the line then goes quiet before the model
 *      files it, the request was dropped: the PCP teardown floor skipped any
 *      call where the ask had been made. It now reads the answer from the
 *      call's timed turns (`answerToTheAsk.ts`) and files it for a person to
 *      route, on an ending we caused. A caller who hung up still gets nothing
 *      filed (v100).
 *   2. v204's `provider`, `doctor` and `nurse` made "get them the provider
 *      notes" read as an ask for a person, through the `get me|them|us` branch.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. v204 is merged, not published (production
 * reads v198), so the ask has never run on a live call and its shape has no
 * live instances. The nearest live shape (PCP, the 14 days to 2026-11-11, an
 * ending we caused, the agent's last line a question the caller answered, no
 * ticket of any provenance) is 17 calls, every one answered by a lookup and
 * closed with `record_automated_resolution`, which is the ruling working. So
 * the call shapes below are synthetic.
 *
 * The person-only answers ARE measured: the 18 person-only calls of
 * 2026-11-10 (v204's corpus), taking every caller line that does not answer a
 * name, organisation, role or email question as if it were the answer to the
 * ask. 15 would file nothing. 3 would file a ticket that is still not a
 * request (an ASR misreading of "front desk", "I hit the wrong button", and
 * background talk), and those are pinned below as the accepted residue: the
 * direction that costs a staffer a ticket to close, not a caller their
 * request. Fixtures are synthetic stand-ins in each line's shape; nothing a
 * caller said is in this file.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  withdrawPcpTicket: vi.fn(async (): Promise<any> => ({ success: true })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent, sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { answerToTheNoRequestAsk, saysMoreThanAnAskForAPerson } = await import('./answerToTheAsk');
const { asksForAPerson } = await import('./explicitAsk');
type Turn = import('./answerToTheAsk').TeardownTurn;

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

/** Lunch on 2026-11-10 (PST): no transfer is granted, so the ask is reached. */
const T0 = new Date('2026-11-10T12:10:00-08:00').getTime();
const OFFICE = { callerName: 'Test Assistant', callerOrganization: 'Example Family Practice', callbackNumber: '5005550006' };
const ASK = 'I can take a message for the team. What can I help you with today?';

/** The call's turns: what came before the ask, the ask, and the answer. */
function turnsWith(answer: string[], after: string[] = []): Turn[] {
  return [
    { role: 'agent', text: 'Thank you for calling Azul Vision PCP Support. How can I help you today?', atMs: T0 - 60_000 },
    { role: 'caller', text: 'Speak with the staff.', atMs: T0 - 50_000 },
    { role: 'agent', text: 'And who am I speaking with, and where are you calling from?', atMs: T0 - 40_000 },
    { role: 'caller', text: 'Test Assistant, Example Family Practice.', atMs: T0 - 30_000 },
    { role: 'agent', text: ASK, atMs: T0 + 800 },
    ...answer.map((text, i) => ({ role: 'caller' as const, text, atMs: T0 + 5_000 + i * 1_000 })),
    ...after.map((text, i) => ({ role: (i % 2 === 0 ? 'agent' : 'caller') as Turn['role'], text, atMs: T0 + 20_000 + i * 1_000 })),
  ];
}

async function askedThenEnded(sid: string, outcome: string, turns: Turn[] | undefined) {
  vi.setSystemTime(T0);
  const agent = agentFor(sid);
  await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
  const asked = await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked to speak with the staff.', callerStatedARequest: false });
  expect(asked.noRequestAsk).toBe('ask');
  expect(pcpDirector.get(sid).requestNotStatedAskedAt).toBe(T0);
  expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  await sweepPcpUnfiledCall(sid, { outcome, turns } as never);
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90500' });
  ticketing.createTicket.mockClear();
  ticketing.withdrawPcpTicket.mockClear();
});

const ANSWER = 'I need to check on a referral for a mutual patient.';

/** A synthetic CallSid in the canonical shape. */
let next = 0x5050;
const sid = () => `CA${(next++).toString(16).padStart(32, '0')}`;

describe('the caller answered the ask, and the call ended on our side before it was filed', () => {
  it.each(['dead_air', 'caller_silent', 'max_duration', 'agent_ended', 'goodbye_grace'])(
    'files the answer for a person to route (%s)',
    async (outcome) => {
      await askedThenEnded(sid(), outcome, turnsWith([ANSWER]));
      expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
      const payload = (ticketing.createPcpTicket.mock.calls[0] as unknown[])[0] as any;
      expect(payload.callPurpose, 'routed by a person, never guessed').toBe('unclassified_call');
      expect(payload.disposition).toBe('CREATE_TASK');
      expect(payload.narrative).toMatch(/THE CALLER SAID WHAT THEY NEED, BUT THE CALL ENDED BEFORE IT WAS FILED/);
      expect(payload.narrative).toContain(`- ${ANSWER}`);
      expect(payload.narrative, 'only the answer, not the person ask before it').not.toContain('Speak with the staff.');
      expect(payload.failureInformation).toBe('call_not_classified');
    },
  );

  it('a caller who hung up still gets nothing filed (v100)', async () => {
    await askedThenEnded(sid(), 'caller_hangup', turnsWith([ANSWER]));
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('a caller who went to the queue gets nothing filed (v100)', async () => {
    await askedThenEnded(sid(), 'transferred', turnsWith([ANSWER]));
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('with no turns on the record, nothing files, as on v204', async () => {
    await askedThenEnded(sid(), 'dead_air', undefined);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('an answer that only asks for a person again files nothing', async () => {
    await askedThenEnded(sid(), 'dead_air', turnsWith(['Just a representative, please.']));
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('an answer that only says who they are files nothing', async () => {
    await askedThenEnded(sid(), 'dead_air', turnsWith(['Test Assistant from Example Family Practice.']));
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });
});

describe('the window is the answer to the ask, read by position', () => {
  const known = ['Test Assistant', 'Example Family Practice'];

  it('opens on the first agent line after the ask and returns what the caller said in it', () => {
    expect(answerToTheNoRequestAsk(turnsWith([ANSWER]), T0, known)).toEqual([ANSWER]);
  });

  it('ignores what the caller said before the ask, however much it was', () => {
    const turns: Turn[] = [
      { role: 'caller', text: 'Speak to someone about a referral for a mutual patient.', atMs: T0 - 10_000 },
      { role: 'agent', text: ASK, atMs: T0 + 800 },
    ];
    expect(answerToTheNoRequestAsk(turns, T0, known)).toEqual([]);
  });

  it('closes on the next agent line: a later answer is to a later question', () => {
    const turns = turnsWith(['Speak with staff.'], ['Is there anything else?', 'I need to check on a referral for a mutual patient.']);
    expect(answerToTheNoRequestAsk(turns, T0, known)).toEqual([]);
  });

  it('never opens when the ask was not spoken', () => {
    const turns: Turn[] = [
      { role: 'agent', text: 'How can I help you today?', atMs: T0 - 60_000 },
      { role: 'caller', text: ANSWER, atMs: T0 + 5_000 },
    ];
    expect(answerToTheNoRequestAsk(turns, T0, known)).toEqual([]);
  });

  it('keeps every substantive line of a split answer', () => {
    const turns = turnsWith(['Yes.', 'It is about a prior authorization.', 'For a mutual patient.']);
    expect(answerToTheNoRequestAsk(turns, T0, known)).toEqual(['It is about a prior authorization.', 'For a mutual patient.']);
  });

  it('has nothing to read without turns', () => {
    expect(answerToTheNoRequestAsk(undefined, T0, known)).toEqual([]);
    expect(answerToTheNoRequestAsk([], T0, known)).toEqual([]);
  });
});

/**
 * The person-only lines of v204's corpus (2026-11-10), as synthetic stand-ins
 * in each line's shape, by the call they came from.
 */
const PERSON_ONLY: Array<[string, string]> = [
  ['CA0e25f858759506aee3157be122b87734', 'Speak to representative.'],
  ['CA1023c6463f0bde2dcee4c800adcc65f1', 'Speak with staff.'],
  ['CA27aeb5cc4bb5edc479ca9227ac449a8e', 'Speak to a staff.'],
  ['CA3e11acc8b3d2da5034818222cc191ecd', 'Talk to representative.'],
  ['CA45fef5bf72ef64bd86643fd0775976c7', 'From my phone, representative.'],
  ['CA45fef5bf72ef64bd86643fd0775976c7', 'I need a representative.'],
  ['CA48acc2562487bb1b1544852a23b4bd1d', 'Speak to provider.'],
  ['CA51ccaf679871976b6d24c87c816e83ab', 'Speak with the front staff.'],
  ['CA842311dc1709ca289bf7578a6acb8d6f', 'Let me speak to someone. Agent.'],
  ['CA842311dc1709ca289bf7578a6acb8d6f', 'Go ahead.'],
  ['CA87a6b58a98a4794166bb92691d905c15', 'Speak with a doctor or nurse.'],
  ['CA8a07b6e15f80860048fb617d30a043dd', 'Speak to staff.'],
  ['CA8ea3135287709d4514ff9e72d5db1473', 'I want to talk to a doctor.'],
  ['CAab7c338f0f53be12f7d7d818cc8be954', 'Speak with a nurse.'],
  ['CAb2d073fc0eb9affa388fe0cc822dcaa9', 'I need to speak with a representative.'],
  ['CAba3cb3dade3eff540aeb07966a887d72', 'I wanted to speak with a, uh, human, please.'],
  ['CAba3cb3dade3eff540aeb07966a887d72', 'Front desk.'],
  ['CAd7242d4b00cc4240bf2c668125cba1ac', 'Speak to a department.'],
  ['CAdbffb8a749fff52c2c3501e087620d40', 'Hello?'],
  ['CA349e9be509a9f6298d5b2222b5800a2a', 'Customer service.'],
  ['CA743d4c9da8612ccc752f58ff6e440825', 'Speak to a representative.'],
];

describe("v204's corpus: an answer that only asks for a person is not a request", () => {
  it.each(PERSON_ONLY)('%s: "%s" files nothing', (_sid, line) => {
    expect(saysMoreThanAnAskForAPerson(line, [])).toBe(false);
  });

  it('a callback with no topic is not a request either', () => {
    expect(saysMoreThanAnAskForAPerson('Can someone call me back?', [])).toBe(false);
  });

  /** The accepted residue: 3 of the 18 calls carry a line like these. */
  it.each([
    ['CA743d4c9da8612ccc752f58ff6e440825', 'Speak to a friend desk.'],
    ['CA349e9be509a9f6298d5b2222b5800a2a', 'Oh my god. Customer service. I hit the wrong button.'],
    ['CA842311dc1709ca289bf7578a6acb8d6f', 'Uh, the parade is tomorrow and then it snows this weekend.'],
  ])('%s: "%s" is the accepted residue and would file', (_sid, line) => {
    expect(saysMoreThanAnAskForAPerson(line, [])).toBe(true);
  });

  it.each([
    'Referrals.',
    'Referral status.',
    'Prior authorization.',
    'Eyeglass pickup.',
    'Transfer me to scheduling.',
    'I have a question about a bill.',
    'I need the provider notes for a mutual patient.',
  ])('a short request is still a request: "%s"', (line) => {
    expect(saysMoreThanAnAskForAPerson(line, [])).toBe(true);
  });

  it('subtracts the names, organisation and role the intake holds', () => {
    expect(saysMoreThanAnAskForAPerson('Test Assistant, Example Family Practice.', ['Test Assistant', 'Example Family Practice'])).toBe(false);
    expect(saysMoreThanAnAskForAPerson('Medical assistant.', ['Medical assistant'])).toBe(false);
  });
});

describe('a document is not a person (the get branch)', () => {
  it.each([
    'Caller asked us to get them the provider notes.',
    'get them the provider notes',
    "get me the doctor's note",
    "get them the nurse's note",
    'get them the provider’s notes',
    'Caller needs us to get them the physician report for the patient.',
    'get us the office fax number',
    'get me the provider referral form',
    'Caller asked to get me the provider notes from office',
    'get me the nurse\'s notes from office',
    'get us the nurse report from office',
  ])('"%s" is not an ask for a person', (narrative) => {
    expect(asksForAPerson(narrative)).toBe(false);
  });

  it.each([
    'get me a rep',
    'get me the provider',
    'Caller asked us to get them the provider, please.',
    "get me the doctor's office",
    "get me the doctor's office manager",
    'Can you get me someone',
    'get me the nurse, please',
    'speak with the office referral coordinator',
    'Caller asked to speak with the provider about the notes.',
  ])('"%s" is still an ask', (narrative) => {
    expect(asksForAPerson(narrative)).toBe(true);
  });
});

describe('the wiring a behavioural test cannot see', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the floor hands the sweep the record\'s turns', () => {
    expect(read('runtime/pcpFloor.ts')).toMatch(/sweep\(record\.callSid, \{ outcome: record\.outcome, transcript: record\.transcript, turns: record\.turns \}\)/);
  });

  it('the sweep reads the answer only after the v100 exit, so a hang-up never reaches it', () => {
    const src = read('agents/pcpAgent.ts');
    const v100 = src.indexOf("if (ctx.outcome === 'caller_hangup' || ctx.outcome === 'transferred') {");
    const reader = src.indexOf('answerToTheNoRequestAsk(ctx.turns');
    expect(v100).toBeGreaterThan(0);
    expect(reader).toBeGreaterThan(v100);
  });
});
