/**
 * AN AFTER-HOURS MEDICAL RECORDS REQUEST, AND WHO IS ASKING — v190.
 *
 * Operator ruling, 2026-11-09: "records requests never ring the on-call."
 * The after-hours line takes a records request as a message for Medical
 * Records (department 16), and the ticket says who asked, so the records case
 * opens on the right pathway. Ticket #73052 (2026-11-07) said nothing about
 * the requester, and when staff moved it to Medical Records the case opened on
 * the patient's 15-day clock by design (the ticketing app's request-pathway.ts
 * puts an unstated requester on the clock and flags it for review).
 *
 * Two places file an after-hours records request: `create_ticket`, and the
 * teardown floor when the caller hangs up first. Both read who is asking from
 * here, so the request reaches Medical Records with the same requester either
 * way. The escalation gate notes it when it refuses a records request; the
 * filing tool notes it when the model files one.
 *
 * Per call, bounded, and imported statically by everything that reads or
 * writes it (the v141 rule — on Node 20 a dynamic import is a second copy).
 */
import {
  MEDICAL_RECORDS_DEPARTMENT_ID,
  classifyRequester,
  determineCapClock,
  normalizeRequesterType,
  resolveRequesterType,
  type RequesterType,
} from '../tools/medicalRecordsTaxonomy';

export { MEDICAL_RECORDS_DEPARTMENT_ID };

const MAX_CALLS = 500;

type Noted = { requester?: RequesterType; requesterName?: string };
const calls = new Map<string, Noted>();

/** Remember that this call is a records request, and who asked when known. */
export function noteAfterHoursRecordsRequest(callSid: string | undefined, noted: Noted = {}): void {
  if (!callSid) return;
  const prior = calls.get(callSid) ?? {};
  calls.delete(callSid);
  calls.set(callSid, {
    requester: noted.requester ?? prior.requester,
    requesterName: noted.requesterName ?? prior.requesterName,
  });
  while (calls.size > MAX_CALLS) {
    const oldest = calls.keys().next().value;
    if (oldest === undefined) break;
    calls.delete(oldest);
  }
}

export function afterHoursRecordsRequestFor(callSid: string | undefined): Noted | undefined {
  return callSid ? calls.get(callSid) : undefined;
}

export function forgetAfterHoursRecordsRequest(callSid: string | undefined): void {
  if (callSid) calls.delete(callSid);
}

/** The escalation tool's caller_type, as a requester. Only a provider is a requester we can name. */
export function requesterFromCallerType(callerType: string | undefined): RequesterType | undefined {
  return callerType === 'healthcare_provider' ? 'provider' : undefined;
}

/**
 * The four fields the ticketing app stores on the ticket's records_* columns,
 * or nothing when nobody said who is asking — an absent requester is the
 * app's to put on the clock and flag, never ours to guess off it.
 *
 * A stated type goes through the records lane's own rule
 * (`resolveRequesterType`): it may not take a request OFF the clock that the
 * caller's words put on it.
 */
export function recordsRequesterPayload(stated: string | undefined, requesterName: string | undefined): {
  requestorType: RequesterType;
  requestPathway: ReturnType<typeof determineCapClock>['pathway'];
  capClockApplies: boolean;
  requestorName?: string;
} | undefined {
  const type = normalizeRequesterType(stated);
  if (!type) return undefined;
  const name = (requesterName ?? '').trim().slice(0, 200);
  const resolved = resolveRequesterType(type, name ? classifyRequester(name) : null);
  const cap = determineCapClock(resolved);
  return {
    requestorType: resolved,
    requestPathway: cap.pathway,
    capClockApplies: cap.onClock,
    ...(name ? { requestorName: name } : {}),
  };
}
