/**
 * Searching a patient's partner availability as they talk (operator,
 * 2026-11-08): "it should always be what day and time works best for you as
 * the starting point … we have to guide the conversation into the scheduling
 * and we have to be able to pull availability rapidly from week to week or
 * day by day."
 *
 * NPX hands the call every slot it may offer this patient once
 * (POST /api/exchange/outreach/availability, by the offer's own rules —
 * credentialing included), and these pure functions answer each "what about
 * Thursday afternoon?" from that list in memory: no network between a
 * caller's question and the answer. Nothing here decides what a patient
 * qualifies for; NPX did, and the booking checks it again.
 */
import type { NpxSlot } from '../services/npxOutreachClient';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type TimeOfDay = 'morning' | 'afternoon' | 'any';

/** What the caller asked for, as the model passes it. Every field optional. */
export interface SlotPreference {
  /** YYYY-MM-DD */
  onDate?: string;
  fromDate?: string;
  toDate?: string;
  weekdays?: Weekday[];
  timeOfDay?: TimeOfDay;
  /** "HH:MM", 24-hour (also read: "9", "9am", "2:30 pm"). */
  earliestTime?: string;
  latestTime?: string;
  city?: string;
}

/** How far a search had to step back from what was asked to find anything. */
export type Relaxed = null | 'time' | 'day' | 'when' | 'city' | 'all';

/** Options read to the caller at once. */
export const OPTIONS_PER_SEARCH = 3;
/** On one day, offered times sit at least this far apart, where they can. */
const SAME_DAY_SPREAD_MIN = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdOrUndefined = (s: unknown): string | undefined =>
  typeof s === 'string' && YMD.test(s.trim()) ? s.trim() : undefined;

/** The model's arguments, read leniently: anything unreadable is simply not a constraint. */
export function preferenceFrom(input: Record<string, unknown>): SlotPreference {
  const rawDays = Array.isArray(input.weekdays)
    ? input.weekdays.map(String)
    : typeof input.weekdays === 'string'
      ? input.weekdays.split(/[,\s]+/)
      : [];
  const weekdays = [
    ...new Set(
      rawDays
        .map((w) => w.trim().toLowerCase().replace(/s$/, ''))
        .filter((w) => (WEEKDAYS as readonly string[]).includes(w)),
    ),
  ] as Weekday[];
  const tod = String(input.time_of_day ?? '').trim().toLowerCase();
  const pref: SlotPreference = {
    onDate: ymdOrUndefined(input.on_date),
    fromDate: ymdOrUndefined(input.from_date),
    toDate: ymdOrUndefined(input.to_date),
    weekdays: weekdays.length ? weekdays : undefined,
    timeOfDay: tod === 'morning' || tod === 'afternoon' ? tod : undefined,
    earliestTime: typeof input.earliest_time === 'string' && minutesOf(input.earliest_time) !== null ? input.earliest_time : undefined,
    latestTime: typeof input.latest_time === 'string' && minutesOf(input.latest_time) !== null ? input.latest_time : undefined,
    city: typeof input.city === 'string' && input.city.trim() ? input.city.trim() : undefined,
  };
  for (const k of Object.keys(pref) as (keyof SlotPreference)[]) if (pref[k] === undefined) delete pref[k];
  return pref;
}

/** Minutes after midnight from "14:30", "9", "9am", "2:30 pm"; null when unreadable. */
export function minutesOf(t: string): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const tz = (s: NpxSlot) => s.timezone || 'America/Los_Angeles';

