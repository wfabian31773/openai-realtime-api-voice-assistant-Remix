/**
 * After-hours counterpart of PCP's registered teardown floor (v129).
 * Factories and sweeps share this module through static imports, as v90
 * requires. Admission reuses PCP's transcript guard; filing uses no-IVR's
 * existing per-call lock and call-<sid> idempotency key.
 */
import { storage } from '../../server/storage';
import { callerLines, HEARD_NAME_NOTE, saidMoreThanTheirOwnIdentity } from '../runtime/requestSweep';
import { askModelForThePatientName, nameFromTheRecording, type NameAsker } from '../runtime/nameFromTheRecording';
import { askModelForTheRequest, readTheRequest, type RequestAsker } from '../runtime/requestFromTheRecording';
import { confirmedClinicFor, verifiedIdentityFor } from '../tools/verifiedIdentity';
import { dobTheCallerGave, floorRequestType, officeTheCallerGave } from './afterHoursCallFacts';
import { AFTER_HOURS_DEPARTMENT_ID } from '../tools/afterHoursTaxonomy';
import { answeredWithoutTicket } from './answeredCallDisposition';
import { nameOrStandIn, STAND_IN_NAME_NOTE } from './standInName';
import { getAzulTimeline } from './toolTimeline';
import { scheduleLookupService } from './scheduleLookupService';
import { AZUL_VISION_LOCATIONS, currentClinicName } from '../config/azulVisionKnowledge';
import type { TicketLocationSource } from '../tools/ticketIdentity';
import { afterHoursRecordsRequestFor, forgetAfterHoursRecordsRequest, MEDICAL_RECORDS_DEPARTMENT_ID, recordsRequesterPayload } from './afterHoursRecordsRequest';

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
/**
 * v190: a records request the escalation gate refused on this call files to
 * Medical Records, never After Hours, with who asked when the caller said it
 * (operator, 2026-11-09). Ticket #73052 was this call shape filed to After
 * Hours with no requester, and became a patient-clock case when staff moved it.
 */
export const FLOOR_RECORDS_NOTE =
  'MEDICAL RECORDS REQUEST — the caller asked for medical records and hung up before the agent filed it. Filed to Medical Records; records requests never ring the on-call (operator ruling 2026-11-09).';
export const FLOOR_DIALED_LOCATION_NOTE =
  'LOCATION from the number dialled (an office line) — not confirmed by the caller.';
/**
 * v276: the request reader could not run at teardown (no model key, the
 * reader switched off, the model failed, or it answered no usable field), so
 * the floor files a named caller as it did before v276 rather than lose a
 * request it cannot judge. A caller with no name is not filed either way.
 */
export const FLOOR_REQUEST_NOT_CONFIRMED_NOTE =
  'REQUEST NOT CONFIRMED — the request reader could not run at teardown, so this was filed as before so nothing is lost. Please review the conversation.';

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

/**
 * v239: THE PATIENT'S NAME THE CALLER SAID, WHEN NO LOOKUP MADE IT CERTAIN.
 * The queue lanes' teardown sweep has read it since v180; the after-hours
 * floor filed every one of these as "Unnamed Caller". The same reader with
 * the same rule: the v180 model reads the PATIENT's name, and the name is
 * kept only when the caller said both halves together in one of their own
 * turns. A model that answers nothing, a half, or a name the caller did not
 * say leaves the stand-in, exactly as before.
 *
 * Not v168's introduction rule: it reads only agent lines it recognises as a
 * plain prompt, the after-hours greeting is not one of them, so on this line
 * it can never fire. Not v182's calling-number owner: measured on the 26
 * after-hours stand-in tickets of 2026-11-08..14 it names none of them (eight
 * numbers are not on file, one carries two people), and on VA-84172 the
 * caller had just said no to that person's name. Nothing here is an
 * identity: the ticket says where the name came from.
 */
