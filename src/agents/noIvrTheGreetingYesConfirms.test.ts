/**
 * THE AFTER-HOURS GREETING ASKS THE NAME, AND THE CALLER'S YES COUNTS — v172.
 *
 * Operator, 2026-11-03, choosing "After-hours too": the named greeting covers
 * the after-hours line, with the closed notice, the 911 direction and the
 * recording disclosure kept word for word (greetingPersonalisation.test.ts),
 * and a caller's yes to "Am I speaking with <first name>?" confirms a number
 * that is one person on file, as it does on the queue lanes (v170).
 *
 * BEFORE, no-ivr, 2026-10-20..11-02, callers the number recognised: 377
 * calls; the agent asked "Am I speaking with" on 185, and on all 159 where
 * the caller said yes it then asked for the last name or the date of birth.
 * The two recognised after-hours calls of 2026-11-03 after the v170 publish
 * are the corpus here (real SIDs, synthetic names — RULE THREE):
 *
 *   CAbf3977601223f045515bc3775c6431d3  asked the name, got a yes, then asked
 *                                        for the surname spelled out
 *   CA28bc2f551fd823cca0e188f2f4c29c2e  used the first name unconfirmed and
 *                                        asked for the date of birth
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const ZELDA = { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', personId: 'p-synthetic' };
const ONE_PERSON_ON_THE_NUMBER = {
  patientFound: true,
  patientName: 'Zelda Quixote',
  matchedBy: 'phone' as const,
  identityUnconfirmed: true,
  identity: { unique: true, candidateCount: 1, candidates: [{ ...ZELDA, appointmentCount: 1 }] },
  patientData: ZELDA,
  upcomingAppointments: [
    { date: 'Tuesday, December 31, 2041', isoDate: '2041-12-31', dayOfWeek: 'Tuesday', timeOfDay: 'afternoon',
      startTime: '3:10 PM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe',
      status: 'Active', appointmentType: 'Dilated Exam' },
  ],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({ success: true, ticketNumber: 'VA-TEST' })),
}));

vi.mock('@openai/agents/realtime', () => ({
  RealtimeAgent: class { constructor(options: Record<string, unknown>) { Object.assign(this, options); } },
  tool: (definition: any) => ({
    ...definition,
    invoke: (_context: unknown, input: string) => definition.execute(definition.parameters.parse(JSON.parse(input))),
  }),
}));
vi.mock('../../server/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'test-call-row' }] }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => undefined } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
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

const { createNoIvrAgent, greetingYesConfirms, greetingConfirmedMatches } = await import('./noIvrAgent');
const { verifiedIdentityFor, resetVerifiedIdentities } = await import('../tools/verifiedIdentity');
const { prepareTicketIdentity } = await import('../tools/ticketIdentity');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const GREETED = { matched: true, firstName: 'Zelda' };
const agentFor = (callSid: string, precontext: unknown = GREETED) =>
  createNoIvrAgent(async () => {}, { callId: `call-${callSid}`, callSid, callerPhone: '+15551234567', precontext } as any);

const CORPUS = ['CAbf3977601223f045515bc3775c6431d3', 'CA28bc2f551fd823cca0e188f2f4c29c2e'] as const;

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(ONE_PERSON_ON_THE_NUMBER as any);
  h.lookupByNameAndDOB.mockClear();
  h.submitSimplifiedTicket.mockClear();
  resetVerifiedIdentities();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('the corpus: a recognised after-hours caller who says yes is confirmed, not interviewed', () => {
  for (const sid of CORPUS) {
    it(`${sid}: the yes lookup returns the appointment and the ticket inherits the record`, async () => {
      const agent = await agentFor(sid);
      const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
      expect(r.found).toBe(true);
      expect(r.identityUnconfirmed).toBeUndefined();
      expect(r.upcomingAppointments).toHaveLength(1);
      expect(h.lookupByNameAndDOB).not.toHaveBeenCalled();
      const held = verifiedIdentityFor(sid);
      expect(held?.certain).toBe(true);
      expect(held?.dateOfBirth).toBe('1958-01-04');
      const filed = prepareTicketIdentity({ call_sid: sid, first_name: 'Zelda' });
      expect(filed.missing).toBeUndefined();
      expect(filed.input.last_name).toBe('Quixote');
      expect(filed.input.date_of_birth).toBe('1958-01-04');
    });
  }

  it('the prompt says the greeting already asked, and the yes goes to lookup_schedule', async () => {
    const agent = await agentFor(CORPUS[0]);
    const prompt = String((agent as any).instructions);
    expect(prompt).toContain('ASKED "Am I speaking with Zelda?"');
    expect(prompt).toContain('call lookup_schedule with first_name "Zelda"');
    expect(prompt).not.toContain('DO NOT OPEN WITH A NAME CONFIRMATION');
    // Still withheld until then.
    expect(prompt).not.toContain('Zebrastripe');
    expect(prompt).not.toContain('3:10 PM');
  });
});

describe('what the yes does NOT confirm', () => {
  const SID = 'CA0000000000000000000000000000a172';

  it('no greeting name (caller ID matched nobody with a first name): a candidate, no details', async () => {
    const agent = await agentFor(SID, null);
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.upcomingAppointments).toBeUndefined();
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a different first name ("no, this is her husband Jordan")', async () => {
    const agent = await agentFor(SID);
    const r = await call(agent, 'lookup_schedule', { first_name: 'Jordan' });
    expect(r.upcomingAppointments).toBeUndefined();
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('several people on the number', async () => {
    h.lookupByPhone.mockResolvedValue({ ...ONE_PERSON_ON_THE_NUMBER, identity: { unique: false, candidateCount: 2, candidates: [] } } as any);
    const agent = await agentFor(SID);
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.upcomingAppointments).toBeUndefined();
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('a stated date of birth that is not the record\'s', () => {
    expect(greetingYesConfirms(GREETED, ONE_PERSON_ON_THE_NUMBER as any, { first_name: 'Zelda', date_of_birth: '07/01/1990' })).toBe(false);
    expect(greetingYesConfirms(GREETED, ONE_PERSON_ON_THE_NUMBER as any, { first_name: 'Zelda', date_of_birth: '01/04/1958' })).toBe(true);
  });

  it('the greeting asked a different name from the record\'s', () => {
    expect(greetingYesConfirms({ matched: true, firstName: 'Ana' }, ONE_PERSON_ON_THE_NUMBER as any, { first_name: 'Zelda' })).toBe(false);
  });

  it('a name-and-date-of-birth match is not this path (it confirms the old way)', () => {
    expect(greetingYesConfirms(GREETED, { ...ONE_PERSON_ON_THE_NUMBER, matchedBy: 'name_and_dob' } as any, { first_name: 'Zelda' })).toBe(false);
  });
});

describe('the yes holds for the rest of the call (Codex P2 on #425)', () => {
  const SID = 'CA0000000000000000000000000000b172';

  it('a later phone-only lookup returns the confirmed appointment, not a candidate', async () => {
    const agent = await agentFor(SID);
    await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    const again = await call(agent, 'lookup_schedule', { phone: '5551234567' });
    expect(again.identityUnconfirmed).toBeUndefined();
    expect(again.upcomingAppointments).toHaveLength(1);
    expect(String(again.fix ?? '')).not.toMatch(/first_name, last_name and date_of_birth/);
  });

  it('only the record the yes confirmed, and only while it is still the cached one', () => {
    const ctx = { ...ONE_PERSON_ON_THE_NUMBER } as any;
    const held = { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', personId: 'p-synthetic' };
    expect(greetingConfirmedMatches(ctx, ctx, held)).toBe(true);
    expect(greetingConfirmedMatches(undefined, ctx, held)).toBe(false);
    expect(greetingConfirmedMatches(ctx, { ...ctx }, held)).toBe(false);
    expect(greetingConfirmedMatches(ctx, ctx, { ...held, firstName: 'Jordan' })).toBe(false);
    expect(greetingConfirmedMatches(ctx, ctx, { ...held, personId: 'p-other' })).toBe(false);
    expect(greetingConfirmedMatches(ctx, ctx, { ...held, dateOfBirth: '1990-07-01' })).toBe(false);
    expect(greetingConfirmedMatches(ctx, ctx, undefined)).toBe(false);
  });
});
