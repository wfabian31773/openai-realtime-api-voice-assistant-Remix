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
 * 5. Its log lines carry a lane, a call reference and a skip reason. Never a
 *    name, never a number, never the transcript.
 */
import {
  decideSweep,
  buildSweptTicket,
  sweepMarker,
  type SweepInput,
  type SweepSkipReason,
} from "./requestSweep";
import type { VoiceCallRecord } from "./mediaStreamBridge";
import { verifiedIdentityFor } from "../tools/verifiedIdentity";

export interface SweepOutcome {
  filed: boolean;
  /** Present when nothing was filed — why, in the decision's own words. */
  reason?: SweepSkipReason | "create-failed" | "threw";
  ticketNumber?: string;
}

/** The POST, injected so a test proves the payload without a network. */
export type SweepFiler = (ticket: ReturnType<typeof buildSweptTicket>) => Promise<{
  success: boolean;
  ticketNumber?: string;
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
const defaultFiler: SweepFiler = async (ticket) => {
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
    callData: { agentUsed: ticket.slug, callSid: ticket.callSid },
    idempotencyKey: ticket.idempotencyKey,
  });
  return {
    success: Boolean(res.success && res.ticketNumber),
    ...(res.ticketNumber ? { ticketNumber: res.ticketNumber } : {}),
    ...(res.error ? { error: res.error } : {}),
  };
};

/**
 * NO DATE OF BIRTH IS SENT, AND THAT IS NOT AN OVERSIGHT.
 *
 * Traced 2026-09-03: `/api/voice-agent/create-ticket` validates
 * `patientBirthMonth/Day/Year` as OPTIONAL. Every `missingFields:
 * ["date_of_birth"]` refusal in that day's logs came from OUR OWN tools. A
 * swept ticket therefore files cleanly without one, and the request survives
 * a gate that was never the server's — which is the single largest reason
 * these requests were lost.
 */
export async function runRequestSweep(
  record: VoiceCallRecord,
  file: SweepFiler = defaultFiler,
): Promise<SweepOutcome> {
  try {
    const identity = verifiedIdentityFor(record.callSid);
    const input: SweepInput = {
      callSid: record.callSid,
      slug: record.slug,
      callerPhone: record.callerPhone,
      transcript: record.transcript,
      toolEvents: record.toolEvents.map((e) => ({ name: e.name, succeeded: e.succeeded })),
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
        : {}),
    };

    const decision = decideSweep(input);
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

    console.info(sweepMarker(record.slug, record.callSid));
    const ticket = buildSweptTicket(input, decision);
    const res = await file(ticket);
    if (!res.success) {
      console.error(
        `[REQUEST SWEEP] ${record.slug}: could not file the recovered request — ` +
          `${res.error ?? "no ticket number returned"} (${record.callSid})`,
      );
      return { filed: false, reason: "create-failed" };
    }
    console.info(
      `[REQUEST SWEEP] ${record.slug}: recovered request filed as ${res.ticketNumber} (${record.callSid})`,
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
