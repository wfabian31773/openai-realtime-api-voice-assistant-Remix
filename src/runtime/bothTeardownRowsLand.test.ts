/**
 * BOTH TEARDOWN ROWS REACH THE DATABASE — Codex P1 on #322, round 4.
 *
 * The two `call_events` writers share one per-SID buffer. Ordered the way
 * `voiceRuntime` orders them, this happened on every runtime call that owed a
 * follow-up:
 *
 *   follow-up writer  emits its row, flush claims it, INSERT lands
 *   identity writer   emits its row a microtask later — unflushed
 *   follow-up writer  durable -> releaseCallEvents deletes the WHOLE buffer,
 *                     taking the identity row with it
 *   identity writer   flushes, finds no buffer, `flushCallEvents` answers TRUE
 *                     (nothing is unflushed), reports durable, row gone
 *
 * Round 3's reply to the same race said the 2h reaper would recover the event.
 * That is true of a predecessor that FAILS and false of one that SUCCEEDS —
 * which is the common case, and the one nothing was testing.
 *
 * THIS DRIVES THE REAL WRITERS OVER THE REAL `callEventLog`, because both ends
 * already had tests (each writer's own file mocks the module) and the link
 * between them — one shared buffer — is exactly what was uncovered. Failure
 * mode 10: a suite that asserts against the last component proves the chain
 * has an end, not that it is wired.
 *
 * Synthetic SIDs, no PHI: these rows carry counts and booleans only.
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

const { logRuntimeFollowUps, FOLLOW_UP_EVENT } = await import('./followUpTelemetry');
const { logRuntimeIdentity, IDENTITY_EVENT } = await import('./identityTelemetry');
const { getCallEvents } = await import('../services/callEventLog');
const { chunkStrings } = await import('./sqlChunkStrings.testkit');

const CALL = 'CA000000000000000000000000000b0th';

const record = () =>
  ({
    callSid: CALL,
    slug: 'surgery',
    outcome: 'caller_hangup',
    hangupsHeld: 0,
    followUps: { owed: 2, requested: 2, toolCallsAfterDone: 1, lastUnanswered: false },
  }) as never;

const IDENTITY = { patientFound: true, patientName: 'Quill Everard', patientDob: '1959-07-07' };
const PROBE = {
  size: 1,
  certainEntries: 1,
  sidCanonical: true,
  hasEntry: true,
  entryCertain: true,
  entryHasDob: true,
};

beforeEach(() => {
  dbState.statements = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the two teardown writers, ordered as voiceRuntime orders them', () => {
  it('both rows are INSERTed, and neither writer deletes the other one', async () => {
    // Exactly the call site: the follow-up write is started first and handed to
    // the identity writer as `after`, which emits before it waits.
    const followUpsWritten = logRuntimeFollowUps(record(), { callLogId: 'row-1' }).catch(
      () => undefined,
    );
    const identityDurable = await logRuntimeIdentity(
      record(),
      IDENTITY,
      PROBE,
      true,
      { callLogId: 'row-1' },
      { after: followUpsWritten },
    );

    expect(await followUpsWritten).toBe(true);
    expect(identityDurable).toBe(true);

    const written = dbState.statements.flatMap((s) => chunkStrings(s));
    expect(written).toContain(FOLLOW_UP_EVENT);
    // RED before the fix: the release above took this row out of the buffer
    // before its own writer ever flushed, and the flush said durable anyway.
    expect(written).toContain(IDENTITY_EVENT);

    // And nothing is left behind: the last writer out releases a buffer whose
    // events have all landed.
    expect(getCallEvents(CALL)).toHaveLength(0);
  });

  it('writes the identity row on a call that owed no follow-up, where there is no predecessor at all', async () => {
    const quiet = {
      callSid: 'CA00000000000000000000000000qu1et',
      slug: 'optical',
      outcome: 'caller_hangup',
      hangupsHeld: 0,
      followUps: { owed: 0, requested: 0, toolCallsAfterDone: 0, lastUnanswered: false },
    } as never;
    const followUpsWritten = logRuntimeFollowUps(quiet, {}).catch(() => undefined);
    expect(
      await logRuntimeIdentity(quiet, {}, { ...PROBE, size: 0, certainEntries: 0, hasEntry: false, entryCertain: false, entryHasDob: false }, null, {}, { after: followUpsWritten }),
    ).toBe(true);
    // The follow-up writer skipped — nothing owed — so it never released.
    expect(await followUpsWritten).toBe(false);
    const written = dbState.statements.flatMap((s) => chunkStrings(s));
    expect(written).toContain(IDENTITY_EVENT);
    expect(written).not.toContain(FOLLOW_UP_EVENT);
  });
});
