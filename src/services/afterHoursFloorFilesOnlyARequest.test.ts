/**
 * v276 — the after-hours teardown floor files only a valid request from an
 * identified patient.
 *
 * Operator, 2026-11-26: "That is really bad practice, not only does it
 * overstate the ticket counts but it adds useless time to our staffs that
 * they have to address trying to figure out what the patient was requesting,
 * we should use the same pcp approach. We shouldnt be filing tickets unless
 * we can identify the patient and there is a valid request".
 *
 * Measured, no-ivr floor tickets 2026-11-12 15:24 to 2026-11-26 01:59 UTC
 * (Support Center, `NEEDS REVIEW` + `teardown floor`): 123, 57 of them under
 * the stand-in name. Read one by one against their calls, 46 of the 57
 * stand-ins and 16 of the 66 named tickets carried no request at all
 * (background speech, a voicemail greeting, a caller asking only for a
 * person, an hours question the agent answered).
 *
 * The rule, read here through the real floor with only the stores, the
 * ticket sink and the two model readers faked:
 *   - no request read from the recording files nothing, named or not;
 *   - a request read from the recording files only under a name (a certain
 *     identity, or the patient's name as the caller said it, v239);
 *   - a reader that could not run (no key, switched off, a model failure)
 *     files as before, with a note, so an outage loses nothing;
 *   - a records request is not read: v190 and the CAP SOP log every access
 *     request, so it files to Medical Records as before.
 *
 * The SIDs are real; every word below is a synthetic stand-in in the shape of
 * that call. No transcript, name or number from a call is in this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

const h = vi.hoisted(() => ({
  getCallLogBySid: vi.fn(),
  submitSimplifiedTicket: vi.fn(),
  lookupPatient: vi.fn(),
  confirmedClinicFor: vi.fn(),
  verifiedIdentityFor: vi.fn(),
  unconfirmedCandidateFor: vi.fn(),
  officeTheCallerGave: vi.fn(),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: h.getCallLogBySid } }));
vi.mock('./syncAgentService', () => ({ SyncAgentService: { submitSimplifiedTicket: h.submitSimplifiedTicket } }));
vi.mock('./scheduleLookupService', () => ({ scheduleLookupService: { lookupPatient: h.lookupPatient } }));
vi.mock('../tools/verifiedIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/verifiedIdentity')>()),
  confirmedClinicFor: h.confirmedClinicFor,
  verifiedIdentityFor: h.verifiedIdentityFor,
  unconfirmedCandidateFor: h.unconfirmedCandidateFor,
}));
vi.mock('./afterHoursCallFacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./afterHoursCallFacts')>()),
  officeTheCallerGave: h.officeTheCallerGave,
}));

const floor = await import('./afterHoursTeardownFloor');
const { noteAfterHoursRecordsRequest, MEDICAL_RECORDS_DEPARTMENT_ID } = await import('./afterHoursRecordsRequest');
const { STAND_IN_FULL_NAME } = await import('./standInName');

const GREETING =
  "AGENT: Thank you for calling Azul Vision. Our offices are currently closed. All calls are being recorded for quality assurance purposes. If this is a medical emergency, please hang up and dial 911. Otherwise, I'm happy to help — how may I assist you?";

const AFTER_HOURS_DEPARTMENT_ID = 8;

type RequestAnswer = { request?: string | null } | null;
type Asker = (transcript: string, retry?: unknown) => Promise<RequestAnswer>;
type HeardName = { firstName?: string | null; lastName?: string | null } | null;

let serial = 0;
async function sweep(
  transcript: string,
  opts: {
    /** What the request reader answers; a function for a sequence or a throw. */
    request?: RequestAnswer | Asker;
    /** The patient's name as the model read it from the recording (v239). */
    heard?: HeardName;
    /** A certain identity the call held. */
    identity?: { firstName: string; lastName: string; dateOfBirth?: string };
    /** A records request the escalation noted on the call (v190). */
    records?: boolean;
  } = {},
) {
  const n = ++serial;
  const callSid = `CA${String(n).padStart(32, '0')}`;
  const callId = `synthetic-floor-request-${n}`;
  floor.registerAfterHoursFloor({ callId, callSid, callerPhone: '+12025550100', dialedNumber: '+12025550199' }, 'no-ivr');
  if (opts.records) noteAfterHoursRecordsRequest(callSid);
  if (opts.identity) h.verifiedIdentityFor.mockReturnValue({ ...opts.identity, certain: true });
  const askName = vi.fn(async () => opts.heard ?? null);
  const given = opts.request;
  const answer: Asker =
    typeof given === 'function'
      ? given
      : async () => (given === undefined ? { request: 'Wants to move an eye appointment.' } : given);
  const askRequest = vi.fn(answer);
  await floor.sweepAfterHoursUnfiledCall(callId, { transcript, askName, askRequest });
  expect(h.submitSimplifiedTicket.mock.calls.length).toBeLessThanOrEqual(1);
  return { payload: h.submitSimplifiedTicket.mock.calls[0]?.[0], askName, askRequest };
}

