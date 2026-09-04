/**
 * server/preservedCostSet.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SET CLAUSE OF A COST-PRESERVING UPDATE, built as a value so it can be
 * rendered and asserted without a database.
 *
 * Extracted for the third time on this PR, for the third time for the same
 * reason: `voiceCostRates.ts` came out of callCostService and
 * `reconciledCostWrite.ts` came out of this clause because a rule inside a
 * SQL builder cannot be tested, and a source scan over it proves shape rather
 * than behaviour — which let a mutation ignoring the incoming value pass
 * cleanly (Codex, PR #268 round 9). Drizzle renders a query offline, so the
 * generated SQL is now the thing under test.
 *
 * THE INVARIANT: `total_cost_cents = provider + twilio`, computed at WRITE
 * time from whichever side of each component is authoritative.
 *
 *   provider  the incoming value when the update supplies one — except on a
 *             reconciled row, where the stored invoice always wins
 *   twilio    the incoming value when the update supplies a valid one,
 *             otherwise the stored column
 *
 * Both fall back to the COLUMN, and Postgres evaluates a SET expression
 * against the PRE-update row, so reading a column here gives the value that
 * was there before this statement — exactly what is wanted for a component
 * this statement is not writing.
 *
 * WHY THE UNRECONCILED BRANCH CANNOT JUST TAKE THE CALLER'S TOTAL. It used
 * to. A caller that fetches no fresh Twilio price correctly omits the column
 * so the stored one survives — but its total was still assembled from the
 * snapshot it read moments earlier, so a Twilio price corrected in that
 * window left `total_cost_cents` disagreeing with its own components on a row
 * that was never reconciled at all (Codex, PR #268 round 13). Every writer in
 * the tree passes provider + twilio, so recomputing it here is not a
 * reinterpretation of anyone's intent — it is the same sum, taken a few
 * milliseconds later, when both numbers are settled.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sql, type SQL } from "drizzle-orm";
import { callLogs } from "../shared/schema";
import { resolveTwilioCostWrite } from "./reconciledCostWrite";

/** The three columns a reconciled row defends. */
export const DEFENDED_COST_COLUMNS = [
  "openaiCostCents",
  "totalCostCents",
  "costIsEstimated",
] as const;

export interface PreservedCostSet {
  /**
   * False when the update touches none of the defended columns — the caller
   * should use the ordinary update and skip all of this.
   */
  touchesCost: boolean;
  /** The object to hand drizzle's `.set()`. Empty when `touchesCost` is false. */
  set: Record<string, unknown>;
  /** True when an invalid `twilioCostCents` was refused and dropped. */
  rejectedTwilio: boolean;
}

export function buildPreservedCostSet(
  updates: Record<string, unknown>,
): PreservedCostSet {
  const { openaiCostCents, totalCostCents, costIsEstimated, ...rest } = updates as {
    openaiCostCents?: number;
    totalCostCents?: number;
    costIsEstimated?: boolean;
  } & Record<string, unknown>;

  const touchesCost =
    openaiCostCents !== undefined ||
    totalCostCents !== undefined ||
    costIsEstimated !== undefined;
  if (!touchesCost) return { touchesCost: false, set: {}, rejectedTwilio: false };

  const reconciled = sql`${callLogs.costReconciledAt} IS NOT NULL`;

  /**
   * ONE decision for the Twilio price, used for the column AND the total —
   * see reconciledCostWrite.ts. A value refused for one and written to the
   * other is how a negative price ended up stored beside a total that did
   * not include it (Codex, PR #268 round 10).
   */
  const twilio = resolveTwilioCostWrite(updates as { twilioCostCents?: number | null });
  if (twilio.rejected) {
    // Do not persist a price that is not one. The column keeps what it had,
    // and the total below reads that same stored value, so the two agree.
    delete (rest as { twilioCostCents?: unknown }).twilioCostCents;
  }
  const twilioForTotal: SQL =
    twilio.value === null
      ? sql`COALESCE(${callLogs.twilioCostCents}, 0)`
      : sql`${twilio.value}`;

  /** The provider cost an UNRECONCILED total is built from. */
  const providerForTotal: SQL =
    openaiCostCents === undefined
      ? sql`COALESCE(${callLogs.openaiCostCents}, 0)`
      : sql`${openaiCostCents}`;

  return {
    touchesCost: true,
    rejectedTwilio: twilio.rejected,
    set: {
      ...rest,
      ...(openaiCostCents === undefined
        ? {}
        : {
            openaiCostCents: sql`CASE WHEN ${reconciled} THEN ${callLogs.openaiCostCents} ELSE ${openaiCostCents} END`,
          }),
      ...(totalCostCents === undefined
        ? {}
        : {
            // Reconciled: the invoiced provider cost, never the incoming one.
            // Otherwise: the incoming provider cost, or the stored column.
            // Either way plus the Twilio price resolved above, and never the
            // caller's own arithmetic over a stale snapshot.
            totalCostCents: sql`CASE WHEN ${reconciled} THEN COALESCE(${callLogs.openaiCostCents}, 0) + ${twilioForTotal} ELSE ${providerForTotal} + ${twilioForTotal} END`,
          }),
      ...(costIsEstimated === undefined
        ? {}
        : {
            costIsEstimated: sql`CASE WHEN ${reconciled} THEN false ELSE ${costIsEstimated} END`,
          }),
    },
  };
}
