/**
 * A REFUSED AFTER-HOURS ESCALATION ASKS WHO IT IS ABOUT BEFORE IT FILES (v244).
 *
 * The overnight pass of 2026-11-16, the bucket "a field the department needs
 * is missing". v80 made a refused `escalate_to_human` file its own ticket at
 * once, from whatever the model passed, so a caller refused as an
 * administrative request or as an unstated provider was filed with no patient
 * name and no date of birth whenever the model had not collected them yet. The
 * after-hours line takes the patient's name and date of birth for every other
 * request (the operator's v235 ruling, "Ask before filing", on PCP).
 *
 * Measured, no-ivr, Pacific days 2026-11-01..15: 16 refused-escalation
 * tickets, 13 with no date of birth. 8 are not reached by v234 (a confirmed
 * record) or v190 (a records request) and are the corpus below, by real SID
 * and ticket number. Every caller line here is a synthetic stand-in in the
 * call's shape; nothing is a real person.
 *
 * On `main` the first refusal files at once with `patientDOB: 'Unknown'`. Here
 * the first refusal files nothing and asks, ONE field at a time; a call inside
 * the 2 s batch window is a sibling of the same model turn and asks again
 * without spending the ask; the next call files with the answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(async (_p: Record<string, unknown>) => ({
    success: true,
    ticketNumber: 'VA-TEST',
    message: 'VA-TEST',
  })),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { getCallLogBySid: async () => undefined } }));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: (p: Record<string, unknown>) => h.submitSimplifiedTicket(p),
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupByNameAndDOB: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
    lookupPatient: async () => ({ patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 }),
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const { pastTheIdentityAsk } = await import('./testSupport/pastTheIdentityAsk');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { noteCallerTranscript, releaseCallerSpeech } = await import('../services/symptomCorroboration');
const { noteSpokenDob, resetSpokenDobs } = await import('../tools/spokenDob');
const { getAzulTimeline } = await import('../services/toolTimeline');
const { sweepAfterHoursUnfiledCall } = await import('../services/afterHoursTeardownFloor');
const {
  decideRefusedEscalationIdentityAsk,
  ASKS_BEFORE_FILING_CODES,
} = await import('../services/onCallIdentityBeforeTransfer');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** On the runtime the agent's callId IS the CallSid; the bridge keys the ledger on it. */
async function runtimeAgent(callSid: string) {
  const handoff = vi.fn(async () => {});
  const agent = await createNoIvrAgent(handoff, {
    callId: callSid,
    callSid,
    callerPhone: '5551234567',
    pipeline: 'runtime',
  } as any);
  return { agent, handoff };
}

let n = 0;
const freshSid = () => `CA${(0xe500 + ++n).toString(16).padStart(32, '0')}`;

const GREETING = 'AGENT: Thank you for calling. Our offices are currently closed. How may I assist you?';
const NAME_ASK = "AGENT: What is the patient's first and last name?";
const DOB_ASK = "AGENT: And the patient's date of birth, starting with the month, then the day, then the year?";

const ADMINISTRATIVE = {
  reason: 'Caller wants to reschedule an appointment for tomorrow and asked for the on-call doctor',
  caller_type: 'patient_urgent_medical',
};
const UNSTATED_PROVIDER = {
  reason: 'Caller identified as operator/clinician requesting human escalation',
  caller_type: 'healthcare_provider',
};

type Code = 'administrative_request' | 'provider_not_stated_by_caller';