beforeEach(() => {
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  h.lookupPatient.mockReset().mockResolvedValue({ patientFound: false, upcomingAppointments: [], pastAppointments: [] });
  h.confirmedClinicFor.mockReset().mockReturnValue(undefined);
  h.verifiedIdentityFor.mockReset().mockReturnValue(undefined);
  h.unconfirmedCandidateFor.mockReset().mockReturnValue(undefined);
  h.officeTheCallerGave.mockReset().mockResolvedValue(undefined);
});

/** A stand-in ticket with no request in it: background speech, a greeting, a person-only ask. */
const STAND_IN_NO_REQUEST: Array<{ ticket: string; sid: string; shape: string; transcript: string }> = [
  {
    ticket: 'VA-90198', sid: 'CA393256052f139cbf4e5cd1d1ec4b4e2f',
    shape: 'background conversation, nobody speaking to the agent',
    transcript: [GREETING, 'CALLER: No, I told him to put it in the back of the car.', 'AGENT: Hello? How can I help you today?', 'CALLER: Yeah, after the game.'].join('\n'),
  },
  {
    ticket: 'VA-90196', sid: 'CAc2fcb81a9858346213b1fa48bcf3e668',
    shape: 'a pocket dial, fragments',
    transcript: [GREETING, 'CALLER: Okay, okay, wait.', 'AGENT: I am here. How can I help?', 'CALLER: Hold on, hold on.'].join('\n'),
  },
  {
    ticket: 'VA-89722', sid: 'CA57bcacd65524a3d6deb50523e7924b25',
    shape: 'the caller talking to someone else in the room',
    transcript: [GREETING, 'CALLER: Did you see where I put the keys?', 'AGENT: How can I help you today?', 'CALLER: They were on the counter this morning.'].join('\n'),
  },
  {
    ticket: 'VA-89715', sid: 'CAdeabe8a0295b055ddf32a117b1d7ddd4',
    shape: 'Spanish, background speech',
    transcript: [GREETING, 'CALLER: No, ahorita no, déjalo ahí.', 'AGENT: ¿En qué puedo ayudarle?', 'CALLER: Ya te dije que mañana.'].join('\n'),
  },
  {
    ticket: 'VA-89727', sid: 'CAef1fd6091a9e6490921e3be2cf56a1aa',
    shape: 'a television in the background',
    transcript: [GREETING, 'CALLER: And the forecast for tomorrow is clear skies.', 'AGENT: Hello? How can I help you?', 'CALLER: Highs in the seventies along the coast.'].join('\n'),
  },
  {
    ticket: 'VA-89085', sid: 'CAc030c518f0788092d5c4e8ab99db5db2',
    shape: 'a voicemail greeting answered the call',
    transcript: [GREETING, 'CALLER: You have reached the voicemail of a number that is not available.', 'CALLER: Please leave your message after the tone.'].join('\n'),
  },
  {
    ticket: 'VA-88382', sid: 'CAcc7646368f2e236f6a3d2b2978fecc7c',
    shape: 'a voicemail system prompt',
    transcript: [GREETING, 'CALLER: The person you are trying to reach is not available.', 'CALLER: At the tone, please record your message.'].join('\n'),
  },
  {
    ticket: 'VA-89730', sid: 'CA4b709febbd90b2de810fa5c9ab1a5124',
    shape: 'Spanish, asks only for a person',
    transcript: [GREETING, 'CALLER: Quiero hablar con una persona.', 'AGENT: Puedo tomar un mensaje para el equipo. ¿En qué le puedo ayudar?', 'CALLER: Con una persona, por favor.'].join('\n'),
  },
  {
    ticket: 'VA-88396', sid: 'CAaac62610f42306950f703355815d107b',
    shape: 'asks only for a representative',
    transcript: [GREETING, 'CALLER: Representative.', 'AGENT: I can take a message for the team. What can I help you with?', 'CALLER: I want to talk to a real person.'].join('\n'),
  },
  {
    ticket: 'VA-89712', sid: 'CAda8c0b597a5b9be78006e1a1b286f340',
    shape: 'unclear, nothing asked',
    transcript: [GREETING, 'CALLER: Yeah, I was just, um.', 'AGENT: Take your time. How can I help?', 'CALLER: Never mind, it is fine.'].join('\n'),
  },
];

