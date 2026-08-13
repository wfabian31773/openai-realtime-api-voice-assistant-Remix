/**
 * Clinical Tech Support's own taxonomy — the only classifications that belong
 * on department 3, as an enum a tool can be held to.
 *
 * WHY THIS FILE EXISTS
 *
 * This is the practice's largest queue: 9,288 tickets in 90 days, 8,064 of them
 * filed by the answering-service path. That path used TWO reasons between them:
 *
 *   153  Prescription Refill Request   6,905
 *   (none)                             1,714
 *   154  Eye Drop Refill                 214
 *   the other sixteen, combined         ~350
 *
 * Staff filing by hand used seventeen. The taxonomy is not the problem here —
 * unlike Surgery, department 3's nineteen reasons genuinely describe the calls.
 * Nothing needs creating. Six thousand nine hundred tickets need splitting into
 * reasons that already exist.
 *
 * THE CAUSE, same two hardcoded fallbacks as everywhere else
 * (`config/answeringServiceTicketing.ts`):
 *
 *   detectRequestType()    no keyword matched -> the department's default type
 *   detectRequestReason()  no keyword matched -> the first reason of that type
 *
 * And the part that stings: THE MODEL ALREADY GETS THIS RIGHT. Ticket
 * descriptions carry its own classification in prose —
 *
 *   REASON FOR CALL: Subject: Medication Refill Request for Lumigan Eye Drops
 *   Request Type: Medication Requests
 *   Request Reason: Refill Request
 *
 * — and the code discards it and stamps 153. Prescription Assistance / Rx
 * Clarification, Patient Assistance / Callback Request, all of it, written into
 * the description and thrown away before it reaches a column anyone can filter.
 *
 * TWO MEASUREMENTS THAT SHAPED THE CUES, both counter-intuitive:
 *
 *   PHARMACY IS ALMOST NEVER A TRANSFER. 2,263 descriptions mention a pharmacy;
 *   only 59 describe an actual transfer. The rest are saying where to SEND a
 *   refill. Cueing 158 on pharmacy names would mis-file about 2,200 tickets, so
 *   its cues require transfer language and never a pharmacy name alone.
 *
 *   GLAUCOMA IS NAMED BY DRUG, NOT BY CONDITION. 278 descriptions say
 *   "glaucoma"; 1,700 name a glaucoma drug. A taxonomy keyed on the word would
 *   miss six of every seven, so 155 carries the drug list.
 *
 * THE ONE GAP THIS TAXONOMY CANNOT COVER, measured at 167 tickets in 90 days:
 * "the prescription never reached the pharmacy" — sent to the wrong one, not
 * sent at all, needs re-sending. It is a distinct, recurring problem and
 * department 3 has no reason for it. Those calls fall to the catch-all with an
 * honest description rather than being forced into Rx Clarification, which is
 * about directions, or Pharmacy Transfer, which is about moving an existing
 * prescription. Worth its own reason if the operator wants one; the count is
 * here so the decision can be made on a number.
 *
 * Every pair below was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 3 on 2026-08-13.
 */

import { anyCue } from './cueMatch';

export const TECH_DEPARTMENT_ID = 3;

export interface TechClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  /** Spoken cues that pick this pair. Lower-case, matched as substrings. */
  cues: string[];
  /** Clinically time-sensitive — raises priority, does not make the agent a nurse. */
  urgent?: true;
}

/**
 * Glaucoma drops, by brand and generic.
 *
 * Six of every seven glaucoma calls name the drug and never say "glaucoma".
 * These are sight-preserving medications a patient must not run out of, which
 * is why the practice gave them their own reason.
 */
const GLAUCOMA_DRUGS = [
  'latanoprost', 'xalatan', 'timolol', 'timoptic', 'istalol',
  'dorzolamide', 'trusopt', 'cosopt', 'brimonidine', 'alphagan', 'combigan',
  'lumigan', 'bimatoprost', 'travatan', 'travoprost', 'azopt', 'brinzolamide',
  'rhopressa', 'netarsudil', 'vyzulta', 'rocklatan', 'simbrinza',
  'betoptic', 'betaxolol', 'zioptan', 'tafluprost', 'iyuzeh',
];

/** Drops given around surgery — steroids, antibiotics, anti-inflammatories. */
const POST_SURGERY_DRUGS = [
  'prednisolone', 'pred forte', 'durezol', 'difluprednate', 'eysuvis',
  'lotemax', 'loteprednol', 'inveltys', 'moxifloxacin', 'vigamox',
  'ofloxacin', 'ciprofloxacin', 'tobramycin', 'tobradex', 'besivance',
  'ketorolac', 'acuvail', 'prolensa', 'bromfenac', 'nevanac', 'ilevro',
  'combo drop', 'combination drop', 'compounded drop',
];

