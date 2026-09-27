/**
 * AN EMAIL PREFERENCE WITHOUT AN ADDRESS IS A QUESTION, NOT A TECHNICAL FAILURE.
 *
 * `CA42f5b35d3924b8a1e5e66c00ee927742`, no-ivr, 2026-09-27 20:48 UTC, 217 s,
 * 14 caller lines. A reschedule request; the caller asked to be reached by
 * email and spelled the address out on the call. The model called
 * `create_ticket` with `preferred_contact: "email"` and no `email` argument;
 * the ticketing app refused HTTP 400 for `patientEmail`; the refusal reached
 * the handler in the app's own spelling ("Missing required fields"), which
 * nothing matched; the generic branch spoke *"I'm experiencing a technical
 * issue on my end right now. I have your information and our team will call
 * you back."* No ticket of any provenance exists for that call.
 *
 * TWO FIXES, BOTH DRIVEN HERE AT THE REAL AGENT (`createNoIvrAgent`, the tool
 * invoked the way the SDK invokes it — the same preamble `noIvrDobEscape.test.ts`
 * uses, because a helper proven alone proves the helper and not that this lane
 * calls it, failure mode 10):
 *
 *   1. The handler asks for the address ONCE, before the schedule lookup and
 *      before any POST, keyed on the CallSid through `gateAttempts`; on the
 *      next attempt the request FILES for a phone callback with a note.
 *   2. A field refusal that DOES reach the handler — in either spelling — is
 *      answered as a question naming the field in words, never as the apology.
 *
 * Synthetic caller, synthetic address. RULE THREE: real SIDs and shapes in the
 * repo, real words on disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const h = vi.hoisted(() => ({
  submitSimplifiedTicket: vi.fn(
    async (_p: Record<string, unknown>): Promise<Record<string, unknown>> => ({
      success: true,
      ticketNumber: 'VA-TEST',
    }),
  ),
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
  callerMemoryService: {
    getCallerMemory: async () => null,
    buildContextForPrompt: () => '',
  },
}));

const { createNoIvrAgent, EMAIL_ASK_ONCE, EMAIL_ESCAPE_NOTE } = await import('./noIvrAgent');
const { resetDobHistory } = await import('../tools/dobEscape');
const { resetGateAttempts } = await import('../tools/gateAttempts');

async function call(agent: any, name: string, args: Record<string, unknown>) {
  const t = agent.tools.find((x: any) => x.name === name);
  expect(t, `${name} is not on the agent`).toBeTruthy();
  const raw = await t.invoke({}, JSON.stringify(args));
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

let n = 0;
/** A canonical Twilio SID per test — the ask is keyed on it. */
const freshSid = () => `CA${(++n).toString(16).padStart(32, '0')}`;

async function agentFor(callSid: string) {
  return createNoIvrAgent(async () => {}, { callId: `call-${callSid}`, callSid });
}

/** A complete reschedule request whose caller wants email. Synthetic. */
const request = (over: Record<string, unknown> = {}) => ({
  first_name: 'Test',
  last_name: 'Caller',
  date_of_birth: '01/04/1958',
  callback_number: '5551234567',
  request_category: 'reschedule_appointment',
  request_summary: "Needs to move next week's appointment to a later date.",
  preferred_contact: 'email',
  ...over,
});

const SYNTHETIC_EMAIL = 'test.caller@example.invalid';

/** The app's refusal on the corpus call, verbatim from voice_agent_api_logs. */
const APP_REFUSAL = {
  success: false,
  error:
    'Missing required fields: patientEmail. Please collect these from the patient before submitting., missing: patientEmail',
  message: 'There was a problem creating your request. Please try again.',
};

/**
 * The generic branch's own copy — what the caller on the corpus call heard.
 * Matched on ITS words, not on the phrase "technical issue" alone, because the
 * question that replaces it tells the model NOT to say there was one.
 */
const THE_APOLOGY = /FAILED to submit|Apologize sincerely|experiencing a technical issue on my end/i;

beforeEach(() => {
  resetDobHistory();
  resetGateAttempts();
  h.submitSimplifiedTicket.mockClear();
  h.submitSimplifiedTicket.mockImplementation(async () => ({ success: true, ticketNumber: 'VA-TEST' }));
});

