/**
 * RECORDING A TOOL CALL AND PERSISTING IT ARE ONE ACT.
 *
 * They were two, and the split was invisible from inside either half.
 * `realtimeAdapter` flushed after every tool, so the four queue lanes were
 * durable within seconds. `pcp`, `no-ivr` and `answering-service` build their
 * tools BY HAND — `recordedTool` in each agent file, wrapping
 * `recordingExecute` directly — and never reached that file at all. Their only
 * route to the database was the 2h reaper, and `timelines` is an in-memory
 * Map, so every deploy or restart inside that window destroyed the record.
 *
 * MEASURED 2026-09-16, substantive calls, `tool_call_count IS NULL`:
 *
 *   pcp      90.9%   (against 36.8% on 09-14 and 31.7% on 09-15)
 *   optical  26.5%   tech 22.2%   surgery 16.4%
 *
 * The swing on one lane across three days is how many times the process
 * restarted, which is not a property anybody should be measuring a fleet
 * through. On 2026-09-16 that left PCP's tool activity unreadable on nine
 * calls in ten, and a "no tool ever ran" bucket was nearly published off the
 * back of it.
 *
 * AND THE ADAPTER'S OWN FLUSH WAS ONE TOOL BEHIND for its whole life. Its
 * call site sat INSIDE the function that `recordingExecute` wraps, and the
 * event is recorded only after that function returns — so the flush persisted
 * the PREVIOUS tools' events and never the one that had just finished. The
 * last tool of every call reached the database through the reaper or not at
 * all. That is the shape the adapter's own header describes costing most of a
 * day: four consecutive live Surgery calls recording three tool events and
 * nothing for the fourth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Timeline = { events: unknown[]; toolCallCount: number };
type Update = { payload: Record<string, unknown>; touched: number };
/** The timeline blob inside a `.set()` — `payload.toolTimeline`, not `payload`. */
const timelineOf = (u: Update) => u.payload.toolTimeline as Timeline;
const updates: Update[] = [];
/** How many rows the next UPDATE reports touching. 0 = the call row is not
 *  open yet, which is the case the second half of this fix exists for. */
let rowsTouched = 1;
/** Milliseconds the next UPDATE takes, so two flushes can be made to overlap. */
let writeDelays: number[] = [];

