/**
 * THE RECALCULATE BUTTON MUST NOT UNDO A RECONCILIATION.
 *
 * `POST /api/call-logs/:id/calculate-costs` is the admin "recalculate this
 * call" path. It has no audio metrics — it synthesises them from the
 * duration at a fixed 70/30 split — and it handed them to a writer that
 * wrote openai_cost_cents, total_cost_cents and cost_calculated_at through
 * the UNGUARDED storage.updateCallLog. So on a Grok row it stored an OpenAI
 * duration estimate, and on a reconciled row it replaced xAI's invoiced
 * figure with that estimate while leaving cost_reconciled_at set — a wrong
 * number wearing the badge of an authoritative one, which is worse than
 * never having reconciled at all (Codex, PR #268 round 11).
 *
 * These are BEHAVIOURAL. Three separate rounds on this same PR were passed
 * by source scans that proved shape and not behaviour, so the storage layer
 * is substituted here with one that MODELS THE SQL GUARD rather than merely
 * recording that it was called: a reconciled row keeps its provider cost.
 * A fix that calls the preserving writer but still computes the wrong
 * number, or computes the right number and writes it raw, fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

interface Row {
  id: string;
  duration: number;
  voiceProvider: string | null;
  inputAudioTokens: number | null;
  openaiCostCents: number | null;
  totalCostCents: number | null;
  twilioCostCents: number | null;
  costIsEstimated: boolean | null;
  costReconciledAt: Date | null;
}

const rows = new Map<string, Row>();
/** Runs inside the preserving write, after the caller's read. See below. */
let raceHook: ((row: Row) => void) | undefined;
/** Every write that reached the database, and which door it came through. */
const writes: Array<{ door: 'raw' | 'preserving'; update: Record<string, unknown> }> = [];

/** The three columns the guard defends. */
const COST_COLUMNS = ['openaiCostCents', 'totalCostCents', 'costIsEstimated'] as const;

vi.mock('../../server/storage', () => ({
  storage: {
    getCallLog: async (id: string) => rows.get(id),
    updateCallLog: async (id: string, update: Record<string, unknown>) => {
      writes.push({ door: 'raw', update });
      const row = rows.get(id)!;
      Object.assign(row, update);
      return row;
    },
    updateCallLogPreservingReconciledCost: async (
      id: string,
      update: Record<string, unknown>,
    ) => {
      writes.push({ door: 'preserving', update });
      const row = rows.get(id)!;
      /**
       * THE RACE, modelled. The guard is in SQL precisely because
       * reconciliation can commit between a caller's read and its write; this
       * hook lets a test put it exactly there.
       */
      raceHook?.(row);
      const applied = { ...update };
      /**
       * MODEL THE SQL, do not just record the call. server/storage.ts wraps
       * each of these three columns in `CASE WHEN cost_reconciled_at IS NOT
       * NULL THEN <stored> ELSE <incoming> END`, and rebuilds the total from
       * the preserved provider cost plus the incoming Twilio price.
       */
      if (row.costReconciledAt && COST_COLUMNS.some((c) => c in applied)) {
        if ('openaiCostCents' in applied) applied.openaiCostCents = row.openaiCostCents;
        if ('totalCostCents' in applied) {
          const twilio =
            'twilioCostCents' in applied
              ? (applied.twilioCostCents as number)
              : (row.twilioCostCents ?? 0);
          applied.totalCostCents = (row.openaiCostCents ?? 0) + twilio;
        }
        if ('costIsEstimated' in applied) applied.costIsEstimated = false;
      }
      Object.assign(row, applied);
      return row;
    },
  },
}));

const { callCostService, GROK_COST_CENTS_PER_SECOND, OPENAI_COST_CENTS_PER_SECOND } =
  await import('./callCostService');

/** Exactly what routes.ts synthesises: a 70/30 split of the duration. */
const asTheRouteCallsIt = (durationSeconds: number) => ({
  inputDurationMs: durationSeconds * 700,
  outputDurationMs: durationSeconds * 300,
});