/** The 8 refused-escalation tickets of 2026-11-01..15 with no date of birth that v234 and v190 do not reach. */
const CORPUS: Array<{
  sid: string;
  ticket: string;
  code: Code;
  shape: 'once' | 'twice' | 'dob_after_refusal';
  callerOpening: string;
}> = [
  { sid: 'CA60bcd8f7138e52aaa92943189ed2aa6c', ticket: 'VA-79827', code: 'administrative_request', shape: 'once',
    callerOpening: 'CALLER: I need to move my appointment tomorrow, can I talk to the doctor?' },
  { sid: 'CAb8b3e93074cd7b447b8bca42ed17503b', ticket: 'VA-80406', code: 'administrative_request', shape: 'once',
    callerOpening: 'CALLER: I want to talk to somebody about my appointment.' },
  { sid: 'CA436b18a7680a7d1951a6f0f82ec97566', ticket: 'VA-82143', code: 'provider_not_stated_by_caller', shape: 'twice',
    callerOpening: 'CALLER: Operator.' },
  { sid: 'CA8d22b2799053f56f3db3bf4f1efc8cc2', ticket: 'VA-82152', code: 'provider_not_stated_by_caller', shape: 'once',
    callerOpening: 'CALLER: Can I talk to the doctor on call?' },
  { sid: 'CAd7c156762b690e8a9711c2eb6083ed89', ticket: 'VA-82198', code: 'provider_not_stated_by_caller', shape: 'once',
    callerOpening: 'CALLER: Representative please.' },
  { sid: 'CA69e5e061164f001d69ac3703321aec62', ticket: 'VA-83628', code: 'provider_not_stated_by_caller', shape: 'dob_after_refusal',
    callerOpening: 'CALLER: I need the doctor.' },
  { sid: 'CAd44cbed8a1e8337ceddf33d7a4a673b0', ticket: 'VA-85362', code: 'administrative_request', shape: 'once',
    callerOpening: 'CALLER: I need my appointment changed and I want to speak to someone.' },
  { sid: 'CA485767badc1cdbd08f81ea221509e7bb', ticket: 'VA-85447', code: 'provider_not_stated_by_caller', shape: 'twice',
    callerOpening: 'CALLER: Operator, please.' },
];

const escalationFor = (code: Code) => (code === 'administrative_request' ? ADMINISTRATIVE : UNSTATED_PROVIDER);

beforeEach(() => {
  resetGateAttempts();
  resetSpokenDobs();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' } as any);
});

describe('the corpus: the first refusal asks, and files nothing', () => {
  for (const c of CORPUS) {
    it(`${c.ticket} (${c.sid}, ${c.code}) is asked who the request is about before anything files`, async () => {
      const { agent, handoff } = await runtimeAgent(c.sid);
      noteCallerTranscript(c.sid, [GREETING, c.callerOpening]);

      const asked = await call(agent, 'escalate_to_human', escalationFor(c.code));
      expect(asked.success).toBe(false);
      expect(asked.refused).toBe(c.code);
      expect(asked.need_identity).toBe(true);
      expect(asked.ticket_filed).toBe(false);
      expect(h.submitSimplifiedTicket, 'nothing files on the ask').not.toHaveBeenCalled();
      expect(handoff).not.toHaveBeenCalled();
      // One field per question, the format inside the question (RULE ZERO 2b).
      expect(asked.message).toContain("What is the patient's first and last name?");
      expect(asked.message).toContain('starting with the month, then the day, then the year');
      expect(asked.message).toMatch(/ONE question at a time/);
      expect(asked.message).toMatch(/NOTHING has been filed yet/);
      expect(asked.message).not.toMatch(/connect you|put you through now/i);
      releaseCallerSpeech(c.sid);
    });
  }
});

describe('the corpus: the next call files with what the caller gave', () => {
  for (const c of CORPUS) {
    it(`${c.ticket} (${c.sid}) files with the patient's name and date of birth`, async () => {
      const { agent, handoff } = await runtimeAgent(c.sid);
      noteCallerTranscript(c.sid, [GREETING, c.callerOpening]);
      await call(agent, 'escalate_to_human', escalationFor(c.code));

      const lines = [
        GREETING,
        c.callerOpening,
        NAME_ASK,
        'CALLER: Dana Example.',
        DOB_ASK,
        'CALLER: March 3rd, 1950.',
      ];
      noteCallerTranscript(c.sid, lines);
      noteSpokenDob(c.sid, lines);

      // VA-83628: the second refusal came 10 s later as an administrative
      // request, and the model sent no date of birth: it comes from the
      // caller's answer to the ask.
      const second =
        c.shape === 'dob_after_refusal'
          ? { ...ADMINISTRATIVE, patient_first_name: 'Dana', patient_last_name: 'Example' }
          : { ...escalationFor(c.code), patient_first_name: 'Dana', patient_last_name: 'Example', patient_dob: '03/03/1950' };
      const r = await pastTheIdentityAsk(() => call(agent, 'escalate_to_human', second));
      expect(r.ticket_filed).toBe(true);
      expect(handoff).not.toHaveBeenCalled();
      expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
      const ticket = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, string>;
      expect(ticket.patientFullName).toBe('Dana Example');
      expect(ticket.patientDOB).toMatch(/^0?3\/0?3\/1950$/);
      expect(ticket.additionalDetails).toMatch(/NOT SANCTIONED/);
      releaseCallerSpeech(c.sid);
    });
  }
});

