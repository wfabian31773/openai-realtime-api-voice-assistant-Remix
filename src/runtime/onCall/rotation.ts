/**
 * WHO IS ON CALL — the weekly after-hours rotation, as pure functions.
 *
 * Operator, 2026-11-22, for go-live on 2026-12-01: "The weekly rotation runs
 * Tuesday 5:00 PM PT to the next Tuesday 8:00 AM PT. Weekday daytime hours
 * are not on-call." The rotation itself lives in the Hub's on_call_* tables
 * (migrations/add_on_call_rotation.sql) so Wayne can enter swaps and new
 * providers without a deploy; this module only reads what the store hands it.
 *
 * Three rules decide a moment:
 *
 *   1. THE WEEK. A week starts on a Tuesday at 17:00 Pacific. Any moment
 *      before that on a Tuesday belongs to the previous Tuesday's week, so at
 *      Tue 4:59 PM the outgoing provider is still the week's provider.
 *   2. THE WINDOW. Inside the week, Monday to Friday 08:00 to 16:59 Pacific is
 *      not on call (the offices are open). Weekends and nights are on call. A
 *      weekday the practice is closed for a holiday is on call all day, and is
 *      marked `holiday_daytime` so the alert and the log say why. A holiday the
 *      practice keeps open (Columbus Day, Veterans Day) is an ordinary weekday.
 *      "Holidays rotate like any other day": no holiday changes WHO is on call.
 *   3. OVERRIDES. An override row (a swap or cover for a window) decides WHO
 *      for the moments it covers; it never decides WHETHER. The override with
 *      the latest start wins when two overlap.
 *
 * Then the chain: the on-call provider (or a post-op patient's surgeon), then
 * that provider's region director, then FINAL (Dr. Logan). A provider never
 * appears twice, so San Diego and Coachella Valley, whose director IS the
 * final director, go straight from the on-call provider to Dr. Logan.
 */
import { isHoliday, practiceOpenHolidaysFor, PACIFIC_TIME_ZONE } from "../outbound/callingWindow";

// ── Data the store hands in ─────────────────────────────────────────────────

export interface OnCallProvider {
  id: number;
  fullName: string;
  /** Matches si_providers.npi on the Console. */
  npi: string | null;
  /** E.164. */
  phone: string;
  email?: string | null;
  region: string;
  rotationOrder: number | null;
  active: boolean;
}

export interface OnCallOverride {
  id: number;
  startsAt: Date;
  endsAt: Date;
  providerId: number;
}

export interface RotationData {
  providers: readonly OnCallProvider[];
  /** week_starts_on (YYYY-MM-DD, a Tuesday) -> provider id. */
  schedule: ReadonlyMap<string, number>;
  overrides: readonly OnCallOverride[];
  /** normalised region -> provider id; the key FINAL_REGION is Dr. Logan. */
  directors: ReadonlyMap<string, number>;
}

/** The directors row that is the last level of every chain. */
export const FINAL_REGION = "FINAL";

