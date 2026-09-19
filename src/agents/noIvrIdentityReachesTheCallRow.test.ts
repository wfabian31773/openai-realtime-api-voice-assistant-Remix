/**
 * THE RECORD REACHES THE AFTER-HOURS CALL ROW — v53, the old-core half of #57.
 *
 * MEASURED over the seven days to 2026-09-17: patient_found was set on 0 of
 * 297 substantive no-ivr calls. The lane HAD a writer — at factory time,
 * beside the phone lookup — and it read `metadata.callLogId` once, before the
 * transport had backfilled it (the getter returns undefined until after
 * session.connect()), so it never fired. And what it would have written was
 * the PHONE match: a candidate, not an identity (RULE ZERO step 2; v47).
 *
 * Now the row is written from create_ticket, once a name + date of birth has
 * confirmed who this is, reading the getter at THAT moment. A phone-only
 * context writes nothing. Synthetic patient, office and doctor — RULE THREE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const EMPTY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
const PHONE_CANDIDATE = {
  ...EMPTY,
  patientFound: true,
  patientName: 'Zelda Quixote',
  matchedBy: 'phone' as const,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};
const CONFIRMED = { ...PHONE_CANDIDATE, matchedBy: 'name_and_dob' as const };

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  updateCallLog: vi.fn(async () => undefined),
  liveCallLogId: undefined as string | undefined,
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: (...a: unknown[]) => h.updateCallLog(...(a as [])) } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: { submitSimplifiedTicket: async () => ({ success: true, ticketNumber: 'VA-TEST' }), checkOpenTickets: async () => [], requiresCallback: () => true },
}));
vi.mock('../services/scheduleLookupService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/scheduleLookupService')>();
  return {
    ...actual,
    scheduleLookupService: {
      lookupByPhone: (...a: unknown[]) => h.lookupByPhone(...(a as [])),
      lookupByNameAndDOB: (...a: unknown[]) => h.lookupByNameAndDOB(...(a as [])),
      formatContextForAgent: actual.scheduleLookupService.formatContextForAgent.bind(actual.scheduleLookupService),
    },
  };
});
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const SID = 'CA0000000000000000000000000000c153';
/** The transport's shape: callLogId is a GETTER that becomes defined later. */
const META = {
  callId: 'call-c153',
  callSid: SID,
  callerPhone: '+15551234567',
  get callLogId() { return h.liveCallLogId; },
};
const TICKET = {
  first_name: 'Zelda',
  last_name: 'Quixote',
  date_of_birth: '01/04/1958',
  callback_number: '5551234567',
  request_category: 'general_question',
  request_summary: 'test request',
};

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(PHONE_CANDIDATE as any);
  h.lookupByNameAndDOB.mockReset().mockResolvedValue(EMPTY as any);
  h.updateCallLog.mockReset().mockResolvedValue(undefined);
  h.liveCallLogId = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('a confirmed identity reaches the call row', () => {
  it('writes patientFound, the name and the date of birth to the id the transport backfilled AFTER the factory ran', async () => {
    h.lookupByNameAndDOB.mockResolvedValue(CONFIRMED as any);
    const agent = await createNoIvrAgent(async () => {}, META);   // callLogId still undefined here
    h.liveCallLogId = 'log-row-c153';                              // backfilled after session.connect()
    const res = await call(agent, 'create_ticket', TICKET);
    expect(res.success).toBe(true);
    await vi.waitFor(() => expect(h.updateCallLog).toHaveBeenCalledTimes(1));
    const [id, patch] = h.updateCallLog.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe('log-row-c153');
    expect(patch).toMatchObject({
      patientFound: true,
      patientName: 'Zelda Quixote',
      lastLocationSeen: 'Quixotic Vision Testville',
      lastProviderSeen: 'Dr. Xavier Zebrastripe',
    });
    expect(String(patch.patientDob)).toContain('1958');
  });

  it('nothing is written at factory time, even though the phone matched', async () => {
    h.liveCallLogId = 'log-row-c153';   // even with the id available early
    await createNoIvrAgent(async () => {}, META);
    expect(h.updateCallLog).not.toHaveBeenCalled();
  });
});

describe('a candidate is not an identity', () => {
  it('a phone match whose name + date of birth lookup MISSES writes nothing', async () => {
    h.lookupByNameAndDOB.mockResolvedValue(EMPTY as any);
    const agent = await createNoIvrAgent(async () => {}, META);
    h.liveCallLogId = 'log-row-c153';
    const res = await call(agent, 'create_ticket', TICKET);
    expect(res.success).toBe(true);
    expect(h.updateCallLog).not.toHaveBeenCalled();
  });

  it('a B2B caller with no date of birth writes nothing — the phone context is all there is', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    h.liveCallLogId = 'log-row-c153';
    const res = await call(agent, 'create_ticket', { ...TICKET, date_of_birth: 'DOB not available' });
    expect(res.success).toBe(true);
    expect(h.lookupByNameAndDOB).not.toHaveBeenCalled();
    expect(h.updateCallLog).not.toHaveBeenCalled();
  });

  it('a confirmed identity with no row id yet is not written, and the ticket still files', async () => {
    h.lookupByNameAndDOB.mockResolvedValue(CONFIRMED as any);
    const agent = await createNoIvrAgent(async () => {}, META);   // liveCallLogId stays undefined
    const res = await call(agent, 'create_ticket', TICKET);
    expect(res.success).toBe(true);
    expect(h.updateCallLog).not.toHaveBeenCalled();
  });
});

describe('several people on the name and date of birth write nothing — Codex P2 on #321', () => {
  it('a name + date-of-birth lookup that matches SEVERAL people does not write the primary as this caller', async () => {
    h.lookupByNameAndDOB.mockResolvedValue({
      ...CONFIRMED,
      identity: { unique: false, candidateCount: 2, candidates: [] },
    } as any);
    const agent = await createNoIvrAgent(async () => {}, META);
    h.liveCallLogId = 'log-row-c153';
    const res = await call(agent, 'create_ticket', TICKET);
    expect(res.success).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(h.updateCallLog).not.toHaveBeenCalled();
  });
});