/** The slot's day, weekday and minute of the day, in the clinic's own time zone. */
export function localParts(s: NpxSlot): { day: string; weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz(s),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(s.startAt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday').toLowerCase() as Weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The clinic's city: NPX's own field, else read from the address
 * ("1 Main St, Suite 2, Fontana, CA 92335" -> "Fontana"). */
export function cityOf(s: NpxSlot): string {
  if (s.city?.trim()) return s.city.trim();
  const parts = (s.address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const stateAt = parts.findIndex((p) => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  return stateAt > 0 ? parts[stateAt - 1] : '';
}

function dayMatches(day: string, weekday: Weekday, p: SlotPreference): boolean {
  if (p.onDate && day !== p.onDate) return false;
  if (p.fromDate && day < p.fromDate) return false;
  if (p.toDate && day > p.toDate) return false;
  if (p.weekdays?.length && !p.weekdays.includes(weekday)) return false;
  return true;
}

function timeMatches(minutes: number, p: SlotPreference): boolean {
  if (p.timeOfDay === 'morning' && minutes >= 12 * 60) return false;
  if (p.timeOfDay === 'afternoon' && minutes < 12 * 60) return false;
  const lo = p.earliestTime ? minutesOf(p.earliestTime) : null;
  const hi = p.latestTime ? minutesOf(p.latestTime) : null;
  if (lo !== null && minutes < lo) return false;
  if (hi !== null && minutes > hi) return false;
  return true;
}

function cityMatches(s: NpxSlot, p: SlotPreference): boolean {
  if (!p.city) return true;
  const want = fold(p.city);
  const have = fold(cityOf(s));
  // A slot whose city cannot be read matches no city: '' is in every string (Codex, #439).
  return Boolean(want) && Boolean(have) && (have.includes(want) || want.includes(have));
}

export function matches(s: NpxSlot, p: SlotPreference): boolean {
  const { day, weekday, minutes } = localParts(s);
  return dayMatches(day, weekday, p) && timeMatches(minutes, p) && cityMatches(s, p);
}

const hasTime = (p: SlotPreference) => Boolean(p.timeOfDay || p.earliestTime || p.latestTime);
const hasDay = (p: SlotPreference) => Boolean(p.onDate || p.fromDate || p.toDate || p.weekdays?.length);

/** One slot per clinic and start time: two providers at 9:20 in one office are one choice for the caller. */
function distinctTimes(slots: NpxSlot[]): NpxSlot[] {
  const seen = new Set<string>();
  return [...slots]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .filter((s) => {
      const k = `${s.clinicId}|${s.startAt}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

const dayDistance = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/**
 * Up to `max` choices from `slots`: on a single day, times spread across it;
 * otherwise the earliest on each of several days. Near `target` first when a
 * day was asked for and could not be had.
 */
export function pickSpread(slots: NpxSlot[], max = OPTIONS_PER_SEARCH, target?: string): NpxSlot[] {
  let list = distinctTimes(slots);
  if (list.length === 0) return [];
  if (target) {
    list = [...list].sort(
      (a, b) =>
        dayDistance(localParts(a).day, target) - dayDistance(localParts(b).day, target) ||
        Date.parse(a.startAt) - Date.parse(b.startAt),
    );
  }
  const days = new Set(list.map((s) => localParts(s).day));
  const picked: NpxSlot[] = [];
  if (days.size === 1) {
    for (const s of list) {
      if (picked.length >= max) break;
      const m = localParts(s).minutes;
      if (picked.every((p) => Math.abs(localParts(p).minutes - m) >= SAME_DAY_SPREAD_MIN)) picked.push(s);
    }
  } else {
    const used = new Set<string>();
    for (const s of list) {
      if (picked.length >= max) break;
      const d = localParts(s).day;
      if (used.has(d)) continue;
      used.add(d);
      picked.push(s);
    }
  }
  for (const s of list) {
    if (picked.length >= max) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

/**
 * The choices for what the caller asked. When nothing matches exactly, the
 * search steps back one constraint at a time — the time of day first (the
 * same day at another time), then the day (the same time on another day,
 * nearest first), then both (another time on the nearest day) — all in the
 * city they named, and only then the city, and says how far it stepped.
 *
 * THE STEPS ACCUMULATE BEFORE THE CITY GOES (Codex P2, #439). Each step was
 * built from the original preference, so a caller who named a day, a time and
 * a city, with nothing on that day at all and something at another time on a
 * nearby day in that city, missed all three single steps and was offered any
 * city. Dropping the day AND the time while keeping the city is now a step of
 * its own, ahead of dropping the city.
 */
export function searchSlots(
  slots: NpxSlot[],
  p: SlotPreference,
  max = OPTIONS_PER_SEARCH,
): { picked: NpxSlot[]; relaxed: Relaxed; matching: number } {
  const exact = slots.filter((s) => matches(s, p));
  if (exact.length) return { picked: pickSpread(exact, max), relaxed: null, matching: distinctTimes(exact).length };
  const target = p.onDate ?? p.fromDate;
  const steps: Array<[Exclude<Relaxed, null>, SlotPreference, string | undefined]> = [];
  const noTime = { timeOfDay: undefined, earliestTime: undefined, latestTime: undefined };
  const noDay = { onDate: undefined, fromDate: undefined, toDate: undefined, weekdays: undefined };
  if (hasTime(p)) steps.push(['time', { ...p, ...noTime }, undefined]);
  if (hasDay(p)) steps.push(['day', { ...p, ...noDay }, target]);
  if (hasTime(p) && hasDay(p)) steps.push(['when', { ...p, ...noTime, ...noDay }, target]);
  if (p.city) steps.push(['city', { ...p, city: undefined }, target]);
  steps.push(['all', {}, target]);
  for (const [relaxed, pref, near] of steps) {
    const found = slots.filter((s) => matches(s, pref));
    if (found.length) return { picked: pickSpread(found, max, near), relaxed, matching: 0 };
  }
  return { picked: [], relaxed: 'all', matching: 0 };
}

// ── In words ────────────────────────────────────────────────────────────────

/** "Tuesday, November 17" */
export function spokenSlotDay(s: NpxSlot): string {
  return new Date(s.startAt).toLocaleDateString('en-US', { timeZone: tz(s), weekday: 'long', month: 'long', day: 'numeric' });
}

/** "9:20 AM" */
export function spokenSlotTime(s: NpxSlot): string {
  return new Date(s.startAt).toLocaleTimeString('en-US', { timeZone: tz(s), hour: 'numeric', minute: '2-digit' });
}

/** "Tuesday, November 17 at 9:20 AM" */
export function spokenWhen(s: NpxSlot): string {
  return `${spokenSlotDay(s)} at ${spokenSlotTime(s)}`;
}

/** "Fontana", "Fontana and Rancho Cucamonga", "Fontana, Chino Hills and Claremont". */
export function joinWords(words: string[], conj = 'and'): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} ${conj} ${words[words.length - 1]}`;
}

/** The cities with openings, earliest first, at most three. */
export function citiesWithOpenings(slots: NpxSlot[], max = 3): string[] {
  const out: string[] = [];
  for (const s of distinctTimes(slots)) {
    const c = cityOf(s);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The choices as one sentence for the caller: day, date, time and city —
 * never a street address, which is said once, after they book.
 */
export function offerLine(picked: NpxSlot[]): string {
  if (picked.length === 0) return '';
  const cities = [...new Set(picked.map(cityOf).filter(Boolean))];
  const oneCity = cities.length <= 1;
  const days = [...new Set(picked.map(spokenSlotDay))];
  let body: string;
  if (days.length === 1 && picked.length > 1) {
    const times = picked.map((s) => (oneCity ? spokenSlotTime(s) : `${spokenSlotTime(s)} in ${cityOf(s)}`));
    body = `On ${days[0]} I have ${joinWords(times, 'or')}`;
  } else {
    const items = picked.map((s) => (oneCity ? spokenWhen(s) : `${spokenWhen(s)} in ${cityOf(s)}`));
    body = `I have ${joinWords(items, 'or')}`;
  }
  if (oneCity && cities[0]) body += `, in ${cities[0]}`;
  const ask =
    picked.length === 1 ? 'Would that work for you?' : picked.length === 2 ? 'Would either of those work for you?' : 'Would any of those work for you?';
  return `${body}. ${ask}`;
}

const PLURAL_DAY: Record<Weekday, string> = {
  monday: 'Mondays',
  tuesday: 'Tuesdays',
  wednesday: 'Wednesdays',
  thursday: 'Thursdays',
  friday: 'Fridays',
  saturday: 'Saturdays',
  sunday: 'Sundays',
};

/**
 * What is open overall, for a caller who asks "what do you have?":
 * which weekdays, from when to when, mornings and/or afternoons, and where.
 */
export function overviewLine(slots: NpxSlot[]): string {
  const list = distinctTimes(slots);
  if (list.length === 0) return '';
  const parts = list.map(localParts);
  const weekdays = WEEKDAYS.filter((w) => parts.some((p) => p.weekday === w));
  const mornings = parts.some((p) => p.minutes < 12 * 60);
  const afternoons = parts.some((p) => p.minutes >= 12 * 60);
  const when = mornings && afternoons ? 'mornings and afternoons' : mornings ? 'mornings' : 'afternoons';
  const cities = citiesWithOpenings(list);
  const first = spokenSlotDay(list[0]);
  const last = spokenSlotDay(list[list.length - 1]);
  const span = first === last ? `on ${first}` : `from ${first} through ${last}`;
  const where = cities.length ? `, in ${joinWords(cities)}` : '';
  return `Openings on ${joinWords(weekdays.map((w) => PLURAL_DAY[w]))}, ${when}, ${span}${where}.`;
}

/** The street address without the state and ZIP: "11000 Eucalyptus St, 185, Rancho Cucamonga". */
export function spokenAddress(s: NpxSlot): string {
  const parts = (s.address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const stateAt = parts.findIndex((p) => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  return (stateAt > 0 ? parts.slice(0, stateAt) : parts).join(', ');
}

/** Today's date in the practice's time zone, YYYY-MM-DD and in words. */
export function practiceToday(now = new Date()): { date: string; words: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const words = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return { date, words };
}
