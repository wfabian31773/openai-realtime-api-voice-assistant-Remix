/**
 * A DONE PCP INTAKE NAMES THE NEXT STEP, AND THE TICKET'S GAP LIST STAYS OFF
 * THE MODEL'S REPLY.
 *
 * The corpus is every PCP call of 30 s or more on 2026-10-30, 11-02 and 11-03
 * that reached the end of the intake (`record_pcp_intake` answered with no
 * next question), never called create_pcp_task, the records tool,
 * handoff_to_pcp or record_automated_resolution, was not transferred and left
 * no ticket: 32 calls. On 25 of them the agent asked the caller's title or
 * email address before anything was filed, and every one of the 32 ended in
 * the caller hanging up.
 *
 * The 25 are below, by real call SID, with the call purpose the model
 * recorded and whether the director first asked for the patient. Names,
 * organisations and numbers here are synthetic; the transcripts are in
 * `call_logs`, never in git.
 *
 * Two causes, both pinned:
 *   1. `record_pcp_intake` returned the director's whole decision, so the
 *      model received `intakeMissing` (v155), which names `callerRole` and
 *      `callerEmail` — the two fields `ENRICHMENT_AFTER_FILING` holds back
 *      until a request is filed.
 *   2. With no next question and nothing on record, the reply named no next
 *      step. On an AUTOMATE purpose that is a dead end.
 *
 * What these tests can and cannot show: they prove the reply the model gets.
 * Whether the model then files instead of asking is the after-number, read
 * from production (see the PR).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const NOT_LUNCH = new Date('2026-11-03T18:00:00Z'); // Tue 10:00 PST
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
  createPcpTicket: vi.fn(async (_payload: any) => ({ success: true, ticketNumber: 'PCP-80001' })),
  createTicket: vi.fn(async () => ({ success: true, ticketNumber: 'VA-1' })),
  withdrawPcpTickets: vi.fn(async () => ({ success: true, withdrawn: [], kept: [] })),
}));
vi.mock('../../server/services/ticketingApiClient', () => ({ ticketingApiClient: ticketing }));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');
const { recordToolEvent, getAzulTimeline } = await import('../services/toolTimeline');
const { FILING_LINE } = await import('./intakeNextStep');

async function call(agent: any, name: string, args: Record<string, unknown> = {}) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** Synthetic. The real calls had a dialable caller ID, which seeds the callback number. */
const CALLER_PHONE = '+19515550123';
const CALLER = { callerName: 'Sam Example', callerOrganization: 'Example Medical Group' };
const PATIENT = { patientFirstName: 'Pat', patientLastName: 'Sample' };

function agentFor(callId: string) {
  return createPcpAgent((async () => ({ ok: true })) as never, { callId, callerPhone: CALLER_PHONE } as never);
}

/**
 * The 25 calls that were asked their title or email with nothing filed.
 * `patient` is true when the purpose requires the patient's name first, so the
 * director asked for it before running out of questions.
 */
