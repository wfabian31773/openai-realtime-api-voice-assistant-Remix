/**
 * Stage C, step 3 — computing one day's metrics from the definitions.
 *
 * Every database is reached through an injected `Query`, so the same code runs
 * against the real read-only pools in production and against fixtures in the
 * tests. A source that is not configured, or that fails, makes ITS metrics
 * unavailable with the reason in the run notes — it never becomes a zero.
 */
import {
  CONSOLE_BOOKED_SQL,
  FIRM_PARTNER_LINK_METHODS,
  FIVESTAR_BOOKINGS_SQL,
  FIVESTAR_CALLS_SQL,
  FIVESTAR_INBOUND_LANE,
  NPX_BOOKED_STATUSES,
  REMIX_CALLS_SQL,
  SUPPORT_PROVENANCE_SQL,
  type MetricId,
} from "./definitions";

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface MetricValue {
  metricId: MetricId;
  repo: "Remix" | "5Star";
  lane: string;
  /** Remix: call_logs.runtime_marker. 5Star: the function's build (call_logs.build_id). '' = unknown. */
  runtimeMarker: string;
  numerator: number;
  denominator: number;
  unknownCount: number;
}

export interface DayResult {
  values: MetricValue[];
  /** metric id -> why it was not computed. */
  unavailable: Record<string, string>;
}

export interface Sources {
  hub: Query;
  /** The Support Center through its plugin API (metrics:read token). Absent until the token is set. */
  supportCenter?: Query;
  fivestar?: Query;
  console?: Query;
  /** Whether the Hub's optional runtime_marker column exists (read once by the runner). */
  hubHasRuntimeMarker: boolean;
}

function key(lane: string, marker: string): string {
  return `${lane}\u0000${marker}`;
}

function bump(map: Map<string, MetricValue>, base: Omit<MetricValue, "numerator" | "denominator" | "unknownCount">, n: number, d: number, u = 0) {
  const k = key(base.lane, base.runtimeMarker);
  const v = map.get(k) ?? { ...base, numerator: 0, denominator: 0, unknownCount: 0 };
  v.numerator += n;
  v.denominator += d;
  v.unknownCount += u;
  map.set(k, v);
}

const SID_CHUNK = 500;

export async function computeRemix(day: string, src: Sources): Promise<DayResult> {
  const unavailable: Record<string, string> = {};
  const sql = REMIX_CALLS_SQL.replace("%MARKER%", src.hubHasRuntimeMarker ? "runtime_marker" : "NULL::text");
  const { rows } = await src.hub(sql, [day]);

  const filed = new Map<string, MetricValue>();
  for (const r of rows) {
    bump(filed, { metricId: "remix.filed_rate", repo: "Remix", lane: r.lane, runtimeMarker: r.runtime_marker }, r.filed ? 1 : 0, 1);
  }

  const values = [...filed.values()];

  if (!src.supportCenter) {
    unavailable["remix.filed_rate_independent"] = "Support Center plugin token (LEARNING_SUPPORT_CENTER_TOKEN) not configured";
  } else {
    try {
      const prov = new Map<string, { agent: boolean; unknown: boolean }>();
      const sids = rows.map((r) => r.call_sid as string);
      for (let i = 0; i < sids.length; i += SID_CHUNK) {
        const res = await src.supportCenter(SUPPORT_PROVENANCE_SQL, [sids.slice(i, i + SID_CHUNK)]);
        for (const p of res.rows) prov.set(p.call_sid, { agent: !!p.any_agent, unknown: !!p.any_unknown });
      }
      const ind = new Map<string, MetricValue>();
      for (const r of rows) {
        const p = prov.get(r.call_sid);
        // agent > UNKNOWN > staff, per call (CLAUDE.md, the filing test).
        const agent = !!p?.agent;
        const unknown = !agent && !!p?.unknown;
        bump(
          ind,
          { metricId: "remix.filed_rate_independent", repo: "Remix", lane: r.lane, runtimeMarker: r.runtime_marker },
          agent ? 1 : 0,
          1,
          unknown ? 1 : 0,
        );
      }
      values.push(...ind.values());
    } catch (e) {
      unavailable["remix.filed_rate_independent"] = `Support Center read failed: ${(e as Error).message}`;
    }
  }
  return { values, unavailable };
}

