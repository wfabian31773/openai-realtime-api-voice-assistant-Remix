/**
 * THE AFTER-HOURS LINE TRANSFERS A PROVIDER CALL ONLY WHEN THE CALLER SAID SO.
 *
 * Operator, 2026-10-19: "no escalation unless the caller themselves said they
 * are a provider." Corpus call CA4079341a0d7e7cbbc9daf36da56bb7c0: the caller
 * said "Operator.", the agent wrote "caller identified as operator/clinician",
 * and the on-call phone answered.
 *
 * Driven on the REAL agent with the caller's words fed the way the runtime
 * feeds them (noteCallerTranscript, the whole record per caller turn), because
 * the ledger the gate reads was fed only by the old core until v99 and a gate
 * proven on a hand-seeded ledger would have hidden exactly that.
 *
 * Synthetic callers and numbers. Nothing here is a real person.
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

const { createNoIvrAgent } = await import('./noIvrAgent');
const { resetGateAttempts } = await import('../tools/gateAttempts');
const { noteCallerTranscript, releaseCallerSpeech } = await import('../services/symptomCorroboration');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
const freshSid = () => `CA${(0x9900 + ++n).toString(16).padStart(32, '0')}`;

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

const GREETING = 'AGENT: Thank you for calling. Our offices are currently closed. How may I assist you?';
const THE_CORPUS_ESCALATION = {
  reason: 'Caller identified as operator/clinician requesting human escalation',
  caller_type: 'healthcare_provider',
};

beforeEach(() => {
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-TEST', message: 'VA-TEST' } as any);
});

describe('"Operator." is not a provider', () => {
  it('the corpus call is refused, nothing rings, and the ticket does not repeat the agent\'s claim as fact', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Operator.']);

    const r = await call(agent, 'escalate_to_human', THE_CORPUS_ESCALATION);
    expect(r.success).toBe(false);
    expect(r.refused).toBe('provider_not_stated_by_caller');
    expect(handoff).not.toHaveBeenCalled();
    // It asks before it says the refusal line, so a real clinician gets one question, not a goodbye.
    expect(r.message).toMatch(/BEFORE you say that line, ask ONE question/);
    expect(r.message).toMatch(/doctor's office, a hospital, a clinic or a laboratory, and which one/);

    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const ticket = h.submitSimplifiedTicket.mock.calls[0][0] as Record<string, string>;
    expect(ticket.reasonForCalling).toMatch(/^Caller asked to reach the on-call team/);
    expect(ticket.reasonForCalling).toMatch(/caller never said they were one/);
    expect(ticket.reasonForCalling).toMatch(/Agent's summary \(unverified\): Caller identified as operator/);
    expect(ticket.additionalDetails).toMatch(/NOT SANCTIONED \(provider_not_stated_by_caller\)/);
    releaseCallerSpeech(sid);
  });

  it('the same caller naming an ER on the next turn is connected, and the record supersedes the refusal ticket', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Operator.']);
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EARLIER', message: 'VA-EARLIER' } as any);
    const refused = await call(agent, 'escalate_to_human', THE_CORPUS_ESCALATION);
    expect(refused.refused).toBe('provider_not_stated_by_caller');

    noteCallerTranscript(sid, [
      GREETING,
      'CALLER: Operator.',
      "AGENT: Are you calling from a doctor's office, a hospital, a clinic or a laboratory, and which one?",
      'CALLER: This is the emergency room at Westside Memorial calling about a patient.',
    ]);
    h.submitSimplifiedTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-RECORD', message: 'VA-RECORD' } as any);
    const r = await call(agent, 'escalate_to_human', {
      ...THE_CORPUS_ESCALATION,
      reason: 'Emergency room at Westside Memorial calling about a patient',
    });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(2));
    const record = h.submitSimplifiedTicket.mock.calls[1][0] as Record<string, unknown>;
    expect(record.secondTicketOnThisCall).toEqual({ keySuffix: 'urgent-transfer' });
    expect(record.additionalDetails).toMatch(/SUPERSEDES VA-EARLIER/);
    expect(record.additionalDetails).toMatch(/No callback is needed on VA-EARLIER/);
    releaseCallerSpeech(sid);
  });

  it('v108: a lab with stat results is asked once, names the lab, and is connected (CA02cebe22 shape)', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    const intro = 'CALLER: Hi, this is Dana with Example Diagnostics calling on a recorded line. I have stat labs for Dr. Lin.';
    noteCallerTranscript(sid, [GREETING, intro]);
    const escalation = {
      reason: 'Diagnostics laboratory calling with stat lab results for the on-call physician',
      caller_type: 'healthcare_provider',
    };
    const refused = await call(agent, 'escalate_to_human', escalation);
    expect(refused.refused).toBe('provider_not_stated_by_caller');
    // The model is told a lab counts, so it calls again instead of saying the refusal line.
    expect(refused.message).toMatch(/a laboratory reporting results counts/);
    expect(refused.message).toMatch(/hospital, ER, lab or clinic/);

    noteCallerTranscript(sid, [
      GREETING,
      intro,
      "AGENT: Are you calling from a doctor's office, a hospital, a clinic or a laboratory, and which one?",
      'CALLER: From Example Diagnostics, uh, lab.',
    ]);
    const r = await call(agent, 'escalate_to_human', escalation);
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a caller who says who they are from the start rings straight through', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, "CALLER: Hi, I'm a PA calling from Mercy General's emergency room."]);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'PA from the emergency room requesting the on-call doctor',
      caller_type: 'healthcare_provider',
      provider_info: 'Mercy General emergency room',
    });
    expect(r.success).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    releaseCallerSpeech(sid);
  });

  it('a patient asking for their doctor by name is refused even when the agent calls it a clinician call', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: Can you speak to Doctor Shah please?']);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Caller requested to speak directly to Doctor Shah (clinician call)',
      caller_type: 'healthcare_provider',
    });
    expect(r.refused).toBe('provider_not_stated_by_caller');
    expect(handoff).not.toHaveBeenCalled();
    releaseCallerSpeech(sid);
  });
});

describe('review r1 (#359): the prompt tells the model a reporting lab is a clinician', () => {
  // The gate only runs once the model calls escalate_to_human. The legacy body
  // listed "we are a lab" as a business caller and neither body nor the tool
  // named a lab as a provider, so a lab would normally have been ticketed and
  // never reached the gate. Read from the REAL agent on both pipelines.
  async function built(pipeline?: 'runtime') {
    const sid = freshSid();
    const agent: any = await createNoIvrAgent(async () => {}, {
      callId: sid, callSid: sid, callerPhone: '5551234567', ...(pipeline ? { pipeline } : {}),
    } as any);
    return { instructions: String(agent.instructions) };
  }

  it('the runtime body lists a laboratory calling in results with the clinicians and keeps optical labs as businesses', async () => {
    const { instructions } = await built('runtime');
    expect(instructions).toMatch(/A clinician —[^\n]*a medical laboratory calling in a patient's results[^\n]*escalate NOW/);
    expect(instructions).toMatch(/A business — an optical lab \(frames, lenses, orders\)/);
  });

  it('the legacy body no longer files "we are a lab" as a business caller', async () => {
    const { instructions } = await built();
    expect(instructions).toMatch(/A medical laboratory calling in a patient's results/);
    expect(instructions).not.toMatch(/"we are a lab"/);
    expect(instructions).not.toMatch(/\[lab\/optical\/office\]/);
    expect(instructions).toMatch(/"we are an optical lab"/);
  });

  // The escalate_to_human field descriptions are NOT asserted here, on purpose:
  // @openai/agents 0.3.7 falls back to a converter that drops every zod
  // .describe() whenever a tool has an optional field, so on the runtime 1 of
  // this agent's 31 field descriptions reaches the model (measured 2026-10-21).
  // The prompt is the channel that does, and it is what the two tests above
  // read. The caller_type description is updated anyway, for when the
  // conversion is fixed.
});

describe('the symptom check the runtime never fed is live again', () => {
  it('pain the caller never mentioned no longer rings on the runtime', async () => {
    const sid = freshSid();
    const { agent, handoff } = await runtimeAgent(sid);
    noteCallerTranscript(sid, [GREETING, 'CALLER: I need to know when my glasses will be ready for pickup.']);
    const r = await call(agent, 'escalate_to_human', {
      reason: 'Patient with severe pain and sudden vision loss',
      caller_type: 'patient_urgent_medical',
      symptoms_summary: 'severe pain, sudden vision loss',
    });
    expect(r.refused).toBe('symptoms_not_stated_by_caller');
    expect(handoff).not.toHaveBeenCalled();
    releaseCallerSpeech(sid);
  });
});
