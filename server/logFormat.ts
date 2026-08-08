/**
 * Single-line log formatting.
 *
 * `console.log('msg:', { ...fields })` looks fine locally but is what turned
 * the hosted logs into a wall of `undefined`. Two things go wrong:
 *
 *   1. Node's inspector prints every key, including ones whose value is
 *      `undefined` — so an endpoint with 12 optional filters logs 12 lines,
 *      10 of them `undefined`, even when the caller passed no filters at all.
 *   2. The log collector ingests one record per line and orders records by
 *      timestamp. A multi-line dump is split, and lines sharing a millisecond
 *      come back in arbitrary order — which is why the closing `}` shows up
 *      above the fields it closes, and two concurrent requests interleave.
 *
 * Keeping each log event on one line fixes both: unset fields disappear and
 * the collector has nothing to shred or reorder.
 */

/**
 * Render fields as a single `key=value` line, dropping keys that are unset.
 * Returns `'(none)'` when every field is unset, so the caller never emits a
 * dangling label.
 */
export function formatLogFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;

    if (value instanceof Date) {
      parts.push(`${key}=${value.toISOString()}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      const str = String(value);
      // Quote anything with whitespace so the pairs stay parseable.
      parts.push(`${key}=${/\s/.test(str) ? JSON.stringify(str) : str}`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : '(none)';
}

/**
 * Suppress repeat log lines for polled endpoints.
 *
 * The live-call dashboards poll `/api/call-logs` every 3 seconds, so an
 * unconditional log emits ~29k lines a day per open tab and buries everything
 * else. The gate lets a line through when its outcome changes, and otherwise
 * only once per `windowMs`, so state transitions stay visible while the
 * steady state stays quiet.
 *
 * @param windowMs how long an unchanged outcome stays suppressed
 * @param maxKeys  cap on tracked keys before the stalest are evicted
 */
export function createRepeatLogGate(windowMs = 60_000, maxKeys = 200) {
  const lastLogged = new Map<string, { outcome: string; at: number }>();

  return function shouldLog(key: string, outcome: string, now: number): boolean {
    const previous = lastLogged.get(key);
    if (previous && previous.outcome === outcome && now - previous.at < windowMs) {
      return false;
    }

    if (lastLogged.size >= maxKeys && !lastLogged.has(key)) {
      for (const [staleKey, entry] of lastLogged) {
        if (now - entry.at >= windowMs) lastLogged.delete(staleKey);
      }
      // Still full (everything is recent) — drop the oldest insertion.
      if (lastLogged.size >= maxKeys) {
        const oldest = lastLogged.keys().next();
        if (!oldest.done) lastLogged.delete(oldest.value);
      }
    }

    lastLogged.set(key, { outcome, at: now });
    return true;
  };
}
