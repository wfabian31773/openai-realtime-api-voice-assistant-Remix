/**
 * AN AFTER-HOURS TICKET IS NAMED FOR THE PATIENT THE CALL LOOKED UP — v264.
 *
 * The before, no-ivr, `tool_call_payloads` 2026-11-15..22: a caller calling for
 * someone else gave the patient's name and date of birth, `lookup_schedule`
 * confirmed that patient, and `create_ticket` was then sent the CALLER's first
 * name (on VA-87261 the caller's whole name) beside the patient's date of birth.
 * The ticket went out under a name nobody on file has with that date of birth.
 * Of the 110 calls with a found lookup and then a ticket in that window, 3:
 *
 *   VA-87261  CA4ce0a96441ccf3658a4763d341d9034a  first and last name differ
 *   VA-87782  CA8203233402d094524387c2d4a611741b  first name differs
 *   VA-88307  CAcbaf44534d401fb7a2d4369eb44b2374  first name differs
 *
 * The control, VA-86173 CA234520365651d9181319016c6e4c9a4a, filed a second
 * person the call had looked up by that first name, and stays as it was.
 *
 * Real SIDs and ticket numbers, synthetic people (RULE THREE). The agent is the
 * real one; only the schedule, the person base and the ticket sink are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const PATIENT = { firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', personId: 'p-zelda' };
const contextFor = (p: typeof PATIENT) => ({
  patientFound: true,
  patientName: `${p.firstName} ${p.lastName}`,
  matchedBy: 'name_and_dob' as const,
  identity: { unique: true, candidateCount: 1, candidates: [{ ...p, appointmentCount: 1 }] },
  patientData: p,
  upcomingAppointments: [
    { date: 'Tuesday, December 31, 2041', isoDate: '2041-12-31', dayOfWeek: 'Tuesday', timeOfDay: 'morning',
      startTime: '8:50 AM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe',
      status: 'Active', appointmentType: 'Dilated Exam' },
  ],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
});
const NOT_FOUND = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

const h = vi.hoisted(() => ({
  lookupByNameAndDOB: vi.fn(),
  verifyPatient: vi.fn(),
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
vi.mock('../services/patientVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/patientVerification')>()),
  verifyPatient: (...a: unknown[]) => h.verifyPatient(...(a as [])),
}));
vi.mock('../services/scheduleLookupService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/scheduleLookupService')>();
  return {
    ...actual,
    scheduleLookupService: {
      lookupByPhone: async () => NOT_FOUND,
      lookupPatient: async () => NOT_FOUND,
      lookupByNameAndDOB: (...a: unknown[]) => h.lookupByNameAndDOB(...(a as [])),
      formatContextForAgent: actual.scheduleLookupService.formatContextForAgent.bind(actual.scheduleLookupService),
    },
  };
});
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent, RECORD_HOLDS_THE_IDENTITY_FIX } = await import('./noIvrAgent');
const { resetVerifiedIdentities } = await import('../tools/verifiedIdentity');
const { recordNameForTheFiling } = await import('./afterHoursFiledName');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const agentFor = (callSid: string) =>
  createNoIvrAgent(async () => {}, {
    callId: `call-${callSid}`, callSid, callerPhone: '+15551234567', precontext: null, pipeline: 'runtime',
  } as any);

/** The person base's answers, in the shape `verifyPatient` gives them. */
const NOBODY_ON_FILE = { verified: false, reason: 'no_match', candidates: 0 };
const THE_HELD_PATIENT = {
  verified: true, reason: 'match', candidates: 1, source: 'mirror',
  patient: { personId: 'p-zelda', personNbr: '1', firstName: 'Zelda', lastName: 'Quixote', dob: '1958-01-04', hasMedicalRecord: true },
};

const ticket = (first: string, last: string, dob: string) => ({
  first_name: first, last_name: last, date_of_birth: dob, callback_number: '5551234567',
  request_category: 'cancel_appointment', request_summary: 'Cancel the appointment; the patient is unwell.',
});
const payload = () => h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, any>;