describe('the double-call shapes', () => {
  for (const c of CORPUS.filter((x) => x.shape === 'twice')) {
    it(`${c.ticket}: a second refusal with nothing new, past the window, files the stand-in rather than asking again`, async () => {
      const { agent } = await runtimeAgent(c.sid);
      noteCallerTranscript(c.sid, [GREETING, c.callerOpening]);
      await call(agent, 'escalate_to_human', escalationFor(c.code));
      noteCallerTranscript(c.sid, [GREETING, c.callerOpening, NAME_ASK, 'CALLER: Just have somebody call me.']);
      const r = await pastTheIdentityAsk(() => call(agent, 'escalate_to_human', escalationFor(c.code)));
      expect(r.ticket_filed).toBe(true);
      expect(r.need_identity).toBeUndefined();
      expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
      const ticket = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, string>;
      expect(ticket.patientDOB).toBe('Unknown');
      releaseCallerSpeech(c.sid);
    });
  }

  it('a sibling inside the 2 s batch window asks again and spends nothing', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Operator.']);
    const a = await call(agent, 'escalate_to_human', UNSTATED_PROVIDER);
    const b = await call(agent, 'escalate_to_human', UNSTATED_PROVIDER);
    expect(a.need_identity).toBe(true);
    expect(b.need_identity).toBe(true);
    expect(b.ticket_filed).toBe(false);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
    // The ask is still one ask: the next call past the window files.
    const c = await pastTheIdentityAsk(() => call(agent, 'escalate_to_human', UNSTATED_PROVIDER));
    expect(c.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });
});

describe('what files at once, as before', () => {
  it('a refusal carrying the name and date of birth files at once', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: I need to move my appointment tomorrow, can I talk to the doctor?']);
    const r = await call(agent, 'escalate_to_human', {
      ...ADMINISTRATIVE,
      patient_first_name: 'Dana',
      patient_last_name: 'Example',
      patient_dob: '03/03/1950',
    });
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a caller who will not give them is filed at once', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: I need to move my appointment tomorrow, can I talk to the doctor?']);
    const r = await call(agent, 'escalate_to_human', { ...ADMINISTRATIVE, details_declined: true });
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a post-op medication refusal files urgent at once (operator, 2026-10-02)', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: I had surgery today and my drops never got to the pharmacy.']);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Post-op patient: the steroid drop prescription never reached the pharmacy',
      caller_type: 'patient_urgent_medical',
    });
    expect(r.refused).toBe('post_op_medication');
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a communication failure files at once: another round of questions is what failed', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Unable to understand the caller after repeated attempts; they want someone to call them',
      caller_type: 'patient_urgent_medical',
    });
    expect(r.refused).toBe('communication_failure');
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('a symptom the caller did not say files at once with its own note', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: I want somebody to call me back about my eye.']);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Patient reports severe pain and sudden vision loss in the right eye',
      caller_type: 'patient_urgent_medical',
    });
    expect(r.refused).toBe('symptoms_not_stated_by_caller');
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a call with no real CallSid files at once: the ask could not be counted, so it would never file', async () => {
    const handoff = vi.fn(async () => {});
    const agent = await createNoIvrAgent(handoff, {
      callId: 'call-no-sid',
      callSid: 'unknown',
      callerPhone: '5551234567',
      pipeline: 'runtime',
    } as any);
    const r = await call(agent, 'escalate_to_human', ADMINISTRATIVE);
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('the decision: a 911-level mention files at once, and only the two codes ever ask', () => {
    const sid = freshSid();
    expect(
      decideRefusedEscalationIdentityAsk({
        callSid: sid,
        code: 'administrative_request',
        reason: 'Caller wants an appointment after a chemical splash to the eye',
      }),
    ).toEqual({ fileNow: true, skipReason: '911' });
    for (const code of ['post_op_medication', 'communication_failure', 'symptoms_not_stated_by_caller', 'records_request']) {
      expect(decideRefusedEscalationIdentityAsk({ callSid: sid, code })).toEqual({ fileNow: true, skipReason: 'code' });
    }
    expect([...ASKS_BEFORE_FILING_CODES].sort()).toEqual(['administrative_request', 'provider_not_stated_by_caller']);
  });

  it('the decision: a placeholder date is not a date of birth, so the ask names it', () => {
    const d = decideRefusedEscalationIdentityAsk({
      callSid: freshSid(),
      code: 'administrative_request',
      firstName: 'Dana',
      lastName: 'Example',
      dob: 'unknown',
    });
    expect(d).toEqual({ fileNow: false, missing: ['dob'] });
  });
});