/** Region names are typed by hand in a CSV; compare them loosely. */
export function regionKey(region: string | null | undefined): string {
  return (region ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ── The Pacific clock, to the minute ────────────────────────────────────────

export interface PacificMinute {
  /** YYYY-MM-DD in Pacific time. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes since Pacific midnight, 0..1439. */
  minute: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function pacificMinute(at: Date): PacificMinute {
  const parts = FORMAT.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY[get("weekday")] ?? 0,
    minute: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10),
  };
}

/** A Pacific calendar date moved by whole days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 17:00 Pacific: a week starts and the weekday night begins. */
export const WEEK_STARTS_AT_MINUTE = 17 * 60;
/** 08:00 Pacific: weekday daytime begins. */
export const DAYTIME_STARTS_AT_MINUTE = 8 * 60;
const TUESDAY = 2;

/** The Tuesday (YYYY-MM-DD) whose rotation week this moment belongs to. */
export function rotationWeekStart(at: Date): string {
  const p = pacificMinute(at);
  if (p.weekday === TUESDAY && p.minute >= WEEK_STARTS_AT_MINUTE) return p.date;
  const back = (p.weekday - TUESDAY + 7) % 7 || 7;
  return addDays(p.date, -back);
}

export type WindowReason = "off_hours" | "weekday_daytime" | "holiday_daytime";

export interface OnCallWindow {
  onCall: boolean;
  reason: WindowReason;
}

/** A weekday the practice is closed for (a holiday it does not keep open). */
export function isClosedHoliday(pacificDate: string): boolean {
  if (!isHoliday(pacificDate)) return false;
  return !practiceOpenHolidaysFor(parseInt(pacificDate.slice(0, 4), 10)).includes(pacificDate);
}

export function onCallWindow(at: Date): OnCallWindow {
  const p = pacificMinute(at);
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const daytime = p.minute >= DAYTIME_STARTS_AT_MINUTE && p.minute < WEEK_STARTS_AT_MINUTE;
  if (!weekday || !daytime) return { onCall: true, reason: "off_hours" };
  if (isClosedHoliday(p.date)) return { onCall: true, reason: "holiday_daytime" };
  return { onCall: false, reason: "weekday_daytime" };
}

// ── Who ─────────────────────────────────────────────────────────────────────

export interface OnCallAnswer {
  window: OnCallWindow;
  weekStartsOn: string;
  /** The provider on call for this moment, or null when nobody is entered. */
  provider: OnCallProvider | null;
  source: "override" | "schedule" | "none";
  /**
   * Why there is no provider, or why the one returned is notable. An override
   * whose provider is gone or inactive falls back to the week's scheduled
   * provider and says so (`override_provider_*`), so a stale cover never
   * leaves the night with nobody.
   */
  note?:
    | "no_schedule_for_week"
    | "provider_inactive"
    | "provider_missing"
    | "override_provider_inactive"
    | "override_provider_missing";
  /** The provider's region director (null when the region has none). */
  director: OnCallProvider | null;
  /** Dr. Logan. */
  final: OnCallProvider | null;
}

function byId(data: RotationData, id: number | undefined): OnCallProvider | null {
  if (id === undefined) return null;
  return data.providers.find((p) => p.id === id) ?? null;
}

export function directorFor(region: string, data: RotationData): OnCallProvider | null {
  return byId(data, data.directors.get(regionKey(region)));
}

export function finalDirector(data: RotationData): OnCallProvider | null {
  return byId(data, data.directors.get(regionKey(FINAL_REGION)));
}

/** The override covering this moment; the latest start wins, then the latest id. */
export function activeOverride(at: Date, overrides: readonly OnCallOverride[]): OnCallOverride | null {
  const t = at.getTime();
  let best: OnCallOverride | null = null;
  for (const o of overrides) {
    if (!(o.startsAt.getTime() <= t && t < o.endsAt.getTime())) continue;
    if (
      !best ||
      o.startsAt.getTime() > best.startsAt.getTime() ||
      (o.startsAt.getTime() === best.startsAt.getTime() && o.id > best.id)
    ) {
      best = o;
    }
  }
  return best;
}

/**
 * The lookup the operator asked for: "given a timestamp, return the on-call
 * provider, their phone, their region, and that region's escalation
 * director." It answers for every moment; `window.onCall` says whether the
 * moment is an on-call one at all.
 */
export function onCallAt(at: Date, data: RotationData): OnCallAnswer {
  const window = onCallWindow(at);
  const weekStartsOn = rotationWeekStart(at);
  const final = finalDirector(data);
  const override = activeOverride(at, data.overrides);
  const scheduled = data.schedule.get(weekStartsOn);
  const answer = (
    provider: OnCallProvider,
    source: OnCallAnswer["source"],
    note?: OnCallAnswer["note"],
  ): OnCallAnswer => ({
    window,
    weekStartsOn,
    provider,
    source,
    ...(note ? { note } : {}),
    director: directorFor(provider.region, data),
    final,
  });
  const nobody = (source: OnCallAnswer["source"], note: NonNullable<OnCallAnswer["note"]>): OnCallAnswer => ({
    window,
    weekStartsOn,
    provider: null,
    source,
    note,
    director: null,
    final,
  });

  // A cover beats the schedule, but only a cover that can be rung. One whose
  // provider was deactivated, or is no longer on file, falls back to the
  // week's scheduled provider with a note, rather than leaving the window to
  // the directors alone.
  let overrideNote: "override_provider_inactive" | "override_provider_missing" | undefined;
  if (override) {
    const covering = byId(data, override.providerId);
    if (covering?.active) return answer(covering, "override");
    overrideNote = covering ? "override_provider_inactive" : "override_provider_missing";
  }
  if (scheduled === undefined) return nobody(override ? "override" : "none", overrideNote ?? "no_schedule_for_week");
  const provider = byId(data, scheduled);
  if (!provider) return nobody("schedule", overrideNote ?? "provider_missing");
  if (!provider.active) return nobody("schedule", overrideNote ?? "provider_inactive");
  return answer(provider, "schedule", overrideNote);
}

// ── The chain ───────────────────────────────────────────────────────────────

export type ChainRole = "on_call" | "surgeon" | "region_director" | "final";

export interface ChainLevel {
  role: ChainRole;
  providerId: number;
  name: string;
  /** The number this level rings and texts. The test phone in test mode. */
  phone: string;
}

export interface ChainPlan {
  levels: ChainLevel[];
  notes: string[];
}

/**
 * The levels, in order, with no provider twice. `first` is the on-call
 * provider or a post-op patient's surgeon; the region whose director comes
 * next is that provider's own.
 */
export function planChain(
  first: { role: "on_call" | "surgeon"; provider: OnCallProvider } | null,
  data: RotationData,
): ChainPlan {
  const levels: ChainLevel[] = [];
  const notes: string[] = [];
  const seen = new Set<number>();
  const push = (role: ChainRole, p: OnCallProvider | null) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    levels.push({ role, providerId: p.id, name: p.fullName, phone: p.phone });
  };
  const final = finalDirector(data);
  if (first) {
    push(first.role, first.provider);
    const director = directorFor(first.provider.region, data);
    if (!director) notes.push("no_director_for_region");
    else if (!director.active) notes.push("region_director_inactive");
    // A region whose director IS the final director (San Diego, Coachella
    // Valley) goes straight to the final level, labelled as such.
    else if (director.id !== final?.id) push("region_director", director);
  } else {
    notes.push("no_first_level");
  }
  if (!final) notes.push("no_final_director");
  else if (!final.active) notes.push("final_director_inactive");
  else push("final", final);
  return { levels, notes };
}
