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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { callEnvironment } from "./callRecord";

export const VOICE_RUNTIME_DEPLOY_MARKER = "voice-runtime-v2-transfer-guardrails-tools";

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
  // Added with task #54. The runtime starts Twilio's call recording over REST
  // on the inbound path, and the greeting promises that recording — so a line
  // without the means to make one is not ready to answer. Nothing in the
  // runtime made a REST call inbound before this, which is why the account sid
  // was not already required alongside the auth token.
  if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
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
