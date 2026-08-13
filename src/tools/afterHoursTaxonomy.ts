/**
 * The After Hours queue's own taxonomy — department 8.
 *
 * WHY THIS FILE EXISTS
 *
 * 76% of this department is mis-recorded. Over 90 days to 2026-08-13:
 *
 *   tickets                              986   (11/day)
 *   159 "Transferred to On-Call Provider" 479  <-- almost none were
 *   NO type and NO reason                 274
 *   174 Callback Request from Provider     92
 *   172 General Message for Office         79
 *   166 Office Hours/Location Question     23
 *   153 Prescription Refill Request        13  <-- a DEPARTMENT 3 reason
 *   the clinical emergencies (160-165)      4
 *
 * WHOSE FALLBACK — CORRECTED 2026-08-13. I first wrote that this was
 * `detectRequestReason()` in our own `config/answeringServiceTicketing.ts`.
 * It is not, and the attribution matters because it decides who can fix it:
 *
 *   dept 8, agent no-ivr             687 tickets, 413 on reason 159
 *   dept 8, agent answering-service  170 tickets,   9 on reason 159
 *
 * `detectRequestReason` is imported by `answeringServiceAgent` and nothing
 * else. no-ivr files through `submitSimplifiedTicket`, which posts
 * conversational fields to /api/voice-agent/submit-ticket and sends NO
 * department, NO request type and NO reason — the comment at that call site
 * says so: "all mapping done server-side". So the 413 are the TICKETING APP's
 * derivation, and type 34's first reason is 159.
 *
 * Our own fallback is real and it owns department 3 (6,119 of the 6,905 on
 * reason 153 come from answering-service). It does not own this one.
 *
 * WHAT THAT MEANS FOR THIS FILE. It cannot be wired into the no-ivr path by
 * choosing a reason, because that path does not send one. Switching no-ivr to
 * create-ticket would mean this repo picking the DEPARTMENT for every overnight
 * call — the entire answering-service classification problem, on the line that
 * carries the night. Not worth it to fix a label.
 *
 * So the taxonomy is sent as a HINT alongside the request instead. It is inert
 * until the ticketing app reads it, which is what makes it safe to send today,
 * and it hands them the classification rather than an argument about one.
 *
 * THE HARM IS THE INVERSE OF WHAT IT LOOKS LIKE. The problem is not that urgent
 * calls are under-described — it is that ROUTINE calls are recorded as urgent
 * transfers, which makes the genuinely urgent ones impossible to find. In the
 * same 479 sits "Worsening pain in right eye over the past day, requesting
 * urgent follow-up". Nobody auditing this queue can separate that from "what
 * time do you open" without reading 479 descriptions.
 *
 * 159 IS A DISPOSITION, NOT A REASON. It describes how the call ended. Nothing
 * in this taxonomy returns it — it belongs to the code that actually completes
 * a transfer, and that code knows whether one happened.
 *
 * OFFICE HOURS AND LOCATION IS THE REAL WORKLOAD. It has 23 tickets on record
 * and is visibly one of the largest groups inside the 479. That is what a line
 * answering out of hours gets asked: when do you open, where are you, what is
 * the address, is Saturday available.
 *
 * SCHEDULING LEAVES THIS DEPARTMENT. Per the operator's ruling, anything
 * schedule-related goes to the HVA Hub — and the 274 unclassified tickets are
 * overwhelmingly Spanish appointment requests. That is `queueRouting`'s job,
 * not this file's, which is why no appointment reasons appear below.
 *
 * Every pair was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 8 on 2026-08-13.
 */
import { fold } from './queueRouting';

export const AFTER_HOURS_DEPARTMENT_ID = 8;

export interface AfterHoursClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  cues: string[];
  /** Sight-threatening. Raises priority; does not make the agent a clinician. */
  urgent?: true;
}

