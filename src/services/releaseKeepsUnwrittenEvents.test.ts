/**
 * `releaseCallEvents` MUST NOT DELETE WHAT NOBODY HAS WRITTEN — Codex P1 on
 * #322, round 4.
 *
 * It deleted the whole per-SID buffer, so an event appended after the
 * caller's own flush had claimed its slice went with it — and
 * `flushCallEvents` answers TRUE for a call it cannot find, so the next writer
 * reported its row durable having written nothing. Two teardown writers share
 * one buffer since task #148, which is what turned a latent trap into a loss
 * on every runtime call that owed a follow-up.
 *
 * The end-to-end proof through both real writers is
 * `src/runtime/bothTeardownRowsLand.test.ts`; this pins the rule itself.
 *
 * ROUND 4 LEFT ONE NARROWER CASE OPEN AND #327 CLOSES IT: a release that races
 * a flush already IN FLIGHT. The claim is taken before the await, so between
 * those two moments a buffer whose events are in the AIR is indistinguishable
 * from one whose events are WRITTEN — and the rollback on a failed insert then
 * landed on an object no longer in the map. Measured before taking it: on the
 * runtime the incremental flush cannot fire (max 2 events on any call in seven
 * days against a threshold of 25), and on the old core it fires on 369 calls a
 * week — so this was always the old core's bug and is fixed for its sake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const dbState = vi.hoisted(() => ({
  statements: [] as unknown[],
  execute: async (q: unknown): Promise<unknown> => {
    dbState.statements.push(q);
    return { rows: [] };
  },
}));
vi.mock('../../server/db', () => ({ db: { execute: (q: unknown) => dbState.execute(q) } }));

const { emitCallEvent, flushCallEvents, getCallEvents, releaseCallEvents } = await import(
  './callEventLog'
);
const { chunkStrings } = await import('../runtime/sqlChunkStrings.testkit');

const CALL = 'CA00000000000000000000000000000re1';

beforeEach(() => {
  dbState.statements = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('releasing a finished call', () => {
  it('keeps an event appended after the flush claimed its slice, and the next flush writes it', async () => {
    emitCallEvent(CALL, 'warn', 'model', 'first_row', { a: 1 });
    expect(await flushCallEvents(CALL)).toBe(true);

    // The shape the two teardown writers produce: the second row is emitted
    // while the first writer's flush is already in flight, so it is still
    // unflushed when that writer releases.
    emitCallEvent(CALL, 'info', 'tool', 'second_row', { b: 2 });
    releaseCallEvents(CALL);

    expect(getCallEvents(CALL)).toHaveLength(2);

    dbState.statements = [];
    expect(await flushCallEvents(CALL)).toBe(true);
    const written = dbState.statements.flatMap((s) => chunkStrings(s));
    expect(written).toContain('second_row');
    // And it is written ONCE — the flushed prefix is not re-sent.
    expect(written.filter((v) => v === 'first_row')).toHaveLength(0);

    releaseCallEvents(CALL);
    expect(getCallEvents(CALL)).toHaveLength(0);
  });

  it('keeps a buffer whose events are still IN FLIGHT, so a failed insert can roll back onto it', async () => {
    // The claim makes the buffer look fully written. Hold the insert open,
    // release while it is in the air, then fail it: the rollback has to land
    // on a buffer that is still in the map or the events are gone for good.
    let failInsert!: (e: Error) => void;
    dbState.execute = async (q: unknown) => {
      dbState.statements.push(q);
      const text = chunkStrings(q).join(' ');
      if (!text.includes('in_flight_row')) return { rows: [] };
      return await new Promise((_resolve, reject) => {
        failInsert = reject;
      });
    };

    emitCallEvent(CALL, 'warn', 'model', 'in_flight_row', { a: 1 });
    const inFlight = flushCallEvents(CALL);
    await new Promise((r) => setTimeout(r, 0));

    // Mid-flight the buffer reads as fully flushed — which is exactly what
    // used to make this deletable.
    releaseCallEvents(CALL);
    expect(getCallEvents(CALL)).toHaveLength(1);

    failInsert(new Error('insert blew up'));
    expect(await inFlight).toBe(false);

    // The rollback landed somewhere real, so the row is still retryable.
    dbState.execute = async (q: unknown) => {
      dbState.statements.push(q);
      return { rows: [] };
    };
    dbState.statements = [];
    expect(await flushCallEvents(CALL)).toBe(true);
    expect(dbState.statements.flatMap((s) => chunkStrings(s))).toContain('in_flight_row');

    releaseCallEvents(CALL);
    expect(getCallEvents(CALL)).toHaveLength(0);
  });

  it('still forgets a call whose events have all landed — retention is not a leak', async () => {
    emitCallEvent(CALL, 'info', 'tool', 'only_row', { a: 1 });
    expect(await flushCallEvents(CALL)).toBe(true);
    releaseCallEvents(CALL);
    expect(getCallEvents(CALL)).toHaveLength(0);
  });

  it('forgets a call that never emitted anything, and tolerates no call id', () => {
    expect(() => releaseCallEvents(undefined)).not.toThrow();
    releaseCallEvents('CA' + '0'.repeat(32));
    expect(getCallEvents('CA' + '0'.repeat(32))).toHaveLength(0);
  });
});
