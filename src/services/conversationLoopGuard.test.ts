import { describe, it, expect, beforeEach } from 'vitest';
import {
  conversationLoopGuard,
  classifyAsk,
  isHumanRequest,
  REASK_SOFT_CAP,
  REASK_HARD_CAP,
  HUMAN_REQUEST_CAP,
} from './conversationLoopGuard';

/**
 * SEV-1 2026-07-30. Fixtures are lifted from real production calls on
 * 07-29 PT: the 12-ask medical-records call (09880f37), the 11-ask
 * customer-service refusal call (bae2618e), and the "Representative" ×6
 * azul call (2c7587c0). ~180 calls/day were looping 3+ identity asks with
 * zero enforcement anywhere.
 */

let n = 0;
const freshCallId = () => `test-call-${++n}`;

describe('classifyAsk — one definition of "asked again"', () => {
  it('counts question-form asks', () => {
    expect(classifyAsk('Could you please tell me your first and last name?')).toBe('full name');
    expect(classifyAsk('Could you also provide your date of birth?')).toBe('date of birth');
  });

  it('counts statement-form asks — the shape the old ?-only meter never saw', () => {
    expect(classifyAsk("I'll need your name and date of birth to look that up.")).not.toBeNull();
    expect(classifyAsk("Now I'll need the patient's date of birth, starting with the month, then the day, and then the year.")).toBe('date of birth');
  });

  it('does NOT count acknowledgments that merely mention the topic', () => {
    // Call 09880f37: the agent said this, then restarted the interview
    // anyway — the acknowledgment itself must not inflate the count.
    expect(classifyAsk("Thank you. Now I have the patient's name and date of birth.")).toBeNull();
    expect(classifyAsk('Thanks, I have your date of birth on file.')).toBeNull();
  });

  it('does not classify lines about unrelated topics', () => {
    expect(classifyAsk('One moment while I check that for you.')).toBeNull();
  });
});

describe('isHumanRequest', () => {
  it('matches the production demand phrasings', () => {
    // 2c7587c0 and bae2618e verbatim caller lines
    expect(isHumanRequest('CALLER: Representative')).toBe(true);
    expect(isHumanRequest('CALLER: Representative, please.')).toBe(true);
    expect(isHumanRequest('CALLER: Customer service')).toBe(true);
    expect(isHumanRequest('CALLER: I want to talk to a real person')).toBe(true);
    expect(isHumanRequest('CALLER: Can you transfer me?')).toBe(true);
    expect(isHumanRequest('CALLER: Quiero hablar con alguien')).toBe(true);
  });

  it('does not fire on ordinary scheduling talk', () => {
    expect(isHumanRequest('CALLER: I need an eye exam as soon as possible')).toBe(false);
    expect(isHumanRequest('CALLER: June 27, 1965')).toBe(false);
  });

  /**
   * REGRESSION: call 4511a0a3 (2026-08-05 18:34). "Just put somebody on the
   * phone that I can speak to." matched NOTHING, so a caller who had already
   * endured six variations of "which office do you visit" asked for a human in
   * as many words and the escalation path never saw it. Graded 2/5, frustrated,
   * follow_up_needed.
   *
   * Every old alternative required the person-word to FOLLOW the verb ("speak to
   * someone") — but a frustrated caller puts it first.
   */
  it('matches the person-first phrasings a frustrated caller actually uses', () => {
    for (const line of [
      "You're a crackerjack individual, aren't you? Just put somebody on the phone that I can speak to.",
      'Just put somebody on the phone',
      'Get someone on the phone please',
      'Put me through to the office',
      'Is there anyone I can speak to',
      'I need somebody I can talk to',
      'Put a human on',
      'I want to speak to a person',
    ]) {
      expect(isHumanRequest(line), line).toBe(true);
    }
  });

  it('still does not fire on lines that merely mention people', () => {
    for (const line of [
      'My glasses are on the counter in their trailer',
      'Somebody told me the exam was covered',
      'I have someone driving me to the appointment',
      'October 18th, 1972.',
      'Campbell, C-A-M-P-B-E-L-L.',
    ]) {
      expect(isHumanRequest(line), line).toBe(false);
    }
  });
});

