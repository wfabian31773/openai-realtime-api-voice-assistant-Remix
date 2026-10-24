/**
 * Stage C, step 3 — the Support Center reading of remix.filed_rate_independent.
 *
 * It goes through the Support Center's plugin API rather than a database
 * login (operator, 2026-10-22: "If i create a plug in for the support center,
 * you dont need all this"). The route, POST /api/plugin/v1/metrics/filing
 * (ticketing-app #375), runs the same per-call fold as SUPPORT_PROVENANCE_SQL
 * and answers counts-shaped booleans only — no ticket, no name, no phone.
 *
 * The token carries ONE scope, metrics:read. It cannot read a ticket or write
 * anything, so a leaked copy reveals only which call SIDs the agent filed for.
 *
 * Shaped as a `Query` so compute.ts is unchanged: it answers the provenance
 * read and refuses any other SQL, loudly, rather than pretend to run it.
 */
import { SUPPORT_PROVENANCE_SQL } from "./definitions";
import type { Query } from "./compute";

/** The route's own cap (ticketing-app lib/plugin/filing-provenance.ts MAX_CALL_SIDS). */
export const PLUGIN_MAX_CALL_SIDS = 500;
export const PLUGIN_FILING_PATH = "/api/plugin/v1/metrics/filing";
export const PLUGIN_TIMEOUT_MS = 15_000;

/**
 * The plugin base URL. LEARNING_SUPPORT_CENTER_URL wins; TICKETING_ENRICHMENT_URL
 * is the fallback because it is the direct-to-app base. TICKETING_SYSTEM_URL is
 * deliberately NOT read: it can point at n8n, which does not serve this route.
 */
export function supportCenterPluginBase(env: NodeJS.ProcessEnv): string {
  return (env.LEARNING_SUPPORT_CENTER_URL || env.TICKETING_ENRICHMENT_URL || "").trim().replace(/\/+$/, "");
}

export function supportCenterPluginQuery(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Query | undefined {
  const token = env.LEARNING_SUPPORT_CENTER_TOKEN?.trim();
  const base = supportCenterPluginBase(env);
  if (!token || !base) return undefined;
  const url = `${base}${PLUGIN_FILING_PATH}`;
  return async (text, params) => {
    if (text !== SUPPORT_PROVENANCE_SQL) {
      throw new Error("the Support Center plugin answers only the provenance read");
    }
    const callSids = (params?.[0] ?? []) as string[];
    if (!Array.isArray(callSids)) throw new Error("expected a list of call SIDs");
    if (callSids.length === 0) return { rows: [] }; // the route refuses an empty list
    if (callSids.length > PLUGIN_MAX_CALL_SIDS) {
      throw new Error(`more than ${PLUGIN_MAX_CALL_SIDS} call SIDs in one read`);
    }
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ callSids }),
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
    });
    // The status only — a body could echo something we do not want in run notes.
    if (!res.ok) throw new Error(`plugin answered HTTP ${res.status}`);
    const body = (await res.json()) as { calls?: unknown };
    if (!Array.isArray(body?.calls)) throw new Error("plugin answer had no calls list");
    // Every entry must be a call we asked about, with both flags real booleans.
    // A malformed entry is a read failure, never a quiet "not filed": mapping it
    // to an empty SID and false flags would score every call as unfiled and
    // store a valid-looking rate (Codex P1, #369). The message names the
    // problem only, never the entry.
    const asked = new Set(callSids);
    const rows = body.calls.map((c: unknown, i: number) => {
      const e = c as { callSid?: unknown; anyAgent?: unknown; anyUnknown?: unknown } | null;
      if (!e || typeof e !== "object") throw new Error(`plugin answer entry ${i} is not an object`);
      if (typeof e.callSid !== "string" || !asked.has(e.callSid)) {
        throw new Error(`plugin answer entry ${i} names a call that was not asked for`);
      }
      if (typeof e.anyAgent !== "boolean" || typeof e.anyUnknown !== "boolean") {
        throw new Error(`plugin answer entry ${i} has no boolean anyAgent/anyUnknown`);
      }
      return { call_sid: e.callSid, any_agent: e.anyAgent, any_unknown: e.anyUnknown };
    });
    return { rows };
  };
}
