/**
 * `flushCallEvents` SAYS whether it landed — Codex P2 on #321, round 9.
 *
 * It catches a failed insert and hands the events back for a retry, which is
 * right; but it returned void, so a caller could not tell a landed flush from
 * a failed one and the runtime's follow-up writer released the buffer either
 * way. The answer is now the return value, and the events are still there to
 * try again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const dbState = vi.hoisted(() => ({
  execute: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('database unavailable');
  },
}));
vi.mock('../../server/db', () => ({ db: { execute: (...a: unknown[]) => dbState.execute(...a) } }));

const { emitCallEvent, flushCallEvents, getCallEvents, releaseCallEvents } = await import('./callEventLog');

const CALL = 'CA0000000000000000000000000000f1u5';

beforeEach(() => {
  releaseCallEvents(CALL);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('flushCallEvents reports what happened', () => {
  it('answers false when the insert fails, keeps the events buffered, and answers true once they land', async () => {
    emitCallEvent(CALL, 'warn', 'model', 'follow_up_summary', { owed: 1 });
    expect(await flushCallEvents(CALL)).toBe(false);
    // Still there for the retry — nothing was deleted on the failure.
    expect(getCallEvents(CALL)).toHaveLength(1);

    dbState.execute = async () => ({ rows: [] });
    expect(await flushCallEvents(CALL)).toBe(true);
    // Idempotent by count: a second flush has nothing to write and says so.
    expect(await flushCallEvents(CALL)).toBe(true);
  });

  it('answers true for a call it has never seen — nothing is unflushed', async () => {
    expect(await flushCallEvents('CA' + '0'.repeat(32))).toBe(true);
  });
});