describe('re-ask caps', () => {
  it(`intervenes on ask #${REASK_SOFT_CAP}, once, and hard-stops at #${REASK_HARD_CAP}`, () => {
    const callId = freshCallId();
    const ask = (i: number) =>
      conversationLoopGuard.onAgentLine(callId, 'answering-service', `Could you tell me your date of birth? (attempt ${i})`);
    const caller = () => conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Um.');

    expect(ask(1)).toBeNull();
    caller();
    expect(ask(2)).toBeNull();
    caller();
    const soft = ask(3);
    expect(soft?.kind).toBe('reask_cap');
    expect(soft?.topic).toBe('date of birth');
    expect(soft?.text).toMatch(/asked for the caller's date of birth 3 times/);
    caller();
    expect(ask(4)).toBeNull(); // soft already sent — no spam
    caller();
    const hard = ask(5);
    expect(hard?.kind).toBe('reask_hard_stop');
    expect(hard?.text).toMatch(/STOP/);
    caller();
    expect(ask(6)).toBeNull(); // hard already sent
    conversationLoopGuard.endCall(callId);
  });

  it('tracks topics independently — two name asks plus two DOB asks stay silent', () => {
    const callId = freshCallId();
    const lines = [
      'Could you tell me your first and last name?',
      'Could you also provide your date of birth?',
      "I may have misheard — what is your first and last name?",
      'And your date of birth, please?',
    ];
    for (const l of lines) {
      expect(conversationLoopGuard.onAgentLine(callId, 'no-ivr', l)).toBeNull();
      conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'Kim Sanchez.');
    }
    conversationLoopGuard.endCall(callId);
  });

  it('ignores duplicate captures of the same response (two transport events, no caller line between)', () => {
    const callId = freshCallId();
    const line = 'Could you tell me your date of birth?';
    expect(conversationLoopGuard.onAgentLine(callId, 'no-ivr', line)).toBeNull();
    expect(conversationLoopGuard.onAgentLine(callId, 'no-ivr', line)).toBeNull(); // double capture
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'March third.');
    expect(conversationLoopGuard.onAgentLine(callId, 'no-ivr', line)).toBeNull(); // real ask #2
    const stats = conversationLoopGuard.endCall(callId);
    expect(stats?.asksByTopic['date of birth']).toBe(2);
  });

  it('a verbatim-identical re-ask WITH caller audio between counts as a real ask', () => {
    // The no-ivr on-call deflection is a fixed script — repeats are verbatim.
    const callId = freshCallId();
    const line = 'Could you tell me your date of birth?';
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', line);
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'No.');
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', line);
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'No.');
    const d = conversationLoopGuard.onAgentLine(callId, 'no-ivr', line);
    expect(d?.kind).toBe('reask_cap');
    conversationLoopGuard.endCall(callId);
  });
});

