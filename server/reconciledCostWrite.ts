/**
 * WHICH TWILIO PRICE THE REBUILT TOTAL USES — as a pure decision.
 *
 * Extracted for the reason `voiceCostRates.ts` was extracted from
 * `callCostService`: the rule lives inside a SQL builder that needs a
 * database, so nothing could test it and a source scan could only see the
 * shape. A mutation that ignored the incoming value entirely passed a
 * shape check cleanly (Codex, PR #268 round 9 — and then the mutation pass
 * on the fix for it).
 *
 * THE RULE, and why it exists: Postgres evaluates a SET expression against
 * the PRE-update row, so a total rebuilt by naming `twilio_cost_cents` reads
 * the OLD price even when the same statement is writing a new one. The paths
 * that reach this code are the ones whose whole job is correcting a Twilio
 * price, so the old value is exactly the wrong one.
 */

/**
 * The Twilio cost to build a reconciled row's total from.
 *
 * A number means "use this, it is arriving in this same statement". `null`
 * means "there is no new price, read the stored column".
 */
export function twilioCostForRebuiltTotal(
  updates: { twilioCostCents?: number | null } | null | undefined,
): number | null {
  const incoming = updates?.twilioCostCents;
  if (typeof incoming !== "number" || !Number.isFinite(incoming)) return null;
  // A negative price is not a price. Fall back rather than write nonsense.
  return incoming < 0 ? null : incoming;
}
