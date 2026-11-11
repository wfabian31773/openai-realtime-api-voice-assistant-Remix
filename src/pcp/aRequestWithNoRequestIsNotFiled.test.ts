/**
 * v204 — A PCP REQUEST WITH NO REQUEST IN IT IS NOT FILED.
 *
 * Operator, 2026-11-11: "tickets that are incomplete should not be filed."
 *
 * THE CORPUS is the 18 PCP tickets of 2026-11-10 (Pacific day) whose only
 * content was that the caller wanted a person. 16 were the refused-transfer
 * fallback (`handoff_to_pcp` → `handoff_not_eligible`), 2 were `create_pcp_task`
 * with nothing but the ask in the narrative. By when and who:
 *
 *   - 7 were inside the lunch closure (12:00–12:59 Pacific), where no
 *     transfer is granted by rule;
 *   - 2 recorded no organisation outside lunch, driven as the patient shape,
 *     never transferred;
 *   - 9 were an organisation outside lunch, owed a transfer by the
 *     2026-09-04 rule, refused because the words they used for a person
 *     ("staff", "the provider", "a nurse", "customer service", …) were not
 *     ones `asksForAPerson` knew. Over the 14 days to 2026-11-11, 33 offices
 *     were refused a transfer that way outside lunch.
 *
 * So two changes, both measured on these calls: the ask detector learns the
 * words offices use (`explicitAsk.ts`), and a filing that carries no request
 * files nothing — the agent asks once what the caller needs, and if they still
 * say nothing the call may end with no ticket.
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
  createPcpTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'PCP-90400' })),
  createTicket: vi.fn(async (): Promise<any> => ({ success: true, ticketNumber: 'VA-90400' })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: ticketing,
  lookupWasUnavailable: () => false,
}));

const { createPcpAgent, sweepPcpUnfiledCall } = await import('../agents/pcpAgent');
const { pcpDirector, NO_REQUEST_BATCH_WINDOW_MS } = await import('./director');
const { PCP_REFUSALS } = await import('./refusals');
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

/** Pacific wall-clock time on 2026-11-10 (PST, UTC-8). */
const at = (pt: string) => new Date(`2026-11-10T${pt}:00-08:00`);

type Shape = 'lunch' | 'patient' | 'office';
interface Row {
  sid: string;
  pt: string;
  purpose: string;
  shape: Shape;
  door: 'handoff' | 'create';
}

/** The 18 tickets of 2026-11-10, by when and who (read from the Support Center). */
const CORPUS: Row[] = [
  { sid: 'CA45fef5bf72ef64bd86643fd0775976c7', pt: '08:58', purpose: 'service_inquiry', shape: 'patient', door: 'handoff' },
  { sid: 'CA842311dc1709ca289bf7578a6acb8d6f', pt: '09:03', purpose: 'service_inquiry', shape: 'patient', door: 'handoff' },
  { sid: 'CAd7242d4b00cc4240bf2c668125cba1ac', pt: '10:09', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CA27aeb5cc4bb5edc479ca9227ac449a8e', pt: '10:36', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CA8a07b6e15f80860048fb617d30a043dd', pt: '10:45', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CAba3cb3dade3eff540aeb07966a887d72', pt: '12:00', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CAb2d073fc0eb9affa388fe0cc822dcaa9', pt: '12:00', purpose: 'service_inquiry', shape: 'lunch', door: 'create' },
  { sid: 'CA87a6b58a98a4794166bb92691d905c15', pt: '12:04', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CAab7c338f0f53be12f7d7d818cc8be954', pt: '12:05', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CA0e25f858759506aee3157be122b87734', pt: '12:27', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CAdbffb8a749fff52c2c3501e087620d40', pt: '12:40', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CA3e11acc8b3d2da5034818222cc191ecd', pt: '12:45', purpose: 'service_inquiry', shape: 'lunch', door: 'handoff' },
  { sid: 'CA48acc2562487bb1b1544852a23b4bd1d', pt: '13:09', purpose: 'provider_information', shape: 'office', door: 'handoff' },
  { sid: 'CA743d4c9da8612ccc752f58ff6e440825', pt: '13:26', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CA51ccaf679871976b6d24c87c816e83ab', pt: '14:02', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CA349e9be509a9f6298d5b2222b5800a2a', pt: '15:07', purpose: 'service_inquiry', shape: 'office', door: 'create' },
  { sid: 'CA1023c6463f0bde2dcee4c800adcc65f1', pt: '16:00', purpose: 'service_inquiry', shape: 'office', door: 'handoff' },
  { sid: 'CA8ea3135287709d4514ff9e72d5db1473', pt: '16:37', purpose: 'provider_information', shape: 'office', door: 'handoff' },
];
// CA87a6b58a was recorded as peer_to_peer, a HAND_OFF purpose whose intake arm
// grants a transfer regardless of lunch once the intake is complete; on the
// call it was refused because the intake was not. It is driven as the lunch
// refusal it was, under a purpose whose only grant is the ask.