function seed(row: Partial<Row> & { id: string }): Row {
  const full: Row = {
    duration: 128,
    voiceProvider: null,
    inputAudioTokens: null,
    openaiCostCents: null,
    totalCostCents: null,
    twilioCostCents: null,
    costIsEstimated: true,
    costReconciledAt: null,
    ...row,
  };
  rows.set(full.id, full);
  return full;
}

beforeEach(() => {
  rows.clear();
  writes.length = 0;
  raceHook = undefined;
});

describe('a reconciled row is finished', () => {
  it('keeps the invoiced provider cost when the button is pressed', async () => {
    // What the reconciler wrote from xAI's own daily total: 17c, not the
    // 18c the flat rate would ceil to. That one-cent gap is the whole point
    // — an estimate that happened to agree would prove nothing.
    const row = seed({
      id: 'reconciled-grok',
      duration: 128,
      voiceProvider: 'grok',
      openaiCostCents: 17,
      totalCostCents: 19,
      twilioCostCents: 2,
      costIsEstimated: false,
      costReconciledAt: new Date('2026-09-04T06:00:00Z'),
    });

    const costs = await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));

    expect(row.openaiCostCents, 'the bill stands').toBe(17);
    expect(row.costReconciledAt, 'and it is still labelled reconciled').not.toBeNull();
    // The badge and the number have to agree. Either both change or neither.
    expect(row.totalCostCents).toBe(17 + (row.twilioCostCents ?? 0));

    // And the operator is told what is actually stored, not what was
    // computed and discarded — reporting the estimate back would say the
    // recalculation landed when it deliberately did not.
    expect(costs?.openaiCostCents).toBe(17);
  });

  it('goes through the preserving door, never the raw one', async () => {
    seed({
      id: 'reconciled-grok-2',
      duration: 128,
      voiceProvider: 'grok',
      openaiCostCents: 17,
      costReconciledAt: new Date('2026-09-04T06:00:00Z'),
    });
    await callCostService.updateCallCosts('reconciled-grok-2', null, asTheRouteCallsIt(128));
    expect(writes.map((w) => w.door)).not.toContain('raw');
    expect(writes.map((w) => w.door)).toContain('preserving');
  });
});

describe('an un-reconciled row is priced by whose stack served it', () => {
  it('a Grok call is charged at xAI rate, not OpenAI rate', async () => {
    const row = seed({ id: 'grok-fresh', duration: 128, voiceProvider: 'grok' });
    await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));

    const grok = Math.ceil(128 * GROK_COST_CENTS_PER_SECOND);
    const openai = Math.ceil(128 * OPENAI_COST_CENTS_PER_SECOND);
    expect(grok).not.toBe(openai); // 18 vs 25 — the test is only worth anything if they differ
    expect(row.openaiCostCents).toBe(grok);
  });

  it('an OpenAI call with no tokens still gets the duration estimate', async () => {
    const row = seed({ id: 'openai-fresh', duration: 128, voiceProvider: null });
    await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));
    expect(row.openaiCostCents).toBe(Math.ceil(128 * OPENAI_COST_CENTS_PER_SECOND));
  });

  it('a token-derived cost is never clobbered by the estimate', async () => {
    const row = seed({
      id: 'openai-tokens',
      duration: 128,
      inputAudioTokens: 20_859,
      openaiCostCents: 31,
    });
    await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));
    expect(row.openaiCostCents).toBe(31);
  });
});

