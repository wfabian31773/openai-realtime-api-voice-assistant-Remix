/**
 * AN ESCALATION CARRIES THE RECORD THIS CALL CONFIRMED — v234.
 *
 * RULE ZERO step 5: once a match is validated, the record is carried into every
 * tool and onto the ticket, and nothing re-asks a field it holds. On the
 * after-hours line `create_ticket` does that (`prepareTicketIdentity`), and so
 * does the teardown floor. `escalate_to_human` did not: every ticket it files
 * (the refused-escalation ticket, v80; the urgent transfer record, v93), the
 * on-call text and the ring-out fallback (both read `escalationDetailsMap`)
 * took the patient's name and date of birth from the model's arguments alone,
 * and the model passes only the first name the caller said yes to, because
 * v194 tells it the record holds the rest.
 *
 * MEASURED 2026-11-14, no-ivr, the 14 days before, agent tickets on calls
 * whose `lookup_schedule` came back CONFIRMED: every create_ticket filing (26)
 * and every floor ticket (21) carried the record's date of birth; 5 of the 6
 * tickets the escalation paths filed carried neither the last name nor the
 * date of birth. Those 5 are the corpus (real SIDs and ticket numbers, the
 * call's escalation shape, a synthetic patient — RULE THREE). The sixth is the
 * control: the model passed the name and date of birth itself, and nothing
 * changes.
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
    { date: 'Tuesday, December 31, 2041', isoDate: '2041-12-31', dayOfWeek: 'Tuesday', timeOfDay: 'morning',
      startTime: '8:50 AM', location: 'Quixotic Vision Testville', provider: 'Dr. Xavier Zebrastripe',
      status: 'Active', appointmentType: 'Dilated Exam' },
  ],
  pastAppointments: [],
  totalAppointmentsFound: 1,
  lastLocationSeen: 'Quixotic Vision Testville',
  lastProviderSeen: 'Dr. Xavier Zebrastripe',
};
const NOBODY = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

const h = vi.hoisted(() => ({
  lookupByPhone: vi.fn(),
  lookupByNameAndDOB: vi.fn(async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 })),
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' })),
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

const { createNoIvrAgent, escalationWithConfirmedRecord } = await import('./noIvrAgent');
const { resetVerifiedIdentities } = await import('../tools/verifiedIdentity');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { noteCallerTranscript, releaseCallerSpeech } = await import('../services/symptomCorroboration');
const { escalationDetailsMap } = await import('../services/escalationStore');
const { urgentFallbackTicketParams, URGENT_TRANSFER_NOT_ANSWERED } = await import('../services/urgentTransferAlert');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const ANI = '+15551234567';
const GREETED = { matched: true, firstName: 'Zelda' };
const GREETING = 'AGENT: Thank you for calling. Our offices are currently closed. Am I speaking with Zelda?';

/** On the runtime the agent's callId IS the CallSid; the bridge keys the speech ledger on it. */
async function agentFor(callSid: string, precontext: unknown = GREETED) {
  const handoff = vi.fn(async () => {});
  const agent = await createNoIvrAgent(handoff, {
    callId: callSid, callSid, callerPhone: ANI, precontext, pipeline: 'runtime',
  } as any);
  return { agent, handoff };
}

/** The greeting's yes, confirmed through lookup_schedule (v172). */
async function confirmed(callSid: string) {
  const { agent, handoff } = await agentFor(callSid);
  const r = await call(agent, 'lookup_schedule', { first_name: 'Zelda' });
  expect(r.identity_on_record, 'the yes must confirm the record first').toBe(true);
  return { agent, handoff };
}

/** The escalation shapes the corpus calls took, with synthetic words. */
const ADMINISTRATIVE = {
  reason: 'Caller wants to reschedule an appointment for tomorrow and asked for the on-call doctor',
  caller_type: 'patient_urgent_medical',
};
const PROVIDER_NOT_STATED = {
  reason: 'Caller identified as operator/clinician requesting human escalation',
  caller_type: 'healthcare_provider',
};
const EMERGENCY = {
  reason: 'Patient reports sudden vision loss in the right eye this evening',
  caller_type: 'patient_urgent_medical',
  symptoms_summary: 'sudden vision loss, right eye',
};
const NOT_AN_EMERGENCY_WORD = {
  reason: 'Patient reports new flashes in the right eye this evening',
  caller_type: 'patient_urgent_medical',
  symptoms_summary: 'new flashes, right eye',
};

const ticketAt = async (i: number) => {
  await vi.waitFor(() => expect(h.submitSimplifiedTicket.mock.calls.length).toBeGreaterThan(i));
  return h.submitSimplifiedTicket.mock.calls[i][0] as Record<string, any>;
};

