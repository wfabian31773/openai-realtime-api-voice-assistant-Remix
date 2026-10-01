/**
 * THE AFTER-HOURS PROMPT NEVER LEARNS A CALLER'S SURNAME OR DATE OF BIRTH
 * FROM A PREVIOUS CALL ON THE SAME NUMBER — on either pipeline.
 *
 * The corpus call, `CA32108e28bc5b21ca1514a126303d0671` (after-hours,
 * 2026-09-30 13:31 UTC): caller ID matched, the greeting used the first name,
 * the v47 redaction withheld the appointment. Then the model called
 * lookup_schedule(first_name, last_name, date_of_birth) BEFORE the caller had
 * said a surname or a date — both came from the CALLER HISTORY section, which
 * wrote the previous call's `KNOWN PATIENT: <name> (DOB: …)` into the prompt.
 * The caller then affirmed the first name and spoke the date; the surname
 * never came from them; the appointment was read; the full name was asked
 * afterwards. RULE ZERO step 2: match, VALIDATE, then join. Memory keyed on
 * the phone is a candidate exactly like the schedule match, and this test
 * drives the REAL agent (`createNoIvrAgent`) with a memory carrying every
 * field the old section rendered, on the SIP core's metadata and on the
 * runtime's, and reads the built prompt.
 *
 * Synthetic everything — RULE THREE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

/** The schedule's phone match: a candidate, one person's rows, matched on the number. */
const PHONE_MATCH = {
  patientFound: true,
  patientName: 'Zelda Quixote',
  matchedBy: 'phone' as const,
  identity: { unique: false, candidateCount: 2, candidates: [] },
  upcomingAppointments: [],
  pastAppointments: [
    { date: 'Monday, July 13, 2026', isoDate: '2026-07-13', dayOfWeek: 'Monday', timeOfDay: 'morning', startTime: '9:40 AM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe', status: 'Active', appointmentType: 'Post-op' },
  ],
  totalAppointmentsFound: 1,
  lastVisitDate: '2026-07-13',
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};

/** What the previous calls on this number remembered — every field the old section rendered. */
const MEMORY = {
  phoneNumber: '+15551234567',
  totalCalls: 5,
  lastCallDate: 'Yesterday',
  patientName: 'Zelda Quixote',
  patientDob: '01/04/1958',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
  lastLocationSeen: 'Quixotic Vision Testville',
  preferredContactMethod: 'text',
  recentCalls: [
    { date: 'Yesterday', reason: 'Asked when the last appointment was, latanoprost refill', outcome: 'Ticket created: VA-TEST-9', ticketNumber: 'VA-TEST-9' },
  ],
  openTickets: ['VA-TEST-9'],
  notes: '1 ticket(s) created in recent calls',
};

/** A surname, a date of birth, a doctor, an office, a summary: none may reach the prompt. */
const SECRETS = ['Quixote', '01/04/1958', '1958', 'Zebrastripe', 'Testville', 'latanoprost', 'July 13', '2026-07-13', '9:40'];

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  getCallerMemory: vi.fn(async () => null as any),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => undefined, getCallHistoryByPhone: async () => [] } }));
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
// The REAL renderer, with the memory lookup stubbed: the property under test is
// what the renderer puts in front of the model, not how the rows are fetched.
vi.mock('../services/callerMemoryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/callerMemoryService')>();
  return {
    ...actual,
    callerMemoryService: {
      getCallerMemory: (...a: unknown[]) => h.getCallerMemory(...(a as [])),
      buildContextForPrompt: actual.callerMemoryService.buildContextForPrompt.bind(actual.callerMemoryService),
    },
  };
});

const { createNoIvrAgent } = await import('./noIvrAgent');

const SID = 'CA0000000000000000000000000000c143';
const BASE = {
  callId: 'call-c143',
  callSid: SID,
  callerPhone: '+15551234567',
  precontext: { matched: true, firstName: 'Zelda' },
};

async function builtPrompt(meta: Record<string, unknown>): Promise<string> {
  const agent = await createNoIvrAgent(async () => {}, { ...BASE, ...meta } as any);
  return String((agent as any).instructions);
}

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(PHONE_MATCH as any);
  h.lookupByNameAndDOB.mockReset().mockResolvedValue(PHONE_MATCH as any);
  h.getCallerMemory.mockReset().mockResolvedValue(MEMORY as any);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe.each([
  ['the SIP core (legacy body)', {}],
  ['the runtime (Grok body)', { pipeline: 'runtime' }],
])('%s: caller memory on a phone match', (_label, meta) => {
  it('the prompt carries the history and none of the surname, date of birth, doctor, office or summary', async () => {
    const prompt = await builtPrompt(meta);
    expect(prompt).toContain('CALLER HISTORY (5 previous calls from this NUMBER)');
    expect(prompt).toContain('OPEN TICKETS: VA-TEST-9');
    for (const s of SECRETS) {
      expect(prompt, `the built prompt carries "${s}"`).not.toContain(s);
    }
    expect(prompt).not.toContain('KNOWN PATIENT');
  });

  it('nothing tells the model to skip the name or date-of-birth questions', async () => {
    const prompt = await builtPrompt(meta);
    expect(prompt).not.toMatch(/don't re-ask/i);
    expect(prompt).not.toMatch(/information you already have \(name, DOB\)/i);
    expect(prompt).toMatch(/do NOT skip the name or date-of-birth\s+questions/);
  });

  it('the sanctioned first-name path is untouched: the candidate is offered to confirm, the surname is not', async () => {
    const prompt = await builtPrompt(meta);
    expect(prompt).toContain('Is this for Zelda?');
    expect(prompt).toMatch(/am I speaking with\s+Zelda\?/);
    expect(prompt).not.toContain('Quixote');
  });

  it('a first-time caller gets no history section and the same redaction', async () => {
    h.getCallerMemory.mockResolvedValue(null);
    const prompt = await builtPrompt(meta);
    expect(prompt).not.toContain('CALLER HISTORY');
    expect(prompt).toContain('Is this for Zelda?');
    for (const s of SECRETS) expect(prompt).not.toContain(s);
  });
});

describe('the wiring, read from the source (failure mode 10)', () => {
  const src = readFileSync(fileURLToPath(new URL('./noIvrAgent.ts', import.meta.url)), 'utf8');

  it('the history section comes from the one renderer and nothing in the agent reads the name or date of birth off the memory', () => {
    expect(src).toMatch(/callerMemoryService\.buildContextForPrompt\(callerMemory\)/);
    expect(src).not.toMatch(/callerMemory\??\.patient(Name|Dob)/);
    expect(src).not.toMatch(/memory\??\.patient(Name|Dob)/);
  });

  it('the Grok body takes the same section, not its own rendering', () => {
    const grok = readFileSync(fileURLToPath(new URL('./noIvrPromptForGrok.ts', import.meta.url)), 'utf8');
    expect(grok).toMatch(/\$\{p\.callerHistorySection\}/);
    expect(grok).not.toMatch(/patientName|patientDob|KNOWN PATIENT/);
  });
});
