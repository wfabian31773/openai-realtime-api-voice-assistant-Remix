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
 * Operator ruling, 2026-08-12, asked directly: map what fits, leave the rest
 * honestly unclassified, do not change the Support Center today. So this file
 * covers the procedure calls and `classifySurgery` returns null for the rest —
 * and null means null. A ticket that says "needs pre-op drops, has not received
 * them, surgery is Monday" with no category is worth more to a coordinator than
 * one that confidently says New Cataract Consult, because the second one is a
 * lie they have to read the description to discover.
 *
 * Every pair below was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 2 on 2026-08-12. A reason that does
 * not belong to its type cannot be expressed.
 */

export const SURGERY_DEPARTMENT_ID = 2;

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
    cues: ['second eye', 'other eye', 'next eye', 'my left eye done', 'my right eye done', 'the second one'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 44, requestReason: 'IOL Selection Counseling',
    cues: ['iol', 'lens implant', 'lens option', 'which lens', 'premium lens', 'multifocal', 'toric', 'lens choice'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 45, requestReason: 'Pre-Op Measurements',
    cues: ['a-scan', 'a scan', 'ascan', 'biometry', 'measurements appointment', 'pre-op measurement', 'eye measurements'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 46, requestReason: 'Post-Op Follow-Up',
    cues: ['post-op appointment', 'post op appointment', 'post-op visit', 'after my surgery', 'since my surgery', 'since the surgery', 'follow-up after surgery', 'post-op check'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 43, requestReason: 'Surgery Scheduling',
    cues: ['schedule my surgery', 'schedule the surgery', 'get my surgery scheduled', 'surgery date', 'when is my surgery', 'book my surgery', 'set up my surgery', 'cataract surgery scheduled'] },
  { requestTypeId: 10, requestType: 'Cataract Surgery', requestReasonId: 42, requestReason: 'New Cataract Consult',
    // LAST, and deliberately narrow. This reason is currently on 1,710 tickets
    // that never earned it; it should only be reached when the caller actually
    // says they want to be evaluated for cataracts.
    // Every cue here pairs the CONDITION with a REQUEST TO BE SEEN. "I have
    // cataracts" on its own is not enough and deliberately does not appear:
    // most people who say it are ringing about drops, a date or a form for a
    // cataract surgery they already have booked, and matching on the condition
    // alone is precisely how 1,710 of those became New Cataract Consult.
    cues: ['cataract evaluation', 'cataract consult', 'cataract consultation', 'evaluated for cataract', 'evaluation for cataract', 'think i have cataract', 'told me i have cataract', 'told i have cataract', 'diagnosed with cataract', 'need an evaluation', 'want to be evaluated', 'set up an evaluation'] },
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
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  for (const c of SURGERY_CLASSIFICATIONS) {
    if (c.cues.some((cue) => t.includes(cue))) return c;
  }
  return null;
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
export interface SurgeryLogisticsBucket {
  key: string;
  /** Prefix for the ticket description, so these are countable without a reason id. */
  label: string;
  cues: string[];
  /** Measured 90-day volume of descriptions mentioning this, dept 2. */
  measured90d: number;
}

export const SURGERY_LOGISTICS: SurgeryLogisticsBucket[] = [
  { key: 'drops_rx', label: 'PRE-OP DROPS / RX', measured90d: 579,
    cues: ['eye drop', 'eyedrop', 'drops', 'prescription', 'pharmacy', 'not received my rx', "haven't received my rx"] },
  { key: 'clearance', label: 'CLEARANCE / FORMS', measured90d: 361,
    cues: ['clearance', 'clear me', 'pre-op form', 'pre op form', 'paperwork', 'primary care', 'pcp form', 'sign the form', 'labs', 'ekg', 'physical'] },
  { key: 'reschedule', label: 'RESCHEDULE / CANCEL', measured90d: 561,
    cues: ['reschedule', 'cancel', 'move my surgery', 'change my surgery', 'change the date', 'different day', 'postpone'] },
  { key: 'arrival', label: 'ARRIVAL / TRANSPORT', measured90d: 368,
    cues: ['what time', 'arrival time', 'when should i arrive', 'how early', 'transportation', 'ride', 'access', 'driver', 'address of'] },
  { key: 'financial', label: 'DEPOSIT / BALANCE', measured90d: 259,
    cues: ['deposit', 'balance', 'how much', 'cost', 'price', 'pay', 'owe', 'invoice', 'bill'] },
  { key: 'status', label: 'STATUS FOLLOW-UP', measured90d: 1369,
    cues: ['status', 'update on', 'still waiting', 'waiting for a call', 'no one has called', 'nobody called', 'called several times', 'follow up on my', 'any word'] },
];

/**
 * The pair used when nothing fits — and why it is not "none".
 *
 * "No category" cannot be expressed. create-ticket REQUIRES a
 * (departmentId, requestTypeId, requestReasonId) triple; measured against
 * production 2026-08-12, `requestTypeId: 0` and omitting the fields are both
 * rejected. And submit-ticket, the free-text endpoint, re-derives the
 * DEPARTMENT server-side and defaults to 8 when it cannot: VA-50811 was filed
 * by the Optical agent, said in its own description "a question about my
 * account that fits no optical category", and landed in After Hours Call
 * Service with assigned_to_id NULL. For Optical that path is the rare tail.
 * For Surgery it would be the majority of calls.
 *
 * So the choice is not between a true reason and no reason. It is between a
 * placeholder reason on a ticket that reaches the surgery coordinator, and an
 * honest one on a ticket that reaches nobody. This is the first.
 *
 * 43 "Surgery Scheduling" rather than 42 "New Cataract Consult", deliberately.
 * 42 is a CLINICAL claim — it asserts this person needs evaluating for
 * cataracts — and it is the assertion currently sitting on 1,710 tickets that
 * never earned it. 43 asserts only that the call concerns a surgery being
 * arranged, which is true of every logistics bucket below. Type 10 comes with
 * it because 43 belongs to it and Surgery Coordination has no non-procedure
 * type at all; that is the gap the Support Center needs to close, and it is
 * written up rather than papered over.
 *
 * Every ticket filed this way leads its description with the bucket label, so
 * a coordinator reads what it actually is in the first three words and the
 * practice can count these later without a reason id to group by.
 */
export const SURGERY_PLACEHOLDER = {
  requestTypeId: 10,
  requestType: 'Cataract Surgery',
  requestReasonId: 43,
  requestReason: 'Surgery Scheduling',
} as const;

/** Prefix for a request that matched no bucket either. Still countable. */
export const SURGERY_UNCATEGORISED_LABEL = 'UNCATEGORISED';

/**
 * Which logistics bucket this is, when the taxonomy has no reason for it.
 *
 * Checked AFTER `classifySurgery` returns null, never instead of it — a caller
 * who says "I need to reschedule my post-op appointment" should be reason 46
 * with a reschedule note, not an unclassified reschedule.
 */
export function classifySurgeryLogistics(text: string): SurgeryLogisticsBucket | null {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  for (const b of SURGERY_LOGISTICS) {
    if (b.cues.some((cue) => t.includes(cue))) return b;
  }
  return null;
}
