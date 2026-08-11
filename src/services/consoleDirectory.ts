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

  return { providers, locations, loadedAt: Date.now() };
}

/** Current snapshot, refreshing if stale. Never throws; returns null if unavailable. */
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
