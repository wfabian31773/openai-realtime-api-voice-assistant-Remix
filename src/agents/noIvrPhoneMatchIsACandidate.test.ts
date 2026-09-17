/**
 * THE AFTER-HOURS LINE DOES NOT READ AN APPOINTMENT TO WHOEVER HOLDS THE PHONE.
 *
 * MEASURED 2026-09-17, no-ivr, substantive calls, 2026-09-09..17 (365 calls):
 * the agent read an appointment — a date with a time — on 81 of them, and on
 * **44** it did so BEFORE any identity question at all. Three hand-read calls
 * from 2026-09-16 (`…8ddc20db13`, `…97b763ab94`, `…e07a57a56e`) show the
 * shape exactly: "I just wanna know my appointment" is answered with the date,
 * time, office and doctor of whoever the schedule matched to the calling
 * number, and the name is confirmed afterwards or never.
 *
 * WHY THE PROMPT ALONE COULD NOT STOP IT. The details were IN the prompt —
 * `formatContextForAgent` renders every upcoming appointment into the PATIENT
 * CONTEXT section — with "AFTER IDENTITY CONFIRMED (in Phase 4): You MAY
 * answer" underneath. A sequencing instruction in front of text the model can
 * already see is not a gate; the pre-context block eleven lines up says
 * "Disclose nothing from anyone's record on the strength of this match" and
 * was ignored on all three calls.
 *
 * RULE ZERO step 2 and standing instruction 6: a phone match is a candidate to
 * CONFIRM, never an identity. So the fix is mechanical, not verbal: a phone
 * match puts a REDACTED section in the prompt (the first name, and how to get
 * the rest), and the tool's phone-only path returns a candidate and no
 * details. The identity standard is Phase 4's own — confirm the name on file,
 * then the date of birth — and the appointment comes back through
 * lookup_schedule(first_name, last_name, date_of_birth) from the tool result.
 *
 * Synthetic patient, synthetic office, synthetic doctor — RULE THREE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

/** What the schedule says about the number that is calling. Every string is
 *  deliberately one that appears nowhere else in the prompt. */
const PHONE_MATCH = {
  patientFound: true,
  patientName: 'Zelda Quixote',
  matchedBy: 'phone' as const,
  upcomingAppointments: [
    {
      date: 'Thursday, October 15, 2026',
      isoDate: '2026-10-15',
      dayOfWeek: 'Thursday',
      timeOfDay: 'afternoon',
      startTime: '3:10 PM',
      location: 'Quixotic Vision Testville',
      provider: 'Dr. Xavier Zebrastripe',
      status: 'Active',
      appointmentType: 'Dilated Exam',
    },
  ],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};
const SECRETS = ['October 15', '2026-10-15', '3:10 PM', 'Quixotic Vision Testville', 'Zebrastripe', 'Dilated Exam', 'Quixote'];

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { updateCallLog: async () => undefined } }));
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

