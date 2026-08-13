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
 * WHOSE FALLBACK. Department 8's 159s come from the ticketing app, not from our
 * `detectRequestReason()` — that function is imported by `answeringServiceAgent`
 * and nothing else, and no-ivr sends no department, type or reason at all.
 * Our own fallback is real and owns department 3 (6,119 of 6,905 on reason 153).
 *
 * WHY 159 ACTUALLY HAPPENS — CORRECTED 2026-08-13, and I had this wrong twice.
 *
 * I wrote that type 34's first reason is 159 and "that is the whole mechanism".
 * The ticketing agent confirmed it. NEITHER OF US READ THE CODE. There is no
 * first-active-reason fallback on their side at all.
 *
 * The real cause, found by reading their mapping table: `urgent_transfer`
 * carries the TWO-CHARACTER keyword `er`, matched with String.includes, at
 * priority 2 — the highest in the table, so it beat every correct mapping it
 * competed with. It fires inside:
 *
 *   "Caller wants to know when she will be getting her glasses"   -> 159
 *   "Caller wants confirmation of the Indio office hours"         -> 159
 *   "Caller stated that their glasses broke at the hinge"         -> 159
 *   "Quiero cancelar mi cita"                                     -> 159
 *
 * call-ER, h-ER, numb-ER, provid-ER, transf-ER, and Qui-ER-o. Their `now`
 * keyword has the same defect one letter longer: it matches inside "know".
 *
 * And the scale is bigger than either of us had it: not 413 on the no-ivr
 * path but 479 in 90 days across the board, 97% of every ticket on request
 * type 34, and 462 of those contain no urgent word at all. Replaying 300 of
 * them through their fix reclassifies 287 (95.7%).
 *
 * THE LESSON, which is not about keywords: two agents agreeing is not
 * verification. I proposed a plausible mechanism, they confirmed it, and the
 * agreement felt like evidence. It was the same story told twice. The code was
 * unreadable to both of us — their classifier opened a database connection at
 * import, so it had no tests and could not be loaded to check — which is the
 * same shape as "a list containing a prefix of itself": the bug was not hard
 * to see, it was impossible to look at.
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
 * a transfer, and that code knows whether one happened. That population is
 * real and still arrives: department 8 carries genuine "URGENT TRANSFER
 * (record ticket — caller connected to on-call)" rows, which is why 159 stays
 * active and stays exported.
 *
 * WHY THE DISPOSITION WAS LOAD-BEARING, AND WHAT REPLACED IT. Type 34's other
 * six reasons all require the caller to NAME a symptom. Someone who said only
 * "this is urgent" matched none of them, and 159 was the only value left on
 * the type. Wayne ruled on 2026-08-13 and the ticketing app created
 *
 *   551  "Urgent Request - Symptom Not Specified"   type 34, active
 *
 * verified in the Support Center's own tables before being used here. It is
 * the LAST entry below, guarded by `excludes`, for reasons the reason name
 * does not tell you — see the comment on the entry itself.
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
  /**
   * Words that DISQUALIFY this entry even when a cue matched.
   *
   * Exists for exactly one entry — reason 551 — and documented not to grow.
   * A cue list says "this is what the caller means"; an exclude says "this
   * word means something else here", and only one word on this line does.
   */
  excludes?: string[];
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

  // --- The floor for type 34. LAST, so every specific category above wins.
  //
  // Added 2026-08-13 after Wayne ruled and the ticketing app created reason
  // 551. Until it existed, a caller who said only "this is urgent" matched
  // none of the six symptom entries and the only other value on type 34 was
  // 159 — a disposition. That is why the disposition was load-bearing.
  //
  // WHY THIS IS LAST AND GUARDED, which the reason name does not tell you.
  // Read the 90-day department 8 text: 40 tickets declare urgency, and only 6
  // name a symptom. Of the other 34, the single largest group is not a
  // complaint at all — it is a CANCELLATION, where "emergency" explains why
  // the patient cannot come:
  //
  //   "cancel the appointment ... due to family emergency, husband in ICU"
  //   "Cancel appointment due to patient being in the emergency hospital"
  //   "cancelar la cita ... debido a una emergencia familiar"
  //
  // Filing those as an urgent eye complaint inverts their meaning. The word
  // points AWAY from needing care. So scheduling language disqualifies the
  // entry outright — which also keeps the operator's ruling intact, because
  // scheduling leaves this department and a type-34 hint would pin it here.
  //
  // Stems, not enumerations: `urgent` covers urgently/urgente, `emergenc`
  // covers emergency/emergencies/emergencia. Both are long enough to be safe
  // as substrings — the `er` lesson at the top of this file.
  { requestTypeId: 34, requestType: 'Urgent/Emergency Transfer', requestReasonId: 551,
    requestReason: 'Urgent Request - Symptom Not Specified', urgent: true,
    cues: ['urgent', 'emergenc'],
    excludes: [
      // The cancellation/scheduling group — 23 of the 34.
      'cancel', 'reschedul', 'reprogram', 'appointment', 'cita', 'schedule',
      // "I want a person", which is a demand, not a symptom.
      'real human', 'real person', 'live person', 'speak with a human',
    ] },
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
    if (!c.cues.some((cue) => t.includes(fold(cue)))) continue;
    if (c.excludes?.some((ex) => t.includes(fold(ex)))) continue;
    return c;
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
