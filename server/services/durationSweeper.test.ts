/**
 * A SWEEPER THAT NEVER CONVERGES IS A SWEEPER THAT ISN'T WORKING.
 *
 * Operator, 2026-08-16, on a republish log: *"I did see some errors"* — a wall
 * of these, on every boot:
 *
 *     [TWILIO RECONCILE] 3233b2be: Already reconciled (duration=595s) - skipping
 *     [DURATION FIX] Fixed 3233b2be: 595s → 595s
 *     [COST] Recalculated for 3233b2be (595s): OpenAI $1.14
 *     ...
 *     [DURATION FIX] Fixed 20/20 calls with incorrect durations
 *
 * Twenty "fixes", none of which changed anything, every startup, forever.
 *
 * THE CAUSE. The filter was `duration >= 550 AND twilio_cost_cents <= 5`, on
 * the theory that a long call which cost almost nothing must have a wrong
 * duration. But Twilio bills inbound at roughly 0.85 cents a minute, so
 * 550-660 seconds IS the five-cent bucket. Measured across a week of live
 * rows:
 *
 *     1c -> 1-180s     3c -> 241-416s    5c -> 482-668s    7c -> 784-946s
 *     2c -> 121-300s   4c -> 363-524s    6c -> 661-834s    9c -> 1051-1119s
 *
 * The two conditions describe the SAME correct call, not a contradiction. 146
 * genuine nine-to-eleven minute conversations matched — including calls with
 * 91 and 93 turns — and stayed matching forever, because reconciling a correct
 * row returns the duration it already had.
 */
import { describe, it, expect } from 'vitest';

/**
 * Twilio inbound, measured from 3,000+ live calls in the week to 2026-08-16.
 * Used here to demonstrate why the old heuristic could not work.
 */
const OBSERVED_COST_BANDS: Array<{ cents: number; minSec: number; maxSec: number }> = [
  { cents: 1, minSec: 1, maxSec: 180 },
  { cents: 2, minSec: 121, maxSec: 300 },
  { cents: 3, minSec: 241, maxSec: 416 },
  { cents: 4, minSec: 363, maxSec: 524 },
  { cents: 5, minSec: 482, maxSec: 668 },
  { cents: 6, minSec: 661, maxSec: 834 },
  { cents: 7, minSec: 784, maxSec: 946 },
];

const oldFilterMatches = (durationSec: number, costCents: number | null) =>
  durationSec >= 550 && (costCents === null || costCents <= 5);

describe('why the old heuristic could never converge', () => {
  it('flags a perfectly ordinary ten-minute call', () => {
    // 595s at 5 cents — a real call, correctly priced, correctly timed.
    expect(oldFilterMatches(595, 5)).toBe(true);
  });

  it('matches the ENTIRE overlap of its own two conditions', () => {
    /**
     * The five-cent band runs 482-668s. Everything in it from 550s up
     * satisfies both halves of the filter at once, so "long AND cheap" is not
     * a contradiction — it is the normal state of a ten-minute call.
     */
    const fiveCent = OBSERVED_COST_BANDS.find((b) => b.cents === 5)!;
    for (let sec = 550; sec <= fiveCent.maxSec; sec += 10) {
      expect(oldFilterMatches(sec, 5), `${sec}s at 5c should not look suspicious`).toBe(true);
    }
  });

  it('would only have spared a call by being MORE expensive', () => {
    // The perverse consequence: a longer call escapes the filter, because a
    // longer call costs more. The filter is anti-correlated with the defect.
    expect(oldFilterMatches(700, 6)).toBe(false);
    expect(oldFilterMatches(900, 7)).toBe(false);
    expect(oldFilterMatches(560, 5)).toBe(true);
  });
});

describe('what the sweeper selects now', () => {
  /**
   * `twilio_insights_fetched_at IS NULL` — calls Twilio has never been asked
   * about. That is what a backstop for "rows the primary reconciliation
   * missed" actually means.
   *
   * Measured before the change: of 14,017 completed calls in the last 30 days,
   * 14,017 were already reconciled and 0 were not. Every row the old filter
   * could reach was one the reconciler would refuse, which is why every
   * DURATION FIX line in the operator's log was paired with "Already
   * reconciled - skipping redundant fetch".
   */
  const newFilterMatches = (row: { insightsFetchedAt: Date | null }) => row.insightsFetchedAt === null;

  it('ignores a call already reconciled, however long or cheap', () => {
    expect(newFilterMatches({ insightsFetchedAt: new Date() })).toBe(false);
  });

  it('picks up a call whose reconciliation never ran', () => {
    expect(newFilterMatches({ insightsFetchedAt: null })).toBe(true);
  });
});

describe('only a CHANGED duration counts as a fix', () => {
  /**
   * The second half of the noise. Even on a row worth re-fetching, logging
   * "595s → 595s" and recalculating the cost is not a fix — it is a no-op
   * wearing a success message. `fixedCount` counted those, so the summary line
   * read "Fixed 20/20 calls with incorrect durations" on a run that corrected
   * nothing.
   */
  const isFix = (stored: number, actual: number | null) =>
    actual !== null && actual !== stored;

  it('does not count a reconcile that returned the same number', () => {
    expect(isFix(595, 595)).toBe(false);
  });

  it('counts a real correction', () => {
    expect(isFix(600, 12)).toBe(true);
  });

  it('does not count a reconcile that returned nothing', () => {
    expect(isFix(600, null)).toBe(false);
  });
});