/**
 * Moving a prescription between pharmacies, in the shapes people actually say it.
 *
 * Substring cues cannot express "a movement verb followed by 'pharmacy'", and
 * hand-listing the variants missed both "I changed pharmacies" and "switch MY
 * pharmacy" on the first two attempts. Generating verb x determiner covers the
 * grammar instead of guessing at it.
 *
 * Crucially this still cannot fire on a pharmacy merely being NAMED as the
 * destination — "refill it and send to CVS" matches nothing here, which is the
 * difference between 59 real transfers and 2,263 mentions.
 */
const MOVE_VERBS = [
  'switch', 'switched', 'switching',
  'change', 'changed', 'changing',
  'move', 'moved', 'moving',
  'transfer', 'transferred', 'transferring',
];
const DETERMINERS = ['', 'my ', 'the ', 'his ', 'her ', 'our ', 'to a different ', 'to another '];

const PHARMACY_TRANSFER_CUES = [
  ...MOVE_VERBS.flatMap((v) => DETERMINERS.map((d) => `${v} ${d}pharmac`)),
  'transfer my prescription', 'transfer my rx', 'transfer the prescription',
  'move my prescription', 'move my rx',
  'different pharmac', 'new pharmac', 'send it to a different',
];

/**
 * The valid pairs, ordered MOST-SPECIFIC FIRST. First match wins.
 *
 * Order is the whole design. The Optical build cost 830 live tickets by getting
 * it backwards, and this queue has more overlap than any other: a glaucoma drop
 * refill sent to CVS matches three buckets at once.
 *
 * The rules that resolve those collisions:
 *   a symptom outranks a refill    "my latanoprost burns"      -> 209, not 155
 *   an insurance block outranks it "they denied my Lumigan"    -> 210, not 155
 *   a named drug outranks "drops"  "refill my Combigan"        -> 155, not 154
 *   a real transfer outranks both  "move my Rx to Walgreens"   -> 158
 *   naming a pharmacy does NOT     "refill, send to CVS"       -> stays a refill
 */