/** Named callers with a real request: these file, as before. */
const NAMED_REQUEST: Array<{ ticket: string; sid: string; shape: string; request: string; transcript: string; heard: { firstName: string; lastName: string } }> = [
  {
    ticket: '(call)', sid: 'CA347d701fbbdb8f60cb557849efd89b0e',
    shape: 'running late for an appointment today',
    request: 'Is running late for an appointment today.',
    heard: { firstName: 'Mara', lastName: 'Quill' },
    transcript: [GREETING, "CALLER: Hi, this is Mara Quill, I'm going to be about twenty minutes late for my appointment this morning.", 'AGENT: Thank you, I will let the team know.'].join('\n'),
  },
  {
    ticket: 'VA-89703', sid: 'CA36eb627568d5ade6e39733625f4f4205',
    shape: 'move an appointment to a later time',
    request: 'Wants to move an appointment to a later time.',
    heard: { firstName: 'Owen', lastName: 'Lark' },
    transcript: [GREETING, 'CALLER: My name is Owen Lark and I need to move my appointment to later in the day.', 'AGENT: I can take that request for the team.'].join('\n'),
  },
  {
    ticket: 'VA-89729', sid: 'CA4936b1d4961184dce8ea1c79dad5f981',
    shape: 'Spanish, confirm an appointment tomorrow',
    request: 'Wants to confirm an appointment tomorrow.',
    heard: { firstName: 'Lucia', lastName: 'Pardo' },
    transcript: [GREETING, 'CALLER: Habla Lucia Pardo, quiero confirmar mi cita de mañana.', 'AGENT: Con gusto, le paso el mensaje al equipo.'].join('\n'),
  },
  {
    ticket: 'VA-89718', sid: 'CA96acbc1d0e46dba4ec2bb3fded45059d',
    shape: 'reschedule an appointment today',
    request: 'Wants to reschedule an appointment today.',
    heard: { firstName: 'Iris', lastName: 'Noble' },
    transcript: [GREETING, "CALLER: This is Iris Noble, I can't make it to my appointment today and need to reschedule.", 'AGENT: Understood, I will pass that on.'].join('\n'),
  },
  {
    ticket: '(call)', sid: 'CA99a33a6a39d7c09bb09ade868af83ab0',
    shape: 'an eye ointment missing at the pharmacy',
    request: 'An eye ointment is missing at the pharmacy.',
    heard: { firstName: 'Paul', lastName: 'Reyes' },
    transcript: [GREETING, "CALLER: My name is Paul Reyes, the pharmacy says they never got my eye ointment from the doctor.", 'AGENT: I will make sure the team sees that.'].join('\n'),
  },
];

/** Named callers with no request: the reader reads none, and nothing files. */
const NAMED_NO_REQUEST: Array<{ sid: string; shape: string; transcript: string; heard: { firstName: string; lastName: string } }> = [
  {
    sid: 'CAa98523d2ab8575c93f02a838022b54ff',
    shape: 'an hours question the agent answered',
    heard: { firstName: 'Dana', lastName: 'Holt' },
    transcript: [GREETING, 'CALLER: Hi, this is Dana Holt, what time do you open tomorrow?', 'AGENT: Our offices open at 8 AM.', 'CALLER: Okay, thank you.'].join('\n'),
  },
  {
    sid: 'CAddb58d33a7331fe4e5549031d13fc0c2',
    shape: 'a question answered on the call',
    heard: { firstName: 'Ruth', lastName: 'Vale' },
    transcript: [GREETING, 'CALLER: My name is Ruth Vale, I just wanted to know if you are open on Saturday.', 'AGENT: Our offices are closed on weekends.', 'CALLER: Got it, thanks.'].join('\n'),
  },
  {
    sid: 'CAb93309bc01af2a6738d99053e28ef41e',
    shape: 'Spanish, wants only an agent',
    heard: { firstName: 'Tomas', lastName: 'Ruelas' },
    transcript: [GREETING, 'CALLER: Me llamo Tomas Ruelas, quiero hablar con un agente.', 'AGENT: Puedo tomar un mensaje. ¿En qué le puedo ayudar?', 'CALLER: No, con un agente nada más.'].join('\n'),
  },
];

