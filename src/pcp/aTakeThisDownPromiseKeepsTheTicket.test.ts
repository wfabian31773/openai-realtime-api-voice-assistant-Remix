/**
 * "I'LL TAKE THIS DOWN AND THE RIGHT TEAM WILL CALL YOU BACK" KEEPS THE TICKET.
 *
 * The hang-up withdrawal (v100) closes a PCP ticket that names no patient when
 * the caller hangs up, unless the agent told the caller the request was
 * recorded (v102). v102 counted a ticket number read back and the refused
 * transfer's "I've taken this down". It did not count the no-transfer promise
 * the done-intake reply hands the model (`NO_TRANSFER_LINE`, v178/v215), which
 * is the same claim in other words and promises a callback.
 *
 * Measured, every PCP hang-up withdrawal of 2026-11-05..19 (40): on 14 the
 * agent had said that line, a `create_pcp_task` had succeeded, and the ticket
 * was then withdrawn. RULE THREE: those calls are the test. Their real SIDs
 * and tickets are below with the SHAPE of what followed the promise; the words
 * are synthetic stand-ins, because transcripts stay on disk and in call_logs,
 * never in git. On every one the promise is our own copy, word for word.
 *
 *   CAecc8908114b7f5961bbfd014e61b3cfe  PCP-82580  then the filing line
 *   CA48075bd7890f252d6a054bfae78d0cac  PCP-82623  then the filing line
 *   CA5e560a524246bd548648f03526300148  PCP-82605  then the filing line
 *   CA6a024f1a56b48f71b2f9d1eaaa686211  PCP-83286  then the filing line
 *   CAf6ec8891e859cf9bf4ddf4033253ec59  PCP-85073  then the title question
 *   CA43181a176a4de340db0c80eab419b69a  PCP-85087  the promise cut short
 *   CAdb47a75c96386a5ca838d2d80b0c91be  PCP-85854  then the title question
 *   CA10c5a125fcb63321f763a1402dee936f  PCP-85843  then the title question
 *   CAa265b4ca2e78c222d23310ce4c8accc9  PCP-85873  then the title question
 *   CA2633ca0a28a002fbf516242a730451b4  PCP-86972  the promise cut short
 *   CA04ac9c39291e6c0f23f4146394ad41e9  PCP-86999  then the title question
 *   CAa87eda13adac75e80f5094b0526b0490  PCP-87542  then the title question,
 *                                                  itself cut short
 *   CA1fdb5b6ef087bf735ec31689850a15df  PCP-87541  then the title question
 *   CAbb59278111ea02a42d146603a83e4295  PCP-87547  then the title question
 *
 * The other 26 withdrawals of the window carried no claim the detector reads
 * and are withdrawn as before; the controls below hold the two lines that
 * sound like the promise and are not.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

const NOT_LUNCH = new Date('2026-11-18T18:00:00Z'); // Wed 10:00 PST
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
const { NO_TRANSFER_LINE } = await import('./intakeNextStep');
const { NO_TRANSFER_ASK_LINE, PCP_REFUSALS } = await import('./refusals');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
function freshCall() {
  const callId = `CApromise${++n}`;
  const agent = createPcpAgent((async () => ({ ok: true })) as never, { callId } as never);
  return { agent, callId };
}

/** A caller who said who they are and what they need, and gave no patient. Synthetic. */
const INTAKE = {
  callerName: 'front desk coordinator',
  callerOrganization: 'Valley Family Practice',
  callbackNumber: '9515550100',
  callPurpose: 'service_inquiry',
};
const FILING = {
  narrative: 'Coordinator asked for a person; wants to know which fax number to send referral notes to.',
  callerStatedARequest: true,
};

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.withdrawPcpTickets.mockClear();
  ticketing.createPcpTicket.mockImplementation(async () => ({ success: true, ticketNumber: 'PCP-90001' }));
});

async function hungUp(callId: string, transcript: string) {
  markPcpCallEnded(callId);
  await sweepPcpUnfiledCall(callId, { outcome: 'caller_hangup', transcript });
}

