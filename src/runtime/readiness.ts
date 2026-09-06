/**
 * src/runtime/readiness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Live-readiness for the voice runtime. "Live-ready" means this process
 * could take a REAL phone call end to end: authenticate Twilio's webhook,
 * open a Grok realtime session, and reach the database its agents' tools
 * and its own call record need.
 *
 * Missing config NEVER prevents the server from starting. It starts, serves
 * `GET /voice/health`, prints exactly which env var NAMES are missing (names
 * only — a readiness endpoint that leaks a value is a credential leak), and
 * the webhook fails CLOSED: a controlled unavailable response, never an
 * unauthenticated accept and never dead air.
 *
 * THE DEPLOY MARKER IS THE POINT OF THIS FILE.
 *
 * Wayne pulls and republishes on Replit, and a failed pull looks exactly
 * like a failed fix — on 2026-08-11 a GitHub rate limit made his pull fail
 * and the next round was spent analysing stale code. Every build prints the
 * marker below at boot and serves it from /voice/health. If the marker is
 * absent or old, the code is not live and the call proves nothing. Bump it
 * on every ship whose effect is hard to see.
 *
 * THE MARKER CARRIES A DATE BECAUSE THE DISCIPLINE ALONE FAILED.
 *
 * It read `voice-runtime-v2-transfer-guardrails-tools` from 2026-08-29 to
 * 2026-09-05, unchanged across every commit in between — including the one
 * that added the `[runtime] pre-context` diagnostic on 08-31. On 2026-09-05
 * the operator searched a live deployment for that line, found nothing, and
 * the marker could not say whether the build contained it: THE SAME STRING
 * is served by a build from before the line existed and by one from after.
 * An instrument that cannot separate those two is not an instrument, and
 * being one is this file's entire purpose.
 *
 * THE BUILD TURNED OUT TO BE CURRENT, WHICH IS THE STRONGER VERSION OF THE
 * POINT. It was established from `call_logs` instead: 405 grok rows carry an
 * `agent_id` the live process stamped itself (outside the 259-row backfill
 * snapshot), and that code merged 2026-09-04 — comfortably after 08-31. The
 * line was absent because the runtime had served NO CALLS that day, not
 * because it was missing. So the marker was useless in both directions: it
 * could not confirm the build and it could not exonerate it, and a database
 * query had to do the job this constant exists to do.
 *
 * So the marker ENDS IN THE YYYYMMDD IT WAS SET, and `markerSetOn` parses it
 * back out. "Is the deployed build newer than <date>?" is then answerable
 * from the marker alone, by anyone, without our commit history — which is
 * exactly the question that could not be answered above. The boot log and
 * `/voice/health` both carry it, so either one gives the same answer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { callEnvironment } from "./callRecord";

export const VOICE_RUNTIME_DEPLOY_MARKER =
  "voice-runtime-v3-precontext-diagnosable-20260905";

/**
 * The date the marker was set, parsed out of the marker itself so anyone can
 * compare a deployment against a date without our commit history. Returns
 * null if a future bump drops the suffix — `readiness.test.ts` fails on that,
 * so it cannot happen silently.
 *
 * IT ROUND-TRIPS THE COMPONENTS INSTEAD OF TRUSTING `Date.parse`, because
 * `Date.parse` NORMALISES an overflow rather than rejecting it: `2026-02-30`
 * parses happily as March 2. The first version of this validated with
 * `Date.parse` and the test that claimed to prove "a real calendar date, not
 * eight digits that merely look like one" would have passed a mistyped
 * `-20260230` (Codex, PR #272 round 3). A marker that reports a date the
 * calendar does not have is worse than one with no date, because it will be
 * believed. Constructing the UTC date and checking all three fields come
 * back unchanged is the only form that actually rejects.
 */
export function markerSetOn(marker: string = VOICE_RUNTIME_DEPLOY_MARKER): string | null {
  const m = /-(\d{4})(\d{2})(\d{2})$/.exec(marker);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  // Month 0, day 0, month 13, 31 September, 29 February in a common year:
  // every one of them survives Date.UTC by rolling into another month, and
  // every one of them fails here.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export interface RuntimeReadiness {
  liveReady: boolean;
  /** Env var NAMES (never values) that are missing. */
  missing: string[];
  /** Which DB env var this environment requires (mirrors config/environment.ts). */
  requiredDbEnvVar: "PRODUCTION_DATABASE_URL (or DATABASE_URL)" | "DATABASE_URL";
}

export function computeRuntimeReadiness(
  env: Record<string, string | undefined> = process.env,
): RuntimeReadiness {
  // The SAME non-throwing production detection the call record uses —
  // APP_ENV, NODE_ENV, REPLIT_DEPLOYMENT, published .replit.app domain.
  // Testing only NODE_ENV/REPLIT_DEPLOYMENT here classified a published
  // deployment (which the shared resolver treats as production, selecting
  // PRODUCTION_DATABASE_URL) as development and reported DATABASE_URL
  // missing — so the webhook served the unavailable TwiML for every call
  // of a completely configured deployment (Codex, PR #227 round 21).
  const isProduction = callEnvironment(env) === "production";
  // Mirrors getEnvironmentConfig() exactly, including its fallback: in
  // production PRODUCTION_DATABASE_URL is preferred and DATABASE_URL is
  // accepted with a warning. Readiness must agree with the code that
  // actually opens the connection, or it reports on a different program.
  const requiredDbEnvVar = isProduction
    ? ("PRODUCTION_DATABASE_URL (or DATABASE_URL)" as const)
    : ("DATABASE_URL" as const);

  const missing: string[] = [];
  // The voice itself. Without it there is no session to connect.
  if (!env.XAI_API_KEY) missing.push("XAI_API_KEY");
  // Webhook authentication. Without it every request is unauthenticated,
  // so the webhook refuses to serve a stream at all — see voiceWebhook.ts.
  if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  // The agents' tools read and write the practice's data, and the call
  // record is written at teardown. A process that can talk but cannot file
  // anything would take a real call and lose it: a controlled unavailable
  // message is the better outcome, and the caller is routed elsewhere.
  const hasDb = isProduction
    ? Boolean(env.PRODUCTION_DATABASE_URL || env.DATABASE_URL)
    : Boolean(env.DATABASE_URL);
  if (!hasDb) missing.push(requiredDbEnvVar);

  return { liveReady: missing.length === 0, missing, requiredDbEnvVar };
}

/** The two startup lines the runbook greps for. A function so the boot
 * test can assert the exact text without spawning a process. */
export function formatReadinessLines(readiness: RuntimeReadiness): string[] {
  const readyLine = readiness.liveReady
    ? "live-ready"
    : `NOT live-ready (missing: ${readiness.missing.join(", ")})`;
  return [`[voice-runtime] ${VOICE_RUNTIME_DEPLOY_MARKER}`, `[voice-runtime] ${readyLine}`];
}
