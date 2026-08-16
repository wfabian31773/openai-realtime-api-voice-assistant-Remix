/**
 * PROVIDER AND OFFICE ROSTER — read from the schedule, not from memory.
 *
 * The transcription keyword list was hand-maintained, and hand-maintained
 * lists rot. On 2026-08-05 the hardcoded roster was `Nayer, Bock, Kim,
 * Thompson, Choi` against the actual top of the schedule:
 *
 *   Amini M.D,Payam · Mahdavi M.D., Paymohn · Khachatoor Sarkissian O.D.,
 *   Talin · Shaw O.D., Minh · Logan, Dwayne K · Diggory O.D., Matthew ·
 *   Villegas O.D., Rex · Hammill, Timothy · Tran O.D., Kevin H · Patel M.D.,
 *   Jay · Sugiyama, Dennis O.D. · Plechot O.D., Eriq · Chang M.D., Sylvia
 *
 * Three of thirteen matched. 'Thompson' was hinted and no Thompson appears in
 * ninety days of appointments — the real name is Tompkins.
 *
 * Worse, and the reason this file exists rather than a longer constant: the
 * replacement list was itself built by reading transcripts, so it contained
 * 'Amani' — which is what the transcriber HEARD. The provider is Amini.
 * Hinting a mis-transcription teaches the transcriber to keep making it, and
 * no amount of care in curating that list would have caught it, because the
 * only source consulted was the output being corrected.
 *
 * Refreshed on an interval and cached in memory. buildTranscriptionConfig is
 * synchronous and sits in the call-accept path, so it reads the cache and
 * never waits; an empty cache falls back to the seed constants, which is the
 * behaviour that shipped before this existed.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../server/db';

/**
 * How far back to look. A provider who has not been on the schedule recently
 * is not who the caller is asking for.
 *
 * WAS 90, CUT TO 30 ON 2026-08-16 BECAUSE 90 DID NOT COMPLETE.
 *
 * The refresh below groups the whole `Schedule` table by provider and office
 * over the window. At 90 days that exceeded the statement timeout on every
 * boot, twice in four seconds:
 *
 *     [ROSTER] refresh failed — falling back to the seed keyword list:
 *     DrizzleQueryError: canceling statement due to statement timeout
 *
 * It fails soft — `refreshProviderRoster` never throws and the seed constants
 * take over — which is why it went unnoticed. But soft failure every time is
 * the same as not having the feature: provider and office recognition has been
 * running on hardcoded seeds, not on who is actually on the schedule.
 *
 * NECESSARY BUT NOT SUFFICIENT — measured, not assumed. Thirty days still
 * exceeded a 60-second budget when tested against production. The plan says
 * why:
 *
 *     Sort  (cost=106368.79..106382.16 rows=5346)
 *       HashAggregate  (cost=105984.30..106037.76 rows=5346)
 *         Group Key: "ProviderFromAppt", "OfficeLocation"
 *         Index Scan using idx_schedule_apptdate  (cost=0.43..104799.65
 *                                                  rows=157953 width=28)
 *
 * The date index is used and is not the problem. The cost is fetching 157,953
 * wide heap rows and grouping them by two columns the index does not carry.
 * Ninety days is roughly three times that.
 *
 * THE FIX THAT ACTUALLY CLOSES THIS is a covering index —
 *   CREATE INDEX CONCURRENTLY idx_schedule_roster
 *     ON "Schedule" ("AppointmentDate", "ProviderFromAppt", "OfficeLocation");
 * — which turns the whole thing into an index-only scan. It is a heavier
 * operation on a large production table, so it is the operator's call and is
 * deliberately not done here.
 *
 * Until then this still fails soft, and that is the part worth remembering:
 * `refreshProviderRoster` never throws, so provider and office recognition has
 * been running on the hardcoded seed lists rather than on who is actually on
 * the schedule — silently, on every boot, for as long as the query has been
 * too slow.
 */
const LOOKBACK_DAYS = 30;
const REFRESH_MS = 12 * 60 * 60 * 1000;
/** Keyword lists are hints, not a dictionary — an unbounded one dilutes. */
const MAX_PROVIDERS = 40;
const MAX_OFFICES = 25;

/**
 * Schedule rows that are not people. The provider column doubles as a
 * resource column: "OCT/VF" (12,423 appointments) and "Screening" (4,345)
 * outrank every human on it.
 */
const NOT_A_PERSON = /^(?:oct|vf|oct\/vf|screening|test|block|hold|lunch|meeting|closed|resource|room|tech|misc|other|n\/a|unknown)$/i;

/** Credentials and honorifics that are not part of the surname. */
const CREDENTIALS = /\b(?:m\.?\s?d\.?|o\.?\s?d\.?|d\.?\s?o\.?|ph\.?\s?d\.?|f\.?a\.?c\.?s\.?|p\.?a\.?\-?c?|n\.?p\.?|r\.?n\.?|dr|doctor|jr|sr|ii|iii|iv)\b/gi;

