/**
 * A CONFIRMED AFTER-HOURS CALLER IS NOT ASKED THEIR LAST NAME OR DATE OF BIRTH — v194.
 *
 * v172 (operator 2026-11-03, "After-hours too") made the caller's yes to the
 * greeting's "Am I speaking with <first name>?" confirm the record, and
 * `prepareTicketIdentity` files the record's last name and date of birth with
 * no question asked (noIvrTheGreetingYesConfirms.test.ts). The model kept
 * asking anyway: the confirmed lookup_schedule result said nothing about it,
 * create_ticket's description said "Call this ONLY when you have collected ALL
 * required fields", and the prompt's summary template carried "date of birth
 * [DOB]". RULE ZERO step 5: nothing re-asks a field the record holds.
 *
 * BEFORE, no-ivr, callers who said yes to the greeting and were then asked
 * "last name" or "date of birth" (the Daybook's matcher): 2026-11-05 10 of 23,
 * 11-06 5 of 25, 11-07 24 of 49, 11-08 15 of 25, 11-09 12 of 27 — 66 of 149.
 * Every one of 2026-11-09's 12 had a CONFIRMED lookup_schedule before the ask
 * (its outcome carries upcomingCount, which only the confirmed branch returns).
 * They are the corpus here (real SIDs, synthetic patient — RULE THREE).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

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
    { date: 'Tuesday, December 31, 2041', isoDate: '2041-12-31', dayOfWeek: 'Tuesday', timeOfDay: 'morning',
      startTime: '8:50 AM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe',
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

const { createNoIvrAgent, RECORD_HOLDS_THE_IDENTITY_FIX, recordHoldsTheIdentity } = await import('./noIvrAgent');
const { resetVerifiedIdentities } = await import('../tools/verifiedIdentity');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const GREETED = { matched: true, firstName: 'Zelda' };
const agentFor = (callSid: string, precontext: unknown = GREETED) =>
  createNoIvrAgent(async () => {}, {
    callId: `call-${callSid}`, callSid, callerPhone: '+15551234567', precontext, pipeline: 'runtime',
  } as any);

/** 2026-11-09, no-ivr: said yes to the greeting, confirmed lookup, then asked again. */
const CORPUS = [
  'CA7c8ceb4b9720eeeed5cae8f00ef8f853', 'CAcc3d64658bb0dc6f6c502ba1bdee0f46',
  'CA2eae1724e6da8f9414a8e1c874069642', 'CA91e983e37bf87db91242fe81b829472f',
  'CAa2d5d2326433060099899e18766d0665', 'CAe97c49b6149e8642480e4ee65d58e523',
  'CAa0a53f51a524bca3e0b945ef773507e7', 'CAe58dadf1df4a4295a86703f863143f1e',
  'CAb88bf354b14e670997c75d4056e8cae4', 'CA81a905c42d769e6743847f228862a6d6',
  'CA16847ebec2365977bdafa13a6390df6e', 'CA08711c5ad6c4bcb8419aa687bd5576ea',
] as const;

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(ONE_PERSON_ON_THE_NUMBER as any);
  h.lookupByNameAndDOB.mockClear();
  h.submitSimplifiedTicket.mockClear();
  resetVerifiedIdentities();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the corpus: a confirmed lookup tells the model the record holds the last name and date of birth', () => {
  for (const sid of CORPUS) {
    it(`${sid}: the yes lookup says so, and the ticket files with the first name alone`, async () => {
      const agent = await agentFor(sid);
      const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
      expect(r.upcomingAppointments).toHaveLength(1);
      expect(r.identity_on_record).toBe(true);
      expect(r.fix).toBe(RECORD_HOLDS_THE_IDENTITY_FIX);
      // The instruction is for the model, never a line to speak (v43).
      expect(r.message).toBeUndefined();

      // And it is TRUE: create_ticket with no last name and no date of birth
      // files the record's, so not asking costs the ticket nothing.
      const t = await call(agent, 'create_ticket', {
        first_name: 'Zelda', callback_number: '5551234567',
        request_category: 'cancel_appointment', request_summary: 'Cancel the appointment; caller is unwell.',
      });
      expect(t.success).toBe(true);
      expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
      const payload = h.submitSimplifiedTicket.mock.calls[0][0];
      expect(payload.patientFullName).toBe('Zelda Quixote');
      expect(payload.patientDOB).toBe('01/04/1958');
    });
  }
});

