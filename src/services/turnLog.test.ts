/**
 * The turn table.
 *
 * The property that matters is that it never touches the call: it buffers in
 * memory, writes at teardown, and swallows everything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: any[] = [];
vi.mock('../../server/db', () => ({
  db: { insert: () => ({ values: async (rows: any[]) => { inserted.push(...rows); } }) },
}));
vi.mock('../../shared/schema', () => ({ callTurns: {} }));

const { recordTurn, getTurns, flushTurns, releaseTurns } = await import('./turnLog');

const state = (known: string[] = [], verified = false, asks = 0) => ({
  known, identityVerified: verified, identityAsks: asks,
});

let n = 0;
const fresh = () => `turn-test-${++n}`;
beforeEach(() => { inserted.length = 0; });

describe('recording', () => {
  it('numbers turns in order and pairs both sides of the conversation', () => {
    const id = fresh();
    recordTurn(id, 'agent', 'May I have your last name?', { state: state() });
    recordTurn(id, 'caller', 'Ferreras', { state: state(['last name']) });
    const turns = getTurns(id);
    expect(turns.map((t) => [t.turnIndex, t.role])).toEqual([[1, 'agent'], [2, 'caller']]);
    expect(turns[1].state.known).toEqual(['last name']);
  });

  it('captures the director ruling alongside the turn it ruled on', () => {
    const id = fresh();
    recordTurn(id, 'agent', 'And your date of birth?', {
      state: state([], false, 5),
      directorDecision: { enforcement: 'author', code: 'identity_ceiling', topic: 'identity' },
    });
    // Turn 7 is now answerable: what did we believe, and what did we do.
    expect(getTurns(id)[0].directorDecision).toMatchObject({ code: 'identity_ceiling' });
    expect(getTurns(id)[0].state.identityAsks).toBe(5);
  });

  it('records the gap between turns — where dead air shows up', () => {
    const id = fresh();
    recordTurn(id, 'agent', 'Hello?', { state: state() });
    recordTurn(id, 'caller', '...', { state: state() });
    expect(getTurns(id)[0].sincePrevMs).toBeNull();
    expect(getTurns(id)[1].sincePrevMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps raw and final separate, so a future correction is comparable', () => {
    const id = fresh();
    recordTurn(id, 'caller', 'Herreras', { state: state() });
    const t = getTurns(id)[0];
    expect(t.rawTranscript).toBe('Herreras');
    expect(t.finalTranscript).toBe('Herreras');
  });
});

describe('it must never affect the call', () => {
  it('does not throw on junk', () => {
    expect(() => recordTurn('', 'caller', 'x', { state: state() })).not.toThrow();
    expect(() => recordTurn(fresh(), 'caller', 'x', {} as never)).not.toThrow();
  });

  it('is bounded — a stuck 3-hour session cannot buffer without limit', () => {
    const id = fresh();
    for (let i = 0; i < 500; i++) recordTurn(id, 'caller', `turn ${i}`, { state: state() });
    expect(getTurns(id).length).toBeLessThanOrEqual(400);
  });
});

describe('flushing', () => {
  it('writes buffered turns once, and only what is new', async () => {
    const id = fresh();
    recordTurn(id, 'agent', 'a', { state: state(), callLogId: 'log-1', agentSlug: 'azul-scheduling' });
    await flushTurns(id);
    expect(inserted).toHaveLength(1);

    await flushTurns(id);
    expect(inserted).toHaveLength(1);

    recordTurn(id, 'caller', 'b', { state: state() });
    await flushTurns(id);
    expect(inserted).toHaveLength(2);
    releaseTurns(id);
  });
});
