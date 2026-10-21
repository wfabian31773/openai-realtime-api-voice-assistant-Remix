/**
 * src/runtime/outbound/consoleMovable.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOVABLE LIST, READ LIVE FROM THE PATIENT CONSOLE.
 *
 * Operator, 2026-10-21: "create a direct connection to the eye care patient
 * console where the movable list is located so it is always fresh."
 *
 * The list lives in the Console (`kbbmywvasbsxnbblrhot`): the Capacity
 * rebuild writes `capacity_movable_cache` once an hour — every booked
 * appointment that could move to an NPX partner, and whether a partner can
 * reach the patient (`in_reach`) — and the Console's own worklist joins that
 * cache to the LIVE appointment table and `patients_master` on every read,
 * so a cancellation or a reschedule leaves the list the moment it lands
 * (0117, 0132). This module reads it exactly that way, over the read-only
 * Console connection the voice app already holds (`OBS_CONSOLE_DATABASE_URL`,
 * role `observatory_ro`: SELECT and BYPASSRLS, measured 2026-10-21). It
 * cannot call `capacity_movable_worklist` itself — that function is granted
 * to service_role only — so it runs the same joins the function runs. No
 * copy of the list is taken anywhere: there is no import file, no nightly
 * job, nothing to go stale.
 *
 * TWO READS, BOTH LIVE:
 *   list(today)      the in-reach, still-booked movable appointments — what
 *                    the campaign may call about right now
 *   current(id)      ONE appointment, re-checked at the moment of the dial:
 *                    still booked, still movable, still in reach, and the
 *                    phone the person base holds for them today
 *
 * The person base is the source of the phone and the date of birth (RULE
 * ZERO: `patients_master` says who somebody is). Cell first, home second,
 * because a text confirmation follows a booking.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ContactSource, SourceContact } from "./campaign";

/** One movable appointment, as the campaign calls about it. */
export interface MovableAppointment {
  appointmentId: string;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD, from `patients_master`. */
  dateOfBirth: string | null;
  /** E.164, cell first then home; null when neither is a US number. */
  phone: string | null;
  /** YYYY-MM-DD. */
  appointmentDate: string;
  beginTime: string | null;
  office: string;
  eventName: string;
  providerName: string | null;
  /** NPX partners who could take this appointment. */
  partners: string[];
  /** When the Console last rebuilt the movable list. */
  builtAt: Date | null;
}

export interface MovableReader {
  /** Every in-reach, still-booked movable appointment from `today` on. */
  list(today: string): Promise<MovableAppointment[]>;
  /** One appointment, if it is STILL booked, movable and in reach. */
  current(appointmentId: string, today: string): Promise<MovableAppointment | null>;
  /** Whether the appointment is OVER as a reason to call — cancelled or
   * moved in NextGen, its date passed, or gone from the appointment table —
   * as opposed to merely off the movable list for now. */
  isOver(appointmentId: string, today: string): Promise<boolean>;
}

/** Ten US digits as E.164, or null. */
export function e164(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `+1${ten}` : null;
}

function isoDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Pure, so the mapping is tested without a database. */
export function rowToMovable(r: Record<string, unknown>): MovableAppointment {
  return {
    appointmentId: String(r.appointment_id),
    personId: String(r.person_id),
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    dateOfBirth: isoDate(r.date_of_birth),
    phone: e164(r.cell_phone) ?? e164(r.home_phone),
    appointmentDate: isoDate(r.appointment_date) ?? "",
    beginTime: (r.begin_time as string | null) ?? null,
    office: String(r.office ?? ""),
    eventName: String(r.event_name ?? ""),
    providerName: (r.provider_name as string | null) ?? null,
    partners: Array.isArray(r.partners) ? (r.partners as unknown[]).map(String) : [],
    builtAt: r.built_at ? new Date(r.built_at as string) : null,
  };
}

/**
 * The movable list's own query: the hourly cache joined to the live
 * appointment row and the live person row, exactly as the Console's
 * `capacity_movable_worklist` joins them (0132), in-reach only, from today.
 * One fixed statement with bound parameters, so it costs the Console one
 * plan and one `pg_stat_statements` entry however often it runs.
 */
export const MOVABLE_SELECT = `
  select r.appointment_id, r.person_id, pm.first_name, pm.last_name, pm.date_of_birth,
         pm.cell_phone, pm.home_phone, f.appointment_date, f.begin_time, r.office,
         f.event_name, r.provider_name, r.partners, r.built_at
    from public.capacity_movable_cache r
    join public.si_appointment_facts f on f.appointment_id = r.appointment_id
    join public.patients_master pm on pm.person_id = r.person_id
   where r.in_reach
     and not coalesce(f.is_cancelled, false)
     and not coalesce(f.is_rescheduled, false)
     and f.appointment_date >= $1::date`;

