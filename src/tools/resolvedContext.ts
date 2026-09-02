/**
 * WHAT A TOOL ON THIS CALL HAS ALREADY RESOLVED.
 *
 * The sibling of `verifiedIdentity.ts`, for the two fields the ticketing API
 * hard-requires: the office and the surgeon. Same failure, same shape of fix.
 *
 * **The control that found it**, 2026-09-02, optical call
 * CA747908b5d46b7ed25cffe733fb792738 — its tool timeline in order:
 *
 *     lookup_patient (577ms, success)
 *     check_open_tickets
 *     classify_optical_request
 *     file_optical_ticket    -> refused, "Missing required information: office"
 *     resolve_location (3ms, { success: true, verified: true })
 *     file_optical_ticket    -> refused AGAIN, same missing office
 *
 * `resolve_location` verified the office and the very next filing call went out
 * without it. The request died in the outbox with the office in hand the whole
 * time. Four surgery requests died the same afternoon the same way, and on all
 * four `lookup_patient` had SUCCEEDED in under 300ms — so the provider ladder
 * in surgeryTools had a record to fall back to and the payload still carried no
 * surgeon.
 *
 * **Why:** `location` and `surgeon` are MODEL arguments. opticalTools.ts says
 * it outright — "The office, as returned by resolve_location." We ask the model
 * to carry one tool's result into the next tool's arguments, and it does not
 * reliably do it. Nothing on the server held the resolved value, so a gate that
 * was working perfectly refused a request we could already have filled in.
 *
 * That is the same twenty-line hand-off `verifiedIdentity.ts` was built for,
 * and this is deliberately the same narrow shape:
 *
 *  - Only a CERTAIN resolution is remembered. `resolve_location` reports
 *    `verified`, and an unverified guess is never stored — a ticket routed to
 *    the wrong office is worse than one routed by a human.
 *  - It is only ever read back for the SAME CALL, keyed on a real CallSid.
 *  - It NEVER replaces something the caller actually said. It fills a gap.
 *
 * In memory, for the length of one call, like `gateAttempts.ts` beside it.
 */

import { isTwilioCallSid } from './callSid';

interface Entry {
  /** The office name exactly as `resolve_location` returned it. */
  office?: string;
  /** A clinician the record shows for this patient, for the surgeon ladder. */
  provider?: string;
  at: number;
}

const resolved = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of resolved) {
    if (now - v.at > TTL_MS) resolved.delete(k);
  }
  if (resolved.size > MAX_ENTRIES) {
    let excess = resolved.size - MAX_ENTRIES;
    for (const k of resolved.keys()) {
      resolved.delete(k);
      if (--excess <= 0) break;
    }
  }
}

function remember(callSid: string | undefined, patch: Partial<Omit<Entry, 'at'>>): void {
  // THE KEY MUST BE A REAL CALLSID, for the reason spelled out in
  // verifiedIdentity.ts: `call_sid` is a declared property on these tools, so a
  // missing injected value becomes a model-supplied sentinel — "unknown",
  // "none", "latest" — and every call emitting the same sentinel would share
  // one entry. Here that would file one caller's request against another
  // caller's office. A call with no usable SID simply remembers nothing.
  if (!isTwilioCallSid(callSid)) return;
  const now = Date.now();
  sweep(now);
  const existing = resolved.get(callSid);
  const next: Entry = { ...existing, ...patch, at: now };
  resolved.delete(callSid);
  resolved.set(callSid, next);
}

/**
 * Remember an office `resolve_location` was CERTAIN about.
 *
 * `verified` is the tool's own word for "this matched a real Azul Vision
 * office", and an unverified guess is not stored: routing a ticket to the wrong
 * office is worse than leaving it for a human to route.
 */
export function rememberResolvedOffice(
  callSid: string | undefined,
  office: string | undefined,
  verified: boolean,
): void {
  const name = (office ?? '').trim();
  if (!name || !verified) return;
  remember(callSid, { office: name });
}

/** Remember a clinician the patient record actually holds. */
export function rememberResolvedProvider(
  callSid: string | undefined,
  provider: string | undefined,
): void {
  const name = (provider ?? '').trim();
  if (!name) return;
  remember(callSid, { provider: name });
}

function read(callSid: string | undefined): Entry | undefined {
  // Validated on the READ as well as the write — not because a sentinel could
  // be in the map, but so the rule survives someone later relaxing the write.
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = resolved.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry;
}

/** The office resolved on this call, or undefined. */
export function resolvedOfficeFor(callSid: string | undefined): string | undefined {
  return read(callSid)?.office;
}

/** The provider resolved on this call, or undefined. */
export function resolvedProviderFor(callSid: string | undefined): string | undefined {
  return read(callSid)?.provider;
}

/** Tests only. */
export function resetResolvedContext(): void {
  resolved.clear();
}

/**
 * Tests only — how many calls the store holds.
 *
 * Exposed because the WRITE guard is otherwise unobservable: the read guard
 * blocks a sentinel key too, so relaxing the write to a truthiness check
 * changes nothing any public read can see, and a mutation doing exactly that
 * survived the first pass. Defence in depth is only defence if both ends are
 * actually tested.
 */
export function resolvedContextSize(): number {
  return resolved.size;
}
