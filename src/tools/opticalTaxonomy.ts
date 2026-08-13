/**
 * Optical Support's own taxonomy — the only classifications that belong on
 * department 1, as an enum a tool can be held to.
 *
 * WHY THIS FILE EXISTS
 *
 * Measured on 90 days of real Optical tickets (1,744, of which 97% came from a
 * voice agent):
 *
 *   736 (42%)  carry NO request type at all
 *   953        carry request_reason_id 153, "Prescription Refill Request"
 *   ~55 (3%)   carry a classification that is present AND belongs to Optical
 *
 * Reason 153 belongs to request type 33, "Medication Refill", in department 3,
 * Technicians Support. Nine hundred and fifty-three optical tickets therefore
 * assert that a patient calling about glasses wanted a medication refill.
 *
 * The cause is structural, not a prompt failure. `/api/voice-agent/submit-ticket`
 * takes `reasonForCalling` as free text and re-derives the taxonomy server-side,
 * so whatever the agent understood is thrown away and guessed at again. An agent
 * that already KNOWS it is on the optical queue should not be re-guessed.
 *
 * So Optical files through `/api/voice-agent/create-ticket`, which accepts an
 * explicit (departmentId, requestTypeId, requestReasonId) triple — the escape
 * hatch PCP and after-hours already use for the same reason. This file is what
 * makes that triple impossible to get wrong: every pair below was read out of
 * the Support Center's own `request_types` / `request_reasons` tables, and a
 * reason that does not belong to its type cannot be expressed.
 */

import { anyCue, crossProduct } from './cueMatch';

export const OPTICAL_DEPARTMENT_ID = 1;

/**
 * "WHERE ARE MY GLASSES" IS THIS QUEUE, and the cue list could not hear it.
 *
 * Optical went live on 2026-08-13 and filed 14 tickets. ELEVEN landed on the
 * catch-all — 85%, the worst of the four new lines — and the descriptions
 * averaged 52 characters against 185 on the tech queue. "Other - See
 * Description" is only honest when the description carries the caller's words;
 * "contact lenses" is not a description.
 *
 * Reading 90 days of real department 1 text, one cluster dominates everything
 * else: a patient chasing an order. Every one of these missed:
 *
 *   "checking on some glasses"            "Check on the status of his glasses"
 *   "checking on status of glasses ordered"
 *   "Waiting on new glasses to arrive"    "Inquiry about eyeglasses arrival"
 *   "when she will be getting her glasses"
 *   "how long they will hold onto her glasses for"
 *   "Glasses Pickup Status Inquiry"       "Needs Status of CL"
 *
 * THREE SEPARATE REASONS THEY MISSED, and only the first is obvious:
 *
 * 1. THE CUES WERE ABOUT READINESS, THE CALLS ARE ABOUT STATUS. 'glasses
 *    ready' answers "are they ready"; nobody says that. They say "checking on",
 *    "status of", "waiting on", "when will I get".
 *
 * 2. "PICKUP" IS ONE WORD AND THE CUES ALL SAID "PICK UP". `pick up glasses`
 *    cannot match "Glasses Pickup Status Inquiry". A space is a character.
 *
 * 3. "CL" IS THE OPTICAL SHORTHAND for contact lens and appeared nowhere —
 *    two characters, so it needs the word-boundary rule in `cueMatch.ts`
 *    rather than a bare substring.
 *
 * Generated below rather than hand-listed, object by object, so that a status
 * question about CONTACTS cannot be captured by the GLASSES reason: the two
 * lists share their status phrases and differ only in what is being chased.
 */
const STATUS_PHRASES = [
  'status of', 'status on', 'check on', 'checking on', 'check the status of',
  'checking the status of', 'inquiry about', 'inquiring about', 'waiting on',
  'waiting for', 'follow up on', 'following up on', 'any update on', 'update on',
  'when will i get', 'when i will get', 'when she will be getting',
  'when he will be getting', 'when do i get', 'when can i pick up',
  'hold onto', 'holding onto', 'heard nothing about', 'heard nothing regarding',
  'estado de', 'consulta sobre', 'recogida de', 'recoleccion de',
];

/**
 * The determiner is where a hand-written list dies. "checking on SOME glasses",
 * "waiting on MY NEW glasses" — the phrase and the object are both right and
 * the cue still misses because of the word between them.
 */
const DETERMINERS = [
  '', 'my ', 'the ', 'her ', 'his ', 'their ', 'some ', 'new ', 'a ',
  'my new ', 'her new ', 'his new ', 'the new ', 'her ', 'reading ',
];

