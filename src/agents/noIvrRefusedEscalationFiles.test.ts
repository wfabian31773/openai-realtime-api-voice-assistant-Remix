/**
 * A REFUSED AFTER-HOURS ESCALATION FILES THE TICKET.
 *
 * Operator, 2026-09-29: "fix the no-ivr refused escalation so it files a
 * ticket." The corpus call is CA05daa62fd6c7156a322ea4810d590923 (00:09 UTC
 * that morning, 417 seconds, 26 caller lines): escalate_to_human was refused
 * twice by the gate in under 3 ms, the agent then said TWICE that it would
 * connect the caller with the on-call team, create_ticket never ran, and the
 * call ended on terminate_call with no ticket of any provenance. Fourteen days
 * before it: 9 after-hours calls had an escalation refused, 3 left no ticket,
 * and all 3 spoke a promise to connect and never called create_ticket.
 *
 * Two links, both fixed here and both tested on the REAL agent (the tool
 * invoked the way the SDK invokes it — a helper proven in isolation proves the
 * helper and not that this lane calls it):
 *
 *   1. The refusal FILES. The directive alone ("call create_ticket now") was a
 *      sentence the model could ignore; the tool now files from its own
 *      arguments plus caller ID and tells the model what has ALREADY happened.
 *   2. The prompt no longer scripts the promise BEFORE the tool answers. Both
 *      bodies said "Say: 'I want to connect you with our on-call team' then
 *      call escalate_to_human" — so a refusal always arrived after a promise
 *      had been spoken.
 *
 * Synthetic caller, synthetic numbers. Nothing here is a real person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
vi.mock('../../server/storage', () => ({ storage: {} }));
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
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));

const {
  createNoIvrAgent,
  refusedEscalationResult,
  REFUSED_ESCALATION_LINE,
  knownNumber,
  transferRecordCrossReference,
} = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { recordCallerSpeech, releaseCallerSpeech } = await import('../services/symptomCorroboration');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;

type Meta = { callerPhone?: string; pipeline?: 'runtime' };
async function agentFor(callSid: string, meta: Meta = { callerPhone: '5551234567' }) {
  const handoff = vi.fn(async () => {});
  const agent = await createNoIvrAgent(handoff, { callId: `call-${callSid}`, callSid, ...meta } as any);
  return { agent, handoff };
}

/** Every way the old prompts promised a connection. */
const PROMISE = /I('| wi)ll connect you|connecting you with|I('| wi)ll transfer|transferring you|put you through to our/i;

/** An appointment is routine business — the gate's own ADMINISTRATIVE_SUBJECTS. */
const ROUTINE = {
  reason: 'Caller wants to reschedule an appointment for tomorrow and asked for the on-call doctor',
  caller_type: 'patient_urgent_medical',
};
/** "I could not do my job" — the gate's COMMUNICATION_FAILURE_TERMS. */
const COULD_NOT_UNDERSTAND = {
  reason: 'Unable to understand the caller after repeated attempts; they want someone to call them',
  caller_type: 'patient_urgent_medical',
};
/** A clinician — the gate's first case, sanctioned regardless of the rest. */
const CLINICIAN = {
  reason: "Nurse from the hospital's emergency department calling about a post-op patient",
  caller_type: 'healthcare_provider',
  provider_info: 'hospital emergency department',
};

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' } as any);
});

