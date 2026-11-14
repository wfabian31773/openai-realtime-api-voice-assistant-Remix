import { correctSurgeryIntake, hasClinicalComplaint, isSurgeryRequest } from './requestClassification';
import { SCHEDULING } from '../../shared/scheduling-cues';
import { SURGERY_SCHEDULING_CUES } from './surgeryTaxonomy';

export { SCHEDULING, type SchedulingCue } from '../../shared/scheduling-cues';

/**
 * A caller who pressed the wrong option is not the caller's problem.
 *
 * OPERATOR RULING, 2026-08-13:
 *
 *   "These are specific queues that are being forwarded. But if someone calls
 *    and they press two for medication refill, and it's an optical question, we
 *    can't just tell the patient call back, call the wrong extension. We have to
 *    have a process where it goes to the appropriate department, which in this
 *    case obviously is optical. And anything that's schedule related that comes
 *    through any of these should go to the HVA hub."
 *
 * Each queue agent knows its own subject because of the line that rang. That is
 * what keeps its prompt small, and it is right almost all of the time — but
 * "almost all" over 9,288 tickets a quarter is a lot of patients told to hang up
 * and dial again. Department 3's own data already shows it: "assistance with
 * eyeglass prescription selection" and "request to schedule an eye exam" are
 * sitting in the medication queue today.
 *
 * So a queue tool files into ITS OWN department unless the caller's words
 * clearly belong to another one, and then it files there instead. The patient is
 * never asked to call back, and the receiving team gets a ticket that says how
 * it arrived.
 *
 * WHAT THIS IS NOT
 *
 * It is not a general classifier and it must not become one. Its job is to catch
 * the OBVIOUS misroute — glasses on the medication line, an appointment request
 * on any line — and to stay silent otherwise, because the line that rang is
 * better evidence than a keyword. When it is unsure it returns null and the
 * home queue keeps the call.
 */

export interface QueueRedirect {
  departmentId: number;
  departmentName: string;
  requestTypeId: number;
  requestReasonId: number;
  requestReason: string;
  /** One line for the description, so the receiving team knows how it arrived. */
  note: string;
}

/** Departments a queue call can legitimately be redirected into. */
const OPTICAL = 1;
const SURGERY = 2;
const TECH = 3;
const HVA_HUB = 9;
/**
 * Medical Records is a HOME department here, never a destination.
 *
 * Nothing redirects INTO it: "can I get a copy of my records" on the optical
 * line is a question the optician can pass along, and a records team is not a
 * place to send a call on a keyword. But records requests constantly name
 * another department's subject — "the notes from the surgery I had on 7/30",
 * "a copy of my glasses prescription" — and without a guard those would be
 * dragged off the records queue by the surgery and optical cues below.
 */
const MEDICAL_RECORDS = 16;

/**
 * What a records request sounds like. Used ONLY to keep such a request on the
 * records line, never to route one there.
 */
const RECORDS_CUES = [
  // Deliberately broad, and safe because it is CONSULTED ONLY when the call
  // arrived on the records line. On that line a document word is the default
  // reading — "the notes from the surgery she had on 7/30" is a records
  // request, not a surgery one. It is still specific enough that a genuine
  // optical request reaching this line ("my glasses broke") routes onward, as
  // the operator's ruling requires.
  'record', 'chart', 'note', 'report', 'documentation',
  'copy of', 'copies of', 'release of information',
  'expediente', 'historial', 'copia', 'copias', 'informe',
];

/**
 * Sub-specialties the practice actually schedules separately. A caller naming
 * one of these is not asking for a routine exam.
 */
export const SPECIALIST_CUES = [
  'cornea specialist', 'retina specialist', 'glaucoma specialist',
  'oculoplastic', 'oculoplastics', 'neuro-ophthalm', 'neuro ophthalm',
  'pediatric optometrist', 'pediatric ophthalm', 'peds',
  'see a specialist', 'specialist consult', 'specialist appointment',
  'referral appointment', 'referred to', 'was referred', 'referral from my',
  'cataract consult', 'cataract evaluation', 'consult for my cataract',
  'low vision', 'uveitis',
  'especialista', 'consulta con especialista',
];

/**
 * Optical, which is glasses and contacts as OBJECTS — the frames, the lenses,
 * the prescription for them, collecting them.
 *
 * Deliberately narrow; this is about the eyewear itself. "Contact lens
 * prescription renewal" is a Tech Support reason (157) and stays there on every
 * line but the medication line, where v202's contact-lens rule below sends it to
 * Optical (staff moved all 11 such tech-line tickets there in 14 days).
 */
const OPTICAL_CUES = [
  'glasses', 'eyeglass', 'eye glasses', 'spectacles', 'frames', 'frame',
  'lenses ready', 'new lenses', 'bifocal', 'progressive', 'reading glasses',
  'sunglasses', 'my glasses are', 'pick up my glasses', 'lentes', 'gafas', 'armazon', 'armazón',
];

/**
 * Surgery, when the words are unmistakably about an operation.
 *
 * Exported for the same reason `SCHEDULING` and `SPECIALIST_CUES` are: so the
 * invariant `OPERATION_CUES` claims about it — a strict subset, differing by
 * exactly the facility words — can be asserted rather than trusted.
 */
export const SURGERY_CUES = [
  'my surgery', 'the surgery', 'cataract surgery', 'lasik', 'surgery date',
  'surgery center', 'pre-op', 'post-op', 'operation', 'cirugía', 'cirugia',
];

/**
 * Medication, which belongs to Clinical Tech Support.
 *
 * SPLIT ON PURPOSE. "Prescription" means a drug on this line and a pair of
 * glasses on the optical one — "assistance with eyeglass prescription
 * selection" is a real department 3 ticket today, and treating that word as a
 * medication signal kept it in the medication queue.
 *
 * So the ambiguous words identify a medication call, but they do NOT hold a
 * call against a clearer signal from another queue. Only the unambiguous ones
 * do that.
 */
const TECH_CUES_STRONG = [
  // 'medicine' as well as 'medication' — a real PCP transcript read "I want
  // the refer some my eye doctor medicine" and matched nothing, because the
  // list had the clinical word and not the ordinary one. Patients say
  // medicine; charts say medication.
  'refill', 'pharmacy', 'medication', 'medicine', 'eye drop', 'eyedrop',
  'prior auth', 'medicamento', 'medicina', 'farmacia', 'gotas',
];
const TECH_CUES_AMBIGUOUS = ['prescription', 'receta', 'rx'];
const TECH_CUES = [...TECH_CUES_STRONG, ...TECH_CUES_AMBIGUOUS];

