/**
 * v267: A CALL THE AGENT PROMISED A FOLLOW-UP ON IS NOT AN ANSWERED CALL.
 *
 * `record_answered_question` tells the after-hours teardown floor that nothing
 * is owed, so the floor files nothing. On these no-ivr calls of 2026-11-08..22
 * the agent told the caller the team would follow up, or the caller said yes to
 * an offer to pass something along, or the caller asked to move or book an
 * appointment, and the agent then recorded the call as answered. No ticket of
 * any provenance exists for any of them.
 *
 * The tool now takes the model's own read, `follow_up_owed` (required on the
 * wire). The model is faked with the answer a correct reading gives; what is
 * pinned is the code around it: a yes is refused, the refusal stays on the
 * timeline, and the floor files the request when the caller hangs up. Each
 * case is its call's shape with invented names and numbers. Real transcripts
 * stay in `call_logs`, never in git (RULE THREE).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

const NOT_FOUND = { patientFound: false, upcomingAppointments: [], pastAppointments: [], totalAppointmentsFound: 0 };

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(),
  getCallLogBySid: vi.fn(),
}));

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({
  storage: { updateCallLog: async () => undefined, getCallLogBySid: h.getCallLogBySid },
}));
vi.mock('../services/syncAgentService', () => ({
  SyncAgentService: {
    submitSimplifiedTicket: h.submitSimplifiedTicket,
    checkOpenTickets: async () => [],
    requiresCallback: () => true,
  },
}));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByPhone: async () => NOT_FOUND,
    lookupByNameAndDOB: async () => NOT_FOUND,
    lookupPatient: async () => NOT_FOUND,
    formatContextForAgent: () => '',
  },
}));
vi.mock('../services/callerMemoryService', () => ({
  callerMemoryService: { getCallerMemory: async () => null, buildContextForPrompt: () => '' },
}));
vi.mock('../services/afterHoursCallFacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/afterHoursCallFacts')>()),
  officeTheCallerGave: async () => undefined,
}));

const { createNoIvrAgent } = await import('./noIvrAgent');
const floor = await import('../services/afterHoursTeardownFloor');
const { getAzulTimeline } = await import('../services/toolTimeline');
const { answeredWithoutTicket } = await import('../services/answeredCallDisposition');
const { FOLLOW_UP_OWED_FIX, FOLLOW_UP_OWED_DESCRIPTION, answeredQuestionResult } = await import('./afterHoursAnsweredQuestion');

const GREETING =
  'AGENT: Thank you for calling Azul Vision. Our offices are currently closed. All calls are being recorded for quality assurance purposes. If this is a medical emergency, please hang up and dial 911. Am I speaking with Testa?';

let serial = 0;
async function agentFor() {
  const n = ++serial;
  const callSid = `CA${n.toString(16).padStart(32, '0')}`;
  const callId = `call-${callSid}`;
  const agent = await createNoIvrAgent(vi.fn(async () => {}), { callId, callSid, callerPhone: '+12025550100' } as any);
  floor.registerAfterHoursFloor({ callId, callSid, callerPhone: '+12025550100', dialedNumber: '+12025550199' }, 'no-ivr');
  return { agent, callId, callSid };
}

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** The model records the call; the caller hangs up; the floor runs. */
async function recordThenHangUp(transcript: string, args: Record<string, unknown>) {
  const { agent, callId } = await agentFor();
  const result = await call(agent, 'record_answered_question', args);
  const answered = answeredWithoutTicket({ events: getAzulTimeline(callId) ?? [] });
  await floor.sweepAfterHoursUnfiledCall(callId, { outcome: 'caller_hangup', transcript, askName: async () => null });
  return { result, answered, filed: h.submitSimplifiedTicket.mock.calls.length };
}

beforeEach(() => {
  h.submitSimplifiedTicket.mockReset().mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });
  h.getCallLogBySid.mockReset().mockResolvedValue(undefined);
});

