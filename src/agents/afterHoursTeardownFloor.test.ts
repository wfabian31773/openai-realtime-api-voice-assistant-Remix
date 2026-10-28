import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { LiveTool } from '../runtime/agentBinding';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

const h = vi.hoisted(() => ({
  getCallLogBySid: vi.fn(),
  submitSimplifiedTicket: vi.fn(),
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: h.submitSimplifiedTicket,
    createTicketFromAgentInput: async () => ({ success: true, ticketNumber: 'VA-SYNTHETIC' }),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [] }),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { defaultLaneSource } = await import('../runtime/laneRegistry');
const { runLaneTeardownFloor } = await import('../runtime/pcpFloor');
const { recordToolEvent } = await import('../services/toolTimeline');

it('the live SIP route uses the same registered floor before releasing its transcript', () => {
  const route = readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8');
  const teardown = route.slice(route.indexOf("console.info(`[SESSION] Call ${callId} ended"));
  expect(teardown).toContain('runLaneTeardownFloor({');
  expect(teardown).toContain('source: async () => agentRegistry');
  expect(teardown.indexOf('runLaneTeardownFloor({')).toBeLessThan(teardown.indexOf('callTranscripts.delete(callId)'));
});

let serial = 0;
beforeEach(() => {
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
});

// Use the real registry and factory: v90 showed that a sweep imported apart
// from its factory can read a different copy of the per-call state.
async function call(slug: string, transcript?: string) {
  const source = await defaultLaneSource();
  const config = source.getAgentConfig(slug)!;
  const callSid = `CA${String(++serial).padStart(32, '0')}`;
  const callId = `synthetic-sip-${serial}`;
  const agent = await config.factory(...[async () => {}, {
    callId, callSid, callerPhone: '+12025550100',
    ...(transcript === undefined ? {} : { getTranscript: () => transcript }),
  }] as never[]);
  const finish = (runtimeTranscript?: string) => runLaneTeardownFloor({
    slug, callSid: callId, outcome: 'caller_hangup', transcript: runtimeTranscript ?? '',
  }, { source: async () => source });
  return { callId, callSid, finish, agent: agent as { tools: LiveTool[] } };
}

describe.each(['no-ivr', 'no-ivr-v2'])('%s teardown floor', (slug) => {
  it('files the stated request through the After Hours path when no ticket exists', async () => {
    const c = await call(slug, 'AGENT: How can I help?\nCALLER: Please have someone call me about a refill.');
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledWith(expect.objectContaining({
      callSid: c.callSid,
      agentUsed: slug,
      departmentId: 8,
      patientPhone: '+12025550100',
      preferredContactMethod: 'phone',
      reasonForCalling: expect.stringContaining('Please have someone call me about a refill.'),
    }));
    // Keep the normal call-<sid> idempotency key; never request a second ticket.
    expect(h.submitSimplifiedTicket.mock.calls[0][0].secondTicketOnThisCall).toBeUndefined();
  });

  it('does not file when this call already has a ticket', async () => {
    const c = await call(slug, 'CALLER: Please call me about a refill.');
    h.getCallLogBySid.mockResolvedValue({ ticketNumber: 'VA-EXISTING' });
    await c.finish();
    expect(h.getCallLogBySid).toHaveBeenCalledWith(c.callSid);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('does not file when the caller was never transcribed', async () => {
    const c = await call(slug, 'AGENT: Please leave your request.');
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('does not duplicate a successful live filing when row write-back is missing', async () => {
    const c = await call(slug, 'CALLER: Please have someone call me about a refill.');
    const tool = c.agent.tools.find((t) => t.name === 'create_ticket')!;
    const result = await tool.invoke!({}, JSON.stringify({
      first_name: 'Synthetic', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '2025550100', request_category: 'general_question',
      request_summary: 'Please return my call about a message for the office.',
    }));
    expect(typeof result === 'string' ? JSON.parse(result) : result).toMatchObject({ success: true });
    h.submitSimplifiedTicket.mockClear();
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it.each(['', 'CALLER: Hello.\nCALLER: Yes.', 'AGENT: What is your date of birth?\nCALLER: January second, nineteen eighty.'])(
    'does not file a silent, filler-only or identity-only call (%s)', async (transcript) => {
      const c = await call(slug, transcript);
      await c.finish();
      expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
    },
  );

  it('uses the runtime transcript when no SIP getter exists', async () => {
    const c = await call(slug);
    await c.finish('CALLER: I need a callback about a refill.');
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('files once across concurrent and repeated teardown', async () => {
    const c = await call(slug, 'CALLER: I need a callback about a refill.');
    await Promise.all([c.finish(), c.finish()]);
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('skips a filing already recorded by a tool even if row write-back failed', async () => {
    const c = await call(slug, 'CALLER: Please call me about a refill.');
    recordToolEvent(c.callId, 'create_ticket', {}, JSON.stringify({ success: true, ticket_number: 'VA-EXISTING' }), 0);
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('does not turn an explicitly answered question into a callback ticket', async () => {
    const c = await call(slug, 'CALLER: What time does the office open?');
    recordToolEvent(c.callId, 'create_ticket', {}, JSON.stringify({ success: true, ticketCreated: false, callbackRequired: false }), 0);
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });
});
