/**
 * RECONCILE A DAY OF GROK CALLS AGAINST WHAT XAI ACTUALLY CHARGED.
 *
 * This is the instrument the operator asked for on 2026-09-04, built the way
 * he described it: take xAI's authoritative daily total, split it across
 * that day's calls by their seconds, and stop estimating.
 *
 * WHAT IT REPLACES. Every Grok row on disk carries cost_is_estimated = true
 * and cost_reconciled_at NULL — 241 of 241 — and its openai_cost_cents is
 * Math.ceil(duration * 8/60) from a constant nobody has ever checked against
 * a bill. That ceil alone overstates the measured 421 minutes by $1.18, or
 * 3.5%, in one direction on every call. The two columns this writes have
 * existed since the schema was written and have never once been used.
 *
 * WHAT IT DOES NOT DO. It does not touch twilio_cost_cents, which belongs to
 * the Twilio reconciler, and it does not touch a call the runtime did not
 * serve. It refuses the whole day rather than write a partial allocation:
 * a day where some calls are reconciled and some are not is a day whose
 * total means nothing, and this codebase has been burned before by a measure
 * that silently covered only part of its population.
 */
import { allocateDailyCost, rateDriftMarker, type CallToPrice } from "./grokCostAllocation";
import { GROK_COST_CENTS_PER_SECOND } from "./voiceCostRates";
import {
  fetchDailySpend,
  readXaiBillingConfig as readXaiBillingSetup,
  type FetchLike,
  type XaiBillingSetup,
} from "./xaiBilling";

export interface ReconcileOutcome {
  day: string;
  reconciled: boolean;
  /** Why not, when it did not. Safe to log — carries no account detail. */
  reason?: string;
  callsUpdated?: number;
  /** xAI's own charge for the day, in cents. */
  xaiTotalCents?: number;
  /** What our estimate had said, in cents, before this ran. */
  estimatedTotalCents?: number;
  derivedCentsPerSecond?: number | null;
  /**
   * How many of the day's calls the `estimatedTotalCents` figure covers. Less
   * than the day's call count means this is a re-run and the comparison is
   * only over the rows not yet reconciled — stated rather than implied, so
   * nobody reads a partial drift as the whole day's.
   */
  estimateCoversCalls?: number;
}

/** One row of the day, as the reconciler needs it. */
export interface GrokCallRow extends CallToPrice {
  /** openai_cost_cents as it stands, so the drift can be reported. */
  estimatedCents: number;
  /**
   * This row was already reconciled by an earlier run.
   *
   * Its `estimatedCents` is no longer an estimate — it is xAI's own number
   * from last time — so counting it in the drift would make the second run
   * of a day report a discrepancy near zero and hide the very thing the
   * drift exists to reveal: that our rate constant is wrong (Codex, PR #268
   * round 3).
   */
  alreadyReconciled?: boolean;
}

export interface ReconcilerPorts {
  /** Every runtime-served call that day, by UTC date. */
  readDay: (day: string) => Promise<GrokCallRow[]>;
  /** Write the allocated cost back. Must be all-or-nothing. */
  writeCosts: (day: string, costs: Array<{ callSid: string; costCents: number }>) => Promise<number>;
}

/**
 * DEPLOY MARKER AND LIVE COUNTER. Prints once per reconciliation run, so its
 * first appearance proves the build is live and its numbers are the answer
 * to "what did yesterday cost". Carries a day, two totals and a rate — no
 * call sid, no phone number, nothing about a patient.
 */
export function reconcileMarker(outcome: ReconcileOutcome): string {
  if (!outcome.reconciled) {
    return `[GROK COST] ${outcome.day}: not reconciled — ${outcome.reason ?? "unknown"}`;
  }
  const xai = ((outcome.xaiTotalCents ?? 0) / 100).toFixed(2);
  const est = ((outcome.estimatedTotalCents ?? 0) / 100).toFixed(2);
  const delta = ((outcome.xaiTotalCents ?? 0) - (outcome.estimatedTotalCents ?? 0)) / 100;
  // Sign before the dollar sign: "$-1.18" reads as a price, "-$1.18" reads as
  // the direction, and the direction is the whole point of the line.
  const signed = `${delta < 0 ? "-" : "+"}$${Math.abs(delta).toFixed(2)}`;
  const partial =
    outcome.estimateCoversCalls !== undefined &&
    outcome.callsUpdated !== undefined &&
    outcome.estimateCoversCalls < outcome.callsUpdated
      ? ` The estimate figure covers only the ${outcome.estimateCoversCalls} call(s) not ` +
        `already reconciled by an earlier run, so this drift is partial.`
      : "";
  return (
    `[GROK COST] ${outcome.day}: reconciled ${outcome.callsUpdated} call(s) against xAI's own ` +
    `$${xai}; our estimate had said $${est} (${signed}). ` +
    `These calls are no longer estimated.${partial}`
  );
}

