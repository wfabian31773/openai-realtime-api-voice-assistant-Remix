/**
 * THE SETUP-FAILURE FLOOR.
 *
 * A call that never reached a configured session used to end with the
 * caller hearing nothing and no ticket of any provenance — 15 live
 * failures of that shape, ~1 in 18 connections, ~40 silent drops on a
 * Monday once the queues open. The retry in providerConnect.ts absorbs
 * most of those. This is what runs when the retries do not.
 *
 * IT FILES WHEN, AND ONLY WHEN:
 *   - the outcome is `provider_failure` (the runtime caused the end), AND
 *   - the agent never spoke (`agentTurns === 0`), AND
 *   - the caller did not HANG UP before the first-event wait had elapsed
 *     (see SetupFailureContext), AND
 *   - the lane has a department we can file into.
 *
 * THE WAIT IS THE LINE BETWEEN A CALLER WE FAILED AND A CALLER WHO LEFT.
 * Inside the first-event wait (2.5 s by default) even a HEALTHY session has
 * not been declared late, so a caller who hung up by then was not failed by
 * the stall this floor exists for — they rang off before anything could
 * have answered. Measured over the floor's first 30 days (2026-10-07..09):
 * 4 tickets filed, and 3 of them were after-hours callers on the line for
 * 1–2 seconds (VA-68899, VA-68900, VA-69923) — callbacks with a stand-in
 * name to somebody who never waited. The fourth, a 14-second optical caller,
 * is exactly who the floor is for and still files.
 *
 * IT KEYS ON THE CALLER HANGING UP, NOT ON THE CALL'S LENGTH. A setup that
 * fails FAST on our side — the agent tree throwing, a lane that will not
 * bind — is also short, and that caller is still on the line hearing the
 * technical-trouble apology: we failed them, so they get the ticket. And
 * the record's own `endedAtMs` is when the runtime NOTICED, which for a
 * hangup during the first-event wait is the end of the wait, not the moment
 * the caller left — so the runtime hands over the moment the caller's
 * socket closed. No context, or no hangup, files: the fail-safe direction
 * is a ticket, not a skip.
 *
 * A caller who hung up while the agent was still being built is
 * `caller_hangup` and is not this floor — that path never opened a
 * provider socket. A hangup AFTER connect started is classified
 * `provider_failure` (mediaStreamBridge.noteProviderConnecting) so it
 * lands here rather than looking like an abandonment.
 *
 * THE NAME IS A STAND-IN. The app refuses a blank name everywhere and
 * only Medical Records accepts a missing one (v73). A setup failure has
 * no verified identity, so `Unnamed` / `Caller` keeps every department's
 * schema happy. The staff note says so.
 *
 * THE DESCRIPTION IS THE SWEEP'S. It is a patient-facing SMS body
 * (BACKEND_HANDOFF §6) and new caller-facing wording is Wayne's to
 * approve. The sweep's sentence already promises only a callback.
 *
 * Idempotency is `call-<sid>-setup-failure` so a later real filing on
 * the same SID cannot collide, and a teardown retry cannot open two.
 *
 * Never throws. Teardown must complete whatever happens here.
 */

import { otherReasonFor } from "../tools/otherReason";
import { SWEPT_TICKET_DESCRIPTION, TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS } from "./requestSweep";
import type { VoiceCallRecord } from "./mediaStreamBridge";
import { DEFAULT_FIRST_EVENT_TIMEOUT_MS } from "./providerConnect";

const DEPARTMENT_BY_SLUG: Record<string, number> = {
  optical: 1,
  surgery: 2,
  tech: 3,
  records: 16,
  pcp: 18,
  "no-ivr": 8,
};

const STAND_IN_FIRST = "Unnamed";
const STAND_IN_LAST = "Caller";

export const SETUP_FAILURE_STAFF_NOTE =
  "PROVIDER SETUP FAILED — the realtime session never started. " +
  "The caller heard the technical-trouble line (or hung up while we were " +
  "still connecting). Call them back. Name on this ticket is a stand-in; " +
  "caller ID is the number to ring.";

export type SetupFailureFiler = (ticket: {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  description: string;
  priority: "high";
  slug: string;
  callSid: string;
  staffNote: string;
  idempotencyKey: string;
  /** Optical and surgery only — the caller never reached a session, so
   * nobody could be asked for the office or the surgeon. */
  routingAskExhausted?: true;
}) => Promise<{ success: boolean; ticketNumber?: string; queued?: boolean; error?: string }>;

export type SetupFailureSkip =
  | "not-provider-failure"
  | "agent-spoke"
  | "left-before-the-first-event-wait"
  | "unknown-lane"
  | "no-other-reason"
  | "no-callback"
  | "create-failed"
  | "threw";

export interface SetupFailureOutcome {
  filed: boolean;
  reason?: SetupFailureSkip;
  ticketNumber?: string;
  queued?: boolean;
}

export function setupFailureIdempotencyKey(callSid: string): string {
  return `call-${callSid}-setup-failure`;
}

