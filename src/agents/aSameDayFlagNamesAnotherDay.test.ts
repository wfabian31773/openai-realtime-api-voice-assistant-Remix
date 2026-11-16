/**
 * v243 — A SAME-DAY FLAG ON A CALL ABOUT ANOTHER DAY.
 *
 * `appointment_today` is the model's reading, and on a Sunday or an early
 * Monday morning it reads "today" into a call about tomorrow's appointment.
 * After-hours tickets filed same-day over the Pacific days 2026-11-01..15: 121.
 * On 7 the request named another day and nothing that is today; staff moved 6
 * of the 7 out of After Hours (5 to the HVA Hub, 1 to Surgery) and left 1.
 * None of the 7 said "today", so the flag was the only same-day arm that could
 * have fired. The corpus below is those 7 by their real call SIDs, each with a
 * synthetic request in the shape the real one had (no PHI in git).
 *
 * Driven through `routeAfterHoursTicket` for the corpus, and through the REAL
 * agent's `create_ticket` for the two calls whose stored arguments show the
 * flag (v238), because the routing module proven alone proves the module and
 * not that this lane sends what it decides (failure mode 10).
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
    requiresCallback: (category: string) => category !== 'confirm_appointment',
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
const { routeAfterHoursTicket, appointmentTodayHolds, daysNamed } = await import('../services/afterHoursRouting');

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

const lastSubmit = () => {
  const calls = h.submitSimplifiedTicket.mock.calls;
  return calls[calls.length - 1][0] as Record<string, any>;
};

/** Each corpus call: its real SID and ticket, the call's own moment, and a synthetic request in its shape. */
const CORPUS = [
  {
    ticket: 'VA-79138',
    sid: 'CA4096d974acfa7ef837849f4ee51a5b01',
    now: '2026-11-01T18:57:00Z', // Sun 10:57 Pacific
    text: 'Caller wants to reschedule her appointment on Monday, November 2 at 9:00 AM.',
    staff: 'HVA Hub',
    after: 9,
  },
  {
    ticket: 'VA-79142',
    sid: 'CAb275ec5141e1ee30869037a4aa0ac3f6',
    now: '2026-11-01T20:58:00Z', // Sun 12:58 Pacific
    text: 'Caller needs to cancel tomorrow’s appointment, Monday November 2, and asked whether November 12 is open.',
    staff: 'HVA Hub',
    after: 9,
  },
  {
    ticket: 'VA-82183',
    sid: 'CA7431a61b5cdd4fc94a231c5fb28d1beb',
    now: '2026-11-08T19:37:00Z', // Sun 11:37 Pacific
    text: 'Patient wants to confirm the appointment on Monday, November 9.',
    staff: 'HVA Hub',
    after: 9,
  },
  {
    ticket: 'VA-82217',
    sid: 'CA49ad31a57367b703ce8808b97cb8f3ed',
    now: '2026-11-09T15:20:00Z', // Mon 07:20 Pacific
    text: 'Caller cannot make tomorrow’s appointment on Tuesday, November 10 and wants to reschedule.',
    staff: 'HVA Hub',
    after: 9,
  },
  {
    ticket: 'VA-82221',
    sid: 'CA2eae1724e6da8f9414a8e1c874069642',
    now: '2026-11-09T15:41:00Z', // Mon 07:41 Pacific
    text: 'Patient asked to move tomorrow’s surgery on Tuesday, November 10 to Wednesday, November 11.',
    staff: 'Surgery',
    // A named operation keeps the surgery-date exception: the app routes it.
    after: undefined,
  },
  {
    ticket: 'VA-85446',
    sid: 'CAdaa3dec3d92a4ec4eb3cd7b9e4376f35',
    now: '2026-11-15T17:31:00Z', // Sun 09:31 Pacific
    text: 'Patient wants to reschedule the follow-up in the office on Monday, November 16, 2026 at 8:45 AM.',
    staff: 'HVA Hub',
    after: 9,
  },
  {
    ticket: 'VA-85461',
    sid: 'CA7d16143b97bf5f1ef0ff5c647221b7f1',
    now: '2026-11-15T21:58:00Z', // Sun 13:58 Pacific
    text: 'Caller wants to move tomorrow’s appointment. Monday, November 16, 2026 at 1:00 PM PST',
    staff: 'left in After Hours (the accepted cost)',
    after: 9,
  },
] as const;

