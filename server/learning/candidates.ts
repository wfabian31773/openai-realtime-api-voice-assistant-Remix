/**
 * Stage C, step 3 — candidate detection.
 *
 * A metric whose newest value falls outside the band of its own trailing
 * baseline becomes a CANDIDATE: a fingerprint for a human (or Claude) to look
 * at, never a finding. Nothing here opens, confirms or closes a learning
 * record — the register is the lifecycle authority — and candidates are
 * computed on read, never stored.
 *
 * The shape is taken from the closed vocabulary (vocab.json, a mirror of
 * ai-bridge learning/vocab.json held to it by a parity test) only where one
 * clearly fits; anything else carries no shape and is classified by a person.
 */
import vocab from "./vocab.json";

export interface StoredValue {
  run_date: string;
  method_version: string;
  metric_id: string;
  repo: string;
  lane: string;
  runtime_marker: string;
  numerator: number;
  denominator: number;
  unknown_count: number;
}

export interface Candidate {
  fingerprint: string;
  metricId: string;
  repo: string;
  lane: string;
  day: string;
  rate: number;
  baselineMean: number;
  baselineSd: number;
  baselineDays: number;
  direction: "down" | "up";
  shape: string | null;
}

/** Only shapes that are the plain reading of the metric. */
export const METRIC_SHAPES: Record<string, string> = {
  "remix.filed_rate": "lost-request-no-ticket",
  "remix.filed_rate_independent": "lost-request-no-ticket",
};

export const BASELINE_DAYS = 14;
export const MIN_BASELINE_DAYS = 7;
export const MIN_DENOMINATOR = 20;
export const BAND_SD = 3;
/** A band narrower than this is noise from a perfectly flat baseline. */
export const MIN_BAND = 0.05;

export function knownShapes(): string[] {
  return Object.keys((vocab as { shapes: Record<string, string> }).shapes);
}

export function detectCandidates(values: StoredValue[]): Candidate[] {
  // Fold builds together per day: a candidate is about the lane, and the
  // build split is read beside it, not instead of it. One method version only.
  const series = new Map<string, Map<string, { n: number; d: number }>>();
  for (const v of values) {
    const k = `${v.method_version}|${v.repo}|${v.metric_id}|${v.lane}`;
    const days = series.get(k) ?? new Map();
    const cur = days.get(v.run_date) ?? { n: 0, d: 0 };
    cur.n += Number(v.numerator);
    cur.d += Number(v.denominator);
    days.set(v.run_date, cur);
    series.set(k, days);
  }
  const out: Candidate[] = [];
  for (const [k, days] of series) {
    const [, repo, metricId, lane] = k.split("|");
    const ordered = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
    const last = ordered[ordered.length - 1];
    if (!last || last[1].d < MIN_DENOMINATOR) continue;
    const base = ordered.slice(0, -1).slice(-BASELINE_DAYS).filter(([, x]) => x.d >= MIN_DENOMINATOR);
    if (base.length < MIN_BASELINE_DAYS) continue;
    const rates = base.map(([, x]) => x.n / x.d);
    const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
    const sd = Math.sqrt(rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length);
    const band = Math.max(BAND_SD * sd, MIN_BAND);
    const rate = last[1].n / last[1].d;
    if (Math.abs(rate - mean) <= band) continue;
    const direction = rate < mean ? "down" : "up";
    out.push({
      fingerprint: `${metricId}:${lane}:${direction}`,
      metricId,
      repo,
      lane,
      day: last[0],
      rate: round(rate),
      baselineMean: round(mean),
      baselineSd: round(sd),
      baselineDays: base.length,
      direction,
      shape: direction === "down" ? METRIC_SHAPES[metricId] ?? null : null,
    });
  }
  return out.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