describe('an email preference with no address is asked for ONCE', () => {
  it('the first attempt refuses with the question, and nothing is POSTed', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request());

    expect(r.success).toBe(false);
    expect(r.validation_errors).toEqual(['email address']);
    expect(r.message).toBe(EMAIL_ASK_ONCE);
    // The funnel: the format is in the question (RULE ZERO 2b), and the way
    // out is named, so the model never has to invent either.
    expect(r.message).toMatch(/What email address should we use\? Please spell it out for me, letter by letter\./);
    expect(r.message).toMatch(/preferred_contact set to "phone"/);
    // And it is never spoken as a failure — that is the defect.
    expect(r.message).not.toMatch(THE_APOLOGY);
    expect(r.message).toMatch(/Nothing has failed/);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  /**
   * THE FIX. Before it, an email preference with no address went to the wire
   * and came back as an apology. Now the second attempt on the same call files
   * — for a phone callback at the number the request already carries.
   */
  it('the second attempt on the SAME call files for a PHONE callback, with a note', async () => {
    const agent = await agentFor(freshSid());
    await call(agent, 'create_ticket', request());
    const r = await call(agent, 'create_ticket', request());

    expect(r.success, 'the second attempt was refused — the request is held on a missing email').toBe(true);
    expect(h.submitSimplifiedTicket).toHaveBeenCalledTimes(1);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('phone');
    expect(sent.patientPhone).toBe('5551234567');
    // Omitted, not blanked: the app refuses an empty string.
    expect(sent).not.toHaveProperty('patientEmail', '');
    expect(sent.patientEmail).toBeUndefined();
    // The staffer is told WHY the method changed, in additionalDetails …
    expect(String(sent.additionalDetails)).toContain(EMAIL_ESCAPE_NOTE);
    expect(String(sent.additionalDetails)).toMatch(/PHONE callback/);
    // THE NOTE CLAIMS ONLY WHAT THE CODE KNOWS (Codex P2, #335). On the corpus
    // call the caller spelled the address out and the model dropped it, so a
    // note saying it was "not captured on the call" was false on the call it
    // was written for. It says the address did not reach the TICKET, and
    // sends the staffer to the recording, where it may be sitting.
    expect(EMAIL_ESCAPE_NOTE).not.toMatch(/captured on the call/i);
    expect(EMAIL_ESCAPE_NOTE).toMatch(/no address reached this ticket/);
    expect(EMAIL_ESCAPE_NOTE).toMatch(/recording/);
    // … and never at the head of reasonForCalling, where the Request Type
    // header must stay the first line (operator, 2026-07-25).
    expect(String(sent.reasonForCalling).split('\n')[0]).toBe('Request Type: Appointment Request');
    // Nothing else moved.
    expect(sent.patientDOB).toBe('01/04/1958');
    expect(sent.patientFullName).toBe('Test Caller');
  });

  it('the ask is PER CALL — a different call is asked again', async () => {
    const a = await agentFor(freshSid());
    const b = await agentFor(freshSid());
    await call(a, 'create_ticket', request());
    const r = await call(b, 'create_ticket', request());
    expect(r.success, "one caller's ask counted for another's").toBe(false);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();
  });

  it('whitespace is "no address": asked for once, then filed with NO patientEmail key at all', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ email: '   ' }));
    expect(r.success).toBe(false);
    expect(r.validation_errors).toEqual(['email address']);
    expect(h.submitSimplifiedTicket).not.toHaveBeenCalled();

    const r2 = await call(agent, 'create_ticket', request({ email: '   ' }));
    expect(r2.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('phone');
    // Omitted, not blanked — the app reads `.trim()` and refuses a blank, so a
    // whitespace value forwarded as-is would be the 400 all over again.
    expect(sent.patientEmail).toBeUndefined();
  });

  it('the caller who then gives the address files by EMAIL, with no note', async () => {
    const agent = await agentFor(freshSid());
    await call(agent, 'create_ticket', request());
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('email');
    expect(sent.patientEmail).toBe(SYNTHETIC_EMAIL);
    expect(sent.additionalDetails ?? '').not.toMatch(/CONTACT PREFERENCE/);
  });

  it('the caller who then chooses phone files by PHONE, with no note — nothing was escaped', async () => {
    const agent = await agentFor(freshSid());
    await call(agent, 'create_ticket', request());
    const r = await call(agent, 'create_ticket', request({ preferred_contact: 'phone' }));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('phone');
    expect(sent.additionalDetails ?? '').not.toMatch(/CONTACT PREFERENCE/);
  });
});

