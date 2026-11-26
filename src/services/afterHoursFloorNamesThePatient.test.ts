/**
 * v239: THE AFTER-HOURS FLOOR NAMES THE PATIENT THE CALLER SAID.
 *
 * The corpus is the after-hours teardown floor's "Unnamed Caller" tickets of
 * 2026-11-08..14 (26 in the Support Center), each read against its call. On
 * these the caller said the patient's first and last name and the ticket still
 * read "Unnamed Caller": the floor took a name only from a CERTAIN lookup,
 * while the queue lanes' sweep has read the name the caller said since v168
 * (an introduction by the calling number's own name) and v180 (the model,
 * kept only when the caller said both halves together in one turn).
 *
 * Each case is its call's shape with invented names and numbers. The model is
 * faked with the answer a correct reading gives; what is pinned is the code
 * around it. Real transcripts stay in `call_logs`, never in git (RULE THREE).
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
vi.mock('./syncAgentService', () => ({
  SyncAgentService: { submitSimplifiedTicket: h.submitSimplifiedTicket },
}));
vi.mock('./scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: h.lookupPatient },
}));
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
const { STAND_IN_FULL_NAME, STAND_IN_NAME_NOTE } = await import('./standInName');
const { HEARD_NAME_NOTE } = await import('../runtime/requestSweep');

const GREETING =
  "AGENT: Thank you for calling Azul Vision. Our offices are currently closed. All calls are being recorded for quality assurance purposes. If this is a medical emergency, please hang up and dial 911. Otherwise, I'm happy to help — how may I assist you?";

type Answer = { firstName?: string | null; lastName?: string | null } | null;

/**
 * v276: the floor reads whether a request was made before it files. Every
 * corpus call made one, so by default the request reader answers with one;
 * `reader: 'unavailable'` is the reader that could not run (no key, switched
 * off, a model failure), where the floor files as before so nothing is lost.
 */
type Reader = 'request' | 'unavailable';