/**
 * What only the runtime knows about how the call ended. Both fields are
 * optional and their absence FILES — see the module doc.
 */
export interface SetupFailureContext {
  /**
   * Milliseconds from the stream starting to the CALLER's socket closing.
   * Undefined when the caller did not hang up (the runtime gave up first).
   */
  callerLeftAfterMs?: number;
  /** The first-event wait this call was configured with
   * (`RUNTIME_FIRST_EVENT_TIMEOUT_MS`); defaults to the module default. */
  firstEventWaitMs?: number;
}

export function shouldFileSetupFailure(
  record: VoiceCallRecord,
  ctx: SetupFailureContext = {},
): SetupFailureSkip | null {
  if (record.outcome !== "provider_failure") return "not-provider-failure";
  if (record.agentTurns > 0) return "agent-spoke";
  if (
    ctx.callerLeftAfterMs !== undefined &&
    ctx.callerLeftAfterMs < (ctx.firstEventWaitMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS)
  ) {
    return "left-before-the-first-event-wait";
  }
  if (DEPARTMENT_BY_SLUG[record.slug] === undefined) return "unknown-lane";
  if (!record.callerPhone) return "no-callback";
  return null;
}

const defaultFiler: SetupFailureFiler = async (ticket) => {
  const { createTicketDurable } = await import("../services/durableTicketFiling");
  const res = await createTicketDurable({
    departmentId: ticket.departmentId,
    requestTypeId: ticket.requestTypeId,
    requestReasonId: ticket.requestReasonId,
    patientFirstName: ticket.patientFirstName,
    patientLastName: ticket.patientLastName,
    patientPhone: ticket.patientPhone,
    preferredContactMethod: "phone",
    description: ticket.description,
    priority: ticket.priority,
    callData: {
      agentUsed: ticket.slug,
      callSid: ticket.callSid,
      transcript: ticket.staffNote,
    },
    idempotencyKey: ticket.idempotencyKey,
    ...(ticket.routingAskExhausted ? { routingAskExhausted: true } : {}),
  });
  const queued = (res as { queued?: boolean }).queued === true;
  return {
    success: Boolean((res.success && res.ticketNumber) || queued),
    ...(res.ticketNumber ? { ticketNumber: res.ticketNumber } : {}),
    ...(queued && !res.ticketNumber ? { queued: true } : {}),
    ...(res.error ? { error: res.error } : {}),
  };
};

export async function runSetupFailureFloor(
  record: VoiceCallRecord,
  filer: SetupFailureFiler = defaultFiler,
  ctx: SetupFailureContext = {},
): Promise<SetupFailureOutcome> {
  try {
    const skip = shouldFileSetupFailure(record, ctx);
    if (skip) {
      console.log(`[SETUP FLOOR] ${record.slug} ${record.callSid}: skipped (${skip})`);
      return { filed: false, reason: skip };
    }
    const departmentId = DEPARTMENT_BY_SLUG[record.slug]!;
    const other = otherReasonFor(departmentId);
    if (!other) {
      console.warn(`[SETUP FLOOR] ${record.slug}: no Other reason for department ${departmentId}`);
      return { filed: false, reason: "no-other-reason" };
    }
    const ticket = {
      departmentId,
      requestTypeId: other.requestTypeId,
      requestReasonId: other.requestReasonId,
      patientFirstName: STAND_IN_FIRST,
      patientLastName: STAND_IN_LAST,
      patientPhone: record.callerPhone,
      description: SWEPT_TICKET_DESCRIPTION,
      priority: "high" as const,
      slug: record.slug,
      callSid: record.callSid,
      staffNote: SETUP_FAILURE_STAFF_NOTE,
      idempotencyKey: setupFailureIdempotencyKey(record.callSid),
      // The same teardown rule as the sweep, from the same set: a session
      // that never started asked nobody anything, so on optical and surgery
      // the app's unassigned exit is the only way this ticket files at all.
      // 2026-10-08: the floor's one optical filing was refused for "office".
      ...(TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS.has(departmentId)
        ? { routingAskExhausted: true as const }
        : {}),
    };
    const res = await filer(ticket);
    if (res.success) {
      console.log(
        `[SETUP FLOOR] ${record.slug} ${record.callSid}: filed` +
          (res.ticketNumber ? ` ${res.ticketNumber}` : res.queued ? " (queued)" : ""),
      );
      return {
        filed: true,
        ...(res.ticketNumber ? { ticketNumber: res.ticketNumber } : {}),
        ...(res.queued ? { queued: true } : {}),
      };
    }
    console.warn(
      `[SETUP FLOOR] ${record.slug} ${record.callSid}: create-failed` +
        (res.error ? ` ${res.error}` : ""),
    );
    return { filed: false, reason: "create-failed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[SETUP FLOOR] ${record.slug} ${record.callSid}: threw ${message}`);
    return { filed: false, reason: "threw" };
  }
}
