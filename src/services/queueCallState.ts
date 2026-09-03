/**
 * WHAT THE FOUR QUEUE LANES ALREADY KNOW ABOUT THIS CALL.
 *
 * Optical, surgery, tech and records have no `terminate_call`. The call ends
 * when the caller hangs up, and until the hangup sweep the filing payload
 * existed only inside `file_*_ticket`. If that tool never ran, nothing had
 * the request.
 *
 * This is the in-memory carry the sweep reads. Same shape as
 * `verifiedIdentity` beside it: one call, one process, a TTL, never written
 * durable for the sake of a teardown. Tools already on the call write what
 * they resolved — classification, a verified office, a filing attempt —
 * and the sweep files from that instead of calling /lookup again.
 *
 * Re-resolving is how a ticket gets wiped: the 2026-08-31 n8n cap made
 * `/lookup` look like "no such office", and optical told 43 callers their
 * real office did not exist. The sweep must not reopen that.
 */

import { isTwilioCallSid } from '../tools/callSid';

/** The four live queue agents on Twilio today. Not answering-service. */
export const QUEUE_LANES = ['optical', 'surgery', 'tech', 'records'] as const;
export type QueueLane = (typeof QUEUE_LANES)[number];

export function isQueueLane(slug: string | null | undefined): slug is QueueLane {
  return (QUEUE_LANES as readonly string[]).includes(slug ?? '');
}

export const QUEUE_HOME_DEPARTMENT: Record<QueueLane, number> = {
  optical: 1,
  surgery: 2,
  tech: 3,
  records: 16,
};

export interface QueueCallState {
  agentSlug?: QueueLane;
  firstName?: string;
  lastName?: string;
  callbackNumber?: string;
  requestDescription?: string;
  departmentId?: number;
  requestTypeId?: number;
  requestReasonId?: number;
  /** Office `resolve_location` already verified. Carry; do not look up again. */
  verifiedLocation?: string;
  /** Usual office from a CERTAIN `lookup_patient` match. Fallback only. */
  usualOffice?: string;
  /** Provider name already on the call. Name only — no id, no re-resolve. */
  lastProvider?: string;
  filedTicketNumber?: string;
  filedPending?: boolean;
  existingOpenTicket?: string;
}

interface Entry extends QueueCallState {
  at: number;
}

const state = new Map<string, Entry>();

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;

function sweep(now: number): void {
  for (const [k, v] of state) {
    if (now - v.at > TTL_MS) state.delete(k);
  }
  if (state.size > MAX_ENTRIES) {
    let excess = state.size - MAX_ENTRIES;
    for (const k of state.keys()) {
      state.delete(k);
      if (--excess <= 0) break;
    }
  }
}

function compact<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined && v !== ''),
  ) as Partial<T>;
}

/**
 * Merge what this tool just learned onto the call. Silent without a real
 * CallSid — a sentinel key would join two callers the way verifiedIdentity
 * refused to.
 */
export function rememberQueueCall(
  callSid: string | undefined,
  patch: QueueCallState,
): void {
  if (!isTwilioCallSid(callSid)) return;
  const now = Date.now();
  sweep(now);
  const prev = state.get(callSid);
  state.set(callSid, {
    ...(prev ?? { at: now }),
    ...compact(patch),
    at: now,
  });
}

export function queueCallStateFor(callSid: string | undefined): QueueCallState | undefined {
  if (!isTwilioCallSid(callSid)) return undefined;
  const entry = state.get(callSid);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  const { at: _at, ...rest } = entry;
  return rest;
}

/** Tests only. */
export function resetQueueCallState(): void {
  state.clear();
}
