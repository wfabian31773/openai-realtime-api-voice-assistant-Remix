/**
 * Greeting enforcement — the database `agents.welcome_greeting` is the
 * single source of truth for how every agent opens a call.
 *
 * History: greetings were hardcoded per-route (voiceAgentRoutes) and in
 * per-agent config objects, while the `agents.welcome_greeting` column —
 * the thing the admin UI and the Observatory display — was written at seed
 * time and never read again. Worse, the greeting string travelled to the
 * delivery point via in-memory call metadata, which is lost whenever the
 * OpenAI webhook lands on a different instance than the one that stored
 * it — so on those calls the agent had NO script and improvised its
 * opening ("Thanks for your patience — let's get started…"). Diagnosed
 * live on four SD calls, 2026-08-06.
 *
 * This resolver closes both gaps: call setup asks here first (keyed on
 * the agent slug, which survives instance hops via SIP header / phone
 * lookup), and only falls back to the legacy hardcoded string when the
 * database has no value or cannot be reached. Every change to
 * `welcome_greeting` is captured by the `agent_change_log` triggers, so
 * greeting drift is now impossible to miss on the Observatory.
 *
 * Latency posture: the whole roster is preloaded at boot and refreshed in
 * the background (stale-while-revalidate) — the per-call path is a warm
 * Map read. A cold Neon connection can take 2–10s (see the phone-lookup
 * timeout note in voiceAgentRoutes); greetings must never eat that on a
 * live call.
 */
import { storage } from '../../server/storage';

const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;
const WARM_RETRY_MS = 30_000;

const cache = new Map<string, { value: string | null; fetchedAt: number }>();

async function fetchGreeting(agentSlug: string): Promise<string | null> {
  const agent = await storage.getAgentBySlug(agentSlug);
  return agent?.welcomeGreeting?.trim() || null;
}

/**
 * Returns the configured `welcome_greeting` for the agent, or null when
 * none is configured / the lookup fails — callers keep their existing
 * fallback greeting in that case. Never throws; a greeting lookup must
 * not be able to take down call setup.
 *
 * Cached entries are served immediately even past the TTL (a stale
 * greeting beats a silent line); expiry only triggers a background
 * refresh.
 */
export async function resolveConfiguredGreeting(agentSlug: string | undefined): Promise<string | null> {
  if (!agentSlug) return null;

  const hit = cache.get(agentSlug);
  if (hit) {
    if (Date.now() - hit.fetchedAt >= CACHE_TTL_MS) {
      void fetchGreeting(agentSlug)
        .then((value) => cache.set(agentSlug, { value, fetchedAt: Date.now() }))
        .catch(() => {
          /* keep serving the stale value; next expiry retries */
        });
      hit.fetchedAt = Date.now(); // one refresh in flight, not one per call
    }
    return hit.value;
  }

  try {
    const value = await Promise.race([
      fetchGreeting(agentSlug),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`greeting lookup timeout after ${LOOKUP_TIMEOUT_MS}ms`)), LOOKUP_TIMEOUT_MS),
      ),
    ]);
    cache.set(agentSlug, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    console.warn(
      `[GREETING] DB lookup failed for '${agentSlug}' — using fallback greeting:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Preload every agent's greeting so the first calls after a boot hit a
 * warm cache instead of racing a cold database connection. Safe to call
 * repeatedly; failures are logged and retried once by the boot hook.
 */
export async function warmGreetingCache(): Promise<boolean> {
  try {
    const agents = await storage.getAgents();
    const now = Date.now();
    for (const a of agents) {
      if (a.slug) cache.set(a.slug, { value: a.welcomeGreeting?.trim() || null, fetchedAt: now });
    }
    console.info(`[GREETING] Cache warmed for ${agents.length} agents`);
    return true;
  } catch (err) {
    console.warn('[GREETING] Cache warm failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Boot hook: warm shortly after startup, one retry if the DB wasn't ready. */
export function scheduleGreetingCacheWarm(): void {
  const attempt = setTimeout(() => {
    void warmGreetingCache().then((ok) => {
      if (!ok) {
        const retry = setTimeout(() => void warmGreetingCache(), WARM_RETRY_MS);
        retry.unref?.();
      }
    });
  }, 3_000);
  attempt.unref?.();
}

/** Test hook. */
export function clearGreetingCache(): void {
  cache.clear();
}