/** What an office says when all it wants is a person. Synthetic, one per word. */
const PERSON_WORDS = [
  'Caller asked to speak with the staff.',
  'Caller asked to speak to a nurse.',
  'Caller would like to speak with the provider.',
  'Caller asked to speak to someone in the department.',
  'Caller requested customer service.',
  'Caller asked to speak to a medical assistant.',
  'Caller asked for the doctor.',
];
const OFFICE = { callerName: 'Test Assistant', callerOrganization: 'Example Family Practice', callbackNumber: '5005550006' };
const PATIENT = { callerName: 'Test Caller', callerIsThePatient: true, callbackNumber: '5005550006' };

function setUp(row: Row) {
  vi.setSystemTime(at(row.pt));
  const agent = agentFor(row.sid);
  const fields = row.shape === 'patient' ? PATIENT : OFFICE;
  return { agent, fields };
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
  ticketing.createPcpTicket.mockResolvedValue({ success: true, ticketNumber: 'PCP-90400' });
  ticketing.createTicket.mockClear();
  ticketing.createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-90400' });
});

describe('the corpus: a caller who asked only for a person, and could not be put through, gets no ticket', () => {
  const refused = CORPUS.filter((r) => r.shape !== 'office');
  it('covers the 9 calls that were rightly refused a transfer', () => {
    expect(refused).toHaveLength(9);
  });

  it.each(refused.map((r, i) => [r.sid, r, i] as const))('%s files nothing, asks once, then may end', async (_sid, row, i) => {
    const { agent, fields } = setUp(row);
    await call(agent, 'record_pcp_intake', { ...fields, callPurpose: row.purpose });
    const words = PERSON_WORDS[i % PERSON_WORDS.length];
    const tool = row.door === 'handoff' ? 'handoff_to_pcp' : 'create_pcp_task';

    const first = await call(agent, tool, { narrative: words, callerStatedARequest: false });
    expect(first.success).toBe(false);
    expect(first.refused).toBe('no_request_stated');
    expect(first.noRequestAsk).toBe('ask');
    expect(String(first.say), 'nothing was taken down, so it must not say so').not.toMatch(/taken this down/i);
    expect(String(first.say)).toMatch(/What can I help you with today\?/);
    expect(ticketing.createPcpTicket, 'a ticket that says only "they wanted a person"').not.toHaveBeenCalled();
    expect(ticketing.createTicket).not.toHaveBeenCalled();
    expect(pcpDirector.next(row.sid).mayTerminate, 'the ask is owed before the call may end').toBe(false);

    // A later turn, and still nothing stated.
    vi.setSystemTime(new Date(at(row.pt).getTime() + NO_REQUEST_BATCH_WINDOW_MS + 5_000));
    const second = await call(agent, tool, { narrative: words, callerStatedARequest: false });
    expect(second.error).toBe('no_request_stated_spent');
    expect(second.noRequestAsk).toBe('spent');
    expect(String(second.say)).not.toMatch(/follow up|call back|taken this down/i);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    expect(pcpDirector.next(row.sid).mayTerminate, 'nothing to file, by rule: the call may end').toBe(true);

    // And the floor does not file it behind them, whatever ended the call.
    await sweepPcpUnfiledCall(row.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket, 'the floor must not file what the tool refused').not.toHaveBeenCalled();
  });

  it.each(refused.map((r, i) => [r.sid, r, i] as const))('%s files the request once the caller says what it is', async (_sid, row, i) => {
    const { agent, fields } = setUp(row);
    await call(agent, 'record_pcp_intake', { ...fields, callPurpose: row.purpose });
    const tool = row.door === 'handoff' ? 'handoff_to_pcp' : 'create_pcp_task';
    await call(agent, tool, { narrative: PERSON_WORDS[i % PERSON_WORDS.length], callerStatedARequest: false });
    const filed = await call(agent, 'create_pcp_task', {
      narrative: 'Caller asked about a referral status for a mutual patient.',
      callerStatedARequest: true,
    });
    expect(filed.success, JSON.stringify(filed)).not.toBe(false);
    expect(ticketing.createPcpTicket.mock.calls.length + ticketing.createTicket.mock.calls.length).toBe(1);
    pcpDirector.clear(row.sid);
  });
});

