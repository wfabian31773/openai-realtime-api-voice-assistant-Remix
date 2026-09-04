/**
 * The rule the SQL builder applies, tested where it can actually be tested.
 *
 * A source scan on storage.ts proved the CASE had the right SHAPE and could
 * not see whether the incoming value was consulted at all — a mutation that
 * ignored it entirely passed cleanly. Same lesson as voiceCostRates: a
 * decision buried in code that needs a database is a decision nobody checks.
 */
import { describe, it, expect } from 'vitest';
import { twilioCostForRebuiltTotal } from './reconciledCostWrite';

describe('which Twilio price a reconciled row rebuilds its total from', () => {
  /**
   * Postgres evaluates a SET expression against the PRE-update row, so naming
   * the column reads the OLD price even while the same statement writes a new
   * one — on exactly the paths whose job is correcting that price (Codex,
   * PR #268 round 9).
   */
  it('uses the price arriving in this same statement', () => {
    expect(twilioCostForRebuiltTotal({ twilioCostCents: 7 })).toBe(7);
  });

  it('uses a zero that was genuinely supplied', () => {
    // Twilio really does report 0 on some legs; it is a price, not an absence.
    expect(twilioCostForRebuiltTotal({ twilioCostCents: 0 })).toBe(0);
  });

  it('falls back to the stored column when no new price is arriving', () => {
    expect(twilioCostForRebuiltTotal({})).toBeNull();
    expect(twilioCostForRebuiltTotal({ twilioCostCents: null })).toBeNull();
    expect(twilioCostForRebuiltTotal(undefined)).toBeNull();
  });

  it('refuses nonsense rather than writing it into a total', () => {
    expect(twilioCostForRebuiltTotal({ twilioCostCents: -3 })).toBeNull();
    expect(twilioCostForRebuiltTotal({ twilioCostCents: NaN })).toBeNull();
    expect(twilioCostForRebuiltTotal({ twilioCostCents: 'x' as never })).toBeNull();
  });
});
