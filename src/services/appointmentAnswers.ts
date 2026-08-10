/**
 * "When was my last appointment?" — answered, not turned into a ticket.
 *
 * Operator, 2026-08-10: "when there's something as simple as when was my last
 * appointment? That should be the easiest thing. That's the lowest hanging
 * fruit… When you got the patients table, we can't get past the intro."
 *
 * He is right, and the old answering service did answer it: "I see your last
 * appointment was on Monday, July 20, 2026, at the Mission Viejo location with
 * Dr. Jennie Tran." The new line filed an appointment REQUEST instead, which
 * is both useless to the caller and misleading — they hang up thinking staff
 * will call them about booking something.
 *
 * This is deliberately only a READ. It books nothing, changes nothing, and
 * cancels nothing; the line still cannot schedule and still says so.
 *
 * The join is the whole point of verifying against the person mirror. Once
 * verification returns a person_id, appointments come back by PersonID — no
 * name matching, no date-of-birth matching, no fuzzy anything. The identity
 * question is asked once, against the person base, and everything downstream
 * keys off the answer.
 */
import { and, desc, asc, eq, gte, lt, ne } from 'drizzle-orm';
import { schedule } from '../../shared/schema';

// server/db is imported LAZILY, inside the lookup. At module scope it runs
// environment validation on import, which would make every file that merely
// wants to format a date — the ticket agent among them — refuse to load
// without a DATABASE_URL. A formatting helper must not drag a database in.

export interface AppointmentFact {
  /** ISO date, as stored. */
  date: string;
  /** "1530" as Twilio-speakable "3:30 PM", or null when not recorded. */
  time: string | null;
  provider: string | null;
  office: string | null;
}

export interface AppointmentAnswer {
  last: AppointmentFact | null;
  next: AppointmentFact | null;
}

/**
 * "Removed" is a cancelled or deleted slot — 202,878 of them. Reading one back
 * as "your last appointment" would tell a patient they were seen on a day they
 * were not. "NoShow" is kept: it did not happen, but it is a real thing on
 * their record, and a patient asking when they were last in is better served
 * by the truth than by silence.
 */
const REMOVED = 'Removed';

/** 0800 -> "8:00 AM". Returns null for anything that is not four digits. */
export function speakTime(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}$/.test(s)) return null;
  const h = Number(s.slice(0, 2));
  const m = s.slice(2);
  if (h > 23 || Number(m) > 59) return null;
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m} ${suffix}`;
}

/** 2026-07-13 -> "Monday, July 13". The year is only said when it is not this one. */
export function speakDate(iso: string, today = new Date()): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const base: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' };
  const opts =
    d.getUTCFullYear() === today.getUTCFullYear() ? base : { ...base, year: 'numeric' as const };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

function toFact(r: Record<string, any>): AppointmentFact {
  return {
    date: String(r.appointmentDate),
    time: speakTime(r.appointmentStart),
    provider: (r.renderingPhysician ?? r.providerFromAppt ?? null) || null,
    office: (r.officeLocation ?? null) || null,
  };
}

/**
 * The caller's last completed and next upcoming appointment.
 *
 * Never throws: a caller is on the line, and a failed lookup must fall back to
 * taking a message, not to an error.
 */
export async function appointmentsForPerson(personId: string): Promise<AppointmentAnswer> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { db } = await import('../../server/db');
    const [past, upcoming] = await Promise.all([
      db
        .select()
        .from(schedule)
        .where(
          and(
            eq(schedule.personId, personId),
            ne(schedule.appointmentStatus, REMOVED),
            lt(schedule.appointmentDate, today),
          ),
        )
        .orderBy(desc(schedule.appointmentDate))
        .limit(1),
      db
        .select()
        .from(schedule)
        .where(
          and(
            eq(schedule.personId, personId),
            ne(schedule.appointmentStatus, REMOVED),
            gte(schedule.appointmentDate, today),
          ),
        )
        .orderBy(asc(schedule.appointmentDate))
        .limit(1),
    ]);
    return {
      last: past[0] ? toFact(past[0] as Record<string, any>) : null,
      next: upcoming[0] ? toFact(upcoming[0] as Record<string, any>) : null,
    };
  } catch (e) {
    console.error('[APPTS] lookup failed — the caller gets a message taken instead:', e);
    return { last: null, next: null };
  }
}

/**
 * One sentence a caller can act on. Provider and office are included only when
 * we actually have them — "with null at null" is how a real system sounds when
 * nobody checked.
 */
export function describeAppointment(f: AppointmentFact, today = new Date()): string {
  const bits = [speakDate(f.date, today)];
  // Belt and braces: the stored form is "1530" and a caller must never hear
  // "at fifteen thirty". If a raw one reaches here it is converted, and if it
  // cannot be converted the time is dropped rather than read out wrong.
  const time = f.time && /^\d{4}$/.test(f.time) ? speakTime(f.time) : f.time;
  if (time) bits.push(`at ${time}`);
  const where: string[] = [];
  if (f.provider) where.push(`with ${f.provider}`);
  if (f.office) where.push(`at our ${f.office} office`);
  return [bits.join(' '), where.join(' ')].filter(Boolean).join(' ');
}
