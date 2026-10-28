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
  checkOpenTickets: vi.fn(),
  lookupByPhone: vi.fn(),
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: h.submitSimplifiedTicket,
    createTicketFromAgentInput: async () => ({ success: true, ticketNumber: 'VA-SYNTHETIC' }),
    checkOpenTickets: h.checkOpenTickets,
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: h.lookupByPhone,
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
  h.checkOpenTickets.mockReset().mockResolvedValue([]);
  h.lookupByPhone.mockReset().mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [] });
});

// Use the real registry and factory: v90 showed that a sweep imported apart
// from its factory can read a different copy of the per-call state.
async function call(slug: string, transcript?: string, handoff = vi.fn(async () => {})) {
  const source = await defaultLaneSource();
  const config = source.getAgentConfig(slug)!;
  const callSid = `CA${String(++serial).padStart(32, '0')}`;
  const callId = `synthetic-sip-${serial}`;
  const agent = await config.factory(...[handoff, {
    callId, callSid, callerPhone: '+12025550100',
    ...(transcript === undefined ? {} : { getTranscript: () => transcript }),
  }] as never[]);
  const finish = (runtimeTranscript?: string) => runLaneTeardownFloor({
    slug, callSid: callId, outcome: 'caller_hangup', transcript: runtimeTranscript ?? '',
  }, { source: async () => source });
  return { callId, callSid, finish, handoff, agent: agent as { tools: LiveTool[] } };
}

async function invoke(agent: { tools: LiveTool[] }, name: string, args = {}) {
  const tool = agent.tools.find((t) => t.name === name)!;
  const result = await tool.invoke!({}, JSON.stringify(args));
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const providerRequest = {
  reason: 'Nurse from the hospital emergency department calling about a patient',
  caller_type: 'healthcare_provider',
  provider_info: 'hospital emergency department',
};

describe('urgent transfer filing owns the call before teardown', () => {
  it.each(['during handoff', 'after handoff'])('waits for the urgent record when teardown starts %s', async (timing) => {
    const handoff = deferred<void>();
    const record = deferred<{ success: boolean; ticketNumber: string }>();
    h.submitSimplifiedTicket.mockImplementationOnce(() => record.promise);
    const c = await call('no-ivr', 'CALLER: I am a nurse calling from the hospital about a patient.', vi.fn(() => handoff.promise));
    const escalation = invoke(c.agent, 'escalate_to_human', providerRequest);
    await vi.waitFor(() => expect(c.handoff).toHaveBeenCalledTimes(1));
    if (timing === 'after handoff') {
      handoff.resolve();
      expect(await escalation).toMatchObject({ success: true });
      await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1));
    }

    let finished = false;
    const teardown = c.finish().then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(h.getCallLogBySid).not.toHaveBeenCalled();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(timing === 'during handoff' ? 0 : 1);

    handoff.resolve();
    expect(await escalation).toMatchObject({ success: true });
    await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1));
    expect(h.submitSimplifiedTicket).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'urgent', departmentId: 8, callSid: c.callSid,
      reasonForCalling: expect.stringContaining('URGENT TRANSFER (record ticket'),
    }));
    record.resolve({ success: true, ticketNumber: 'VA-URGENT-SYNTHETIC' });
    await teardown;
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    expect(h.getCallLogBySid).not.toHaveBeenCalled();
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it.each(['refused', 'rejected'])('allows the floor to recover when the urgent filing is %s', async (failure) => {
    const record = deferred<{ success: boolean; error: string }>();
    h.submitSimplifiedTicket.mockImplementationOnce(() => record.promise);
    const c = await call('no-ivr', 'CALLER: I am a nurse calling from the hospital about a patient.');
    expect(await invoke(c.agent, 'escalate_to_human', providerRequest)).toMatchObject({ success: true });
    await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1));

    const teardown = c.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    if (failure === 'rejected') record.reject(new Error('synthetic filing failure'));
    else record.resolve({ success: false, error: 'synthetic filing failure' });
    await teardown;
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(2);
    expect(h.submitSimplifiedTicket.mock.calls[1][0]).toMatchObject({
      callSid: c.callSid,
      additionalDetails: expect.stringContaining('AFTER-HOURS TEARDOWN'),
    });
  });

  it('releases the reservation if the handoff fails', async () => {
    const c = await call('no-ivr', 'CALLER: I am a nurse calling from the hospital about a patient.',
      vi.fn(async () => { throw new Error('synthetic handoff failure'); }));
    expect(await invoke(c.agent, 'escalate_to_human', providerRequest)).toMatchObject({ success: false });
    await c.finish();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    expect(h.submitSimplifiedTicket.mock.calls[0][0].additionalDetails).toContain('AFTER-HOURS TEARDOWN');
  });
});

describe.each(['no-ivr-v2', 'dev-no-ivr'])('%s has no floor without dispositions', (slug) => {
  it('does not register a teardown sweep', async () => {
    expect((await defaultLaneSource()).getAgentConfig(slug)?.teardownSweep).toBeUndefined();
  });

  it('does not create staff work for an already-open ticket inquiry', async () => {
    h.checkOpenTickets.mockResolvedValue([{ ticketNumber: 'VA-EXISTING-SYNTHETIC', reason: 'Callback request', daysAgo: 0 }]);
    const c = await call(slug, 'CALLER: Can you check whether my callback request is still open?');
    expect(await invoke(c.agent, 'check_open_tickets')).toMatchObject({ checked: true, hasOpenTickets: true });
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('does not create staff work for an answered appointment question', async () => {
    const c = await call(slug, 'CALLER: When is my upcoming appointment?');
    h.lookupByPhone.mockResolvedValue({
      patientFound: true, upcomingAppointments: [{ date: '2030-01-02', time: '10:00' }], pastAppointments: [],
    });
    expect(await invoke(c.agent, 'lookup_schedule', { phone: '+12025550100' })).toMatchObject({
      found: true, upcomingAppointments: [{ date: '2030-01-02', time: '10:00' }],
    });
    await c.finish();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });
});

describe('no-ivr teardown floor', () => {
  const slug = 'no-ivr';
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
