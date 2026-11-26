/**
 * server/observatory/funnelSettle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FUNNEL'S "KEPT" STAGE, WHEN 5STAR STOPPED SETTLING BOOKINGS.
 *
 * The SAGE funnel counts a booking as kept when 5Star's reconciler moves it to
 * `completed`. That reconciler stopped around 2026-10-21: from the week of
 * 2026-10-19 on, 0 bookings are `completed` and past bookings stay at
 * `entered_in_nextgen` (190, 80 and 123 in the three weeks after, measured
 * 2026-11-26). So the screen read "Kept 0" for weeks that had kept visits.
 *
 * The NextGen schedule mirror in the Console (`si_appointment_facts`) still
 * knows. Measured 2026-11-26 over the 12 weeks shown: 291 past AI-voice
 * bookings 5Star left unsettled carry their NextGen appointment id, and the
 * mirror holds all 291 (164 kept, 65 no-show, 41 cancelled, 23 moved). So a
 * past booking 5Star never settled is settled here from the mirror, by the
 * NextGen Bible's §2 order: kept > rescheduled > cancelled, and a past
 * appointment never kept is a no-show. A moved appointment's outcome lives on
 * its replacement, which the booking does not point to, so it stays
 * unsettled. A booking at an NPX partner clinic has no NextGen appointment;
 * 5Star's own partner fields settle it. The rest (257 bookings entered by
 * hand with no appointment id recorded; 5Star's patient id is not the
 * Console's person id, so they cannot be matched) stay unsettled. Unsettled
 * is shown as its own number, never folded into "not kept".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A past booking 5Star left unsettled. */
export interface StuckBooking {
  weekStart: string;
  appointmentId: string | null;
  /** 5Star's partner fields, set on a booking at an NPX partner clinic. */
  partnerOutcome?: string | null;
  partnerVisit?: string | null;
}

/** What the schedule mirror says about one appointment. */
export interface MirrorFact {
  appointmentId: string;
  isKept: boolean | null;
  isCancelled: boolean | null;
  isRescheduled: boolean | null;
}

export interface WeekSettlement {
  kept: number;
  noShow: number;
  cancelled: number;
  /** Past bookings neither 5Star nor the mirror can settle. */
  unsettled: number;
}

export type MirrorOutcome = 'kept' | 'no_show' | 'cancelled' | 'unsettled';

/** One appointment's outcome by the NextGen Bible's §2 order. */
export function mirrorOutcome(fact: MirrorFact | undefined): MirrorOutcome {
  if (!fact) return 'unsettled';
  if (fact.isKept === true) return 'kept';
  if (fact.isRescheduled === true) return 'unsettled';
  if (fact.isCancelled === true) return 'cancelled';
  if (fact.isKept === false) return 'no_show';
  return 'unsettled';
}

