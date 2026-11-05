/**
 * THE AFTER-HOURS YES, CONFIRMED THROUGH THE PERSON BASE — v175.
 *
 * v172 made a caller's yes to "Am I speaking with <first name>?" confirm the
 * record on the after-hours line, but it checks the yes only against the
 * context loaded at call start, which on this lane is the appointment book's
 * phone search (cell and home phone, appointment rows). The queue lanes ask
 * the person base first and narrow a shared number by the affirmed first name
 * (v85, `findByPhone`).
 *
 * v172's first full night, 2026-11-04: 20 recognised after-hours callers said
 * yes, and on 4 the first `lookup_schedule` with the greeted first name
 * answered found: false, after which the agent asked the last name and the
 * date of birth. The greeted first name is ONE person in `patients_master` on
 * every one of the 4. The corpus (real SIDs, synthetic names — RULE THREE):
 *
 *   CA255f743ec7e4820aeacf08bf671689bd  the book has no rows for the number
 *   CAb7e5de3cff1431e9c924d230ea64e4f4  the book holds one person, not the greeted one
 *   CAcbe320f4c0f779d0432e96d172433f0d  the book holds two people on the number
 *   CAe147d466eab4bfb7bf1f203fae55a04f  the book holds three people on the number
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const CALLER_PHONE = '+15551234567';
const ZELDA = { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', personId: 'p-zelda' };
const APPT = {
  date: 'Tuesday, December 31, 2041', isoDate: '2041-12-31', dayOfWeek: 'Tuesday', timeOfDay: 'afternoon',
  startTime: '3:10 PM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe',
  status: 'Active', appointmentType: 'Dilated Exam',
};

/** What the person base answers for the number narrowed by "Zelda": one person, joined on PersonID. */
const PERSON_BASE_ZELDA = {
  patientFound: true,
  patientName: 'Zelda Quixote',
  matchedBy: 'phone' as const,
  identityUnconfirmed: true,
  identity: { unique: true, candidateCount: 1, candidates: [] },
  patientData: ZELDA,
  upcomingAppointments: [APPT],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};

const EMPTY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };
const someoneElse = (firstName: string) => ({
  patientFound: true, patientName: `${firstName} Quixote`, matchedBy: 'phone' as const, identityUnconfirmed: true,
  identity: { unique: true, candidateCount: 1, candidates: [] },
  patientData: { firstName, lastName: 'Quixote', dateOfBirth: '1931-07-07', personId: `p-${firstName}` },
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 1,
});
const severalPeople = (n: number) => ({
  patientFound: true, patientName: 'Yolanda Quixote', matchedBy: 'phone' as const,
  identity: { unique: false, candidateCount: n, candidates: [] },
  patientData: { firstName: 'Yolanda', lastName: 'Quixote', dateOfBirth: '1960-02-02' },
  upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: n,
});

/** The start-of-call context the book gave each corpus call. */
const CORPUS = [
  ['CA255f743ec7e4820aeacf08bf671689bd', 'the book has no rows for the number', EMPTY],
  ['CAb7e5de3cff1431e9c924d230ea64e4f4', 'the book holds one person, not the greeted one', someoneElse('Yolanda')],
  ['CAcbe320f4c0f779d0432e96d172433f0d', 'the book holds two people', severalPeople(2)],
  ['CAe147d466eab4bfb7bf1f203fae55a04f', 'the book holds three people', severalPeople(3)],
] as const;

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(),
  lookupPatient: vi.fn(),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
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
    submitSimplifiedTicket: async () => ({ success: true, ticketNumber: 'VA-TEST' }),
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
      lookupPatient: (...a: unknown[]) => h.lookupPatient(...(a as [])),
      lookupByNameAndDOB: (...a: unknown[]) => h.lookupByNameAndDOB(...(a as [])),
      formatContextForAgent: actual.scheduleLookupService.formatContextForAgent.bind(actual.scheduleLookupService),
    },
  };
});
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent, greetingYesFromPersonBase } = await import('./noIvrAgent');
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
  createNoIvrAgent(async () => {}, {
    callId: `call-${callSid}`, callSid, callerPhone: CALLER_PHONE, precontext, pipeline: 'runtime',
  } as any);

