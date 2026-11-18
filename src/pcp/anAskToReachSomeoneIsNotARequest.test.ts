/**
 * v248 — AN ASK TO REACH SOMEONE IS NOT A REQUEST.
 *
 * The 2026-11-11 ruling (v204): "tickets that are incomplete should not be
 * filed." A PCP ticket that says only that the caller wanted a person is that
 * ticket. v204 files nothing when the model answers `callerStatedARequest:
 * false` and nothing is on record; it asks once what the caller needs.
 *
 * THE CORPUS is the nine PCP tickets of 2026-11-17 (Pacific day) whose only
 * content was that the caller wanted someone. On all nine the model sent
 * `callerStatedARequest: true` (read from `tool_call_payloads`), so the v204
 * gate never fired:
 *
 *   - five were the refused-transfer fallback (`handoff_to_pcp` ->
 *     `handoff_not_eligible_task_created`), four came through `create_pcp_task`;
 *   - the narratives asked to speak with a staff member by NAME (four), with
 *     "Dr. <name>" (one), with "the technician" (one), for "someone to talk
 *     to" (one), for a representative (one) and for customer service (one).
 *
 * Two changes, measured separately:
 *
 *   1. The model's field. `callerStatedARequest`'s description said "false
 *      only when all the caller has asked for is a person". The model read a
 *      named staff member, a doctor, a technician or a department as more
 *      than "a person". It now names those shapes. What the model then sends
 *      is the model's (standing instruction 3): this file pins what the model
 *      READS, and the offline A/B in the PR body measures what it sends.
 *
 *   2. "Dr." counts as "doctor" when the doctor is the person the caller
 *      asked to reach (`explicitAsk.ts`), so an office that asks to speak with
 *      a doctor by name is offered the transfer v204 gives an office that asks
 *      for "a doctor". That is the one corpus call a rule reaches on its own.
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
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-90480' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-90480' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { asksForAPerson } = await import('./explicitAsk');

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

/** Pacific wall-clock time on 2026-11-17 (PST, UTC-8). */
const at = (pt: string) => new Date(`2026-11-17T${pt}:00-08:00`);

const OFFICE = { callerName: 'Test Assistant', callerOrganization: 'Example Family Practice', callbackNumber: '5005550006' };

interface Row {
  sid: string;
  ticket: string;
  pt: string;
  purpose: string;
  door: 'handoff' | 'create';
  /** The narrative's shape, synthetic. */
  narrative: string;
}

/** The nine tickets of 2026-11-17 (Support Center ticket times, Pacific). */
const CORPUS: Row[] = [
  { sid: 'CAe9fc34df5f995c5dfcf5dbd2cfa732cb', ticket: 'PCP-86269', pt: '09:42', purpose: 'provider_information', door: 'create', narrative: 'Caller from Example Family Practice asked to speak with Pat Doe. No other details about the request were given.' },
  { sid: 'CA5cc0ca50a11c08161113f1521e053661', ticket: 'PCP-86335', pt: '10:51', purpose: 'provider_information', door: 'handoff', narrative: 'Caller from Example Family Practice is asking to speak with Lee Roe.' },
  { sid: 'CAd2f635462e5e3e7ebbc0ce0909e5b51f', ticket: 'PCP-86426', pt: '12:16', purpose: 'pharmaceutical_representative', door: 'create', narrative: 'Caller called asking to speak to Sam. No further details about the request were provided.' },
  { sid: 'CAa64038f4be63cc0cda3f3b7ecc51d161', ticket: 'PCP-86466', pt: '13:11', purpose: 'provider_information', door: 'handoff', narrative: 'Caller from Example Eye asked to talk to the technician.' },
  { sid: 'CA7076c9e1e8d8cc7c0cdefd633db7a246', ticket: 'PCP-86526', pt: '14:15', purpose: 'provider_information', door: 'handoff', narrative: 'Caller from Example Family Practice asked to speak with Kim Poe.' },
  { sid: 'CA248b671087314cee85363026ab3098df', ticket: 'PCP-86556', pt: '14:46', purpose: 'service_inquiry', door: 'create', narrative: 'Caller is very tired of not being able to reach the office. Says it is urgent and just needs someone to talk to.' },
  { sid: 'CA3640a8b2dbe5855d8dcaa1a96524be47', ticket: 'PCP-86564', pt: '14:57', purpose: 'service_inquiry', door: 'create', narrative: 'Caller from Example Program asked for a representative.' },
  { sid: 'CA37a811ac24a62f3c0ef2f004d9655dcb', ticket: 'PCP-86641', pt: '16:09', purpose: 'provider_information', door: 'handoff', narrative: 'Caller from Example Eye called asking to speak with Dr. Amini.' },
  { sid: 'CA813b3897ef14865b34ab68086b66c278', ticket: 'PCP-86659', pt: '16:37', purpose: 'service_inquiry', door: 'handoff', narrative: 'Caller from Example Medical Group called requesting customer service.' },
];

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90480' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90480' });
});