const ASKED_CREDENTIALS_FIRST: Array<{ sid: string; purpose: string; patient?: true }> = [
  { sid: 'CA1fd84fc5dcbedd6cbf83ce53377fa0c2', purpose: 'service_inquiry' },
  { sid: 'CA2e6fbb725a65573223ef9343671de422', purpose: 'service_inquiry' },
  { sid: 'CAef5840adb151d7d448688ac7fe613ca8', purpose: 'service_inquiry' },
  { sid: 'CA7af7679fd7eff8f35a848c51a7c9615f', purpose: 'service_inquiry' },
  { sid: 'CA812614b188051358eec3cc396ab868e2', purpose: 'outside_referral_status', patient: true },
  { sid: 'CA571ee331538a7e35c50e6c86d40ec723', purpose: 'service_inquiry' },
  { sid: 'CA538880a6c7832bc614ea9b5ceaad4bc2', purpose: 'service_inquiry' },
  { sid: 'CA68d47de4a4b371f8c8ffb43126a42964', purpose: 'provider_information' },
  { sid: 'CA516c5d3743f2ae8449445d15f1e91036', purpose: 'service_inquiry' },
  { sid: 'CA7f98a743513ad105c04370da38a75723', purpose: 'service_inquiry' },
  { sid: 'CA45d88fe77a30de5d0f8cacb59a81906e', purpose: 'service_inquiry' },
  { sid: 'CA063e868429ab0c7ca0db64debf4c7eb3', purpose: 'service_inquiry' },
  { sid: 'CA953f262316135288d1bed0b1f66516c8', purpose: 'service_inquiry' },
  { sid: 'CA12155947a4455f502ba1399f3c9b36cd', purpose: 'service_inquiry' },
  { sid: 'CA124eda6cbdd1aee6cddadef1f4043cd7', purpose: 'check_patient_scheduled', patient: true },
  { sid: 'CA9a3dc57f6e018354cead634cafb773b8', purpose: 'service_inquiry' },
  { sid: 'CAc5fbd345f4303708e0b3ee82b9161bd9', purpose: 'provider_information' },
  { sid: 'CAbf26be76d2044e7849a9e99356d3cb82', purpose: 'service_inquiry' },
  { sid: 'CA6a3b7f463e1da0c1d7595552d7d1bbd0', purpose: 'service_inquiry' },
  { sid: 'CAcedcb0895b426bc2d90ea4a3fa3a1f8b', purpose: 'service_inquiry' },
  { sid: 'CA078a943dc6c369314c2f7670b2c06017', purpose: 'provider_information' },
  { sid: 'CAbf0215fabdc8a45e62825921a2d411e5', purpose: 'check_patient_scheduled', patient: true },
  { sid: 'CAacde4907771d2334cbf5295b72ce713b', purpose: 'service_inquiry' },
  { sid: 'CAea18922dfdc8e9973fc7b26156869a76', purpose: 'service_inquiry' },
  { sid: 'CAe6ec4a2c0ff1196c65bd63b88d3c7433', purpose: 'service_inquiry' },
];

/** Run the intake the way the corpus call did, up to the reply with no next question. */
async function intakeToTheEnd(sid: string, purpose: string, patient?: boolean) {
  const agent = agentFor(sid);
  const first = await call(agent, 'record_pcp_intake', { callPurpose: purpose });
  expect(first.nextQuestion?.field, `${sid}: the first reply asks who is calling`).toBe('callerName');
  const done = await call(agent, 'record_pcp_intake', { ...CALLER, ...(patient ? PATIENT : {}) });
  return { agent, done };
}

beforeEach(() => {
  ticketing.createPcpTicket.mockClear();
});

describe('the 25 corpus calls: what the model is handed when the intake runs out of questions', () => {
  it.each(ASKED_CREDENTIALS_FIRST)('$sid ($purpose): no gap list, and a named next step', async ({ sid, purpose, patient }) => {
    const { done } = await intakeToTheEnd(sid, purpose, patient);
    expect(done.nextQuestion, 'the intake has nothing more to ask').toBeUndefined();
    expect(done.intakeMissing, 'the ticket-only gap list does not reach the model').toBeUndefined();
    const json = JSON.stringify(done);
    expect(json, 'no reply field names the title the director holds back').not.toContain('callerRole');
    expect(json, 'no reply field names the email the director holds back').not.toContain('callerEmail');
    expect(done.nextStep).toBe('connect_answer_or_file');
    expect(done.guidance).toContain('Do not ask for their title, role or email address now');
    expect(done.guidance).toContain('call create_pcp_task');
    expect(done.guidance).toContain('call handoff_to_pcp');
    expect(done.guidance).toContain(FILING_LINE);
  });

  it('the director still holds the title and email back, so they remain on the ticket gap list', () => {
    // The fix changes the model's reply, not the director: `ticketState()`
    // still reads `intakeMissing` from `next()`.
    const sid = 'CAacde4907771d2334cbf5295b72ce713b';
    expect(pcpDirector.next(sid).intakeMissing).toEqual(expect.arrayContaining(['callerRole', 'callerEmail']));
  });
});