/** The calls where something was owed, by real SID. */
const OWED: Array<{ sid: string; shape: string; transcript: string }> = [
  {
    sid: 'CA84379080641a49df95c4591e26173d45',
    shape: 'a reschedule; the agent says the team will reach out, the caller says they will call back',
    transcript: [
      GREETING,
      'CALLER: Yes.',
      'AGENT: Your record is confirmed. What can I help you with?',
      'CALLER: I want to cancel that date and move my appointment to another day, 3:30 in the afternoon.',
      'AGENT: For the cancellation and the new time, our team will reach out to set it up. Would you prefer we call, text, or email you back?',
      'CALLER: Okay, I call you back tomorrow. What time do you open?',
      'AGENT: The office opens at eight AM. Anything else?',
      "CALLER: That's all.",
    ].join('\n'),
  },
  {
    sid: 'CAcfdaf663f0c4df8c268a1b35bb9b1e5e',
    shape: 'a reschedule to a named day; the agent asks how to reach them, the caller says thanks',
    transcript: [
      GREETING,
      'CALLER: Yes.',
      'AGENT: What can I help you with?',
      'CALLER: I would like to reschedule my appointment for next week.',
      'AGENT: What day works better for you?',
      'CALLER: Next Tuesday.',
      'AGENT: Next Tuesday would be November 24th. Would you prefer we call, text, or email you back?',
      'CALLER: Thanks.',
    ].join('\n'),
  },
  {
    sid: 'CA0b8288023f795882217d179d8f3cb3b0',
    shape: 'a text said the appointment was cancelled; the caller says yes to the team reaching out',
    transcript: [
      GREETING,
      'CALLER: Yes.',
      'AGENT: What can I help you with?',
      'CALLER: I got a text that my appointment today was cancelled and I have to reschedule.',
      'AGENT: The appointment still shows active. Would you like me to have the team reach out to sort it out?',
      'CALLER: Yeah, I need to know if I still come in or if I have to reschedule.',
      'AGENT: The office opens at eight AM. Anything else?',
      "CALLER: Okay, I'll try calling back at eight.",
    ].join('\n'),
  },
  {
    sid: 'CA1a8ca6f6f07dc38f3468c48713a91430',
    shape: 'a referral appointment; the agent says the on-call doctor will get the message and call back',
    transcript: [
      GREETING,
      'CALLER: Yes.',
      'AGENT: What can I help you with?',
      'CALLER: I need to make an appointment with the eye specialist, my regular doctor is sending me.',
      'AGENT: I can make sure the on-call doctor receives your message and can call you back. Is this the best number to reach you?',
      'CALLER: Yeah. What time do they open tomorrow?',
      'AGENT: All of our offices open at 8 AM. Anything else?',
      'CALLER: I want to make the appointment, but I will call tomorrow, okay?',
    ].join('\n'),
  },
  {
    sid: 'CA92f80e74bb02c180f5b63c077f1391ce',
    shape: 'an appointment request; the caller asks to leave a message and the agent says it will pass it on',
    transcript: [
      GREETING.replace('Am I speaking with Testa?', 'How may I assist you?'),
      'CALLER: I need to schedule an appointment. When is the office open?',
      'AGENT: All of our offices open at 8 AM on weekdays. Anything else?',
      'CALLER: Can I leave a message?',
      "AGENT: I'm here to help. I'll get your message to the right person. What should we know?",
    ].join('\n'),
  },
  {
    sid: 'CAcd6e996dd23bf1c05102ab7720c5eedc',
    shape: 'Spanish; the caller asks to be notified about the appointment and the agent reads the callback number back',
    transcript: [
      GREETING,
      'CALLER: Sí.',
      'AGENT: ¿En qué le puedo ayudar?',
      'CALLER: Quiero saber de mi cita del 23 de noviembre.',
      'AGENT: Su cita es el lunes 23 de noviembre a las nueve y cuarenta. ¿Algo más?',
      'CALLER: Nada más que me notifiquen, por favor, gracias.',
      'AGENT: Tengo su número para devolver la llamada y quiere que le avisen de su cita del lunes 23 de noviembre.',
    ].join('\n'),
  },
  {
    sid: 'CA609328aa5720e266743acc3d2fca1864',
    shape: 'the caller asks for a sooner appointment and says they will call themselves (filed under this rule; the operator can overrule)',
    transcript: [
      GREETING,
      'CALLER: Yes.',
      'AGENT: What can I help you with?',
      'CALLER: I need to make an appointment. I have one next month, but I have a problem with my eyes.',
      'AGENT: I understand you would like to be seen sooner.',
      "CALLER: Yeah, but I'll call tomorrow when it's open.",
      "AGENT: That's fine.",
    ].join('\n'),
  },
];

