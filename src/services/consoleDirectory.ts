/**
 * Providers and locations, from the one source of truth.
 *
 * OPERATOR RULE (2026-08-11): NextGen is the source of truth. It is mirrored
 * into the Eye Care Patient Console for speed — so a lookup is a local query
 * rather than a live NextGen API call that can be slow or fail. Nothing queries
 * NextGen directly, and nothing keeps its own third copy.
 *
 * This module is that rule, applied to the two fields the answering service
 * sends on every ticket. Before it, "is this string a real provider?" was
 * answered by a hardcoded list in this repo — which is precisely the kind of
 * fourth copy the rule exists to prevent.
 *
 * WHY IT MATTERS, measured over 90 days of `/api/voice-agent/submit-ticket`:
 * a provider name the ticketing app cannot resolve sends it to a Schedule-DB
 * fallback that roughly doubles the caller's wait — 5,184ms to 10,741ms, and
 * 4.1% to 21.5% of turns over fifteen seconds.
 *
 * The directory is small (77 providers, 105 locations) and changes about once
 * a day, so it is cached in memory and refreshed on a timer. A miss never
 * blocks a call: if the Console is unreachable we fall back to the pure string
 * rules in `ticketFieldSanitizers`, which are always safe.
 */
import pg from 'pg';

const REFRESH_MS = Number(process.env.CONSOLE_DIRECTORY_TTL_MS ?? 15 * 60_000);
const QUERY_TIMEOUT_MS = 2500;

export interface DirectoryProvider {
  /** Exactly as NextGen names them, e.g. "Talin Khachatoor Sarkissian, O.D." */
  canonical: string;
  /** Lower-cased, credentials and honorifics removed — the match key. */
  key: string;
  /** Appointments in the last 90 days. 0 means they are not currently seeing patients. */
  volume90d: number;
}

export interface DirectoryLocation {
  canonical: string;
  key: string;
  /** clinic | surgery_center | screening_site | mobile | … */
  facilityKind: string | null;
  volume90d: number;
  /**
   * The name the TICKETING APP stores, when it differs from the mirror's.
   *
   * Only set for the handful of offices in LOCATION_ALIASES. Everywhere else
   * the brand-stripped mirror name is already what the receiver holds.
   */
  fileAs?: string;
}

interface Snapshot {
  providers: Map<string, DirectoryProvider>;
  locations: Map<string, DirectoryLocation>;
  loadedAt: number;
}

let pool: pg.Pool | null = null;
let snapshot: Snapshot | null = null;
let inFlight: Promise<Snapshot | null> | null = null;

export function isDirectoryConfigured(): boolean {
  return Boolean(process.env.OBS_CONSOLE_DATABASE_URL);
}

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.OBS_CONSOLE_DATABASE_URL;
    if (!url) throw new Error('OBS_CONSOLE_DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
      // Read-only by session as well as by role. This path has no business
      // writing to the console and that guarantee should not rest on anyone
      // remembering it.
      options: `-c default_transaction_read_only=on -c statement_timeout=${QUERY_TIMEOUT_MS}`,
    });
    pool.on('error', (e) => console.error('[DIRECTORY] console pool error:', e.message));
  }
  return pool;
}

/**
 * The match key.
 *
 * NextGen's own credential formatting is not consistent — the live mirror
 * contains "M.D.", "MD", "O.D.", "OD", "DO", "NP", "P.A.", the typo "O,D."
 * on two rows, and 8 providers with no credential at all. Normalising both
 * sides is the only way a comparison means anything.
 */
