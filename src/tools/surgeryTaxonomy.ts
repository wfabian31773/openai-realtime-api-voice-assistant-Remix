/**
 * Surgery Coordination's own taxonomy — the only classifications that belong on
 * department 2, as an enum a tool can be held to.
 *
 * WHY THIS FILE EXISTS
 *
 * Measured on 90 days of real Surgery Coordination tickets (5,134), split by
 * who filed them:
 *
 *   Answering Service   2,183   1,710 on reason 42, 228 on reason 153,
 *                               245 with no reason, and ZERO on any of the
 *                               other seventeen reasons
 *   Staff / other       1,172   436 spread across the real taxonomy
 *
 * Staff use the taxonomy. The agent path has never once used it. Every ticket
 * it files says "New Cataract Consult" or nothing.
 *
 * THE CAUSE IS TWO HARDCODED FALLBACKS, not a prompt.
 * `src/config/answeringServiceTicketing.ts`:
 *
 *   detectRequestType()   no keyword matched → `case 'surgery': return CATARACT_SURGERY`
 *   detectRequestReason() no keyword matched → first reason listed for that type → 42
 *
 * So "I have not received my three eye drop prescriptions, my surgery is 8/3"
 * matches none of the keywords, is assumed to be a cataract case, and is filed
 * as a new cataract consult. Until 2026-06-22 the same two fallbacks produced
 * request_reason_id 153 — a Technicians-Support medication-refill reason — on
 * 1,443 surgery tickets. Somebody changed the default that week. The defect did
 * not move; it changed clothes.
 *
 * WHAT THIS QUEUE IS ACTUALLY CALLED ABOUT, keyword pass over 5,134 descriptions:
 *
 *   status / "still waiting for a callback"   1,369    no box exists
 *   eye drops or Rx not received                579    no box exists
 *   reschedule or cancel                        561    no box exists
 *   arrival time / transportation               368    no box exists
 *   PCP clearance forms                         361    no box exists
 *   post-op question                            270    reason 46
 *   deposit / balance                           259    no box exists
 *
 * The nineteen reasons below are all PROCEDURE boxes — which cataract, which
 * laser, which retinal repair. The calls are LOGISTICS around a surgery that is
 * already booked. The taxonomy and the phone do not describe the same queue.
 *
 * Asked about that gap, the operator's first ruling was to map what fits and
 * leave the rest unclassified. Told that "unclassified" could not actually be
 * expressed — create-ticket requires a complete triple — he gave the better
 * answer: "why don't you create one? Create another reason, to satisfy the
 * nulls, the ones that we can't quantify."
 *
 * So request type 65, "Surgery Logistics", was added to department 2 with seven
 * reasons: the six buckets above that we CAN quantify (529-534) and a catch-all
 * for what is left (535). `classifySurgeryRequest` therefore always returns a
 * reason the request genuinely earned, and nothing in this file borrows one
 * from a procedure the caller never mentioned.
 *
 * Every pair below was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 2 on 2026-08-12. A reason that does
 * not belong to its type cannot be expressed.
 */

import { anyCue, crossProduct } from './cueMatch';

export const SURGERY_DEPARTMENT_ID = 2;

/**
 * HOW A CUE IS MATCHED — rebuilt 2026-08-13 from the queue's first live day.
 *
 * It went live and filed 32 tickets. TWENTY-ONE landed on the catch-all, and
 * reading them showed three defects, none of which a unit test would have
 * found, because every test string was one I had written myself:
 *
 *   1. no diacritic folding, so Spanish could not match at all;
 *   2. hand-listed phrases with the object in the middle, so reason 43 missed
 *      every real "schedule a cataract surgery" sentence;
 *   3. "sx" — the practice's own word — in no cue anywhere.
 *
 * The matcher and the reasoning now live in `cueMatch.ts`, shared with Optical,
 * which turned out to have the identical three.
 */
export const anySurgeryCue = anyCue;

