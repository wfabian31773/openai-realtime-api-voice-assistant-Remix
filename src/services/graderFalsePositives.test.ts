/**
 * The three checks that painted the dashboard red on 2026-08-13, and what
 * each was actually measuring.
 *
 * Operator: "I would rather fix the grader."
 *
 * The day's numbers, from the live databases rather than the dashboard:
 *   - ticket_required_vs_created "failed" 46.2% of tech while tech filed 106
 *     real tickets — the create-ticket path never wrote ticket_number back to
 *     call_logs, and the hangup calls (45 of 173, avg 2.3 turns) were in the
 *     denominator.
 *   - handoff_expected_vs_actual failed 52 of tech's 55 "critical fails" for
 *     not transferring — on lines the operator ruled must never transfer.
 *   - transcript_coverage flagged 16.3% — ghost calls counted as defects, and
 *     real record loss (republishes killing per-process buffers) counted as
 *     agent behaviour.
 *
 * A grader whose reds do not mean anything teaches people to ignore red.
 */
import { describe, it, expect } from 'vitest';

// callGradingService imports systemAlertService, which opens the database at
// import — the same shape that made the scheduling prompt and the 159
// classifier untestable. Satisfy the unrelated env check and import
// dynamically; the graders themselves are pure functions of their input.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
// The singleton constructor builds an OpenAI client for the LLM graders. The
// deterministic graders under test never touch it.
process.env.OPENAI_API_KEY ||= 'test-unused';
const { callGradingService } = await import('./callGradingService');

type AnyInput = Parameters<typeof callGradingService.runDeterministicGraders>[0] extends infer T ? T : never;

const base = {
  callLogId: 'test',
  transferredToHuman: false,
  ticketNumber: null as string | null,
  agentSlug: 'tech' as string | null,
  totalTurns: 10,
  interruptionCount: 0,
  truncationCount: 0,
  toolCallCount: 4,
  durationSeconds: 150,
  firstTranscriptDelayMs: 800,
  postTranscriptTailMs: 0,
  localDurationSeconds: 150,
  transcriptWindowSeconds: 150,
  durationMismatchRatio: null,
  durationMismatchFlag: false,
};

function run(input: Partial<typeof base> & { transcript: string }) {
  return callGradingService.runDeterministicGraders({ ...base, ...input } as AnyInput);
}

function check(results: Array<{ grader: string }>, name: string) {
  const r = results.find((x) => x.grader === name) as
    | { grader: string; pass: boolean; reason: string; metadata?: Record<string, unknown> }
    | undefined;
  expect(r, `grader ${name} did not run`).toBeTruthy();
  return r!;
}

describe('handoff_expected_vs_actual — capability-aware', () => {
  const ESCALATION_CALL = [
    'AGENT: Thank you for calling Azul Vision clinical support.',
    'CALLER: this is urgent, I need my drops before my surgery',
    'AGENT: I can take a message and the team will follow up with you.',
    'CALLER: fine, please have someone call me',
    'AGENT: Your ticket number is VA-51000.',
  ].join('\n');

  it('a ticket on a no-transfer line satisfies an escalation request', () => {
    const r = check(run({ transcript: ESCALATION_CALL, ticketNumber: 'VA-51000' }), 'handoff_expected_vs_actual');
    expect(r.pass).toBe(true);
    expect(r.metadata?.noTransferLine).toBe(true);
  });

  it('still fails the caller who left with nothing', () => {
    const r = check(run({ transcript: ESCALATION_CALL, ticketNumber: null }), 'handoff_expected_vs_actual');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/left with nothing/i);
  });

  it('the AGENT saying "urgent" does not count as the caller demanding a transfer', () => {
    // The old check scanned the whole transcript. The agents say these words
    // constantly — "is this urgent?" tripped the detector on triage questions.
    const agentOnly = [
      'AGENT: Is this urgent, or can the team call you back tomorrow?',
      'CALLER: tomorrow is fine, just the office hours please',
      'AGENT: We open at eight.',
    ].join('\n');
    const r = check(run({ transcript: agentOnly, ticketNumber: null }), 'handoff_expected_vs_actual');
    expect(r.pass).toBe(true);
  });

  it('transfer-capable lines keep the original contract', () => {
    const demand = [
      'AGENT: How can I help?',
      'CALLER: transfer me to a person right now',
      'AGENT: One moment.',
    ].join('\n');
    const r = check(run({ transcript: demand, agentSlug: 'pcp', ticketNumber: null }), 'handoff_expected_vs_actual');
    expect(r.pass).toBe(false);
  });
});

