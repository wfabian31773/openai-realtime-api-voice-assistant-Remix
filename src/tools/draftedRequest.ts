/**
 * THE REQUEST AS THE MODEL WROTE IT, KEPT FOR THE TEARDOWN SWEEP — v166.
 *
 * Six voice calls between 2026-10-28 and 11-01 produced the ticketing app's
 * "Callback needed - reason not captured" ticket (its `no-reason.ts` keys on
 * the sweep's placeholder description). On several of them the model HAD
 * written the request down — in `request_description` on a classify or filing
 * tool the gate then refused (70298: the records tool refused the requester
 * field four times), or on a classify call before the caller hung up mid-
 * sentence (70230, 68501). The sweep then filed with nothing but the
 * placeholder, because nothing kept what the model had written.
 *
 * This keeps the LAST `request_description` a request-taking tool received on
 * the call, noted in `runTool` before validation (the `statedName.ts` shape),
 * so a refusal still leaves it behind. It is the model's own extraction of the
 * request — the same text every ordinary filing puts in the ticket's
 * description — never the transcript (standing instruction 3; the description
 * is an SMS body).
 *
 * In memory, one call, a TTL and a size cap, like `statedName.ts`.
 */
import { isTwilioCallSid } from './callSid';

/** The tools whose `request_description` is the caller's request. */
export const DRAFTED_REQUEST_TOOLS: ReadonlySet<string> = new Set([
  'classify_optical_request',
  'classify_surgery_request',
  'classify_tech_request',
  'classify_records_request',
  'file_optical_ticket',
  'file_surgery_ticket',
  'file_tech_ticket',
  'file_records_ticket',
]);

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;
/** Longer than any real request; a runaway argument is cut, not stored whole. */
export const DRAFTED_REQUEST_MAX_CHARS = 500;

const drafted = new Map<string, { text: string; at: number }>();

function prune(now: number): void {
  for (const [k, v] of drafted) if (now - v.at > TTL_MS) drafted.delete(k);
  if (drafted.size > MAX_ENTRIES) {
    let excess = drafted.size - MAX_ENTRIES;
    for (const k of drafted.keys()) {
      drafted.delete(k);
      if (--excess <= 0) break;
    }
  }
}

/** Note the request text a request-taking tool was called with. A later one replaces it. */
export function noteDraftedRequestFromArgs(tool: string, input: Record<string, unknown>): void {
  if (!DRAFTED_REQUEST_TOOLS.has(tool)) return;
  const callSid = typeof input.call_sid === 'string' ? input.call_sid : undefined;
  if (!isTwilioCallSid(callSid)) return;
  const raw = input.request_description;
  if (typeof raw !== 'string') return;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 3) return;
  const now = Date.now();
  prune(now);
  drafted.set(callSid!, { text: text.slice(0, DRAFTED_REQUEST_MAX_CHARS), at: now });
}

/** The latest request text the model wrote on this call, or nothing. */
export function draftedRequestFor(callSid: string | undefined): string | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = drafted.get(callSid!);
  if (!entry || Date.now() - entry.at > TTL_MS) return undefined;
  return entry.text;
}

/** Tests only. */
export function resetDraftedRequests(): void {
  drafted.clear();
}