describe('human-request escalation', () => {
  // Operator directive 2026-07-30: the answering service cannot transfer at
  // all, so making the caller ask twice before hearing that is the bug.
  // Honesty is owed on the FIRST ask — that is what stops the insisting.
  it('fires on the FIRST demand for an agent that cannot transfer', () => {
    const callId = freshCallId();
    const d = conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Representative.');
    expect(d?.kind).toBe('human_request');
    expect(d?.text).toMatch(/CANNOT transfer calls/);
    expect(d?.text).toMatch(/take the message/);
    expect(d?.text).toMatch(/never promise that anyone will pick up/);
    expect(d?.text).toMatch(/Create the ticket NOW/); // the exit still rides along
    // The directive used to dictate a sentence here — "take a message and have
    // the team contact you as soon as they become available" — which records,
    // optical, surgery and tech all forbid, and which overrode their prompts
    // because answeringServiceAgent tells the model to follow a SERVER STATE
    // CHECK exactly. It now defers to whatever the lane's own prompt rules.
    // See src/services/noTransferDirective.test.ts for the invariant.
    expect(d?.text).toMatch(/your own instructions give you wording/);
    expect(d?.text).not.toMatch(/currently busy|become available/);
    conversationLoopGuard.releaseCall(callId);
  });

  it('never repeats the limitation — one directive per call', () => {
    const callId = freshCallId();
    expect(conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Customer service.')).toBeTruthy();
    conversationLoopGuard.onAgentLine(callId, 'answering-service', "I can't connect calls, but I can have someone call you back.");
    expect(conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Representative!')).toBeNull();
    expect(conversationLoopGuard.onCallerLine(callId, 'answering-service', 'REPRESENTATIVE.')).toBeNull();
    conversationLoopGuard.releaseCall(callId);
  });

  it(`still waits for demand #${HUMAN_REQUEST_CAP} on agents that CAN transfer`, () => {
    // azul has a real handoff, so a first mention may be an aside.
    const callId = freshCallId();
    expect(conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative.')).toBeNull();
    const d = conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative, please.');
    expect(d?.kind).toBe('human_request');
    expect(d?.text).not.toMatch(/CANNOT transfer calls/);
    conversationLoopGuard.releaseCall(callId);
  });

  it('gives azul the sage_handoff exit and forbids identity re-asks (2nd ask)', () => {
    const callId = freshCallId();
    conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative.');
    const d = conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative, please.');
    expect(d?.kind).toBe('human_request');
    expect(d?.text).toMatch(/sage_handoff/);
    expect(d?.text).toMatch(/do NOT re-ask name or date of birth/);
    conversationLoopGuard.endCall(callId);
  });
});

describe('alias resolution + flush-once (the 07-30 test-call defect)', () => {
  // On the first live test calls the lifecycle coordinator finalized 4 of 5
  // calls instead of observeCall's teardown. The coordinator holds only
  // callLogId/twilioCallSid, so the guard — keyed by the OpenAI callId —
  // returned nothing and the turn telemetry stayed NULL on those calls.
  it('flushes through a registered alias (callLogId / twilioCallSid)', () => {
    const callId = freshCallId();
    const callLogId = `log-${callId}`;
    conversationLoopGuard.registerAlias(callId, callLogId);
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'How can I help?');
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'Refill please.');
    const stats = conversationLoopGuard.endCall(callLogId);
    expect(stats?.agentLines).toBe(1);
    expect(stats?.callerLines).toBe(1);
    conversationLoopGuard.releaseCall(callId);
  });

  it('flushes exactly once — the losing teardown path is a no-op', () => {
    const callId = freshCallId();
    const callLogId = `log-${callId}`;
    conversationLoopGuard.registerAlias(callId, callLogId);
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'How can I help?');
    expect(conversationLoopGuard.endCall(callId)).toBeTruthy();   // observeCall wins
    expect(conversationLoopGuard.endCall(callLogId)).toBeUndefined(); // coordinator no-ops
    // state survives the flush so a late reader still resolves
    expect(conversationLoopGuard.getStats(callLogId)?.agentLines).toBe(1);
    conversationLoopGuard.releaseCall(callId);
    expect(conversationLoopGuard.getStats(callLogId)).toBeUndefined();
  });

  it('counts barge-ins in the guard, so they survive alias lookup', () => {
    // Previously a parallel map keyed only by the OpenAI callId: flushing via
    // an alias read 0 and wrote interruption_count = 0.
    const callId = freshCallId();
    const callLogId = `log-${callId}`;
    conversationLoopGuard.registerAlias(callId, callLogId);
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'Let me explain the—');
    conversationLoopGuard.onTruncation(callId);
    conversationLoopGuard.onTruncation(callId);
    expect(conversationLoopGuard.endCall(callLogId)?.truncations).toBe(2);
    conversationLoopGuard.releaseCall(callId);
  });

  it('ignores a self-referential alias', () => {
    const callId = freshCallId();
    conversationLoopGuard.registerAlias(callId, callId);
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'Hello?');
    expect(conversationLoopGuard.endCall(callId)?.agentLines).toBe(1);
    conversationLoopGuard.releaseCall(callId);
  });
});

describe('end-of-call stats (the telemetry writer reads these)', () => {
  it('reports turns, asks, human requests, and interventions — then frees the state', () => {
    const callId = freshCallId();
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'How can I help you today?');
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'Representative.');
    conversationLoopGuard.onAgentLine(callId, 'no-ivr', 'Could you tell me your first and last name?');
    conversationLoopGuard.onCallerLine(callId, 'no-ivr', 'Representative!');
    const stats = conversationLoopGuard.endCall(callId);
    expect(stats?.agentLines).toBe(2);
    expect(stats?.callerLines).toBe(2);
    expect(stats?.humanRequests).toBe(2);
    expect(stats?.interventions).toContain('human');
    expect(conversationLoopGuard.endCall(callId)).toBeUndefined();
  });
});