describe('the corpus: a flag on a call about another day is not same-day', () => {
  for (const c of CORPUS) {
    it(`${c.ticket} ${c.sid} (staff: ${c.staff})`, () => {
      const now = new Date(c.now);
      const words = routeAfterHoursTicket({ text: c.text, appointmentIntent: true, now });
      expect(words.kind, 'the words alone never made it same-day: the flag did').not.toBe('same_day');
      expect(appointmentTodayHolds(true, c.text, now)).toBe(false);
      const route = routeAfterHoursTicket({ appointmentToday: true, text: c.text, appointmentIntent: true, now });
      expect(route.kind).not.toBe('same_day');
      expect('departmentId' in route ? route.departmentId : undefined).toBe(c.after);
    });
  }
});

describe('the flag still stands when the words do not say otherwise', () => {
  const MONDAY_MORNING = new Date('2026-11-09T15:20:00Z'); // Mon 07:20 Pacific
  const keep = (text: string, now = MONDAY_MORNING) =>
    routeAfterHoursTicket({ appointmentToday: true, text, appointmentIntent: true, now }).kind;

  it('no day named at all', () => {
    expect(keep('Confirming the 8 o clock')).toBe('same_day');
  });
  it("today's own date", () => {
    expect(keep('Appointment on Monday, November 9 at 9:00 AM; running behind')).toBe('same_day');
    expect(keep('Appointment Monday at 9')).toBe('same_day');
  });
  it('"today" beside another day', () => {
    expect(keep('Wants to be seen today; the next booked visit is November 23')).toBe('same_day');
  });
  it('a date of birth names no day, with a year or after a birth word', () => {
    expect(keep('Confirming the 8 o clock; date of birth March 17, 1973')).toBe('same_day');
    expect(keep('Confirming the 8 o clock; born on March 17')).toBe('same_day');
  });
  it('a weekday that is today, even beside "next"', () => {
    expect(keep('Asked about next Monday')).toBe('same_day');
  });
  it('Spanish: "esta mañana" is today, "de la mañana" is a time', () => {
    expect(keep('Su cita es esta mañana')).toBe('same_day');
    expect(keep('Cita a las 8 de la mañana')).toBe('same_day');
  });
  it('today named beside another day keeps the flag, read on the helper (the route\'s words arm would mask it)', () => {
    expect(appointmentTodayHolds(true, 'Confirming today; asked about November 23', MONDAY_MORNING)).toBe(true);
    expect(appointmentTodayHolds(true, 'Appointment on November 9 at 9, and asked about November 23', MONDAY_MORNING)).toBe(true);
    expect(appointmentTodayHolds(true, "Moving Monday's appointment to Thursday", MONDAY_MORNING)).toBe(true);
    expect(keep("Moving Monday's appointment to Thursday")).toBe('same_day');
  });
  it('a date with a past year is a date of birth even with no birth word', () => {
    expect(appointmentTodayHolds(true, 'Patient, March 17, 1973, confirming the 8 o clock', MONDAY_MORNING)).toBe(true);
    expect(keep('Patient, March 17, 1973, confirming the 8 o clock')).toBe('same_day');
  });
  it('the evening rule is unchanged: never same-day after 5 PM', () => {
    const evening = new Date('2026-11-10T03:00:00Z'); // Mon 19:00 Pacific
    expect(keep('Confirming the 8 o clock', evening)).not.toBe('same_day');
  });
});

