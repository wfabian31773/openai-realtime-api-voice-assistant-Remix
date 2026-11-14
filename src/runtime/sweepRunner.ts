import { ticketIdentityFields } from '../tools/ticketIdentity';
import { readDobQuietly } from '../tools/dobParts';
/**
 * RUNNING THE SWEEP AT TEARDOWN — the last thing that happens to a call.
 *
 * `requestSweep.ts` decides. This files. They are separate so the decision can
 * be tested without a network and the backfill can reuse the same decision
 * over calls that are already over.
 *
 * WHY THIS EXISTS AT ALL, restated because it keeps being forgotten:
 * ten calls on the afternoon of 2026-09-03 ended with a complete request in
 * the transcript and no ticket anywhere. Each was stopped by a different gate
 * — an ambiguous lookup, a hangup, a date of birth the caller had already
 * said. Arguing with the gates one at a time is how the fortnight went. This
 * is the floor underneath all of them: if the caller made a request and
 * nothing was filed, file what they said.
 *
 * FIVE RULES IT HOLDS TO
 *
 * 1. It never throws. Teardown must complete whatever happens here — losing
 *    the call record to a sweep failure would be worse than the loss it is
 *    fixing.
 * 2. It runs AFTER the call_logs write, never instead of it.
 * 3. It files on the queue the call arrived on and nowhere else. The queue is
 *    the classification (operator, 2026-08-11).
 * 4. No name, no ticket (operator, 2026-09-03) — the identity comes from the
 *    record `lookup_patient` verified, never from reading the transcript.
 *    EXCEPT on the records lane (operator, 2026-09-27): there an unnamed
 *    request files with a staff note, because an unlogged access request is
 *    the failure the department's Corrective Action Plan polices.
 * 5. Its log lines carry a lane, a call reference and a skip reason. Never a
 *    name, never a number, never the transcript.
 */
import {
  decideSweep,
  buildSweptTicket,
  sweepMarker,
  SWEPT_TICKET_DESCRIPTION,
  type SweepInput,
  type SweepSkipReason,
} from "./requestSweep";
import type { VoiceCallRecord } from "./mediaStreamBridge";
import type { CreateTicketParams } from '../../server/services/ticketingApiClient';
import { unconfirmedCandidateFor, verifiedIdentityFor } from "../tools/verifiedIdentity";
import { callerSaidTheName } from "./callerSaidTheName";
import { statedNameFor } from "../tools/statedName";
import { askModelForThePatientName, nameFromTheRecording, type NameAsker } from "./nameFromTheRecording";

import { askModelForTheRequest, requestFromTheRecording, type RequestAsker } from "./requestFromTheRecording";

/** Reads nothing — the default for any caller that did not choose the model. */
const noNameFromTheRecording: NameAsker = async () => null;
/** v201: reads nothing — the default, so no test that calls `runRequestSweep` directly reaches the network. */
const noRequestFromTheRecording: RequestAsker = async () => null;
import { draftedRequestFor } from "../tools/draftedRequest";
import { dobFromCallerAnswer } from "../tools/spokenDob";
import { findByPhone } from "../services/patientVerification";

/**
 * v182: WHO THE CALLING NUMBER BELONGS TO, when it is exactly one person.
 *
 * Operator ruling, 2026-10-29: "we should not be filing nameless tickets but
 * we also need to make sure that we did not get the name in transcripts nor
 * did we match the phone number to a patient on lookup." v171 built the half
 * where the caller said the record's name, v180 the half where a name is in
 * the transcript; this is the phone-match half, approved as filed on
 * 2026-11-06 ("going with proposed changes").
 *
 * ONE PERSON, NEVER A PICK (standing instruction 6). `findByPhone` answers
 * `verified` only when the number belongs to one person in `patients_master`,
 * or to one person charted twice (v179); several people on the number answer
 * `ambiguous` and nothing files, exactly as before. The pre-context candidate
 * is NOT used for this: the service's `matched` flag is not a uniqueness
 * promise (17 of 38 named numbers on 2026-09-11 held two or three people), and
 * the corpus call this was written for is one of those.
 *
 * The default reads nothing, so no test that calls `runRequestSweep` directly
 * can reach the person base; production passes `lookUpTheCallingNumber`.
 */
export type NumberLookup = (
  phone: string | undefined,
) => Promise<{ firstName: string; lastName: string } | null>;
export const noNumberLookup: NumberLookup = async () => null;
export const lookUpTheCallingNumber: NumberLookup = async (phone) => {
  const res = await findByPhone(phone);
  if (!res.verified || !res.patient) return null;
  const firstName = res.patient.firstName.trim();
  const lastName = res.patient.lastName.trim();
  return firstName && lastName ? { firstName, lastName } : null;
};