/**
 * THE OFFICES WHOSE NAME NOBODY AGREES ON.
 *
 * Found 2026-08-13, from a live optical call that looped `resolve_location`
 * ten times. The caller said "Downtown LA". The operator's answer when I
 * reported it as an unknown office: *"we do have downtown la that is our main
 * los angeles office."*
 *
 * He is right, and the office is invisible to this code from BOTH ends:
 *
 *   caller says        NextGen mirror              ticketing app     vol/90d
 *   ---------------------------------------------------------------------
 *   "Downtown LA"      Azul Vision DTLA            Los Angeles         4,810
 *   "Riverside"        Azul Vision Riverside Latham Riverside         11,399
 *   "Mission Hills"    Azul Vision Mission Hlls    Mission Hills       7,259
 *   "Long Beach"/"Willow" Azul Vision Willow       Long Beach Willow   3,373
 *
 * Every other clinic brand-strips to a plain city name and resolves fine.
 * These four do not, and between them they carry 26,841 appointments a
 * quarter — a fifth of all clinic volume. "Mission Hlls" is a TYPO in NextGen
 * itself, which no amount of normalising will fix from our side.
 *
 * TWO SEPARATE BREAKS, and fixing either alone still fails:
 *
 *   1. `spoken` — what a caller calls it does not match the mirror, so
 *      lookupLocation returns null and the agent has nothing to file.
 *   2. `fileAs` — even once resolved, we hand on the MIRROR's form. The
 *      ticketing app sets the location foreign key by name, and it has never
 *      heard of "DTLA". That is the same class as the provider drift the
 *      ticketing agent measured across 11,296 appointments, and I only ever
 *      checked providers.
 *
 * A THIRD BREAK, added 2026-08-21: a RETIRED name. Two offices were renamed
 * in NextGen a couple of months before this (Wayne, confirmed directly, not
 * inferred): "North Valley Eye" -> Mission Hills, "Magan" -> Covina. Every
 * appointment booked before the rename still carries the old name in
 * `Schedule.OfficeLocation` — which is where `lookup_patient`'s `usual_clinic`
 * reads from — so a longtime patient hears their own real office named back
 * to them correctly, confirms it, and `resolve_location` still can't place
 * it: the old name was never in `si_locations` to begin with (a rename, not
 * a typo), so there was no live entry for it to be an alternate spelling OF.
 * Traced from a real call, 2026-08-21: `lookup_patient` said "I have you at
 * our North Valley Eye office," the caller confirmed it, and filing asked
 * "which city is your optical office in?" as if nothing had been said —
 * measured at 7 of 19 optical location-refusals that day, the single largest
 * cause. `spoken` is exactly the right place for a retired name to live: it
 * does not need to exist in the mirror, only the office it now points at
 * does, and Covina needed a first entry here for it (it resolves natively by
 * brand-stripping, same as Mission Hills' bare "Mission Hlls" would if it
 * were not misspelled — the entry exists so "Magan" has somewhere to point).
 *
 * This table is deliberately small and explicit. It is NOT a fuzzy matcher —
 * a fuzzy matcher would paper over exactly the drift we want to keep visible,
 * and would eventually route a caller to the wrong clinic. Any office added
 * here needs a real reason, written down.
 */
export const LOCATION_ALIASES: Array<{
  /** Key as it appears in the Console mirror, after directoryKey(). */
  mirror: string;
  /** The name the TICKETING APP stores, which is what we must file. */
  fileAs: string;
  /** What callers and staff actually say. */
  spoken: string[];
}> = [
  {
    mirror: 'azul vision dtla',
    fileAs: 'Los Angeles',
    spoken: ['downtown la', 'downtown los angeles', 'los angeles', 'downtown', 'dtla', 'l a office', 'the la office'],
  },
  {
    mirror: 'azul vision riverside latham',
    fileAs: 'Riverside',
    // NOT 'latham' alone — that is a street, and the LASIK centre also sits in
    // Riverside. Callers say the city.
    spoken: ['riverside', 'riverside latham', 'latham'],
  },
  {
    mirror: 'azul vision mission hlls',
    fileAs: 'Mission Hills',
    // The mirror's own spelling is missing an 'i'. Index the correct spelling
    // so a caller who says it properly is not punished for NextGen's typo.
    // 'north valley eye' is the office's own RETIRED NextGen name (renamed a
    // couple of months before 2026-08-21, per Wayne) — it never existed in
    // si_locations under that name, so it can only ever be a spoken synonym,
    // never a `mirror`. See the file header.
    spoken: ['mission hills', 'mission hlls', 'north valley eye'],
  },
  {
    mirror: 'azul vision willow',
    fileAs: 'Long Beach Willow',
    // Deliberately NOT 'long beach' — that is a DIFFERENT clinic (Atlantis
    // Eyecare Long Beach, 9,241 a quarter). Aliasing it here would send those
    // callers to the wrong office, which is worse than not resolving.
    spoken: ['willow', 'long beach willow'],
  },
  {
    mirror: 'azul vision covina',
    // Already resolves natively by brand-stripping to "covina" — this entry
    // exists only to carry the retired name below. fileAs is explicit (not
    // relied on implicitly) because this entry is new, unlike Covina's own
    // bare-strip match which predates it.
    fileAs: 'Covina',
    // 'magan' is Covina's own RETIRED NextGen name (renamed alongside North
    // Valley Eye -> Mission Hills, per Wayne, 2026-08-21). Same shape as
    // above: never a `mirror`, only ever a spoken synonym.
    spoken: ['magan'],
  },
];

