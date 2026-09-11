/**
 * THE OFFICE THIS CALL ALREADY RESOLVED.
 *
 * The sibling of `verifiedIdentity.ts`, written one day after it (2026-09-01
 * and 2026-09-02) for the same failure in a different field.
 *
 * **The control**, optical call CA747908b5d46b7ed25cffe733fb792738 — its tool
 * timeline in order:
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
 * time.
 *
 * **Why:** `location` is a MODEL argument — opticalTools.ts says it outright,
 * "The office, as returned by resolve_location." We ask the model to carry one
 * tool's result into the next tool's arguments and it does not reliably do it.
 * Nothing on the server held the value, so a gate that was working perfectly
 * refused a request we could already have filled in.
 *
 * SCOPE — OPTICAL ONLY, and read this before widening it:
 *
 *  - Four surgery requests died the same afternoon and they are NOT the same
 *    shape. I claimed they were and retracted it (Cursor, PR #253). Surgery
 *    does not gate on location at all, so a missing office was never why they
 *    died — a missing SURGEON was. Worse, `resolveWith` ANDs `cleanLocation`
 *    into every `/lookup`, so carrying an office there would narrow the
 *    surgeon ladder on the one queue that most needs it.
 *  - `rememberResolvedProvider` exists and is deliberately UNWIRED. The
 *    surgeon carry needs the four timelines measured first — matched_by,
 *    whether the ladder ran, whether name+DOB on the filing call agreed with
 *    the lookup. See #48. Do not wire it in the dark.
 *
 * THE GUARDS, all three load-bearing:
 *
 *  - Only a resolution this queue can actually FILE TO is stored.
 *    `verified` means the Console directory hit; `usable_for_this_queue` is
 *    computed separately, and a surgery centre spoken to optical is the first
 *    and not the second.
 *  - Read back only for the SAME CALL, keyed on a real CallSid.
 *  - Optical applies it only on the SECOND attempt, after its gate has already
 *    asked. The carry is last-write-wins with no "is this still what the caller
 *    said" check, and optical assigns BY office, so on a first attempt it could
 *    file an office the caller had since corrected. Wayne's ruling decides
 *    which way to err: unassigned is sanctioned, a wrong building is not.
 *
 * In memory, for the length of one call, like `gateAttempts.ts` beside it.
 */

import { isTwilioCallSid } from './callSid';

interface Entry {
  /** The office name exactly as `resolve_location` returned it. */
  office?: string;
  /** UNWIRED — see the scope note above. Nothing writes this in production. */
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
 * The caller passes `verified && usable`, NOT `verified` alone: `verified` is
 * only the Console directory hit, and a surgery centre spoken to optical is
 * verified and unusable. Routing a ticket to a building this queue cannot file
 * to is worse than leaving it for a human to route.
 */
export function rememberResolvedOffice(
  callSid: string | undefined,
  office: string | undefined,
  fileable: boolean,
): void {
  const name = (office ?? '').trim();
  if (!name || !fileable) return;
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
