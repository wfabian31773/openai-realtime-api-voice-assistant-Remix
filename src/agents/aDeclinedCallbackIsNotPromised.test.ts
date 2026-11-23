/**
 * A CALLER WHO DECLINES A CALLBACK IS NOT PROMISED ONE (v269).
 *
 * Operator, 2026-11-22: the agent says "we'll call you back" even after the
 * caller declines a callback.
 *
 * The after-hours prompt asks "Would you prefer we call, text, or email you
 * back?" on every call, so the model fills `preferred_contact` on nearly every
 * filing. v166 (ticket 70202) let that field outrank the model's explicit
 * `requires_callback: false`, so a caller who said "You don't need to call
 * back." was promised a callback and the ticket lost its `[NO CALLBACK
 * NEEDED]` tag. Measured, no-ivr `create_ticket` calls 2026-11-15..23
 * (`tool_call_payloads`): 3 sent `requires_callback: false`, and all 3 were
 * overridden on `preferred_contact` alone.
 *
 * The corpus, by real CallSid, with synthetic stand-ins for the caller's words
 * (the real transcripts stay out of git):
 *   - CAc93e587d61e2905d35850a571c08ce97: "You don't need to call back." The
 *     agent then said the team would call them back.
 *   - CA25b3b9562772a9f881d266ab17eb1f29: "I'll call back." No spoken promise,
 *     but the ticket lost its tag and the tool told the agent to promise one.
 *   - CAb7ae17c94d5bec743b5d171646f46985 (control): "Just email me." The third
 *     override; the caller's own words ask for email, so it stays a follow-up.
 *   - CA89e491eb82b2cfb17501a2c07efeeb9f, CA677149c220f916389dc68485841eac6b
 *     (controls): the model sent TRUE; nothing changes.
 *   - 70202 (control): "Call, please." with the model's FALSE is still a
 *     callback.
 * Not in the corpus: CAe2962ea79a8ee8d47b98302a36b85d44 (2026-11-12, before
 * `tool_call_payloads`), where the agent assumed phone without asking and the
 * caller declined nothing; its arguments are not recoverable.
 *
 * Driven through the real agent the way the SDK invokes it, with the caller's
 * words fed the way the runtime feeds them (`noteCallerTranscript`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const NOT_FOUND = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: 'VA-TEST',
    message: 'VA-TEST',
  })),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => undefined } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: (category: string) => category !== 'confirm_appointment',
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => NOT_FOUND,
    lookupByNameAndDOB: async () => NOT_FOUND,
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { noteCallerTranscript, releaseCallerSpeech } = await import('../services/symptomCorroboration');

const TICKET = {
  first_name: 'Testa',
  last_name: 'Patient',
  date_of_birth: 'January 15, 1980',
  location: 'Synthetic Clinic',
  callback_number: '5551234567',
};

/** 2026-11-20 07:00 Pacific, inside the after-hours window. */
const MORNING = new Date('2026-11-20T15:00:00Z');

const METHOD_QUESTION = 'AGENT: Would you prefer we call, text, or email you back?';

interface Case {
  sid: string;
  caller: string;
  args: Record<string, unknown>;
}

async function file(c: Case) {
  const agent = await createNoIvrAgent(vi.fn(async () => {}), {
    callId: `call-${c.sid}`,
    callSid: c.sid,
    callerPhone: '5551234567',
  } as any);
  noteCallerTranscript(`call-${c.sid}`, [
    'CALLER: I need to cancel my appointment.',
    METHOD_QUESTION,
    `CALLER: ${c.caller}`,
  ]);
  try {
    const t = (agent as any).tools.find((x: any) => x.name === 'create_ticket');
    const raw = await t.invoke({}, JSON.stringify({ ...TICKET, ...c.args }));
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const calls = h.submitSimplifiedTicket.mock.calls;
    const payload = calls[calls.length - 1]?.[0] as Record<string, any> | undefined;
    return { result, payload };
  } finally {
    releaseCallerSpeech(`call-${c.sid}`);
  }
}

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MORNING);
});
afterEach(() => {
  vi.useRealTimers();
});

const DECLINED: Case[] = [
  {
    sid: 'CAc93e587d61e2905d35850a571c08ce97',
    caller: "You don't need to call back.",
    args: {
      request_category: 'cancel_appointment',
      request_summary: 'Wants to cancel an appointment.',
      preferred_contact: 'phone',
      requires_callback: false,
    },
  },
  {
    sid: 'CA25b3b9562772a9f881d266ab17eb1f29',
    caller: "Um, I'll call back.",
    args: {
      request_category: 'cancel_appointment',
      request_summary: 'Wants to cancel an appointment today; feeling unwell.',
      preferred_contact: 'phone',
      requires_callback: false,
    },
  },
];

