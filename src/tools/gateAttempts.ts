/**
 * HOW MANY TIMES THIS CALL HAS ALREADY BEEN ASKED FOR A FIELD.
 *
 * Operator ruling, 2026-09-01, on optical's office gate: *"if you gate the
 * location, the agent will ask and if no answer, unassigned."*
 *
 * A gate that only ever refuses is a gate that loses the request. Measured over
 * the 14 days to 2026-09-01: 107 calls reached a filing tool, were refused for
 * a missing field, and ended with no ticket at all — and **62 of those were
 * optical with the office as the only thing still missing**. The caller had
 * given their name, date of birth, callback number and the request. One 2026-08-13
 * call ran nine consecutive refusals over 236 seconds for an office we do not have.
 *
 * The tools are stateless and the model is not a reliable narrator of what it
 * has already asked, so the count lives here, keyed by CallSid. Ask once; if
 * the answer still does not resolve, file it.
 *
 * DELIBERATELY IN MEMORY. It exists for the length of one call, it is worthless
 * afterwards, and a database round trip inside a filing tool is latency a
 * caller hears. A process restart mid-call means the caller is asked once more,
 * which is the harmless direction to fail in.
 */

interface Attempt {
  n: number;
  at: number;
}

const attempts = new Map<string, Attempt>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;

/** A ceiling, in case something ever calls this with unbounded distinct keys. */
const MAX_ENTRIES = 5_000;

function key(callSid: string, tool: string, field: string): string {
  return `${callSid}|${tool}|${field}`;
}

function sweep(now: number): void {
  for (const [k, v] of attempts) {
    if (now - v.at > TTL_MS) attempts.delete(k);
  }
  if (attempts.size > MAX_ENTRIES) {
    // Oldest first. Map preserves insertion order, and an entry is only ever
    // re-inserted on write, so this drops the least recently touched.
    const excess = attempts.size - MAX_ENTRIES;
    let dropped = 0;
    for (const k of attempts.keys()) {
      attempts.delete(k);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * How many times this call has already been refused for this field.
 *
 * Returns 0 when there is no CallSid to key on, which keeps the old
 * ask-every-time behaviour for those calls rather than letting one caller's
 * answer count for another's. Since 2026-09-01 a real CallSid reaches the
 * tools on every call (the model can no longer overwrite it), so that path is
 * the exception it looks like.
 */
export function gateRefusalsSoFar(callSid: string | undefined, tool: string, field: string): number {
  if (!callSid) return 0;
  const entry = attempts.get(key(callSid, tool, field));
  if (!entry) return 0;
  if (Date.now() - entry.at > TTL_MS) return 0;
  return entry.n;
}

/** Record that we just refused this call for this field. Returns the new count. */
export function noteGateRefusal(callSid: string | undefined, tool: string, field: string): number {
  if (!callSid) return 0;
  const now = Date.now();
  sweep(now);
  const k = key(callSid, tool, field);
  const n = (attempts.get(k)?.n ?? 0) + 1;
  attempts.delete(k); // re-insert so insertion order tracks recency
  attempts.set(k, { n, at: now });
  return n;
}

/** Tests only. */
export function resetGateAttempts(): void {
  attempts.clear();
}