const SCHED_VERBS = [
  'schedule', 'scheduling', 'scheduled', 'book', 'booking', 'set up', 'setup',
  'arrange', 'programar', 'agendar',
];
const SCHED_DETERMINERS = [
  '', 'a ', 'an ', 'my ', 'the ', 'her ', 'his ', 'their ', 'this ', 'that ',
  'mi ', 'la ', 'el ', 'her 2nd ', 'my 2nd ', 'the 2nd ', 'my second ', 'her second ',
  // LATERALITY. "schedule the right eye surgery after the left surgery" is a
  // real sentence from the first live day and no determiner above reaches it.
  'the right ', 'the left ', 'my right ', 'my left ', 'her right ', 'her left ',
  'his right ', 'his left ', 'the other ', 'my other ', 'her other ',
];
const SCHED_OBJECTS = [
  'surgery', 'surgeries', 'sx', 'procedure', 'operation', 'cirugia', 'operacion',
  'cataract surgery', 'cataract sx', 'eye surgery', 'eye sx',
  'surgery appointment', 'surgery appt', 'sx appointment', 'sx appt',
];

/**
 * The scheduling vocabulary, GENERATED rather than guessed.
 *
 * Exported so a test can assert the real sentences from the live queue against
 * it, rather than against sentences I invented.
 */
export const SURGERY_SCHEDULING_CUES: string[] = [
  ...crossProduct(SCHED_VERBS, SCHED_DETERMINERS, SCHED_OBJECTS),
  // Asking WHEN is the same request phrased as a question.
  'when is my surgery', 'when is my sx', 'when is the surgery',
  'date and time of my', 'date of my surgery', 'surgery date', 'sx date',
  'what day is my surgery', 'when they have scheduled',
  'have not been scheduled', 'has not been scheduled', 'no surgery scheduled',
  'still waiting for a date', 'waiting for appointment date',
  'waiting for a surgery date', 'needs scheduling', 'need scheduling',
  'requesting sx', 'requesting surgery', 'next available sx', 'next available surgery',
  'cuando es mi cirugia', 'fecha de la cirugia', 'fecha de mi cirugia',
];

export interface SurgeryClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  /** Spoken cues that pick this pair. Lower-case, matched as substrings. */
  cues: string[];
  /**
   * Clinically time-critical. Only Retinal Detachment Urgent carries this.
   * A ticket is still a ticket — this raises its priority, it does not make
   * the agent a triage nurse.
   */
  urgent?: true;
}

/**
 * The 19 valid pairs, verbatim from the Support Center.
 *
 * ORDER IS THE WHOLE DESIGN. First match wins, so the list runs most-specific
 * to most-generic. The Optical build cost 830 live tickets by getting this
 * backwards — "are my glasses ready" contains both "glasses ready" and
 * "glasses", and the generic cue was listed first.
 *
 * The collisions that matter here:
 *   "post-op after my LASIK"  → 51, not 46      (51 requires a refractive cue)
 *   "my second eye"           → 47, not 43      (47 first)
 *   "schedule my cataract surgery" → 43, not 42 (a booking, not a consult)
 *   "flashes and a curtain"   → 53, first of all (an emergency outranks tidiness)
 */