describe('a declined callback is not promised (the corpus)', () => {
  for (const c of DECLINED) {
    it(`${c.sid}: files the request with no callback promised`, async () => {
      const { result, payload } = await file(c);
      expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: false });
      expect(String(result.message)).toMatch(/do not promise a phone callback/i);
      expect(String(result.message)).not.toMatch(/receive a callback|call you back/i);
      expect(payload, 'the request still files').toBeTruthy();
      expect(String(payload!.reasonForCalling)).toContain('[NO CALLBACK NEEDED]');
    });
  }
});

describe('a caller who wants a follow-up still gets one (controls)', () => {
  it('CAb7ae17c94d5bec743b5d171646f46985: "Just email me." beside the model\'s FALSE is an email follow-up', async () => {
    const { result, payload } = await file({
      sid: 'CAb7ae17c94d5bec743b5d171646f46985',
      caller: 'Just email me.',
      args: {
        request_category: 'cancel_appointment',
        request_summary: 'Wants to cancel an appointment tomorrow.',
        preferred_contact: 'email',
        email: 'testa.patient@example.com',
        requires_callback: false,
      },
    });
    expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: true });
    expect(String(result.message)).toMatch(/follow up by email/i);
    expect(String(payload!.reasonForCalling)).not.toContain('[NO CALLBACK NEEDED]');
  });

  for (const c of [
    {
      sid: 'CA89e491eb82b2cfb17501a2c07efeeb9f',
      caller: 'Call is fine.',
      args: { request_category: 'cancel_appointment', request_summary: 'Wants to cancel an appointment.' },
    },
    {
      sid: 'CA677149c220f916389dc68485841eac6b',
      caller: 'Phone, please.',
      args: { request_category: 'follow_up_care', request_summary: 'Has a question after a visit.' },
    },
  ]) {
    it(`${c.sid}: the model's TRUE stands`, async () => {
      const { result, payload } = await file({
        ...c,
        args: { ...c.args, preferred_contact: 'phone', requires_callback: true },
      });
      expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: true });
      expect(String(result.message)).toMatch(/receive a callback/i);
      expect(String(payload!.reasonForCalling)).not.toContain('[NO CALLBACK NEEDED]');
    });
  }

  it('70202: "Call, please." outranks the model\'s FALSE', async () => {
    const { result, payload } = await file({
      sid: 'CA0000000000000000000000000070202a',
      caller: 'Call, please.',
      args: {
        request_category: 'cancel_appointment',
        request_summary: 'Wants to cancel an appointment.',
        preferred_contact: 'phone',
        requires_callback: false,
      },
    });
    expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: true });
    expect(String(payload!.reasonForCalling)).not.toContain('[NO CALLBACK NEEDED]');
  });

  it('a chosen method with the model silent on it is still a callback', async () => {
    const { result } = await file({
      sid: 'CA00000000000000000000000000000269',
      caller: 'Text is fine.',
      args: {
        request_category: 'cancel_appointment',
        request_summary: 'Wants to cancel an appointment.',
        preferred_contact: 'text',
      },
    });
    expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: true });
    expect(String(result.message)).toMatch(/follow up by text/i);
  });
  // Codex P1 on #517: a bare method answer to the method question is the
  // caller choosing a follow-up, so the model's FALSE beside it does not stand.
  for (const c of [
    { sid: 'CA00000000000000000000000005170001', caller: 'Text.', contact: 'text', said: /follow up by text/i },
    { sid: 'CA00000000000000000000000005170002', caller: 'Phone.', contact: 'phone', said: /receive a callback/i },
    { sid: 'CA00000000000000000000000005170003', caller: 'Email.', contact: 'email', said: /follow up by email/i },
  ] as const) {
    it(`"${c.caller}" beside the model's FALSE is a follow-up by ${c.contact}`, async () => {
      const { result, payload } = await file({
        sid: c.sid,
        caller: c.caller,
        args: {
          request_category: 'cancel_appointment',
          request_summary: 'Wants to cancel an appointment.',
          preferred_contact: c.contact,
          ...(c.contact === 'email' ? { email: 'testa.patient@example.com' } : {}),
          requires_callback: false,
        },
      });
      expect(result).toMatchObject({ success: true, ticketCreated: true, callbackRequired: true });
      expect(String(result.message)).toMatch(c.said);
      expect(String(payload!.reasonForCalling)).not.toContain('[NO CALLBACK NEEDED]');
    });
  }
});
