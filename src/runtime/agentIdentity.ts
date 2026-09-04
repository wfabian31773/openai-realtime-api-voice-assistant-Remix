/**
 * WHY A CALL_LOGS ROW NEEDS agent_id AND NOT JUST agent_used.
 *
 * Measured 2026-09-04 on the Operations Hub, over every call since 09-01:
 *
 *   pipeline            calls   rows carrying agent_id
 *   old core (SIP)        1315   1315  (100%)
 *   grok runtime           239      0  (NONE)
 *
 * The runtime opens its row with the lane slug and nothing else, and the
 * slug is not what anything reads. Every per-agent report in this app joins
 * the agents table on the uuid:
 *
 *   server/observatory/queries.ts  opsHubAgentScorecards, todayOverview
 *   server/routes.ts:2281          cost analytics, grouped by agent
 *   server/routes.ts:2463          quality and sentiment analytics
 *   server/routes.ts:257           the agents overview
 *   server/storage.ts:523          "show me this agent's calls"
 *
 * So at 15:24:58 UTC on 2026-09-03, the moment optical cut over, it stopped
 * existing in all five. Not wrong — ABSENT, which is worse, because an
 * absent lane looks like a quiet lane. That is what the operator meant by
 * *"the observatory isn't tracking these agents properly"*: the Observatory
 * is fine, the join key is missing.
 *
 * The schema anticipated exactly this and said so at shared/schema.ts:549 —
 * *"Actual agent slug used ... even if agentId is null"* — but a fallback
 * nothing implements is not a fallback. Rather than teach five call sites a
 * second join, the fix is here, at the one place the row is created.
 *
 * NOT a lookup per call: the agents table is 13 static rows, so a slug is
 * resolved once per process and remembered.
 */

/** Reads the agents table. Injectable so this module is testable without a database. */
export type AgentIdLookup = (slug: string) => Promise<string | undefined>;

/**
 * Resolutions so far, as promises rather than values — two calls arriving on
 * the same lane in the same second must not both query.
 */
const cache = new Map<string, Promise<string | undefined>>();

/** Slugs whose marker has already printed. One line per lane, not per call. */
const announced = new Set<string>();

/** Tests only. Production resolves each slug once for the life of the process. */
export function resetAgentIdCache(): void {
  cache.clear();
  announced.clear();
}

/**
 * DEPLOY MARKER, and the line that names the damage if a lane is missing.
 *
 * The success line prints once per lane on its first call after a deploy, so
 * seeing four of them is proof the build is live — the discipline in
 * CLAUDE.md, "how to tell whether a deploy actually took". Neither line
 * carries anything but a slug and a uuid; no PHI passes through here.
 */
export function agentIdMarker(slug: string, agentId: string | undefined): string {
  return agentId
    ? `[AGENT ID] ${slug} -> ${agentId}; call_logs.agent_id will be set on this lane `
      + `(it was NULL on every runtime call before this build)`
    : `[AGENT ID] no agents row for slug "${slug}" — call_logs.agent_id stays NULL, so this lane `
      + `is INVISIBLE in the Observatory scorecard and in every cost and quality report`;
}

async function defaultLookup(slug: string): Promise<string | undefined> {
  const [{ db }, { agents }, { eq }] = await Promise.all([
    import("../../server/db"),
    import("../../shared/schema"),
    import("drizzle-orm"),
  ]);
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, slug))
    .limit(1);
  return rows[0]?.id;
}

/**
 * How long a lookup may take before the call gives up on it.
 *
 * A BOUND, NOT A PREFERENCE. Codex found the failure on PR #268: a lookup
 * that never settles — a wedged connection pool is the ordinary way — was
 * cached as a pending promise for the life of the process. voiceRuntime's own
 * deadline stops WAITING for the call row; it does not cancel this, so every
 * later call on that lane awaited the same dead promise and never reached the
 * insert at all. The calls still connect, but their row is absent while their
 * tools run, and an absent row is not a cosmetic loss: flushAzulTimeline
 * marks its events flushed whether or not a row was there to update, so the
 * timeline is gone permanently.
 *
 * Well under the call-row deadline, because losing the join key costs a
 * report and losing the row costs the call's whole timeline.
 */
export const AGENT_ID_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * The agents-table uuid for a lane slug, or undefined when there is no row.
 *
 * Never throws and never blocks a call: a caller who cannot be attributed is
 * still a caller to be answered, and the row is written either way — just
 * without the join key, exactly as it is today.
 *
 * A MISS IS NOT CACHED, and neither is a TIMEOUT. If the slug is absent
 * because someone has yet to add the agents row, or because the database was
 * briefly unreachable, the next call must find it once that changes, without
 * a redeploy — and the marker keeps printing until then, which makes it a
 * live counter of the gap rather than a single line lost in the boot log.
 */
export async function resolveAgentId(
  slug: string,
  lookup: AgentIdLookup = defaultLookup,
  timeoutMs: number = AGENT_ID_LOOKUP_TIMEOUT_MS,
): Promise<string | undefined> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const pending = (async () => {
    try {
      return await lookup(slug);
    } catch (error) {
      console.error(`[AGENT ID] could not resolve slug "${slug}":`, error);
      return undefined;
    }
  })();
  cache.set(slug, pending);

  // The race is what makes the timeout real. Awaiting `pending` alone would
  // inherit the hang the bound exists to prevent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  const raced = await Promise.race([
    pending,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (raced === timedOut) {
    // Evict, so the NEXT call retries instead of inheriting this one's hang.
    // The abandoned promise is left to settle or not on its own; it holds
    // nothing but a row id and cannot wedge anything once it is unreferenced.
    if (cache.get(slug) === pending) cache.delete(slug);
    // Swallow a later rejection on the orphan — nothing is awaiting it now,
    // and an unhandled rejection would take the process down.
    void pending.catch(() => undefined);
    console.info(
      `[AGENT ID] lookup for "${slug}" exceeded ${timeoutMs}ms — this call's row is written ` +
        `without agent_id and the next call retries; the lane is missing from the Observatory ` +
        `and every cost and quality report until it succeeds`,
    );
    return undefined;
  }

  const resolved = raced;
  if (resolved === undefined) cache.delete(slug);
  if (resolved === undefined || !announced.has(slug)) {
    if (resolved !== undefined) announced.add(slug);
    console.info(agentIdMarker(slug, resolved));
  }
  return resolved;
}