describe('a refused escalation files the ticket itself', () => {
  it('a routine request is refused, nothing is dialled, and the ticket is filed from the escalation', async () => {
    const sid = freshSid();
    const { agent, handoff } = await agentFor(sid);
    const r = await call(agent, 'escalate_to_human', ROUTINE);

    expect(handoff).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.refused).toBe('administrative_request');
    expect(r.ticket_filed).toBe(true);
    expect(r.ticketNumber).toBe('VA-TEST');

    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const p = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(p.reasonForCalling).toContain('reschedule an appointment');
    expect(p.additionalDetails).toMatch(/ESCALATION REQUESTED, NOT SANCTIONED \(administrative_request\)/);
    expect(p.reasonForCalling, 'the note must not displace the head of the description').not.toMatch(/NOT SANCTIONED/);
    expect(p.callSid).toBe(sid);
    expect(p.agentUsed).toBe('no-ivr');
    expect(p.patientPhone, 'caller ID is the callback when nothing else was given').toBe('5551234567');
    expect(p.patientDOB).toBe('Unknown');
    expect(p.patientFullName).toBe('Unknown Caller');
    expect(p.preferredContactMethod).toBe('phone');
  });

  it('the result tells the model what ALREADY happened, what to say, and never promises a connection', async () => {
    const { agent } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', ROUTINE);
    expect(r.message).toMatch(/ALREADY been filed/);
    expect(r.message).toMatch(/Do NOT call create_ticket/);
    expect(r.message).toContain(REFUSED_ESCALATION_LINE.callerId);
    expect(r.message).not.toMatch(PROMISE);
  });

  it('a communication failure files too, and carries the name and date of birth the escalation had', async () => {
    const { agent } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', {
      ...COULD_NOT_UNDERSTAND,
      patient_first_name: 'Test',
      patient_last_name: 'Caller',
      patient_dob: '01/04/1958',
    });
    expect(r.refused).toBe('communication_failure');
    expect(r.ticket_filed).toBe(true);
    const p = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(p.patientFullName).toBe('Test Caller');
    expect(p.patientDOB).toBe('01/04/1958');
    expect(p.additionalDetails).toMatch(/\(communication_failure\)/);
  });

  it('a number the caller GAVE beats caller ID, in the ticket and in the spoken line', async () => {
    const { agent } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', { ...ROUTINE, callback_number: '(714) 555-9876' });
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientPhone).toBe('7145559876');
    expect(r.message).toContain(REFUSED_ESCALATION_LINE.gave);
    expect(r.message).not.toContain(REFUSED_ESCALATION_LINE.callerId);
  });

  it('a withheld caller ID is a WORD, not a number: the line asks for one and the ticket carries none', async () => {
    const { agent } = await agentFor(freshSid(), { callerPhone: 'anonymous' });
    const r = await call(agent, 'escalate_to_human', ROUTINE);
    expect(r.ticket_filed).toBe(true);
    expect(h.submitSimplifiedTicket.mock.calls[0][0].patientPhone).toBeUndefined();
    expect(r.message).toContain(REFUSED_ESCALATION_LINE.none);
    expect(r.message).toMatch(/read it back one digit at a time/);
  });

  it('when the filing FAILS the result says nothing is on record and sends the model to create_ticket', async () => {
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: false, error: 'Validation failed', message: 'x' } as any);
    const { agent } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', ROUTINE);
    expect(r.success).toBe(false);
    expect(r.ticket_filed).toBe(false);
    expect(r.ticketNumber).toBeUndefined();
    expect(r.message).toMatch(/could NOT be filed/);
    expect(r.message).toMatch(/Validation failed/);
    expect(r.message).toMatch(/Call create_ticket now/);
    expect(r.message).not.toMatch(/ALREADY been filed/);
    expect(r.message).not.toMatch(/I've logged your message/);
    expect(r.message).not.toMatch(PROMISE);
  });

  it('symptoms the caller never said do not reach the ticket — the note says so and points at the recording', async () => {
    const sid = freshSid();
    const { agent } = await agentFor(sid);
    // What the caller actually said, recorded the way the transport records it.
    recordCallerSpeech(`call-${sid}`, 'I need to know when my glasses will be ready for pickup');
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Patient reports severe pain and sudden vision loss in the right eye',
      caller_type: 'patient_urgent_medical',
      symptoms_summary: 'severe pain, sudden vision loss',
    });
    expect(r.refused).toBe('symptoms_not_stated_by_caller');
    expect(r.ticket_filed).toBe(true);
    const p = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(p.reasonForCalling).toMatch(/NOT stated by the caller/);
    expect(p.reasonForCalling).toMatch(/read the recording/);
    expect(p.reasonForCalling, "the model's sentence must not become the request").not.toMatch(/Patient reports severe pain/);
    expect(p.additionalDetails).toMatch(/\(symptoms_not_stated_by_caller\)/);
    expect(r.message).toMatch(/once more/);
    releaseCallerSpeech(`call-${sid}`);
  });

  it('a filer that THROWS is a failed filing, never a thrown tool', async () => {
    h.submitSimplifiedTicket.mockRejectedValueOnce(new Error('socket hang up'));
    const { agent } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', ROUTINE);
    expect(r.ticket_filed).toBe(false);
    expect(r.message).toMatch(/socket hang up/);
    expect(r.message).toMatch(/Call create_ticket now/);
  });
});