/**
 * The six clinical emergencies the practice named, in the words patients use.
 *
 * These are FIRST and they are deliberately generous. The cost of a false
 * positive here is a ticket marked urgent that was not; the cost of a false
 * negative is a retinal detachment that waited until morning. Those are not
 * comparable, and the taxonomy should not pretend they are.
 */
export const AFTER_HOURS_CLASSIFICATIONS: AfterHoursClassification[] = [
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 164, requestReason: 'Chemical Exposure', urgent: true,
    cues: ['chemical', 'bleach', 'splashed', 'got in my eye', 'sprayed in my eye', 'cleaner in my eye', 'quimico', 'químico', 'me cayo', 'me cayó'] },
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 165, requestReason: 'Retinal Detachment Symptoms', urgent: true,
    cues: ['curtain', 'shadow over', 'veil', 'flashes', 'flashing light', 'new floaters', 'lot of floaters', 'shower of', 'cortina', 'destellos', 'moscas volantes'] },
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 161, requestReason: 'Sudden Vision Loss', urgent: true,
    cues: ['lost my vision', 'lost vision', 'cannot see', "can't see", 'went blind', 'blurry all of a sudden', 'sudden vision', 'vision went', 'no puedo ver', 'perdi la vista', 'perdí la vista'] },
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 162, requestReason: 'Eye Injury/Trauma', urgent: true,
    cues: ['injury', 'injured', 'hit in the eye', 'hit me in the eye', 'hit my eye', 'hit in my eye', 'poked', 'scratched my eye', 'something in my eye', 'got into my eye', 'foreign body', 'trauma', 'golpe en el ojo', 'lastimé', 'lastime'] },
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 160, requestReason: 'Post-Surgery Complication', urgent: true,
    cues: ['after my surgery', 'since my surgery', 'since the surgery', 'post-op pain', 'post op pain', 'surgery site', 'stitches', 'the eye i had done', 'despues de la cirugia', 'después de la cirugía'] },
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 163, requestReason: 'Severe Eye Pain', urgent: true,
    cues: ['severe pain', 'terrible pain', 'excruciating', 'worst pain', 'worsening pain', 'a lot of pain', 'really hurts', 'unbearable', 'mucho dolor', 'dolor fuerte', 'dolor severo'] },

  // --- Not clinical. The largest real group in the queue, and the reason a
  // line answering out of hours exists at all.
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 166, requestReason: 'Office Hours/Location Question',
    cues: ['office hours', 'hours of operation', 'opening time', 'closing time', 'what time do you open', 'what time do you close',
           'what time you open', 'time do you open', 'open at', 'close at', 'are you open', 'open on saturday', 'open tomorrow', 'weekend',
           'address', 'directions', 'where are you located', 'which office', 'parking',
           'horario', 'a que hora abren', 'a qué hora abren', 'estan abiertos', 'están abiertos', 'direccion', 'dirección', 'como llegar', 'cómo llegar'] },

  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 169, requestReason: 'Test Results Inquiry',
    cues: ['test result', 'my results', 'the results of', 'biopsy', 'scan result', 'resultados'] },
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 170, requestReason: 'Pre-Appointment Instructions',
    cues: ['before my appointment', 'what do i need to bring', 'do i need a driver', 'should i eat', 'dilated tomorrow', 'antes de mi cita'] },
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 171, requestReason: 'Post-Procedure Questions',
    cues: ['after the procedure', 'after my injection', 'is this normal after', 'recovery', 'when can i drive', 'when can i shower'] },
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 167, requestReason: 'Insurance Question',
    cues: ['insurance', 'my plan', 'coverage', 'authorization', 'referral', 'seguro', 'aseguranza'] },
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 168, requestReason: 'Billing Question',
    cues: ['bill', 'billing', 'statement', 'how much do i owe', 'balance', 'payment', 'factura', 'cuenta'] },

  // --- Messages for people.
  { requestTypeId: 36, requestType: 'Provider Message', requestReasonId: 177, requestReason: 'Second Opinion Request',
    cues: ['second opinion', 'another opinion', 'segunda opinion', 'segunda opinión'] },
  { requestTypeId: 36, requestType: 'Provider Message', requestReasonId: 175, requestReason: 'Medical Question for Provider',
    cues: ['medical question', 'question for the doctor', 'ask the doctor', 'question for dr', 'is it normal', 'should i be worried'] },
  { requestTypeId: 36, requestType: 'Provider Message', requestReasonId: 176, requestReason: 'Follow-Up Care Question',
    cues: ['follow-up care', 'follow up care', 'next steps', 'what happens next', 'my treatment plan'] },
  { requestTypeId: 36, requestType: 'Provider Message', requestReasonId: 173, requestReason: 'Message for Specific Doctor',
    cues: ['message for dr', 'message for doctor', 'tell dr', 'let dr', 'for doctor ', 'para el doctor'] },
  { requestTypeId: 36, requestType: 'Provider Message', requestReasonId: 174, requestReason: 'Callback Request from Provider',
    cues: ['call me back', 'callback', 'return my call', 'have someone call', 'need a call back', 'que me llamen', 'llamada de regreso'] },

  // --- Somebody wants to leave word and said nothing more specific. LAST of
  // the real reasons.
  { requestTypeId: 35, requestType: 'General Inquiry', requestReasonId: 172, requestReason: 'General Message for Office',
    cues: ['message for the office', 'leave a message', 'pass along', 'let them know', 'dejar un mensaje', 'un mensaje'] },
];