let serial = 0;
async function sweep(
  transcript: string,
  answer: Answer,
  opts: { throws?: boolean; reader?: Reader } = {},
) {
  const n = ++serial;
  const callSid = `CA${String(n).padStart(32, '0')}`;
  const callId = `synthetic-floor-name-${n}`;
  floor.registerAfterHoursFloor({ callId, callSid, callerPhone: '+12025550100', dialedNumber: '+12025550199' }, 'no-ivr');
  const askName = vi.fn(async () => {
    if (opts.throws) throw new Error('synthetic outage');
    return answer;
  });
  const askRequest = vi.fn(async () =>
    (opts.reader ?? 'request') === 'unavailable' ? null : { request: 'Wants to move an eye appointment.' },
  );
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

/** The six tickets the heard name rescues, by real ticket and call SID. */
const RESCUED: Array<{ ticket: string; sid: string; shape: string; transcript: string; answer: { firstName: string; lastName: string } }> = [
  {
    ticket: 'VA-82178', sid: 'CA95b6cc0fb83eebe104c564af51a320cd',
    shape: 'a relative cancels for the patient; the patient named first, then the caller',
    transcript: [
      GREETING,
      'CALLER: To cancel an appointment.',
      'AGENT: I can help with that. Are you calling on behalf of someone else, or is this for yourself?',
      'CALLER: On behalf of someone else.',
      "AGENT: What is the patient's name?",
      'CALLER: Nora Vance.',
      'AGENT: Nora Vance. And your name?',
      'CALLER: Ivy Vance.',
      'AGENT: May I have your last name? Please spell it letter by letter.',
    ].join('\n'),
    answer: { firstName: 'Nora', lastName: 'Vance' },
  },
  {
    ticket: 'VA-83625', sid: 'CAb826c22f671d3285469e201cf964d51e',
    shape: 'Spanish, a parent books for a child; the caller gives her own name later',
    transcript: [
      GREETING,
      'CALLER: Español.',
      'AGENT: ¿En qué puedo ayudarle?',
      'CALLER: Ah, quería programar una cita para mi niño.',
      'AGENT: Entendido, una cita para su hijo. ¿Cuál es el nombre de su hijo?',
      'CALLER: Tomas Ruelas.',
      'AGENT: Tomas Ruelas. ¿Y su fecha de nacimiento, empezando por el mes?',
      'CALLER: Marzo 4, 2016.',
      'AGENT: ¿Me puede dar su nombre, por favor?',
      'CALLER: Elena Duarte.',
    ].join('\n'),
    answer: { firstName: 'Tomas', lastName: 'Ruelas' },
  },
  {
    ticket: 'VA-84815', sid: 'CA3603ad1c8045874061ba04d4fd9f6b0f',
    shape: 'a new patient gives both names to the first-name question, then spells the surname',
    transcript: [
      GREETING,
      "CALLER: I'd like to make an appointment to see a specialist.",
      'AGENT: Are you calling on behalf of someone else, or is this for yourself?',
      'CALLER: Myself.',
      "AGENT: Great. What's your first name?",
      'CALLER: Dale Rinker.',
      'AGENT: May I have your last name? Please spell it letter by letter.',
      'CALLER: R I N K E R',
      'AGENT: And your date of birth, starting with the month, then the day, then the year?',
      'CALLER: 4 12 61.',
      'CALLER: I, I don\'t know. What time is the office open?',
    ].join('\n'),
    answer: { firstName: 'Dale', lastName: 'Rinker' },
  },
  {
    ticket: 'VA-82935', sid: 'CA702b8f2f2251622f133d52fa54cca87b',
    shape: 'an optical lab asks for a frame status on a named patient; the caller gives her first name only',
    transcript: [
      GREETING,
      'CALLER: Leave a message for the optical.',
      "AGENT: I'm here to help. What should we know?",
      'CALLER: Calling for a frame status on your patient Paula Reyes.',
      "AGENT: Sure. What's the name of your business?",
      'CALLER: Northgate Lab.',
      'AGENT: Northgate Lab. And your name?',
      'CALLER: Jo.',
    ].join('\n'),
    answer: { firstName: 'Paula', lastName: 'Reyes' },
  },
  {
    ticket: 'VA-82942', sid: 'CA94332c5819bef108b291e8472cb76ed1',
    shape: 'the same lab, the patient named surname first with a compound surname',
    transcript: [
      GREETING,
      'CALLER: Leave a message for optical.',
      "AGENT: I'm here to help. What should we know?",
      'CALLER: Calling for a status update on the frame for Lopez Mora Teodora.',
      "AGENT: What's your name or the business you're calling from?",
      'CALLER: Northgate Lab.',
    ].join('\n'),
    answer: { firstName: 'Teodora', lastName: 'Lopez Mora' },
  },
  {
    ticket: 'VA-85410', sid: 'CA990e5367ab59c6b9760b157da879dbcc',
    shape: 'a caller confirms their own name in one turn, then asks for an appointment in another language',
    transcript: [
      GREETING,
      "AGENT: I'm sorry, I cannot hear you. Are you still there?",
      "CALLER: That's Karl Fenn, yes.",
      'AGENT: Hi Karl. What can I help you with?',
      'CALLER: Chinese, Mandarin.',
      'CALLER: 我要预约看眼睛。',
    ].join('\n'),
    answer: { firstName: 'Karl', lastName: 'Fenn' },
  },
];

describe('v239: the corpus — the floor files under the patient name the caller said', () => {
  for (const c of RESCUED) {
    it(`${c.ticket} (${c.sid}): ${c.shape}`, async () => {
      const { payload, askName } = await sweep(c.transcript, c.answer);
      expect(askName).toHaveBeenCalledWith(c.transcript);
      expect(payload.patientFullName).toBe(`${c.answer.firstName} ${c.answer.lastName}`);
      expect(payload.additionalDetails).toContain(HEARD_NAME_NOTE);
      expect(payload.additionalDetails).not.toContain(floor.FLOOR_MISSING_IDENTITY_NOTE);
      expect(payload.additionalDetails).not.toContain(STAND_IN_NAME_NOTE);
      // Still a floor ticket, still for review.
      expect(payload.additionalDetails).toContain(floor.FLOOR_NEEDS_REVIEW_NOTE);
      // v276: the reader confirmed a request, so the ticket says nothing about it.
      expect(payload.additionalDetails).not.toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
    });
  }

  it('VA-84815: the date of birth the caller answered still rides beside the heard name', async () => {
    const c = RESCUED.find((r) => r.ticket === 'VA-84815')!;
    const { payload } = await sweep(c.transcript, c.answer);
    expect(payload.patientDOB).toBe('04/12/1961');
  });
});

describe('v239: still fails, and correctly refused', () => {
  // v276: a request whose patient the floor cannot name is not filed at all
  // (operator, 2026-11-26: "We shouldnt be filing tickets unless we can identify
  // the patient and there is a valid request"). v239's refusal still decides
  // which name a ticket may carry, and it is pinned on the arm that still files:
  // a request reader that could not run, where the stand-in goes out as before.
  const FILLER = [
    GREETING,
    'CALLER: Español.',
    'AGENT: ¿En qué puedo ayudarle?',
    'CALLER: Sí, eh, te habla señora Rosa Ortiz. Quiero hacer una cita para el señor Pablo, eh, Ortiz. Gracias.',
  ].join('\n');
  const DENIED = [
    GREETING,
    'CALLER: Cancel an appointment.',
    'AGENT: I can help with that. I was able to pull up a record. Is this for Greta?',
    'CALLER: No.',
  ].join('\n');
  const CROSSED = [
    GREETING,
    'CALLER: To cancel an appointment for my mother.',
    "AGENT: What is the patient's name?",
    'CALLER: Nora Vance.',
    'AGENT: And your name?',
    'CALLER: Ivy Lund.',
  ].join('\n');

  it('VA-85388 (CA63ca740bacad79db17e99a2b38c7eb83): a filler between the halves — not filed under a stand-in', async () => {
    const { payload } = await sweep(FILLER, { firstName: 'Pablo', lastName: 'Ortiz' });
    expect(payload).toBeUndefined();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('VA-85388: with the request reader down, still the stand-in, never the heard name', async () => {
    const { payload } = await sweep(FILLER, { firstName: 'Pablo', lastName: 'Ortiz' }, { reader: 'unavailable' });
    expect(payload.patientFullName).toBe(STAND_IN_FULL_NAME);
    expect(payload.additionalDetails).toContain(STAND_IN_NAME_NOTE);
    expect(payload.additionalDetails).not.toContain(HEARD_NAME_NOTE);
    expect(payload.additionalDetails).toContain(floor.FLOOR_REQUEST_NOT_CONFIRMED_NOTE);
  });

  it('VA-84172 (CA578334d5580401a6de5c3002f19c8b6a): the caller denied the only name the agent said — never filed under it', async () => {
    // A model that took the agent's own word for it is refused: the caller
    // never said either half. With nobody named, the request is not filed.
    const { payload } = await sweep(DENIED, { firstName: 'Greta', lastName: 'Holm' });
    expect(payload).toBeUndefined();
    const down = await sweep(DENIED, { firstName: 'Greta', lastName: 'Holm' }, { reader: 'unavailable' });
    expect(down.payload.patientFullName).toBe(STAND_IN_FULL_NAME);
    expect(down.payload.additionalDetails).toContain(floor.FLOOR_MISSING_IDENTITY_NOTE);
  });

  it('a model that crosses the caller with the patient is refused (the halves were never said together)', async () => {
    expect((await sweep(CROSSED, { firstName: 'Ivy', lastName: 'Vance' })).payload).toBeUndefined();
    const down = await sweep(CROSSED, { firstName: 'Ivy', lastName: 'Vance' }, { reader: 'unavailable' });
    expect(down.payload.patientFullName).toBe(STAND_IN_FULL_NAME);
  });

  it('a name model that answers nothing, a half, or throws: not filed when a request was read, the stand-in when the reader is down', async () => {
    const t = `${GREETING}\nCALLER: Please have someone call me back about my glasses order.`;
    expect((await sweep(t, null)).payload).toBeUndefined();
    expect((await sweep(t, { firstName: 'Nora', lastName: null })).payload).toBeUndefined();
    expect((await sweep(t, { firstName: 'Nora', lastName: 'Vance' }, { throws: true })).payload).toBeUndefined();
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();

    expect((await sweep(t, null, { reader: 'unavailable' })).payload.patientFullName).toBe(STAND_IN_FULL_NAME);
    h.submitSimplifiedTicket.mockClear();
    expect((await sweep(t, { firstName: 'Nora', lastName: null }, { reader: 'unavailable' })).payload.patientFullName).toBe(STAND_IN_FULL_NAME);
    h.submitSimplifiedTicket.mockClear();
    const thrown = await sweep(t, { firstName: 'Nora', lastName: 'Vance' }, { throws: true, reader: 'unavailable' });
    expect(thrown.payload.patientFullName).toBe(STAND_IN_FULL_NAME);
    expect(thrown.payload.additionalDetails).toContain(STAND_IN_NAME_NOTE);
  });
});

describe('v239: the order of the readers', () => {
  it('a certain identity wins and the model is never asked', async () => {
    h.verifiedIdentityFor.mockReturnValue({ firstName: 'Mara', lastName: 'Quill', dateOfBirth: '01/02/1950', certain: true });
    const t = `${GREETING}\nCALLER: Please have someone call me back about my glasses order.`;
    const { payload, askName } = await sweep(t, { firstName: 'Nora', lastName: 'Vance' });
    expect(askName).not.toHaveBeenCalled();
    expect(payload.patientFullName).toBe('Mara Quill');
    expect(payload.additionalDetails).not.toContain(HEARD_NAME_NOTE);
  });

  it('the calling number\'s candidate is not used on its own: a name the caller said decides', async () => {
    // v168's introduction rule cannot fire under the after-hours greeting, so
    // the floor does not consult the candidate at all. A caller who names
    // somebody else is filed under that name, never the number's.
    h.unconfirmedCandidateFor.mockReturnValue({ firstName: 'Mara', lastName: 'Quill' });
    const t = `${GREETING}\nCALLER: Calling for my son Theo Quill, he needs his appointment moved.`;
    const { payload } = await sweep(t, { firstName: 'Theo', lastName: 'Quill' });
    expect(payload.patientFullName).toBe('Theo Quill');
    expect(payload.additionalDetails).toContain(HEARD_NAME_NOTE);
  });

  it('the v168 introduction rule cannot fire under the after-hours greeting (why the floor does not use it)', async () => {
    const { callerSaidTheName } = await import('../runtime/callerSaidTheName');
    const intro = '\nCALLER: My name is Mara Quill. I need to move my appointment on Monday.';
    expect(callerSaidTheName(`AGENT: How can I help?${intro}`, 'Mara', 'Quill')).toBe(true);
    expect(callerSaidTheName(`${GREETING}${intro}`, 'Mara', 'Quill')).toBe(false);
  });
});

describe('v239: the production wiring', () => {
  const source = readFileSync(new URL('./afterHoursTeardownFloor.ts', import.meta.url), 'utf8');
  it('the floor asks the v180 model by default', () => {
    expect(source).toMatch(/nameForTheFloor\(transcript, ctx\.askName \?\? askModelForThePatientName\)/);
  });
  it('reads the name readers through static imports (v141)', () => {
    expect(source).toMatch(/import \{[^}]*nameFromTheRecording[^}]*\} from '\.\.\/runtime\/nameFromTheRecording'/);
    expect(source).not.toMatch(/await import\('\.\.\/runtime\/nameFromTheRecording'\)/);
  });
  it('one copy of each staff note, shared with the queue sweep', () => {
    expect(source).not.toContain('NAME TAKEN FROM THE RECORDING');
    expect(source).toMatch(/HEARD_NAME_NOTE/);
  });
});
