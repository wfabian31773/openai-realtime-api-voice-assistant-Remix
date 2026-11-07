/**
 * v186 — THE AFTER-HOURS LINE ASKS FOR THE OFFICE OR THE SURGEON ONCE.
 *
 * /submit-ticket refuses an Optical request with no office and a Surgery
 * request with no surgeon. Until now it refused on every attempt, and the
 * agent's create_ticket handed each refusal back as a fresh question, so a
 * caller who did not know was asked again and again. Measured in
 * voice_agent_api_logs over the 14 days to 2026-11-06: 9 no-ivr calls, 26
 * refused POSTs; 3 were told the system had a technical issue; 4 were filed
 * only by the teardown floor after the caller had hung up; 1 has no ticket of
 * any provenance. The corpus is below, by real call SID; the transcripts stay on
 * disk (RULE THREE) and the stand-ins here are synthetic.
 *
 * Driven at the REAL agent (createNoIvrAgent, the tool invoked as the SDK
 * invokes it), with the sink mocked at its boundary, so what is pinned is the
 * payload create_ticket hands the sink and the line it hands the model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(
    async (_p: Record<string, unknown>): Promise<Record<string, unknown>> => ({ success: true, ticketNumber: 'VA-TEST' }),
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
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent, ROUTING_ASK_BATCH_WINDOW_MS } = await import('./noIvrAgent');
const { resetDobHistory } = await import('../tools/dobEscape');
const { resetGateAttempts } = await import('../tools/gateAttempts');

type Field = 'surgeon name' | 'location';
interface Case { sid: string; field: Field; refusedPosts: number; ticket: 'agent' | 'floor' | 'none' }

/** The 9 calls of 2026-10-24..11-06, refused for a routing field on /submit-ticket. */
const CORPUS: readonly Case[] = [
  { sid: 'CAa0bdf3a5f68c1c070798f6996db11226', field: 'surgeon name', refusedPosts: 6, ticket: 'floor' },
  { sid: 'CA9b02ea2cd46b91e03e055f382acb5f82', field: 'surgeon name', refusedPosts: 6, ticket: 'floor' },
  { sid: 'CA8cfc7ec2f7b03273ee3985cfac10b118', field: 'surgeon name', refusedPosts: 3, ticket: 'agent' },
  { sid: 'CAbeed2bfb4f8c7b46aa924bb0ebf1d80b', field: 'surgeon name', refusedPosts: 1, ticket: 'agent' },
  // The "not found" wording: told a technical issue, no ticket of any kind.
  { sid: 'CA93323bf5677ec2d8fad28ff0c014f0b1', field: 'surgeon name', refusedPosts: 1, ticket: 'none' },
  { sid: 'CA1a3dc7293c5ded9b631f6bc301a6b7a4', field: 'location', refusedPosts: 4, ticket: 'floor' },
  { sid: 'CA13a8916ca7363fb21403d2501fb3de2a', field: 'location', refusedPosts: 1, ticket: 'agent' },
  { sid: 'CA1089891528132abaa7c2cedbdb34122c', field: 'location', refusedPosts: 3, ticket: 'floor' },
  { sid: 'CA012ff09fc397df5cd29cac805b2bebfd', field: 'location', refusedPosts: 1, ticket: 'agent' },
];

/** The sink's refusal, as submitSimplifiedTicket hands it to the agent. */
const SINK_REFUSAL = (field: Field) => ({
  success: false,
  error: `Missing required information: ${field}`,
  message: 'I need to collect more information.',
});

/** The generic branch's own copy — what three of these callers heard. */
const THE_APOLOGY = /FAILED to submit|Apologize sincerely|experiencing a technical issue on my end/i;

async function call(agent: any, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === 'create_ticket');
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const request = (field: Field) => ({
  first_name: 'Test',
  last_name: 'Sample',
  date_of_birth: '01/04/1958',
  location: '',
  callback_number: '5551234567',
  request_category: field === 'location' ? 'optical_request' : 'general_question',
  request_summary: field === 'location' ? 'Asking about the status of a glasses order.' : 'A question about surgery aftercare.',
  preferred_contact: 'phone',
});