type Query = (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** The reader over any query function — the production pool, or a test's. */
export function movableReader(query: Query): MovableReader {
  return {
    async list(today) {
      const { rows } = await query(`${MOVABLE_SELECT}\n   order by f.appointment_date, f.begin_time, r.appointment_id`, [today]);
      return rows.map(rowToMovable);
    },
    async current(appointmentId, today) {
      const { rows } = await query(`${MOVABLE_SELECT}\n     and r.appointment_id = $2::uuid`, [today, appointmentId]);
      return rows[0] ? rowToMovable(rows[0]) : null;
    },
    async isOver(appointmentId, today) {
      const { rows } = await query(
        `select coalesce(is_cancelled, false) or coalesce(is_rescheduled, false)
                or appointment_date < $2::date as over
           from public.si_appointment_facts where appointment_id = $1::uuid`,
        [appointmentId, today],
      );
      // An appointment the mirror no longer holds at all is over too.
      return rows.length === 0 || rows[0].over === true;
    },
  };
}

let pool: { query: Query } | null = null;

/**
 * The production reader, on its own small pool: read-only at the session as
 * well as by role, and bounded, so a slow Console can never hold a dial. Its
 * own pool rather than the verification one, for the reason that one gives:
 * a campaign read queueing ahead of a live caller's lookup is not a trade
 * worth making. Null when the Console is not configured in this process.
 */
export async function consoleMovableReader(
  env: Record<string, string | undefined> = process.env,
): Promise<MovableReader | null> {
  const url = env.OBS_CONSOLE_DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    const pg = (await import("pg")).default;
    const p = new pg.Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
      options: "-c default_transaction_read_only=on -c statement_timeout=8000",
    });
    p.on("error", (e: Error) => console.error("[outbound] console pool error:", e.message));
    pool = { query: (text, values) => p.query(text, values) as Promise<{ rows: Record<string, unknown>[] }> };
  }
  return movableReader(pool.query);
}

// ── As a campaign's live contact source (dialer.refreshFromSource) ──────────

export const CONSOLE_MOVABLE_SOURCE = "the Console's movable list";
/** How often the queue is refreshed. The full read is ~1.8 s cold
 * (measured 2026-10-21, 1,183 rows), so not every minute. */
export const MOVABLE_REFRESH_MS = 15 * 60 * 1000;
/** How long a row that left the list waits: the Console rebuilds hourly. */
export const MOVABLE_PARK_MS = 60 * 60 * 1000;

/** Today in Pacific time, YYYY-MM-DD — the practice's day, not the server's. */
export function pacificToday(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** One movable appointment as a queue row. The date of birth goes under
 * `date_of_birth`, where a returned call's identity check reads it. */
export function movableToContact(m: MovableAppointment): SourceContact {
  return {
    externalRef: m.appointmentId,
    phone: m.phone,
    firstName: m.firstName,
    lastName: m.lastName,
    data: {
      source: "console_movable",
      appointment_id: m.appointmentId,
      person_id: m.personId,
      date_of_birth: m.dateOfBirth,
      appointment_date: m.appointmentDate,
      begin_time: m.beginTime,
      office: m.office,
      event_name: m.eventName,
      provider_name: m.providerName,
      partners: m.partners,
    },
  };
}

/** The movable list as a campaign's contact source. */
export function consoleMovableSource(reader: MovableReader): ContactSource {
  return {
    name: CONSOLE_MOVABLE_SOURCE,
    refreshEveryMs: MOVABLE_REFRESH_MS,
    parkMs: MOVABLE_PARK_MS,
    async list(now) {
      return (await reader.list(pacificToday(now))).map(movableToContact);
    },
    async recheck(appointmentId, now) {
      const today = pacificToday(now);
      const live = await reader.current(appointmentId, today);
      if (live) return { state: "current", contact: movableToContact(live) };
      return (await reader.isOver(appointmentId, today)) ? { state: "gone" } : { state: "off_list" };
    },
  };
}

/** For a lane's `OutboundLanePolicy.source`: the live movable list over the
 * read-only Console connection, or null where the Console is not configured
 * (and the campaign then does not dial). */
export async function consoleMovableContactSource(): Promise<ContactSource | null> {
  const reader = await consoleMovableReader();
  return reader ? consoleMovableSource(reader) : null;
}