describe('another day, in the forms the model writes it', () => {
  const SUNDAY = new Date('2026-11-15T17:31:00Z'); // Sun 09:31 Pacific
  it.each([
    ['tomorrow', 'Cancel the appointment tomorrow'],
    ['a weekday', 'Reschedule the Tuesday appointment'],
    ['a month and day', 'Appointment on November 18'],
    ['a month and day with this year', 'Appointment on November 16, 2026'],
    ['an ISO date', 'Appointment 2026-11-16 13:00'],
    ['Spanish mañana', 'Necesita cancelar su cita de mañana'],
    ['a Spanish weekday', 'Su cita del miércoles'],
    ['a Spanish date', 'Cita el 16 de noviembre'],
  ])('%s', (_label, text) => {
    expect(daysNamed(text, SUNDAY)).toEqual({ today: false, other: true });
    expect(appointmentTodayHolds(true, text, SUNDAY)).toBe(false);
  });

  it("next year's date is still a day, not a date of birth", () => {
    const dec30 = new Date('2026-12-30T17:00:00Z'); // Wed 09:00 Pacific
    expect(daysNamed('Appointment on January 5, 2027', dec30)).toEqual({ today: false, other: true });
  });

  it('the veto only ever takes a flag away, never gives one', () => {
    expect(appointmentTodayHolds(false, 'Confirming today', SUNDAY)).toBe(false);
    expect(appointmentTodayHolds(undefined, 'Confirming today', SUNDAY)).toBe(false);
  });

  it('the record arm is not touched: a confirmed appointment later today still routes', () => {
    const r = routeAfterHoursTicket({
      text: 'Wants to move the appointment to November 18',
      appointmentIntent: true,
      confirmedUpcoming: [{ isoDate: '2026-11-15', startTime: '11:00 AM' }],
      now: SUNDAY,
    });
    expect(r.kind).toBe('same_day');
  });
});

describe('on the real agent: the two calls whose stored arguments carry the flag', () => {
  beforeEach(() => {
    resetGateAttempts();
    h.submitSimplifiedTicket.mockClear();
    h.byNameAndDob.mockReset();
    h.byNameAndDob.mockResolvedValue(NOT_FOUND);
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('VA-85446 CAdaa3dec3d92a4ec4eb3cd7b9e4376f35: the HVA Hub, not After Hours', async () => {
    vi.setSystemTime(new Date('2026-11-15T17:31:00Z'));
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: CORPUS[5].text,
      appointment_today: true,
    });
    const p = lastSubmit();
    expect(p.departmentId).toBe(9);
    expect(String(p.additionalDetails ?? '')).not.toMatch(/SAME-DAY/);
  });

  it('VA-85461 CA7d16143b97bf5f1ef0ff5c647221b7f1: the date is in appointment_time', async () => {
    vi.setSystemTime(new Date('2026-11-15T21:58:00Z'));
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: 'Caller wants to move tomorrow’s appointment.',
      appointment_time: 'Monday, November 16, 2026 at 1:00 PM PST',
      appointment_today: true,
    });
    const p = lastSubmit();
    expect(p.departmentId).toBe(9);
    expect(String(p.additionalDetails ?? '')).not.toMatch(/SAME-DAY/);
  });

  it('a vetoed flag runs no same-day time-conflict check, so no high priority', async () => {
    // Sunday morning, a confirmed record with an appointment at 11 today,
    // and a caller asking to move tomorrow's 1 PM: not a conflict with today.
    vi.setSystemTime(new Date('2026-11-15T17:31:00Z'));
    h.byNameAndDob.mockResolvedValue({
      ...NOT_FOUND,
      patientFound: true,
      matchedBy: 'name_and_dob',
      identity: { unique: true, candidateCount: 1, candidates: [] },
      upcomingAppointments: [{ isoDate: '2026-11-15', startTime: '11:00 AM' }],
    });
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'general_question',
      request_summary: 'Question about the parking',
      appointment_time: 'Monday, November 16, 2026 at 1:00 PM',
      appointment_today: true,
    });
    const p = lastSubmit();
    expect(String(p.additionalDetails ?? '')).not.toContain('APPOINTMENT TIME CONFLICT');
    expect(p.priority).not.toBe('high');
  });

  it('control: a flag on a call about today still files same-day to After Hours', async () => {
    vi.setSystemTime(new Date('2026-11-16T15:20:00Z')); // Mon 07:20 Pacific
    const { agent } = await agentFor();
    await call(agent, 'create_ticket', {
      ...TICKET,
      request_category: 'reschedule_appointment',
      request_summary: 'Wants to move the appointment this morning, Monday, November 16 at 8:45 AM.',
      appointment_today: true,
    });
    const p = lastSubmit();
    expect(p.departmentId).toBe(8);
    expect(p.additionalDetails).toMatch(/SAME-DAY/);
  });
});