/**
 * v202 — REQUESTS FILE WHERE STAFF WORK THEM. Operator, 2026-11-11: "We're
 * doing more transferring of tickets than anything else … Staff are working
 * too hard chasing down the right person for the tickets." Measured over the
 * fourteen Pacific days 2026-10-28..11-10, agent tickets on the queue lanes,
 * the router below run over each ticket's own description and checked
 * against where staff moved it. Four gaps, each fixed where its decision is
 * made:
 *
 *   1. THE OPERATION WORD ON THE SURGERY LINE (`namesAnOperation`).
 *      `SURGERY_CUES` lists phrases ("my surgery", "the surgery") and not the
 *      word, so "Patient's surgery is Monday … the drops have not arrived" and
 *      "Surgery was cancelled, when will it be rescheduled" matched nothing:
 *      the first went to Technicians as a medication request and the second
 *      to the HVA Hub as a reschedule, against this file's own rule that a
 *      request naming its home subject stays home and the operator's
 *      "surgery is an exception to that hva hub rule". 42 such tickets in 14
 *      days; staff moved 24 back to Surgery Coordination.
 *   2. A ROUTINE VISIT ASKED ABOUT ON THE SURGERY LINE (`asksAboutARoutineVisit`).
 *      "Will my eyes be dilated at tomorrow's appointment", "what is the visit
 *      tomorrow for", "new patient wants an appointment": no operation, no
 *      scheduling cue, so the surgery coordinators got them and moved 160 of
 *      839 surgery-line tickets to the Hub in the window.
 *   3. CONTACT LENSES ON THE MEDICATION LINE (`CONTACT_LENS`). Staff moved
 *      every one of the 11 tech-line contact-lens tickets in the window to
 *      Optical, renewals of the lens prescription included.
 *   4. AN EYE EXAM THAT ALREADY HAPPENED (`examAlreadyHappened`). "A copy of
 *      my glasses prescription from my eye exam" fired the `eye exam`
 *      scheduling cue and went to the Hub; it is an optical request.
 *
 * Each is gated on the line that took the call, so PCP (department 18), the
 * records line and the HVA Hub read this file exactly as before.
 */
const SURGERY_DENIAL =
  /\b(?:not|no)\s+(?:(?:about|for|a|an|the|my|any|need|want|planning|to|have|having|undergo|cataract|eye|specific|scheduled)\s+)*(?:surgery|surgeries|surgical|operations?|procedures?)\b/g;
const OPERATION_WORD =
  /\b(?:surgery|surgeries|surgical|operations?|lasik|prk|pre[-\s]?op(?:erative)?|post[-\s]?op(?:erative)?|procedures?|cirugias?|operacion(?:es)?)\b/;

/**
 * Does the request name an operation — the WORD, not a phrase, and not in a
 * denial ("no surgery date", "not about surgery")? Read on the surgery line
 * to keep a request HOME, and on the optical line only alongside its own
 * guards; never to send a tech-line request anywhere.
 */
export function namesAnOperation(text: string): boolean {
  return OPERATION_WORD.test(fold(text).replace(SURGERY_DENIAL, ' '));
}

/** A visit, an appointment or an exam, by name. */
const VISIT_WORD =
  /\b(?:appointments?|appts?|visits?|check[- ]?ups?|exams?|examinations?|new patient|first[- ]time patient|citas?)\b/;
/**
 * TODAY'S visit stays where it lands. On the surgery line staff left 7 of the
 * 10 same-day visit questions in Surgery Coordination (running late, cancel
 * this afternoon's, what is today's for), so the rule leaves them alone; the
 * after-hours line has its own same-day ruling.
 */
const SAME_DAY_WORDS =
  /\b(?:today|tonight|this morning|this afternoon|hoy|esta manana)\b|\b(?:running late|run late|be late|late for|arrived late|on (?:my|our|his|her|their) way|outside the (?:office|building|clinic))\b/;
const NO_SURGEON = /\b(?:no|not|without)\s+(?:(?:a|any|specific|particular|preferred)\s+)*surgeons?\b/g;
const BIOPSY_OR_OPERATIVE = /\b(?:biops(?:y|ies)|preoperative|postoperative|pre-operative|post-operative)\b/;

/**
 * A question about a routine visit, taken on the surgery line: names a visit,
 * names no operation (the denial-aware word above AND the surgery taxonomy's
 * own procedure boxes, so "cataract" and a named procedure still stay), no
 * surgeon the caller named, no clinical complaint, and not today's visit.
 */
export function asksAboutARoutineVisit(text: string): boolean {
  const t = fold(text).replace(NO_SURGEON, ' ');
  if (!VISIT_WORD.test(t)) return false;
  if (namesAProcedure(text) || BIOPSY_OR_OPERATIVE.test(t)) return false;
  if (/\bsurgeons?\b/.test(t) || hasClinicalComplaint(text)) return false;
  // v205: "a copy of the visit notes", "the report from her last eye visit".
  // The visit is where a document came from, not a visit being asked about
  // (Codex P2 on #450, round 3, now taken).
  if (everyVisitIsADocumentsSource(t)) return false;
  return !SAME_DAY_WORDS.test(t);
}

/**
 * v205 — EVERY VISIT THE REQUEST NAMES IS WHERE A DOCUMENT CAME FROM.
 *
 * Operator, 2026-11-11: "a request for visit notes moves from Surgery to the
 * HVA Hub." The visit word fired the routine-visit rule above while nothing
 * asked for a visit. The records-line hold already reads this binding (v152,
 * `BOUND_AFTER` / `BOUND_BEFORE`): a visit word counts as the document's only
 * when a document word sits right after it ("visit NOTES", "visit SUMMARY") or
 * names it as its source ("the REPORT FROM her last eye visit", "a COPY OF the
 * visit notes"), and an ask for a visit in any other words ("and needs to book
 * an appointment") still sends the request to the Hub. A kind of visit ("eye",
 * "follow-up", "office") between the two still binds.
 */
const VISIT_WORD_G = new RegExp(VISIT_WORD.source, 'g');
const VISIT_KIND = /(?:\b(?:new|routine|follow[ -]?up|return|office|clinic|eye|annual|yearly|dilated|last|recent)\s+)+$/;

// Called only once `VISIT_WORD` has matched, so the loop runs at least once.
function everyVisitIsADocumentsSource(folded: string): boolean {
  for (const visit of folded.matchAll(VISIT_WORD_G)) {
    const before = folded.slice(0, visit.index!).replace(VISIT_KIND, '');
    const after = folded.slice(visit.index! + visit[0].length).replace(THEN_APPOINTMENT_NOUN, '');
    if (!BOUND_AFTER.test(after) && !BOUND_BEFORE.test(before)) return false;
  }
  return !hasSeparateAppointmentAsk(folded);
}

/**
 * v205 — WHAT IS BEING SCHEDULED. The surgery taxonomy reads a few scheduling
 * phrases that name no operation ("needs scheduling", "has not been
 * scheduled") as surgery scheduling, which is right on its own: on the surgery
 * line those words mean the operation. Operator, 2026-11-11: "'Needs
 * scheduling for an eye exam' stays in Surgery." When the request names an
 * exam to book (an exam name not in the past, "after her eye exam" is
 * history), that exam is what is scheduled, so those phrases stop counting as
 * an operation; a named operation or procedure still does. The phrases are
 * GENERATED from the taxonomy's own list, never a second one, and on first
 * use: `surgeryTaxonomy` reaches this module through `cueMatch`, so the list
 * is not defined yet while this module loads.
 */
