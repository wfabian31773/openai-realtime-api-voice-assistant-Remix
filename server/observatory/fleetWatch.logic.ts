/**
 * Pure decision logic for the fleet watcher — the thing that looks at the
 * voice lanes every few minutes and decides whether anything said out loud
 * is worth saying.
 *
 * Import-free so it is testable without DATABASE_URL (the same extraction
 * pattern as `staleCallSweep.logic.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS MOSTLY ABOUT *NOT* ALARMING
 * ---------------------------------------------------------------------------
 *
 * Every number this watcher reads has already been misread at least once, and
 * each misreading is written down in `/CLAUDE.md` or
 * `docs/observatory/STATE-OF-PLAY.md`. A watcher that re-commits those
 * mistakes automatically is worse than no watcher, because it commits them
 * every five minutes instead of once an afternoon.
 *
 * So the rules below are derived from the record, not picked:
 *
 *  1. `tool_call_count >= 40` is the ceiling DOING ITS JOB, not a regression.
 *     `ToolCallCeiling.begin` refuses at `dispatches >= perCallDispatches`
 *     (40), so a call can reach 40 and can never exceed it. The check
 *     published before 2026-09-09 asked for `> 40` and was therefore blind to
 *     every loop the ceiling stopped (measured: `> 40` = 1, `= 40` = 5,
 *     25..39 = 0). Only a value ABOVE the limit is a fault — it would mean the
 *     ceiling is not in the dispatch path.
 *
 *  2. A SINGLE HOUR IS NEVER A SPIKE. Surgery's hourly barely-heard rate on
 *     2026-09-08 ran 16.7 · 14.3 · 42.9 · 31.6 · 36.4 · 5.9 · 31.6 · 7.7 · 0.0
 *     across nine business hours at n = 9..19. Any one hour above the watch
 *     threshold is inside the established spread.
 *
 *  3. QUIET QUEUE LANES ON A WEEKEND OR HOLIDAY ARE THE ROUTING WORKING.
 *     Standing instruction 13 sends everything to the after-hours agent out of
 *     hours, and it is on the old core. Measured shape: 09-05 (Sat) 133 no-ivr
 *     / 1 queue, 09-06 (Sun) 26 / 0, 09-07 (Labor Day) 276 no-ivr / 2 queue and
 *     ZERO on optical, surgery and tech. A holiday Monday is indistinguishable
 *     from a total queue-lane outage on volume alone — the discriminator is
 *     whether no-ivr is absorbing.
 *
 *  4. A FILING RATE WE CANNOT MEASURE IS `null`, NEVER 0%. `tickets` lives in
 *     the Support Center project and `call_logs` in the Operations Hub; no
 *     statement joins them. If the ticket half is unavailable the watcher says
 *     so. Reporting 0% because a credential is missing is the exact shape of
 *     the 2026-09-03 error that understated filing by a third.
 *
 *  5. `tool_timeline` IS RELIABLE FOR REFUSALS ONLY. It drops about 35% of
 *     successful filings fleet-wide and 100% of them on pcp. Gate refusals
 *     (`outcome.missingFields`) are trustworthy; "no filing event" is not
 *     evidence that nothing filed.
 *
 *  6. `tool_call_count` IS NULL ON ABOUT A THIRD OF GROK ROWS, steady on every
 *     day the lane has run. The ceiling check is blind to that share, so the
 *     watcher reports the blind share beside the result rather than implying a
 *     clean sweep.
 *
 *  7. A MOVE AT SMALL n IS NOT A MOVE. tech +2.6 points and surgery +6.3
 *     across the runtime cutover were both reported as flat, correctly, at
 *     n≈66 and n≈32. The watcher applies the same test rather than reacting to
 *     the first number that looks different.
 */

/** Lanes that take patient queue traffic during business hours. */
export const QUEUE_LANES = ['optical', 'surgery', 'tech', 'records', 'pcp'] as const;

/** The after-hours agent. Standing instruction 13: all overnight and weekend
 * volume lands here, and it is on the old core. It is the control that tells a
 * closed office apart from a broken one. */