export async function reconcileGrokCostsForDay(
  day: string,
  ports: ReconcilerPorts,
  options: { setup?: XaiBillingSetup; fetchImpl?: FetchLike } = {},
): Promise<ReconcileOutcome> {
  const spend = await fetchDailySpend(day, { setup: options.setup, fetchImpl: options.fetchImpl });
  if (!spend.ok) return { day, reconciled: false, reason: spend.reason };

  let calls: GrokCallRow[];
  try {
    calls = await ports.readDay(day);
  } catch (error) {
    return {
      day,
      reconciled: false,
      reason: error instanceof Error ? `could not read the day: ${error.message}` : "could not read the day",
    };
  }
  if (calls.length === 0) {
    return { day, reconciled: false, reason: "no runtime-served calls on this day" };
  }

  // Cents, from dollars, rounded ONCE — at the day level, where a half-cent
  // is a half-cent rather than a bias repeated 241 times.
  const xaiTotalCents = Math.round(spend.value.totalUsd * 100);
  // Only rows still carrying an ESTIMATE contribute to the estimate total.
  // A reconciled row's cost is xAI's, and summing it back in would compare
  // the bill against itself.
  const stillEstimated = calls.filter((c) => !c.alreadyReconciled);
  const estimatedTotalCents = stillEstimated.reduce((s, c) => s + (c.estimatedCents || 0), 0);

  const allocation = allocateDailyCost(calls, xaiTotalCents);

  /**
   * xAI CHARGED FOR A DAY WITH NO BILLABLE SECONDS.
   *
   * The allocation hands every call zero — correctly, there is nothing to
   * divide by — but writing that would mark every row reconciled and
   * NOT-estimated at $0 while xAI's invoice says otherwise, and report
   * success doing it. Zeros that claim to be authoritative are the worst
   * output this module can produce, so an inconsistency between the bill and
   * the durations is a reconciliation FAILURE, not a result (Codex, PR #268
   * round 2).
   */
  if (xaiTotalCents > 0 && allocation.totalSeconds <= 0) {
    return {
      day,
      reconciled: false,
      reason:
        `xAI billed $${(xaiTotalCents / 100).toFixed(2)} for ${day} but the ${calls.length} ` +
        `runtime call(s) on record carry no billable seconds — durations are missing, so the ` +
        `charge cannot be attributed and nothing was written`,
      xaiTotalCents,
      estimatedTotalCents,
    };
  }

  console.info(rateDriftMarker(day, allocation.derivedCentsPerSecond, GROK_COST_CENTS_PER_SECOND));

  let callsUpdated: number;
  try {
    callsUpdated = await ports.writeCosts(day, allocation.calls);
  } catch (error) {
    return {
      day,
      reconciled: false,
      reason: error instanceof Error ? `could not write the allocation: ${error.message}` : "could not write the allocation",
    };
  }

  const outcome: ReconcileOutcome = {
    day,
    reconciled: true,
    callsUpdated,
    xaiTotalCents,
    estimatedTotalCents,
    estimateCoversCalls: stillEstimated.length,
    derivedCentsPerSecond: allocation.derivedCentsPerSecond,
  };
  console.info(reconcileMarker(outcome));
  return outcome;
}

/**
 * The production ports. Kept apart from the logic above so the reconciler is
 * testable without a database — the mistake voiceCostRates.ts was extracted
 * to fix, where a pricing branch could not be tested at all and a first
 * attempt at a test silently ran zero assertions.
 */
