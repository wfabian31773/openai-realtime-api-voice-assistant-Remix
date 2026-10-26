/**
 * THE EXACT COST OF ONE PHONE CALL, from xAI's own daily total.
 *
 * The operator, 2026-09-04:
 *
 *   *"We have to make sure that we are tracking the exact cost of Grok. I can
 *   see it in their dashboard, but we should be able to tap into their exact
 *   cost because they have a cost per day, and they have a flat rate. So we
 *   should be able to absolutely nail down the exact cost of every single
 *   phone call that's made."*
 *
 * That is the whole method and it is his. A flat per-minute rate means cost
 * is proportional to duration and nothing else, so a day's authoritative
 * total can be split across that day's calls by their seconds — and the
 * result is not an estimate, it is an allocation that SUMS TO WHAT XAI
 * ACTUALLY CHARGED.
 *
 * WHY THIS BEATS THE RATE CONSTANT WE HAVE
 *
 * `voiceCostRates.ts` prices a Grok call at GROK_COST_CENTS_PER_SECOND = 8/60,
 * from the published $0.08/min. Measured over the 241 runtime calls on disk:
 *
 *   summed seconds                     25,259  (421 minutes)
 *   exact at $0.08/min                 $33.68
 *   what we actually stored            $34.86
 *   overstatement from Math.ceil alone  $1.18  = 3.5%
 *
 * Every row matched the formula, so the formula is applied consistently — it
 * is the per-call ceil that inflates it, and it inflates in one direction on
 * every single call. On the one comparison this migration exists to make,
 * 3.5% is not noise.
 *
 * And the rate itself is unverified. xAI publish "$0.08 / min audio" for
 * grok-voice-think-fast-2.0 AND, separately, "$0.004 / text input", which we
 * have never counted at all. Whether that second component is material is
 * not a thing to reason about — it is a thing the invoice answers. An
 * allocation from their total absorbs it automatically, and the derived rate
 * this module reports is how you SEE that it did.
 *
 * NO CENT IS INVENTED AND NONE IS LOST. Largest-remainder allocation: floor
 * every share, then hand the leftover cents to the calls with the largest
 * fractional parts. Sum of the parts equals the total, exactly, by
 * construction — which is the property a rounded per-call rate can never
 * have.
 */

export interface CallToPrice {
  callSid: string;
  /** Billable seconds. Zero-duration calls take no share. */
  durationSeconds: number;
}

export interface AllocatedCall {
  callSid: string;
  /** This call's share of the day, in whole cents. Sums to the day's total. */
  costCents: number;
}

export interface Allocation {
  calls: AllocatedCall[];
  /** What xAI charged, in cents — the number the parts add up to. */
  totalCents: number;
  /** Summed billable seconds across the allocated calls. */
  totalSeconds: number;
  /**
   * xAI's real cost per second, derived rather than assumed. Compare it
   * against GROK_COST_CENTS_PER_SECOND: a gap is the published rate being
   * wrong, a component we are not counting (that "$0.004 / text input"), or
   * xAI billing a different duration than Twilio reports. Null when there
   * were no seconds to divide by.
   */
  derivedCentsPerSecond: number | null;
}

/**
 * Split one day's authoritative charge across that day's calls.
 *
 * `totalCents` is xAI's number, not ours. Calls with no duration are still
 * returned, at zero — a row that vanishes from the output would look like a
 * call we failed to price rather than a call that cost nothing.
 */
export function allocateDailyCost(calls: CallToPrice[], totalCents: number): Allocation {
  const billable = calls.map((c) => ({
    callSid: c.callSid,
    seconds: Number.isFinite(c.durationSeconds) ? Math.max(0, c.durationSeconds) : 0,
  }));
  const totalSeconds = billable.reduce((sum, c) => sum + c.seconds, 0);

  // Nothing to divide, or nothing to divide it among: everyone gets zero and
  // the caller can see from totalSeconds why.
  if (totalSeconds <= 0 || totalCents <= 0) {
    return {
      calls: billable.map((c) => ({ callSid: c.callSid, costCents: 0 })),
      totalCents: totalSeconds <= 0 ? totalCents : 0,
      totalSeconds,
      derivedCentsPerSecond: totalSeconds > 0 ? totalCents / totalSeconds : null,
    };
  }

  const exact = billable.map((c) => (c.seconds / totalSeconds) * totalCents);
  const floors = exact.map((v) => Math.floor(v));
  let remaining = totalCents - floors.reduce((a, b) => a + b, 0);

  // Largest fractional part first. The callSid tiebreak keeps the result
  // deterministic, so re-running a reconciliation cannot silently move a cent
  // from one ticketed call to another.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || (billable[a.i].callSid < billable[b.i].callSid ? -1 : 1));

  const cents = floors.slice();
  for (const { i } of order) {
    if (remaining <= 0) break;
    cents[i] += 1;
    remaining -= 1;
  }

  return {
    calls: billable.map((c, i) => ({ callSid: c.callSid, costCents: cents[i] })),
    totalCents,
    totalSeconds,
    derivedCentsPerSecond: totalCents / totalSeconds,
  };
}