const { createNoIvrAgent, buildNoIvrSystemPrompt, phoneMatchIsUnconfirmed } = await import('./noIvrAgent');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const SID = 'CA0000000000000000000000000000c142';
const META = { callId: 'call-c142', callSid: SID, callerPhone: '+15551234567' };

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(PHONE_MATCH as any);
  h.lookupByNameAndDOB.mockReset().mockResolvedValue(PHONE_MATCH as any);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('a phone match puts a CANDIDATE in the prompt, never the appointment', () => {
  it('the built agent knows the first name and NOT the date, time, office or doctor', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const prompt = String((agent as any).instructions);
    expect(prompt).toContain('PHONE MATCH — UNCONFIRMED');
    expect(prompt).toContain('Is this for Zelda?');
    for (const s of SECRETS.filter((x) => x !== 'Quixote')) {
      expect(prompt, `the prompt carries "${s}" on a phone match`).not.toContain(s);
    }
    // The last name is not spoken first (the pre-context block's own rule), so
    // it is not in the prompt either.
    expect(prompt).not.toContain('Quixote');
    expect(prompt).not.toContain('AFTER IDENTITY CONFIRMED (in Phase 4)');
  });

  it('tells the model the way back to the details: name, then date of birth, then the tool', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const prompt = String((agent as any).instructions);
    const section = prompt.slice(prompt.indexOf('PHONE MATCH — UNCONFIRMED'));
    expect(section).toMatch(/date of birth \(month, then\s+day, then year\)/);
    expect(section).toContain('call lookup_schedule(first_name, last_name, date_of_birth)');
    expect(section).toMatch(/Never state a date, a time, an\s+office or a doctor's name before step 2 has returned/);
  });

  it('the mandatory-lookup rule now counts an UNCONFIRMED match as "no record loaded"', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    expect(String((agent as any).instructions)).toMatch(
      /No CONFIRMED patient record was loaded at call start \(the PATIENT CONTEXT section is\s+missing, or says the phone match is UNCONFIRMED\)/,
    );
  });

  /**
   * THE DISCRIMINATOR, both ways. A context matched on name + date of birth
   * is confirmed and keeps the full section — this is not "always redact",
   * which would make the after-hours line unable to answer anyone.
   */
  it('a context matched by name and date of birth keeps the full details', () => {
    const confirmed = { ...PHONE_MATCH, matchedBy: 'name_and_dob' as const };
    const prompt = buildNoIvrSystemPrompt(META as any, confirmed as any);
    expect(prompt).toContain('PATIENT CONTEXT (LOADED - use as reference only)');
    expect(prompt).toContain('Dr. Xavier Zebrastripe');
    expect(prompt).toContain('3:10 PM');
    expect(prompt).not.toContain('PHONE MATCH — UNCONFIRMED');
  });

  it('the person-base rung marks the same thing as identityUnconfirmed, and that redacts too', () => {
    expect(phoneMatchIsUnconfirmed({ ...PHONE_MATCH, matchedBy: 'name_and_dob', identityUnconfirmed: true } as any)).toBe(true);
    expect(phoneMatchIsUnconfirmed({ ...PHONE_MATCH, matchedBy: 'name_and_dob' } as any)).toBe(false);
    const prompt = buildNoIvrSystemPrompt(META as any, { ...PHONE_MATCH, matchedBy: 'name_and_dob', identityUnconfirmed: true } as any);
    expect(prompt).toContain('PHONE MATCH — UNCONFIRMED');
    expect(prompt).not.toContain('Zebrastripe');
  });

  it('no match at all: no section, no first name, nothing to redact', () => {
    const prompt = buildNoIvrSystemPrompt(META as any, { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 } as any);
    // The mandatory-lookup rule mentions the section by name; the SECTION itself must be absent.
    expect(prompt).not.toContain('===== PATIENT CONTEXT');
    expect(prompt).not.toContain('Zelda');
  });
});

describe('lookup_schedule: the tool is the gate, not the prompt', () => {
  it('a phone-only lookup returns the candidate and NO appointment details, with the way back', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const r = await call(agent, 'lookup_schedule', { phone: '5551234567' });
    expect(r).toMatchObject({ found: true, identityUnconfirmed: true, patientFirstName: 'Zelda' });
    expect(r).not.toHaveProperty('upcomingAppointments');
    expect(r).not.toHaveProperty('lastProviderSeen');
    expect(r).not.toHaveProperty('lastLocationSeen');
    expect(JSON.stringify(r)).not.toMatch(/Zebrastripe|Testville|3:10/);
    expect(String(r.fix)).toMatch(/first_name, last_name and date_of_birth/);
    expect(r).not.toHaveProperty('message');
  });

  it('a phone-only lookup that matches nobody still says so', async () => {
    h.lookupByPhone.mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 } as any);
    const agent = await createNoIvrAgent(async () => {}, META);
    expect(await call(agent, 'lookup_schedule', { phone: '5551234567' })).toEqual({ found: false });
  });

  it('name + date of birth returns the appointment, exactly as before', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda', last_name: 'Quixote', date_of_birth: '01/04/1958' });
    expect(r.found).toBe(true);
    expect(r.upcomingAppointments).toHaveLength(1);
    expect(r.upcomingAppointments[0].provider).toBe('Dr. Xavier Zebrastripe');
    expect(h.lookupByNameAndDOB).toHaveBeenCalledTimes(1);
  });

  it('phone AND name + date of birth together is a confirmed lookup, not a phone one', async () => {
    const agent = await createNoIvrAgent(async () => {}, META);
    const r = await call(agent, 'lookup_schedule', { phone: '5551234567', first_name: 'Zelda', last_name: 'Quixote', date_of_birth: '01/04/1958' });
    expect(r.upcomingAppointments).toHaveLength(1);
  });
});
