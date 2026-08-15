/**
 * THE MEASURING STICK WAS CALIBRATED ON THE ANSWERING SERVICE.
 *
 * Operator, 2026-08-15: *"Do you also notice that your findings only affect the
 * agents that you created? You did not create the answering service — that is
 * what we are trying to break down into single agents. So something in the
 * answering service works but when you built individual agents, it stopped
 * working."*
 *
 * He was right, and it cuts two ways. One of them is this: the answering
 * service cold-opens and asks "may I have your first and last name?", and the
 * callback-fields grader was written against exactly that script. The
 * department agents were built to do something BETTER — pre-context matches
 * the caller from their number, so the agent confirms instead of interrogating:
 *
 *     AGENT:  Am I speaking with Charles?
 *     CALLER: Yes.
 *     AGENT:  Can you please tell me your last name?
 *     CALLER: Fate.
 *     AGENT:  Thank you, Charles.
 *
 * The name is collected and the ticket carries it. No pattern matched, so 104
 * tech/surgery/optical tickets were graded CRITICAL for a missing name that was
 * on the call — and I reported that number to the operator as the fleet's top
 * behavioural defect. It was the instrument not recognising the improvement.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
const { callGradingService } = await import('./callGradingService');

const base = {
  callLogId: 'test', transferredToHuman: false, ticketNumber: 'VA-51935' as string | null,
  agentSlug: 'tech' as string | null, totalTurns: 10, interruptionCount: 0,
  truncationCount: 0, toolCallCount: 4, durationSeconds: 150,
  firstTranscriptDelayMs: 800, postTranscriptTailMs: 0, localDurationSeconds: 150,
  transcriptWindowSeconds: 150, durationMismatchRatio: null, durationMismatchFlag: false,
};

/** Real transcripts, trimmed. VA-51935 and VA-51925, tech line, 08-14. */
const RECOGNITION_TECH = `AGENT: Thank you for calling Azul Vision clinical support. All of our technicians are currently assisting other patients, but I can take a message and they will follow up with you. Am I speaking with Charles?
CALLER: Yes.
AGENT: Great. Can you please tell me your last name?
CALLER: Fate.
AGENT: Thank you. And what's your date of birth?
CALLER: Nine six fifty-six.
AGENT: Thank you, Charles. It looks like I have your record here. What can I help you with today?
CALLER: I need a prescription refilled on the eye drops.
AGENT: Give me one moment while I get this submitted for you.
AGENT: Your request has been submitted. Our clinical team will call you back at 7605551234.`;

const COLD_OPEN_ANSWERING_SERVICE = `AGENT: Thank you for calling Azul Vision. May I have your first and last name?
CALLER: Paula Kolterman.
AGENT: And your date of birth?
CALLER: August 29th, 1952.
AGENT: What can I help you with?
CALLER: I need a refill on my drops.
AGENT: Give me one moment while I get this submitted for you.
AGENT: Your request has been submitted, we'll call you back at 7605551234.`;

const check = (transcript: string, name: string, over: Record<string, unknown> = {}) => {
  const results = callGradingService.runDeterministicGraders({ ...base, transcript, ...over } as never);
  const r = (results as Array<{ grader: string; pass: boolean; reason: string }>).find((x) => x.grader === name);
  expect(r, `grader ${name} did not run`).toBeTruthy();
  return r!;
};

describe('a name confirmed is a name collected', () => {
  it('does not fail a recognition-first greeting for a missing name', () => {
    const g = check(RECOGNITION_TECH, 'callback_fields_completeness');
    expect(g.reason, g.reason).not.toMatch(/missing:.*name/);
    expect(g.pass, g.reason).toBe(true);
  });

  it('still passes the cold-open script it was originally written for', () => {
    // The fix must not be a widening that swallows the original case.
    const g = check(COLD_OPEN_ANSWERING_SERVICE, 'callback_fields_completeness');
    expect(g.pass, g.reason).toBe(true);
  });

  it('STILL fails a call where no name was ever exchanged', () => {
    /**
     * The check has to keep working. A caller who never gives a name and gets
     * a ticket filed anyway is a real defect and must not be swallowed by the
     * patterns added above.
     */
    const anonymous = `AGENT: Thank you for calling Azul Vision clinical support. What can I help you with?
CALLER: I need to know if you're open tomorrow.
AGENT: Give me one moment while I get this submitted for you.
AGENT: Your request has been submitted.`;
    const g = check(anonymous, 'callback_fields_completeness');
    expect(g.reason, g.reason).toMatch(/name/);
  });
});
