/**
 * THE MEDICATION NAME IS ASKED FOR ONCE, AND THEN THE REQUEST FILES (v112).
 *
 * `gateBeforeExecution` (toolDirection.ts) refused `create_ticket` whenever the
 * arguments said "refill" or "medication" and no name in its short drug list
 * matched — with no count, so it refused the same request on every attempt for
 * the life of the call. The refusal returns before the agent's recorder runs,
 * so none of it reached `tool_timeline`.
 *
 * THE CORPUS (RULE THREE), after-hours line, the 30 days to 2026-10-22: every
 * call that asked for the medication name and ended with NO ticket of any
 * provenance (checked by call SID in the Support Center). Fourteen calls, nine
 * told the team would call them back, worst asked 19 times. Below, each real
 * SID with a SYNTHETIC stand-in for the request the model wrote — the drug
 * names are the ones the callers gave, which name no person; no caller's name,
 * date of birth or number is here.
 *
 * Driven through the REAL agent (`createNoIvrAgent`, the tool invoked the way
 * the SDK invokes it): the gate lives in a wrapper the agent puts around its
 * tools, and a test of the wrapper alone would not prove this lane wraps them
 * (failure mode 10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(
    async (_p: Record<string, unknown>): Promise<Record<string, unknown>> => ({
      success: true,
      ticketNumber: 'VA-TEST',
    }),
  ),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: {
    getCallerMemory: async () => null,
    buildContextForPrompt: () => '',
  },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { MEDICATION_GATE_REFUSAL, MEDICATION_ASK_LIMIT } = await import('../services/toolDirection');
const { getAzulTimeline } = await import('../services/toolTimeline');
const { resetDobHistory } = await import('../tools/dobEscape');
const { resetGateAttempts } = await import('../tools/gateAttempts');

let n = 0;
const freshSid = () => `CA${(0xa11ce000 + ++n).toString(16).padStart(32, '0')}`;

async function agentFor(callSid: string) {
  return createNoIvrAgent(async () => {}, { callId: `call-${callSid}`, callSid });
}

/** The gate answers with a plain string; the handler answers with JSON. */
async function invoke(agent: any, args: Record<string, unknown>): Promise<{ refused: boolean; raw: unknown }> {
  const t = agent.tools.find((x: any) => x.name === 'create_ticket');
  expect(t, 'create_ticket is not on the agent').toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return { refused: typeof raw === 'string' && raw === MEDICATION_GATE_REFUSAL, raw };
}

/** A synthetic refill request. */
const refill = (summary: string, over: Record<string, unknown> = {}) => ({
  first_name: 'Ana',
  last_name: 'Example',
  date_of_birth: '01/04/1958',
  location: 'Synthetic Clinic', // Complete live intake before testing this lane.
  callback_number: '5551234567',
  request_category: 'medication_refill',
  request_summary: summary,
  preferred_contact: 'phone',
  ...over,
});

/**
 * Each corpus call: its real SID, how many times it was asked on the day, and
 * a synthetic stand-in for the request. `named` is whether the caller had said
 * the drug's name — the gate's list knew none of these.
 */
const CORPUS: Array<{ sid: string; askedOnTheDay: number; summary: string; shape: 'named' | 'unknown' | 'contact_lens' }> = [
  { sid: 'CA05daa62fd6c7156a322ea4810d590923', askedOnTheDay: 10, summary: 'Needs a refill of Betoptic eye drops.', shape: 'named' },
  { sid: 'CA4adf6a1a3b45a076b20f750250c5de3c', askedOnTheDay: 10, summary: 'Medication refill: Lumigan, sent to the usual pharmacy.', shape: 'named' },
  { sid: 'CAf075812601e0bf65857d35c0d8c466d5', askedOnTheDay: 19, summary: 'Refill of Alphagan 0.1% eye drops.', shape: 'named' },
  { sid: 'CA8b9a374d81810f650871abe9ba608930', askedOnTheDay: 4, summary: 'Refill of cyclosporine 0.05%.', shape: 'named' },
  { sid: 'CAa825ae7e3c495bee202f9a780d6d0699', askedOnTheDay: 3, summary: 'Refill of Cosopt drops.', shape: 'named' },
  { sid: 'CA5ca84823816bbd4f1653a057113f1687', askedOnTheDay: 4, summary: 'Refill of fluorometholone drops.', shape: 'named' },
  { sid: 'CAbd3d0cbc9e6dc6eed2707f682bcc1a58', askedOnTheDay: 12, summary: 'Refill of prednisone.', shape: 'named' },
  { sid: 'CA901dfdae0c21ced9bbc9a8215099f8f2', askedOnTheDay: 3, summary: 'Refill of doxycycline.', shape: 'named' },
  { sid: 'CA307827d708899015406582b5ddac3b61', askedOnTheDay: 2, summary: 'Refill of sodium chloride liquid eye drops.', shape: 'named' },
  { sid: 'CA5a3fc78884408b69bfd0bdee30a8cef4', askedOnTheDay: 10, summary: 'Refill of eye drops the caller spelled as Tredniflone.', shape: 'named' },
  { sid: 'CA9fe1f8adc1fa8717c09143562686cddd', askedOnTheDay: 9, summary: 'Refill of the twice-a-day eye drop; the caller cannot pronounce the name.', shape: 'unknown' },
  { sid: 'CA1ea885702a6ff014ef4394696ee1c20a', askedOnTheDay: 7, summary: 'Refill of the eye drops prescribed on Wednesday; the caller does not know the name.', shape: 'unknown' },
  { sid: 'CA926f2b0f7b68e4118fbc5f9bf9624538', askedOnTheDay: 7, summary: 'Medication refill of Alcon eye drops; name not known.', shape: 'unknown' },
  { sid: 'CA2bb48e02022fdbd4759bcff27202f58f', askedOnTheDay: 2, summary: 'One-month contact lens refill; five lenses left, appointment in a month.', shape: 'contact_lens' },
];