interface BookingRow {
  call_log_id: string;
  booking_id: string;
  status: string;
  source: string;
  nextgen_appointment_id: string | null;
  person_id: string | null;
  slot_date: string | null;
  slot_time: string;
  npx_link_method: string | null;
  partner_link_needs_review: boolean | null;
  partner_outcome_status: string | null;
}

/** isFirmPartnerLink + the Daybook's NPX status rule. */
export function npxBooked(b: BookingRow): boolean {
  if (b.status === "cancelled") return false;
  if (b.partner_link_needs_review) return false;
  if (!(FIRM_PARTNER_LINK_METHODS as readonly string[]).includes((b.npx_link_method ?? "").trim())) return false;
  return (NPX_BOOKED_STATUSES as readonly string[]).includes(b.partner_outcome_status ?? "");
}

export async function computeFivestar(day: string, src: Sources): Promise<DayResult> {
  const ids: MetricId[] = ["5star.submitted_rate_a", "5star.booked_rate_a", "5star.booked_rate_b"];
  const unavailable: Record<string, string> = {};
  if (!src.fivestar) {
    for (const id of ids) unavailable[id] = "5Star read-only connection not configured";
    return { values: [], unavailable };
  }
  const { rows: calls } = await src.fivestar(FIVESTAR_CALLS_SQL, [day]);

  const base = (metricId: MetricId, build: string) => ({ metricId, repo: "5Star" as const, lane: FIVESTAR_INBOUND_LANE, runtimeMarker: build });
  const submitted = new Map<string, MetricValue>();
  for (const c of calls) if (c.substantive) bump(submitted, base("5star.submitted_rate_a", c.build), c.submitted ? 1 : 0, 1);
  const values = [...submitted.values()];

  // Booked: every substantive call is looked up. Submission is a separate,
  // non-independent signal; a booking whose notes lost REQUEST_SUBMITTED (a
  // failed write-back) still counts (Codex, #365: 2 such calls 10-01..10-22).
  const candidates = calls.filter((c) => c.substantive);
  const bookedCalls = new Set<string>();
  if (!src.console) {
    unavailable["5star.booked_rate_a"] = "Patient Console connection not configured";
    unavailable["5star.booked_rate_b"] = "Patient Console connection not configured";
    return { values, unavailable };
  }
  try {
    const bookings: BookingRow[] = candidates.length
      ? (await src.fivestar(FIVESTAR_BOOKINGS_SQL, [candidates.map((c) => c.id)])).rows
      : [];
    const toMirror: Array<Record<string, string | null>> = [];
    for (const b of bookings) {
      if (b.source === "npx") {
        if (npxBooked(b)) bookedCalls.add(b.call_log_id);
        continue;
      }
      if (b.status === "cancelled" || !b.slot_date) continue;
      if (!b.nextgen_appointment_id && !b.person_id) continue; // cannot be checked: not booked
      toMirror.push({
        k: `${b.call_log_id}|${b.booking_id}`,
        appointment_id: b.nextgen_appointment_id,
        person_id: b.person_id,
        slot_date: b.slot_date,
        slot_time: b.slot_time,
        since: day,
      });
    }
    if (toMirror.length) {
      const res = await src.console(CONSOLE_BOOKED_SQL, [JSON.stringify(toMirror)]);
      for (const r of res.rows) bookedCalls.add(String(r.k).split("|")[0]);
    }
  } catch (e) {
    const why = `booking read failed: ${(e as Error).message}`;
    unavailable["5star.booked_rate_a"] = why;
    unavailable["5star.booked_rate_b"] = why;
    return { values, unavailable };
  }

  const a = new Map<string, MetricValue>();
  const b = new Map<string, MetricValue>();
  for (const c of calls) {
    if (!c.substantive) continue;
    const booked = bookedCalls.has(c.id) ? 1 : 0;
    bump(a, base("5star.booked_rate_a", c.build), booked, 1);
    if (c.asked) bump(b, base("5star.booked_rate_b", c.build), booked, 1);
  }
  values.push(...a.values(), ...b.values());
  return { values, unavailable };
}

/** Deterministic order, so the same inputs always hash the same. */
export function sortValues(values: MetricValue[]): MetricValue[] {
  return [...values].sort((x, y) =>
    x.metricId.localeCompare(y.metricId) || x.lane.localeCompare(y.lane) || x.runtimeMarker.localeCompare(y.runtimeMarker),
  );
}