export const AFTER_HOURS_LANE = 'no-ivr';

/**
 * The tool ceiling's per-call dispatch limit.
 *
 * NOT imported from `src/runtime/toolCeiling.ts` on purpose: that module is on
 * the runtime side of the tree and this file must stay import-free so the test
 * runs without any environment. `ceilingDocCheck.test.ts` already guards the
 * documents against drift from the real limit; `fleetWatch.logic.test.ts`
 * guards this copy the same way.
 */
export const CEILING_PER_CALL_DISPATCHES = 40;

/** Below this many substantive calls, a rate is reported but never alarmed on. */
export const MIN_N_FOR_A_RATE = 25;

/** Consecutive substantive calls with no filing before the filing-stop alarm.
 * Derived 2026-09-01: runs were 185 once (the 08-31 outage) and never above 8
 * otherwise, so 12 separates a real stop from the worst healthy run. */
export const FILING_STOP_RUN = 12;

/** Barely-heard watch level. Old-core lanes ran 8.5–13.0%; the runtime at VAD
 * 0.85 ran 23.7–37.2% and at 0.6 sits in the high teens to low twenties. */
export const BARELY_HEARD_WATCH_PCT = 25;

export type Severity = 'info' | 'watch' | 'alarm';

export interface LaneWindow {
  lane: string;
  pipeline: 'grok' | 'old-core';
  substantive: number;
  barelyHeard: number;
  /** Calls whose highest `tool_call_count` reached the ceiling. */
  ceilingReached: number;
  /** The largest `tool_call_count` seen. `null` when every row was NULL. */
  maxToolCalls: number | null;
  /** Rows where `tool_call_count` is NULL — the ceiling check cannot see these. */
  toolCountNull: number;
  /** Calls carrying a `date_of_birth` gate refusal. Refusals only — see rule 5. */
  dobRefused: number;
  /** Calls with an agent-provenance ticket. `null` when the Support Center
   * could not be reached — see rule 4. NEVER default this to 0. */
  filed: number | null;
  /** Longest run of consecutive substantive calls with no agent filing.
   * `null` when the ticket half is unavailable. */
  longestUnfiledRun: number | null;
}

export interface Finding {
  severity: Severity;
  lane: string;
  headline: string;
  /** What the reader should do, or why no action is implied. */
  detail: string;
}

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (100 * numerator) / denominator;
}