describe('v276: no request read from the recording files nothing', () => {
  for (const c of STAND_IN_NO_REQUEST) {
    it(`${c.ticket} ${c.sid}: ${c.shape}`, async () => {
      const { payload, askRequest } = await sweep(c.transcript, { request: { request: null } });
      expect(askRequest).toHaveBeenCalledTimes(1);
      expect(payload).toBeUndefined();
    });
  }

  for (const c of NAMED_NO_REQUEST) {
    it(`${c.sid}: a named caller with ${c.shape} is not filed`, async () => {
      const { payload } = await sweep(c.transcript, { request: { request: null }, heard: c.heard });
      expect(payload).toBeUndefined();
    });
  }

  it('a certain identity with no request is not filed either', async () => {
    const { payload } = await sweep(
      [GREETING, 'CALLER: Yes, that is me.', 'AGENT: How can I help you tonight?', 'CALLER: Oh, never mind, I will wait until the morning.'].join('\n'),
      { request: { request: null }, identity: { firstName: 'Mara', lastName: 'Quill', dateOfBirth: '01/02/1950' } },
    );
    expect(payload).toBeUndefined();
  });

  it('an answer that says nothing, or names no topic, is no request', async () => {
    for (const request of ['Unclear.', 'Wants to speak with a representative.', '   ']) {
      h.submitSimplifiedTicket.mockClear();
      const { payload } = await sweep(
        [GREETING, 'CALLER: My name is Owen Lark, I just want somebody to call me.', 'AGENT: I can take a message.'].join('\n'),
        { request: { request }, heard: { firstName: 'Owen', lastName: 'Lark' } },
      );
      expect(payload).toBeUndefined();
    }
  });
});

describe('v276: a request read from the recording files only under a name', () => {
  for (const c of NAMED_REQUEST) {
    it(`${c.ticket} ${c.sid}: ${c.shape}`, async () => {
      const { payload } = await sweep(c.transcript, { request: { request: c.request }, heard: c.heard });
      expect(payload).toBeDefined();
      expect(payload.patientFullName).toBe(`${c.heard.firstName} ${c.heard.lastName}`);
      expect(payload.departmentId).toBe(AFTER_HOURS_DEPARTMENT_ID);
      expect(payload.additionalDetails).not.toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
    });
  }

  it('a certain identity with a request files under the record', async () => {
    const { payload, askRequest } = await sweep(
      [GREETING, 'CALLER: Yes. I need to move my appointment on Thursday to the afternoon.', 'AGENT: I will pass that on.'].join('\n'),
      { identity: { firstName: 'Mara', lastName: 'Quill', dateOfBirth: '01/02/1950' } },
    );
    expect(payload?.patientFullName).toBe('Mara Quill');
    expect(askRequest).toHaveBeenCalledTimes(1);
  });

  it("a sentence carrying the held patient's name is asked for again (the held names reach the reader)", async () => {
    const answers: RequestAnswer[] = [
      { request: 'Mara Quill wants to move an appointment.' },
      { request: 'Wants to move an appointment.' },
    ];
    const { payload, askRequest } = await sweep(
      [GREETING, 'CALLER: Yes. I need to move my appointment on Thursday to the afternoon.', 'AGENT: I will pass that on.'].join('\n'),
      {
        request: async () => answers.shift() ?? null,
        identity: { firstName: 'Mara', lastName: 'Quill', dateOfBirth: '01/02/1950' },
      },
    );
    expect(askRequest).toHaveBeenCalledTimes(2);
    expect(payload?.patientFullName).toBe('Mara Quill');
  });

  it('CAb3028d29030d258608d043c9838a2c29 (VA-90194): a stand-in asking for the on-call doctor is not filed', async () => {
    // "Wants to reach the on-call doctor." passes the reader's checks, so only
    // the identity rule stops it.
    const { payload } = await sweep(
      [GREETING, 'CALLER: I need the on-call doctor.', 'AGENT: Can you tell me what is going on?', 'CALLER: Just get me the doctor.'].join('\n'),
      { request: { request: 'Wants to reach the on-call doctor.' } },
    );
    expect(payload).toBeUndefined();
  });

  it('CA724fad6b1c1095d7edce728856262ef6 (VA-88389): a stand-in pharmacy message is not filed (the stated cost)', async () => {
    const { payload } = await sweep(
      [GREETING, 'CALLER: Hi, this is the pharmacy calling, a prescription is ready for pickup for one of your patients.', 'AGENT: Thank you, I can pass that on.'].join('\n'),
      { request: { request: 'Wants a pharmacy to know a prescription is ready.' } },
    );
    expect(payload).toBeUndefined();
  });

  it('a first answer that fails a content check and a clean second answer files', async () => {
    const answers: RequestAnswer[] = [
      { request: 'Wants to reschedule an appointment on March 3.' },
      { request: 'Wants to reschedule an appointment.' },
    ];
    const { payload, askRequest } = await sweep(
      [GREETING, 'CALLER: My name is Owen Lark, I need to reschedule my appointment on March third.', 'AGENT: I will pass that on.'].join('\n'),
      { request: async () => answers.shift() ?? null, heard: { firstName: 'Owen', lastName: 'Lark' } },
    );
    expect(askRequest).toHaveBeenCalledTimes(2);
    expect(payload?.patientFullName).toBe('Owen Lark');
  });

  it('two answers that both fail a content check still read as a request (files under a name, not under a stand-in)', async () => {
    const named = await sweep(
      [GREETING, 'CALLER: My name is Owen Lark, I need to talk to Dr. Lin about my drops.', 'AGENT: I will pass that on.'].join('\n'),
      { request: { request: 'Wants to talk to Dr. Lin.' }, heard: { firstName: 'Owen', lastName: 'Lark' } },
    );
    expect(named.askRequest).toHaveBeenCalledTimes(2);
    expect(named.payload?.patientFullName).toBe('Owen Lark');

    h.submitSimplifiedTicket.mockClear();
    const standIn = await sweep(
      [GREETING, 'CALLER: I need to talk to Dr. Lin about my drops.', 'AGENT: I will pass that on.'].join('\n'),
      { request: { request: 'Wants to talk to Dr. Lin.' } },
    );
    expect(standIn.payload).toBeUndefined();
  });
});