const expectTheRecord = (ticket: Record<string, any>) => {
  expect(ticket.patientFullName).toBe('Zelda Quixote');
  expect(ticket.patientDOB).toBe('01/04/1958');
};

beforeEach(() => {
  h.lookupByPhone.mockReset().mockResolvedValue(ONE_PERSON_ON_THE_NUMBER as any);
  h.lookupByNameAndDOB.mockClear();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' } as any);
  resetVerifiedIdentities();
  resetGateAttempts();
  escalationDetailsMap.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the corpus: a refused escalation files the confirmed record', () => {
  for (const [sid, ticket] of [
    ['CA3ee43813a3e0326d94e57acb6f1aee01', 'VA-84772'],
    ['CAe18109fad6e971318672443a415e5b63', 'VA-82158'],
  ] as const) {
    it(`${sid} (${ticket}): an administrative escalation is refused, and its ticket carries the last name and date of birth`, async () => {
      const { agent, handoff } = await confirmed(sid);
      const r = await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
      expect(r.refused).toBe('administrative_request');
      expect(r.ticket_filed).toBe(true);
      expect(handoff).not.toHaveBeenCalled();
      expectTheRecord(await ticketAt(0));
    });
  }

  for (const [sid, ticket] of [
    ['CA60acf05b84a6b001e2e2dd8a69d7c224', 'VA-82180'],
    ['CAdcc8178cf8d45aaa2ebaf96c72ce67fd', 'VA-82153'],
  ] as const) {
    it(`${sid} (${ticket}): a provider claim the caller never made is refused, and its ticket carries the record`, async () => {
      const { agent, handoff } = await confirmed(sid);
      noteCallerTranscript(sid, [GREETING, 'CALLER: Yes.', 'AGENT: How can I help?', 'CALLER: Operator.']);
      const r = await call(agent, 'escalate_to_human', { ...PROVIDER_NOT_STATED, patient_first_name: 'Zelda' });
      expect(r.refused).toBe('provider_not_stated_by_caller');
      expect(handoff).not.toHaveBeenCalled();
      expectTheRecord(await ticketAt(0));
      releaseCallerSpeech(sid);
    });
  }
});

describe('the corpus: a sanctioned transfer carries the confirmed record', () => {
  const sid = 'CAd1795d47d6da132f1e2ce04ca0a44632'; // VA-82110

  it(`${sid} (VA-82110): the transfer record, the on-call text and the ring-out fallback all carry the record`, async () => {
    const { agent, handoff } = await confirmed(sid);
    const r = await call(agent, 'escalate_to_human', { ...EMERGENCY, patient_first_name: 'Zelda' });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);

    const record = await ticketAt(0);
    expect(record.reasonForCalling).toMatch(/URGENT TRANSFER/);
    expectTheRecord(record);

    // escalationDetailsMap feeds the on-call text and the ring-out fallback.
    const details = escalationDetailsMap.get(sid);
    expect(details?.patientLastName).toBe('Quixote');
    expect(details?.patientDob).toBe('01/04/1958');
    const fallback = urgentFallbackTicketParams({
      why: URGENT_TRANSFER_NOT_ANSWERED, escalationDetails: details, callerId: ANI, callSid: sid, agentUsed: 'no-ivr',
    });
    expect(fallback).toMatchObject({
      patientFirstName: 'Zelda', patientLastName: 'Quixote',
      patientBirthMonth: '01', patientBirthDay: '04', patientBirthYear: '1958',
    });
  });

  it('the identity ask before a transfer does not ask for what the record holds', async () => {
    const { agent, handoff } = await confirmed('CA' + 'b'.repeat(32));
    const r = await call(agent, 'escalate_to_human', { ...NOT_AN_EMERGENCY_WORD, patient_first_name: 'Zelda' });
    expect(r.need_identity, 'the record holds the last name and date of birth').toBeUndefined();
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    expectTheRecord(await ticketAt(0));
  });
});

describe('the control: the model passed the name and date of birth itself', () => {
  it('CA9904e10fdabe72cbf22684ef02676e59 (VA-79127): what the model sent is filed as sent', async () => {
    const sid = 'CA9904e10fdabe72cbf22684ef02676e59';
    const { agent } = await confirmed(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Yes.', 'AGENT: How can I help?', 'CALLER: I need to talk to the doctor.']);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Patient reports severe pain and sudden vision loss in the right eye',
      caller_type: 'patient_urgent_medical',
      symptoms_summary: 'severe pain, sudden vision loss',
      patient_first_name: 'Zelda', patient_last_name: 'Quixote', patient_dob: 'January 4, 1958',
    });
    expect(r.refused).toBe('symptoms_not_stated_by_caller');
    const t = await ticketAt(0);
    expect(t.patientFullName).toBe('Zelda Quixote');
    expect(t.patientDOB).toBe('January 4, 1958');
    releaseCallerSpeech(sid);
  });
});