export function formatPct(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${pct(numerator, denominator).toFixed(1)}%`;
}

/**
 * Two-proportion z-test. Rule 7: a difference is only reported as a move when
 * it would not routinely arise from noise at these sample sizes.
 *
 * Returns `false` for any comparison below `MIN_N_FOR_A_RATE` on either side,
 * because at that size the test has no power and reporting its verdict either
 * way is theatre.
 */
export function isRealMove(
  aHits: number, aN: number,
  bHits: number, bN: number,
  z = 1.96,
): boolean {
  if (aN < MIN_N_FOR_A_RATE || bN < MIN_N_FOR_A_RATE) return false;
  const p = (aHits + bHits) / (aN + bN);
  if (p <= 0 || p >= 1) return false;
  const se = Math.sqrt(p * (1 - p) * (1 / aN + 1 / bN));
  if (se === 0) return false;
  return Math.abs(aHits / aN - bHits / bN) / se > z;
}

/**
 * Rule 3. Is the fleet quiet because the office is shut?
 *
 * The discriminator is not the calendar — it is whether the after-hours agent
 * is absorbing the volume the queue lanes are not taking. A real queue outage
 * during business hours leaves BOTH low, because the numbers simply fail.
 */
export function isClosedOfficeShape(
  queueSubstantive: number,
  afterHoursSubstantive: number,
): boolean {
  return queueSubstantive <= 2 && afterHoursSubstantive >= 10;
}

/**
 * Rule 1. A row at the ceiling is the ceiling working. A row ABOVE it means
 * the ceiling is not in the dispatch path, which is a fault.
 */
export function assessCeiling(w: LaneWindow): Finding | null {
  if (w.maxToolCalls !== null && w.maxToolCalls > CEILING_PER_CALL_DISPATCHES) {
    return {
      severity: 'alarm',
      lane: w.lane,
      headline: `tool_call_count ${w.maxToolCalls} is ABOVE the ceiling of ${CEILING_PER_CALL_DISPATCHES}`,
      detail:
        'The ceiling refuses at >= the limit, so nothing should exceed it. A value above ' +
        'it means the ceiling is not in the dispatch path for this lane. Read the call.',
    };
  }
  if (w.ceilingReached > 0) {
    const blind = w.toolCountNull > 0
      ? ` ${w.toolCountNull} of ${w.substantive} rows have a NULL tool_call_count, so this check cannot see them.`
      : '';
    return {
      severity: 'watch',
      lane: w.lane,
      headline: `${w.ceilingReached} call(s) reached the tool ceiling (${CEILING_PER_CALL_DISPATCHES} dispatches)`,
      detail:
        'This is the ceiling stopping a loop, not a regression — read the calls to find ' +
        `what looped. None of the six recorded so far filed a ticket.${blind}`,
    };
  }
  return null;
}

/** Rule 2 lives here: this is only ever called with a whole-day or
 * multi-hour window, and the caller is responsible for never handing it a
 * single hour. `assessBarelyHeard` refuses to alarm below `MIN_N_FOR_A_RATE`
 * for the same reason. */
export function assessBarelyHeard(w: LaneWindow): Finding | null {
  const rate = pct(w.barelyHeard, w.substantive);
  if (rate < BARELY_HEARD_WATCH_PCT) return null;
  const underpowered = w.substantive < MIN_N_FOR_A_RATE;
  return {
    severity: underpowered ? 'info' : 'watch',
    lane: w.lane,
    headline: `barely-heard ${formatPct(w.barelyHeard, w.substantive)} (${w.barelyHeard}/${w.substantive})`,
    detail: underpowered
      ? `Below ${MIN_N_FOR_A_RATE} substantive calls — reported, not alarmed on.`
      : 'Callers transcribed at most once on a call of 30s or more. Check ' +
        'RUNTIME_VAD_THRESHOLD before concluding anything, and compare against the ' +
        "lane's own recent days rather than against another lane.",
  };
}

/** Rule 4 and the filing-stop alarm. */
export function assessFiling(w: LaneWindow): Finding | null {
  if (w.filed === null) {
    return {
      severity: 'info',
      lane: w.lane,
      headline: 'filing rate UNKNOWN — the Support Center was not reachable',
      detail:
        'tickets and call_logs are in different Supabase projects and nothing joins them. ' +
        'An unmeasured rate is reported as unknown; it is never reported as zero.',
    };
  }
  if (w.longestUnfiledRun !== null && w.longestUnfiledRun >= FILING_STOP_RUN) {
    return {
      severity: 'alarm',
      lane: w.lane,
      headline: `${w.longestUnfiledRun} consecutive substantive calls filed nothing`,
      detail:
        'This is the 2026-08-31 shape (185 consecutive, found hours later because staff ' +
        'told Wayne). Check the ticketing gateway before anything else.',
    };
  }
  return null;
}

/** One row of `call_logs`, reduced to what the watcher reads. */
export interface CallRow {
  call_sid: string;
  agent_used: string;
  pipeline: 'grok' | 'old-core';
  tool_call_count: number | null;
  /** `CALLER:` lines counted from the transcript. NOT `total_turns`, which
   * counts something else — it fell 16.1 -> 9.7 across the tech cutover while
   * the callers demonstrably said MORE. */
  caller_lines: number;
  dob_refused: boolean;
}

/**
 * Longest run of consecutive substantive calls, in time order, that filed
 * nothing. The 2026-08-31 detector: 185 consecutive that day, never above 8 on
 * any healthy day.
 *
 * Callers must pass the rows already ordered by time — a run means nothing
 * over an unordered set.
 */
export function longestUnfiledRun(calls: CallRow[], filed: Set<string>): number {
  let run = 0;
  let worst = 0;
  for (const c of calls) {
    run = filed.has(c.call_sid) ? 0 : run + 1;
    if (run > worst) worst = run;
  }
  return worst;
}

/**
 * Fold time-ordered calls into one window per (lane, pipeline).
 *
 * `filed = null` means the Support Center could not be read, and it propagates
 * as `null` all the way to the report. It must NEVER become 0 — see rule 4.
 *
 * A lane is split by pipeline on purpose: a lane that cut over mid-day is two
 * populations, and the Observatory already warns "mixed pipelines — do not
 * read these as one population" for the same reason.
 */
export function foldCallsIntoWindows(
  calls: CallRow[],
  filed: Set<string> | null,
): LaneWindow[] {
  // Keyed by lane+pipeline, but the parts are carried in the value rather than
  // packed into the key and split back out. An earlier version joined them into
  // a string and split on a separator, which is one silent-corruption class
  // (and one NUL byte) away from grouping every lane together.
  const byLane = new Map<string, { lane: string; pipeline: 'grok' | 'old-core'; rows: CallRow[] }>();
  for (const c of calls) {
    const key = `${c.agent_used}::${c.pipeline}`;
    const entry = byLane.get(key);
    if (entry) entry.rows.push(c);
    else byLane.set(key, { lane: c.agent_used, pipeline: c.pipeline, rows: [c] });
  }

  const windows: LaneWindow[] = [];
  byLane.forEach(({ lane, pipeline, rows }) => {
    const toolCounts = rows
      .map((r) => r.tool_call_count)
      .filter((n): n is number => n !== null);
    windows.push({
      lane,
      pipeline,
      substantive: rows.length,
      barelyHeard: rows.filter((r) => r.caller_lines <= 1).length,
      ceilingReached: rows.filter(
        (r) => r.tool_call_count !== null && r.tool_call_count >= CEILING_PER_CALL_DISPATCHES,
      ).length,
      maxToolCalls: toolCounts.length ? Math.max(...toolCounts) : null,
      toolCountNull: rows.filter((r) => r.tool_call_count === null).length,
      dobRefused: rows.filter((r) => r.dob_refused).length,
      filed: filed ? rows.filter((r) => filed.has(r.call_sid)).length : null,
      longestUnfiledRun: filed ? longestUnfiledRun(rows, filed) : null,
    });
  });

  return windows.sort((a, b) => b.substantive - a.substantive);
}

export interface FleetAssessment {
  findings: Finding[];
  /** True when queue silence is explained by the after-hours agent absorbing. */
  closedOffice: boolean;
}

export function assessFleet(windows: LaneWindow[]): FleetAssessment {
  const queue = windows.filter((w) => (QUEUE_LANES as readonly string[]).includes(w.lane));
  const afterHours = windows.filter((w) => w.lane === AFTER_HOURS_LANE);
  const queueSubstantive = queue.reduce((n, w) => n + w.substantive, 0);
  const afterHoursSubstantive = afterHours.reduce((n, w) => n + w.substantive, 0);

  const closedOffice = isClosedOfficeShape(queueSubstantive, afterHoursSubstantive);

  const findings: Finding[] = [];

  if (closedOffice) {
    findings.push({
      severity: 'info',
      lane: 'fleet',
      headline: `queue lanes quiet (${queueSubstantive} substantive) while ${AFTER_HOURS_LANE} carries ${afterHoursSubstantive}`,
      detail:
        'This is the closed-office shape — a weekend or a holiday, with standing ' +
        'instruction 13 routing everything to the after-hours agent. It is NOT an ' +
        'outage: a real queue outage leaves the after-hours agent quiet too.',
    });
  }

  for (const w of windows) {
    const ceiling = assessCeiling(w);
    if (ceiling) findings.push(ceiling);

    const heard = assessBarelyHeard(w);
    if (heard) findings.push(heard);

    const filing = assessFiling(w);
    // A closed office explains an empty queue lane; do not also alarm on it.
    if (filing && !(closedOffice && filing.severity === 'alarm' && w.substantive <= 2)) {
      findings.push(filing);
    }
  }

  const order: Record<Severity, number> = { alarm: 0, watch: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, closedOffice };
}