describe('what does NOT change', () => {
  it('an email preference WITH an address files on the first attempt, by email', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('email');
    expect(sent.patientEmail).toBe(SYNTHETIC_EMAIL);
    expect(sent.additionalDetails ?? '').not.toMatch(/CONTACT PREFERENCE/);
  });

  it('a phone preference with no email files on the first attempt, as before', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ preferred_contact: 'phone' }));
    expect(r.success).toBe(true);
    const sent = h.submitSimplifiedTicket.mock.calls[0]![0];
    expect(sent.preferredContactMethod).toBe('phone');
    expect(sent.patientEmail).toBeUndefined();
    expect(sent.additionalDetails).toBeUndefined();
  });

  it('a text preference with no email files on the first attempt, as sms', async () => {
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ preferred_contact: 'text' }));
    expect(r.success).toBe(true);
    expect(h.submitSimplifiedTicket.mock.calls[0]![0].preferredContactMethod).toBe('sms');
  });
});

/**
 * THE SECOND HALF: a field refusal that reaches the handler from the wire —
 * because the app grew a new requirement, or the pre-check was bypassed — is a
 * QUESTION in either spelling, and never the apology.
 */
describe('a field refusal from the wire is a question, in either spelling', () => {
  it("the app's own wording (the corpus shape) names the email address and forbids the apology", async () => {
    h.submitSimplifiedTicket.mockImplementation(async () => APP_REFUSAL);
    const agent = await agentFor(freshSid());
    // The pre-check is satisfied — an address WAS sent — so this is the wire refusing.
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));

    expect(r.success).toBe(false);
    expect(r.validation_errors).toEqual(['patientEmail']);
    expect(r.message).toMatch(/^Missing required information: the email address/);
    expect(r.message).toMatch(/letter by letter/);
    expect(r.message).toMatch(/Nothing has failed/);
    // The defect, pinned from both sides: not the apology, and not the sink's
    // generic "try again" either, which would be a retry loop.
    expect(r.message).not.toMatch(THE_APOLOGY);
    expect(r.message).not.toMatch(/Please try again/);
  });

  it("the sink's wording is read the same way", async () => {
    h.submitSimplifiedTicket.mockImplementation(async () => ({
      success: false,
      error: 'Missing required information: patientEmail',
      message: 'I need to collect more information. Please ask the caller for: the email address.',
    }));
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));
    expect(r.success).toBe(false);
    expect(r.validation_errors).toEqual(['patientEmail']);
    expect(r.message).toMatch(/^Missing required information: the email address/);
    expect(r.message).not.toMatch(THE_APOLOGY);
  });

  it('a refusal for several fields names each of them', async () => {
    h.submitSimplifiedTicket.mockImplementation(async () => ({
      success: false,
      error: 'Missing required information: patientPhone, patientDOB',
      message: 'x',
    }));
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));
    expect(r.validation_errors).toEqual(['patientPhone', 'patientDOB']);
    expect(r.message).toMatch(/ten digits/);
    expect(r.message).toMatch(/month first, then the day, then the year/);
  });

  /** The control: an outage is still an outage, and the apology is still right for it. */
  it('an unrelated failure still speaks the technical-issue apology', async () => {
    h.submitSimplifiedTicket.mockImplementation(async () => ({
      success: false,
      error: 'Ticketing service is temporarily unavailable. Please try again.',
      message: 'There was a problem creating your request. Please try again.',
    }));
    const agent = await agentFor(freshSid());
    const r = await call(agent, 'create_ticket', request({ email: SYNTHETIC_EMAIL }));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(THE_APOLOGY);
    expect(r.validation_errors).toBeUndefined();
  });
});

/**
 * The funnel is in the prompt too, so the address is asked for at the moment
 * the preference is stated rather than discovered missing at filing. Read from
 * the source, the way noIvrPromptForGrok.test.ts reads the prompt.
 */
describe('the prompt asks for the address when email is chosen', () => {
  const SOURCE = readFileSync(new URL('./noIvrAgent.ts', import.meta.url), 'utf8');

  it('carries the funnel question in the contact-method block', () => {
    const block = SOURCE.slice(SOURCE.indexOf('PREFERRED CONTACT METHOD:'), SOURCE.indexOf('IF THIRD-PARTY CALL'));
    expect(block).toMatch(/IF EMAIL: "What email address should we use\?/);
    expect(block).toMatch(/spell\s+it out for me, letter by letter/);
    expect(block).toMatch(/ask once, then offer a\s+phone callback/);
    expect(block).toMatch(/Never say anything failed/);
  });
});