let operationFree: readonly string[] | undefined;
function operationFreeScheduling(): readonly string[] {
  return (operationFree ??= SURGERY_SCHEDULING_CUES
    .map(fold)
    .filter((c) => !namesAnOperation(c) && !/\bsx\b/.test(c)));
}

function namesAnExamToBook(folded: string): boolean {
  for (const name of EXAM_NAME_CUES.map(fold)) {
    let at = folded.indexOf(name);
    while (at !== -1) {
      if (!EXAM_IN_THE_PAST.test(folded.slice(0, at))) return true;
      at = folded.indexOf(name, at + name.length);
    }
  }
  return false;
}

/**
 * Does the request name an operation or a procedure? `namesAnOperation`, or
 * the surgery taxonomy's own boxes (`isSurgeryRequest`), with the
 * operation-free scheduling phrases left out when an exam is what is being
 * booked. Read on the surgery line and by the after-hours scheduling rule.
 */
export function namesAProcedure(text: string): boolean {
  if (namesAnOperation(text)) return true;
  const t = fold(text);
  if (!namesAnExamToBook(t)) return isSurgeryRequest(text);
  let without = t;
  for (const phrase of operationFreeScheduling()) without = without.split(phrase).join(' ');
  return isSurgeryRequest(without);
}

/** Contact lenses as a product: Optical's, on every measured tech-line ticket. */
const CONTACT_LENS = /\b(?:contacts|contact[- ]lens(?:es)?|lentes de contacto)\b/;
/**
 * v205 — A SYMPTOM THE CONTACT-LENS RULE DID NOT KNOW. Operator, 2026-11-11:
 * "A contact lens allergic reaction goes to Optical even though it's a
 * symptom." `hasClinicalComplaint` is shared with the ticketing app and reads
 * pain, redness and blur; a lens wearer's complaint is usually an allergy, an
 * itch, an irritation or an infection. Those keep the request clinical, on the
 * medication line, before the lens sends it to Optical. A scratched LENS is
 * the lens, so `scratch` is read only as a feeling or an abrasion, and a lens
 * that keeps tearing is a damaged lens: `tearing` counts only with an eye as
 * its subject or as "tearing up" (Codex P2 on #453).
 */
const LENS_SYMPTOM =
  /\b(?:allerg\w*|reactions?|itch\w*|irritat\w*|infect\w*|inflam\w*|sore(?:ness)?|scratchy|(?:corneal )?abrasion|sting(?:s|ing)?|watery|watering|eyes?\s+(?:(?:is|are|keeps?|ha(?:s|ve) been|been|started)\s+)?tearing|tearing\s+(?:up|eyes?)|gritty|foreign (?:body|object)|something (?:stuck )?in (?:my|her|his|their|the) eyes?|alergi\w*|picaz\w*|picor|comezon|irritad\w*|irritacion|infeccion|ardor|lagrime\w*)\b/;
/**
 * v205 — A DRUG NAMED BESIDE THE LENSES. "Lost his contacts and needs a refill
 * of his eye drops" asks for the drops. `refill` and `pharmacy` are not read
 * here: lens wearers refill lenses at pharmacies, and all 11 tech-line lens
 * tickets in the 14 days to 2026-11-10 that said so were moved to Optical by
 * staff. Drops made for the lens (rewetting, lens, comfort or lubricating
 * drops, "eye drops" among them) are the lens's (Codex P2 on #453).
 */
const LENS_DRUG =
  /\b(?:(?<!(?:rewetting|lens|comfort|lubricating|contact) )(?:eye ?drops?|(?<!eye )drops)|medications?|medicines?|ointments?|antibiotics?|steroids?|gotas|medicamentos?|medicinas?)\b/;
/** Eyewear by name, for the exam-already-happened rule and the optical-line guard. */
const EYEWEAR = /\b(?:glasses|eyeglass(?:es)?|spectacles|frames?|lens|lenses|contacts|lentes|gafas)\b/;

/**
 * Every exam the request names already happened ("had an eye exam", "after
 * their eye exam", "from her last eye exam"), the request is about eyewear,
 * and nothing asks for a new visit. Then the exam name is history, not a
 * booking, and the scheduling step stands aside.
 */
const EXAM_IN_THE_PAST =
  /\b(?:had|after|from|since|following|during|at)\s+(?:(?:an?|the|my|her|his|their|your|last|recent|most|previous|prior|latest|recently)\s+){0,3}$/;
const ASKS_FOR_A_VISIT =
  /\b(?:wants?|needs?|would like|requesting|requests?|book|schedul\w*|set up|make|get)\s+(?:(?:an?|another|new|the|my|her|his|their|eye|a new|routine|annual)\s+){0,3}(?:eye exam|exam|appointment|appt|visit|check[- ]?up)\b/;

export function examAlreadyHappened(text: string): boolean {
  const t = fold(text);
  if (!EYEWEAR.test(t) || ASKS_FOR_A_VISIT.test(t)) return false;
  const names = EXAM_NAME_CUES.map(fold);
  const fired = SCHEDULING.flatMap((s) => s.cues).map(fold).filter((c) => t.includes(c));
  if (!fired.length || !fired.every((c) => names.includes(c))) return false;
  for (const name of names) {
    let at = t.indexOf(name);
    while (at !== -1) {
      if (!EXAM_IN_THE_PAST.test(t.slice(0, at))) return false;
      at = t.indexOf(name, at + name.length);
    }
  }
  return true;
}

/**
 * v233 — A SCHEDULING WORD THAT REPORTS A VISIT IS NOT A BOOKING.
 *
 * The scheduling step reads its cues as substrings, so a request about drops
 * or glasses went to the HVA Hub because the caller said when they had been
 * in: "she was seen today and the drops are not at the pharmacy", "out of her
 * drops, requesting a same-day callback", "her check was rescheduled, should
 * she keep using the drops", "given drops after an eye exam", "are their eye
 * exam glasses ready". Measured over the 14 days 2026-10-31..11-13, every
 * optical, surgery and tech agent ticket carrying a scheduling cue and a drug,
 * drop or eyewear word (427, run through this router as it was on `main` and
 * as it is now): 6 change department, and staff had moved all 6 out of the Hub
 * to the department this rule now picks (5 to Technicians, 1 to Optical).
 *
 * `examAlreadyHappened`'s rule, widened by one subject and three cues: the
 * request names eyewear, a drug (`TECH_CUES`) or a kind of drug (`A_DRUG`),
 * nothing asks for a visit, and every scheduling cue the request fired, at
 * every place it fired, reports a visit rather than asking for one:
 *   - an exam name after a past marker ("after an eye exam", the existing
 *     rule) or naming the eyewear it produced ("eye exam glasses");
 *   - "seen today" after was/were/got/been ("she was seen today");
 *   - "same day" or "same-day" naming a callback ("same-day callback");
 *   - "rescheduled", past tense, after was/were/but/and/a subject ("her
 *     check was rescheduled", "but rescheduled").
 * Any other cue, any other place a cue fires, or an ask for a visit anywhere
 * ("wants to be seen today", "needs to be rescheduled", "schedule an
 * appointment") keeps the Hub. Gated on the optical and tech lines, where the
 * measurement is; surgery (0 of 427 changed), PCP, the records line and the
 * Hub read this as before.
 */