describe('an unstated provider who then says where they call from', () => {
  it('rings with no ticket filed before it', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Operator.']);
    const asked = await call(agent, 'escalate_to_human', UNSTATED_PROVIDER);
    expect(asked.need_identity).toBe(true);
    expect(asked.message).toMatch(/FIRST ask ONE question/);

    noteCallerTranscript(sid, [
      GREETING,
      'CALLER: Operator.',
      "AGENT: Are you calling from a doctor's office, a hospital, a clinic or a laboratory, and which one?",
      "CALLER: Yes, I'm a nurse calling from the Example Hospital emergency room about a patient.",
    ]);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'ER nurse from Example Hospital calling about a mutual patient',
      caller_type: 'healthcare_provider',
      provider_info: 'Example Hospital emergency room',
    });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1));
    const record = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(record.secondTicketOnThisCall, 'no refusal ticket was filed, so the record is the call\'s own').toBeUndefined();
    expect(String(record.additionalDetails ?? '')).not.toMatch(/NOT SANCTIONED/);
    releaseCallerSpeech(sid);
  });

  it('VA-82198 (CAd7c156762b690e8a9711c2eb6083ed89): the filing after the ask does not ask the facility question again', async () => {
    const sid = 'CAd7c156762b690e8a9711c2eb6083ed89';
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Representative please.']);
    await call(agent, 'escalate_to_human', UNSTATED_PROVIDER);
    noteCallerTranscript(sid, [
      GREETING,
      'CALLER: Representative please.',
      "AGENT: Are you calling from a doctor's office, a hospital, a clinic or a laboratory, and which one?",
      'CALLER: No.',
    ]);
    const r = await pastTheIdentityAsk(() => call(agent, 'escalate_to_human', UNSTATED_PROVIDER));
    expect(r.ticket_filed).toBe(true);
    expect(r.message).toMatch(/already been asked; do not ask it again/);
    releaseCallerSpeech(sid);
  });
});

describe('the ask is countable', () => {
  it('need_identity reaches the timeline on the refused escalation', async () => {
    const sid = freshSid();
    const { agent } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Operator.']);
    await call(agent, 'escalate_to_human', UNSTATED_PROVIDER);
    const events = getAzulTimeline(sid) ?? [];
    const esc = events.filter((e: any) => e.tool === 'escalate_to_human');
    expect(esc.length).toBeGreaterThan(0);
    expect((esc[0] as any).outcome?.need_identity).toBe(true);
    expect((esc[0] as any).outcome?.refused).toBe('provider_not_stated_by_caller');
    releaseCallerSpeech(sid);
  });
});

describe('a caller who hangs up on the ask', () => {
  it('VA-79827 (CA60bcd8f7138e52aaa92943189ed2aa6c): the after-hours floor files the request the ask did not', async () => {
    const sid = 'CA60bcd8f7138e52aaa92943189ed2aa6c';
    // Its own callId: the timeline and the floor key on it, and the corpus
    // tests above already filed under this CallSid in this module.
    const callId = `floor-${sid}`;
    const agent = await createNoIvrAgent(vi.fn(async () => {}), {
      callId,
      callSid: sid,
      callerPhone: '5551234567',
      pipeline: 'runtime',
    } as any);
    const lines = [GREETING, 'CALLER: I need to move my appointment tomorrow, can I talk to the doctor?'];
    noteCallerTranscript(sid, lines);
    const asked = await call(agent, 'escalate_to_human', ADMINISTRATIVE);
    expect(asked.need_identity).toBe(true);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();

    // The caller hangs up on the question; teardown runs the floor.
    await sweepAfterHoursUnfiledCall(callId, {
      transcript: [...lines, NAME_ASK].join('\n'),
      askName: async () => null,
    } as any);
    expect(h.submitSimplifiedTicket, 'the request is filed by the floor, not lost').toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });
});