describe('"Dr." counts when the doctor is the person asked for', () => {
  it.each([
    'Caller called asking to speak with Dr. Amini.',
    'Caller asked to talk to Dr Amini about it.',
    'Caller wants to speak with the Dr.',
    'Caller asked us to transfer them to Dr. Amini.',
    'Caller asked to be connected to Dr. Amini, please.',
    'Caller asked for the Dr.',
    'Caller asked to speak with Dr. Amini about the patient.',
    "Caller asked to speak with Dr. O'Brien regarding a referral.",
    'Caller wants to talk with a Dr., please.',
    'Caller asked us to put them through to Dr. Amini-Lee.',
    // The doctor's own staff is still a person.
    "Caller asked to speak with Dr. Amini's office about the fax.",
    "Caller asked to speak with Dr. Amini's medical assistant.",
    "Caller asked to speak with Dr. Amini's coordinator for cataract surgery.",
    "Caller asked to be connected to Dr. Tompkins' nurse.",
  ])('"%s" is an ask for a person', (n) => {
    expect(asksForAPerson(n)).toBe(true);
  });

  it.each([
    // After `get` the abbreviation can begin a document's owner, so that
    // branch reads the raw text; after an asking verb the noun must end the
    // phrase, so the name fails it.
    'Caller asked us to get them Dr. Amini\'s notes from the last visit.',
    'Caller requested Dr. Amini\'s records for the patient.',
    'Caller asked for Dr. Amini\'s fax number.',
    'Caller asked for Dr. Amini.',
    // A negated ask is still not one.
    'Caller did not ask to speak with Dr. Amini.',
    // `dr` inside a word is not the abbreviation.
    'Caller asked to talk with the pharmacy about the drops.',
    // The doctor in the window is not the person asked for (Codex on #494).
    "Caller asked to speak with the pharmacy about Dr. Amini's prescription.",
    "Caller asked to be connected to Dr. Amini's voicemail.",
    'Caller asked to be connected to Dr. Amini voicemail.',
    "Caller asked to speak with Dr. Amini's office fax line.",
    // A provider choice is not an ask to be put through.
    'Patient requested Dr. Amini for the surgery.',
    'Caller wants Dr. Amini to review the images.',
    // After an asking verb the noun must end the phrase, as "asked for the
    // doctor about the refill" already reads nothing.
    'Caller asked for the Dr. about the refill.',
    'Caller asked for the doctor about the refill.',
    // A mention is not an ask.
    'Caller is Dr. Amini from Example Eye.',
  ])('"%s" is not', (n) => {
    expect(asksForAPerson(n)).toBe(false);
  });
});

describe('the corpus: PCP-86641, an office asking for a doctor by name, is offered the transfer', () => {
  const row = CORPUS.find((r) => r.ticket === 'PCP-86641')!;

  it(`${row.sid} reaches the queue choice instead of the refused-transfer fallback`, async () => {
    vi.setSystemTime(at(row.pt));
    const agent = agentFor(row.sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: row.purpose });
    // What the model sent on the day: true.
    const r = await call(agent, 'handoff_to_pcp', { narrative: row.narrative, callerStatedARequest: true });
    expect(r.error, 'the queue choice is the transfer being offered').toBe('queue_choice');
    expect(ticketing.createPcpTicket, 'no refused-transfer fallback was filed').not.toHaveBeenCalled();
    pcpDirector.clear(row.sid);
  });
});

describe('the corpus: with the model answering false, none of the nine files a ticket that says only "they wanted someone"', () => {
  it('covers the nine tickets', () => {
    expect(CORPUS).toHaveLength(9);
  });

  const notTransferred = CORPUS.filter((r) => !asksForAPerson(r.narrative));

  it('a rule reaches only what the abbreviation and the existing nouns reach; the rest is the model\'s field', () => {
    // Four name a staff member, one the technician, one "someone to talk to":
    // no verb-and-noun rule reads those without a name detector (standing
    // instruction 3). The representative and customer service asks already
    // latch, and now "Dr." does too.
    expect(notTransferred.map((r) => r.ticket)).toEqual([
      'PCP-86269', 'PCP-86335', 'PCP-86426', 'PCP-86466', 'PCP-86526', 'PCP-86556',
    ]);
  });

  it.each(notTransferred.map((r) => [r.sid, r] as const))('%s files nothing and asks once when the model answers false', async (_sid, row) => {
    vi.setSystemTime(at(row.pt));
    const agent = agentFor(row.sid);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: row.purpose });
    const tool = row.door === 'handoff' ? 'handoff_to_pcp' : 'create_pcp_task';
    const r = await call(agent, tool, { narrative: row.narrative, callerStatedARequest: false });
    expect(r.success).toBe(false);
    expect(['no_request_stated', 'no_request_try_handoff']).toContain(r.refused ?? r.error);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    pcpDirector.clear(row.sid);
  });
});

describe('what the model reads', () => {
  const agent = agentFor('CA00000000000000000000000000000248');
  const described = (tool: string) => {
    const t = (agent.tools as any[]).find((x) => x.name === tool);
    return String(t?.parameters?.properties?.callerStatedARequest?.description ?? '');
  };

  it.each(['create_pcp_task', 'handoff_to_pcp'])('%s: the field names the shapes the model read as a request', (tool) => {
    const d = described(tool);
    expect(d).toMatch(/^false\b/);
    for (const shape of [/by name/i, /\bdoctor\b/i, /\btechnician\b/i, /\bdepartment\b/i, /customer service/i]) {
      expect(d, `${tool} names ${shape}`).toMatch(shape);
    }
    expect(d, 'it says what makes it a request').toMatch(/what it is about/i);
    expect(d).toMatch(/otherwise true/i);
  });

  it('both tools read the same words', () => {
    expect(described('create_pcp_task')).toBe(described('handoff_to_pcp'));
  });
});