export interface SweepOutcome {
  filed: boolean;
  /** Present when nothing was filed — why, in the decision's own words. */
  reason?: SweepSkipReason | "create-failed" | "threw";
  ticketNumber?: string;
}

/** The POST, injected so a test proves the payload without a network. */
type SweepTicket = ReturnType<typeof buildSweptTicket> & Pick<CreateTicketParams,
  'validatedPatient' | 'patientBirthYear' | 'patientBirthMonth' | 'patientBirthDay' | 'locationOfLastVisit' | 'locationSource'>;
export type SweepFiler = (ticket: SweepTicket) => Promise<{
  success: boolean;
  ticketNumber?: string;
  /** Durably queued in the outbox; a number will follow from the retry worker. */
  queued?: boolean;
  error?: string;
}>;

/**
 * The real filer. Goes through `createTicketDurable` exactly as the agents'
 * own tools do, so a swept request inherits the outbox: if the ticketing app
 * is down at teardown the request is captured and the worker retries it,
 * rather than being lost a second time by the thing built to stop it being
 * lost once.
 *
 * Imported lazily. This module is reached from the runtime's teardown path and
 * the outbox pulls in the database; a test that never files must not need a
 * DATABASE_URL.
 */
const fileOnce: SweepFiler = async (ticket) => {
  const { createTicketDurable } = await import("../services/durableTicketFiling");
  const res = await createTicketDurable({
    ...(ticket.validatedPatient ? { validatedPatient: ticket.validatedPatient } : {}),
    ...(ticket.patientBirthYear ? { patientBirthYear: ticket.patientBirthYear, patientBirthMonth: ticket.patientBirthMonth, patientBirthDay: ticket.patientBirthDay } : {}),
    ...(ticket.locationOfLastVisit ? { locationOfLastVisit: ticket.locationOfLastVisit, locationSource: ticket.locationSource } : {}),
    departmentId: ticket.departmentId,
    requestTypeId: ticket.requestTypeId,
    requestReasonId: ticket.requestReasonId,
    // Absent on an unnamed records-lane request: the app treats a missing name
    // as missing and a blank one as a name.
    ...(ticket.patientFirstName ? { patientFirstName: ticket.patientFirstName } : {}),
    ...(ticket.patientLastName ? { patientLastName: ticket.patientLastName } : {}),
    patientPhone: ticket.patientPhone,
    preferredContactMethod: "phone",
    description: ticket.description,
    priority: ticket.priority,
    callData: {
      agentUsed: ticket.slug,
      callSid: ticket.callSid,
      // Staff-only, and the ONLY place the recovery annotation appears. The
      // description is a patient-facing SMS body (BACKEND_HANDOFF section 6).
      transcript: ticket.staffNote,
    },
    idempotencyKey: ticket.idempotencyKey,
    // Optical and surgery only, decided in buildSweptTicket. Without it the
    // app refuses a swept request for an office or a surgeon nobody is left
    // to give — 87 of 92 on those two queues, 2026-09-28..10-08.
    ...(ticket.routingAskExhausted ? { routingAskExhausted: true } : {}),
  },
  /**
   * The placeholder the default filer would send after a refusal goes into the
   * outbox beside a drafted description, so a refusal that arrives on the
   * worker's replay after an outage files it too, instead of dead-lettering
   * the request (v205). A placeholder description carries none: the outbox
   * stores a fallback only when it differs from the description.
   */
  { refusalFallbackDescription: SWEPT_TICKET_DESCRIPTION });
  /**
   * A QUEUED REQUEST IS A RECOVERED REQUEST.
   *
   * When the ticketing API is down but the outbox write succeeded,
   * `createTicketDurable` answers `success: false, queued: true` — there is
   * no ticket number YET, and the payload is durably persisted for the retry
   * worker. Reading only the ticket number called that a failure and logged
   * that a recovered request could not be filed, which corrupts the sweep's
   * counts and its outage diagnostics at precisely the moment an outage is
   * the thing being diagnosed (Codex, PR #268 round 6).
   *
   * The distinction is kept rather than flattened: `ticketNumber` is still
   * absent, so nothing downstream can read a number that does not exist.
   */
  const queued = (res as { queued?: boolean }).queued === true;
  return {
    success: Boolean((res.success && res.ticketNumber) || queued),
    ...(res.ticketNumber ? { ticketNumber: res.ticketNumber } : {}),
    ...(queued && !res.ticketNumber ? { queued: true } : {}),
    ...(res.error ? { error: res.error } : {}),
  };
};

