/**
 * After-hours counterpart of PCP's registered teardown floor (v129).
 * Factories and sweeps share this module through static imports, as v90
 * requires. Admission reuses PCP's transcript guard; filing uses no-IVR's
 * existing per-call lock and call-<sid> idempotency key.
 */
import { storage } from '../../server/storage';
import { callerLines, saidMoreThanTheirOwnIdentity } from '../runtime/requestSweep';
import { confirmedClinicFor, verifiedIdentityFor } from '../tools/verifiedIdentity';
import { dobTheCallerGave, floorRequestType, officeTheCallerGave } from './afterHoursCallFacts';
import { AFTER_HOURS_DEPARTMENT_ID } from '../tools/afterHoursTaxonomy';
import { answeredWithoutTicket } from './answeredCallDisposition';
import { nameOrStandIn, STAND_IN_NAME_NOTE } from './standInName';
import { getAzulTimeline } from './toolTimeline';

interface AfterHoursCall {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  getTranscript?: () => string;
}

const calls = new Map<string, {
  metadata: AfterHoursCall;
  agentUsed: string;
  ticketFiled?: boolean;
  pendingFiling?: Promise<void>;
}>();

export function registerAfterHoursFloor(metadata: AfterHoursCall, agentUsed: string): void {
  calls.set(metadata.callId, { metadata, agentUsed });
}

/** Remember a successful live filing even if row write-back failed. */
export function markAfterHoursTicketFiled(callId: string): void {
  const call = calls.get(callId);
  if (call) call.ticketFiled = true;
}

/** Reserve before handoff can trigger teardown; settle even when filing fails. */
export function reserveAfterHoursTicketFiling(callId: string): (filed: boolean) => void {
  const call = calls.get(callId);
  if (!call) return () => {};
  let release!: () => void;
  call.pendingFiling = new Promise<void>((resolve) => { release = resolve; });
  return (filed) => {
    // Teardown may already have claimed/deleted the map entry, so update the
    // captured call rather than looking it up again by id.
    if (filed) call.ticketFiled = true;
    call.pendingFiling = undefined;
    release();
  };
}

export async function sweepAfterHoursUnfiledCall(
  callId: string,
  ctx: { outcome?: string; transcript?: string } = {},
): Promise<void> {
  const call = calls.get(callId);
  // Claim synchronously: concurrent/repeated teardown cannot file twice.
  calls.delete(callId);
  if (!call) return;
  try {
    // The urgent transfer owns the normal per-call key while it is pending.
    // A failed filing releases it so the floor can still recover the request.
    if (call.pendingFiling) await call.pendingFiling;
    if (call.ticketFiled) return;
    const { metadata, agentUsed } = call;
    // A real carrier SID is required for the normal filing path's dedup key.
    if (!metadata.callSid) return;
    const transcript = ctx.transcript || metadata.getTranscript?.() || '';
    const identity = verifiedIdentityFor(metadata.callSid);
    if (!saidMoreThanTheirOwnIdentity(transcript, identity)) return;

    const events = getAzulTimeline(callId) ?? [];
    if (answeredWithoutTicket({ events })) return;
    if (events.some(({ tool, outcome }) =>
      outcome.ticket_number || outcome.ticketNumber || outcome.filed_pending === true ||
      (tool === 'create_ticket' && outcome.success === true && outcome.ticketCreated !== false),
    )) return;
    const row = await storage.getCallLogBySid(metadata.callSid);
    if (row?.ticketNumber) return;

    const { fullName, standIn } = nameOrStandIn(identity?.firstName, identity?.lastName);
    const callerText = callerLines(transcript).join('\n');
    // v163: the date of birth the caller gave when asked (70150), the office
    // the caller confirmed or named when asked (no-IVR has no tool that fills
    // the confirmed store), and department 8's own request type — before this
    // the floor sent only a certain match's date, no office and no type.
    const spokenDob = identity?.dateOfBirth ? undefined : dobTheCallerGave(metadata.callSid, transcript);
    const clinic = confirmedClinicFor(metadata.callSid) ?? await officeTheCallerGave(transcript);
    const requestType = floorRequestType(callerText);
    const { SyncAgentService } = await import('./syncAgentService');
    const result = await SyncAgentService.submitSimplifiedTicket({
      patientFullName: fullName,
      patientDOB: identity?.dateOfBirth ?? spokenDob ?? 'Unknown',
      reasonForCalling: callerText,
      preferredContactMethod: 'phone',
      patientPhone: metadata.callerPhone,
      departmentId: AFTER_HOURS_DEPARTMENT_ID,
      ...(clinic ? { locationOfLastVisit: clinic, locationSource: 'caller' as const } : {}),
      // The department-8 pair, so the hint and the pinned department agree.
      suggestedRequestTypeId: requestType.requestTypeId,
      suggestedRequestReasonId: requestType.requestReasonId,
      suggestedRequestReason: requestType.requestReason,
      ...(requestType.urgent ? { suggestedUrgent: true } : {}),
      additionalDetails: [
        'AFTER-HOURS TEARDOWN: the call ended with a stated request and no recorded ticket. Please review the conversation and complete the request.',
        standIn ? STAND_IN_NAME_NOTE : undefined,
        spokenDob ? 'DATE OF BIRTH as the caller gave it on the call — not matched to a patient record.' : undefined,
      ].filter(Boolean).join('\n'),
      callSid: metadata.callSid,
      callerPhone: metadata.callerPhone,
      dialedNumber: metadata.dialedNumber,
      agentUsed,
      transcript,
    });
    console.info(`[AFTER-HOURS FLOOR] ${metadata.callSid}: ${result.success ? 'filed' : 'filing failed'}`);
  } catch {
    // Log the call reference only; service errors can contain patient data.
    console.error(`[AFTER-HOURS FLOOR] sweep failed for ${callId} (call already ended)`);
  }
}
