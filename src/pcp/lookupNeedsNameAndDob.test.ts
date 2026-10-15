/**
 * THE PCP LINE READS A SCHEDULE ONLY ON NAME AND DATE OF BIRTH (v96).
 *
 * `lookupPatient` falls through: when the name and date of birth match
 * nobody, the appointment book's NAME-ONLY rung answers with the most recently
 * seen person carrying that name. On this line the subject is a third party
 * and the answer is read to an outside office, so that fall-through read one
 * stranger's appointments to another.
 *
 * CA23f7d0724863d9566e5d638041246160 (2026-10-14) is the shape: a name shared
 * by 126 people in the person base, no date of birth from the caller, five
 * upcoming appointments read out. 18 of 48 PCP calls whose lookup found
 * someone over 10-08..10-14 had no date-like word in anything the caller said.
 *
 * Every fixture is invented. No production caller appears here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupPatient = vi.fn();

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient, lookupByNameAndDOB: vi.fn() },
}));

const { createPcpAgent } = await import('../agents/pcpAgent');
const { pcpDirector } = await import('./director');

let n = 0;
const freshCall = () => `pcp-name-and-dob-${++n}`;

const call = async (agent: any, name: string, args: unknown) => {
  const t = agent.tools.find((tool: any) => tool.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  const raw = await t.invoke({} as any, JSON.stringify(args));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed?.result ?? parsed;
};

const CALLER_PHONE = '+17605550100';
const PATIENT = { patientFirstName: 'Teodoro', patientLastName: 'Quillfeather', patientDob: '1957-06-30' };

const APPOINTMENT = {
  date: '2027-01-04',
  time: '07:00',
  location: 'Example Surgery Center',
  provider: 'Example Surgeon, MD',
  type: 'Surgery',
  status: 'Active',
};

const context = (over: Record<string, unknown>) => ({
  patientFound: true,
  upcomingAppointments: [APPOINTMENT],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  ...over,
});

const build = (callId: string) =>
  createPcpAgent(async () => ({ ok: false, status: 'NO_ANSWER' as const }), {
    callId,
    callSid: `CA${callId}`,
    callerPhone: CALLER_PHONE,
  });

async function lookupAs(ctx: unknown) {
  const callId = freshCall();
  const agent = build(callId);
  pcpDirector.update(callId, {
    callPurpose: 'check_patient_scheduled',
    callerName: 'Dana Okafor',
    callerOrganization: 'North County Medical Group',
    callbackNumber: CALLER_PHONE,
  });
  lookupPatient.mockResolvedValue(ctx);
  return call(agent, 'lookup_patient_appointments', PATIENT);
}

beforeEach(() => {
  lookupPatient.mockReset();
});

describe('a schedule is read only when the patient matched on name and date of birth', () => {
  it('reads the appointments on a single-person name-and-date-of-birth match', async () => {
    const result = await lookupAs(
      context({ matchedBy: 'name_and_dob', identity: { unique: true, candidateCount: 1, candidates: [] } }),
    );
    expect(result.patientFound).toBe(true);
    expect(result.upcomingAppointments).toHaveLength(1);
    expect(result.suppressed).toBeUndefined();
  });

  it('withholds a NAME-ONLY match — the fall-through that read a stranger’s surgeries', async () => {
    const result = await lookupAs(
      context({ matchedBy: 'name', identity: { unique: false, candidateCount: 4, candidates: [] } }),
    );
    expect(result.success).toBe(true);
    expect(result.patientFound).toBe(false);
    expect(result.identityConfirmed).toBe(false);
    expect(result.suppressed).toBe('not_name_and_dob');
    expect(result.upcomingAppointments).toEqual([]);
    expect(result.pastAppointments).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Example Surgery Center');
  });

  it('withholds a name-only match even when the book calls it one person', async () => {
    const result = await lookupAs(
      context({ matchedBy: 'name', identity: { unique: true, candidateCount: 1, candidates: [] } }),
    );
    expect(result.suppressed).toBe('not_name_and_dob');
    expect(result.upcomingAppointments).toEqual([]);
  });

  it('withholds a name-and-date-of-birth match that settles on several people', async () => {
    const result = await lookupAs(
      context({ matchedBy: 'name_and_dob', identity: { unique: false, candidateCount: 2, candidates: [] } }),
    );
    expect(result.suppressed).toBe('not_name_and_dob');
    expect(result.upcomingAppointments).toEqual([]);
  });

  it('withholds a match that does not say how it was made', async () => {
    const result = await lookupAs(context({}));
    expect(result.suppressed).toBe('not_name_and_dob');
    expect(result.upcomingAppointments).toEqual([]);
  });

  it('sends the model back for the date of birth in the caller’s words, and never says there are no appointments', async () => {
    const result = await lookupAs(context({ matchedBy: 'name' }));
    expect(result.guidance).toMatch(/starting with the month, then the day, then the year/);
    expect(result.guidance).toMatch(/Never send a date of birth the caller did not say/);
    expect(result.guidance).toMatch(/Do NOT read, confirm or deny any appointment/);
    // A withheld answer has no spoken line of its own: the guidance is for the model.
    expect(result.say).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it('leaves a plain miss a plain miss', async () => {
    const result = await lookupAs({ patientFound: false, upcomingAppointments: [], pastAppointments: [] });
    expect(result.patientFound).toBe(false);
    expect(result.suppressed).toBeUndefined();
  });

  it('tells the model the date of birth must be the one the caller said', () => {
    const agent = build(freshCall());
    const t = agent.tools.find((tool: any) => tool.name === 'lookup_patient_appointments') as any;
    const schema = JSON.stringify(t.parameters);
    expect(schema).toMatch(/exactly as the caller said it/);
    expect(schema).toMatch(/Never send a date the caller did not say/);
  });
});
