/**
 * THE OFFICE THE CALLER NAMED ON THIS CALL, ONCE `resolve_location` HAS
 * VERIFIED IT — so the filing tool does not ask for it a second time.
 *
 * Found on the operator's own test call, 2026-10-29 (`CAe121c3c176d626e8a679536788e58d63`,
 * optical, pack-01 A1): the caller named an office, `resolve_location`
 * answered `verified: true`, and two tool calls later `file_optical_ticket`
 * refused for `location` and the agent asked "Which of our offices do you
 * usually visit?" again. The model had simply not passed the office it was
 * just handed. The filing tool reads its own argument and the patient's
 * record (`usualOfficeFor`), and nothing else, so an office the caller
 * confirmed on the call was invisible to it.
 *
 * Measured 2026-10-20..28 on optical: 27 calls took a `location` refusal
 * after `resolve_location` had verified an office on the same call. None of
 * them was lost, because the gate asks once and then files, but each one
 * asked the caller a question they had already answered — and that repeat is
 * what the caller hears.
 *
 * It is the date-of-birth carry's shape (`spokenDob`, `verifiedDobFor`): a
 * fact the call has already established fills the field the model left out.
 * An office the model DOES send still wins, and a later verified office
 * replaces an earlier one, because the caller's latest answer is the answer.
 *
 * Same bounding as `gateAttempts`: in memory, 30-minute TTL, a ceiling on
 * entries, and a sentinel CallSid is not a call. Imported STATICALLY by both
 * the writer (`resolve_location`) and the reader (`file_optical_ticket`) —
 * a dynamic import of a module that keeps a Map is the Node 20 two-copies
 * defect (v78, v90, v115, v141).
 */
import { isTwilioCallSid } from './callSid';

interface Entry {
  office: string;
  at: number;
}

const offices = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;

/** A ceiling, in case something ever writes unbounded distinct keys. */
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of offices) {
    if (now - v.at > TTL_MS) offices.delete(k);
  }
  if (offices.size > MAX_ENTRIES) {
    const excess = offices.size - MAX_ENTRIES;
    let dropped = 0;
    for (const k of offices.keys()) {
      offices.delete(k);
      if (++dropped >= excess) break;
    }
  }
}

/** Record the office `resolve_location` just verified for this call. */
export function rememberVerifiedOffice(callSid: string | undefined, office: string): void {
  if (!isTwilioCallSid(callSid) || !office.trim()) return;
  const now = Date.now();
  sweep(now);
  offices.delete(callSid); // re-insert so insertion order tracks recency
  offices.set(callSid, { office: office.trim(), at: now });
}

/** The office verified on this call, within the TTL — or undefined. */
export function verifiedOfficeFor(callSid: string | undefined): string | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = offices.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.office;
}

/** Tests only. */
export function resetVerifiedOffices(): void {
  offices.clear();
}
