/**
 * The rule the SQL builder applies, tested where it can actually be tested.
 *
 * A source scan on storage.ts proved the CASE had the right SHAPE and could
 * not see whether the incoming value was consulted at all — a mutation that
 * ignored it entirely passed cleanly (Codex, PR #268 round 9). And the first
 * version of this rule answered only half the question, which let a refused
 * price be written to the column while the total used the stored one
 * (round 10).
 */
import { describe, it, expect } from 'vitest';
import { resolveTwilioCostWrite } from './reconciledCostWrite';

describe('the Twilio price a cost-preserving update uses', () => {
  /**
   * Postgres evaluates a SET expression against the PRE-update row, so naming
   * the column reads the OLD price even while the same statement writes a new
   * one — on exactly the paths whose job is correcting that price.
   */
  it('uses the price arriving in this same statement', () => {
    expect(resolveTwilioCostWrite({ twilioCostCents: 7 })).toEqual({ value: 7, rejected: false });
  });

  it('uses a zero that was genuinely supplied', () => {
    // Twilio really does report 0 on some legs; it is a price, not an absence.
    expect(resolveTwilioCostWrite({ twilioCostCents: 0 })).toEqual({ value: 0, rejected: false });
  });

  it('reads the stored column when no new price is arriving', () => {
    for (const u of [{}, { twilioCostCents: null }, undefined]) {
      expect(resolveTwilioCostWrite(u as never)).toEqual({ value: null, rejected: false });
    }
  });

  /**
   * THE HALF THAT WAS MISSING. Refusing a value for the total while still
   * spreading it into the column left a negative twilio_cost_cents beside a
   * total built from the previous, non-negative one — the exact inconsistency
   * this path exists to prevent. `rejected` is what tells the caller to drop
   * it from the write too, so one decision governs both.
   */
  it.each([[-3], [Number.NaN], [Number.POSITIVE_INFINITY], ['x' as never]])(
    'REJECTS %p — and says so, so it is not written either',
    (bad) => {
      const out = resolveTwilioCostWrite({ twilioCostCents: bad as never });
      expect(out.value).toBeNull();
      expect(out.rejected).toBe(true);
    },
  );

  it('does not flag an ordinary absent price as rejected', () => {
    // Only a SUPPLIED bad value is a rejection; nothing supplied is normal.
    expect(resolveTwilioCostWrite({}).rejected).toBe(false);
    expect(resolveTwilioCostWrite({ twilioCostCents: null }).rejected).toBe(false);
  });
});
