/**
 * WHICH SOFTWARE HANDLED THE CALL — stamped on the call row (Stage C, A6).
 *
 * Three columns on `call_logs`, added by migrations/add_call_build_identity.sql:
 *
 *   runtime_marker  VOICE_RUNTIME_DEPLOY_MARKER for a runtime call, 'old-core'
 *                   for the SIP pipeline.
 *   build_sha       the commit the deployed bundle was built from
 *                   (build-info.json, written at build time). NULL = unknown.
 *   voice_model     the model the runtime session opened with. NULL on the
 *                   old core, which does not say.
 *
 * TWO RULES, and each is why this is a raw UPDATE rather than a Drizzle column.
 *
 * 1. THE MIGRATION AND THE PUBLISH MAY HAPPEN IN EITHER ORDER. Drizzle lists
 *    EVERY declared column in every insert and every `select()` (checked on
 *    drizzle-orm 0.44: `insert into "t" ("a","b") values ($1, default)`), so
 *    declaring these in shared/schema.ts before the columns exist on the Hub
 *    would break every call_logs read and write in the fleet. Instead the
 *    columns are written by one statement here, and only after
 *    `information_schema` says all three exist — checked once, re-checked
 *    every ten minutes while absent, so applying the migration starts the
 *    stamping without a republish. Absent, it logs one line and writes nothing.
 *
 * 2. NEVER OVERWRITE, NEVER GUESS. Each column is `COALESCE(column, value)`:
 *    the first writer of a call wins, and a later write on the same call
 *    (teardown after open) can only fill a NULL. A NULL value stays NULL —
 *    nothing is inferred, and historical rows are never backfilled.
 *
 * It never throws and never blocks a call: every caller fires it and forgets.
 */
import { getBuildInfo } from "../../server/buildInfo";
import { VOICE_RUNTIME_DEPLOY_MARKER } from "./readiness";

export const OLD_CORE_MARKER = "old-core";

export const BUILD_IDENTITY_COLUMNS = ["runtime_marker", "build_sha", "voice_model"] as const;

export interface BuildIdentity {
  runtimeMarker: string;
  buildSha: string | null;
  voiceModel: string | null;
}

/** The build SHA this process was built from, or null. Read once. */
let cachedSha: string | null | undefined;
export function deployedBuildSha(read: () => { gitSha: string | null } = getBuildInfo): string | null {
  if (cachedSha === undefined) {
    const sha = read().gitSha;
    cachedSha = typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  }
  return cachedSha;
}

export function runtimeBuildIdentity(voiceModel: string | null | undefined): BuildIdentity {
  return {
    runtimeMarker: VOICE_RUNTIME_DEPLOY_MARKER,
    buildSha: deployedBuildSha(),
    voiceModel: voiceModel && voiceModel.trim() ? voiceModel.trim() : null,
  };
}

export function oldCoreBuildIdentity(): BuildIdentity {
  return { runtimeMarker: OLD_CORE_MARKER, buildSha: deployedBuildSha(), voiceModel: null };
}

/** The one statement. Exported so a test pins the never-overwrite rule. */
export const STAMP_SQL =
  "UPDATE call_logs SET " +
  "runtime_marker = COALESCE(runtime_marker, $2::text), " +
  "build_sha = COALESCE(build_sha, $3::text), " +
  "voice_model = COALESCE(voice_model, $4::text) " +
  "WHERE call_sid = $1::text";

export const COLUMNS_SQL =
  "SELECT count(*)::int AS n FROM information_schema.columns " +
  "WHERE table_schema = 'public' AND table_name = 'call_logs' " +
  "AND column_name IN ('runtime_marker', 'build_sha', 'voice_model')";

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

async function defaultQuery(text: string, params?: unknown[]): Promise<{ rows: any[] }> {
  const { pool } = await import("../../server/db");
  return pool.query(text, params);
}

const ABSENT_RECHECK_MS = 10 * 60_000;

export interface ColumnCheck {
  present(): Promise<boolean>;
}

/** Present is remembered for the life of the process; absent or unreadable is
 * re-checked after ten minutes, so a migration applied after the publish is
 * picked up. Announces absence once. */
export function createColumnCheck(
  query: Query = defaultQuery,
  now: () => number = Date.now,
): ColumnCheck {
  let known: boolean | null = null;
  let checkedAt = 0;
  let inflight: Promise<boolean> | null = null;
  let announced = false;
  return {
    async present() {
      if (known === true) return true;
      if (known === false && now() - checkedAt < ABSENT_RECHECK_MS) return false;
      if (!inflight) {
        inflight = (async () => {
          try {
            const { rows } = await query(COLUMNS_SQL);
            known = Number(rows[0]?.n) === BUILD_IDENTITY_COLUMNS.length;
          } catch {
            known = false;
          }
          checkedAt = now();
          if (!known && !announced) {
            announced = true;
            console.warn("[build-identity] columns absent; not stamping");
          }
          if (known && announced) console.info("[build-identity] columns present; stamping");
          inflight = null;
          return known;
        })();
      }
      return inflight;
    },
  };
}

const sharedCheck = createColumnCheck();

export interface StampDeps {
  query?: Query;
  check?: ColumnCheck;
}

/** Write the identity onto the call's row. Never throws. Returns whether the
 * statement ran (for tests and the one console line). */
export async function stampBuildIdentity(
  callSid: string,
  identity: BuildIdentity,
  deps: StampDeps = {},
): Promise<boolean> {
  try {
    if (!callSid) return false;
    const check = deps.check ?? sharedCheck;
    if (!(await check.present())) return false;
    await (deps.query ?? defaultQuery)(STAMP_SQL, [
      callSid,
      identity.runtimeMarker,
      identity.buildSha,
      identity.voiceModel,
    ]);
    return true;
  } catch (error) {
    console.warn(
      `[build-identity] stamp failed for ${callSid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Test seam only. */
export function _resetBuildIdentityForTests(): void {
  cachedSha = undefined;
}