describe('what the carry does not do', () => {
  it('a call with no confirmed record carries nothing', async () => {
    h.lookupByPhone.mockResolvedValue(NOBODY as any);
    const { agent } = await agentFor('CA' + 'c'.repeat(32), undefined);
    const r = await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
    expect(r.refused).toBe('administrative_request');
    const t = await ticketAt(0);
    expect(t.patientFullName).not.toMatch(/Quixote/);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('an escalation about somebody else (another first name) carries nothing', async () => {
    const { agent } = await confirmed('CA' + 'd'.repeat(32));
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Yolanda' });
    const t = await ticketAt(0);
    expect(t.patientFullName).not.toMatch(/Quixote/);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('a surname that is not the record\'s carries nothing', async () => {
    const { agent } = await confirmed('CA' + 'e'.repeat(32));
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_last_name: 'Otherly' });
    const t = await ticketAt(0);
    expect(t.patientFullName).toBe('Zelda Otherly');
    expect(t.patientDOB).toBe('Unknown');
  });

  it('a date of birth that disagrees with the record carries nothing', async () => {
    const { agent } = await confirmed('CA' + 'f'.repeat(32));
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_dob: '02/09/1960' });
    const t = await ticketAt(0);
    expect(t.patientFullName).not.toMatch(/Quixote/);
    expect(t.patientDOB).toBe('02/09/1960');
  });

  it('an escalation that names nobody is left as it was, and the identity ask still fires', async () => {
    const { agent, handoff } = await confirmed('CA' + '1'.repeat(32));
    const r = await call(agent, 'escalate_to_human', NOT_AN_EMERGENCY_WORD);
    expect(r.need_identity).toBe(true);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('a refused escalation that names nobody files no part of the record', async () => {
    const { agent } = await confirmed('CA' + '5'.repeat(32));
    await call(agent, 'escalate_to_human', ADMINISTRATIVE);
    const t = await ticketAt(0);
    expect(t.patientFullName).not.toMatch(/Quixote/);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('a placeholder date of birth is replaced by the record\'s', async () => {
    const { agent } = await confirmed('CA' + '2'.repeat(32));
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_dob: 'unknown' });
    expectTheRecord(await ticketAt(0));
  });

  it('a stated date the record agrees with is kept as the caller gave it', () => {
    const sid = 'CA' + '3'.repeat(32);
    return confirmed(sid).then(() => {
      const args: { patient_first_name?: string; patient_last_name?: string; patient_dob?: string } =
        { patient_first_name: 'Zelda', patient_dob: 'January 4, 1958' };
      const p = escalationWithConfirmedRecord(sid, undefined, args);
      expect(p.patient_last_name).toBe('Quixote');
      expect(p.patient_dob).toBe('January 4, 1958');
    });
  });

  it('the first word of a compound first name the yes confirmed carries the whole record', async () => {
    const MAE = { ...ZELDA, firstName: 'Zelda Mae' };
    h.lookupByPhone.mockResolvedValue({ ...ONE_PERSON_ON_THE_NUMBER, patientName: 'Zelda Mae Quixote', patientData: MAE,
      identity: { unique: true, candidateCount: 1, candidates: [{ ...MAE, appointmentCount: 1 }] } } as any);
    const { agent } = await confirmed('CA' + '4'.repeat(32));
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
    const t = await ticketAt(0);
    expect(t.patientFullName).toBe('Zelda Mae Quixote');
    expect(t.patientDOB).toBe('01/04/1958');
  });
});

/**
 * Codex P1 on #478 (comment 4570996648): a date of birth that is there and
 * does not read is not a missing one. `validatedPatientFor` cannot see a
 * conflict in "February 30, 1960", so carrying would put the record's date
 * over whatever the caller said. Only an absent value or an explicit
 * placeholder ("unknown", "n/a", "none", "unavailable") is replaced.
 */
describe('a stated date of birth that does not read blocks the carry', () => {
  for (const said of ['February 30, 1960', '13/45/1960']) {
    it(`"${said}" on the refused escalation of the VA-84772 shape: no part of the record is filed`, async () => {
      const { agent } = await confirmed('CA' + '6'.repeat(32));
      await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_dob: said });
      const t = await ticketAt(0);
      expect(t.patientFullName).not.toMatch(/Quixote/);
      expect(t.patientDOB).not.toBe('01/04/1958');
    });
  }

  it('on a sanctioned escalation the identity ask still fires instead of carrying the record', async () => {
    const { agent, handoff } = await confirmed('CA' + '7'.repeat(32));
    const r = await call(agent, 'escalate_to_human', {
      ...NOT_AN_EMERGENCY_WORD, patient_first_name: 'Zelda', patient_dob: 'February 30, 1960',
    });
    expect(r.need_identity).toBe(true);
    expect(handoff).not.toHaveBeenCalled();
  });

  for (const placeholder of ['unknown', 'N/A', 'none', 'unavailable']) {
    it(`the placeholder "${placeholder}" is still replaced by the record's date`, async () => {
      const { agent } = await confirmed('CA' + '8'.repeat(32));
      await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_dob: placeholder });
      expectTheRecord(await ticketAt(0));
    });
  }
});

