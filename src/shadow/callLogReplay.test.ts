/** Stored-call replay bridge: transcript parsing, slug coercion, tool interleaving. */
import { describe, expect, it } from 'vitest';
import { callLogToFixture, normalizeAgentSlug, replayCallLog } from './callLogReplay';

const TRANSCRIPT = [
  'AGENT: Thank you for calling. How can I help you tonight?',
  'CALLER: I need a refill on my eye drops prescription.',
  'AGENT: May I have your first and last name?',
  'CALLER: My name is Jane Doe.',
  'AGENT: And the best phone number to reach you?',
  'CALLER: 555-201-0101.',
  'AGENT: Let me read that back. Is that right?',
  'CALLER: Yes, correct.',
].join('\n');

describe('normalizeAgentSlug', () => {
  it('keeps known slugs, maps ticket vocabulary, coerces unknowns like production', () => {
    expect(normalizeAgentSlug('no-ivr')).toBe('no-ivr');
    expect(normalizeAgentSlug('urgent-triage')).toBe('after-hours');
    expect(normalizeAgentSlug('greeter')).toBe('after-hours');
    expect(normalizeAgentSlug(null)).toBe('after-hours');
  });
});

describe('callLogToFixture', () => {
  it('parses CALLER/AGENT lines including continuations', () => {
    const withContinuation = 'CALLER: I need help\nwith my prescription\nAGENT: Of course.';
    const fx = callLogToFixture({ id: 1, agentUsed: 'no-ivr', transcript: withContinuation })!;
    expect(fx.fixture.turns[0]).toEqual({ caller: 'I need help with my prescription' });
    expect(fx.fixture.turns[1]).toEqual({ agent: 'Of course.' });
  });

  it('returns null without a transcript or without caller turns', () => {
    expect(callLogToFixture({ id: 1, transcript: '' })).toBeNull();
    expect(callLogToFixture({ id: 1, transcript: 'AGENT: hello?' })).toBeNull();
  });

  it('interleaves timeline tools proportionally by timestamp', () => {
    const start = new Date('2026-08-01T10:00:00Z');
    const fx = callLogToFixture({
      id: 2,
      agentUsed: 'no-ivr',
      transcript: TRANSCRIPT,
      createdAt: start,
      duration: 100,
      toolTimeline: {
        events: [
          { at: new Date(start.getTime() + 99_000).toISOString(), tool: 'create_ticket', args: {}, outcome: { ok: true }, ms: 800 },
        ],
      },
    })!;
    const idx = fx.fixture.turns.findIndex((t) => 'tool' in t);
    // Late-call tool lands after the last caller turn, not at position 0.
    const lastCallerIdx = fx.fixture.turns.map((t) => 'caller' in t).lastIndexOf(true);
    expect(idx).toBeGreaterThan(lastCallerIdx);
    expect(fx.approximations.some((a) => a.includes('proportionally'))).toBe(true);
  });

  it('appends tools at the end when timing is unusable, and flags failures', () => {
    const fx = callLogToFixture({
      id: 3,
      agentUsed: 'answering-service',
      transcript: TRANSCRIPT,
      toolTimeline: { events: [{ tool: 'create_ticket', outcome: { error: 'boom' } }] },
    })!;
    const toolTurn = fx.fixture.turns.find((t) => 'tool' in t) as { tool: string; failed?: boolean };
    expect(toolTurn.failed).toBe(true);
    expect(fx.approximations.some((a) => a.includes('appended at end'))).toBe(true);
  });
});

describe('replayCallLog', () => {
  it('produces a full shadow analysis from a stored call', async () => {
    const result = await replayCallLog({
      id: 'abc',
      agentUsed: 'no-ivr',
      transcript: TRANSCRIPT,
      status: 'completed',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      duration: 120,
      toolTimeline: {
        events: [
          { at: '2026-08-01T10:01:55Z', tool: 'create_ticket', args: {}, outcome: { ok: true, ticketId: 9 }, ms: 700 },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('no-ivr');
    expect(result!.summary).toBeDefined();
    expect(result!.summary!.turns).toBe(4);
    expect(result!.summary!.limitation).toContain('Counterfactual');
    expect(result!.approximations.length).toBeGreaterThan(0);
    expect(['better', 'equivalent', 'worse', 'indeterminate', 'human_review']).toContain(result!.evaluation!.verdict);
  });

  it('is idempotent across repeated replays of the same call', async () => {
    const log = { id: 'x', agentUsed: 'no-ivr', transcript: TRANSCRIPT };
    const a = await replayCallLog(log);
    const b = await replayCallLog(log);
    expect(b!.flags).toEqual(a!.flags);
    expect(b!.summary!.actionAgreementPct).toBe(a!.summary!.actionAgreementPct);
  });
});