describe('the urgent transfer record beside a refused-escalation ticket (Codex P1 on #339)', () => {
  const INVENTED_SYMPTOMS = {
    reason: 'Patient reports severe pain and sudden vision loss in the right eye',
    caller_type: 'patient_urgent_medical',
    symptoms_summary: 'severe pain, sudden vision loss',
  };
  const recordFiled = async () =>
    vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(2));

  it('a sanctioned escalation after a refusal files the record BESIDE the earlier ticket, not into it', async () => {
    const sid = freshSid();
    const { agent, handoff } = await agentFor(sid);
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EARLIER', message: 'VA-EARLIER' } as any);
    const refused = await call(agent, 'escalate_to_human', ROUTINE);
    expect(refused.ticketNumber).toBe('VA-EARLIER');

    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-RECORD', message: 'VA-RECORD' } as any);
    const r = await call(agent, 'escalate_to_human', CLINICIAN);
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    await recordFiled();

    const record = h.submitSimplifiedTicket.mock.calls[1][0];
    expect(record.priority).toBe('urgent');
    expect(record.reasonForCalling).toMatch(/^Request Type: Urgent\/Emergency Transfer/);
    // Its own key and no per-call claim — otherwise the sink hands VA-EARLIER back and posts nothing.
    expect(record.secondTicketOnThisCall).toEqual({ keySuffix: 'urgent-transfer' });
    expect(record.additionalDetails).toMatch(/SEE ALSO VA-EARLIER/);
    expect(record.additionalDetails).toMatch(/administrative_request/);
    expect(record.additionalDetails).toMatch(/still stands/);
    expect(record.additionalDetails).not.toMatch(/SUPERSEDES/);
  });

  it('after the uncorroborated-symptoms arm the record says the earlier ticket is superseded', async () => {
    const sid = freshSid();
    const { agent } = await agentFor(sid);
    recordCallerSpeech(`call-${sid}`, 'I need to know when my glasses will be ready for pickup');
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EARLIER', message: 'VA-EARLIER' } as any);
    const refused = await call(agent, 'escalate_to_human', INVENTED_SYMPTOMS);
    expect(refused.refused).toBe('symptoms_not_stated_by_caller');
    releaseCallerSpeech(`call-${sid}`);

    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-RECORD', message: 'VA-RECORD' } as any);
    await call(agent, 'escalate_to_human', CLINICIAN);
    await recordFiled();

    const record = h.submitSimplifiedTicket.mock.calls[1][0];
    expect(record.secondTicketOnThisCall).toEqual({ keySuffix: 'urgent-transfer' });
    expect(record.additionalDetails).toMatch(/SUPERSEDES VA-EARLIER/);
    expect(record.additionalDetails).toMatch(/No callback is needed on VA-EARLIER/);
    expect(record.additionalDetails).not.toMatch(/SEE ALSO/);
  });

  it('with no refusal on the call the record files exactly as before — one ticket, the call\'s own key', async () => {
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', CLINICIAN);
    await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1));
    const record = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(record.priority).toBe('urgent');
    expect(record.secondTicketOnThisCall).toBeUndefined();
    expect(record.additionalDetails).toBeUndefined();
  });

  it('a refusal whose filing FAILED leaves nothing to file beside — the record is the call\'s ticket', async () => {
    const sid = freshSid();
    const { agent } = await agentFor(sid);
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: false, error: 'Validation failed', message: 'x' } as any);
    const refused = await call(agent, 'escalate_to_human', ROUTINE);
    expect(refused.ticket_filed).toBe(false);

    await call(agent, 'escalate_to_human', CLINICIAN);
    await recordFiled();
    const record = h.submitSimplifiedTicket.mock.calls[1][0];
    expect(record.secondTicketOnThisCall).toBeUndefined();
    expect(record.additionalDetails).toBeUndefined();
  });

  it('the cross-reference is a pure function of the ticket and the arm', () => {
    const symptoms = transferRecordCrossReference({ ticketNumber: 'VA-1', code: 'symptoms_not_stated_by_caller' });
    expect(symptoms).toMatch(/^SUPERSEDES VA-1/);
    expect(symptoms).toMatch(/WAS connected/);
    for (const code of ['communication_failure', 'administrative_request'] as const) {
      const other = transferRecordCrossReference({ ticketNumber: 'VA-2', code });
      expect(other).toMatch(/^SEE ALSO VA-2/);
      expect(other).toContain(code);
      expect(other).not.toMatch(/No callback is needed/);
    }
  });
});