/**
 * The surname out of a schedule entry.
 *
 * The column is free text and every format in it is different: "Logan, Dwayne
 * K", "Amini M.D,Payam", "Sugiyama, Dennis O.D.", "Rocha.O.D.Guadalupe",
 * "Grant-Acquah, Kweku". The surname leads in all of them, so strip the
 * credentials and take what is in front of the first separator.
 */
export function surnameOf(entry: string): string | null {
  if (!entry) return null;
  const cleaned = entry
    .replace(/\./g, '. ')          // "Rocha.O.D.Guadalupe" → "Rocha. O. D. Guadalupe"
    .replace(CREDENTIALS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A slash means a resource, not a person: "OCT/VF" is the single
  // highest-volume value in the provider column.
  if (entry.includes('/')) return null;
  const head = cleaned.split(',')[0].trim();
  const rawFirst = head.split(/\s+/)[0] ?? '';
  const first = rawFirst.replace(/[^A-Za-z'-]/g, '');
  if (first.length < 3) return null;
  // Tested against BOTH forms: stripping punctuation turned "OCT/VF" into
  // "OCTVF", which matched nothing on the deny-list.
  if (NOT_A_PERSON.test(rawFirst) || NOT_A_PERSON.test(first)) return null;
  // An all-caps token is an abbreviation, not a surname.
  if (first.length <= 5 && first === first.toUpperCase()) return null;
  // Title-case so the hint reads as a name.
  return first[0].toUpperCase() + first.slice(1);
}

interface Roster {
  providers: string[];
  offices: string[];
  refreshedAt: number | null;
  /** Distinguishes "not loaded yet" from "loaded and genuinely empty". */
  loaded: boolean;
}

const roster: Roster = { providers: [], offices: [], refreshedAt: null, loaded: false };

export function providerSurnames(): string[] {
  return roster.providers;
}

export function officeNames(): string[] {
  return roster.offices;
}

export function rosterStatus(): { loaded: boolean; providers: number; offices: number; refreshedAt: number | null } {
  return {
    loaded: roster.loaded,
    providers: roster.providers.length,
    offices: roster.offices.length,
    refreshedAt: roster.refreshedAt,
  };
}

/** Exposed for tests and for the boot path; never throws. */
export async function refreshProviderRoster(): Promise<void> {
  try {
    const rows: any = await db.execute(sql`
      select "ProviderFromAppt" as provider, "OfficeLocation" as office, count(*) as n
      from "Schedule"
      where "AppointmentDate" >= current_date - ${LOOKBACK_DAYS}::int
      group by 1, 2
      order by n desc
    `);
    const list: Array<{ provider?: string; office?: string; n?: number }> = rows?.rows ?? rows ?? [];

    const providerCounts = new Map<string, number>();
    const officeCounts = new Map<string, number>();
    for (const r of list) {
      const n = Number(r.n ?? 0);
      const surname = surnameOf(String(r.provider ?? ''));
      if (surname) providerCounts.set(surname, (providerCounts.get(surname) ?? 0) + n);
      const office = String(r.office ?? '').trim();
      if (office && office.length >= 3 && !NOT_A_PERSON.test(office)) {
        officeCounts.set(office, (officeCounts.get(office) ?? 0) + n);
      }
    }

    const byCount = (m: Map<string, number>, cap: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([k]) => k);

    const providers = byCount(providerCounts, MAX_PROVIDERS);
    const offices = byCount(officeCounts, MAX_OFFICES);

    // Never replace a good roster with an empty one: a query that returns
    // nothing (schedule sync stalled, table renamed) must not silently strip
    // every hint the transcriber had.
    if (providers.length === 0 && offices.length === 0) {
      console.warn('[ROSTER] refresh returned nothing — keeping the previous roster');
      return;
    }

    roster.providers = providers;
    roster.offices = offices;
    roster.refreshedAt = Date.now();
    roster.loaded = true;
    console.info(
      `[ROSTER] ${providers.length} provider surname(s), ${offices.length} office(s) from the last ${LOOKBACK_DAYS} days ` +
        `(top: ${providers.slice(0, 5).join(', ')})`,
    );
  } catch (e) {
    // A roster failure costs vocabulary hints, never a call: the transcription
    // config falls back to the seed constants.
    console.error('[ROSTER] refresh failed — falling back to the seed keyword list:', e);
  }
}

let refreshStarted = false;

/**
 * Boot once, then daily. unref so the timers never hold the process open.
 *
 * Idempotent per PROCESS, and it has to be: this roster is module state, so
 * every process that reads the keyterms must start it, and more than one of
 * them may. Until now only voiceAgentRoutes started it — so the API server,
 * where the demo line lives, always reported an empty roster and quietly
 * handed every transcriber the seed word list instead of this practice's
 * actual doctors.
 */
export function startProviderRosterRefresh(): void {
  if (refreshStarted) return;
  refreshStarted = true;
  void refreshProviderRoster();
  setInterval(() => { void refreshProviderRoster(); }, REFRESH_MS).unref?.();
}