const SEEN_IN_THE_PAST = /\b(?:was|were|got|been)\s+(?:just\s+|already\s+)?$/;
const RESCHEDULED_IN_THE_PAST = /\b(?:was|were|been|got|already|but|and|she|he|they|we|i|who|patient)\s+$/;
const THEN_A_CALLBACK = /^\s*(?:call[- ]?backs?|calls?|phone calls?|return calls?|responses?|replies)\b/;
const THEN_EYEWEAR = /^\s*(?:glasses|eyeglass(?:es)?|lenses|prescriptions?|rx)\b/;
/** A drug by its kind, where the request names no brand the cue lists know ("her drops"). */
const A_DRUG = /\b(?:drops|ointments?|antibiotics?|steroids?|gotas)\b/;

function reportsAVisit(cue: string, before: string, after: string): boolean {
  if (EXAM_NAME_CUES.map(fold).includes(cue)) return EXAM_IN_THE_PAST.test(before) || THEN_EYEWEAR.test(after);
  if (cue === 'seen today') return SEEN_IN_THE_PAST.test(before);
  if (cue === 'same day' || cue === 'same-day') return THEN_A_CALLBACK.test(after);
  if (cue === 'reschedule') return after.startsWith('d') && RESCHEDULED_IN_THE_PAST.test(before);
  return false;
}

export function schedulingWordsReportAVisit(text: string, homeDepartmentId: number): boolean {
  if (homeDepartmentId !== OPTICAL && homeDepartmentId !== TECH) return false;
  const t = fold(text);
  if (!EYEWEAR.test(t) && !hit(t, TECH_CUES) && !A_DRUG.test(t)) return false;
  if (ASKS_FOR_A_VISIT.test(t) || hasSeparateAppointmentAsk(t)) return false;
  const fired = SCHEDULING.flatMap((s) => s.cues).map(fold).filter((c) => t.includes(c));
  if (!fired.length) return false;
  for (const cue of fired) {
    let at = t.indexOf(cue);
    while (at !== -1) {
      if (!reportsAVisit(cue, t.slice(0, at), t.slice(at + cue.length))) return false;
      at = t.indexOf(cue, at + cue.length);
    }
  }
  return true;
}

/** The (department 1) pair for a contact-lens request, the same split `classifyNonSurgicalRequest` makes. */
function contactLensPair(t: string): { requestTypeId: number; requestReasonId: number } {
  // Status of an order already placed, then a new order, then a pickup: "reorder
  // the same ones and pick them up at the office" is an order.
  if (/\b(?:status|ready|arriv\w*|estado|listos)\b/.test(t)) return { requestTypeId: 5, requestReasonId: 21 };
  if (/\b(?:order\w*|reorder\w*|refill\w*|replacement|buy|purchase|box|ordenar)\b/.test(t)) return { requestTypeId: 3, requestReasonId: 11 };
  if (/\b(?:pickup|pick up|recoger)\b/.test(t)) return { requestTypeId: 5, requestReasonId: 21 };
  return { requestTypeId: 66, requestReasonId: 536 };
}

/**
 * Lowercase and strip diacritics, so "Cancelación" and "cancelacion" are the
 * same word to a cue. Both sides go through it, which is what lets a cue be
 * written in whichever form reads better.
 */
