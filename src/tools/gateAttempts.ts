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

import { isTwilioCallSid } from './callSid';

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
 * Returns 0 when there is no REAL CallSid to key on, which keeps the old
 * ask-every-time behaviour for those calls rather than letting one caller's
 * answer count for another's. Since 2026-09-01 a real CallSid reaches the
 * tools on every call (the model can no longer overwrite it), so that path is
 * the exception it looks like.
 *
 * A SENTINEL IS NOT A CALL — found by Codex on PR #244. `call_sid` is a
 * declared property, so a model with no injected value supplies "unknown" or
 * "latest", and a truthiness check makes every such call share one counter.
 * One optical caller refused for a missing office would then make the NEXT
 * sentinel-bearing call look already-asked, so it would skip the question and
 * file unassigned without ever asking. Validating the key restores the
 * documented ask-every-time fallback for those calls.
 */
export function gateRefusalsSoFar(callSid: string | undefined, tool: string, field: string): number {
  if (!isTwilioCallSid(callSid)) return 0;
  const entry = attempts.get(key(callSid, tool, field));
  if (!entry) return 0;
  if (Date.now() - entry.at > TTL_MS) return 0;
  return entry.n;
}

/** Record that we just refused this call for this field. Returns the new count. */
export function noteGateRefusal(callSid: string | undefined, tool: string, field: string): number {
  if (!isTwilioCallSid(callSid)) return 0;
  const now = Date.now();
  sweep(now);
  const k = key(callSid, tool, field);
  const n = (attempts.get(k)?.n ?? 0) + 1;
  attempts.delete(k); // re-insert so insertion order tracks recency
  attempts.set(k, { n, at: now });
  return n;
}

/**
 * A per-call FACT rather than a count — same map, so same TTL, same ceiling,
 * same recency eviction, same "a sentinel is not a call" rule.
 *
 * `dobEscape` kept its own module-global Set for one such fact and it had
 * none of those: production never removed an entry, the only clearing
 * function was test-only, and an unvalidated key meant "unknown" and "latest"
 * accumulated too. A voice process that stays up for weeks grows it forever
 * (Codex, PR #268 round 15). Anything per-call and boolean belongs here now,
 * where the bounding was already solved.
 */
const FACT_TOOL = "__fact";

/** Record a per-call fact. Ignored, like every write here, for a sentinel. */
export function noteCallFact(callSid: string | undefined, fact: string): void {
  noteGateRefusal(callSid, FACT_TOOL, fact);
}

/** Whether this call recorded that fact, within the TTL. */
export function callFactNoted(callSid: string | undefined, fact: string): boolean {
  return gateRefusalsSoFar(callSid, FACT_TOOL, fact) > 0;
}

/** Tests only. */
export function resetGateAttempts(): void {
  attempts.clear();
}