/**
 * HOW FAR THE DERIVED RATE MAY RUN AHEAD OF THE ASSUMED ONE BEFORE THE DAY IS
 * REFUSED — and this exists because the allocation booked a 104-second call
 * at $37.43 and flagged it as settled truth.
 *
 * `CAb04962a559c013987d12958542b2b02c`, optical, Saturday 2026-09-12, 104
 * seconds. At the published rate that call costs 14 cents. xAI reported
 * $37.43 of voice spend for that day, `call_logs` held exactly ONE grok call
 * — the queue lanes are essentially silent at the weekend (CLAUDE.md records
 * 0-1 queue calls on every Saturday and Sunday measured) — and largest
 * remainder correctly handed the whole day to it. `cost_is_estimated` went
 * FALSE. 267x the published rate, wearing an authoritative badge, and it is
 * 21.7% of optical's entire reconciled cost in the Observatory's per-lane
 * report (`server/routes.ts:2259`, `:2300`).
 *
 * THE MODULE ALREADY COMPUTED THE PROOF AND ONLY PRINTED IT.
 * `rateDriftMarker` turns the same `derivedCentsPerSecond` into a console
 * line — 36.0 c/s against an assumed 0.1333 — and nothing read it. That is
 * the tool ceiling's failure exactly: the one trace a fault leaves is a
 * console line no query can reach. So the number now DECIDES rather than
 * narrates.
 *
 * THIS IS THE SAME PRINCIPLE THE TWO GUARDS ABOVE IT ALREADY STATE, one step
 * further: "an inconsistency between the bill and the durations is a
 * reconciliation FAILURE, not a result". A day with no billable seconds is
 * refused; a day with 104 of them against a full day's charge is the same
 * inconsistency with a denominator that happens to be non-zero.
 *
 * THREE IS A JUDGEMENT, NOT A MEASUREMENT, and here is what it has to clear.
 * Derived rate over xAI-reported spend and OUR minutes, every reconciled day:
 *
 *   09-03 12.8 c/min · 09-04 9.8 · 09-08 10.1 · 09-09 9.8 · 09-10 11.3
 *   09-11 11.5 · 09-14 8.9 · 09-15 8.2        (published: 8.0)
 *
 * The widest legitimate day is 1.6x. Three leaves real headroom for a rate
 * change or an uncounted component while still refusing 267x by a wide
 * margin. Raise it if a legitimate day is ever refused — and the refusal is
 * loud and leaves the rows honest, so that costs a day's precision, never a
 * day's data.
 *
 * ONLY THE UPPER BOUND, DELIBERATELY. Under-booking is visible immediately
 * against our own per-call estimate and errs toward "estimated", which is
 * the honest flag; 2026-09-15 came in 1% BELOW our estimate and is a
 * perfectly good day. Over-booking is the direction that poisons a report
 * while claiming to be authoritative.
 */
export const RATE_SANITY_MULTIPLE = 3;

/**
 * Is this day's derived rate too far above the assumed one to write?
 *
 * Returns false when there is nothing to judge — a null derived rate is the
 * no-seconds case, which the caller already refuses on its own terms.
 */
export function impliedRateIsImplausible(
  derivedCentsPerSecond: number | null,
  assumedCentsPerSecond: number,
  multiple: number = RATE_SANITY_MULTIPLE,
): boolean {
  if (derivedCentsPerSecond === null || !Number.isFinite(derivedCentsPerSecond)) return false;
  if (!Number.isFinite(assumedCentsPerSecond) || assumedCentsPerSecond <= 0) return false;
  return derivedCentsPerSecond > assumedCentsPerSecond * multiple;
}

/**
 * What the derived rate says about the rate we assume.
 *
 * Prints only when a reconciliation runs, so it is a live counter of how far
 * off the constant is — and the first place a silent price change or an
 * uncounted billing component would show up.
 */
export function rateDriftMarker(
  day: string,
  derivedCentsPerSecond: number | null,
  assumedCentsPerSecond: number,
): string {
  if (derivedCentsPerSecond === null) {
    return `[GROK COST] ${day}: no billable seconds — nothing to reconcile`;
  }
  const derivedPerMin = derivedCentsPerSecond * 60;
  const assumedPerMin = assumedCentsPerSecond * 60;
  const driftPct = assumedPerMin === 0 ? 0 : ((derivedPerMin - assumedPerMin) / assumedPerMin) * 100;
  return (
    `[GROK COST] ${day}: xAI's own total works out to ${derivedPerMin.toFixed(4)} c/min; ` +
    `we assume ${assumedPerMin.toFixed(4)} c/min (${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(2)}%). ` +
    `A persistent gap is the published rate, an uncounted component such as xAI's ` +
    `separate text-input charge, or xAI billing a different duration than Twilio reports.`
  );
}
