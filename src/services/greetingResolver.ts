/**
 * Greeting enforcement — the database `agents.welcome_greeting` is the
 * single source of truth for how every agent opens a call.
 *
 * History: greetings were hardcoded per-route (voiceAgentRoutes) and in
 * per-agent config objects, while the `agents.welcome_greeting` column —
 * the thing the admin UI and the Observatory display — was written at seed
 * time and never read again. Editing the config changed nothing on the
 * phone, which surfaced as "someone wiped away the greeting" (2026-08-06).
 *
 * This resolver closes that gap: call setup asks here first, and only
 * falls back to the legacy hardcoded string when the database has no
 * value or cannot be reached within the timeout. Every change to
 * `welcome_greeting` is captured by the `agent_change_log` triggers, so
 * greeting drift is now impossible to miss on the Observatory.
 */
import { storage } from '../../server/storage';

const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;

const cache = new Map<string, { value: string | null; fetchedAt: number }>();

/**
 * Returns the configured `welcome_greeting` for the agent, or null when
 * none is configured / the lookup fails — callers keep their existing
 * fallback greeting in that case. Never throws; a greeting lookup must
 * not be able to take down call setup.
 */
export async function resolveConfiguredGreeting(agentSlug: string | undefined): Promise<string | null> {
  if (!agentSlug) return null;

  const hit = cache.get(agentSlug);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.value;
  }

  try {
    const agent = await Promise.race([
      storage.getAgentBySlug(agentSlug),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`greeting lookup timeout after ${LOOKUP_TIMEOUT_MS}ms`)), LOOKUP_TIMEOUT_MS),
      ),
    ]);
    const greeting = agent?.welcomeGreeting?.trim() || null;
    cache.set(agentSlug, { value: greeting, fetchedAt: Date.now() });
    return greeting;
  } catch (err) {
    console.warn(
      `[GREETING] DB lookup failed for '${agentSlug}' — using fallback greeting:`,
      err instanceof Error ? err.message : err,
    );
    // Do not cache failures for the full TTL: a stale hit (if any) stays
    // usable, and the next call retries the database.
    return hit ? hit.value : null;
  }
}

/** Test hook. */
export function clearGreetingCache(): void {
  cache.clear();
}