export function databasePorts(): ReconcilerPorts {
  return {
    async readDay(day) {
      const { pool } = await import("../../server/db");
      const { rows } = await pool.query(
        `SELECT call_sid, COALESCE(duration, 0)::int AS duration,
                COALESCE(openai_cost_cents, 0)::int AS estimated_cents,
                (cost_reconciled_at IS NOT NULL) AS already_reconciled
           FROM call_logs
          WHERE voice_provider = 'grok'
            AND call_sid IS NOT NULL
            /**
             * FINALISED ROWS ONLY.
             *
             * The reconciler settles the previous UTC day and runs every six
             * hours, so the first run after midnight can catch a call from
             * that day still in flight. Its duration is NULL, COALESCE made
             * it zero, and because other completed calls had seconds the
             * positive-spend guard did not fire — so the live call was
             * marked reconciled at $0 (permanently, since later writers then
             * preserve it) and its share of the bill was absorbed by the
             * calls that had finished (Codex, PR #268 round 7).
             *
             * Excluding it costs nothing: the NEXT run re-allocates the
             * whole day across every row, that call included, because a
             * re-run writes all of them. A row briefly missing its share is
             * self-correcting; a row permanently stamped $0 is not.
             *
             * FINALISED, NOT COMPLETED. The first version of this filter
             * tested status = completed, which also dropped every call the
             * runtime ends as failed — dead air and provider failures — and
             * xAI bills those: the audio happened. Dropping them spread the
             * whole invoice across the survivors AND left the failed row's
             * estimate standing, so the stored daily total came out ABOVE
             * the invoice (Codex, PR #268 round 8). Measured the same day:
             * 0 of 241 Grok rows are failed so far, so this has not bitten
             * yet — but statusFor in callRecord.ts produces that status by
             * design, so it is a question of when.
             *
             * in_progress is the only non-final state the runtime writes
             * (callRecord.ts opens every row with it), so excluding that one
             * status is the whole rule. The duration check then covers a
             * finalised row that somehow has no billable seconds.
             */
            AND status IS NOT NULL
            AND status <> 'in_progress'
            AND duration IS NOT NULL
            AND duration > 0
            AND created_at >= $1::date
            AND created_at <  ($1::date + INTERVAL '1 day')`,
        [day],
      );
      return rows.map(
        (r: {
          call_sid: string;
          duration: number;
          estimated_cents: number;
          already_reconciled: boolean;
        }) => ({
          callSid: r.call_sid,
          durationSeconds: Number(r.duration) || 0,
          estimatedCents: Number(r.estimated_cents) || 0,
          alreadyReconciled: Boolean(r.already_reconciled),
        }),
      );
    },

    async writeCosts(day, costs) {
      const { pool } = await import("../../server/db");
      const client = await pool.connect();
      try {
        // One transaction: a half-allocated day would sum to neither xAI's
        // total nor our estimate, and nothing downstream could tell.
        await client.query("BEGIN");
        // total_cost_cents is rebuilt from the reconciled provider cost plus
        // whatever Twilio's own reconciler has put on the row, rather than
        // being adjusted by a delta — a delta would compound if this ran twice.
        const result = await client.query(
          `UPDATE call_logs c
              SET openai_cost_cents  = v.cost_cents,
                  total_cost_cents   = v.cost_cents + COALESCE(c.twilio_cost_cents, 0),
                  cost_is_estimated  = false,
                  cost_reconciled_at = NOW()
             FROM (SELECT * FROM unnest($1::text[], $2::int[]) AS t(call_sid, cost_cents)) v
            WHERE c.call_sid = v.call_sid
              AND c.voice_provider = 'grok'`,
          [costs.map((c) => c.callSid), costs.map((c) => c.costCents)],
        );
        /**
         * ALL OR NOTHING MEANS ALL. If a row was deleted, or stopped being a
         * Grok row, between `readDay` and this update, Postgres updates fewer
         * rows than the allocation covers — and committing that leaves the
         * survivors summing to LESS than xAI billed while every one of them
         * claims to be authoritative (Codex, PR #268 round 5). The whole
         * point of the transaction is that a half-allocated day cannot exist.
         */
        const updated = result.rowCount ?? 0;
        if (updated !== costs.length) {
          await client.query("ROLLBACK");
          throw new Error(
            `allocation covers ${costs.length} call(s) but only ${updated} row(s) matched — ` +
              `the day changed underneath the read; nothing was written`,
          );
        }
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** The UTC day before `now`, as YYYY-MM-DD — the day a nightly run settles. */
export function previousUtcDay(now: Date): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * DEPLOY MARKER — prints at boot either way, because "the reconciler is not
 * running" is exactly as important to see as "it is".
 *
 * A scheduler that wakes every hour to log that it has no credential is
 * noise, and noise is what stops people reading logs. So with no management
 * key this says so ONCE, names the two variables, and does not schedule.
 */
export function startGrokCostReconciler(
  options: {
    setup?: XaiBillingSetup;
    intervalMs?: number;
    ports?: ReconcilerPorts;
    /** Injected in tests. Without it the runner could only be exercised by
     * making a real call to xAI's billing API, which is not a test. */
    fetchImpl?: FetchLike;
  } = {},
): { scheduled: boolean; timer?: ReturnType<typeof setInterval> } {
  const setup = options.setup ?? readXaiBillingSetup();
  if (!setup.configured) {
    console.log(
      `[GROK COST] reconciler DORMANT — set ${setup.missing.join(" and ")} to switch it on. ` +
        `Until then every Grok call keeps the duration-times-rate estimate and stays marked ` +
        `cost_is_estimated = true, which is honest but is not the bill. The management key is ` +
        `created at xAI Console -> Settings -> Management Keys and is a different credential ` +
        `from XAI_API_KEY; the team id is at console.x.ai/team/default/settings/team.`,
    );
    return { scheduled: false };
  }

  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  const ports = options.ports ?? databasePorts();
  console.log(
    `[GROK COST] Starting cost reconciler (every ${Math.round(intervalMs / 60000)} minutes; ` +
      `settles the previous UTC day against xAI's own billing total)`,
  );
  const run = () => {
    void reconcileGrokCostsForDay(previousUtcDay(new Date()), ports, {
      setup,
      fetchImpl: options.fetchImpl,
    }).catch((error) => {
      console.error("[GROK COST] reconciliation threw:", error);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  // Never hold the process open for a billing job.
  if (typeof timer.unref === "function") timer.unref();
  return { scheduled: true, timer };
}