describe('the instruction says what it must, and only on a confirmed record', () => {
  it('forbids both asks, keeps the date of birth out of the summary, and keeps the someone-else exception', () => {
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/last name and date of birth/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/Do not ask the caller for either/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/date of birth out of your summary/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/someone else, take that patient's name and date of birth/);
  });

  it('a phone-only candidate gets no such instruction (standing instruction 6)', async () => {
    const agent = await agentFor('CA0000000000000000000000000000d194', null);
    const r = await call(agent, 'lookup_schedule', { phone: '+15551234567' });
    expect(r.identityUnconfirmed).toBe(true);
    expect(r.identity_on_record).toBeUndefined();
    expect(r.fix).not.toBe(RECORD_HOLDS_THE_IDENTITY_FIX);
  });

  it('a confirmed chart with no date of birth on file is not said to hold one (Codex on #443)', async () => {
    const NO_DOB = { firstName: 'Zelda', lastName: 'Quixote', personId: 'p-synthetic' };
    h.lookupByPhone.mockReset().mockResolvedValue({
      ...ONE_PERSON_ON_THE_NUMBER,
      identity: { unique: true, candidateCount: 1, candidates: [{ ...NO_DOB, appointmentCount: 1 }] },
      patientData: NO_DOB,
    } as any);
    const agent = await agentFor('CA0000000000000000000000000000a194');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.identity_on_record).toBeUndefined();
    expect(r.fix).not.toBe(RECORD_HOLDS_THE_IDENTITY_FIX);
  });

  it('holds the identity only with a last name and a readable date of birth', () => {
    expect(recordHoldsTheIdentity({ lastName: 'Quixote', dateOfBirth: '1958-01-04' })).toBe(true);
    expect(recordHoldsTheIdentity({ lastName: 'Quixote' })).toBe(false);
    expect(recordHoldsTheIdentity({ lastName: 'Quixote', dateOfBirth: 'unknown' })).toBe(false);
    expect(recordHoldsTheIdentity({ lastName: ' ', dateOfBirth: '1958-01-04' })).toBe(false);
    expect(recordHoldsTheIdentity(undefined)).toBe(false);
  });

  it('a different first name ("no, this is her husband") gets no such instruction', async () => {
    const agent = await agentFor('CA0000000000000000000000000000e194');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Jordan' });
    expect(r.upcomingAppointments).toBeUndefined();
    expect(r.identity_on_record).toBeUndefined();
  });
});

describe('the prompt and the tool no longer tell the model to collect what the record holds', () => {
  it('create_ticket no longer says "collected ALL required fields", and says not to ask', async () => {
    const agent: any = await agentFor('CA0000000000000000000000000000f194');
    const desc = agent.tools.find((t: any) => t.name === 'create_ticket').description as string;
    expect(desc).not.toMatch(/collected ALL required fields/);
    expect(desc).toMatch(/When lookup_schedule confirmed the caller, the record supplies last_name and\s+date_of_birth: do not ask for them\./);
  });

  it('the runtime body says a confirmed lookup holds both, and to omit a held date of birth from the summary', async () => {
    const agent: any = await agentFor('CA0000000000000000000000000000f195');
    const prompt = String(agent.instructions);
    expect(prompt).toMatch(/a confirmed lookup_schedule holds last name and DOB: ask neither/);
    expect(prompt).toMatch(/\[reason\]\." Omit a DOB the record holds\./);
    // The ruling the rulings map pins is kept word for word.
    expect(prompt).toMatch(/Use the validated record's DOB and clinic if held/);
  });

  it('the source carries the fix on the confirmed branch only (the reading a mutation would break)', () => {
    const src = readFileSync(new URL('./noIvrAgent.ts', import.meta.url), 'utf8');
    const confirmedReturn = src.indexOf('identity_on_record: true');
    expect(confirmedReturn).toBeGreaterThan(src.indexOf('rememberVerifiedIdentity(metadata.callSid, { ...result.patientData'));
  });
});
