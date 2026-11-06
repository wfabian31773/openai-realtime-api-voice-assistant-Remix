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
import { scheduleLookupService } from './scheduleLookupService';
import { AZUL_VISION_LOCATIONS, currentClinicName } from '../config/azulVisionKnowledge';
import type { TicketLocationSource } from '../tools/ticketIdentity';

/** Bound on the caller-ID history read at teardown; the caller is already gone. */
export const FLOOR_HISTORY_LOOKUP_TIMEOUT_MS = 2000;

/**
 * The ticket API has no review flag on `/submit-ticket` (its schema is strict,
 * so an unknown field risks a 400), so every floor ticket carries this line.
 */
export const FLOOR_NEEDS_REVIEW_NOTE =
  'NEEDS REVIEW — filed by the after-hours teardown floor, not by the agent.';
export const FLOOR_MISSING_LOCATION_NOTE =
  'MISSING LOCATION — no office was named, confirmed, found in the caller-ID visit history or matched to the number dialled.';
export const FLOOR_MISSING_IDENTITY_NOTE =
  'MISSING IDENTITY — stand-in name; no verified patient record on this call.';
export const FLOOR_HISTORY_LOCATION_NOTE =
  'LOCATION from the caller-ID visit history (the last office seen for the one patient on this number) — not confirmed by the caller.';
export const FLOOR_DIALED_LOCATION_NOTE =
  'LOCATION from the number dialled (an office line) — not confirmed by the caller.';

const last10 = (v?: string) => (v ?? '').replace(/\D/g, '').slice(-10);

/** The office whose public line was dialled, when exactly one office has it. */
export function officeForDialedNumber(dialedNumber?: string): string | undefined {
  const digits = last10(dialedNumber);
  if (digits.length !== 10) return undefined;
  const hits = AZUL_VISION_LOCATIONS.filter((loc) => last10(loc.phone) === digits);
  return hits.length === 1 ? hits[0].name : undefined;
}

/**
 * The last office seen for the ONE person on the caller's number. A number
 * shared by several people answers nothing: that office could be anyone's.
 * Routing only — the match is never written onto the ticket as an identity.
 *
 * Reads through `lookupPatient`, not `lookupByPhone`: the person base
 * (`patients_master`) answers first and its PersonID join brings the visit
 * history, so a caller whose number is only on their chart — not on any
 * appointment row — still yields their office (RULE ZERO step 1).
 */
export async function officeFromCallerHistory(
  callerPhone: string | undefined,
  callSid: string,
  timeoutMs = FLOOR_HISTORY_LOOKUP_TIMEOUT_MS,
): Promise<string | undefined> {
  if (last10(callerPhone).length !== 10) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const context = await Promise.race([
      scheduleLookupService.lookupPatient({
        phone: callerPhone!,
        deadlineAt: Date.now() + timeoutMs,
        logIdentifiers: false,
      }).catch(() => {
        console.warn(`[AFTER-HOURS FLOOR] ${callSid}: caller-ID history lookup failed`);
        return null;
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!context?.patientFound || context.identity?.unique === false) return undefined;
    return currentClinicName(context.lastLocationSeen) ?? undefined;
  } catch {
    console.warn(`[AFTER-HOURS FLOOR] ${callSid}: caller-ID history lookup failed`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const named = confirmedClinicFor(metadata.callSid) ?? await officeTheCallerGave(transcript);
    // v182: with no office named, try the one patient on the caller's number,
    // then the office line that was dialled. The ticket API accepts only
    // 'caller' | 'history', so a dialled-number office is sent as 'history'
    // (automatic, not caller-stated) and the staff note says where it came from.
    const fromHistory = named ? undefined : await officeFromCallerHistory(metadata.callerPhone, metadata.callSid);
    const fromDialed = named || fromHistory ? undefined : officeForDialedNumber(metadata.dialedNumber);
    const clinic = named ?? fromHistory ?? fromDialed;
    const locationSource: TicketLocationSource | undefined = named ? 'caller' : clinic ? 'history' : undefined;
    const requestType = floorRequestType(callerText);
    const { SyncAgentService } = await import('./syncAgentService');
    const result = await SyncAgentService.submitSimplifiedTicket({
      patientFullName: fullName,
      patientDOB: identity?.dateOfBirth ?? spokenDob ?? 'Unknown',
      reasonForCalling: callerText,
      preferredContactMethod: 'phone',
      patientPhone: metadata.callerPhone,
      departmentId: AFTER_HOURS_DEPARTMENT_ID,
      ...(clinic && locationSource ? { locationOfLastVisit: clinic, locationSource } : {}),
      // The department-8 pair, so the hint and the pinned department agree.
      suggestedRequestTypeId: requestType.requestTypeId,
      suggestedRequestReasonId: requestType.requestReasonId,
      suggestedRequestReason: requestType.requestReason,
      ...(requestType.urgent ? { suggestedUrgent: true } : {}),
      additionalDetails: [
        FLOOR_NEEDS_REVIEW_NOTE,
        'AFTER-HOURS TEARDOWN: the call ended with a stated request and no recorded ticket. Please review the conversation and complete the request.',
        clinic ? undefined : FLOOR_MISSING_LOCATION_NOTE,
        fromHistory ? FLOOR_HISTORY_LOCATION_NOTE : undefined,
        fromDialed ? FLOOR_DIALED_LOCATION_NOTE : undefined,
        standIn ? FLOOR_MISSING_IDENTITY_NOTE : undefined,
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