describe('the corpus: an office outside lunch that asked for a person is put through', () => {
  const offices = CORPUS.filter((r) => r.shape === 'office');
  it('covers the 9 offices', () => {
    expect(offices).toHaveLength(9);
  });

  it.each(offices.map((r, i) => [r.sid, r, i] as const))('%s: the ask latches and the transfer is offered, nothing filed', async (_sid, row, i) => {
    const { agent, fields } = setUp(row);
    await call(agent, 'record_pcp_intake', { ...fields, callPurpose: row.purpose });
    const words = PERSON_WORDS[i % PERSON_WORDS.length];
    expect(asksForAPerson(words), `"${words}" is an office asking for a person`).toBe(true);

    if (row.door === 'create') {
      // The model went to file instead of transferring: sent to the transfer,
      // nothing spent, nothing filed.
      const sent = await call(agent, 'create_pcp_task', { narrative: words, callerStatedARequest: false });
      expect(sent.error).toBe('no_request_try_handoff');
      expect(sent.noRequestAsk).toBe('handoff');
      expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    }
    const r = await call(agent, 'handoff_to_pcp', { narrative: words, callerStatedARequest: false });
    expect(r.error, 'the queue choice is the transfer being offered').toBe('queue_choice');
    expect(ticketing.createPcpTicket, 'no refused-transfer fallback was filed').not.toHaveBeenCalled();
    pcpDirector.clear(row.sid);
  });

  // Codex P1 on #452: a caller who declines the queue chose a message, so the
  // filing asks what it is about instead of sending them back to the transfer.
  it('an office that declines the queue is asked what it needs, not sent back to the transfer', async () => {
    const row = offices[0];
    const { agent, fields } = setUp(row);
    await call(agent, 'record_pcp_intake', { ...fields, callPurpose: row.purpose });
    const offered = await call(agent, 'handoff_to_pcp', { narrative: PERSON_WORDS[0], callerStatedARequest: false });
    expect(offered.error).toBe('queue_choice');
    const declined = await call(agent, 'handoff_to_pcp', {
      narrative: PERSON_WORDS[0],
      callerAcceptedQueue: false,
      callerStatedARequest: false,
    });
    expect(declined.error).toBe('queue_choice_declined');
    const filing = await call(agent, 'create_pcp_task', { narrative: PERSON_WORDS[0], callerStatedARequest: false });
    expect(filing.error, 'not sent back to handoff_to_pcp').not.toBe('no_request_try_handoff');
    expect(filing.refused).toBe('no_request_stated');
    expect(filing.noRequestAsk).toBe('ask');
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
    pcpDirector.clear(row.sid);
  });
});