describe('the next step fits the purpose', () => {
  it('a knowledge-base purpose may answer from get_public_practice_information', async () => {
    const { done } = await intakeToTheEnd('CAkb00000000000000000000000000001', 'service_inquiry');
    expect(done.guidance).toContain('get_public_practice_information');
    expect(done.guidance).toContain('record_automated_resolution');
  });

  it('a scheduling purpose may answer from lookup_patient_appointments', async () => {
    const { done } = await intakeToTheEnd('CAsc00000000000000000000000000001', 'check_patient_scheduled', true);
    expect(done.guidance).toContain('lookup_patient_appointments');
    expect(done.guidance).toContain('record_automated_resolution');
  });

  it('a purpose that cannot be automated is offered no lookup, only connect or file', async () => {
    const { done } = await intakeToTheEnd('CAor00000000000000000000000000001', 'outside_referral_status', true);
    expect(done.guidance).not.toContain('record_automated_resolution');
    expect(done.guidance).toContain('call create_pcp_task');
  });

  it('a patient is told to file, never to try a transfer', async () => {
    const agent = agentFor('CApt00000000000000000000000000001');
    await call(agent, 'record_pcp_intake', { callPurpose: 'patient_caller' });
    const done = await call(agent, 'record_pcp_intake', { callerName: 'Sam Example' });
    expect(done.nextQuestion).toBeUndefined();
    expect(done.nextStep).toBe('file');
    expect(done.guidance).toContain('call create_pcp_task');
    expect(done.guidance).not.toContain('handoff_to_pcp');
  });
});

describe('the next step is named only at the dead end', () => {
  it('not while the intake still has a question', async () => {
    const agent = agentFor('CAq000000000000000000000000000001');
    const first = await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });
    expect(first.nextQuestion?.field).toBe('callerName');
    expect(first.nextStep).toBeUndefined();
    expect(first.guidance).toBeUndefined();
    expect(first.intakeMissing, 'the gap list is off every reply, not only the last').toBeUndefined();
  });

  it('not once a request is on record: the enrichment questions are create_pcp_task\'s to hand over', async () => {
    const { agent } = await intakeToTheEnd('CAf000000000000000000000000000001', 'service_inquiry');
    const filed = await call(agent, 'create_pcp_task', { narrative: 'Caller asked about a referral.' });
    expect(filed.success).toBe(true);
    const after = await call(agent, 'record_pcp_intake', { callerRole: 'Referral coordinator' });
    expect(after.nextStep).toBeUndefined();
    expect(after.guidance).toBeUndefined();
    // And with nothing left to ask at all: the request is on record, so there
    // is no dead end to name a step for.
    const last = await call(agent, 'record_pcp_intake', { callerEmail: 'desk@example.org' });
    expect(last.nextQuestion).toBeUndefined();
    expect(last.nextStep).toBeUndefined();
    expect(last.guidance).toBeUndefined();
  });

  it('not once the director has granted a transfer: the prompt\'s transfer rules take that', async () => {
    const sid = 'CAh000000000000000000000000000001';
    const agent = agentFor(sid);
    await call(agent, 'record_pcp_intake', { callPurpose: 'service_inquiry' });
    pcpDirector.markCallerRequestedHuman(sid);
    const done = await call(agent, 'record_pcp_intake', CALLER);
    expect(done.handoffEligible).toBe(true);
    expect(done.nextStep).toBeUndefined();
  });

  it('a filing made at the dead end still carries the title and email as gaps for staff', async () => {
    const { agent } = await intakeToTheEnd('CAg000000000000000000000000000001', 'service_inquiry');
    await call(agent, 'create_pcp_task', { narrative: 'Caller asked about a referral.' });
    expect(ticketing.createPcpTicket).toHaveBeenCalledTimes(1);
    const narrative = String(ticketing.createPcpTicket.mock.calls[0][0].narrative);
    expect(narrative).toContain('Intake incomplete');
    expect(narrative).toContain('caller role');
  });
});

describe('the timeline counts it by a fixed code', () => {
  function recorded(outcome: Record<string, unknown>) {
    const callId = `CAtl${Math.random().toString(16).slice(2, 12)}`;
    recordToolEvent(callId, 'record_pcp_intake', {}, JSON.stringify(outcome), 1, { agentSlug: 'pcp' });
    const [ev] = getAzulTimeline(callId)!;
    return ev.outcome as Record<string, unknown>;
  }

  it('keeps the nextStep code beside the intake verdict', () => {
    const out = recorded({
      mayTerminate: false,
      handoffEligible: false,
      disposition: 'AUTOMATE',
      nextStep: 'connect_answer_or_file',
      guidance: 'The intake has nothing more to ask before this request is handled.',
    });
    expect(out.nextStep).toBe('connect_answer_or_file');
    expect(out.nextField).toBeNull();
    expect(out.disposition).toBe('AUTOMATE');
  });

  it('refuses any other nextStep value', () => {
    expect(recorded({ mayTerminate: false, nextStep: 'anything' }).nextStep).toBeUndefined();
  });
});