beforeEach(() => {
  resetDobHistory();
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
});

describe('the corpus: every call files, and none is asked more than once', () => {
  it('is the 14 calls of the 30 days to 2026-10-22, each a canonical SID', () => {
    expect(CORPUS).toHaveLength(14);
    for (const c of CORPUS) expect(c.sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(Math.max(...CORPUS.map((c) => c.askedOnTheDay))).toBe(19);
    expect(MEDICATION_ASK_LIMIT).toBe(1);
  });

  for (const c of CORPUS) {
    it(`${c.sid} (${c.shape}, asked ${c.askedOnTheDay}x on the day) files within ${c.shape === 'contact_lens' ? 'one attempt' : 'two attempts'}`, async () => {
      const agent = await agentFor(c.sid);
      // The model on the day called create_ticket once per ask; give it as
      // many tries as the caller was asked, and count the refusals.
      let refusals = 0;
      let filedOn = 0;
      for (let attempt = 1; attempt <= c.askedOnTheDay && !filedOn; attempt++) {
        const r = await invoke(agent, refill(c.summary));
        if (r.refused) refusals++;
        else filedOn = attempt;
      }
      expect(filedOn, 'the request never filed — the gate is still unbounded').toBeGreaterThan(0);
      expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
      if (c.shape === 'contact_lens') {
        // A contact lens is not a medication: the drug question is never asked.
        expect(refusals).toBe(0);
        expect(filedOn).toBe(1);
      } else {
        expect(refusals).toBe(1);
        expect(filedOn).toBe(2);
      }
    });
  }
});

describe('what the refusal tells the model', () => {
  it('says not to re-ask a caller who already named it, to ask at most once, and that the next attempt files', () => {
    expect(MEDICATION_GATE_REFUSAL).toMatch(/ALREADY said the name of the medication, do not ask again/);
    expect(MEDICATION_GATE_REFUSAL).toMatch(/Which medication do you need refilled\?/);
    expect(MEDICATION_GATE_REFUSAL).toMatch(/call create_ticket again anyway; it will file without it/);
    expect(MEDICATION_GATE_REFUSAL).toMatch(/Never ask for the medication name a second time/);
    // Never a failure: an apology here is what tells a caller nothing will happen.
    expect(MEDICATION_GATE_REFUSAL).toMatch(/NOT a system error/);
  });
});

describe('the refusal is countable', () => {
  it('lands on the call’s tool timeline as a refused create_ticket, and the filing after it too', async () => {
    const sid = freshSid();
    const agent = await agentFor(sid);
    await invoke(agent, refill('Refill of Betoptic eye drops.'));
    await invoke(agent, refill('Refill of Betoptic eye drops.'));

    const events = (getAzulTimeline(`call-${sid}`) ?? []).filter((e) => e.tool === 'create_ticket');
    expect(events, 'the refusal never reached tool_timeline').toHaveLength(2);
    expect(events[0]!.outcome).toMatchObject({ success: false, refused: 'medication_name', missingFields: ['medication'] });
    expect(events[1]!.outcome).toMatchObject({ success: true });
  });
});

describe('what does not change', () => {
  it('a drug the list knows files on the first attempt', async () => {
    const agent = await agentFor(freshSid());
    expect((await invoke(agent, refill('Refill of latanoprost.'))).refused).toBe(false);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('a request that is not a refill is never asked', async () => {
    const agent = await agentFor(freshSid());
    const r = await invoke(agent, refill('Wants to move next week’s appointment.', { request_category: 'reschedule_appointment' }));
    expect(r.refused).toBe(false);
  });

  it('the ask is per call — a second caller with the same request is asked once too', async () => {
    const a = await agentFor(freshSid());
    const b = await agentFor(freshSid());
    expect((await invoke(a, refill('Refill of Cosopt drops.'))).refused).toBe(true);
    expect((await invoke(b, refill('Refill of Cosopt drops.'))).refused).toBe(true);
  });
});
