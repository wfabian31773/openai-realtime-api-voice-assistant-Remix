/**
 * THE TWILIO PRICE A COST-PRESERVING UPDATE USES — as a pure decision, used
 * for BOTH the column and the rebuilt total, so the two cannot disagree.
 *
 * Extracted for the reason `voiceCostRates.ts` was extracted from
 * callCostService: the rule lives inside a SQL builder that needs a database,
 * so nothing could test it and a source scan could only see the shape. A
 * mutation that ignored the incoming value entirely passed such a scan
 * cleanly (Codex, PR #268 round 9).
 *
 * ONE VALUE, TWO USES — and that is the whole design. The first version
 * answered only "what should the TOTAL use", and a negative price then took
 * the fallback for the total while still being spread into the column: the
 * row ended up with a negative twilio_cost_cents and a total built from the
 * previous, non-negative one. Refusing a value for one half of a statement
 * and writing it in the other half recreates the exact inconsistency this
 * path exists to prevent (Codex, PR #268 round 10).
 *
 * WHY THE TOTAL CANNOT JUST NAME THE COLUMN: Postgres evaluates a SET
 * expression against the PRE-update row, so a total rebuilt from
 * `twilio_cost_cents` reads the OLD price even while the same statement
 * writes a new one — on exactly the paths whose job is correcting that price.
 */

export interface TwilioCostWrite {
  /**
   * The price to write AND to build the total from, or null for "leave the
   * column alone and read the stored value". Never one without the other.
   */
  value: number | null;
  /** True when the caller supplied something this refused. */
  rejected: boolean;
}

export function resolveTwilioCostWrite(
  updates: { twilioCostCents?: number | null } | null | undefined,
): TwilioCostWrite {
  if (!updates || !("twilioCostCents" in updates)) return { value: null, rejected: false };
  const incoming = updates.twilioCostCents;
  // Absent or explicitly null: nothing to write, read the stored column.
  if (incoming === undefined || incoming === null) return { value: null, rejected: false };
  // A negative or non-finite price is not a price. Refusing it for the total
  // and writing it to the column would be worse than either alone.
  if (typeof incoming !== "number" || !Number.isFinite(incoming) || incoming < 0) {
    return { value: null, rejected: true };
  }
  // A genuine zero IS a price — Twilio reports it on some legs.
  return { value: incoming, rejected: false };
}
