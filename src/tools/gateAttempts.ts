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
  /** Attempts claimed before their response is in — see claimGateAttempt. */
  pending?: number;
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
  const prev = attempts.get(k);
  const n = (prev?.n ?? 0) + 1;
  attempts.delete(k); // re-insert so insertion order tracks recency
  attempts.set(k, { n, at: now, pending: prev?.pending ?? 0 });
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
/** Waiters parked on a key until no attempt on it is in flight. */
const settlementWaiters = new Map<string, Array<() => void>>();

/**
 * A claim never waits longer than this for ANY ONE attempt ahead of it, and
 * `settleGateAttempt` runs on every path that reaches a response — this is
 * the floor under a settle that never comes, not a budget anyone should
 * reach. It sits ABOVE the longest attempt the production create path can
 * legitimately take: two 3 s health probes, the 500 ms retry delay and the
 * 15 s POST come to about 21.5 s (`ticketingApiClient`), so a bound that
 * passes means a settle was lost and nothing else (Codex, #321 round 18). It
 * is PER PREDECESSOR, re-armed by every settle: one deadline for the whole
 * queue released the third of a batch while its second predecessor was still
 * inside its own POST, so it read one refusal where there were two and the
 * exit did not fire — the lost-third-attempt case this claim exists to close
 * (Codex P2, #321 round 17).
 */
export const GATE_SETTLEMENT_WAIT_MS = 25_000;

/**
 * Claims on a key are QUEUED and released ONE AT A TIME. Every waiter used to
 * start its own bound on arrival, so a single predecessor that outlasted the
 * bound released all of them at once — the second and third of a batch both
 * claimed before the first had answered, and the third could again send no
 * flag (Codex P2, #321 round 18). Now a claim waits for the claim ahead of it
 * to finish claiming (or give up) before its own wait even starts, so a bound
 * that passes releases exactly one waiter and the one behind it still waits
 * for what the released one draws. The total a claim can wait is therefore
 * one bound for a stuck predecessor plus the REAL duration of the attempts
 * that answer — never a bound per queued claim (see `abandonInFlight`).
 */
const claimQueues = new Map<string, Promise<void>>();

/**
 * The bound passed with no settle: the attempt this claim was waiting on is
 * let go of, so nobody queued behind waits on it AGAIN. Without this a stuck
 * first attempt cost every later claim its own full bound — the third of a
 * batch waited two bounds, 50 s, and the runtime's tool-dispatch watchdog
 * (`DEFAULT_DEAD_AIR_MS + TOOL_DISPATCH_GRACE_MS` in `mediaStreamBridge`,
 * 45 s) tore the call down first (Codex P2, #321 round 19). Now a stuck
 * attempt is waited on ONCE, by the claim directly behind it; the claims
 * behind that wait only for what actually answers. A settle that arrives
 * late for the abandoned attempt is clamped at zero, which can only wake a
 * later claim EARLY — a smaller count, never a false flag.
 */
function abandonInFlight(k: string): void {
  const prev = attempts.get(k);
  if (!prev) return;
  attempts.delete(k);
  attempts.set(k, { ...prev, pending: Math.max(0, (prev.pending ?? 0) - 1) });
}

/**
 * Park until the next settle on this key, or until the bound passes with no
 * settle at all. True means a settle woke us; false means the bound did — the
 * waiter takes itself off the list on the way out, so a settle that arrives
 * later wakes nobody who has already gone.
 */
function waitForSettlement(k: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      const left = (settlementWaiters.get(k) ?? []).filter((w) => w !== wake);
      if (left.length) settlementWaiters.set(k, left);
      else settlementWaiters.delete(k);
      abandonInFlight(k);
      resolve(false);
    }, GATE_SETTLEMENT_WAIT_MS);
    (timer as { unref?: () => void }).unref?.();
    settlementWaiters.set(k, [...(settlementWaiters.get(k) ?? []), wake]);
  });
}

function wakeSettlementWaiters(k: string): void {
  const waiting = settlementWaiters.get(k);
  if (!waiting) return;
  settlementWaiters.delete(k);
  for (const wake of waiting) wake();
}

/**
 * Claim an attempt BEFORE it is dispatched — after every attempt ahead of it
 * on this key has answered. Returns the CONFIRMED refusals on the record at
 * that moment, then counts this attempt as in flight so the next claimant
 * waits in turn. Concurrent attempts are therefore ORDERED: the third of a
 * batch reads what the first two actually drew, not a presumption about them.
 *
 * Why the wait rather than counting attempts in flight — measured 2026-09-17
 * on surgery: every lost call that reached a third filing attempt had fired
 * its attempts 1–100 ms apart, in one model response, and a counter noted
 * only after each response read 0 on all three (`surgeonAskExhausted`,
 * surgeryTools.ts). Counting the in-flight attempts as refusals fixed that
 * and opened the door Codex named on #321 round 16: a batch whose first two
 * answered 503, or refused another field, would have flagged its third —
 * the exit spent on an ask the caller never heard. Waiting closes it: only
 * a settled refusal for THIS field is ever read.
 *
 * Settle with `settleGateAttempt` once the response is in. An outage or a
 * refusal for another field leaves the count alone, so for SEQUENTIAL
 * attempts the rules are exactly what `gateRefusalsSoFar` + `noteGateRefusal`
 * gave.
 */
export async function claimGateAttemptAfterSettlement(
  callSid: string | undefined,
  tool: string,
  field: string,
): Promise<number> {
  if (!isTwilioCallSid(callSid)) return 0;
  const k = key(callSid, tool, field);
  // Take a place in the queue: this claim's wait starts only once the claim
  // ahead of it has claimed or given up — see claimQueues.
  let claimed!: () => void;
  const gate = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  const ahead = claimQueues.get(k) ?? Promise.resolve();
  const tail = ahead.then(() => gate);
  claimQueues.set(k, tail);
  await ahead;
  try {
    // One bounded wait PER attempt ahead of this one — see GATE_SETTLEMENT_WAIT_MS.
    // A settle that never comes releases the claim; a settle that does re-arms
    // the bound for the next predecessor, so the wait grows with the queue and
    // never with the clock.
    while ((attempts.get(k)?.pending ?? 0) > 0) {
      const settled = await waitForSettlement(k);
      if (!settled) break;
    }
    const now = Date.now();
    sweep(now);
    const prev = attempts.get(k);
    const fresh = prev && now - prev.at <= TTL_MS ? prev : undefined;
    attempts.delete(k);
    attempts.set(k, { n: fresh?.n ?? 0, at: now, pending: (fresh?.pending ?? 0) + 1 });
    return fresh?.n ?? 0;
  } finally {
    claimed();
    if (claimQueues.get(k) === tail) claimQueues.delete(k);
  }
}

/** The other half of `claimGateAttemptAfterSettlement`: the attempt has answered. */
export function settleGateAttempt(
  callSid: string | undefined,
  tool: string,
  field: string,
  refused: boolean,
): void {
  if (!isTwilioCallSid(callSid)) return;
  const k = key(callSid, tool, field);
  const prev = attempts.get(k);
  if (!prev) return;
  const pending = Math.max(0, (prev.pending ?? 0) - 1);
  attempts.delete(k);
  attempts.set(k, { n: prev.n + (refused ? 1 : 0), at: Date.now(), pending });
  if (pending === 0) wakeSettlementWaiters(k);
}

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
  claimQueues.clear();
  for (const k of [...settlementWaiters.keys()]) wakeSettlementWaiters(k);
}