describe('v276: a reader that could not run files as before, with a note', () => {
  it('the reader answering nothing (no key, switched off) files a stand-in with the note', async () => {
    const { payload } = await sweep(
      [GREETING, 'CALLER: I need to move my appointment to next week.', 'AGENT: I can take that for the team.'].join('\n'),
      { request: null },
    );
    expect(payload?.patientFullName).toBe(STAND_IN_FULL_NAME);
    expect(payload.additionalDetails).toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
  });

  it('the reader throwing files a named caller with the note', async () => {
    const { payload } = await sweep(
      [GREETING, 'CALLER: My name is Owen Lark, I need to move my appointment.', 'AGENT: I can take that.'].join('\n'),
      {
        request: async () => {
          throw new Error('synthetic outage');
        },
        heard: { firstName: 'Owen', lastName: 'Lark' },
      },
    );
    expect(payload?.patientFullName).toBe('Owen Lark');
    expect(payload.additionalDetails).toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
  });
});

describe('v276: a records request is not read', () => {
  it('a records request files to Medical Records without asking the reader, even with a stand-in', async () => {
    const { payload, askRequest } = await sweep(
      [GREETING, "CALLER: I'm calling from a doctor's office, we need records for a mutual patient.", 'AGENT: Who is the patient?', 'CALLER: I will have to call back with that.'].join('\n'),
      { records: true, request: { request: null } },
    );
    expect(askRequest).not.toHaveBeenCalled();
    expect(payload?.departmentId).toBe(MEDICAL_RECORDS_DEPARTMENT_ID);
    expect(payload.additionalDetails).not.toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
  });
});

describe('v276: wiring', () => {
  it('the floor reads the request through the shared reader, and the production asker by default', () => {
    const src = readFileSync(new URL('./afterHoursTeardownFloor.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*readTheRequest[^}]*\} from '\.\.\/runtime\/requestFromTheRecording'/);
    expect(src).toContain('ctx.askRequest ?? askModelForTheRequest');
    expect(src).not.toMatch(/await import\(['"]\.\.\/runtime\/requestFromTheRecording['"]\)/);
  });
});