describe('what does not change', () => {
  it('a clinician is still dialled, the record ticket is the sanctioned one, and the refusal path is never taken', async () => {
    const { agent, handoff } = await agentFor(freshSid());
    const r = await call(agent, 'escalate_to_human', CLINICIAN);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
    expect(r.refused).toBeUndefined();
    expect(r.ticket_filed).toBeUndefined();
    await settle();
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const p = h.submitSimplifiedTicket.mock.calls[0][0];
    expect(p.reasonForCalling).toMatch(/URGENT TRANSFER/);
    expect(p.additionalDetails ?? '').not.toMatch(/NOT SANCTIONED/);
  });

  it('a second escalation after a sanctioned one is still the duplicate refusal, and files nothing', async () => {
    const { agent } = await agentFor(freshSid());
    await call(agent, 'escalate_to_human', CLINICIAN);
    await settle();
    const before = h.submitSimplifiedTicket.mock.calls.length;
    const r = await call(agent, 'escalate_to_human', ROUTINE);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/already transferred/i);
    expect(r.ticket_filed).toBeUndefined();
    await settle();
    expect(h.submitSimplifiedTicket.mock.calls.length).toBe(before);
  });
});

describe('the result, as a pure function', () => {
  it('the symptoms arm keeps the door open for an emergency the caller then describes', () => {
    const r = refusedEscalationResult({ code: 'symptoms_not_stated_by_caller', filed: { ok: true, ticketNumber: 'VA-1' }, number: 'callerId' });
    expect(r.message).toMatch(/you may call escalate_to_human once more/);
    expect(r.message).toMatch(/ONE question at a time/);
    const routine = refusedEscalationResult({ code: 'administrative_request', filed: { ok: true }, number: 'callerId' });
    expect(routine.message).not.toMatch(/once more/);
  });

  it('every arm forbids the promise, filed or not', () => {
    for (const code of ['communication_failure', 'administrative_request', 'symptoms_not_stated_by_caller'] as const) {
      for (const filed of [{ ok: true as const }, { ok: false as const, error: 'x' }]) {
        for (const number of ['gave', 'callerId', 'none'] as const) {
          const r = refusedEscalationResult({ code, filed, number });
          expect(r.message, `${code}/${filed.ok}/${number}`).toMatch(/Do NOT say you will connect, transfer or put anyone through/);
          expect(r.message, `${code}/${filed.ok}/${number}`).not.toMatch(PROMISE);
          expect(r.refused).toBe(code);
          expect(r.ticket_filed).toBe(filed.ok);
        }
      }
    }
  });

  it('knownNumber wants ten digits — a withheld caller ID is a word', () => {
    expect(knownNumber('anonymous')).toBe(false);
    expect(knownNumber('')).toBe(false);
    expect(knownNumber(undefined)).toBe(false);
    expect(knownNumber('555-1234')).toBe(false);
    expect(knownNumber('+1 (714) 555-1234')).toBe(true);
    expect(knownNumber('7145551234')).toBe(true);
  });
});

describe('the prompts no longer promise before the tool answers', () => {
  async function bodies() {
    const legacy = (await agentFor(freshSid())).agent.instructions as string;
    const grok = (await agentFor(freshSid(), { callerPhone: '5551234567', pipeline: 'runtime' })).agent.instructions as string;
    return { legacy, grok };
  }

  it('both bodies say a refusal has ALREADY filed the ticket and forbid the promise after it', async () => {
    const { legacy, grok } = await bodies();
    for (const body of [legacy, grok]) {
      expect(body).toMatch(/it has ALREADY filed\s*\n?\s*a ticket/);
      expect(body).toMatch(/never say you will connect, transfer or put anyone through/);
      expect(body).toMatch(/say nothing about connecting anyone until it answers/);
    }
  });

  it('neither body scripts the connect line BEFORE escalate_to_human is called', async () => {
    const { legacy, grok } = await bodies();
    expect(legacy).not.toMatch(/Say: "Based on what you're describing, I want to connect you/);
    expect(legacy).not.toMatch(/"Let me connect you with someone who can help\." → call escalate_to_human/);
    expect(grok).not.toMatch(/For a clinician say "I'll connect you/);
    expect(grok).not.toMatch(/For an emergency say "Based on what you're describing, I want to connect you/);
  });
});

describe('the refusal is countable', () => {
  it("`refused` and `ticket_filed` are on the tool timeline's outcome allow-list", () => {
    const src = readFileSync(join(__dirname, '..', 'services', 'toolTimeline.ts'), 'utf8');
    expect(src).toMatch(/'refused',/);
    expect(src).toMatch(/'ticket_filed',/);
  });
});