describe('ticket_required_vs_created — the conversation floor', () => {
  it('a hangup is not a lost request', () => {
    // 45 of tech's 173 calls that day: no tools, ~2 turns, gone. The caller
    // said one line containing "call" and the old check demanded a ticket.
    const hangup = ['AGENT: Thank you for calling Azul Vision clinical support.', 'CALLER: oh wrong number, this was a mistaken call'].join('\n');
    const r = check(run({ transcript: hangup, ticketNumber: null, toolCallCount: 0, durationSeconds: 18 }), 'ticket_required_vs_created');
    expect(r.pass).toBe(true);
    expect(r.metadata?.notApplicable).toBe(true);
  });

  it('a real conversation with a request and no ticket still fails', () => {
    const real = [
      'AGENT: Thank you for calling.',
      'CALLER: I need a refill of my latanoprost prescription please',
      'AGENT: Of course.',
      'CALLER: the pharmacy is CVS on Main, please send the request today',
      'AGENT: Goodbye.',
    ].join('\n');
    const r = check(run({ transcript: real, ticketNumber: null }), 'ticket_required_vs_created');
    expect(r.pass).toBe(false);
  });

  it('the same conversation with a ticket passes', () => {
    const real = [
      'AGENT: Thank you for calling.',
      'CALLER: I need a refill of my prescription please',
      'AGENT: Let me get this logged for you.',
      'CALLER: thank you so much',
      'AGENT: Your ticket number is VA-51001.',
    ].join('\n');
    const r = check(run({ transcript: real, ticketNumber: 'VA-51001' }), 'ticket_required_vs_created');
    expect(r.pass).toBe(true);
  });
});

describe('transcript_coverage — short call vs lost record', () => {
  it('a short hangup with one line is full coverage, not a defect', () => {
    const r = check(
      run({ transcript: 'AGENT: Thank you for calling Azul Vision.', durationSeconds: 12, totalTurns: 1 }),
      'transcript_coverage',
    );
    expect(r.pass).toBe(true);
    expect(r.metadata?.shortCall).toBe(true);
  });

  it('a long call with one surviving line is an instrumentation gap, and says so', () => {
    const r = check(
      run({ transcript: 'AGENT: Thank you for calling Azul Vision.', durationSeconds: 240, totalTurns: 1 }),
      'transcript_coverage',
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/instrumentation gap/i);
    expect(r.metadata?.instrumentationGap).toBe(true);
  });

  /**
   * THE FALSE PASS THIS CHECK NEARLY SHIPPED WITH, found the next morning.
   *
   * 45 of 534 no-IVR calls in 7 days carry a duration of 0-3 seconds while
   * holding 5-12 conversational turns — the duration is reconciled from a
   * Twilio leg that is not the one the conversation happened on (one of them
   * is `no-answer` with five turns of dialogue).
   *
   * Trusting duration alone would call those "short call, full coverage" and
   * wave through exactly the population this check exists to catch. Turns come
   * from our own recorder, so they are the honest signal for "was there a
   * conversation".
   */
  it('does not call a multi-turn conversation a short call because duration is wrong', () => {
    const r = check(
      run({ transcript: 'AGENT: Thank you for calling Azul Vision.', durationSeconds: 1, totalTurns: 8 }),
      'transcript_coverage',
    );
    expect(r.pass).toBe(false);
    expect(r.metadata?.instrumentationGap).toBe(true);
  });
});

describe('actionable_request_needs_ticket — same floor', () => {
  it('does not demand a ticket from a two-line call', () => {
    const r = check(
      run({ transcript: 'AGENT: Hello.\nCALLER: call me back about my prescription request', ticketNumber: null }),
      'actionable_request_needs_ticket',
    );
    expect(r.pass).toBe(true);
  });
});