/**
 * Codex P1 on #478 (comment 4570996644): create_ticket replaces the held
 * identity and the schedule when it verifies a different family member, and
 * leaves the greeting's record where it was. A first name both people answer
 * to must not carry the other person's surname and date of birth.
 */
describe("a family member verified after the greeting does not lend the greeting's name", () => {
  const RIVERS = { firstName: 'Zelda', lastName: 'Rivers', dateOfBirth: '1990-03-15', personId: 'p-synthetic-2' };
  const familyMember = (patient: typeof RIVERS) => ({
    patientFound: true,
    patientName: `${patient.firstName} ${patient.lastName}`,
    matchedBy: 'name_and_dob' as const,
    identity: { unique: true, candidateCount: 1, candidates: [{ ...patient, appointmentCount: 0 }] },
    patientData: patient,
    upcomingAppointments: [],
    pastAppointments: [],
    totalAppointmentsFound: 0,
  });

  async function thenAFamilyMemberIsFiled(sid: string, patient: typeof RIVERS) {
    const { agent, handoff } = await confirmed(sid);
    h.lookupByNameAndDOB.mockResolvedValueOnce(familyMember(patient) as any);
    const t = await call(agent, 'create_ticket', {
      first_name: patient.firstName, last_name: patient.lastName, date_of_birth: '03/15/1990',
      callback_number: '5551234567', request_category: 'cancel_appointment',
      request_summary: 'Cancel the appointment for a family member.',
    });
    expect(t.success).toBe(true);
    return { agent, handoff };
  }

  it('the same first name: the escalation carries neither person', async () => {
    const { agent } = await thenAFamilyMemberIsFiled('CA' + '9'.repeat(32), RIVERS);
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
    const t = await ticketAt(1);
    expect(t.patientFullName).not.toMatch(/Rivers|Quixote/);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('a compound first name the model shortened: the stale greeting does not rewrite it', async () => {
    const MAE = { ...ZELDA, firstName: 'Zelda Mae' };
    h.lookupByPhone.mockResolvedValue({ ...ONE_PERSON_ON_THE_NUMBER, patientName: 'Zelda Mae Quixote', patientData: MAE,
      identity: { unique: true, candidateCount: 1, candidates: [{ ...MAE, appointmentCount: 1 }] } } as any);
    const { agent } = await thenAFamilyMemberIsFiled('CA' + 'a'.repeat(32), { ...RIVERS, firstName: 'Zelda Mae' });
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
    const t = await ticketAt(1);
    expect(t.patientFullName).not.toMatch(/Rivers|Quixote/);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('a surname that names the family member carries that person\'s date of birth', async () => {
    const { agent } = await thenAFamilyMemberIsFiled('CA' + '0'.repeat(31) + '1', RIVERS);
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_last_name: 'Rivers' });
    const t = await ticketAt(1);
    expect(t.patientFullName).toBe('Zelda Rivers');
    expect(t.patientDOB).toBe('03/15/1990');
  });

  it('a family member with the same first name and surname: the surname does not say which, nothing carries', async () => {
    const { agent } = await thenAFamilyMemberIsFiled('CA' + '0'.repeat(31) + '3', { ...RIVERS, lastName: 'Quixote' });
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda', patient_last_name: 'Quixote' });
    const t = await ticketAt(1);
    expect(t.patientDOB).toBe('Unknown');
  });

  it('the greeting person filed again by name and date of birth is not stale', async () => {
    const { agent } = await confirmed('CA' + '0'.repeat(31) + '2');
    const t = await call(agent, 'create_ticket', {
      first_name: 'Zelda', last_name: 'Quixote', date_of_birth: '01/04/1958',
      callback_number: '5551234567', request_category: 'cancel_appointment', request_summary: 'Cancel the appointment.',
    });
    expect(t.success).toBe(true);
    await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, patient_first_name: 'Zelda' });
    expectTheRecord(await ticketAt(1));
  });
});
