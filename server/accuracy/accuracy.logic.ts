/**
 * server/accuracy/accuracy.logic.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ACCURACY CHECK: every number a screen shows, read twice.
 *
 * Operator, 2026-11-26: "We need to overhaul this project end to end via
 * validation and accuracy", and, asked whether to build a standing check,
 * "yes, build the accuracy check too".
 *
 * Each check reads ONE number two ways:
 *   - the SCREEN side calls the same function (or endpoint) the screen calls,
 *     so it sees exactly what the operator sees;
 *   - the TRUTH side reads the same fact from the source of record by an
 *     independent route (direct SQL on the table that records it, a stored
 *     independent measurement, or a different system).
 * If the two disagree by more than the check's tolerance, the screen is wrong.
 *
 * This file is pure: no database, no clock it does not take as an argument.
 * The wiring (pools, routes, the schedule, history) is in accuracy.ts.
 *
 * Why the screen side calls the screen's own code and never re-implements it:
 * a check that re-implements the screen's query proves only that the copy is
 * right. The Operations Monitor showed 0 calls on a day with 662 because it
 * read an in-memory list the runtime never writes; only a check that asks the
 * screen's own endpoint can see that.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type CheckStatus = 'pass' | 'fail' | 'unknown';

/** How a value is shown. 'percent' values are fractions (0.25 = 25%). */
export type Unit = 'count' | 'percent' | 'dollars' | 'minutes' | 'seconds';

/** One side of a comparison: a number, or null with the reason it is unknown. */
export interface Reading {
  value: number | null;
  /** Why the value is null, or anything a reader needs to interpret it. */
  note?: string;
}

/** The allowed difference. abs is in the check's unit; rel is a fraction of the truth. */
export interface Tolerance {
  abs?: number;
  rel?: number;
}

export interface AccuracyCheck<D> {
  /** Stable id, e.g. 'operations-monitor.calls-24h'. History is keyed on it. */
  id: string;
  /** The screen, as the menu names it. */
  screen: string;
  /** The widget, as the screen labels it. */
  widget: string;
  /** In plain words, what the widget's label claims. */
  claim: string;
  /** In plain words, where the truth is read from and why it is independent. */
  truthSource: string;
  unit: Unit;
  tolerance?: Tolerance;
  screenValue(deps: D): Promise<Reading>;
  truthValue(deps: D): Promise<Reading>;
}

export interface CheckResult {
  id: string;
  screen: string;
  widget: string;
  claim: string;
  truthSource: string;
  unit: Unit;
  status: CheckStatus;
  screenValue: number | null;
  truthValue: number | null;
  /** |screen - truth|, when both are known. */
  difference: number | null;
  /** The largest difference that still passes. */
  allowed: number | null;
  note: string;
  ms: number;
}

export interface AccuracyReport {
  ranAt: string;
  durationMs: number;
  counts: Record<CheckStatus, number>;
  results: CheckResult[];
}

/** A value is usable only when it is a finite number. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Compare a screen reading with a truth reading.
 *
 * - The truth unknown → unknown: nothing can be said about the screen.
 * - The screen unknown (null) → unknown: the screen did not answer.
 * - The screen not a finite number (NaN, Infinity) → FAIL: the screen would
 *   show "NaN" or "Infinity", which is wrong whatever the truth is.
 * - Otherwise pass when |screen − truth| ≤ max(abs, rel × |truth|).
 */
export function compare(
  screen: number | null | undefined,
  truth: number | null | undefined,
  tolerance: Tolerance = {},
): { status: CheckStatus; difference: number | null; allowed: number | null } {
  if (truth === null || truth === undefined || !isFiniteNumber(truth)) {
    return { status: 'unknown', difference: null, allowed: null };
  }
  if (screen === null || screen === undefined) {
    return { status: 'unknown', difference: null, allowed: null };
  }
  if (!isFiniteNumber(screen)) {
    return { status: 'fail', difference: null, allowed: null };
  }
  const allowed = Math.max(tolerance.abs ?? 0, (tolerance.rel ?? 0) * Math.abs(truth));
  const difference = Math.abs(screen - truth);
  // A hair of slack for floating point (0.1 + 0.2), never more.
  const status: CheckStatus = difference <= allowed + 1e-9 ? 'pass' : 'fail';
  return { status, difference, allowed };
}

/** A number as the screen would show it, for the plain-words note. */
export function formatValue(v: number | null, unit: Unit): string {
  if (v === null) return 'unknown';
  if (!Number.isFinite(v)) return String(v);
  switch (unit) {
    case 'percent':
      return `${(v * 100).toFixed(1)}%`;
    case 'dollars':
      return `$${v.toFixed(2)}`;
    case 'minutes':
      return `${v.toFixed(1)} min`;
    case 'seconds':
      return `${v.toFixed(1)} s`;
    default:
      return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  }
}