describe('the common case did not move', () => {
  /**
   * The rate this path used and the rate the decision module uses are the
   * same number reached two ways: the route's 70/30 split at 6 and 24 cents
   * a minute is 0.7 x 6 + 0.3 x 24 = 11.4 c/min = 0.19 c/sec, which IS
   * OPENAI_COST_CENTS_PER_SECOND. Only the rounding differs — two
   * Math.rounds became one Math.ceil. Pinned as a bound rather than an
   * equality, because they genuinely disagree by a cent on some durations
   * and claiming otherwise would be the false half of a true statement.
   */
  it('agrees with the old audio-metric arithmetic to within two cents', async () => {
    for (const duration of [30, 47, 89, 128, 175, 600]) {
      const oldWay =
        Math.round(((duration * 700) / 60_000) * 6) + Math.round(((duration * 300) / 60_000) * 24);
      const row = seed({ id: `d-${duration}`, duration });
      await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(duration));
      expect(
        Math.abs((row.openaiCostCents ?? 0) - oldWay),
        `${duration}s: now ${row.openaiCostCents}c, before ${oldWay}c`,
      ).toBeLessThanOrEqual(2);
    }
  });
});

describe('a row that vanished between the read and the write', () => {
  it('reports nothing rather than writing zeros', async () => {
    const costs = await callCostService.updateCallCosts('gone', null, asTheRouteCallsIt(128));
    expect(costs).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('reconciliation commits between the read and the write', () => {
  /**
   * The read in `updateCallCosts` is a snapshot. Reconciliation committing
   * after it and before the UPDATE is the exact race the SQL guard exists to
   * close — and closing it in the database is only half the job. A response
   * assembled from the snapshot still hands the operator the estimate and
   * calls it stored: the same wrong number wearing the same badge, one layer
   * up (Codex, PR #268 round 12). The answer has to come from the row the
   * statement returned.
   */
  it('reports the invoice that won, not the estimate that was planned', async () => {
    const row = seed({
      id: 'raced',
      duration: 128,
      voiceProvider: 'grok',
      openaiCostCents: null,
      twilioCostCents: 2,
      costReconciledAt: null, // NOT reconciled at the moment of the read
    });

    // ...and the reconciler commits xAI's figure while the write is in flight.
    raceHook = (r) => {
      r.openaiCostCents = 17;
      r.costReconciledAt = new Date('2026-09-04T06:00:00Z');
    };

    const costs = await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));

    const estimate = Math.ceil(128 * GROK_COST_CENTS_PER_SECOND); // 18 — what was planned
    expect(estimate).not.toBe(17); // the test is only worth anything if they differ

    expect(row.openaiCostCents, 'the database kept the invoice').toBe(17);
    expect(costs?.openaiCostCents, 'and so does the answer the operator gets').toBe(17);
    expect(costs?.totalCostCents).toBe(17 + 2);
  });
});

describe('a Twilio fetch that did not happen', () => {
  /**
   * `twilioCostCents` is initialised to 0 and stays there when there is no
   * callSid, or when Twilio has not finalised the leg. Writing it replaced a
   * price Twilio had already given us on an earlier pass — and
   * `resolveTwilioCostWrite` cannot defend against it, because a genuine zero
   * IS a price on some legs and the guard has no way to tell the two apart.
   * Only the caller knows which it is holding.
   */
  it('leaves the stored price alone instead of writing zero over it', async () => {
    const row = seed({
      id: 'no-fetch',
      duration: 128,
      twilioCostCents: 7, // Twilio priced this leg on an earlier pass
    });

    const costs = await callCostService.updateCallCosts(row.id, null, asTheRouteCallsIt(128));

    expect(row.twilioCostCents, 'the known price survives').toBe(7);
    expect(costs?.twilioCostCents).toBe(7);
    // And the total is built from it, not from the initialiser.
    expect(costs?.totalCostCents).toBe(Math.ceil(128 * OPENAI_COST_CENTS_PER_SECOND) + 7);
  });

  it('does not send the column at all when nothing was fetched', async () => {
    seed({ id: 'no-fetch-2', duration: 128, twilioCostCents: 7 });
    await callCostService.updateCallCosts('no-fetch-2', null, asTheRouteCallsIt(128));
    const write = writes.find((w) => w.door === 'preserving');
    expect(write?.update).not.toHaveProperty('twilioCostCents');
  });
});