const ASKED = 'CALLER: Can I speak with someone in the office?';
const FILING_LINE = 'AGENT: Let me get this logged for you — one moment.';
const TITLE = 'AGENT: And what is your title there?';

/** What followed the promise on each call, as a synthetic stand-in. */
const AFTER = {
  filing: `AGENT: ${NO_TRANSFER_LINE} ${FILING_LINE.slice('AGENT: '.length)}`,
  title: `AGENT: ${NO_TRANSFER_LINE}\n${TITLE}`,
  titleCut: `AGENT: ${NO_TRANSFER_LINE}\n${TITLE} [interrupted]`,
  cut: `AGENT: ${NO_TRANSFER_LINE} [interrupted]`,
} as const;

const CORPUS: Array<[sid: string, ticket: string, shape: keyof typeof AFTER]> = [
  ['CAecc8908114b7f5961bbfd014e61b3cfe', 'PCP-82580', 'filing'],
  ['CA48075bd7890f252d6a054bfae78d0cac', 'PCP-82623', 'filing'],
  ['CA5e560a524246bd548648f03526300148', 'PCP-82605', 'filing'],
  ['CA6a024f1a56b48f71b2f9d1eaaa686211', 'PCP-83286', 'filing'],
  ['CAf6ec8891e859cf9bf4ddf4033253ec59', 'PCP-85073', 'title'],
  ['CA43181a176a4de340db0c80eab419b69a', 'PCP-85087', 'cut'],
  ['CAdb47a75c96386a5ca838d2d80b0c91be', 'PCP-85854', 'title'],
  ['CA10c5a125fcb63321f763a1402dee936f', 'PCP-85843', 'title'],
  ['CAa265b4ca2e78c222d23310ce4c8accc9', 'PCP-85873', 'title'],
  ['CA2633ca0a28a002fbf516242a730451b4', 'PCP-86972', 'cut'],
  ['CA04ac9c39291e6c0f23f4146394ad41e9', 'PCP-86999', 'title'],
  ['CAa87eda13adac75e80f5094b0526b0490', 'PCP-87542', 'titleCut'],
  ['CA1fdb5b6ef087bf735ec31689850a15df', 'PCP-87541', 'title'],
  ['CAbb59278111ea02a42d146603a83e4295', 'PCP-87547', 'title'],
];

describe('the 2026-11-05..19 corpus, through the real sweep', () => {
  it('holds every withdrawal of the window that carried the promise', () => {
    expect(CORPUS).toHaveLength(14);
    expect(new Set(CORPUS.map(([sid]) => sid)).size).toBe(14);
  });

  it.each(CORPUS)('%s (%s) — %s: the ticket stands', async (_sid, ticket, shape) => {
    ticketing.createPcpTicket.mockImplementation(async () => ({ success: true, ticketNumber: ticket }));
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    expect((await call(agent, 'create_pcp_task', FILING)).success).toBe(true);
    await hungUp(callId, `${ASKED}\n${AFTER[shape]}`);
    expect(ticketing.withdrawPcpTickets, 'the caller was promised a callback').not.toHaveBeenCalled();
    expect(ticketing.createPcpTicket.mock.calls, 'and nothing new is filed behind the caller').toHaveLength(1);
  });
});