/** The one sentence a reader sees beside a result. */
export function describeResult(
  status: CheckStatus,
  screen: Reading,
  truth: Reading,
  unit: Unit,
  difference: number | null,
  allowed: number | null,
): string {
  const s = formatValue(screen.value, unit);
  const t = formatValue(truth.value, unit);
  if (truth.value === null || !isFiniteNumber(truth.value)) {
    return `The truth could not be read${truth.note ? `: ${truth.note}` : '.'}`;
  }
  if (screen.value === null) {
    return `The screen gave no value${screen.note ? `: ${screen.note}` : '.'} The truth is ${t}.`;
  }
  if (status === 'fail' && difference === null) {
    return `The screen would show ${s}, which is not a number. The truth is ${t}.`;
  }
  const tail = [screen.note, truth.note].filter(Boolean).join(' ');
  if (status === 'pass') {
    return `The screen shows ${s}; the truth is ${t}.${tail ? ` ${tail}` : ''}`;
  }
  return `The screen shows ${s}, but the truth is ${t} (off by ${formatValue(difference, unit)}; allowed ${formatValue(allowed, unit)}).${tail ? ` ${tail}` : ''}`;
}

/** A failed read's message, without anything a row might carry. */
export function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

/** Resolve within ms, or reject with a timeout. Never leaves the timer running. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read one side; a throw or a timeout becomes an unknown reading with the reason. */
async function readSide<D>(
  fn: (deps: D) => Promise<Reading>,
  deps: D,
  timeoutMs: number,
  label: string,
): Promise<Reading> {
  try {
    const r = await withTimeout(fn(deps), timeoutMs, label);
    return r ?? { value: null, note: `${label} returned nothing` };
  } catch (err) {
    return { value: null, note: `${label} failed: ${safeError(err)}` };
  }
}

/** Run one check. Never throws. */
export async function runCheck<D>(
  check: AccuracyCheck<D>,
  deps: D,
  opts: { timeoutMs: number; clock?: () => number },
): Promise<CheckResult> {
  const clock = opts.clock ?? (() => Date.now());
  const started = clock();
  const [screen, truth] = await Promise.all([
    readSide(check.screenValue, deps, opts.timeoutMs, 'the screen read'),
    readSide(check.truthValue, deps, opts.timeoutMs, 'the truth read'),
  ]);
  const { status, difference, allowed } = compare(screen.value, truth.value, check.tolerance);
  return {
    id: check.id,
    screen: check.screen,
    widget: check.widget,
    claim: check.claim,
    truthSource: check.truthSource,
    unit: check.unit,
    status,
    screenValue: screen.value,
    truthValue: truth.value,
    difference,
    allowed,
    note: describeResult(status, screen, truth, check.unit, difference, allowed),
    ms: clock() - started,
  };
}

const STATUS_ORDER: Record<CheckStatus, number> = { fail: 0, unknown: 1, pass: 2 };

/** Failures first, then unknowns, then passes; within each, by screen then widget. */
export function sortResults(results: CheckResult[]): CheckResult[] {
  return [...results].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.screen.localeCompare(b.screen) ||
      a.widget.localeCompare(b.widget),
  );
}

/** Run every check, a few at a time. Never throws. */
export async function runChecks<D>(
  checks: readonly AccuracyCheck<D>[],
  deps: D,
  opts: { timeoutMs?: number; concurrency?: number; now?: () => Date; clock?: () => number } = {},
): Promise<AccuracyReport> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const clock = opts.clock ?? (() => Date.now());
  const ranAt = (opts.now ?? (() => new Date()))().toISOString();
  const started = clock();
  const results: CheckResult[] = new Array(checks.length);
  let next = 0;
  const worker = async () => {
    while (next < checks.length) {
      const i = next++;
      results[i] = await runCheck(checks[i], deps, { timeoutMs, clock });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, checks.length) }, worker));
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status]++;
  return { ranAt, durationMs: clock() - started, counts, results: sortResults(results) };
}

/**
 * A cached runner: a report younger than ttlMs is reused, a forced refresh
 * younger than minRefreshMs is refused (so a button cannot hammer production),
 * and two callers at once share one run.
 */
export function createAccuracyRunner<D>(opts: {
  checks: () => readonly AccuracyCheck<D>[];
  deps: () => D;
  ttlMs?: number;
  minRefreshMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => Date;
  onReport?: (report: AccuracyReport) => void | Promise<void>;
}) {
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const minRefreshMs = opts.minRefreshMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  let last: AccuracyReport | null = null;
  let lastAt = 0;
  let inFlight: Promise<AccuracyReport> | null = null;

  const run = (): Promise<AccuracyReport> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const report = await runChecks(opts.checks(), opts.deps(), {
          timeoutMs: opts.timeoutMs,
          concurrency: opts.concurrency,
          now,
        });
        last = report;
        lastAt = now().getTime();
        try {
          await opts.onReport?.(report);
        } catch (err) {
          console.warn(`[ACCURACY] could not store the report: ${safeError(err)}`);
        }
        return report;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    /** The latest report, running the checks when there is none or it is stale (or forced and old enough). */
    async report(force = false): Promise<AccuracyReport> {
      const age = now().getTime() - lastAt;
      if (last && !force && age < ttlMs) return last;
      if (last && force && age < minRefreshMs) return last;
      return run();
    },
    last: (): AccuracyReport | null => last,
  };
}
