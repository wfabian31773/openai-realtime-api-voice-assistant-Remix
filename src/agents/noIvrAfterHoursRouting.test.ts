/**
 * THE OPERATOR'S TWO AFTER-HOURS ROUTES, ON THE REAL AGENT (v89).
 *
 * Operator, 2026-10-02:
 *   - "1, no, it should record an urgent ticket in after hours" — a post-op
 *     patient whose medication did not reach the pharmacy is not a ring; it is
 *     an URGENT ticket in After Hours. Corpus: CAa2e451aba415a1deb97a72374e3e1784
 *     and CAb475175ff010615e82b9f6799c0fb114 (2026-10-02 00:41/00:46 UTC), two
 *     medium tickets, one in Technicians Support, both unassigned.
 *   - "same day tickets are worked in the after hours department." Corpus: 7 of
 *     the 8 tickets filed 6–8 AM Pacific on 2026-10-01 were same-day and went to
 *     the HVA Hub or Surgery Coordination; first touched at 8:17–8:26.
 *
 * Driven through the tool the way the SDK invokes it, because the routing
 * module proven alone proves the module and not that this lane sends what it
 * decides (failure mode 10). Synthetic caller throughout.
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
    requiresCallback: () => true,
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

describe('a post-op medication problem files URGENT to After Hours', () => {
  it('on the model flag', async () => {
    const { agent } = await agentFor();
    const r = await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'prescription_question',
      request_summary: 'Drops from today are not at the pharmacy',
      post_op_prescription: true,
    });
    expect(r.success).toBe(true);
    const p = lastSubmit();
    expect(p.departmentId).toBe(8);
    expect(p.priority).toBe('urgent');
    expect(p.suggestedRequestTypeId).toBe(35);
    expect(p.suggestedRequestReasonId).toBe(171);
    expect(p.additionalDetails).toMatch(/POST-OP MEDICATION — URGENT/);
    expect(p.reasonForCalling, 'the note never displaces the head of the description').not.toMatch(/POST-OP MEDICATION/);
  });

  it('files without a drug name — the corpus caller did not know it', async () => {
    // The pre-execution gate blocks any create_ticket naming "refill" or
    // "medication" until a drug is named. A post-op prescription problem is
    // exempt: "we don't know the name" was the corpus caller's own answer.
    const { agent } = await agentFor();
    const r = await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'medication_refill',
      request_summary: 'Post-op medication from today never reached the pharmacy; caller does not know the name',
      post_op_prescription: true,
    });
    expect(r.success).toBe(true);
    expect(lastSubmit().priority).toBe('urgent');
  });

  it('on the words, when the model sent no flag — and in the evening too', async () => {
    vi.setSystemTime(EVENING);
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'prescription_question',
      request_summary: 'Had a surgical procedure today; steroid drop prescription is not at the pharmacy',
    });
    const p = lastSubmit();
    expect(p.departmentId).toBe(8);
    expect(p.priority).toBe('urgent');
  });

  it('a refused escalation for it files the SAME urgent After Hours ticket and rings nobody', async () => {
    const callSid = freshSid();
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, { callId: `call-${callSid}`, callSid, callerPhone: '5551234567' } as any);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Post-op patient: the steroid drop prescription never reached the pharmacy',
      caller_type: 'patient_urgent_medical',
    });
    expect(handoff).not.toHaveBeenCalled();
    expect(r.refused).toBe('post_op_medication');
    expect(r.ticket_filed).toBe(true);
    const p = lastSubmit();
    expect(p.departmentId).toBe(8);
    expect(p.priority).toBe('urgent');
    expect(p.suggestedRequestReasonId).toBe(171);
    expect(p.additionalDetails).toMatch(/POST-OP MEDICATION — URGENT/);
    expect(p.additionalDetails).toMatch(/NOT SANCTIONED \(post_op_medication\)/);
    expect(r.message, 'a later symptom may still reach the on-call provider').toMatch(/NEW SYMPTOM/);
  });
});

describe('a same-day request files to After Hours', () => {
  it('on the model flag, in the morning, with no priority of its own', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'confirm_appointment',
      request_summary: 'Confirming the 8 o clock',
      appointment_today: true,
    });
    const p = lastSubmit();
    expect(p.departmentId).toBe(8);
    expect(p.priority).toBeUndefined();
    expect(p.additionalDetails).toMatch(/SAME-DAY/);
  });

  it('on the words: running late never says "today"', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'general_question',
      request_summary: 'Running about ten minutes late for the 8 o clock appointment',
    });
    expect(lastSubmit().departmentId).toBe(8);
  });

  it('on the CONFIRMED record: an appointment later today', async () => {
    h.byNameAndDob.mockResolvedValue({
      ...NOT_FOUND,
      patientFound: true,
      matchedBy: 'name_and_dob',
      identity: { unique: true, candidateCount: 1, candidates: [] },
      upcomingAppointments: [{ isoDate: '2026-10-02', startTime: '9:20 AM' }],
    });
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: 'Wants to move her appointment',
    });
    expect(lastSubmit().departmentId).toBe(8);
  });

  it('a record that matched several people is not the caller\'s, so it routes nothing', async () => {
    h.byNameAndDob.mockResolvedValue({
      ...NOT_FOUND,
      patientFound: true,
      matchedBy: 'name_and_dob',
      identity: { unique: false, candidateCount: 2, candidates: [] },
      upcomingAppointments: [{ isoDate: '2026-10-02', startTime: '9:20 AM' }],
    });
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: 'Wants to move her appointment',
    });
    expect(lastSubmit().departmentId).toBeUndefined();
  });

  it('not after the office day has ended', async () => {
    vi.setSystemTime(EVENING);
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'confirm_appointment',
      request_summary: 'About the appointment today',
      appointment_today: true,
    });
    expect(lastSubmit().departmentId).toBeUndefined();
  });
});

describe('every other call is the app\'s to route, exactly as before', () => {
  it('sends no department and no priority', async () => {
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'medication_refill',
      request_summary: 'Refill of latanoprost to the usual pharmacy',
    });
    const p = lastSubmit();
    expect(p.departmentId).toBeUndefined();
    expect(p.priority).toBeUndefined();
    expect(p.additionalDetails ?? '').not.toMatch(/SAME-DAY|POST-OP/);
  });
});
