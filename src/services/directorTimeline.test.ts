/**
 * Director telemetry — the receipt for an intervention.
 *
 * Before this, the director only console.warn'd, so the one question that
 * matters on the morning it goes live ("is the reasoning layer actually ruling
 * on turns, or is it loaded and silent?") could only be answered by scrolling a
 * Replit deploy log. These tests pin the two properties that make persisting it
 * safe: the verdict survives the call, and the caller's data does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updates: Array<{ payload: any }> = [];

vi.mock('../../server/db', () => ({
  db: {
    update: () => ({
      set: (payload: any) => {
        updates.push({ payload });
        return { where: async () => undefined };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));
vi.mock('../../shared/schema', () => ({ callLogs: { id: 'id', callSid: 'call_sid' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
// The post-flush rubric pass pulls in the grading world; not under test here.
vi.mock('./callGradingService', () => ({
  callGradingService: { runAndPersistDeterministicGraders: async () => undefined },
}));

const mod = await import('./toolTimeline');
const { recordDirectorAction, getDirectorActions, recordToolEvent, flushAzulTimeline } = mod;
const { callMetadataForDB } = await import('./callMetadataStore');

let n = 0;
const freshCall = () => `dir-test-${++n}`;

/** The action the director hands us on the afb1e688 shape. `text` and `speak`
 *  quote the caller's own date of birth back — that is the PHI this must drop. */
const REASK_ACTION = {
  enforcement: 'author' as const,
  code: 'reask_answered_field' as const,
  topic: 'date of birth',
  text:
    'DIRECTOR — TAKING THIS TURN. The caller already gave their date of birth: ' +
    '"October 5th, 1983" (turn 4). A previous correction was ignored.',
  speak: 'Thanks — I have your date of birth as October 5th, 1983. Let me take it from here.',
};

beforeEach(() => {
  updates.length = 0;
});

describe('PHI discipline — only the verdict crosses the boundary', () => {
  it('stores enforcement, code and the FIELD NAME, and drops text and speak', () => {
    const callId = freshCall();
    recordDirectorAction(callId, 'azul-scheduling', REASK_ACTION);

    const [a] = getDirectorActions(callId);
    expect(a).toMatchObject({
      enforcement: 'author',
      code: 'reask_answered_field',
      topic: 'date of birth',
    });
    expect(a).not.toHaveProperty('text');
    expect(a).not.toHaveProperty('speak');

    // "date of birth" is a field NAME and must survive; the VALUE must not.
    const blob = JSON.stringify(getDirectorActions(callId));
    expect(blob).toContain('date of birth');
    for (const phi of ['October 5th, 1983', '1983', 'turn 4']) {
      expect(blob).not.toContain(phi);
    }
  });

  it('keeps the caller out of the persisted payload too', async () => {
    const callId = freshCall();
    callMetadataForDB.set(callId, {
      dbCallLogId: 'log-phi',
      startTime: new Date(),
      agentSlug: 'azul-scheduling',
      transferredToHuman: false,
      audioInputMs: 0,
      audioOutputMs: 0,
    });
    recordDirectorAction(callId, 'azul-scheduling', REASK_ACTION);
    await flushAzulTimeline(callId);

    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0].payload)).not.toContain('October 5th, 1983');
  });
});

