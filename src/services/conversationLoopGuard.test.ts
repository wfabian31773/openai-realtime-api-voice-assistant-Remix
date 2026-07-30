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
  it(`fires on demand #${HUMAN_REQUEST_CAP} with the ticket exit for the answering fleet`, () => {
    const callId = freshCallId();
    expect(conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Customer service.')).toBeNull();
    conversationLoopGuard.onAgentLine(callId, 'answering-service', 'I can help with that.');
    const d = conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Customer service!');
    expect(d?.kind).toBe('human_request');
    expect(d?.text).toMatch(/Create the ticket NOW/);
    // once per call
    expect(conversationLoopGuard.onCallerLine(callId, 'answering-service', 'Representative.')).toBeNull();
    conversationLoopGuard.endCall(callId);
  });

  it('gives azul the sage_handoff exit and forbids identity re-asks', () => {
    const callId = freshCallId();
    conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative.');
    const d = conversationLoopGuard.onCallerLine(callId, 'azul-scheduling', 'Representative, please.');
    expect(d?.kind).toBe('human_request');
    expect(d?.text).toMatch(/sage_handoff/);
    expect(d?.text).toMatch(/do NOT re-ask name or date of birth/);
    conversationLoopGuard.endCall(callId);
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