export function fold(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Is this scheduling request for a named sub-specialty?
 *
 * The cue list lives HERE rather than in `hubTaxonomy`, even though 152 is a
 * department 9 reason, because hubTaxonomy already imports from this file and
 * the reverse would be a cycle. Same list either way — which is the point: a
 * request routed from another queue gets the same reason as one classified
 * directly.
 */
function specialistReferral(foldedText: string): boolean {
  return SPECIALIST_CUES.some((c) => foldedText.includes(fold(c)));
}

/** `text` is already folded by the caller; cues are folded here. */
function hit(text: string, cues: string[]): boolean {
  return cues.some((c) => text.includes(fold(c)));
}

/**
 * Does this request name a document — a record, a chart, a note, a report?
 *
 * The records-line hold below. Broad on purpose — see RECORDS_CUES — and NOT
 * what `file_records_ticket` reads to keep a third party's request home: that
 * turns the order round, so it reads the narrow `namesADocument`.
 */
export function namesARecord(text: string): boolean {
  return hit(fold(text), RECORDS_CUES);
}

/**
 * Does this request ASK FOR a document — the narrow reading, for the one place
 * a document word OUTRANKS a scheduling cue (v127, Codex P1 on #376).
 *
 * `namesARecord` is the records-line hold, and it is deliberately broad: it is
 * substring matching over `record`, `note` and `report`, and it was safe only
 * because `detectCrossQueue` reads scheduling BEFORE it, so a scheduling cue
 * always won. `file_records_ticket` reads a document word to WITHHOLD the
 * scheduling redirect for a third party, which turns that order round, and the
 * broad list then reads ordinary speech as a document: *"please NOTE the
 * patient needs to reschedule"*, *"calling to REPORT that the patient needs an
 * eye exam"*, and — on most professional calls — *"calling on a RECORDED
 * line"*. Each would have kept a third party's appointment request in Medical
 * Records instead of the HVA Hub, the guard this change promised not to move.
 *
 * So this asks for the NOUN, as a whole word, and the ambiguous ones only in a
 * document phrase: `records`, `chart(s)`, `documentation`, `copy of`, `release
 * of information`; `record`, `notes` and `report(s)` after a determiner or a
 * clinical word ("the most recent eye exam REPORT", "chart NOTES", "her
 * medical RECORD"; `record` and `report(s)` also after `a`/`an`, and `record`
 * after `patient` — "the patient RECORD from her last eye exam", Codex P2 on
 * `9e5b8a6`), and singular `note` only after a clinical word, because
 * "leave a note for the doctor" is a message, not a chart. A verb never
 * matches: "to report", "please note", "the patient reports". "For the
 * record" is not a request for one.
 *
 * Its own list rather than a narrowed `RECORDS_CUES`: the records-line hold is
 * live on every records-lane call and keeps its reading; only the new order
 * needs the narrow one.
 */
const DOCUMENT_CLINICAL =
  "(?:chart|office|visit|progress|clinic|clinical|consult|consultation|op|operative|surgical|surgery|" +
  "exam|examination|medical|pathology|lab|labs|imaging|oct|field|test|testing|radiology|discharge|" +
  "treatment|encounter|doctor|doctors|doctor's|physician|physicians|physician's|provider|providers|provider's)";
const DOCUMENT_DETERMINER =
  "(?:the|this|that|these|those|his|her|their|its|any|all|latest|recent|last|final|full|written)";
const DOCUMENT_PATTERNS: readonly RegExp[] = [
  /\brecords\b/,
  new RegExp(`\\b(?:${DOCUMENT_CLINICAL}|${DOCUMENT_DETERMINER}|patients?|patient's|patients'|a|an)\\s+record\\b`),
  /\bcharts?\b/,
  new RegExp(`\\b${DOCUMENT_CLINICAL}\\s+notes?\\b`),
  new RegExp(`\\b${DOCUMENT_DETERMINER}\\s+notes\\b`),
  /\bnotes\s+(?:from|for)\b/,
  new RegExp(`\\b(?:${DOCUMENT_CLINICAL}|${DOCUMENT_DETERMINER}|a|an)\\s+reports?\\b`),
  /\breports?\s+from\b/,
  /\bdocumentation\b/,
  /\bcop(?:y|ies)\s+of\b/,
  /\brelease\s+of\s+information\b/,
  /\b(?:expediente|historial|copias?|informes?)\b/,
];

export function namesADocument(text: string): boolean {
  const t = fold(text).replace(/\bfor\s+the\s+record\b/g, ' ');
  return DOCUMENT_PATTERNS.some((re) => re.test(t));
}

/**
 * The `SCHEDULING` cues that are an exam's NAME, not an ask to book one — v127,
 * Codex P2 on #376 (head `8e11d5e`).
 *
 * The defect `file_records_ticket` holds against is exactly one of these firing
 * on a document's own name: "the most recent EYE EXAM report" matched reason
 * 146 on `'eye exam'` with nothing in it asking for an appointment. A caller
 * who ALSO asks to book, move, cancel or confirm ("we received the eye exam
 * report and need to reschedule the patient") is making a scheduling request,
 * and every other `SCHEDULING` cue is that kind of ask. So the hold fires only
 * when an exam name was the whole of the scheduling signal.
 *
 * A subset of reason 146's cues, asserted by a test so it cannot drift from
 * the list `detectCrossQueue` reads; the list itself is unchanged.
 */
export const EXAM_NAME_CUES: readonly string[] = [
  'eye exam', 'new patient exam', 'check-up', 'checkup', 'annual exam', 'yearly exam',
  'routine exam', 'vision exam', 'dilated exam',
  'examen de la vista', 'examen de ojos', 'revision general', 'revisión general',
];

export function scheduledOnlyByAnExamName(text: string): boolean {
  const t = fold(text);
  const names = new Set(EXAM_NAME_CUES.map(fold));
  const fired = SCHEDULING.flatMap((s) => s.cues).map(fold).filter((c) => t.includes(c));
  return (
    fired.length > 0 && fired.every((c) => names.has(c)) &&
    everyExamNameIsTheDocuments(t) && everyAppointmentIsTheDocuments(t) &&
    !hasSeparateAppointmentAsk(t)
  );
}

/**
 * EVERY EXAM NAMED IS THE SUBJECT OF A DOCUMENT — Codex P2 on #376, head
 * `48dde27`.
 *
 * An ask in words `SCHEDULING` does not list ("we have the chart notes and need
 * to BOOK an eye exam") fired only an exam name, so the rule above read it as
 * document-only. Adding the missing verbs would be one more list that can
 * always be one verb short — the shape of every round so far on this hold. So
 * the evidence is turned round: the hold needs each exam name to be BOUND to a
 * document — "eye exam REPORT", "the records FROM her last eye exam", "a copy
 * OF the dilated exam" — and anything phrased otherwise, an unknown verb
 * included, falls back to the Hub, which is what this line did before v127.
 * A miss here costs the corpus fix on an odd phrasing; it can no longer keep an
 * appointment request out of the Hub. Binding alone does not establish that
 * the whole request is document-only: a caller may also ask to arrange a visit
 * without naming the exam again.
 */
const BOUND_AFTER = /^\s+(?:reports?|notes?|records?|results?|summary|findings|documentation|informe|informes|notas|resultados)\b/;
const BOUND_BEFORE =
  /\b(?:reports?|notes?|records?|results?|charts?|summary|findings|documentation|copy|copies|informe|informes|notas|resultados|expediente|historial|copia|copias)\s+(?:from|of|for|on|de|del)\s+(?:(?:the|her|his|their|its|this|that|a|an|la|el|su|last|latest|recent|most|prior|previous|ultimo|ultima)\s+){0,3}$/;

function everyExamNameIsTheDocuments(folded: string): boolean {
  for (const name of EXAM_NAME_CUES.map(fold)) {
    let at = folded.indexOf(name);
    while (at !== -1) {
      const before = folded.slice(0, at);
      const after = folded.slice(at + name.length);
      if (!BOUND_AFTER.test(after) && !BOUND_BEFORE.test(before)) return false;
      at = folded.indexOf(name, at + name.length);
    }
  }
  return true;
}

/**
 * Preserve an existing redirect when an appointment ask is phrased separately
 * from the exam report, e.g. "received the eye exam report and need to set up
 * a follow-up visit". These phrases need not match SCHEDULING themselves.
 * A request for a "follow-up visit report" is still a document request.
 */
const ASK_VERB =
  "(?:book(?:ing)?|schedul(?:e|ing)|reschedul(?:e|ing)|arrang(?:e|ing)|set(?:ting)?[ -]+up|mak(?:e|ing)|" +
  "request(?:s|ing)?|needs?|wants?|would\\s+like|cancel(?:l?ing)?|confirm(?:ing)?|mov(?:e|ing)|chang(?:e|ing)|" +
  "postpon(?:e|ing)|push(?:ing)?(?:\\s+back)?|check(?:ing)?\\s+on)";
/**
 * The verb may be chained ("need to CANCEL her visit"), and the ask may be in
 * Spanish ("necesitamos cancelar su cita") — Codex P2 on #376, head `abe568e`:
 * cancel/confirm/move a visit beside an exam report was held in Records.
 */
const APPOINTMENT_ASK = new RegExp(
  `\\b${ASK_VERB}(?:\\s+to\\s+${ASK_VERB})?\\s+(?:(?:an?|the|another|new|next|upcoming|annual|yearly|regular|routine|existing|current|scheduled|earlier|later|first|second|same|follow[ -]?up|return|office|clinic|eye|patient's|my|our|her|his|their|this|that)\\s+){0,5}(?:appointments?|appts?|visits?|follow[ -]?ups?)\\b` +
    `|\\b(?:agendar|programar|reprogramar|hacer|cancelar|confirmar|cambiar|mover|pedir|solicitar|necesita(?:mos|n)?|quiere(?:n)?)\\s+(?:(?:una|un|la|el|su|otra|nueva|proxima|siguiente|de|del|seguimiento)\\s+){0,4}(?:citas?|consultas?|visitas?)\\b`,
  'g',
);

function hasSeparateAppointmentAsk(folded: string): boolean {
  for (const ask of folded.matchAll(APPOINTMENT_ASK)) {
    if (!BOUND_AFTER.test(folded.slice(ask.index! + ask[0].length))) return true;
  }
  return false;
}

/**
 * EVERY APPOINTMENT NAMED IS THE DOCUMENT'S TOO — Codex P2 on #376, head
 * `abe568e`.
 *
 * `APPOINTMENT_ASK` reads an ask by its verb, and a verb list is one verb
 * short: "we received the eye exam report and need to CANCEL her visit" (or
 * confirm it, or move it, or cancel her appointment) fired only the exam name
 * — `SCHEDULING`'s cues are first-person ("cancel my appointment") — so the
 * hold kept an appointment request out of the Hub. So the appointment NOUN is
 * read the way an exam name already is: it must be bound to a document
 * ("the visit notes", "the records from her last visit", "the eye exam report
 * for her appointment"), or the request falls back to the Hub, which is what
 * this line did before v127. `follow-up` counts only as a NOUN, after an
 * article, a possessive or a kind ("get her A follow-up", "her NEXT
 * follow-up"; Codex P2 on `c239fa3`), so the verb in "calling TO follow up on
 * the eye exam report" is still a records chase.
 */
const APPOINTMENT_NOUN =
  /\b(?:appointments?|appts?|visits?|citas?|consultas?|visitas?)\b|(?<=\b(?:a|an|the|her|his|their|my|our|another|next|upcoming|new|routine|return)\s+)follow[ -]?ups?\b/g;
// `consulta(s)` is the noun `APPOINTMENT_ASK` already reads (Codex P2 on #376,
// head `b02c127`): "… necesitamos posponer su consulta" carries a verb on no
// list. It also means "a question" ("tengo una consulta sobre el informe"),
// which now falls back to the Hub — the accepted cost, where it went before
// v127.
// "the follow-up VISIT report": the noun after a kind of visit is still the
// document's.
const THEN_APPOINTMENT_NOUN = /^\s+(?:visits?|appointments?|appts?)\b/;
// The kinds of visit `APPOINTMENT_ASK` already reads, so "the eye exam report
// from the FOLLOW-UP visit" is still bound to the report.
const APPOINTMENT_KIND = /(?:\b(?:new|routine|follow[ -]?up|return|office|clinic)\s+)+$/;

function everyAppointmentIsTheDocuments(folded: string): boolean {
  for (const noun of folded.matchAll(APPOINTMENT_NOUN)) {
    const before = folded.slice(0, noun.index!).replace(APPOINTMENT_KIND, '');
    const after = folded.slice(noun.index! + noun[0].length).replace(THEN_APPOINTMENT_NOUN, '');
    if (!BOUND_AFTER.test(after) && !BOUND_BEFORE.test(before)) return false;
  }
  return true;
}

/**
 * `hit`, but the cue has to stand as a WHOLE WORD — Codex P2 round 2, PR #298.
 *
 * `hit` is a substring test, which is right for `detectCrossQueue`: several of
 * its cues are deliberate STEMS (`reprogram` catches reprogramar,
 * reprogramación and reprogramacion; `oculoplastic` catches oculoplastics), and
 * a boundary would silently disarm them.
 *
 * It is wrong for WITHHOLDING a redirect on a professional narrative. The bare
 * cue `operation` is contained in `operations`, so an "operations coordinator"
 * or "operations manager" ringing to book an ordinary eye exam matched the
 * surgery exception and stayed in department 18 — their ROLE NAME withheld the
 * route. That is the 'surgery center' finding one level down, and it survived
 * removing 'surgery center'.
 *
 * Safe here and only here because `OPERATION_CUES` contains no stems — every
 * entry is a complete word or phrase — and `schedulingReachesTheHub.test.ts`
 * fires each cue on its own to prove none was disarmed by the boundary.
 *
 * The text is already folded (lowercased, diacritics stripped), so a boundary
 * is "not a letter or a digit". Hyphens count as boundaries, which is what
 * `pre-op` and `post-op` need.
 */
function hitWord(text: string, cues: string[]): boolean {
  return cues.some((c) => {
    const cue = fold(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${cue}([^a-z0-9]|$)`).test(text);
  });
}

/**
 * Where this request really belongs, or null to keep it on the queue that took
 * the call.
 *
 * ORDER, and why:
 *
 *   1. SCHEDULING FIRST, from every queue — the operator's ruling — EXCEPT an
 *      operation. Asked directly, 2026-08-13: "surgery is an exception to that
 *      hva hub rule."
 *
 *      Moving a surgery date is coordinator work rather than front-desk
 *      scheduling: it drags a surgeon's block, a facility slot, pre-op
 *      measurements and a drop schedule with it, which is why department 2 has
 *      its own reason 531. The exception is the OPERATION, not the word
 *      "reschedule" — "reschedule my post-op appointment" is still Surgery's,
 *      and "reschedule my eye exam" still goes to the Hub.
 *
 *   2. Then the subject-matter queues, each only when the home queue is not
 *      already the right one.
 *
 * A request that mentions BOTH its home subject and another one stays home.
 * "Refill the drops for my cataract surgery" is a medication request on the
 * medication line, not a surgery redirect — so a redirect requires the other
 * queue's language WITHOUT the home queue's.
 */
export function detectCrossQueue(text: string, homeDepartmentId: number): QueueRedirect | null {
  const t = fold(text);
  if (!t.trim()) return null;

  const corrected = correctSurgeryIntake(text, homeDepartmentId);
  if (corrected) {
    if (corrected.departmentId === homeDepartmentId) return null;
    const departmentName = corrected.departmentId === 1 ? 'Optical Support'
      : corrected.departmentId === 3 ? 'Clinical Tech Support' : 'HVA Hub';
    return { ...corrected, departmentName, requestReason: 'Request classified from caller intent',
      note: 'Request taken on another line and routed by its subject.' };
  }

  // v202 (1): on the surgery line the operation WORD keeps a request home —
  // "Patient's surgery is Monday", "Surgery was cancelled" — where the phrase
  // list saw nothing. Only on that line: elsewhere this flag SENDS requests to
  // Surgery (rule 3), and a past surgery named beside a symptom on the tech
  // line is a clinical question, not coordinator work.
  const mentionsSurgery = homeDepartmentId === SURGERY
    ? namesAProcedure(text)
    : hit(t, SURGERY_CUES);
  const mentionsOptical = hit(t, OPTICAL_CUES);
  const mentionsMedication = hit(t, TECH_CUES);
  // Only an unambiguous drug signal keeps a call on the medication line against
  // a clear signal from elsewhere. See TECH_CUES_STRONG.
  const mentionsMedicationClearly = hit(t, TECH_CUES_STRONG);

  /**
   * A records request on the records line stays there, whatever else it names.
   *
   * "The notes from the surgery she had on 7/30, the PCP has not got the
   * report" is a real department 16 ticket. Every subject-matter rule below
   * would pull it into Surgery on the words "the surgery", and the records team
   * would never see it. Same for "a copy of my glasses prescription".
   *
   * Scheduling is deliberately NOT covered by this guard — the operator's
   * ruling is that schedule-related requests go to the Hub from every queue,
   * and a records line is one of them.
   */
  const holdsOnRecordsLine = homeDepartmentId === MEDICAL_RECORDS && namesARecord(t);

  // 1. Appointments -> HVA Hub, from anywhere, unless it is a surgery date.
  //
  // THIS REPLACES A MANUAL MOVE. Operator, 2026-08-13: "we don't have a queue
  // for the HVA hub... those have been landing [in other queues], and then
  // they've been moving over manually into the HVA hub for our scheduling team
  // to address." Nobody answers a department 9 number; this is the handoff
  // between the queue that took the call and the team that works it, so the
  // reason has to be right or the scheduling team gets an undifferentiated pile
  // instead of a sorted queue.
  // v202 (4): an exam that already happened is history, not a booking —
  // "a copy of my glasses prescription from my eye exam" is Optical's.
  // v233: and no scheduling word that only reports a visit ("she was seen
  // today", "same-day callback") sends a drug or eyewear request there.
  if (!mentionsSurgery && !examAlreadyHappened(text) && !schedulingWordsReportAVisit(text, homeDepartmentId)) {
    for (const s of SCHEDULING) {
      if (hit(t, s.cues)) {
        if (homeDepartmentId === HVA_HUB) return null;
        // A named sub-specialty is a different scheduling problem from a
        // routine exam — different provider list, different slot length, often
        // a referral to chase first. Department 9 has reason 152 for it and it
        // has been used ONCE in 90 days, so it is asked BEFORE the six ordinary
        // appointment reasons rather than after.
        const specialist = specialistReferral(t);
        return {
          departmentId: HVA_HUB,
          departmentName: 'HVA Hub',
          requestTypeId: 32,
          requestReasonId: specialist ? 152 : s.reasonId,
          requestReason: specialist ? 'Specialist Referral Appointment' : s.reason,
          note: 'Scheduling request — taken on another line and routed here.',
        };
      }
    }
  }

  // v202 (3): contact lenses on the medication line are Optical's — every one
  // of the 11 in the 14 days to 2026-11-10 was moved there by staff, the
  // lens-prescription renewals included. A symptom stays clinical.
  if (
    homeDepartmentId === TECH && CONTACT_LENS.test(t) &&
    !hasClinicalComplaint(text) && !LENS_SYMPTOM.test(t) && !LENS_DRUG.test(t)
  ) {
    return {
      departmentId: OPTICAL,
      departmentName: 'Optical Support',
      ...contactLensPair(t),
      requestReason: 'Contact lens request',
      note: 'Optical request — taken on another line and routed here.',
    };
  }

  // 2. Optical, when it is about eyewear and NOT about this queue's own subject.
  // A clinical complaint is not a glasses request — leave it on Surgery/HVA —
  // but an explicit appointment still goes to the Hub.
  if (
    homeDepartmentId !== OPTICAL &&
    mentionsOptical &&
    !holdsOnRecordsLine &&
    !(homeDepartmentId === TECH && mentionsMedicationClearly) &&
    !(homeDepartmentId === SURGERY && mentionsSurgery) &&
    !((homeDepartmentId === SURGERY || homeDepartmentId === HVA_HUB) && hasClinicalComplaint(text))
  ) {
    return {
      departmentId: OPTICAL,
      departmentName: 'Optical Support',
      // "General / Other" for department 1 — the receiving optician reads the
      // description. Guessing at one of the eighteen optical reasons from a
      // sentence taken on a different line would be the same mistake this whole
      // effort exists to undo.
      requestTypeId: 66,
      requestReasonId: 536,
      requestReason: 'Other - See Description',
      note: 'Optical request — taken on another line and routed here.',
    };
  }

  // 3. Surgery, when it is unmistakably about an operation. v202: on the
  // optical line the operation WORD counts too, when nothing in the request
  // is eyewear or a symptom — "urgent message for the surgical coordinator
  // about eye surgery" (2 of 2 in the window moved to Surgery by staff).
  const opticalLineOperation =
    homeDepartmentId === OPTICAL && namesAnOperation(text) && !EYEWEAR.test(t) &&
    !hit(t, TECH_CUES_STRONG) && !hasClinicalComplaint(text);
  if (
    homeDepartmentId !== SURGERY &&
    (mentionsSurgery || opticalLineOperation) &&
    !holdsOnRecordsLine &&
    !(homeDepartmentId === TECH && mentionsMedicationClearly)
  ) {
    return {
      departmentId: SURGERY,
      departmentName: 'Surgery Coordination',
      requestTypeId: 65,
      requestReasonId: 535,
      requestReason: 'Other - See Description',
      note: 'Surgery request — taken on another line and routed here.',
    };
  }

  // 4. Medication, when it is unmistakably a prescription matter.
  if (
    homeDepartmentId !== TECH &&
    mentionsMedication &&
    !holdsOnRecordsLine &&
    !mentionsSurgery &&
    !mentionsOptical
  ) {
    return {
      departmentId: TECH,
      departmentName: 'Clinical Tech Support',
      requestTypeId: 72,
      requestReasonId: 542,
      requestReason: 'Other - See Description',
      note: 'Medication request — taken on another line and routed here.',
    };
  }

  // 5. v202 (2): a question about a routine visit, on the surgery line, is the
  // HVA Hub's — the operator's "anything that's schedule related … should go
  // to the HVA hub", applied to the visits the scheduling cues do not name.
  if (homeDepartmentId === SURGERY && asksAboutARoutineVisit(text)) {
    const cued = SCHEDULING.find((s) => hit(t, s.cues));
    const newPatient = /\b(?:new patient|first[- ]time patient)\b/.test(t);
    const pair = cued
      ? { requestTypeId: 32, requestReasonId: cued.reasonId, requestReason: cued.reason }
      : newPatient
        ? { requestTypeId: 32, requestReasonId: 146, requestReason: 'New Appointment Request' }
        : { requestTypeId: 69, requestReasonId: 539, requestReason: 'Other - See Description' };
    return {
      departmentId: HVA_HUB,
      departmentName: 'HVA Hub',
      ...pair,
      note: 'Scheduling request — taken on another line and routed here.',
    };
  }

  return null;
}

/**
 * The three scheduling intents a caller can STATE rather than imply.
 *
 * WHY THIS EXISTS BESIDE `detectCrossQueue` RATHER THAN INSIDE IT.
 *
 * `detectCrossQueue` reads prose, which is the only evidence a queue lane has:
 * a patient says what they want and the words are all we get. The PCP line is
 * different — its intake asks the caller what the call is about and stores the
 * answer as a closed enum, so on that lane the intent is a STATED FACT and the
 * description is a summary written around it.
 *
 * Reading the stated value is worth a third of the population. Measured over
 * all 217 PCP tickets, 2026-09-14: **75 carry one of these three slugs, and 25
 * of them contain no scheduling cue at all** — a narrative like "caller would
 * like to be seen before their referral expires" states the purpose in the
 * enum and never uses a word this file cues on. Prose alone leaves those 25 in
 * department 18.
 *
 * It is also the safer read on a professional line, and that is not a
 * side-benefit. `detectCrossQueue`'s subject cues fire on a caller's EMPLOYER
 * — `'surgery center'` in SURGERY_CUES routed a Loma Linda Surgery Center
 * caller's ticket to department 2 on 2026-09-08 (CAbf717457), which is still
 * open. An enum filled from a closed list has nothing in it to drift.
 *
 * THE SURGERY EXCEPTION STILL WINS, and it is enforced HERE rather than at the
 * call site so it cannot be forgotten by the next caller of this function.
 * Operator, 2026-08-13: "surgery is an exception to that hva hub rule." A
 * stated `reschedule` whose narrative names an operation is coordinator work,
 * so this declines and the request stays with the line that took it. 4 of the
 * 75 are that shape.
 *
 * BUT IT READS `OPERATION_CUES`, NOT `SURGERY_CUES` — Codex P2, PR #298, and
 * it caught this route doing the exact thing the paragraph above boasts it
 * cannot. `SURGERY_CUES` contains the literal `'surgery center'`, so a
 * referral coordinator AT a surgery centre, ringing to book an ordinary eye
 * exam, hit the exception on their EMPLOYER's name and stayed in department
 * 18. That is #99 arriving through the one line here that reads prose.
 *
 * The operator's own wording settles which list is right: "The exception is
 * the OPERATION, not the word 'reschedule'." A place that performs surgery is
 * not a surgery being performed.
 */
export type StatedSchedulingIntent = 'new' | 'reschedule' | 'cancel';

/**
 * Surgery cues that name a PLACE rather than a procedure.
 *
 * Derived by subtraction rather than written out, so this list stays visibly
 * a statement about `SURGERY_CUES` — if a future facility word is added there
 * and not here, the subtraction is where to add it. `queueRouting.test.ts`
 * asserts the two lists still differ by exactly this.
 *
 * NOT removed from `SURGERY_CUES` itself. That list is read by
 * `detectCrossQueue`, which routes on subject matter across every lane, and
 * changing it is the open #99 work that `docs/BACKEND_HANDOFF.md` requires a
 * before-and-after department-2 misroute measurement for. This narrower list
 * is used ONLY to decide whether to WITHHOLD a scheduling redirect, where a
 * false positive costs a routed ticket and can never misroute one.
 */
const SURGERY_CUES_NAMING_A_PLACE = ['surgery center'];

export const OPERATION_CUES = SURGERY_CUES.filter(
  (cue) => !SURGERY_CUES_NAMING_A_PLACE.includes(cue),
);

/**
 * Reason ids for a STATED intent, read back out of SCHEDULING so this cannot
 * drift from the cue table — the same argument that keeps `hubTaxonomy` on the
 * shared list rather than a copy of it.
 */
const STATED_SCHEDULING_REASON_ID: Record<StatedSchedulingIntent, number> = {
  new: 146,
  reschedule: 147,
  cancel: 148,
};

export function schedulingRedirectForStatedIntent(
  intent: StatedSchedulingIntent,
  text: string,
  homeDepartmentId: number,
  /**
   * THE CALLER'S OWN METADATA, REMOVED BEFORE THE GUARD READS THE TEXT —
   * Codex P2 round 3, PR #298, and the point where this stopped being a cue
   * list problem.
   *
   * The same finding arrived three times in three shapes: `surgery center`,
   * then `operation` inside `operations coordinator`, then `lasik` inside
   * "Coordinator at Example LASIK Clinic". No edit to the cue list closes it,
   * because in the last case the employer token and the procedure token are
   * the SAME TOKEN — a word boundary cannot separate them and neither can a
   * narrower list.
   *
   * What separates them is provenance, not spelling. Codex's own framing was
   * "request-scoped evidence rather than matching the whole narrative", and
   * this makes that literal: whatever the intake recorded as the caller's
   * organisation and role is removed from the text, and the guard reads what
   * is left. On the PCP line that metadata is a large share of the narrative
   * by construction, which is why every one of these findings landed here.
   *
   * IT CANNOT LOOSEN THE EXCEPTION BEYOND ITS OWN STRING. Only exact
   * occurrences of the supplied text are removed, so "Coordinator at Example
   * LASIK Clinic — needs to move the surgery date" still withholds, and
   * "Booking her LASIK" still withholds because "example lasik clinic" does
   * not occur in it. Omitted entirely, the behaviour is exactly as before.
   *
   * MEASURED, all 217 PCP tickets: 7 organisations contain an operation cue,
   * and 2 of the 75 scheduling tickets are this shape. Small — and the reason
   * to fix it at the source anyway is that it closes all three rounds at one
   * point rather than waiting for the fourth token.
   */
  callerMetadata: readonly string[] = [],
): QueueRedirect | null {
  if (homeDepartmentId === HVA_HUB) return null;
  let t = fold(text);
  for (const raw of callerMetadata) {
    const m = fold(raw).trim();
    // A one- or two-character fragment would blank half the narrative; a
    // missing organisation arrives as '' and must not match everywhere.
    if (m.length < 3) continue;
    t = t.split(m).join(' ');
  }
  // The exception, before anything else. An operation is not front-desk
  // scheduling whatever the intake enum says — but a surgery CENTRE is an
  // employer, not an operation. See OPERATION_CUES.
  if (hitWord(t, OPERATION_CUES)) return null;

  const reasonId = STATED_SCHEDULING_REASON_ID[intent];
  const row = SCHEDULING.find((s) => s.reasonId === reasonId);
  // Unreachable while the ids above are in SCHEDULING, and `queueRouting.test.ts`
  // asserts they are. Handled rather than asserted so a future edit to the cue
  // table degrades to "keep it here" instead of throwing inside a filing tool.
  if (!row) return null;

  /**
   * NO SPECIALIST REFINEMENT ON THIS PATH — Codex P2 round 2, PR #298.
   *
   * `specialistReferral` read `SPECIALIST_CUES` over the whole narrative, and
   * on this path the narrative is dominated by the caller's own organisation
   * and role BY CONSTRUCTION — that is what the PCP intake collects. So
   * "coordinator at Example Retina Specialist", booking a routine exam, graded
   * as reason 152.
   *
   * There is no lexical way to separate that employer from a patient who
   * genuinely needs a retina specialist: the two sentences contain the same
   * string. So this stops guessing rather than guessing better — the same
   * ruling as `detectCrossQueue` not being called here at all.
   *
   * The cost is small and was checked rather than assumed: reason 152 has been
   * used ONCE in 90 days (see the note on `specialistReferral`). A refinement
   * that fires once a quarter is not worth a class of mislabelled tickets.
   *
   * `detectCrossQueue` keeps its own specialist read. That is the PATIENT path,
   * where the narrative is the caller's own words about their own care.
   */
  return {
    departmentId: HVA_HUB,
    departmentName: 'HVA Hub',
    requestTypeId: 32,
    requestReasonId: row.reasonId,
    requestReason: row.reason,
    note: 'Scheduling request — taken on another line and routed here.',
  };
}