vi.mock('../../server/db', () => ({
  db: {
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const delay = writeDelays.shift() ?? 0;
            if (delay) await new Promise((r) => setTimeout(r, delay));
            const rows = rowsTouched > 0 ? [{ id: 'row-1' }] : [];
            updates.push({ payload, touched: rows.length });
            return rows;
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));
vi.mock('../../shared/schema', () => ({ callLogs: { id: 'id', callSid: 'call_sid' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

const { recordingExecute, flushAzulTimeline, getAzulTimeline } = await import('./toolTimeline');

let n = 0;
const freshCall = () => `persist-test-${++n}`;

/** Let the fire-and-forget flush settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  updates.length = 0;
  rowsTouched = 1;
  writeDelays = [];
});

describe('a hand-built agent tool persists without anyone calling the flush', () => {
  it('writes the timeline after the tool returns — no explicit flush anywhere', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute(
      { callId, callSid: 'CApersist1', agentSlug: 'pcp' },
      'record_pcp_intake',
      async () => JSON.stringify({ success: true }),
    );

    await wrapped({});
    await settle();

    expect(
      updates,
      'the tool completed and nothing was written — this is the state that made PCP 90.9% blind',
    ).toHaveLength(1);
    expect(updates[0]!.payload.toolCallCount).toBe(1);
  });

  it('persists EVERY tool, including the last one of the call', async () => {
    // The adapter's old call site fired before the event was recorded, so the
    // final tool never made it. Three tools must leave a timeline of three.
    const callId = freshCall();
    const ctx = { callId, callSid: 'CApersist2', agentSlug: 'pcp' };
    for (const name of ['record_pcp_intake', 'create_pcp_task', 'terminate_call']) {
      await recordingExecute(ctx, name, async () => JSON.stringify({ success: true }))({});
      await settle();
    }

    expect(updates[updates.length - 1]!.payload.toolCallCount).toBe(3);
  });

  it('never lets a write failure reach the tool', async () => {
    const wrapped = recordingExecute(
      { callId: freshCall(), callSid: 'CApersist3', agentSlug: 'pcp' },
      'record_pcp_intake',
      async () => JSON.stringify({ success: true, ticket: 'PCP-1' }),
    );
    rowsTouched = 0; // the row is not there; the flush takes its own exit
    await expect(wrapped({})).resolves.toContain('PCP-1');
  });
});

describe('two flushes for one call cannot race', () => {
  /**
   * Codex P1 on #320. `mediaStreamBridge.handleToolCall` dispatches every tool
   * call in one model response CONCURRENTLY, and the per-tool flush this PR
   * adds turned that into overlapping UPDATEs on a single row. The older write
   * could land LAST, overwrite the newer timeline, and then mark the larger
   * event count durable — so the reaper saw a complete entry sitting over a
   * truncated row and never repaired it.
   *
   * That is the 2026-07-28 race this module's own comment records (17 of 51
   * timelines gutted), with a much shorter fuse because it now fires per TOOL.
   */
  it('the last write to land holds the FULL timeline, not a stale snapshot', async () => {
    const callId = freshCall();
    const ctx = { callId, callSid: 'CArace1', agentSlug: 'pcp' };

    // The first write is slow, the second is instant — the ordering that made
    // the old code overwrite three events with one.
    writeDelays = [40, 0];

    const first = recordingExecute(ctx, 'record_pcp_intake', async () => '{}')({});
    await first;
    // A second and third tool land while that first flush is still in flight.
    await recordingExecute(ctx, 'create_pcp_task', async () => '{}')({});
    await recordingExecute(ctx, 'terminate_call', async () => '{}')({});
    await new Promise((r) => setTimeout(r, 120));

    const last = updates[updates.length - 1]!;
    expect(
      last.payload.toolCallCount,
      'an older flush landed last and overwrote the complete timeline',
    ).toBe(3);
    expect(timelineOf(last).events).toHaveLength(3);
  });

  it('never marks a count larger than the snapshot it actually wrote', async () => {
    const callId = freshCall();
    const ctx = { callId, callSid: 'CArace2', agentSlug: 'pcp' };

    writeDelays = [40, 0, 0];
    await recordingExecute(ctx, 'record_pcp_intake', async () => '{}')({});
    await recordingExecute(ctx, 'create_pcp_task', async () => '{}')({});
    await new Promise((r) => setTimeout(r, 120));

    // Every write's marked count must be describable by its own payload.
    for (const u of updates) {
      // The blob's own count and its own events must agree, and both must
      // match the count stamped on the column.
      expect(timelineOf(u).events).toHaveLength(timelineOf(u).toolCallCount);
      expect(timelineOf(u).toolCallCount).toBe(u.payload.toolCallCount);
    }
    // And the entry ends durable at exactly what the row holds.
    const finalCount = updates[updates.length - 1]!.payload.toolCallCount;
    await flushAzulTimeline(callId);
    expect(updates[updates.length - 1]!.payload.toolCallCount).toBe(finalCount);
  });
});

describe('a write that touched NO row is not a flush', () => {
  /**
   * `callRecord.ts` has described this defect since PR #227 and it was never
   * fixed: the UPDATE runs `WHERE call_sid = ?`, matches nothing when the
   * call's row is not open yet, and `flushedCount` was set anyway — so the
   * entry read as durable, the 2h reaper skipped it, and the events died in
   * memory. Moving the flush EARLIER, which is what the other half of this
   * change does, makes that case more likely rather than less.
   */
  it('leaves the entry dirty so a later flush writes it again', async () => {
    const callId = freshCall();
    const ctx = { callId, callSid: 'CApersist4', agentSlug: 'pcp' };

    rowsTouched = 0; // the call row does not exist yet
    await recordingExecute(ctx, 'record_pcp_intake', async () => '{}')({});
    await settle();
    expect(updates, 'it should still have TRIED').toHaveLength(1);
    expect(updates[0]!.touched).toBe(0);

    // The row lands, and a later flush must re-write rather than skip.
    rowsTouched = 1;
    await flushAzulTimeline(callId);
    expect(
      updates,
      'the entry was marked flushed on a write that touched nothing — the events are now lost',
    ).toHaveLength(2);
    expect(updates[1]!.payload.toolCallCount).toBe(1);
  });

  it('still skips a second flush when the first one really landed', async () => {
    // Idempotence must survive the fix: a successful write marks the entry,
    // and re-flushing with nothing new writes nothing.
    const callId = freshCall();
    await recordingExecute(
      { callId, callSid: 'CApersist5', agentSlug: 'pcp' },
      'record_pcp_intake',
      async () => '{}',
    )({});
    await settle();
    expect(updates).toHaveLength(1);

    await flushAzulTimeline(callId);
    expect(updates, 'a no-op flush wrote again').toHaveLength(1);
    expect(getAzulTimeline(callId)).toHaveLength(1);
  });
});

/**
 * Source with comments stripped.
 *
 * The first version of the assertion below banned the STRING
 * `flushTimelineSafely` and went red on the COMMENT that explains why the
 * call site was removed — documentation reading as a second copy. That is the
 * device `recognisedCallerBlock.test.ts` already settled: compare CODE, not
 * prose, or the file cannot explain its own history.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('wiring, read from the source', () => {
  /**
   * Failure mode 10. The behaviour above is tested against the helper; these
   * read the files, because the whole defect was that three agents never
   * reached the file that did the flushing.
   */
  const read = (p: string) => readFileSync(path.resolve(__dirname, p), 'utf8');

  it('the recorder flushes on BOTH exits, each after its own record', () => {
    const src = codeOnly(read('./toolTimeline.ts'));
    // Two exits: the tool threw, and the tool returned. A tool that threw is
    // still a tool that ran, and its event is the one a reader most wants
    // (Codex P2, #320) — before this it depended on the 2h reaper.
    expect(src.match(/void flushAfterRecording\(/g) ?? []).toHaveLength(2);

    // And each flush sits AFTER the record it belongs to, never before.
    const firstRecord = src.indexOf('recordToolEvent(');
    const firstFlush = src.indexOf('void flushAfterRecording(');
    const lastRecord = src.lastIndexOf('recordToolEvent(');
    const lastFlush = src.lastIndexOf('void flushAfterRecording(');
    expect(firstFlush).toBeGreaterThan(firstRecord);
    expect(lastFlush).toBeGreaterThan(lastRecord);

    // The error exit still rethrows — telemetry must not swallow the failure.
    expect(src.slice(firstFlush, firstFlush + 120)).toContain('throw err;');
  });

  it('the adapter no longer keeps a second flush call site', () => {
    const src = codeOnly(read('../tools/realtimeAdapter.ts'));
    expect(
      src.includes('flushTimelineSafely'),
      'two flush sites is the drift shape this repo has already paid for',
    ).toBe(false);
    // And it must still route tools through the recorder, or nothing persists.
    expect(src).toContain('recordingExecute<unknown, string>(');
  });


  it('marks the snapshot it wrote, never the live count', () => {
    // `entry.events` keeps growing while the write is awaited, so reading its
    // length afterwards marks a size the row does not hold — the entry then
    // reads durable over a truncated row and the reaper never repairs it.
    const src = codeOnly(read('./toolTimeline.ts'));
    expect(src).toContain('const eventsSnapshot = entry.events.slice();');
    expect(src).toContain('const eventsWritten = eventsSnapshot.length;');
    expect(src).toContain('events: eventsSnapshot,');
    expect(src).toContain('toolCallCount: eventsWritten');
    expect(
      src.includes('entry.flushedCount = entry.events.length'),
      'the live count is marked again — Codex P1 on #320',
    ).toBe(false);
  });

  it('serializes flushes per entry so two cannot overlap', () => {
    // mediaStreamBridge dispatches every tool call in one model response
    // CONCURRENTLY, and a per-tool flush turns that into overlapping UPDATEs
    // on one row. The older write landing last is the 2026-07-28 race.
    const src = codeOnly(read('./toolTimeline.ts'));
    expect(src).toContain('flushChain');
    expect(src).toMatch(/flushChain = \(.*flushChain \?\? Promise\.resolve\(\)\)\.then\(run, run\)/s);
    // Both arms of .then, so a rejected flush cannot wedge the chain forever.
    expect(src).toContain('.then(run, run)');
  });

  it('every hand-built agent still wraps its tools in the recorder', () => {
    // These three never reached realtimeAdapter, which is why they were blind.
    for (const agent of ['pcpAgent', 'noIvrAgent', 'answeringServiceAgent']) {
      const src = read(`../agents/${agent}.ts`);
      expect(src, `${agent} stopped recording`).toContain('recordingExecute(');
    }
  });

  it('the flush only marks an entry durable when a row came back', () => {
    const src = read('./toolTimeline.ts');
    const returning = src.indexOf('.returning({ id: callLogs.id })');
    const marked = src.indexOf('entry.flushedCount = Math.max(');
    expect(returning).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(returning);
    // The zero-row exit sits between them and returns, so the mark is skipped.
    expect(src.slice(returning, marked)).toMatch(/rowsTouched === 0[\s\S]*return;/);
  });
});