export const SURGERY_CLASSIFICATIONS: SurgeryClassification[] = [
  // --- Retinal, urgent (12). FIRST, unconditionally. A detaching retina is
  // hours-sensitive and the words for it are unambiguous.
  { requestTypeId: 12, requestType: 'Retinal Surgery', requestReasonId: 53, requestReason: 'Retinal Detachment Urgent',
    urgent: true,
    cues: ['retinal detachment', 'detached retina', 'retina detach', 'curtain over', 'curtain across', 'shade over my', 'veil over', 'sudden flashes', 'flashes and floaters', 'lots of floaters', 'shower of floaters', 'lost part of my vision', 'losing vision in'] },

  // --- Oculoplastic (13). Distinctive words, no overlap with anything below.
  { requestTypeId: 13, requestType: 'Oculoplastic Surgery', requestReasonId: 60, requestReason: 'Chalazion Removal',
    cues: ['chalazion', 'stye', 'sty on my', 'bump on my eyelid', 'lump on my eyelid'] },
  { requestTypeId: 13, requestType: 'Oculoplastic Surgery', requestReasonId: 58, requestReason: 'Ectropion/Entropion Repair',
    cues: ['ectropion', 'entropion', 'eyelid turning', 'lid turns in', 'lid turns out', 'lashes rubbing'] },
  { requestTypeId: 13, requestType: 'Oculoplastic Surgery', requestReasonId: 57, requestReason: 'Ptosis Repair Consult',
    cues: ['ptosis', 'droopy eyelid', 'drooping eyelid', 'eyelid droop', 'lid is drooping'] },
  { requestTypeId: 13, requestType: 'Oculoplastic Surgery', requestReasonId: 59, requestReason: 'Blepharoplasty Consult',
    cues: ['blepharoplasty', 'bleph', 'eyelid lift', 'eyelid surgery', 'excess skin', 'bags under'] },

  // --- Retinal, scheduled (12)
  { requestTypeId: 12, requestType: 'Retinal Surgery', requestReasonId: 55, requestReason: 'Macular Hole Repair',
    cues: ['macular hole'] },
  { requestTypeId: 12, requestType: 'Retinal Surgery', requestReasonId: 56, requestReason: 'Epiretinal Membrane Peel',
    cues: ['epiretinal', 'membrane peel', 'macular pucker'] },
  { requestTypeId: 12, requestType: 'Retinal Surgery', requestReasonId: 54, requestReason: 'Vitrectomy Scheduling',
    cues: ['vitrectomy'] },

  // --- LASIK / Refractive (11). Before the cataract block: "post-op" and
  // "scheduling" mean different reasons depending on which surgery it is, and
  // the refractive cues are the specific half of that pair.
  { requestTypeId: 11, requestType: 'LASIK / Refractive', requestReasonId: 51, requestReason: 'Post-Refractive Follow-Up',
    cues: ['after my lasik', 'after lasik', 'since my lasik', 'post-op lasik', 'post op lasik', 'lasik follow', 'after my prk', 'since my prk'] },
  { requestTypeId: 11, requestType: 'LASIK / Refractive', requestReasonId: 52, requestReason: 'Enhancement Evaluation',
    cues: ['enhancement', 'touch up', 'touch-up', 'lasik again', 'regression'] },
  { requestTypeId: 11, requestType: 'LASIK / Refractive', requestReasonId: 50, requestReason: 'Refractive Surgery Scheduling',
    cues: ['schedule lasik', 'schedule my lasik', 'schedule prk', 'book lasik', 'laser surgery date', 'lasik date'] },
  { requestTypeId: 11, requestType: 'LASIK / Refractive', requestReasonId: 49, requestReason: 'PRK Consultation',
    cues: ['prk'] },
  { requestTypeId: 11, requestType: 'LASIK / Refractive', requestReasonId: 48, requestReason: 'LASIK Consultation',
    cues: ['lasik', 'laser vision', 'laser eye surgery', 'get rid of my glasses'] },

  // --- Cataract (10), specific reasons before the two generic ones.
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 47, requestReason: 'Second Eye Surgery',
    // "2nd eye sx" is how the practice writes it — six of these in 90 days
    // used the digit form and none of them matched.
    cues: ['second eye', '2nd eye', 'other eye', 'next eye', 'my left eye done', 'my right eye done',
           'the second one', 'second surgery', '2nd surgery', 'second sx', '2nd sx',
           'segundo ojo', 'otro ojo', 'right eye surgery after', 'left eye surgery after'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 44, requestReason: 'IOL Selection Counseling',
    cues: ['iol', 'lens implant', 'lens option', 'which lens', 'premium lens', 'multifocal', 'toric', 'lens choice'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 45, requestReason: 'Pre-Op Measurements',
    cues: ['a-scan', 'a scan', 'ascan', 'biometry', 'measurements appointment', 'pre-op measurement', 'eye measurements'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 46, requestReason: 'Post-Op Follow-Up',
    cues: ['post-op appointment', 'post op appointment', 'post-op visit', 'after my surgery', 'since my surgery', 'since the surgery', 'follow-up after surgery', 'post-op check'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 43, requestReason: 'Surgery Scheduling',
    // GENERATED — see SURGERY_SCHEDULING_CUES. The hand-written list this
    // replaced missed every real sentence on the queue's first live day.
    cues: SURGERY_SCHEDULING_CUES },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 42, requestReason: 'New Cataract Consult',
    // LAST, and deliberately narrow. This reason is currently on 1,710 tickets
    // that never earned it; it should only be reached when the caller actually
    // says they want to be evaluated for cataracts.
    // Every cue here pairs the CONDITION with a REQUEST TO BE SEEN. "I have
    // cataracts" on its own is not enough and deliberately does not appear:
    // most people who say it are ringing about drops, a date or a form for a
    // cataract surgery they already have booked, and matching on the condition
    // alone is precisely how 1,710 of those became New Cataract Consult.
    cues: ['cataract evaluation', 'cataract consult', 'cataract consultation', 'evaluated for cataract', 'evaluation for cataract', 'think i have cataract', 'told me i have cataract', 'told i have cataract', 'diagnosed with cataract', 'need an evaluation', 'want to be evaluated', 'set up an evaluation',
           // THE REFERRAL IN, which is the one first-contact shape the narrow
           // list above could not reach: "My husband went to the optometrist
           // today, and they sent him to the ophthalmologist. They said he has
           // a cataract." It still pairs a referral with the condition, so it
           // does not reopen the 1,710-ticket over-capture.
           'sent him to the ophthalmologist', 'sent her to the ophthalmologist',
           'sent me to the ophthalmologist', 'referred to the ophthalmologist',
           'referred me to a surgeon', 'said he has a cataract', 'said she has a cataract',
           'me mandaron al oftalmologo'] },
];

/** Every reason id Surgery may legitimately use. Used to reject anything else. */
export const SURGERY_REASON_IDS = new Set(SURGERY_CLASSIFICATIONS.map((c) => c.requestReasonId));

/**
 * The pair whose cues the caller's words match, or null.
 *
 * NULL IS THE COMMON ANSWER HERE AND IT IS THE CORRECT ONE.
 *
 * Unlike Optical, where eighteen boxes covered most of the queue, Surgery's
 * nineteen boxes cover roughly the procedure half of the calls. Drops, clearance
 * forms, arrival times, reschedules, deposits and status chases have no box at
 * all, and together they are the majority. Returning null for them is the
 * fix, not a shortfall: the alternative is what the current code does, which is
 * to call every one of them a New Cataract Consult.
 */
export function classifySurgery(text: string): SurgeryClassification | null {
  if (!String(text ?? '').trim()) return null;
  for (const c of SURGERY_CLASSIFICATIONS) {
    if (anySurgeryCue(text, c.cues)) return c;
  }
  return null;
}

/**
 * A POST-OPERATIVE SYMPTOM — someone who has had the surgery and something is
 * wrong with the eye now.
 *
 * Added 2026-08-13 because the first live day produced this, filed as
 * "Other - See Description" at medium priority:
 *
 *   "I had cataract surgery on my right eye, but it feels like there's
 *    something stuck in my eye and I need to see the doctor."
 *
 * Surgery flagged 0 of 32 tickets that day at any raised priority, while the
 * tech queue flagged 18 of 57. This queue had no urgency concept beyond a
 * detaching retina, and a post-op foreign-body sensation is not a detaching
 * retina — but it is not a scheduling question either.
 *
 * DELIBERATELY NOT `urgent`. That flag makes the agent say "seek emergency
 * care or call 911 now", which is right for reason 53 and wrong here. This
 * raises priority to high and says a coordinator should call today. The
 * distinction matters: telling a post-op cataract patient to dial 911 over a
 * gritty eye is its own harm.
 *
 * BOTH HALVES ARE REQUIRED — a post-op context AND a symptom. "When is my
 * post-op appointment" is not a symptom, and "my eye hurts" from someone who
 * has had no surgery is not this queue's call.
 */
const POSTOP_CONTEXT_CUES = [
  'had surgery', 'had my surgery', 'had cataract surgery', 'had the surgery', 'had my cataract',
  'after my surgery', 'after the surgery', 'since my surgery', 'since the surgery',
  'post-op', 'post op', 'postop', 'had my sx', 'had sx', 'my surgery was',
  'operated', 'me operaron', 'despues de la cirugia', 'desde la cirugia', 'ya me operaron',
];

const POSTOP_SYMPTOM_CUES = [
  'stuck in my eye', 'something in my eye', 'feels like something', 'foreign body',
  'pain', 'hurts', 'hurting', 'burning', 'swollen', 'swelling', 'redness', 'red eye',
  'discharge', 'pus', 'bleeding', 'blurry', 'blurred', 'cannot see', "can't see",
  'vision is worse', 'getting worse', 'flashes', 'floaters', 'light sensitivity',
  'dolor', 'duele', 'hinchado', 'sangrado', 'borroso', 'no puedo ver', 'empeorando',
];

export function isSurgeryPostOpSymptom(text: string): boolean {
  if (!String(text ?? '').trim()) return false;
  return anySurgeryCue(text, POSTOP_CONTEXT_CUES) && anySurgeryCue(text, POSTOP_SYMPTOM_CUES);
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function surgeryClassificationByReasonId(reasonId: number): SurgeryClassification | null {
  return SURGERY_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}

/**
 * The logistics buckets the taxonomy has no reasons for.
 *
 * These do NOT produce a classification — there is nothing valid to produce.
 * They exist so the tool can tell the agent "I know exactly what this is and
 * there is no box for it", which is a different and more useful answer than
 * "I have no idea", and so the description carries a consistent leading phrase
 * that a coordinator can scan and the practice can count later.
 *
 * The counts are 90-day measurements and are what the ticketing app would need
 * to size new reasons if the operator decides to add them.
 */
export interface SurgeryLogisticsBucket extends SurgeryClassification {
  key: string;
  /** Human label, also used when a description needs to name the bucket. */
  label: string;
  /** Measured 90-day volume of descriptions mentioning this, dept 2. */
  measured90d: number;
}

const LOGISTICS_TYPE = { requestTypeId: 65, requestType: 'Surgery Logistics' } as const;

export const SURGERY_LOGISTICS: SurgeryLogisticsBucket[] = [
  { ...LOGISTICS_TYPE, requestReasonId: 529, requestReason: 'Pre-Op Drops / Prescription',
    key: 'drops_rx', label: 'Pre-Op Drops / Prescription', measured90d: 579,
    cues: ['eye drop', 'eyedrop', 'drops', 'prescription', 'pharmacy', 'not received my rx', "haven't received my rx",
           'gotas', 'receta', 'farmacia', 'pre-op drops', 'pre op drops', 'combo drop'] },
  { ...LOGISTICS_TYPE, requestReasonId: 530, requestReason: 'Clearance / Pre-Op Forms',
    key: 'clearance', label: 'Clearance / Pre-Op Forms', measured90d: 361,
    cues: ['clearance', 'clear me', 'pre-op form', 'pre op form', 'paperwork', 'primary care', 'pcp form',
           'sign the form', 'labs', 'ekg', 'physical',
           // The packet is what patients call the pre-op paperwork bundle, and
           // "pre-surgery things" is how they ask whether it is all done.
           'surgery packet', 'sx packet', 'pre-surgery kit', 'pre surgery kit',
           'pre-surgery things', 'pre surgery things', 'papeleo', 'formulario'] },
  { ...LOGISTICS_TYPE, requestReasonId: 531, requestReason: 'Reschedule / Cancel Surgery',
    key: 'reschedule', label: 'Reschedule / Cancel Surgery', measured90d: 561,
    cues: ['reschedule', 'cancel', 'move my surgery', 'change my surgery', 'change the date', 'different day', 'postpone',
           // Spanish nominalises where English uses a verb — "Cancelación de la
           // cita", not "cancelar". Stems cover both, and fold() handles the
           // accent. Same lesson as the department 8 cue list.
           'cancelacion', 'cancelar', 'reprogram', 'mover la cirugia', 'cambiar la fecha',
           'cambiado la cita', 'cambiar la cita', 'cambio de cita', 'cambiado la fecha',
           'postponed', 'was moved to', 'moved to october', 'rs appt', 'rescheduling'] },
  { ...LOGISTICS_TYPE, requestReasonId: 532, requestReason: 'Arrival Time / Transportation',
    key: 'arrival', label: 'Arrival Time / Transportation', measured90d: 368,
    cues: ['what time', 'arrival time', 'when should i arrive', 'how early', 'transportation', 'ride', 'access', 'driver', 'address of',
           'surgery time', 'sx time', 'time of his surgery', 'time of her surgery', 'time of my surgery',
           'nearer', 'closer to', 'hora de la cirugia', 'transporte'] },
  { ...LOGISTICS_TYPE, requestReasonId: 533, requestReason: 'Deposit / Balance Question',
    key: 'financial', label: 'Deposit / Balance Question', measured90d: 259,
    cues: ['deposit', 'balance', 'how much', 'cost', 'price', 'pay', 'owe', 'invoice', 'bill',
           'pagar', 'pago', 'costo', 'precio', 'cuanto cuesta', 'financial question'] },
  { ...LOGISTICS_TYPE, requestReasonId: 534, requestReason: 'Status Follow-Up',
    key: 'status', label: 'Status Follow-Up', measured90d: 1369,
    // The largest bucket in the queue at 1,369 in 90 days, and the one whose
    // real phrasing is most varied — it is nearly always a complaint about
    // silence rather than a request for information.
    cues: ['status', 'update on', 'still waiting', 'waiting for a call', 'no one has called', 'nobody called',
           'called several times', 'follow up on my', 'any word',
           'no one is calling', 'not calling her back', 'not calling him back', 'has not received a call',
           "haven't heard", 'have not heard', "hasn't called", 'has not called', 'never called',
           'waiting for a return call', 'return my call', 'forgot about', 'been trying to reach',
           'leaving messages', 'left messages', 'lack of updates', 'called 3 times', 'called three times',
           'follow up on surgery', 'follow-up on surgery', 'following up',
           'no me han llamado', 'no me llamaron', 'sigo esperando', 'esperando una llamada',
           // A CALLBACK REQUEST IS A STATUS CHASE on this queue. Nearly every
           // one of these is "nobody has got back to me", and the named person
           // is a surgery coordinator. Broad on purpose and SAFE because this
           // bucket is checked last, after every procedure box and every other
           // logistics bucket — the rule that a bare `copy of` is safe in
           // Medical Records' 500 only because everything stronger ran first.
           // "call me back" does NOT contain "call back" — the object sits in
           // the middle again, which is the same trap that cost reason 43 its
           // whole vocabulary. Enumerate the pronouns rather than assume.
           'call me back', 'call him back', 'call her back', 'call them back',
           'calling me back', 'calling her back', 'calling him back', 'call me',
           'call back', 'callback', 'call the patient', 'please call', 'give her a call',
           'give him a call', 'speak with someone', 'speak to someone', 'speak directly to',
           'surgery coordinator', 'sx coordinator', 'coordinator', 'que me llamen'] },
];

/**
 * The catch-all, which is now a REAL reason rather than a borrowed one.
 *
 * This block used to define a placeholder: reason 43 "Surgery Scheduling",
 * chosen as the least-wrong of the nineteen procedure boxes, because
 * create-ticket REQUIRES a (departmentId, requestTypeId, requestReasonId)
 * triple and "no category" could not be expressed. Every unclassifiable call —
 * the majority of this queue — would have carried a reason it did not earn.
 *
 * Operator, 2026-08-12, on being told that: "why don't you create one? Create
 * another reason, to satisfy the nulls, the ones that we can't quantify."
 *
 * So request type 65, "Surgery Logistics", was added to department 2 with seven
 * reasons: the six buckets measured below, which we CAN quantify, and this one
 * for what is left. Nothing in this file borrows a reason from another kind of
 * request any more.
 */
export const SURGERY_CATCHALL: SurgeryClassification = {
  // Department 2's own "Other - See Description". Not a shared id: a reason
  // belongs to a type and a type belongs to one department, so every queue has
  // its own and files into the department that took the call. See
  // `otherReason.ts`, which holds the table for all sixteen.
  requestTypeId: 65,
  requestType: 'Surgery Logistics',
  requestReasonId: 535,
  requestReason: 'Other - See Description',
  cues: [],
};

/**
 * Which logistics bucket this is, when the taxonomy has no reason for it.
 *
 * Checked AFTER `classifySurgery` returns null, never instead of it — a caller
 * who says "I need to reschedule my post-op appointment" should be reason 46
 * with a reschedule note, not an unclassified reschedule.
 */
export function classifySurgeryLogistics(text: string): SurgeryLogisticsBucket | null {
  if (!String(text ?? '').trim()) return null;
  for (const b of SURGERY_LOGISTICS) {
    if (anySurgeryCue(text, b.cues)) return b;
  }
  return null;
}

/**
 * The classification for this request. Never null.
 *
 * Procedure boxes first, then the logistics reasons, then the catch-all. The
 * order between the first two is what makes "I need to move my post-op
 * appointment" reason 46 rather than a bare reschedule: it is a post-op matter
 * that happens to involve a date, and the procedure reason is the more specific
 * of the two.
 *
 * Before request type 65 existed this function could not have been written —
 * there was nothing true to return for most of the queue.
 */
export function classifySurgeryRequest(text: string): {
  classification: SurgeryClassification;
  /** True when nothing matched and this is the catch-all. */
  isCatchAll: boolean;
  /** True when the match came from a logistics reason rather than a procedure one. */
  isLogistics: boolean;
} {
  const procedure = classifySurgery(text);
  if (procedure) return { classification: procedure, isCatchAll: false, isLogistics: false };

  const bucket = classifySurgeryLogistics(text);
  if (bucket) return { classification: bucket, isCatchAll: false, isLogistics: true };

  return { classification: SURGERY_CATCHALL, isCatchAll: true, isLogistics: false };
}

/** Every reason this queue may file under, procedure or logistics. */
export function isSurgeryReasonId(id: number): boolean {
  return (
    SURGERY_REASON_IDS.has(id) ||
    SURGERY_LOGISTICS.some((b) => b.requestReasonId === id) ||
    id === SURGERY_CATCHALL.requestReasonId
  );
}

/** Look up any reason this queue may file under, procedure or logistics. */
export function surgeryReasonById(id: number): SurgeryClassification | null {
  return (
    surgeryClassificationByReasonId(id) ??
    SURGERY_LOGISTICS.find((b) => b.requestReasonId === id) ??
    (id === SURGERY_CATCHALL.requestReasonId ? SURGERY_CATCHALL : null)
  );
}