export async function nameForTheFloor(
  transcript: string,
  askName: NameAsker,
): Promise<{ firstName: string; lastName: string } | undefined> {
  return (await nameFromTheRecording(transcript, askName)) ?? undefined;
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
  ctx: {
    outcome?: string;
    transcript?: string;
    /** v239 seam. Production asks the model; tests pass their own reader. */
    askName?: NameAsker;
    /** v276 seam. Production asks the model; tests pass their own reader. */
    askRequest?: RequestAsker;
  } = {},
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

    const records = afterHoursRecordsRequestFor(metadata.callSid);
    forgetAfterHoursRecordsRequest(metadata.callSid);
    // v276 (operator, 2026-11-26): "We shouldnt be filing tickets unless we
    // can identify the patient and there is a valid request." The floor asks
    // the v201 reader whether the caller asked for anything; no request files
    // nothing, and a request with no patient identified (below) files nothing
    // either. A records request is not read: v190 and the CAP SOP log every
    // access request. A reader that could not run files a named caller as
    // before, with a note; a caller with no name files nothing (below).
    const reading = records
      ? undefined
      : await readTheRequest(
          transcript,
          ctx.askRequest ?? askModelForTheRequest,
          [identity?.firstName, identity?.lastName].filter(
            (n): n is string => typeof n === 'string' && n.trim().length > 0,
          ),
          metadata.callSid,
        );
    if (reading?.kind === 'none') {
      console.info(`[AFTER-HOURS FLOOR] ${metadata.callSid}: not filed — no request read from the recording`);
      return;
    }

    const callerText = callerLines(transcript).join('\n');
    // v163: the date of birth the caller gave when asked (70150), the office
    // the caller confirmed or named when asked (no-IVR has no tool that fills
    // the confirmed store), and department 8's own request type — before this
    // the floor sent only a certain match's date, no office and no type.
    const spokenDob = identity?.dateOfBirth ? undefined : dobTheCallerGave(metadata.callSid, transcript);
    // v239: with no certain identity, the patient's name as the caller said
    // it, before the stand-in.
    const found = identity
      ? undefined
      : await nameForTheFloor(transcript, ctx.askName ?? askModelForThePatientName);
    if (found) {
      console.info(`[AFTER-HOURS FLOOR] ${metadata.callSid}: named from the recording, unconfirmed`);
    }
    const { fullName, standIn } = nameOrStandIn(
      identity?.firstName ?? found?.firstName,
      identity?.lastName ?? found?.lastName,
    );
    // v276 (review of #526): the identity rule holds whatever the reader
    // answered, so a reader that could not run files only under a name. A
    // records request still files under the stand-in (v190, the CAP SOP).
    if (standIn && !records) {
      console.info(`[AFTER-HOURS FLOOR] ${metadata.callSid}: not filed — the patient was not identified`);
      return;
    }
    const named = confirmedClinicFor(metadata.callSid) ?? await officeTheCallerGave(transcript);
    // v184: with no office named, try the one patient on the caller's number,
    // then the office line that was dialled. The ticket API accepts only
    // 'caller' | 'history', so a dialled-number office is sent as 'history'
    // (automatic, not caller-stated) and the staff note says where it came from.
    const fromHistory = named ? undefined : await officeFromCallerHistory(metadata.callerPhone, metadata.callSid);
    const fromDialed = named || fromHistory ? undefined : officeForDialedNumber(metadata.dialedNumber);
    const clinic = named ?? fromHistory ?? fromDialed;
    const locationSource: TicketLocationSource | undefined = named ? 'caller' : clinic ? 'history' : undefined;
    const requestType = floorRequestType(callerText);
    const recordsRequester = records ? recordsRequesterPayload(records.requester, records.requesterName) : undefined;
    const { SyncAgentService } = await import('./syncAgentService');
    const result = await SyncAgentService.submitSimplifiedTicket({
      patientFullName: fullName,
      patientDOB: identity?.dateOfBirth ?? spokenDob ?? 'Unknown',
      reasonForCalling: callerText,
      preferredContactMethod: 'phone',
      patientPhone: metadata.callerPhone,
      departmentId: records ? MEDICAL_RECORDS_DEPARTMENT_ID : AFTER_HOURS_DEPARTMENT_ID,
      ...(clinic && locationSource ? { locationOfLastVisit: clinic, locationSource } : {}),
      // The department-8 pair, so the hint and the pinned department agree —
      // and none on a records request, which is not department 8's.
      ...(records
        ? recordsRequester ? { recordsRequester } : {}
        : {
            suggestedRequestTypeId: requestType.requestTypeId,
            suggestedRequestReasonId: requestType.requestReasonId,
            suggestedRequestReason: requestType.requestReason,
            ...(requestType.urgent ? { suggestedUrgent: true } : {}),
          }),
      additionalDetails: [
        FLOOR_NEEDS_REVIEW_NOTE,
        records ? FLOOR_RECORDS_NOTE : undefined,
        reading?.kind === 'unavailable' ? FLOOR_REQUEST_NOT_CONFIRMED_NOTE : undefined,
        'AFTER-HOURS TEARDOWN: the call ended with a stated request and no recorded ticket. Please review the conversation and complete the request.',
        clinic ? undefined : FLOOR_MISSING_LOCATION_NOTE,
        fromHistory ? FLOOR_HISTORY_LOCATION_NOTE : undefined,
        fromDialed ? FLOOR_DIALED_LOCATION_NOTE : undefined,
        standIn ? FLOOR_MISSING_IDENTITY_NOTE : undefined,
        standIn ? STAND_IN_NAME_NOTE : undefined,
        !standIn && found ? HEARD_NAME_NOTE : undefined,
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
