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

export const OPTICAL_DEPARTMENT_ID = 1;

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
    cues: ['glasses ready', 'glasses are ready', 'pick up my glasses', 'picking up my glasses', 'pick up glasses', 'glasses arrived', 'glasses come in', 'glasses in yet'] },
  { requestTypeId: 5, requestType: 'Product Pickup', requestReasonId: 21, requestReason: 'Contact Lenses Ready',
    cues: ['contacts ready', 'contacts are ready', 'pick up my contacts', 'contacts arrived', 'contacts come in'] },
  { requestTypeId: 5, requestType: 'Product Pickup', requestReasonId: 22, requestReason: 'Remake Ready',
    cues: ['remake', 'redo', 'remade', 'replacement ready'] },

  // --- Lens Issues (2)
  { requestTypeId: 2, requestType: 'Lens Issues', requestReasonId: 7, requestReason: 'Wrong Prescription',
    cues: ['wrong prescription', 'wrong script', 'incorrect prescription', 'not right', "can't see", 'cant see', 'blurry', 'blurred'] },
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
    cues: ['order contacts', 'reorder', 'more contacts', 'box of contacts', 'running out of contacts', 'contact lens order'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 12, requestReason: 'Fitting Appointment Needed',
    cues: ['contact fitting', 'fitting', 'first time contacts', 'try contacts'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 13, requestReason: 'Contact Lens Irritation',
    cues: ['contacts hurt', 'contacts irritate', 'irritation', 'eyes are red', 'dry eyes with contacts'] },
  { requestTypeId: 3, requestType: 'Contact Lenses', requestReasonId: 14, requestReason: 'Trial Lens Request',
    cues: ['trial lens', 'trial pair', 'sample contacts'] },
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
    cues: ['new prescription', 'new rx', 'new glasses', 'pick out frames', 'choose frames', 'need glasses'] },
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
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  for (const c of OPTICAL_CLASSIFICATIONS) {
    if (c.cues.some((cue) => t.includes(cue))) return c;
  }
  return null;
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function classificationByReasonId(reasonId: number): OpticalClassification | null {
  return OPTICAL_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}