/**
 * A drafted description can be refused (or re-routed and then refused) by the
 * app where the placeholder never is — e.g. a nameless records call whose
 * draft names an appointment. Refused outright (not queued), the sweep files
 * once more with the placeholder, so v166 never loses a request the old
 * placeholder-only sweep would have filed. (Codex, PR #420.)
 */
const defaultFiler: SweepFiler = async (ticket) => {
  const first = await fileOnce(ticket);
  if (first.success || first.queued) return first;
  if (ticket.description === SWEPT_TICKET_DESCRIPTION) return first;
  return fileOnce({
    ...ticket,
    // Same idempotency key: a re-run sweep must not create a second ticket. (Codex, PR #420.)
    description: SWEPT_TICKET_DESCRIPTION,
  });
};

/**
 * NO DATE OF BIRTH IS REQUIRED.
 *
 * Traced 2026-09-03: `/api/voice-agent/create-ticket` validates
 * `patientBirthMonth/Day/Year` as OPTIONAL. Every `missingFields:
 * ["date_of_birth"]` refusal in that day's logs came from OUR OWN tools.
 * A certain identity's chart date of birth is carried when held, and
 * otherwise the date the caller said (v231). A swept ticket still files
 * without one, and the request survives
 * a gate that was never the server's — which is the single largest reason
 * these requests were lost.
 */