/** Department 8's own "Other - See Description" — see `otherReason.ts`. */
export const AFTER_HOURS_CATCHALL: AfterHoursClassification = {
  requestTypeId: 68,
  requestType: 'General / Other',
  requestReasonId: 538,
  requestReason: 'Other - See Description',
  cues: [],
};

/**
 * Reason 159, kept here so nothing has to hardcode it, and deliberately NOT in
 * the classification table.
 *
 * It records that a transfer HAPPENED. Only the code that completes one knows
 * that, and 479 tickets exist because a keyword fallback claimed it instead.
 */
export const AFTER_HOURS_TRANSFERRED = {
  requestTypeId: 34,
  requestType: 'Urgent/Emergency Transfer',
  requestReasonId: 159,
  requestReason: 'Transferred to On-Call Provider',
} as const;

/** Every reason id this queue may use, including the transfer disposition. */
export const AFTER_HOURS_REASON_IDS = new Set([
  ...AFTER_HOURS_CLASSIFICATIONS.map((c) => c.requestReasonId),
  AFTER_HOURS_CATCHALL.requestReasonId,
  AFTER_HOURS_TRANSFERRED.requestReasonId,
]);

/** The pair whose cues the caller's words match, or null. */
export function classifyAfterHours(text: string): AfterHoursClassification | null {
  const t = fold(text);
  if (!t.trim()) return null;
  for (const c of AFTER_HOURS_CLASSIFICATIONS) {
    if (c.cues.some((cue) => t.includes(fold(cue)))) return c;
  }
  return null;
}

/**
 * The classification for this request. Never null.
 *
 * Falls to department 8's own catch-all — NOT to 159, which is the behaviour
 * that produced 479 false urgent transfers.
 */
export function classifyAfterHoursRequest(text: string): {
  classification: AfterHoursClassification;
  isCatchAll: boolean;
} {
  const hit = classifyAfterHours(text);
  return hit
    ? { classification: hit, isCatchAll: false }
    : { classification: AFTER_HOURS_CATCHALL, isCatchAll: true };
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function afterHoursReasonById(reasonId: number): AfterHoursClassification | null {
  if (reasonId === AFTER_HOURS_CATCHALL.requestReasonId) return AFTER_HOURS_CATCHALL;
  return AFTER_HOURS_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}