const GLASSES_OBJECTS = [
  'glasses', 'eyeglasses', 'sunglasses', 'frames', 'frame', 'lenses', 'lens',
  'lentes', 'glasses order', 'order',
];

const CONTACT_OBJECTS = [
  'contacts', 'contact lens', 'contact lenses', 'cl order', 'contacts order',
  'lentes de contacto',
];

const PICKUP_VERBS = ['pick up', 'picking up', 'pickup', 'come pick up', 'come and pick up'];

/** Object + trailing noun, for when a brand name sits in the middle. */
function suffixed(objects: string[], suffixes: string[]): string[] {
  const out: string[] = [];
  for (const o of objects) for (const s of suffixes) out.push(`${o} ${s}`);
  return out;
}

/** Generated. Exported so a test can assert real ticket text against it. */
export const OPTICAL_GLASSES_STATUS_CUES: string[] = [
  ...crossProduct(STATUS_PHRASES, DETERMINERS, GLASSES_OBJECTS),
  ...crossProduct(PICKUP_VERBS, DETERMINERS, GLASSES_OBJECTS),
  // "Inquiry about Maui Jim SUNGLASSES STATUS" — a brand between the phrase
  // and the object defeats any prefix cue, so match the trailing noun too.
  ...suffixed(GLASSES_OBJECTS, ['status', 'inquiry', 'ready', 'readiness', 'pickup', 'arrival']),
  'pickup status', 'ready for pickup', 'ready for pick up', 'pick-up',
  'glasses to arrive', 'glasses have arrived', 'glasses came in',
  'are my glasses in', 'glasses in yet', 'lentes listos', 'shipped',
  'prescription eyeglasses', 'prescription glasses are ready',
];

export const OPTICAL_CONTACTS_STATUS_CUES: string[] = [
  ...crossProduct(STATUS_PHRASES, DETERMINERS, CONTACT_OBJECTS),
  ...crossProduct(PICKUP_VERBS, DETERMINERS, CONTACT_OBJECTS),
  ...suffixed(CONTACT_OBJECTS, ['status', 'inquiry', 'ready', 'readiness', 'pickup', 'arrival']),
  'contacts to arrive', 'contacts came in', 'are my contacts in', 'contacts in yet',
  // The shorthand, safe because `cueMatch` boundary-matches anything this short.
  'cl', 'cls',
];

/**
 * ORDERING one, as opposed to chasing one already ordered. Reason 1 carried
 * 'new glasses', which does not match "new EYEglasses" — the compound word
 * breaks the substring, and seven real tickets said it that way.
 */
export const OPTICAL_NEW_ORDER_CUES: string[] = [
  ...crossProduct(['order', 'ordering', 'want to order', 'like to order', 'purchase', 'buy'],
                  DETERMINERS, GLASSES_OBJECTS),
  ...suffixed(GLASSES_OBJECTS, ['request', 'ordering inquiry', 'order inquiry']),
  'new eyeglasses', 'new glasses', 'new prescription', 'new rx',
  'pick out frames', 'choose frames', 'need glasses', 'needed sooner',
  'frame selection', 'ordenar lentes', 'comprar lentes',
];

export interface OpticalClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  /** Spoken cues that pick this pair. Lower-case, matched as substrings. */
  cues: string[];
}

/**
 * The 18 valid pairs, verbatim from the Support Center.
 *
 * Ordered most-specific first: a caller who says "my new glasses are ready"
 * should land on Product Pickup, not Frame Selection, and first match wins.
 */