export const TECH_CLASSIFICATIONS: TechClassification[] = [
  // --- Clinical concern first. A patient reporting a reaction is not a refill.
  { requestTypeId: 6, requestType: 'Medication Requests', requestReasonId: 209, requestReason: 'Side Effect Concern',
    cues: ['side effect', 'reaction', 'allergic', 'irritation from', 'burning', 'stinging', 'itching', 'swollen', 'blurry after', 'made my eyes', 'is bothering my', 'hurts when i use'] },

  // --- Blocked by insurance. The drug is irrelevant; the obstacle is the point.
  { requestTypeId: 6, requestType: 'Medication Requests', requestReasonId: 210, requestReason: 'Prior Authorization',
    cues: ['prior auth', 'pre-auth', 'preauth', 'authorization', 'insurance denied', 'denied by', 'not covered', 'needs approval', 'insurance wont', "insurance won't", 'too expensive', 'co-pay', 'copay', 'cost of', 'how much is', 'cheaper', 'discount', 'coupon', 'coverage'] },

  // --- A genuine move between pharmacies. NOT merely naming one: 2,263
  // descriptions mention a pharmacy and only 59 are transfers.
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 158, requestReason: 'Pharmacy Transfer Request',
    cues: PHARMACY_TRANSFER_CUES },

  // --- Named medication classes, before the generic "drops".
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 155, requestReason: 'Glaucoma Medication Refill',
    cues: ['glaucoma', ...GLAUCOMA_DRUGS] },
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 156, requestReason: 'Post-Surgery Medication Refill',
    cues: ['after my surgery', 'after surgery', 'post-op drop', 'post op drop', 'post-surgery', 'since my surgery', 'for my cataract surgery', ...POST_SURGERY_DRUGS] },
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 157, requestReason: 'Contact Lens Prescription Renewal',
    cues: ['contact lens prescription', 'contact lens rx', 'renew my contact', 'contacts prescription', 'prescription for contacts'] },

  // --- Nothing left to refill. Before the generic refill: "out of refills" is
  // a different problem from "please refill".
  { requestTypeId: 7, requestType: 'Prescription Assistance', requestReasonId: 213, requestReason: 'Lost/Expired Rx',
    cues: ['no refills left', 'out of refills', 'no more refills', 'expired', 'ran out', 'lost my prescription', 'lost the prescription', 'misplaced'] },

  // --- Never had one.
  { requestTypeId: 7, requestType: 'Prescription Assistance', requestReasonId: 214, requestReason: 'New Rx Request',
    cues: ['new prescription', 'new rx', 'never got', 'never received', 'was never sent', 'needs a prescription', 'need a prescription for'] },

  // --- Asking about it rather than asking for it.
  { requestTypeId: 7, requestType: 'Prescription Assistance', requestReasonId: 211, requestReason: 'Rx Clarification',
    cues: ['how do i use', 'how often', 'how many times', 'which eye', 'wrong dose', 'wrong strength', 'dosage', 'instruction', 'direction', 'clarify', 'clarification', 'is this the right'] },
  { requestTypeId: 6, requestType: 'Medication Requests', requestReasonId: 208, requestReason: 'Medication Question',
    cues: ['medication question', 'question about my medic', 'question about the medic', 'can i take', 'safe to take', 'interact', 'with my other medic', 'should i stop', 'stopping'] },

  // --- Not medication at all.
  { requestTypeId: 8, requestType: 'Patient Assistance', requestReasonId: 216, requestReason: 'Medical Records Request',
    cues: ['medical record', 'records request', 'copy of my chart', 'send my records', 'fax my records', 'release of information'] },
  { requestTypeId: 8, requestType: 'Patient Assistance', requestReasonId: 217, requestReason: 'Forms Completion',
    cues: ['form', 'paperwork', 'dmv', 'disability', 'fmla', 'letter for', 'note for work', 'fill out'] },
  { requestTypeId: 8, requestType: 'Patient Assistance', requestReasonId: 218, requestReason: 'Referral Coordination',
    cues: ['referral', 'refer me', 'refer her', 'refer him', 'see a specialist', 'authorization for a specialist'] },

  // --- The generic drop refill. AFTER the named classes above.
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 154, requestReason: 'Eye Drop Refill',
    cues: ['eye drop', 'eyedrop', 'drops', 'gotas', 'colirio'] },

  // --- The generic refill. LAST of the medication reasons, and the one that
  // currently carries 6,905 tickets it did not earn.
  { requestTypeId: 33, requestType: 'Medication Refill', requestReasonId: 153, requestReason: 'Prescription Refill Request',
    cues: ['refill', 'renew my prescription', 'renewal', 'more of my medic', 'running low',
           'resurtir', 'resurtido', 'surtir', 'reposicion', 'reposición', 'renovar receta', 'medicamento'] },

  // --- Someone wants a person to ring them back and said nothing else.
  { requestTypeId: 8, requestType: 'Patient Assistance', requestReasonId: 215, requestReason: 'Callback Request',
    cues: ['callback', 'call me back', 'have someone call', 'return my call', 'speak to someone', 'waiting for a call', 'llamada'] },
];

/** Department 3's own "Other - See Description" — see `otherReason.ts`. */
export const TECH_CATCHALL: TechClassification = {
  requestTypeId: 72,
  requestType: 'General / Other',
  requestReasonId: 542,
  requestReason: 'Other - See Description',
  cues: [],
};

/** Every reason id this queue may use. */
export const TECH_REASON_IDS = new Set([
  ...TECH_CLASSIFICATIONS.map((c) => c.requestReasonId),
  TECH_CATCHALL.requestReasonId,
]);

/** The pair whose cues the caller's words match, or null. */
export function classifyTech(text: string): TechClassification | null {
  if (!String(text ?? '').trim()) return null;
  for (const c of TECH_CLASSIFICATIONS) {
    // THE LAST TAXONOMY THAT COULD NOT READ SPANISH.
    //
    // This was `toLowerCase().includes` until 2026-08-13 — no diacritic
    // folding, so an accented word could not match a cue even when the cue
    // existed. Surgery, Optical and After Hours were all converted once real
    // tickets showed the miss. Tech is the LARGEST queue in the practice and
    // was the last one still doing it, which is the wrong order to have found
    // them in — I converted the ones whose failures I happened to read.
    //
    // `anyCue` also word-boundaries short cues, so `rx` cannot fire inside
    // another word.
    if (anyCue(text, c.cues)) return c;
  }
  return null;
}

/**
 * The classification for this request. Never null.
 *
 * Falls to department 3's own catch-all rather than to the first reason of a
 * default type, which is the behaviour that put 6,905 tickets on reason 153.
 */
export function classifyTechRequest(text: string): {
  classification: TechClassification;
  isCatchAll: boolean;
} {
  const hit = classifyTech(text);
  return hit
    ? { classification: hit, isCatchAll: false }
    : { classification: TECH_CATCHALL, isCatchAll: true };
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function techReasonById(reasonId: number): TechClassification | null {
  if (reasonId === TECH_CATCHALL.requestReasonId) return TECH_CATCHALL;
  return TECH_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}
