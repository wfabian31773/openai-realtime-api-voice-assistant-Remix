/**
 * The HVA Hub's own taxonomy — department 9.
 *
 * WHY THIS FILE EXISTS
 *
 * This is where the operator's cross-queue ruling sends every schedule-related
 * call in the practice, so it is about to get busier. Over 90 days to
 * 2026-08-13:
 *
 *   tickets                         1,651  (18.3/day)
 *   NO type and NO reason             463  — 28%
 *   147 Reschedule Existing           456
 *   153 Prescription Refill Request   224  <-- NOT A DEPARTMENT 9 REASON
 *   146 New Appointment Request       198
 *   178 Insurance Verification        131
 *   151 Same-Day                       55
 *   293 Interpreter, in office         47
 *   180 Prior Authorization            30
 *   the rest, combined                ~47
 *
 * THE 224. Reason 153 belongs to department 3. It is on department 9 tickets
 * with request type 32 — Appointment Request — which is not a combination
 * anyone chose. It is `detectRequestReason()` in
 * `config/answeringServiceTicketing.ts` doing what it does everywhere: no
 * keyword matched, so return the first reason of the default type. The same
 * fallback that put 6,905 tickets on 153 in department 3 has stamped it on 224
 * here, plus 13 more in department 8.
 *
 * That is the single largest wrong-reason population in the practice outside
 * department 3, and it is invisible in a report grouped by department because
 * the department is right.
 *
 * WHAT THE 463 UNCLASSIFIED ONES ACTUALLY SAY, read from real ticket text:
 * overwhelmingly appointment requests — "new patient requesting eye exam
 * appointment", "Solicitud de cita para examen de la vista", "Pt needs to
 * set-up a Cataract consult", "Request to schedule earlier appointment with
 * glaucoma specialist" — plus interpreter bookings, pre-authorisations, and
 * pre-op coordination.
 *
 * THE SPECIALIST SIGNAL IS REAL AND IT IS BEING LOST. Department 9 has reason
 * 152, Specialist Referral Appointment, used ONCE in 90 days — while the
 * unclassified pile is full of cornea, retina, glaucoma, oculoplastics and
 * pediatric optometry consults. Those are a different scheduling problem from a
 * routine exam: a different provider list, a different slot length, often a
 * referral to chase first.
 *
 * THERE IS NO HVA PHONE LINE. Operator, 2026-08-13: "we don't have a queue for
 * the HVA hub. The HVA hub are just our health care virtual assistants that are
 * primarily responsible for the scheduling team." Scheduling requests land in
 * the queues patients actually dial and are then MOVED BY HAND into department
 * 9 for that team.
 *
 * That is what this file is for. It is not an agent's taxonomy — no agent
 * answers a department 9 number — it is the reason table that `queueRouting`
 * uses when it files a scheduling request into department 9 on another queue's
 * behalf. It replaces the manual move, so getting the reason right here is the
 * difference between the scheduling team receiving a sorted queue and receiving
 * an undifferentiated pile.
 *
 * TYPE 40 IS DEAD. "Scheduling Request" (189-192) carries the same four
 * concepts as type 32 and has nine tickets in 90 days against type 32's 735.
 * Nothing should file into it. It is listed nowhere below.
 *
 * Every pair was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 9 on 2026-08-13.
 */
import { fold, SCHEDULING, SPECIALIST_CUES } from './queueRouting';

export const HUB_DEPARTMENT_ID = 9;

export interface HubClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  /** Spoken cues that pick this pair. Matched as folded substrings. */
  cues: string[];
  /**
   * A second condition that must ALSO hold.
   *
   * Exists for one real case and should not grow casually. The interpreter
   * split is "in office" versus "by phone", and "over the phone" on its own
   * means nothing — a caller saying "can we do this over the phone" is not
   * booking an interpreter. A substring cue cannot express two terms that are
   * separated in the sentence, and generating the cross product (as the
   * pharmacy and send-to-provider cues do) is wrong here because the two parts
   * appear in either order and far apart.
   */
  alsoRequires?: string[];
}

/** Interpreter bookings — 47 in 90 days, and they have their own request type. */
const INTERPRETER_CUES = [
  'interpreter', 'interprete', 'intérprete', 'translator', 'traductor',
  'language assistance', 'sign language', 'asl ', 'needs an interpreter',
];
/** The telephonic half of the interpreter split. */
const INTERPRETER_PHONE_CUES = [
  'phone interpreter', 'interpreter by phone', 'over the phone', 'telephonic',
  'video interpreter', 'por telefono',
];