describe('what stays as it was', () => {
  const lunch = CORPUS.find((r) => r.sid === 'CAba3cb3dade3eff540aeb07966a887d72')!;

  it('a refused transfer whose caller stated a request still files it', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    const r = await call(agent, 'handoff_to_pcp', {
      narrative: 'Caller asked to speak with the staff about a referral status.',
      callerStatedARequest: true,
    });
    expect(r.error).toBe('handoff_not_eligible_task_created');
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    pcpDirector.clear(lunch.sid);
  });

  it('a filing that does not answer the question files as before', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    const r = await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked to speak with the staff.' });
    expect(r.error).toBe('handoff_not_eligible_task_created');
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    pcpDirector.clear(lunch.sid);
  });

  it('a create_pcp_task that does not answer the question files as before', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    const r = await call(agent, 'create_pcp_task', { narrative: 'Caller asked about a referral status.' });
    expect(r.refused).not.toBe('no_request_stated');
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    pcpDirector.clear(lunch.sid);
  });

  it('a call that already filed is not blocked by a later false (the enrichment re-file)', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Caller asked about a referral status.', callerStatedARequest: true });
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const again = await call(agent, 'create_pcp_task', { narrative: 'Caller asked to speak with the staff.', callerStatedARequest: false });
    expect(again.refused).not.toBe('no_request_stated');
    pcpDirector.clear(lunch.sid);
  });

  it('two filings in one response are one ask, not the ask spent', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    const a = await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    vi.setSystemTime(new Date(at(lunch.pt).getTime() + 500));
    const b = await call(agent, 'create_pcp_task', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    expect([a.noRequestAsk, b.noRequestAsk]).toEqual(['ask', 'ask']);
    expect(pcpDirector.next(lunch.sid).mayTerminate).toBe(false);
    pcpDirector.clear(lunch.sid);
  });

  // Codex P2 on #452: the ask must not outlive the caller's answer to it.
  it('a request stated after the ask is still the floor\'s to file when its filing fails', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    const asked = await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    expect(asked.noRequestAsk).toBe('ask');
    vi.setSystemTime(new Date(at(lunch.pt).getTime() + NO_REQUEST_BATCH_WINDOW_MS + 5_000));
    ticketing.createPcpTicket.mockResolvedValueOnce({ success: false, error: 'upstream 500' });
    await call(agent, 'create_pcp_task', {
      narrative: 'Caller asked about a referral status for a mutual patient.',
      callerStatedARequest: true,
    });
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    expect(pcpDirector.next(lunch.sid).mayTerminate, 'a stated request is not a spent ask').toBe(false);
    await sweepPcpUnfiledCall(lunch.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket, 'the floor files what the caller said after the ask').toHaveBeenCalledTimes(2);
  });

  it('a stated request after a spent ask means the call may not end until it is filed', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    await call(agent, 'create_pcp_task', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    vi.setSystemTime(new Date(at(lunch.pt).getTime() + NO_REQUEST_BATCH_WINDOW_MS + 5_000));
    const spent = await call(agent, 'create_pcp_task', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    expect(spent.noRequestAsk).toBe('spent');
    expect(pcpDirector.next(lunch.sid).mayTerminate).toBe(true);
    ticketing.createPcpTicket.mockResolvedValueOnce({ success: false, error: 'upstream 500' });
    await call(agent, 'handoff_to_pcp', {
      narrative: 'Caller asked to speak with the staff about a referral status.',
      callerStatedARequest: true,
    });
    expect(pcpDirector.next(lunch.sid).mayTerminate).toBe(false);
    pcpDirector.clear(lunch.sid);
  });

  it('a new purpose recorded after the ask is the caller answering it: the floor files', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    await call(agent, 'record_pcp_intake', { callPurpose: 'outside_referral_status', patientFirstName: 'Test', patientLastName: 'Patient' });
    await sweepPcpUnfiledCall(lunch.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket, 'what they said after the ask is a request').toHaveBeenCalledTimes(1);
  });

  it('the same purpose, or only a name, recorded after the ask does not answer it', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    await call(agent, 'handoff_to_pcp', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry', patientFirstName: 'Test', patientLastName: 'Patient' });
    await sweepPcpUnfiledCall(lunch.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('a first purpose recorded after the ask does not answer it (it can be the catch-all)', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE });
    await call(agent, 'create_pcp_task', { narrative: 'Caller asked for the staff.', callerStatedARequest: false });
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });
    await sweepPcpUnfiledCall(lunch.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket).not.toHaveBeenCalled();
  });

  it('the floor still files a caller who gave their name and purpose and was cut off by us', async () => {
    const { agent } = setUp(lunch);
    await call(agent, 'record_pcp_intake', { ...OFFICE, callPurpose: 'service_inquiry' });
    await sweepPcpUnfiledCall(lunch.sid, { outcome: 'dead_air' } as never);
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
  });
});

describe('the model is asked, every time', () => {
  it('both filing tools require callerStatedARequest on the wire, with its description', () => {
    vi.setSystemTime(at('09:00'));
    const agent = agentFor('CAwire204000000000000000000000000') as any;
    for (const name of ['create_pcp_task', 'handoff_to_pcp']) {
      const t = agent.tools.find((x: any) => x.name === name);
      const params = t.parameters as { required?: string[]; properties: Record<string, any> };
      expect(params.required, name).toContain('callerStatedARequest');
      expect(params.properties.callerStatedARequest.description).toMatch(/asked for is a person/);
    }
    pcpDirector.clear('CAwire204000000000000000000000000');
  });

  it('the three lines claim no record and tell nobody to call back', () => {
    for (const key of ['handoff_not_eligible_no_request', 'no_request_stated', 'no_request_stated_spent']) {
      const say = PCP_REFUSALS[key].say ?? '';
      expect(say, key).toBeTruthy();
      expect(say, key).not.toMatch(/taken this down|call back|follow up/i);
    }
  });
});

describe('the words offices use for a person', () => {
  it.each([
    'asked to speak to a staff member',
    'Caller wants to speak to a provider.',
    'Caller asked to speak with a nurse.',
    'Caller would like to speak to a department.',
    'Caller is requesting customer service.',
    'Caller asked for the doctor.',
    'Caller asked to speak with a medical assistant.',
    'Caller asked to transfer to the nurse.',
    'Caller asked to transfer the call over to the front desk.',
    'Caller wants us to transfer her directly to the provider.',
  ])('"%s" is an ask', (words) => {
    expect(asksForAPerson(words)).toBe(true);
  });

  it.each([
    'Caller is a nurse at the clinic.',
    'Caller did not ask for a provider.',
    'Caller needs a doctor\'s note.',
    'Requested by Tanya, doctor.',
    'Caller requesting provider notes.',
    'Third-party request (provider).',
    'Patient needs to see an eye doctor.',
    // Codex P2 on #452: a document being moved is not the caller being moved.
    'Caller requested to transfer records to the provider.',
    'Caller asked to transfer her records to the doctor.',
    'Caller requested to transfer records to the office.',
  ])('"%s" is not', (words) => {
    expect(asksForAPerson(words)).toBe(false);
  });
});