describe('the record survives the call', () => {
  it('persists a director block on a call that also used tools', async () => {
    const callId = freshCall();
    recordToolEvent(callId, 'sage_availability', { daysAhead: 14 }, JSON.stringify({ options: [] }), 30, {
      callLogId: 'log-1',
      agentSlug: 'azul-scheduling',
    });
    recordDirectorAction(callId, 'azul-scheduling', REASK_ACTION);
    await flushAzulTimeline(callId);

    const { toolTimeline } = updates[0].payload;
    expect(toolTimeline.toolCallCount).toBe(1);
    // Director actions live BESIDE the tool events, never inside them: the
    // classifiers, tool_call_count, the graders and the shadow replay all keep
    // counting tool calls only.
    expect(toolTimeline.events).toHaveLength(1);
    expect(toolTimeline.director).toMatchObject({
      count: 1,
      maxEnforcement: 'author',
      topics: ['date of birth'],
    });
  });

  it('persists a call where the director fired and NO tool was ever called', async () => {
    // The shape that used to vanish entirely: the entry only existed if a tool
    // created it, so a call the director stopped early wrote nothing at all.
    const callId = freshCall();
    callMetadataForDB.set(callId, {
      dbCallLogId: 'log-2',
      startTime: new Date(),
      agentSlug: 'answering-service',
      transferredToHuman: false,
      audioInputMs: 0,
      audioOutputMs: 0,
    });
    recordDirectorAction(callId, 'answering-service', {
      enforcement: 'force_exit',
      code: 'reask_answered_field',
      topic: 'last name',
    });
    await flushAzulTimeline(callId);

    expect(updates).toHaveLength(1);
    expect(updates[0].payload.toolTimeline.director).toMatchObject({
      count: 1,
      maxEnforcement: 'force_exit',
    });
    expect(updates[0].payload.toolCallCount).toBe(0);
  });

  it('reports the WORST enforcement reached, not the last one', async () => {
    const callId = freshCall();
    for (const enforcement of ['inject', 'force_exit', 'inject'] as const) {
      recordDirectorAction(callId, 'azul-scheduling', {
        enforcement,
        code: 'reask_answered_field',
        topic: 'date of birth',
      });
    }
    recordToolEvent(callId, 'sage_handoff', {}, '{}', 1, { callLogId: 'log-3', agentSlug: 'azul-scheduling' });
    await flushAzulTimeline(callId);

    expect(updates[0].payload.toolTimeline.director).toMatchObject({
      count: 3,
      maxEnforcement: 'force_exit',
    });
  });

  it('omits the director block entirely when it never intervened', async () => {
    const callId = freshCall();
    recordToolEvent(callId, 'sage_book', {}, JSON.stringify({ booking_status: 'confirmed' }), 10, {
      callLogId: 'log-4',
      agentSlug: 'azul-scheduling',
    });
    await flushAzulTimeline(callId);
    // `tool_timeline->'director' IS NOT NULL` is the "did the reasoning layer
    // do anything?" query — a clean call must not answer yes.
    expect(updates[0].payload.toolTimeline).not.toHaveProperty('director');
  });
});

describe('flush idempotence', () => {
  it('re-flushes when a director action arrives after the tool events were written', async () => {
    const callId = freshCall();
    recordToolEvent(callId, 'sage_availability', {}, '{}', 5, { callLogId: 'log-5', agentSlug: 'azul-scheduling' });
    await flushAzulTimeline(callId);
    expect(updates).toHaveLength(1);

    // Nothing new — must not write again.
    await flushAzulTimeline(callId);
    expect(updates).toHaveLength(1);

    // A late director action IS new, and the old guard (tool events only)
    // would have swallowed it.
    recordDirectorAction(callId, 'azul-scheduling', REASK_ACTION);
    await flushAzulTimeline(callId);
    expect(updates).toHaveLength(2);
    expect(updates[1].payload.toolTimeline.director.count).toBe(1);

    await flushAzulTimeline(callId);
    expect(updates).toHaveLength(2);
  });
});

describe('telemetry must never break a call', () => {
  it('does not throw on junk input or a missing call id', () => {
    expect(() => recordDirectorAction('', 'azul-scheduling', REASK_ACTION)).not.toThrow();
    expect(() =>
      recordDirectorAction(freshCall(), '', { enforcement: 'inject', code: 'bundled_questions', topic: 'bundled' }),
    ).not.toThrow();
    expect(() => recordDirectorAction(freshCall(), 'azul-scheduling', {} as any)).not.toThrow();
  });

  it('returns an empty list for an unknown call rather than null', () => {
    expect(getDirectorActions('never-seen')).toEqual([]);
  });
});
