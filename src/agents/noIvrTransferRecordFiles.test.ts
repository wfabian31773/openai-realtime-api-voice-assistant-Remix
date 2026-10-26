/**
 * THE URGENT TRANSFER RECORD FILES, AND IT FILES IN AFTER HOURS.
 *
 * Operator mandate 2026-07-25: every urgent outcome on the after-hours line
 * leaves a record ticket pinned to the After Hours queue. On a CONNECTED
 * transfer the record is filed fire-and-forget beside the handoff, and over
 * 2026-08-11..10-09 it failed two ways (voice_agent_api_logs, Support Center):
 *
 *   - 22 refused "Could not parse patient name" — the fallback name was
 *     "Unknown Caller" and /submit-ticket refuses a name whose every word is a
 *     placeholder. Every one of the 22 was a caller connected to the on-call
 *     provider (21 found in call_logs, all transferred) and none of them has a
 *     ticket of any provenance. Recent: CAf746549c0b24b252a761959031c097f4,
 *     CA62977ba64183d6a3227b0c22a3be45e6, CA7ae28b7165f09fc1a7652c0428f993d8.
 *   - 9 refused "Missing required information: surgeon" — no department was
 *     named, the app classified the description as Surgery, and Surgery demands
 *     a surgeon. Of 54 records that DID file, only 32 landed in After Hours.
 *
 * Driven on the REAL agent, the tool invoked the way the SDK invokes it.
 * Synthetic callers; nothing here is a real person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: 'VA-TEST',
    message: 'VA-TEST',
  })),
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

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { appWouldRefuseName, STAND_IN_NAME_NOTE } = await import('../services/standInName');
const { AFTER_HOURS_DEPARTMENT_ID } = await import('../tools/afterHoursTaxonomy');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0x930;
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;

async function agentFor(callSid: string) {
  const handoff = vi.fn(async () => {});
  const agent = await createNoIvrAgent(handoff, { callId: `call-${callSid}`, callSid, callerPhone: '5551234567' } as any);
  return { agent, handoff };
}

/** The corpus shape: a clinician, connected, no patient name recorded. */
const CLINICIAN = {
  reason: "Nurse from the hospital's emergency department calling about a post-op patient",
  caller_type: 'healthcare_provider',
  provider_info: 'hospital emergency department',
};
/** Routine — the gate refuses it, which files the caller's own request. */
const ROUTINE = {
  reason: 'Caller wants to reschedule an appointment for tomorrow and asked for the on-call doctor',
  caller_type: 'patient_urgent_medical',
};

const recordAt = async (i: number) => {
  await vi.waitFor(() => expect(h.submitSimplifiedTicket.mock.calls.length).toBeGreaterThan(i));
  return h.submitSimplifiedTicket.mock.calls[i][0] as Record<string, any>;
};

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' } as any);
});

describe('a connected transfer with no patient name still leaves its record', () => {
  it('files under a name the app accepts, and says it is a stand-in', async () => {
    const { agent, handoff } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', CLINICIAN);
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);

    const record = await recordAt(0);
    expect(record.reasonForCalling).toMatch(/URGENT TRANSFER \(record ticket — caller connected to on-call\)/);
    expect(record.patientFullName).toBe('Unnamed Caller');
    expect(appWouldRefuseName(record.patientFullName), '/submit-ticket would refuse this').toBe(false);
    expect(record.additionalDetails).toBe(STAND_IN_NAME_NOTE);
  });

  it('a placeholder the MODEL wrote is replaced too — "Unknown" alone is refused', async () => {
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', { ...CLINICIAN, patient_first_name: 'Unknown' });
    const record = await recordAt(0);
    expect(record.patientFullName).toBe('Unnamed Caller');
    expect(record.additionalDetails).toBe(STAND_IN_NAME_NOTE);
  });

  it('a real name is kept and carries no note', async () => {
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', { ...CLINICIAN, patient_first_name: 'Dana', patient_last_name: 'Example' });
    const record = await recordAt(0);
    expect(record.patientFullName).toBe('Dana Example');
    expect(record.additionalDetails).toBeUndefined();
  });
});

describe('the record is pinned to After Hours', () => {
  it('names department 8 on every connected transfer, so the app cannot classify it into Surgery', async () => {
    expect(AFTER_HOURS_DEPARTMENT_ID).toBe(8);
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', { ...CLINICIAN, patient_first_name: 'Dana', patient_last_name: 'Example' });
    const record = await recordAt(0);
    expect(record.departmentId).toBe(8);
    expect(record.priority).toBe('urgent');
  });

  it('sends no reason hint — the app refuses 159 as a hint, a disposition is not a request reason', async () => {
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', CLINICIAN);
    const record = await recordAt(0);
    expect(record.suggestedRequestTypeId).toBeUndefined();
    expect(record.suggestedRequestReasonId).toBeUndefined();
  });

  it('beside an earlier refused-escalation ticket: After Hours, its own key, and both notes', async () => {
    const { agent } = await agentFor(freshSid());
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EARLIER', message: 'VA-EARLIER' } as any);
    await call(agent, 'escalate_to_human', ROUTINE);
    await call(agent, 'escalate_to_human', CLINICIAN);
    const record = await recordAt(1);
    expect(record.departmentId).toBe(8);
    expect(record.secondTicketOnThisCall).toEqual({ keySuffix: 'urgent-transfer' });
    expect(record.additionalDetails).toMatch(/^SEE ALSO VA-EARLIER/);
    expect(record.additionalDetails).toContain(STAND_IN_NAME_NOTE);
  });
});

describe('what does not change', () => {
  it("a refused escalation's own ticket still names no department of its own (only post-op does, v89)", async () => {
    const { agent, handoff } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', ROUTINE);
    expect(handoff).not.toHaveBeenCalled();
    const p = await recordAt(0);
    expect(p.departmentId).toBeUndefined();
    expect(p.priority).toBeUndefined();
    expect(p.patientFullName).toBe('Unnamed Caller');
  });
});