beforeEach(() => {
  h.lookupByPhone.mockReset();
  h.lookupPatient.mockReset().mockResolvedValue(PERSON_BASE_ZELDA as any);
  h.lookupByNameAndDOB.mockClear();
  resetVerifiedIdentities();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('the corpus: the yes is confirmed by the person base when the book cannot', () => {
  for (const [sid, shape, startContext] of CORPUS) {
    it(`${sid} (${shape}): found and confirmed on the first lookup, and the ticket inherits the record`, async () => {
      h.lookupByPhone.mockResolvedValue(startContext as any);
      const agent = await agentFor(sid);
      const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
      expect(r.found).toBe(true);
      expect(r.identityUnconfirmed).toBeUndefined();
      expect(r.upcomingAppointments).toHaveLength(1);
      // The queue lanes' question: the calling number, narrowed by the affirmed name.
      expect(h.lookupPatient).toHaveBeenCalledWith({ phone: CALLER_PHONE, firstName: 'Zelda' });
      const held = verifiedIdentityFor(sid);
      expect(held?.certain).toBe(true);
      expect(held?.dateOfBirth).toBe('1958-01-04');
      const filed = prepareTicketIdentity({ call_sid: sid, first_name: 'Zelda' });
      expect(filed.missing).toBeUndefined();
      expect(filed.input.last_name).toBe('Quixote');
      expect(filed.input.date_of_birth).toBe('1958-01-04');
    });
  }

  it('a later phone-only lookup on the same call reuses the confirmed record', async () => {
    h.lookupByPhone.mockResolvedValue(severalPeople(2) as any);
    const agent = await agentFor(CORPUS[2][0]);
    await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    const again = await call(agent, 'lookup_schedule', { phone: CALLER_PHONE });
    expect(again.found).toBe(true);
    expect(again.identityUnconfirmed).toBeUndefined();
  });
});

describe('what stays exactly as it was', () => {
  it('a start-of-call context that already confirms the yes asks the person base nothing', async () => {
    h.lookupByPhone.mockResolvedValue({ ...PERSON_BASE_ZELDA } as any);
    const agent = await agentFor('CAa0000000000000000000000000000001');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.found).toBe(true);
    expect(h.lookupPatient).not.toHaveBeenCalled();
  });

  it('two people on the number who share the first name stay two people (the person base reports them ambiguous)', async () => {
    h.lookupByPhone.mockResolvedValue(severalPeople(2) as any);
    h.lookupPatient.mockResolvedValue({ ...EMPTY, identity: { unique: false, candidateCount: 2, candidates: [] } } as any);
    const agent = await agentFor('CAa0000000000000000000000000000002');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.found).toBe(false);
    expect(verifiedIdentityFor('CAa0000000000000000000000000000002')).toBeUndefined();
  });

  it('a person-base record whose first name is not the one the caller said yes to is not confirmed', async () => {
    h.lookupByPhone.mockResolvedValue(EMPTY as any);
    h.lookupPatient.mockResolvedValue(someoneElse('Zeldina') as any);
    const agent = await agentFor('CAa0000000000000000000000000000003');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.found).toBe(false);
    expect(verifiedIdentityFor('CAa0000000000000000000000000000003')).toBeUndefined();
  });

  it('a stated date of birth that disagrees with the record leaves the caller unconfirmed', async () => {
    h.lookupByPhone.mockResolvedValue(EMPTY as any);
    const agent = await agentFor('CAa0000000000000000000000000000004');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda', date_of_birth: '07/07/1931' });
    expect(r.identityUnconfirmed === true || r.found === false).toBe(true);
    expect(verifiedIdentityFor('CAa0000000000000000000000000000004')).toBeUndefined();
  });

  it('a first name the greeting did not ask asks the person base nothing', async () => {
    h.lookupByPhone.mockResolvedValue(EMPTY as any);
    const agent = await agentFor('CAa0000000000000000000000000000005');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Yolanda' });
    expect(r.found).toBe(false);
    expect(h.lookupPatient).not.toHaveBeenCalled();
  });

  it('an unrecognised caller (no greeting name) asks the person base nothing', async () => {
    h.lookupByPhone.mockResolvedValue(EMPTY as any);
    const agent = await agentFor('CAa0000000000000000000000000000006', { matched: false });
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.found).toBe(false);
    expect(h.lookupPatient).not.toHaveBeenCalled();
  });

  it('a person base that throws leaves the lookup as it was, and never throws itself', async () => {
    h.lookupByPhone.mockResolvedValue(EMPTY as any);
    h.lookupPatient.mockRejectedValue(new Error('console unreachable'));
    const agent = await agentFor('CAa0000000000000000000000000000007');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
    expect(r.found).toBe(false);
  });
});

describe('the helper on its own', () => {
  const lookup = async () => PERSON_BASE_ZELDA as any;
  it('confirms the greeted name and its first word only', async () => {
    expect(await greetingYesFromPersonBase(GREETED, CALLER_PHONE, { first_name: 'zelda' }, lookup)).toBeTruthy();
    expect(await greetingYesFromPersonBase({ matched: true, firstName: 'Zelda Mae' }, CALLER_PHONE, { first_name: 'Zelda' }, lookup)).toBeTruthy();
    expect(await greetingYesFromPersonBase(GREETED, CALLER_PHONE, { first_name: 'Zel' }, lookup)).toBeUndefined();
  });
  it('needs a calling number', async () => {
    expect(await greetingYesFromPersonBase(GREETED, undefined, { first_name: 'Zelda' }, lookup)).toBeUndefined();
    expect(await greetingYesFromPersonBase(GREETED, '  ', { first_name: 'Zelda' }, lookup)).toBeUndefined();
  });
  it('a stated surname that is not the record\'s is not confirmed', async () => {
    expect(await greetingYesFromPersonBase(GREETED, CALLER_PHONE, { first_name: 'Zelda', last_name: 'Other' }, lookup)).toBeUndefined();
  });
});

describe('the wiring', () => {
  const src = readFileSync('src/agents/noIvrAgent.ts', 'utf8');
  it('lookup_schedule asks the person base only after the start-of-call context fails to confirm, and uses lookupPatient', () => {
    const at = src.indexOf('const yesFromPersonBase =');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block).toContain('!(scheduleContext && greetingYesConfirms(metadata.precontext, scheduleContext, params))');
    expect(block).toContain('scheduleLookupService.lookupPatient(q)');
  });
  it('the confirmed person-base record is used as confirmed by the greeting', () => {
    const at = src.indexOf('} else if (yesFromPersonBase) {');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 400);
    expect(block).toContain('result = yesFromPersonBase;');
    expect(block).toContain('confirmedByGreeting = true;');
  });
});