/** Calls the agent rightly closed as answered, by real SID. */
const ANSWERED: Array<{ sid: string; shape: string; transcript: string }> = [
  {
    sid: 'CAb62668184eac0dd5cca4d0446a677652',
    shape: 'practice questions; the caller declines each offer to pass one along',
    transcript: [
      GREETING.replace('Am I speaking with Testa?', 'How may I assist you?'),
      'CALLER: New patient eye care information. Are you open Sunday?',
      'AGENT: No, our offices are closed on weekends. Anything else?',
      'CALLER: Do you have a lab for same-day glasses?',
      "AGENT: I don't have that. Would you like me to pass that along?",
      "CALLER: No, thanks. That's all I need.",
    ].join('\n'),
  },
  {
    sid: 'CA8a3003884eecc6645f2c51977799dae2',
    shape: 'the caller confirms today\'s appointment and declines the offer to have the team look into the insurance',
    transcript: [
      GREETING,
      'CALLER: Yes. I needed to make sure I have an appointment today.',
      'AGENT: I see an appointment today at nine twenty-five AM. I can make sure the team looks into the insurance authorization. Would you like me to do that?',
      'CALLER: No, I think it should be fine. I will be there. Thank you.',
    ].join('\n'),
  },
  {
    sid: 'CA0af7c68de841a364a80ba18fd1d2ce61',
    shape: 'the caller asks to reschedule, hears the date, and keeps it',
    transcript: [
      GREETING,
      'CALLER: Yes. Reschedule the appointment.',
      'AGENT: You have an upcoming visit on Monday, December twenty-first at eight oh five AM. What day were you hoping to move it to?',
      "CALLER: Monday, December 21st. No, that's fine. Thank you.",
    ].join('\n'),
  },
];

describe('the model says something is owed: the call is not answered, and the floor files it', () => {
  it.each(OWED)('$sid: $shape', async ({ transcript }) => {
    const { result, answered, filed } = await recordThenHangUp(transcript, { follow_up_owed: true });
    expect(result).toMatchObject({ success: false, ticketCreated: false, refused: 'follow_up_owed', fix: FOLLOW_UP_OWED_FIX });
    expect(answered).toBe(false);
    expect(filed).toBe(1);
  });
});

describe('the model says nothing is owed: the call is answered, as before', () => {
  it.each(ANSWERED)('$sid: $shape', async ({ transcript }) => {
    const { result, answered, filed } = await recordThenHangUp(transcript, { follow_up_owed: false });
    expect(result).toEqual({ success: true, ticketCreated: false, callbackRequired: false });
    expect(answered).toBe(true);
    expect(filed).toBe(0);
  });

  it('an omitted answer records the call as answered, as before v267', async () => {
    const { result, answered, filed } = await recordThenHangUp(ANSWERED[0].transcript, {});
    expect(result).toEqual({ success: true, ticketCreated: false, callbackRequired: false });
    expect(answered).toBe(true);
    expect(filed).toBe(0);
  });
});

describe('after a refusal', () => {
  it('a later "nothing is owed" does not make the call answered again, so the floor still files', async () => {
    const { agent, callId } = await agentFor();
    await call(agent, 'record_answered_question', { follow_up_owed: true });
    const later = await call(agent, 'record_answered_question', { follow_up_owed: false });
    expect(later).toMatchObject({ success: true });
    expect(answeredWithoutTicket({ events: getAzulTimeline(callId) ?? [] })).toBe(false);
    await floor.sweepAfterHoursUnfiledCall(callId, { outcome: 'caller_hangup', transcript: OWED[0].transcript, askName: async () => null });
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
  });

  it('the refusal tells the model to file, never to send the caller to call back, and speaks nothing', () => {
    expect(FOLLOW_UP_OWED_FIX).toMatch(/create_ticket/);
    expect(FOLLOW_UP_OWED_FIX).toMatch(/Never tell the caller to call back/);
    // The refusal is for the model alone (v43): no channel the agent speaks.
    const refusal = answeredQuestionResult(true);
    for (const spoken of ['message', 'say', 'speak']) expect(refusal).not.toHaveProperty(spoken);
  });

  it('the timeline keeps the model\'s answer, so the refusals are countable', async () => {
    const { agent, callId } = await agentFor();
    await call(agent, 'record_answered_question', { follow_up_owed: true });
    const events = getAzulTimeline(callId) ?? [];
    const last = events[events.length - 1];
    expect(last.tool).toBe('record_answered_question');
    expect(last.args).toMatchObject({ follow_up_owed: true });
    expect(last.outcome).toMatchObject({ success: false, refused: 'follow_up_owed' });
  });
});

describe('the wire', () => {
  it('lists follow_up_owed as required and carries its description', async () => {
    const { agent } = await agentFor();
    const tool = agent.tools.find((x: any) => x.name === 'record_answered_question') as any;
    expect(tool.parameters.required).toEqual(['follow_up_owed']);
    expect(tool.parameters.properties.follow_up_owed).toMatchObject({ type: 'boolean', description: FOLLOW_UP_OWED_DESCRIPTION });
  });
});