export const OPTICAL_CLASSIFICATIONS: OpticalClassification[] = [
  // --- Product Pickup (5). Checked first: "ready" is a strong, specific cue.
  { requestTypeId: 5, requestType: 'Product Pickup', requestReasonId: 20, requestReason: 'Glasses Ready - Pickup',
    cues: ['glasses ready', 'glasses are ready', 'pick up my glasses', 'picking up my glasses',
           'pick up glasses', 'come pick up', 'glasses arrived', 'glasses come in', 'glasses in yet',
           ...OPTICAL_GLASSES_STATUS_CUES] },
  { requestTypeId: 5, requestType: 'Product Pickup', requestReasonId: 21, requestReason: 'Contact Lenses Ready',
    cues: ['contacts ready', 'contacts are ready', 'pick up my contacts', 'contacts arrived', 'contacts come in',
           ...OPTICAL_CONTACTS_STATUS_CUES] },
  { requestTypeId: 5, requestType: 'Product Pickup', requestReasonId: 22, requestReason: 'Remake Ready',
    cues: ['remake', 'redo', 'remade', 'replacement ready'] },

  // --- Lens Issues (2)
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 7, requestReason: 'Wrong Prescription',
    cues: ['wrong prescription', 'wrong script', 'incorrect prescription', 'not right', "can't see", 'cant see', 'blurry', 'blurred',
           // "He believes the lens is incorrect", "requesting a recheck for her
           // glasses prescription" — both are this, and neither matched.
           'lens is incorrect', 'lens is wrong', 'wrong lens', 'lenses are wrong',
           'recheck', 're-check', "aren't helpful", 'are not helpful', 'not helping'] },
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 6, requestReason: 'Scratched Lenses',
    cues: ['scratch', 'scratched', 'scratches'] },
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 8, requestReason: 'Progressive Lens Adaptation',
    cues: ['progressive', 'bifocal', 'trifocal', 'adjusting to', 'getting used to', 'trouble adapting'] },
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 9, requestReason: 'Anti-Reflective Coating Question',
    cues: ['anti-reflective', 'anti reflective', 'ar coating', 'glare', 'reflection'] },
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 10, requestReason: 'Blue Light Filter Request',
    cues: ['blue light', 'computer glasses', 'screen glasses'] },

  // --- Contact Lenses (3)
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 11, requestReason: 'Contact Lens Order',
    cues: ['order contacts', 'reorder', 'more contacts', 'box of contacts', 'running out of contacts', 'contact lens order',
           // "Ordering contact lenses for daughter" — the verb inflects and the
           // object is two words. Generated, like everything else here now.
           ...crossProduct(['order', 'ordering', 'want to order', 'like to order', 'buy', 'purchase'],
                           ['', 'my ', 'the ', 'some ', 'new ', 'more '],
                           ['contacts', 'contact lens', 'contact lenses', 'lentes de contacto'])] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 12, requestReason: 'Fitting Appointment Needed',
    cues: ['contact fitting', 'fitting', 'first time contacts', 'try contacts'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 13, requestReason: 'Contact Lens Irritation',
    cues: ['contacts hurt', 'contacts irritate', 'irritation', 'eyes are red', 'dry eyes with contacts'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 14, requestReason: 'Trial Lens Request',
    cues: ['trial lens', 'trial pair', 'sample contacts', 'trial contact', 'trial contacts'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 15, requestReason: 'Contact Lens Education',
    cues: ['how do i put', 'how to insert', 'how to remove', 'take them out', 'how do i clean'] },

  // --- Frame Selection (1). Last: its cues are the most generic.
  { requestTypeId: 1, requestType: 'Frame Selection', requestReasonId: 2, requestReason: 'Frame Repair Needed',
    cues: ['broke', 'broken', 'snapped', 'repair', 'fix my glasses', 'damaged'] },
  { requestTypeId: 1, requestType: 'Frame Selection', requestReasonId: 3, requestReason: 'Frame Adjustment',
    cues: ['adjust', 'adjustment', 'too loose', 'too tight', 'slipping', 'crooked', 'uncomfortable'] },
  { requestTypeId: 1, requestType: 'Frame Selection', requestReasonId: 5, requestReason: 'Kids Frames',
    cues: ['my son', 'my daughter', 'kids glasses', "children's frames", 'pediatric'] },
  { requestTypeId: 1, requestType: 'Frame Selection', requestReasonId: 4, requestReason: 'Style Consultation',
    cues: ['what style', 'which frames would', 'help me choose', 'recommend a frame'] },
  { requestTypeId: 1, requestType: 'Frame Selection', requestReasonId: 1, requestReason: 'New Rx - Frame Selection',
    cues: OPTICAL_NEW_ORDER_CUES },
];

/** Every reason id Optical may legitimately use. Used to reject anything else. */
export const OPTICAL_REASON_IDS = new Set(OPTICAL_CLASSIFICATIONS.map((c) => c.requestReasonId));

/**
 * The pair whose cues the caller's words match, or null.
 *
 * Null is a real answer. Optical takes "anything optical except appointment
 * requests", and plenty of that will not fit one of eighteen boxes — a ticket
 * with no classification and an honest description is better than one filed
 * under a guess, which is how 953 tickets came to claim a medication refill.
 */
export function classifyOptical(text: string): OpticalClassification | null {
  if (!String(text ?? '').trim()) return null;
  for (const c of OPTICAL_CLASSIFICATIONS) {
    // `anyCue` folds diacritics and word-boundaries short cues. The previous
    // `toLowerCase().includes` could not match "Consulta sobre estado de
    // lentes" at all, and would have fired `cl` inside any word containing it.
    if (anyCue(text, c.cues)) return c;
  }
  return null;
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function classificationByReasonId(reasonId: number): OpticalClassification | null {
  return OPTICAL_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}
