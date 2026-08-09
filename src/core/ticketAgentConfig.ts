/**
 * Live config for the ticket agent — so tuning does not need a deploy.
 *
 * Operator directive 2026-08-09: "we have to do this in demo so we can test
 * rapidly", without republishing every time. Code shape stays in code; the
 * things you actually tune mid-test — what each intent needs, what the agent
 * says, the greeting — live in one database row per line and are re-read
 * every REFRESH_MS. Change the row, make the next call, hear the change.
 *
 * A missing or malformed row simply means "use the built-in defaults": this
 * can never take a line down.
 */
export interface LiveTicketConfig {
  /** intent key -> the fields that intent needs (overrides the built-in list). */
  intents?: Record<string, { needs?: string[]; department?: 1 | 2 | 3; label?: string }>;
  /** line key -> replacement text, English and Spanish. */
  lines?: Record<string, { en?: string; es?: string }>;
  greeting?: string;
}

const REFRESH_MS = 20_000;
const cache = new Map<string, { at: number; cfg: LiveTicketConfig }>();

export function cachedConfig(slug: string): LiveTicketConfig {
  return cache.get(slug)?.cfg ?? {};
}

/** Refresh in the background; never blocks or throws into a call. */
export function refreshConfig(slug: string): void {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < REFRESH_MS) return;
  cache.set(slug, { at: Date.now(), cfg: hit?.cfg ?? {} });
  void (async () => {
    try {
      const { pool } = await import('../../server/db');
      const { rows } = await pool.query(
        `SELECT intents, lines, greeting FROM ticket_agent_config WHERE slug = $1 LIMIT 1`,
        [slug],
      );
      if (!rows.length) return;
      const r = rows[0] as { intents: unknown; lines: unknown; greeting: string | null };
      cache.set(slug, {
        at: Date.now(),
        cfg: {
          intents: (r.intents as LiveTicketConfig['intents']) ?? undefined,
          lines: (r.lines as LiveTicketConfig['lines']) ?? undefined,
          greeting: r.greeting ?? undefined,
        },
      });
      console.info(`[TICKET-AGENT] config refreshed for ${slug}`);
    } catch (e) {
      console.warn(`[TICKET-AGENT] config refresh failed for ${slug} (using defaults):`, e);
    }
  })();
}