export const HUB_CLASSIFICATIONS: HubClassification[] = [
  // --- Interpreter first. It names itself and never means anything else.
  { requestTypeId: 54, requestType: 'Patient Interpreter Request', requestReasonId: 294, requestReason: 'Telecommunications',
    cues: INTERPRETER_PHONE_CUES, alsoRequires: INTERPRETER_CUES },
  { requestTypeId: 54, requestType: 'Patient Interpreter Request', requestReasonId: 293, requestReason: 'In Office / Expected Appointment',
    cues: INTERPRETER_CUES },

  // --- Eligibility. An insurance obstacle is not an appointment request, even
  // when the caller mentions one in the same breath.
  { requestTypeId: 37, requestType: 'Eligibility Request', requestReasonId: 180, requestReason: 'Prior Authorization',
    cues: ['prior auth', 'pre-auth', 'preauth', 'pre auth', 'authorization', 'approval status', 'approved yet', 'autorizacion', 'autorización'] },
  { requestTypeId: 37, requestType: 'Eligibility Request', requestReasonId: 178, requestReason: 'Insurance Verification',
    cues: ['verify my insurance', 'insurance verification', 'verify coverage', 'check my insurance', 'is my insurance active', 'still have coverage', 'verificar mi seguro'] },
  { requestTypeId: 37, requestType: 'Eligibility Request', requestReasonId: 179, requestReason: 'Benefits Check',
    cues: ['benefits', 'what does my plan cover', 'how much will it cost', 'my deductible', 'beneficios'] },
  { requestTypeId: 37, requestType: 'Eligibility Request', requestReasonId: 181, requestReason: 'Coverage Question',
    cues: ['do you take', 'do you accept', 'in network', 'in-network', 'out of network', 'covered by', 'aceptan mi seguro'] },

  // --- Surgery coordination that belongs to the Hub rather than department 2:
  // the visit AROUND an operation, not the operation.
  { requestTypeId: 38, requestType: 'Surgery Coordination', requestReasonId: 182, requestReason: 'Pre-Op Coordination',
    cues: ['pre-op appointment', 'pre op appointment', 'h&p', 'history and physical', 'pre-operative appointment', 'clearance appointment'] },
  { requestTypeId: 38, requestType: 'Surgery Coordination', requestReasonId: 183, requestReason: 'Post-Op Follow-up',
    cues: ['post-op follow', 'post op follow', 'follow-up after surgery', 'follow up after surgery'] },

  // --- Billing, which reaches this line and has nowhere else to go.
  { requestTypeId: 41, requestType: 'Billing Inquiry', requestReasonId: 193, requestReason: 'Patient Balance',
    cues: ['my balance', 'how much do i owe', 'outstanding balance', 'cuanto debo'] },
  { requestTypeId: 41, requestType: 'Billing Inquiry', requestReasonId: 196, requestReason: 'Statement Question',
    cues: ['statement', 'bill i received', 'my bill', 'invoice', 'factura'] },

  // --- The specialist appointment, BEFORE the generic new-appointment bucket.
  // Reason 152 has been used once in 90 days while the unclassified pile is
  // full of cornea, retina and glaucoma consults.
  { requestTypeId: 32, requestType: 'Appointment Request', requestReasonId: 152, requestReason: 'Specialist Referral Appointment',
    cues: SPECIALIST_CUES },

  // --- The six ordinary appointment reasons, from the SAME table
  // queueRouting uses. Not a copy: see the note on SCHEDULING.
  ...SCHEDULING.map((s) => ({
    requestTypeId: 32,
    requestType: 'Appointment Request',
    requestReasonId: s.reasonId,
    requestReason: s.reason,
    cues: s.cues,
  })),
];

/** Department 9's own "Other - See Description" — see `otherReason.ts`. */
export const HUB_CATCHALL: HubClassification = {
  requestTypeId: 69,
  requestType: 'General / Other',
  requestReasonId: 539,
  requestReason: 'Other - See Description',
  cues: [],
};

/** Every reason id this queue may use. */
export const HUB_REASON_IDS = new Set([
  ...HUB_CLASSIFICATIONS.map((c) => c.requestReasonId),
  HUB_CATCHALL.requestReasonId,
]);

/** The pair whose cues the caller's words match, or null. */
export function classifyHub(text: string): HubClassification | null {
  const t = fold(text);
  if (!t.trim()) return null;
  for (const c of HUB_CLASSIFICATIONS) {
    if (!c.cues.some((cue) => t.includes(fold(cue)))) continue;
    if (c.alsoRequires && !c.alsoRequires.some((cue) => t.includes(fold(cue)))) continue;
    return c;
  }
  return null;
}

/**
 * The classification for this request. Never null.
 *
 * Falls to department 9's own catch-all rather than to the first reason of a
 * default type — which is the behaviour that put 224 medication reasons on
 * this department's appointment tickets.
 */
export function classifyHubRequest(text: string): {
  classification: HubClassification;
  isCatchAll: boolean;
} {
  const hit = classifyHub(text);
  return hit
    ? { classification: hit, isCatchAll: false }
    : { classification: HUB_CATCHALL, isCatchAll: true };
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function hubReasonById(reasonId: number): HubClassification | null {
  if (reasonId === HUB_CATCHALL.requestReasonId) return HUB_CATCHALL;
  return HUB_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}