export function directoryKey(raw: string): string {
  return raw
    .replace(/,?\s*(O\.?,?\s?D\.?|M\.?\s?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?|DNP|PhD)\s*$/i, '')
    .replace(/^(Dr\.?|Dra\.?|Doctor)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();
}

async function load(): Promise<Snapshot | null> {
  const client = getPool();
  const [prov, loc] = await Promise.all([
    client.query<{ nextgen_name: string; volume_90d: number | null }>(
      `select nextgen_name, volume_90d from si_providers
       where coalesce(is_deleted_in_nextgen, false) = false`,
    ),
    client.query<{ nextgen_name: string; facility_kind: string | null; volume_90d: number | null }>(
      `select nextgen_name, facility_kind, volume_90d from si_locations
       where coalesce(is_deleted_in_nextgen, false) = false`,
    ),
  ]);

  const providers = new Map<string, DirectoryProvider>();
  for (const r of prov.rows) {
    if (!r.nextgen_name) continue;
    const key = directoryKey(r.nextgen_name);
    if (key) providers.set(key, { canonical: r.nextgen_name, key, volume90d: r.volume_90d ?? 0 });
  }

  const locations = new Map<string, DirectoryLocation>();
  for (const r of loc.rows) {
    if (!r.nextgen_name) continue;
    const key = directoryKey(r.nextgen_name);
    if (!key) continue;
    const entry = {
      canonical: r.nextgen_name,
      key,
      facilityKind: r.facility_kind,
      volume90d: r.volume_90d ?? 0,
    };
    locations.set(key, entry);
    // NextGen brands clinics "Azul Vision Encinitas"; callers and the ticketing
    // app both say "Encinitas". Index both so either resolves.
    const bare = key.replace(/^(azul vision|atlantis eyecare)\s+/, '');
    if (bare !== key && !locations.has(bare)) locations.set(bare, entry);
  }

  // The four offices nobody names the same way. See LOCATION_ALIASES.
  for (const alias of LOCATION_ALIASES) {
    const entry = locations.get(alias.mirror);
    if (!entry) {
      // The mirror renamed it, or it was retired. Say so — a silently dead
      // alias is how this class of bug hides in the first place.
      console.warn(
        `[DIRECTORY] alias target "${alias.mirror}" is not in the mirror — ` +
          `the ${alias.fileAs} aliases will not resolve`,
      );
      continue;
    }
    entry.fileAs = alias.fileAs;
    for (const spoken of alias.spoken) {
      const k = directoryKey(spoken);
      const existing = locations.get(k);
      // NEVER overwrite a real office. "long beach" already resolves to the
      // Long Beach clinic and must keep doing so; an alias that steals a key
      // sends callers to the wrong clinic, which is worse than not resolving.
      if (existing && existing !== entry) {
        console.warn(
          `[DIRECTORY] alias "${spoken}" already resolves to "${existing.canonical}" — ` +
            `not remapping it to "${entry.canonical}"`,
        );
        continue;
      }
      locations.set(k, entry);
    }
  }

  return { providers, locations, loadedAt: Date.now() };
}

/** Current snapshot, refreshing if stale. Never throws; returns null if unavailable. */
/**
 * The snapshot ALREADY in memory, or null — never a fetch.
 *
 * The voice runtime builds its keyterm list inside a synchronous
 * `createSession` callback on the call path, where an await would add latency
 * to every answer for data that is refreshed on a timer anyway. A cold process
 * answers its first call or two without keyterms and warms up behind them;
 * that is the right trade against making a caller wait.
 */
export function loadedDirectory(): Snapshot | null {
  return snapshot;
}

export async function getDirectory(): Promise<Snapshot | null> {
  if (snapshot && Date.now() - snapshot.loadedAt < REFRESH_MS) return snapshot;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    if (!isDirectoryConfigured()) return snapshot;
    try {
      const fresh = await load();
      if (fresh) {
        snapshot = fresh;
        console.info(
          `[DIRECTORY] loaded from the Patient Console: ${fresh.providers.size} providers, ` +
            `${fresh.locations.size} location keys`,
        );
      }
      return snapshot;
    } catch (e) {
      // A stale snapshot beats no snapshot, and no snapshot beats a failed call.
      console.warn(`[DIRECTORY] refresh failed (${(e as Error).message}) — using what we have`);
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Look a provider up by anything a caller or the schedule might say. */
export async function lookupProvider(raw: string): Promise<DirectoryProvider | null> {
  const dir = await getDirectory();
  if (!dir) return null;
  return dir.providers.get(directoryKey(raw)) ?? null;
}

export async function lookupLocation(raw: string): Promise<DirectoryLocation | null> {
  const dir = await getDirectory();
  if (!dir) return null;
  return dir.locations.get(directoryKey(raw)) ?? null;
}

/** Test seam. Also lets a deploy force a refresh without a restart. */
export function __resetDirectory(next?: Snapshot | null): void {
  snapshot = next ?? null;
  inFlight = null;
}