export async function runRequestSweep(
  record: VoiceCallRecord,
  file: SweepFiler = defaultFiler,
  /**
   * v180: who reads the patient's name out of the transcript. The default reads
   * nothing; production passes the model through `runProductionSweep`, so no
   * test that calls this directly can reach the network.
   */
  askName: NameAsker = noNameFromTheRecording,
  /** v182: who the calling number belongs to. The default reads nothing. */
  lookupNumber: NumberLookup = noNumberLookup,
  /**
   * v201: who reads what the caller asked for out of the transcript, when the
   * model wrote nothing down. The default reads nothing; production passes
   * the model through `runProductionSweep`.
   */
  askRequest: RequestAsker = noRequestFromTheRecording,
): Promise<SweepOutcome> {
  try {
    const identity = verifiedIdentityFor(record.callSid);
    // A certain match wins. Without one, the name the caller gave, as the
    // agent's own tools received it (operator ruling 2026-10-29).
    const stated = identity ? undefined : statedNameFor(record.callSid);
    // v168, the other half of that ruling: the person the calling number
    // belongs to, when the caller SAID both halves of that name on the call.
    // Never on its own — an unconfirmed candidate is not an identity.
    const candidate = identity || stated ? undefined : unconfirmedCandidateFor(record.callSid);
    const spoken =
      candidate && callerSaidTheName(record.transcript, candidate.firstName, candidate.lastName)
        ? candidate
        : undefined;
    if (spoken) {
      console.info(
        `[REQUEST SWEEP] ${record.slug}: the caller said the name the calling number belongs to — ` +
          `filing under it, unconfirmed (${record.callSid})`,
      );
    }
    const drafted = draftedRequestFor(record.callSid);
    let input: SweepInput = {
      callSid: record.callSid,
      slug: record.slug,
      callerPhone: record.callerPhone,
      transcript: record.transcript,
      toolEvents: record.toolEvents.map((e) => ({
        name: e.name,
        succeeded: e.succeeded,
        ...(e.foundOpenTicket === undefined ? {} : { foundOpenTicket: e.foundOpenTicket }),
        ...(typeof e.requestReasonId === "number" ? { requestReasonId: e.requestReasonId } : {}),
      })),
      ...(record.summary?.trim() ? { summary: record.summary.trim() } : {}),
      // v166: what the model wrote as the request on a classify or filing
      // tool, refused or not — the reason the swept ticket used to lose.
      ...(drafted ? { draftedRequest: drafted } : {}),
      /**
       * Still false, and still for the reason below — but the evidence that
       * DOES matter now travels in `toolEvents`, where `decideSweep` reads a
       * successful `check_open_tickets` and skips as "status-check".
       *
       * This flag means "a filing tool put a ticket on this call". A patient
       * can have a ticket from last week and a new problem today, so an old
       * ticket existing is not that, and the `call-<sid>` idempotency key
       * already collapses a genuine race with the agent's own filing.
       */
      ticketAlreadyFiled: false,
      ...(identity
        ? { verifiedName: { firstName: identity.firstName, lastName: identity.lastName } }
        : stated
          ? { verifiedName: { firstName: stated.firstName, lastName: stated.lastName }, nameSource: "stated" as const }
          : spoken
            ? { verifiedName: { firstName: spoken.firstName, lastName: spoken.lastName }, nameSource: "spoken" as const }
            : {}),
    };

    let decision = decideSweep(input);
    /**
     * v180: NO NAME, SO READ IT FROM THE RECORDING. Operator, 2026-10-29: "make
     * sure that we did not get the name in transcripts". Only here, where the
     * request would otherwise be dropped for want of a name; a model reads the
     * patient's name and the code files under it only if the caller said it as
     * one name in one of their turns. Re-decided with that name, so a caller who said nothing but
     * their name is still `identity-only`.
     */
    if (!decision.file && decision.reason === "no-name") {
      const heard = await nameFromTheRecording(record.transcript, askName);
      if (heard) {
        input = { ...input, verifiedName: heard, nameSource: "heard" };
        decision = decideSweep(input);
        if (decision.file) {
          console.info(
            `[REQUEST SWEEP] ${record.slug}: no name was captured on the call — filing under the ` +
              `patient name the caller said, read from the recording (${record.callSid})`,
          );
        }
      }
    }
    /**
     * v182: STILL NO NAME, SO ASK WHO THE NUMBER BELONGS TO. Last, after every
     * name the call itself carried: a caller who named a patient identifies
     * that patient, even from another person's phone. Only a number that
     * belongs to one person files; the ticket says the name came from the
     * number and is not confirmed. A lookup that fails files nothing.
     */
    if (!decision.file && decision.reason === "no-name") {
      const owner = await lookupNumber(record.callerPhone).catch(() => null);
      if (owner) {
        input = { ...input, verifiedName: owner, nameSource: "number" };
        decision = decideSweep(input);
        if (decision.file) {
          console.info(
            `[REQUEST SWEEP] ${record.slug}: no patient name was said — the calling number belongs to ` +
              `one patient on file; filing under that record, unconfirmed (${record.callSid})`,
          );
        }
      }
    }
    /**
     * v201: THE RECORDS LANE GETS THE HEARD NAME TOO. That lane files without a
     * name (operator, 2026-09-27), so it never skips as `no-name` and the v180
     * reader above never ran for it: of 65 nameless high-priority Medical
     * Records tickets in the 14 days to 2026-11-10, 64 were this sweep's. Same
     * reader, same same-turn check, same staff note, no date of birth, office
     * or validated patient. Only where nobody established a name on the call
     * (no certain match, no tool-received or spoken name). A re-decision that
     * would NOT file (the caller said only that name) keeps the nameless
     * filing: a name must never cost a records request its ticket.
     */
    if (decision.file && !decision.firstName && !decision.lastName && !input.verifiedName) {
      const heard = await nameFromTheRecording(record.transcript, askName);
      if (heard) {
        const named: SweepInput = { ...input, verifiedName: heard, nameSource: "heard" };
        const redecided = decideSweep(named);
        if (redecided.file) {
          input = named;
          decision = redecided;
          console.info(
            `[REQUEST SWEEP] ${record.slug}: no name was captured on the call — filing under the ` +
              `patient name the caller said, read from the recording (${record.callSid})`,
          );
        }
      }
    }
    if (!decision.file) {
      /**
       * A SKIP IS LOGGED TOO, and only "no-name" loudly.
       *
       * The other reasons are the sweep working: a lane it does not cover, a
       * request already filed, a caller who said nothing. "no-name" is the one
       * where a real request existed and the operator's ruling stopped it —
       * those callers are not lost, they surface on the callback list, and the
       * rate is the evidence for whether that ruling needs revisiting.
       */
      if (decision.reason === "no-name") {
        console.warn(
          `[REQUEST SWEEP] ${record.slug}: a request was made and nobody was identified — ` +
            `not filed, needs a callback (${record.callSid})`,
        );
      } else {
        console.info(
          `[REQUEST SWEEP] ${record.slug}: nothing to recover — ${decision.reason} (${record.callSid})`,
        );
      }
      return { filed: false, reason: decision.reason };
    }

    /**
     * v201: NOTHING WAS WRITTEN DOWN, SO READ WHAT THE CALLER ASKED FOR.
     * Operator, 2026-11-11: a ticket that says "reason not captured" leaves
     * staff calling back just to find out what the call was about. Only when
     * the model drafted nothing on the call — its own words win — and only once
     * the decision is to file. The sentence is checked against every patient
     * name this call holds, so none of them can reach the description.
     */
    if (!input.draftedRequest?.trim()) {
      const candidate = unconfirmedCandidateFor(record.callSid);
      const held = [
        decision.firstName, decision.lastName,
        identity?.firstName, identity?.lastName,
        stated?.firstName, stated?.lastName,
        candidate?.firstName, candidate?.lastName,
      ].filter((n): n is string => typeof n === "string" && n.trim().length > 0);
      const asked = await requestFromTheRecording(record.transcript, askRequest, held);
      if (asked) {
        input = { ...input, requestFromRecording: asked };
        console.info(
          `[REQUEST SWEEP] ${record.slug}: the model wrote no request down — the description is ` +
            `the request read from the recording (${record.callSid})`,
        );
      }
    }

    /**
     * v231: THE DATE OF BIRTH THE CALLER GAVE, read from the whole call by the
     * same reader the filing tools use (the answer to a date-of-birth ask, or a
     * date the caller called the date of birth). `buildSweptTicket` carries it
     * only under a name the caller gave (`stated`, `spoken`, `heard`), with a
     * staff note that it is not matched; a certain identity has no such source
     * and carries the chart's date below, which always wins (RULE ZERO step 5).
     */
    const said = dobFromCallerAnswer(record.transcript.split("\n"));
    if (said) input = { ...input, callerDob: said };
    console.info(sweepMarker(record.slug, record.callSid));
    const ticket: SweepTicket = buildSweptTicket(input, decision);
    if (identity) {
      const dob = readDobQuietly(identity.dateOfBirth ?? '');
      const fields = ticketIdentityFields(record.callSid, identity.firstName, identity.lastName);
      let office = identity.usualOffice;
      if (record.slug === 'optical' && fields.validatedPatient) {
        const { filterOpticalPatientLocations } = await import('../tools/acceptableLocation');
        // Use the live Optical path's facility rules on carried history too:
        // the receiver prefers joined appointments over the fallback office.
        const patient = await filterOpticalPatientLocations(fields.validatedPatient);
        fields.validatedPatient = patient;
        office = patient.nextAppointment?.location || patient.lastVisit?.location || patient.confirmedClinic;
      }
      Object.assign(ticket, fields,
        { ...(dob ? { patientBirthYear: dob.year, patientBirthMonth: dob.month, patientBirthDay: dob.day } : {}),
          ...(office ? { locationOfLastVisit: office, locationSource: 'history' } : {}) });
    }
    const res = await file(ticket);
    if (!res.success) {
      console.error(
        `[REQUEST SWEEP] ${record.slug}: could not file the recovered request — ` +
          `${res.error ?? "no ticket number returned"} (${record.callSid})`,
      );
      return { filed: false, reason: "create-failed" };
    }
    // Two true outcomes, and the log distinguishes them: a number in hand, or
    // durably queued while the ticketing app is unreachable. Both mean the
    // request is not lost, which is what this sweep is counted on for.
    console.info(
      res.ticketNumber
        ? `[REQUEST SWEEP] ${record.slug}: recovered request filed as ${res.ticketNumber} (${record.callSid})`
        : `[REQUEST SWEEP] ${record.slug}: recovered request QUEUED in the outbox — the ticketing ` +
          `app is unreachable; the retry worker will file it (${record.callSid})`,
    );
    return { filed: true, ...(res.ticketNumber ? { ticketNumber: res.ticketNumber } : {}) };
  } catch (err) {
    // Rule 1. The message only — an error carrying a transcript would be
    // patient data in a log nobody is watching.
    console.error(
      `[REQUEST SWEEP] ${record.slug}: sweep threw and was swallowed (${record.callSid}):`,
      err instanceof Error ? err.message : String(err),
    );
    return { filed: false, reason: "threw" };
  }
}

/**
 * THE SWEEP THE RUNTIME RUNS (v180, v182, v201): the real filer, the model that
 * reads the patient's name out of the transcript when the call captured none,
 * the person-base lookup of who the calling number belongs to, and the model
 * that reads what the caller asked for when nothing was written down.
 * `voiceRuntime` uses this as its default; `sweepRunner.wiring` pins it.
 */
export function runProductionSweep(record: VoiceCallRecord): Promise<SweepOutcome> {
  return runRequestSweep(record, defaultFiler, askModelForThePatientName, lookUpTheCallingNumber, askModelForTheRequest);
}