async function lookUpZelda(agent: any) {
  const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda', last_name: 'Quixote', date_of_birth: '01/04/1958' });
  expect(r.found).toBe(true);
  expect(r.identity_on_record).toBe(true);
}

beforeEach(() => {
  h.lookupByNameAndDOB.mockReset().mockImplementation(async (first: string) =>
    first.trim().toLowerCase() === 'zelda' ? contextFor(PATIENT) : NOT_FOUND);
  h.verifyPatient.mockReset().mockResolvedValue(NOBODY_ON_FILE);
  h.submitSimplifiedTicket.mockClear();
  resetVerifiedIdentities();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the corpus: a ticket filed under another name beside the looked-up patient\'s date of birth', () => {
  it('VA-87261 CA4ce0a96441ccf3658a4763d341d9034a: the caller\'s whole name, nobody on file with it', async () => {
    const agent = await agentFor('CA4ce0a96441ccf3658a4763d341d9034a');
    await lookUpZelda(agent);
    const t = await call(agent, 'create_ticket', ticket('Marta', 'Ruiz', '01/04/1958'));
    expect(t.success).toBe(true);
    expect(h.verifyPatient).toHaveBeenCalledWith({ firstName: 'Marta', lastName: 'Ruiz', dob: '1958-01-04' });
    expect(payload().patientFullName).toBe('Zelda Quixote');
    expect(payload().patientDOB).toBe('01/04/1958');
    expect(payload().additionalDetails).toMatch(/NAME CORRECTED TO THE RECORD: the agent filed this as "Marta Ruiz"/);
  });

  it('VA-87782 CA8203233402d094524387c2d4a611741b: the caller\'s first name, which the person base resolves to the patient', async () => {
    h.verifyPatient.mockResolvedValue(THE_HELD_PATIENT);
    const agent = await agentFor('CA8203233402d094524387c2d4a611741b');
    await lookUpZelda(agent);
    await call(agent, 'create_ticket', ticket('Marta', 'Quixote', '01/04/1958'));
    expect(payload().patientFullName).toBe('Zelda Quixote');
    expect(payload().additionalDetails).toMatch(/"Marta Quixote"/);
  });

  it('VA-88307 CAcbaf44534d401fb7a2d4369eb44b2374: the caller\'s first name, the date said in words', async () => {
    h.verifyPatient.mockResolvedValue(THE_HELD_PATIENT);
    const agent = await agentFor('CAcbaf44534d401fb7a2d4369eb44b2374');
    await lookUpZelda(agent);
    await call(agent, 'create_ticket', ticket('Bea', 'Quixote', 'January 4, 1958'));
    expect(payload().patientFullName).toBe('Zelda Quixote');
    expect(payload().patientDOB).toBe('01/04/1958');
    // The record's office reaches the ticket with the record's name.
    expect(payload().locationOfLastVisit).toBe('Quixotic Vision Testville');
  });
});

describe('what stays as the agent sent it', () => {
  it('VA-86173 CA234520365651d9181319016c6e4c9a4a: a second person the call looked up by that first name', async () => {
    const agent = await agentFor('CA234520365651d9181319016c6e4c9a4a');
    await lookUpZelda(agent);
    const miss = await call(agent, 'lookup_schedule', { first_name: 'Bruno', last_name: 'Quixote', date_of_birth: '01/04/1958' });
    expect(miss.found).toBe(false);
    await call(agent, 'create_ticket', ticket('Bruno', 'Quixote', '01/04/1958'));
    expect(h.verifyPatient).not.toHaveBeenCalled();
    expect(payload().patientFullName).toBe('Bruno Quixote');
    expect(payload().additionalDetails ?? '').not.toMatch(/NAME CORRECTED/);
  });

  it('the record\'s own first name after a lookup under another spelling of it', async () => {
    h.lookupByNameAndDOB.mockImplementation(async (first: string) =>
      first.trim().toLowerCase().startsWith('zel') ? contextFor(PATIENT) : NOT_FOUND);
    const agent = await agentFor('CA00000000000000000000000000a10264');
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zellda', last_name: 'Quixote', date_of_birth: '01/04/1958' });
    expect(r.found).toBe(true);
    await call(agent, 'create_ticket', ticket('Zelda', 'Quixote', '01/04/1958'));
    expect(h.verifyPatient).not.toHaveBeenCalled();
    expect(payload().patientFullName).toBe('Zelda Quixote');
    expect(payload().additionalDetails ?? '').not.toMatch(/NAME CORRECTED/);
  });

  it('a date of birth that is not the looked-up patient\'s', async () => {
    const agent = await agentFor('CA00000000000000000000000000a00264');
    await lookUpZelda(agent);
    await call(agent, 'create_ticket', ticket('Marta', 'Ruiz', '02/09/1984'));
    expect(h.verifyPatient).not.toHaveBeenCalled();
    expect(payload().patientFullName).toBe('Marta Ruiz');
  });

  it('the record\'s own names', async () => {
    const agent = await agentFor('CA00000000000000000000000000b00264');
    await lookUpZelda(agent);
    await call(agent, 'create_ticket', ticket('Zelda', 'Quixote', '01/04/1958'));
    expect(h.verifyPatient).not.toHaveBeenCalled();
    expect(payload().patientFullName).toBe('Zelda Quixote');
    expect(payload().additionalDetails ?? '').not.toMatch(/NAME CORRECTED/);
  });

  it('no patient looked up on the call', async () => {
    const agent = await agentFor('CA00000000000000000000000000c00264');
    await call(agent, 'create_ticket', ticket('Marta', 'Ruiz', '01/04/1958'));
    expect(h.verifyPatient).not.toHaveBeenCalled();
    expect(payload().patientFullName).toBe('Marta Ruiz');
  });

  const otherAnswers: Array<[string, unknown]> = [
    ['a twin on file with that name and date of birth', {
      verified: true, reason: 'match', candidates: 2, source: 'mirror',
      patient: { personId: 'p-twin', personNbr: '2', firstName: 'Marta', lastName: 'Quixote', dob: '1958-01-04', hasMedicalRecord: true },
    }],
    ['two people the person base cannot tell apart', { verified: false, reason: 'ambiguous', candidates: 2 }],
    ['the appointment book answering because the mirror is down', { verified: false, reason: 'no_match', candidates: 0, source: 'schedule' }],
    ['the appointment book naming the patient', { ...THE_HELD_PATIENT, source: 'schedule' }],
    ['the person base unreachable', { verified: false, reason: 'unavailable', candidates: 0 }],
  ];
  for (const [label, answer] of otherAnswers) {
    it(`${label}`, async () => {
      h.verifyPatient.mockResolvedValue(answer);
      const agent = await agentFor('CA00000000000000000000000000d00264');
      await lookUpZelda(agent);
      await call(agent, 'create_ticket', ticket('Marta', 'Quixote', '01/04/1958'));
      expect(h.verifyPatient).toHaveBeenCalledTimes(1);
      expect(payload().patientFullName).toBe('Marta Quixote');
    });
  }

  it('a person base that throws', async () => {
    h.verifyPatient.mockRejectedValue(new Error('connection reset'));
    const agent = await agentFor('CA00000000000000000000000000e00264');
    await lookUpZelda(agent);
    const t = await call(agent, 'create_ticket', ticket('Marta', 'Quixote', '01/04/1958'));
    expect(t.success).toBe(true);
    expect(payload().patientFullName).toBe('Marta Quixote');
  });
});

describe('the rule on its own', () => {
  const held = async (callSid: string, p: Partial<typeof PATIENT> = PATIENT) => {
    const { rememberVerifiedIdentity } = await import('../tools/verifiedIdentity');
    rememberVerifiedIdentity(callSid, { ...p, certain: true } as any);
  };
  const ask = (callSid: string, over: Partial<Parameters<typeof recordNameForTheFiling>[0]> = {}) =>
    recordNameForTheFiling({
      callSid, firstName: 'Marta', lastName: 'Ruiz', dateOfBirth: '01/04/1958',
      lookedUpFirstNames: new Set(['zelda']), verify: h.verifyPatient as any, ...over,
    });

  it('needs a held identity that is certain', async () => {
    const { rememberVerifiedIdentity } = await import('../tools/verifiedIdentity');
    rememberVerifiedIdentity('CA00000000000000000000000000f00264', { ...PATIENT, certain: false } as any);
    expect(await ask('CA00000000000000000000000000f00264')).toBeUndefined();
  });

  it('needs a last name to look for', async () => {
    await held('CA00000000000000000000000000f10264');
    expect(await ask('CA00000000000000000000000000f10264', { lastName: ' ' })).toBeUndefined();
    expect(h.verifyPatient).not.toHaveBeenCalled();
  });

  it('needs a date of birth that reads', async () => {
    await held('CA00000000000000000000000000f20264');
    expect(await ask('CA00000000000000000000000000f20264', { dateOfBirth: 'unknown' })).toBeUndefined();
  });

  it('matches the held patient by person id when the record has one, and by name and date without', async () => {
    await held('CA00000000000000000000000000f30264');
    h.verifyPatient.mockResolvedValue({ ...THE_HELD_PATIENT, patient: { ...THE_HELD_PATIENT.patient, personId: 'p-other' } });
    expect(await ask('CA00000000000000000000000000f30264')).toBeUndefined();

    const { personId: _drop, ...noId } = PATIENT;
    await held('CA00000000000000000000000000f40264', noId);
    h.verifyPatient.mockResolvedValue(THE_HELD_PATIENT);
    expect(await ask('CA00000000000000000000000000f40264')).toEqual({ firstName: 'Zelda', lastName: 'Quixote', dateOfBirth: '1958-01-04', filedAs: 'Marta Ruiz' });
    h.verifyPatient.mockResolvedValue({ ...THE_HELD_PATIENT, patient: { ...THE_HELD_PATIENT.patient, dob: '1958-01-05' } });
    expect(await ask('CA00000000000000000000000000f40264')).toBeUndefined();
  });

  it('folds the first name the way the lookups were noted', async () => {
    await held('CA00000000000000000000000000f50264');
    expect(await ask('CA00000000000000000000000000f50264', { lookedUpFirstNames: new Set(['marta']), firstName: ' MARTA ' })).toBeUndefined();
    expect(h.verifyPatient).not.toHaveBeenCalled();
  });
});

describe('the confirmed lookup names whose first name to file', () => {
  it('says the patient\'s, never the caller\'s own, and keeps what v194 pinned', () => {
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/the looked-up patient's first name/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/never the caller's own/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).not.toMatch(/their first name/);
    expect(RECORD_HOLDS_THE_IDENTITY_FIX).toMatch(/Do not ask the caller for either/);
  });

  it('the person base is imported statically (the v141 rule) and every lookup notes its first name', () => {
    const src = readFileSync(new URL('./noIvrAgent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^import \{ verifyPatient \} from '\.\.\/services\/patientVerification';$/m);
    expect(src).not.toMatch(/import\(['"]\.\.\/services\/patientVerification['"]\)/);
    const lookup = src.indexOf('name: "lookup_schedule"');
    const noted = src.indexOf('lookedUpFirstNames.add(nameKey(params.first_name))');
    expect(noted).toBeGreaterThan(lookup);
    expect(noted).toBeLessThan(src.indexOf('let result: PatientScheduleContext;', lookup));
  });
});