/** A partner-clinic booking's outcome from 5Star's own partner fields. */
export function partnerOutcome(s: StuckBooking): MirrorOutcome {
  if (s.partnerVisit === 'completed') return 'kept';
  switch (s.partnerOutcome) {
    case 'partner_report_received':
    case 'partner_reported_showed':
      return 'kept';
    case 'partner_reported_no_show':
      return 'no_show';
    case 'partner_reported_cancelled':
      return 'cancelled';
    default:
      return 'unsettled';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Appointment ids safe to send to the mirror as uuids. */
export function mirrorIds(stuck: StuckBooking[]): string[] {
  const ids = new Set<string>();
  for (const s of stuck) if (s.appointmentId && UUID.test(s.appointmentId)) ids.add(s.appointmentId.toLowerCase());
  return [...ids];
}

/**
 * Per week, the outcomes of the stuck bookings. `facts` is null when the
 * mirror could not be read; then every stuck booking is unsettled.
 */
export function settleStuckBookings(
  stuck: StuckBooking[],
  facts: MirrorFact[] | null,
): Map<string, WeekSettlement> {
  const byId = new Map<string, MirrorFact>();
  for (const f of facts ?? []) byId.set(f.appointmentId.toLowerCase(), f);
  const out = new Map<string, WeekSettlement>();
  for (const s of stuck) {
    const week = out.get(s.weekStart) ?? { kept: 0, noShow: 0, cancelled: 0, unsettled: 0 };
    const outcome: MirrorOutcome = s.appointmentId
      ? facts === null
        ? 'unsettled'
        : mirrorOutcome(byId.get(s.appointmentId.toLowerCase()))
      : partnerOutcome(s);
    if (outcome === 'kept') week.kept += 1;
    else if (outcome === 'no_show') week.noShow += 1;
    else if (outcome === 'cancelled') week.cancelled += 1;
    else week.unsettled += 1;
    out.set(s.weekStart, week);
  }
  return out;
}

/** The 5Star statuses that mean "settled"; anything else past its slot is stuck. */
export const SETTLED_STATUSES = ['completed', 'no_show', 'cancelled', 'pending_orphan_review'] as const;

/**
 * Past AI-voice bookings 5Star has not settled. The slot date is a Pacific
 * date, so "past" is before today in Pacific time.
 */
export const STUCK_BOOKINGS_SQL = `
SELECT date_trunc('week', ib.created_at)::date::text AS week_start,
       ib.nextgen_appointment_id AS appointment_id,
       ib.partner_outcome_status AS partner_outcome,
       ib.partner_visit_status AS partner_visit
  FROM internal_bookings ib
 WHERE ib.booked_by_name LIKE 'AI Voice Agent%'
   AND ib.status::text <> ALL($2::text[])
   AND ib.slot_date < (now() AT TIME ZONE 'America/Los_Angeles')::date
   AND ib.created_at >= date_trunc('week', NOW() - make_interval(weeks => $1::int))`;

/** The mirror's answer for those appointments. Read-only, by primary key. */
export const MIRROR_FACTS_SQL = `
SELECT f.appointment_id::text AS appointment_id, f.is_kept, f.is_cancelled, f.is_rescheduled
  FROM si_appointment_facts f
 WHERE f.appointment_id = ANY($1::uuid[])`;

type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface SettleDeps {
  fivestar: Query;
  /** null when the Console is not configured in this process. */
  console: Query | null;
}

export interface FunnelSettlement {
  byWeek: Map<string, WeekSettlement>;
  /** False when a booking needed the mirror and the mirror could not be read. */
  mirrorRead: boolean;
}

/**
 * The stuck bookings of the last `weeks` weeks, settled from the mirror where
 * they carry a NextGen appointment id and from 5Star's partner fields where
 * they were booked at a partner clinic. A mirror that is not configured or
 * fails leaves those bookings unsettled; it never fails the funnel.
 */
export async function settleTheStuckBookings(weeks: number, deps: SettleDeps): Promise<FunnelSettlement> {
  const { rows } = await deps.fivestar(STUCK_BOOKINGS_SQL, [weeks, [...SETTLED_STATUSES]]);
  const stuck: StuckBooking[] = rows.map((r: any) => ({
    weekStart: r.week_start,
    appointmentId: r.appointment_id ?? null,
    partnerOutcome: r.partner_outcome ?? null,
    partnerVisit: r.partner_visit ?? null,
  }));
  const ids = mirrorIds(stuck);
  let facts: MirrorFact[] | null = [];
  if (ids.length > 0) {
    if (!deps.console) facts = null;
    else {
      try {
        const res = await deps.console(MIRROR_FACTS_SQL, [ids]);
        facts = res.rows.map((r: any) => ({
          appointmentId: r.appointment_id,
          isKept: r.is_kept ?? null,
          isCancelled: r.is_cancelled ?? null,
          isRescheduled: r.is_rescheduled ?? null,
        }));
      } catch (err) {
        console.warn(`[observatory] funnel: the schedule mirror could not be read (${(err as Error)?.message ?? err}); stuck bookings stay unsettled`);
        facts = null;
      }
    }
  }
  return { byWeek: settleStuckBookings(stuck, facts), mirrorRead: facts !== null };
}
