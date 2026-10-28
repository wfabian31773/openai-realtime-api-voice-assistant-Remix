/**
 * src/runtime/outbound/callingWindow.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN an outbound campaign may ring somebody, and HOW OFTEN. Pure: no
 * clock, no database, no Twilio. The dialer asks `mayDialNow` and gets
 * either a yes or the reason it may not, with the earliest moment it could.
 *
 * Ported from the 5Star outbound lane, which has dialled real patients
 * since 2026-08 (`shared/outbound-window.ts`, `shared/holidays.ts` there):
 * the window is read in PACIFIC time, never the server's, and federal
 * holidays plus the practice's own closures are skipped. What differs here
 * is that the window and the caps belong to the CAMPAIGN, because the
 * fleet will run more than one (operator, 2026-10-20: "this is not the
 * first time we will need outbound agents").
 *
 * Nothing in this module knows what a campaign is FOR. A rule that only
 * makes sense for one campaign belongs on that campaign's policy object.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export interface CallingWindow {
  /** First hour (0–23, Pacific) a call may start. */
  startHour: number;
  /** First hour (0–23, Pacific) a call may NOT start; 20 = nothing at or after 8 PM. */
  endHour: number;
  /** Days of the week (0 = Sunday … 6 = Saturday) calls may go out. */
  days: readonly number[];
  /** Skip federal holidays and the practice's own closures. */
  skipHolidays: boolean;
}

export interface AttemptCaps {
  /** Calls to one person per Pacific calendar day. */
  perDay: number;
  /** Calls to one person in any rolling seven days. */
  perWeek: number;
  /** Calls to one person, ever, for this campaign. */
  total: number;
  /** Hours that must pass after one attempt before the next. */
  minHoursBetween: number;
}

/** The shape the NPX outreach plan settled on (2026-10-20): 9am–8pm Pacific,
 * at most one attempt a day and three a week. A campaign may be stricter. */
export const DEFAULT_CALLING_WINDOW: Readonly<CallingWindow> = Object.freeze({
  startHour: 9,
  endHour: 20,
  days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  skipHolidays: true,
});

export const DEFAULT_ATTEMPT_CAPS: Readonly<AttemptCaps> = Object.freeze({
  perDay: 1,
  perWeek: 3,
  total: 3,
  minHoursBetween: 20,
});

// ── Pacific clock ───────────────────────────────────────────────────────────

export interface PacificParts {
  /** YYYY-MM-DD in Pacific time. */
  date: string;
  hour: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function pacificParts(at: Date): PacificParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
    weekday: WEEKDAY[get("weekday")] ?? 0,
  };
}

// ── Holidays ────────────────────────────────────────────────────────────────

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fixed-date federal holidays move to Friday on a Saturday, Monday on a Sunday. */
function observed(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const wd = d.getUTCDay();
  if (wd === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (wd === 0) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return iso(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
  return iso(last);
}

/**
 * The eleven federal holidays (observed) plus the day after Thanksgiving,
 * which the practice closes. Add a one-off closure to PRACTICE_CLOSURES.
 */
export function holidaysFor(year: number): string[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const dayAfter = new Date(`${thanksgiving}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  return [
    observed(year, 1, 1),
    // When January 1 falls on a Saturday the holiday is observed on the
    // Friday before, December 31 of THIS year (Codex P2 on #357). The filter
    // below drops this year's own New Year when it lands in the year before.
    observed(year + 1, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    lastWeekday(year, 5, 1),
    observed(year, 6, 19),
    observed(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
    observed(year, 11, 11),
    thanksgiving,
    iso(dayAfter),
    observed(year, 12, 25),
    ...PRACTICE_CLOSURES,
  ].filter((d) => d.startsWith(`${year}-`));
}

/** One-off practice closures, YYYY-MM-DD. Human-edited on purpose. */
export const PRACTICE_CLOSURES: readonly string[] = [];

export function isHoliday(pacificDate: string): boolean {
  const year = parseInt(pacificDate.slice(0, 4), 10);
  return holidaysFor(year).includes(pacificDate);
}

// ── The decision ────────────────────────────────────────────────────────────

export interface PriorAttempt {
  /** When the attempt was placed. */
  at: Date;
}

export type DialDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "outside_hours"
        | "closed_day"
        | "holiday"
        | "daily_cap"
        | "weekly_cap"
        | "total_cap"
        | "too_soon";
    };

/**
 * May this campaign ring this person at `now`? Pure. `attempts` is every
 * prior attempt THIS campaign made to this person, in any order.
 *
 * The window is checked before the caps so a "no" at 10 PM reads as the
 * window, not as a cap — the window is the rule that is about the law.
 */
export function mayDialNow(
  now: Date,
  attempts: readonly PriorAttempt[],
  window: CallingWindow = DEFAULT_CALLING_WINDOW,
  caps: AttemptCaps = DEFAULT_ATTEMPT_CAPS,
): DialDecision {
  const p = pacificParts(now);
  if (!window.days.includes(p.weekday)) return { ok: false, reason: "closed_day" };
  if (window.skipHolidays && PRACTICE_CLOSURES.includes(p.date)) return { ok: false, reason: "closed_day" };
  if (window.skipHolidays && isHoliday(p.date)) return { ok: false, reason: "holiday" };
  if (p.hour < window.startHour || p.hour >= window.endHour) {
    return { ok: false, reason: "outside_hours" };
  }

  if (attempts.length >= caps.total) return { ok: false, reason: "total_cap" };
  const today = attempts.filter((a) => pacificParts(a.at).date === p.date).length;
  if (today >= caps.perDay) return { ok: false, reason: "daily_cap" };
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = attempts.filter((a) => a.at.getTime() > weekAgo).length;
  if (thisWeek >= caps.perWeek) return { ok: false, reason: "weekly_cap" };
  const latest = Math.max(...attempts.map((a) => a.at.getTime()), -Infinity);
  if (now.getTime() - latest < caps.minHoursBetween * 60 * 60 * 1000) {
    return { ok: false, reason: "too_soon" };
  }
  return { ok: true };
}