/** One refusal, then whatever the second answer is. */
function refuseOnceThen(field: Field, then: Record<string, unknown> = { success: true, ticketNumber: 'VA-TEST' }) {
  h.submitSimplifiedTicket.mockImplementationOnce(async () => SINK_REFUSAL(field));
  h.submitSimplifiedTicket.mockImplementationOnce(async () => then);
}

beforeEach(() => {
  resetDobHistory();
  resetGateAttempts();
  h.submitSimplifiedTicket.mockReset();
  h.submitSimplifiedTicket.mockImplementation(async () => ({ success: true, ticketNumber: 'VA-TEST' }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T03:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('v186 — the corpus: asked once, then filed', () => {
  it.each(CORPUS.map((c) => [c.sid, c] as const))('%s', async (sid, c) => {
    const agent = await createNoIvrAgent(async () => {}, { callId: `call-${sid}`, callSid: sid });
    refuseOnceThen(c.field);

    const first = await call(agent, request(c.field));
    expect(first.success).toBe(false);
    expect(first.validation_errors).toEqual([c.field]);
    expect(first.message).toMatch(/ONCE/);
    expect(first.message).toMatch(/do not know it, that is fine/);
    expect(first.message).not.toMatch(THE_APOLOGY);
    expect(h.submitSimplifiedTicket.mock.calls[0][0].routingAskExhausted).toBeUndefined();

    // The caller is asked; their answer comes a turn later.
    vi.setSystemTime(Date.now() + ROUTING_ASK_BATCH_WINDOW_MS + 1_000);
    const second = await call(agent, request(c.field));
    expect(second.success).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(2);
    expect(h.submitSimplifiedTicket.mock.calls[1][0].routingAskExhausted).toBe(true);
  });
});

describe('v186 — the flag is the agent’s record, not a guess', () => {
  it('a call with no routing refusal never sends it', async () => {
    const sid = 'CA0000000000000000000000000000a186';
    const agent = await createNoIvrAgent(async () => {}, { callId: `call-${sid}`, callSid: sid });
    await call(agent, request('surgeon name'));
    expect(h.submitSimplifiedTicket.mock.calls[0][0].routingAskExhausted).toBeUndefined();
  });

  it('a sibling in the same model response is not a later turn, and does not send it', async () => {
    const sid = 'CA0000000000000000000000000000b186';
    const agent = await createNoIvrAgent(async () => {}, { callId: `call-${sid}`, callSid: sid });
    h.submitSimplifiedTicket.mockImplementation(async () => SINK_REFUSAL('surgeon name'));
    await call(agent, request('surgeon name'));
    vi.setSystemTime(Date.now() + 200);
    const sibling = await call(agent, request('surgeon name'));
    expect(h.submitSimplifiedTicket.mock.calls[1][0].routingAskExhausted).toBeUndefined();
    expect(sibling.message).not.toMatch(THE_APOLOGY);
  });

  it('a refusal for another field spends nothing', async () => {
    const sid = 'CA0000000000000000000000000000c186';
    const agent = await createNoIvrAgent(async () => {}, { callId: `call-${sid}`, callSid: sid });
    h.submitSimplifiedTicket.mockImplementationOnce(async () => ({
      success: false, error: 'Missing required information: patientPhone', message: 'I need more.',
    }));
    await call(agent, request('surgeon name'));
    vi.setSystemTime(Date.now() + 10_000);
    await call(agent, request('surgeon name'));
    expect(h.submitSimplifiedTicket.mock.calls[1][0].routingAskExhausted).toBeUndefined();
  });

  it('refused even with the flag (the app not yet deployed): the answer is today’s, never the apology', async () => {
    const sid = 'CA0000000000000000000000000000d186';
    const agent = await createNoIvrAgent(async () => {}, { callId: `call-${sid}`, callSid: sid });
    h.submitSimplifiedTicket.mockImplementation(async () => SINK_REFUSAL('location'));
    await call(agent, request('location'));
    vi.setSystemTime(Date.now() + 10_000);
    const again = await call(agent, request('location'));
    expect(h.submitSimplifiedTicket.mock.calls[1][0].routingAskExhausted).toBe(true);
    expect(again.success).toBe(false);
    expect(again.validation_errors).toEqual(['location']);
    expect(again.message).not.toMatch(THE_APOLOGY);
  });
});
