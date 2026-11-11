/**
 * v202 — AN AFTER-HOURS APPOINTMENT REQUEST THAT IS NOT ABOUT TODAY FILES TO
 * THE HVA HUB, ON THE REAL AGENT.
 *
 * Operator, 2026-11-11: "We're doing more transferring of tickets than
 * anything else." Standing instruction 10: schedule-related goes to the HVA Hub
 * from every queue, except a surgery date. The after-hours line sent no
 * department for a routine appointment request and let the app decide, and the
 * app followed the department-8 hint the after-hours taxonomy attached: a
 * summary carrying "callback" matched Callback Request (department 8), so a new
 * patient asking for an appointment filed in After Hours. Measured over the
 * fourteen Pacific days 2026-10-28..11-10, no-IVR tickets whose category is
 * Appointment Request, not same-day and naming no operation: 68 landed in the
 * Hub (66 stayed); 37 landed elsewhere and staff moved 24 of them to the Hub,
 * left 8 and moved 5 elsewhere.
 *
 * The corpus is the four after-hours tickets of 2026-11-10 that staff moved
 * to the Hub (VA-82941, VA-82948, VA-82955 from After Hours, VA-82975 from
 * Surgery), by the real call SID with synthetic words. Driven through the tool
 * the way the SDK invokes it (failure mode 10).
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
  byNameAndDob: vi.fn(async (): Promise<any> => ({
    patientFound: false,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  })),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => undefined } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    // The production default is false for confirmations. A blanket true
    // hid requests being discarded before their same-day route could run.
    requiresCallback: (category: string) => category !== 'confirm_appointment',
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => NOT_FOUND,
    lookupByNameAndDOB: () => h.byNameAndDob(),
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;
async function agentFor() {
  const callSid = freshSid();
  const agent = await createNoIvrAgent(vi.fn(async () => {}), {
    callId: `call-${callSid}`,
    callSid,
    callerPhone: '5551234567',
  } as any);
  return { agent, callSid };
}

const TICKET = {
  first_name: 'Testa',
  last_name: 'Patient',
  date_of_birth: 'January 15, 1980',
  location: 'Synthetic Clinic', // Complete live intake before testing this lane.
  callback_number: '5551234567',
  preferred_contact: 'phone',
};

/** 2026-10-02 06:30 Pacific — the morning window. */
const MORNING = new Date('2026-10-02T13:30:00Z');
/** 2026-10-01 20:00 Pacific — after the office day. */
const EVENING = new Date('2026-10-02T03:00:00Z');

const lastSubmit = () => {
  const calls = h.submitSimplifiedTicket.mock.calls;
  return calls[calls.length - 1][0] as Record<string, any>;
};

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  h.byNameAndDob.mockReset();
  h.byNameAndDob.mockResolvedValue(NOT_FOUND);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MORNING);
});
afterEach(() => {
  vi.useRealTimers();
});


describe('the corpus: routine appointment requests file to the HVA Hub with no department-8 hint', () => {
  const CORPUS: Array<[string, string, string, string, Date]> = [
    ['CA7828f7c9491196a8e88d284f9839065a', 'VA-82941', 'new_appointment',
      'Patient requests a new appointment at the Example office. Existing patient. Prefers a phone callback.', EVENING],
    ['CAadde32f0d4ba71b3d317d3800cb5f8d5', 'VA-82948', 'new_appointment',
      'New patient requesting to make an appointment. Prefers a phone callback.', EVENING],
    ['CAca583db54e5368861845a2ff8dad00f8', 'VA-82955', 'cancel_appointment',
      'Daughter calling to cancel an upcoming appointment for her father next week. Requests a callback.', EVENING],
    ['CA0875fa005dea9d7a6e6929c8e4e79611', 'VA-82975', 'appointment_request',
      'Patient asks to be told by text if an earlier appointment opens up before her upcoming one.', MORNING],
  ];
  for (const [sid, ticket, category, summary, at] of CORPUS) {
    it(`${ticket} (${sid}) files to department 9`, async () => {
      vi.setSystemTime(at);
      const agent = await createNoIvrAgent(vi.fn(async () => {}), {
        callId: `call-${sid}`, callSid: sid, callerPhone: '5551234567',
      } as any);
      const r = await call(agent, 'create_ticket', { ...TICKET, request_category: category, request_summary: summary });
      expect(r.success).toBe(true);
      const sent = lastSubmit();
      expect(sent.departmentId).toBe(9);
      // The department-8 hint is what pulled these into After Hours; it is not sent.
      expect(sent.suggestedRequestTypeId).toBeUndefined();
      expect(sent.suggestedRequestReasonId).toBeUndefined();
      expect(String(sent.additionalDetails)).toMatch(/SCHEDULING: an appointment request that is not about today/);
    });
  }
});

describe('controls', () => {
  it('a same-day request in the morning still files to After Hours (the operator\'s ruling)', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'confirm_appointment',
      request_summary: 'Wants to confirm the appointment this morning',
      appointment_today: true,
    });
    expect(lastSubmit().departmentId).toBe(8);
  });
  it('a surgery date is left to the app, never sent to the Hub', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: 'Needs to reschedule her cataract surgery set for next month',
    });
    expect(lastSubmit().departmentId).toBeUndefined();
  });
  it('an urgent appointment request keeps the app\'s routing and its urgent hint', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'new_appointment',
      request_summary: 'Lost vision in the right eye and needs an appointment',
    });
    const sent = lastSubmit();
    expect(sent.departmentId).toBeUndefined();
    expect(sent.suggestedUrgent).toBe(true);
  });
  it('a request that is not an appointment one is left to the app as before', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'billing_question',
      request_summary: 'Question about a bill for the last visit. Requests a callback.',
    });
    expect(lastSubmit().departmentId).toBeUndefined();
  });
});
