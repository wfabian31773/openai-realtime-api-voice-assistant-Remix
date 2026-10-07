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
 *   - the lane has a department we can file into.
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
import { SWEPT_TICKET_DESCRIPTION } from "./requestSweep";
import type { VoiceCallRecord } from "./mediaStreamBridge";

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
}) => Promise<{ success: boolean; ticketNumber?: string; queued?: boolean; error?: string }>;

export type SetupFailureSkip =
  | "not-provider-failure"
  | "agent-spoke"
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

export function shouldFileSetupFailure(record: VoiceCallRecord): SetupFailureSkip | null {
  if (record.outcome !== "provider_failure") return "not-provider-failure";
  if (record.agentTurns > 0) return "agent-spoke";
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
): Promise<SetupFailureOutcome> {
  try {
    const skip = shouldFileSetupFailure(record);
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
