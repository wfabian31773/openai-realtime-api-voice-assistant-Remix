/**
 * THE NAME THE CALLER GAVE, AS THE AGENT'S OWN TOOLS RECEIVED IT.
 *
 * Operator, 2026-10-29: *"we should not be filing nameless tickets but we also
 * need to make sure that we did not get the name in transcripts nor did we
 * match the phone number to a patient on lookup."*
 *
 * The teardown sweep (`requestSweep.ts`) files a request the agent did not,
 * and its "no name, no ticket" rule (2026-09-03) read only `verifiedIdentity`,
 * which holds a CERTAIN lookup match. A name the caller said out loud, which
 * the model then handed to `lookup_patient` or a filing tool, did not count.
 * Measured 2026-10-20..28 on optical, surgery and tech: of 152 heard calls
 * that ended with no ticket of any provenance, 101 had the caller's identity
 * in hand, and the sweep filed none of them. On 31 of the 152 a tool had
 * received the name: a filing refused for the date of birth, the office or
 * the surgeon after the name was given, or a lookup run more than once.
 *
 * So this keeps the last first and last name a name-taking tool received on
 * the call, and the sweep reads it when no certain match exists. It is NOT a
 * name detector and reads no transcript (standing instruction 3): the model
 * extracted the name from what the caller said, and this only keeps what the
 * model already sent. A stated name is not a verified one, and the swept
 * ticket says so.
 *
 * In memory, for one call, like `verifiedIdentity.ts` beside it: patient data
 * with no business being written anywhere durable.
 */

import { isTwilioCallSid } from './callSid';
import { appWouldRefuseName } from '../services/standInName';

export interface StatedName {
  firstName: string;
  lastName: string;
}

interface Entry {
  firstName?: string;
  lastName?: string;
  at: number;
}

const stated = new Map<string, Entry>();

/** Longer than any call, short enough that the map cannot become a leak. */
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

/**
 * The tools whose `first_name` / `last_name` arguments are the patient's
 * name as the caller gave it. Each lane's filing tool, and the lookup the
 * queue lanes run once the caller has said who they are.
 */
export const STATED_NAME_TOOLS: ReadonlySet<string> = new Set([
  'lookup_patient',
  'file_optical_ticket',
  'file_surgery_ticket',
  'file_tech_ticket',
  'file_records_ticket',
]);

/**
 * One name part as the tool received it, or nothing. Refused: blank, a
 * digit anywhere (a date or a phone number in the wrong field), and any
 * value the ticketing app itself refuses as a placeholder ("Unknown",
 * "Caller", "Patient").
 */
function usablePart(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/\s+/g, ' ');
  if (!t || /\d/.test(t)) return undefined;
  if (appWouldRefuseName(t)) return undefined;
  return t;
}

function sweep(now: number): void {
  for (const [k, v] of stated) {
    if (now - v.at > TTL_MS) stated.delete(k);
  }
  if (stated.size > MAX_ENTRIES) {
    let excess = stated.size - MAX_ENTRIES;
    for (const k of stated.keys()) {
      stated.delete(k);
      if (--excess <= 0) break;
    }
  }
}

/**
 * Keep the name parts a name-taking tool was called with, before the tool
 * validates or refuses anything: a filing refused for the date of birth
 * still received the name. A later call's part replaces an earlier one (a
 * caller who corrects their surname is believed the second time); a part a
 * call does not carry is left as it was.
 */
export function noteStatedNameFromArgs(tool: string, input: Record<string, unknown>): void {
  if (!STATED_NAME_TOOLS.has(tool)) return;
  const callSid = typeof input.call_sid === 'string' ? input.call_sid : undefined;
  if (!isTwilioCallSid(callSid)) return;
  const first = usablePart(input.first_name);
  const last = usablePart(input.last_name);
  if (!first && !last) return;
  const now = Date.now();
  sweep(now);
  const prior = stated.get(callSid!);
  const fresh = prior && now - prior.at <= TTL_MS ? prior : undefined;
  stated.set(callSid!, {
    firstName: first ?? fresh?.firstName,
    lastName: last ?? fresh?.lastName,
    at: now,
  });
}

/** Both names as the caller gave them on this call, or nothing. */
export function statedNameFor(callSid: string | undefined): StatedName | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = stated.get(callSid!);
  if (!entry || Date.now() - entry.at > TTL_MS) return undefined;
  if (!entry.firstName || !entry.lastName) return undefined;
  return { firstName: entry.firstName, lastName: entry.lastName };
}

/** Tests only. */
export function resetStatedNames(): void {
  stated.clear();
}