describe('what counts', () => {
  it('the done-intake promise counts, in the words intakeNextStep.ts gives it', () => {
    expect(toldTheCallerItWasRecorded(`AGENT: ${NO_TRANSFER_LINE}`, [])).toBe(true);
  });

  it('the PCP prompt scripts the same words for a patient, so the same match reads them', () => {
    const src = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const scripted = src.match(/Say so plainly: "([^"]+)"/);
    expect(scripted, 'the patient no-transfer line is still scripted').toBeTruthy();
    expect(toldTheCallerItWasRecorded(`AGENT: ${scripted![1]}`, [])).toBe(true);
  });

  it('a promise cut short after the claim still counts', () => {
    expect(
      toldTheCallerItWasRecorded(
        "AGENT: I'm not able to put you through from this line, but I'll take this down and the right team will call you back. [interrupted]",
        [],
      ),
    ).toBe(true);
  });

  it('a promise cut short before the call-back clause still counts (Codex P1 on #497)', () => {
    expect(
      toldTheCallerItWasRecorded(
        "AGENT: I'm not able to put you through from this line, but I'll take this down and the [interrupted]",
        [],
      ),
    ).toBe(true);
    expect(
      toldTheCallerItWasRecorded("AGENT: I'm not able to put you through from this line, but I will take this down", []),
    ).toBe(true);
    expect(
      toldTheCallerItWasRecorded('AGENT: I\u2019m not able to put you through from this line, but I\u2019ll take this down and', []),
    ).toBe(true);
  });

  it('the scripted lead-in still counts with a person named between (github-actions on #497)', () => {
    // CAad914a95e714fb3815722832ec1e9a73's shape: the one line of 111 in the
    // 30 days that named who the caller asked for inside the lead-in.
    expect(
      toldTheCallerItWasRecorded(
        "AGENT: I'm not able to put you through to Alex from this line, but I'll take this down and the right team will call you back.",
        [],
      ),
    ).toBe(true);
  });

  it('an offer in the promise\'s own words does not count (github-actions on #497)', () => {
    expect(toldTheCallerItWasRecorded("AGENT: If you'd like, I'll take this down for the team.", [])).toBe(false);
    expect(toldTheCallerItWasRecorded('AGENT: Would you like me to? I will take this down and pass it on.', [])).toBe(false);
    expect(
      toldTheCallerItWasRecorded("AGENT: I can't put you through. If you'd like, I'll take this down.", []),
    ).toBe(false);
    expect(
      toldTheCallerItWasRecorded("AGENT: I can put you through to the queue, or I'll take this down if you'd prefer.", []),
    ).toBe(false);
    expect(
      toldTheCallerItWasRecorded("AGENT: I can look that up for you, but I'll take this down for the team if you'd like.", []),
    ).toBe(false);
  });

  it('the promise split across two sentences still counts', () => {
    expect(
      toldTheCallerItWasRecorded(
        "AGENT: I'm not able to put you through from this line. But I'll take this down and the right team will call you back.",
        [],
      ),
    ).toBe(true);
  });

  it('an offer cut short is still an offer and does not count', () => {
    expect(
      toldTheCallerItWasRecorded("AGENT: I'm not able to pull that up right now, but I can take this down for the team [interrupted]", []),
    ).toBe(false);
  });

  it('a line cut before "take this down" carries no claim and does not count', () => {
    expect(
      toldTheCallerItWasRecorded("AGENT: I'm not able to put you through from this line, but I'll [interrupted]", []),
    ).toBe(false);
  });

  it('the no-transfer ask promises nothing and does not count', () => {
    expect(toldTheCallerItWasRecorded(`AGENT: ${NO_TRANSFER_ASK_LINE}`, ['PCP-90001'])).toBe(false);
  });

  it('an offer to take it down promises nothing and does not count', () => {
    const offer = PCP_REFUSALS.schedule_lookup_failed.say!;
    expect(offer).toContain('take this down');
    expect(toldTheCallerItWasRecorded(`AGENT: ${offer}`, ['PCP-90001'])).toBe(false);
  });

  it('the caller saying it is not the agent promising it', () => {
    expect(
      toldTheCallerItWasRecorded("CALLER: So you'll take this down and the right team will call you back?", ['PCP-90001']),
    ).toBe(false);
  });
});

describe('the withdrawal still happens where nothing was promised', () => {
  it.each([
    ['the no-transfer ask, then a hang-up', `${ASKED}\nAGENT: ${NO_TRANSFER_ASK_LINE}`],
    ['the lookup offer, then a hang-up', `${ASKED}\nAGENT: ${PCP_REFUSALS.schedule_lookup_failed.say!}`],
    ['the title question with no promise before it', `${ASKED}\n${TITLE}`],
  ])('%s', async (_label, transcript) => {
    const { agent, callId } = freshCall();
    await call(agent, 'record_pcp_intake', INTAKE);
    await call(agent, 'create_pcp_task', FILING);
    await hungUp(callId, transcript);
    expect(ticketing.withdrawPcpTickets).toHaveBeenCalledWith({ callSid: callId, reason: 'caller_hung_up' });
  });
});
