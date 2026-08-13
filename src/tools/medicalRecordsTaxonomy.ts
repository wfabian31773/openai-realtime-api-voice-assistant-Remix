/**
 * Medical Records' own taxonomy — department 16.
 *
 * WHY THIS FILE EXISTS
 *
 * This is the worst classification gap in the practice, proportionally. Over 90
 * days to 2026-08-13:
 *
 *   tickets                         495   (5.5/day)
 *   NO request type, NO reason      453   — 91.5%
 *   500 Copies of Records            31
 *   504 Other Records Request         4
 *   502 Records Sent to Another Provider  3
 *   501 Inspect / Review Records      1
 *
 * Five reasons exist. Four of them have been used eight times between them. The
 * department is, in the data, one undifferentiated pile.
 *
 * And as with department 3, THE MODEL ALREADY GETS IT RIGHT and the code throws
 * it away. The descriptions carry a classification in prose —
 *
 *   Subject: Medical records request for Social Security office
 *   Request Type: Patient Assistance
 *   Request Reason: Medical Records Request
 *
 * — which the answering-service path then files with no reason at all.
 *
 * WHAT THE QUEUE ACTUALLY IS, read from real ticket text
 *
 * Not "patients asking for their chart". The dominant axis is WHO IS ASKING and
 * WHERE IT IS GOING, because that is what decides the paperwork:
 *
 *   another clinic       "Records for pcp request… send to FAX 714 586-9011"
 *                        "Request for patient consult notes" (San Fernando
 *                        Community), "faxed to Dr. Ann Warn's office"
 *   a health plan        SCAN Health Plan, Blue Shield of California,
 *                        "Medicare risk adjustment review"
 *   a legal process      Lexitas (a records-retrieval firm), "lawyer for
 *                        immigration procedure", "power of attorney",
 *                        "personal representative", Social Security
 *   the patient          "I need copy of my records"
 *   not records at all   "doctor's note for injection days", "PROOF OF SERVICE
 *                        FORM", letters and forms
 *
 * That last group matters: a note or a form is not a chart copy, and filing it
 * as one sends it down a release-of-information path it does not belong in.
 *
 * A THING THE AGENT MUST NOT DO. Release of records requires a signed
 * authorization — staff say so in these tickets themselves ("Please advise the
 * patient that a signed Auth for Release of Medical Records is required"). The
 * agent takes the request and says the records team will follow up with what is
 * needed. It does not quote the requirement as procedure, does not promise
 * anything will be sent, and never reads a record back to anyone.
 *
 * Every pair below was read out of the Support Center's own `request_types` /
 * `request_reasons` tables for department 16 on 2026-08-13.
 */
import { fold } from './queueRouting';

export const MEDICAL_RECORDS_DEPARTMENT_ID = 16;

export interface RecordsClassification {
  requestTypeId: number;
  requestType: string;
  requestReasonId: number;
  requestReason: string;
  /** Spoken cues that pick this pair. Matched as folded substrings. */
  cues: string[];
}

/**
 * A request driven by a third party with a legal or benefits interest.
 *
 * Named organisations are in here on purpose. "Lexitas" and "SCAN Health Plan"
 * mean nothing as English words but everything as a requester, and they are what
 * actually appears in the ticket text.
 */
const LEGAL_AND_INSURANCE_CUES = [
  // Legal process
  'attorney', 'lawyer', 'law office', 'law firm', 'legal', 'subpoena', 'court',
  'litigation', 'deposition', 'lexitas', 'record retrieval', 'records retrieval',
  'proof of service', 'immigration', 'abogado', 'demanda',
  // NOT 'power of attorney' or 'personal representative'. Those describe WHO is
  // asking, not a legal purpose — a daughter with power of attorney requesting
  // her mother's chart is a copy request (500), and filing it as "Records for
  // Legal or Insurance" sends it down the wrong path.
  // Benefits and disability
  'social security', 'seguro social', 'ssa', 'ssi', 'disability determination',
  'workers comp', "worker's comp", 'workers compensation', 'state disability', 'edd',
  // Health plans and plan-driven chart review
  'health plan', 'risk adjustment', 'hedis', 'chart review', 'chart audit',
  'scan health', 'blue shield', 'blue cross', 'anthem', 'molina', 'health net',
  'united healthcare', 'humana', 'aetna', 'cigna', 'medicare advantage',
  'insurance company', 'insurance carrier', 'claims department',
];

/**
 * Records going TO a clinician — the referring doctor, the primary, the next
 * specialist. The signal is a destination, not the word "records".
 *
 * The verb x target pairs are GENERATED rather than hand-listed, the same
 * lesson the pharmacy-transfer cues taught in `techTaxonomy.ts`. Hand-listing
 * missed "faxed to Dr. Ann Warn's office" on the first attempt because the list
 * had "fax to dr" and the ticket said "faxed to". English inflects; a list
 * written by hand quietly encodes whichever tense came to mind.
 */
const SEND_VERBS = [
  'send', 'sent', 'sending', 'fax', 'faxed', 'faxing',
  'mail', 'mailed', 'forward', 'forwarded', 'transfer', 'transferred', 'release',
];
/**
 * What sits BETWEEN the verb and the destination, which is the part a flat list
 * cannot express. "Please fax the records to Dr. Warn" defeated a
 * verb-plus-target list on the first attempt, because the object of the verb is
 * in the way — the same shape that defeated the pharmacy-transfer cues.
 */
const SEND_OBJECTS = [
  '', 'the records ', 'my records ', 'her records ', 'his records ',
  'the chart ', 'the notes ', 'the report ', 'a copy ', 'them ', 'it ', 'these ',
];
const CLINICIAN_TARGETS = [
  'to dr', 'to doctor', 'to the doctor', 'to my doctor',
  'to my primary', 'to her primary', 'to his primary',
  'to my pcp', 'to her pcp', 'to his pcp',
  'to the referring', 'to another provider', 'to another doctor', 'to the new doctor',
];

const TO_ANOTHER_PROVIDER_CUES = [
  // ~2,200 generated phrases. Classification runs once per call, so the cost of
  // the scan is irrelevant next to getting the grammar right rather than
  // guessing at which tense and object order a caller will use.
  ...SEND_VERBS.flatMap((v) => SEND_OBJECTS.flatMap((o) => CLINICIAN_TARGETS.map((t) => `${v} ${o}${t}`))),
  // Standing phrases that name a clinician destination without a verb.
  'primary care', 'my pcp', 'her pcp', 'his pcp', 'for pcp', 'pcp request',
  'referring doctor', 'referring provider', 'another provider', 'another doctor',
  'new doctor', 'other office', 'another office', 'outside provider',
  // Document types that only a clinician asks for.
  'consult note', 'consultation note', 'progress note', 'operative report', 'surgery note',
  'transfer my records', 'transfer her records', 'transfer his records',
  'mandar al doctor', 'enviar al doctor', 'a mi doctor de cabecera',
];

/**
 * A letter, note or form. NOT a chart copy, and the distinction is the point —
 * these go to whoever writes letters, not down release-of-information.
 */
const LETTER_OR_FORM_CUES = [
  "doctor's note", 'doctors note', 'doctor note', 'note for work', 'note for school',
  'work note', 'school form', 'jury duty', 'dmv form', 'dmv paperwork',
  'letter for', 'letter from the doctor', 'letter stating', 'write a letter',
  'fill out a form', 'fill out this form', 'paperwork to be filled',
  'verification of treatment', 'proof of treatment', 'proof that',
  'carta del doctor', 'constancia', 'comprobante',
];

/** Reading rather than receiving — an in-person or portal review of the chart. */
const INSPECT_CUES = [
  'review my record', 'review my chart', 'look at my record', 'look at my chart',
  'inspect', 'see my chart', 'view my record', 'read my record', 'go over my chart',
  'revisar mi expediente', 'ver mi expediente',
];

/**
 * The plain request: the patient wants a copy. LAST, because almost every
 * ticket in this department contains these words — including the ones that
 * belong to the four buckets above.
 */
const COPIES_CUES = [
  // Deliberately broad. This bucket runs LAST, so everything with a stronger
  // claim has already matched — which is exactly what lets a bare "copy of" be
  // safe here and nowhere else. "Request for copy of most recent visit records"
  // matched none of the narrower phrasings on the first attempt.
  'copy of', 'copies of', 'get my records', 'need my records', 'want my records',
  'request my records', 'the records', 'my records', 'her records', 'his records',
  'medical record', 'medical records', 'records request',
  'medical report', 'my chart', 'eye exam record', 'visit record', 'visit note',
  'copia', 'copias', 'expediente', 'historial medico', 'record medico',
  'reporte medico', 'informe medico', 'solicitud de records', 'mis registros',
];

/**
 * The valid pairs, ordered MOST-SPECIFIC FIRST. First match wins.
 *
 * ORDER IS THE WHOLE DESIGN, and here it is unusually load-bearing because
 * every one of these requests is also, literally, a request for medical
 * records. "Medical records request for Social Security office" contains the
 * generic phrase and the specific one; if 500 were tested first it would take
 * every ticket in the department, which is roughly what happens today.
 *
 * The rules that resolve the collisions:
 *   a legal or plan requester outranks everything   "records for SSA"      -> 503
 *   a clinician destination outranks a plain copy   "fax to Dr. Warn"      -> 502
 *   a letter or form is not a chart copy            "doctor's note"        -> 504
 *   reading is not receiving                        "review my chart"      -> 501
 *   everything else the patient asks for            "copy of my records"   -> 500
 */
export const RECORDS_CLASSIFICATIONS: RecordsClassification[] = [
  { requestTypeId: 58, requestType: 'Medical Records Request', requestReasonId: 503, requestReason: 'Records for Legal or Insurance',
    cues: LEGAL_AND_INSURANCE_CUES },
  { requestTypeId: 58, requestType: 'Medical Records Request', requestReasonId: 502, requestReason: 'Records Sent to Another Provider',
    cues: TO_ANOTHER_PROVIDER_CUES },
  { requestTypeId: 58, requestType: 'Medical Records Request', requestReasonId: 504, requestReason: 'Other Records Request',
    cues: LETTER_OR_FORM_CUES },
  { requestTypeId: 58, requestType: 'Medical Records Request', requestReasonId: 501, requestReason: 'Inspect / Review Records',
    cues: INSPECT_CUES },
  { requestTypeId: 58, requestType: 'Medical Records Request', requestReasonId: 500, requestReason: 'Copies of Records',
    cues: COPIES_CUES },
];

/** Department 16's own "Other - See Description" — see `otherReason.ts`. */
export const RECORDS_CATCHALL: RecordsClassification = {
  requestTypeId: 77,
  requestType: 'General / Other',
  requestReasonId: 547,
  requestReason: 'Other - See Description',
  cues: [],
};

/** Every reason id this queue may use. */
export const RECORDS_REASON_IDS = new Set([
  ...RECORDS_CLASSIFICATIONS.map((c) => c.requestReasonId),
  RECORDS_CATCHALL.requestReasonId,
]);

/** The pair whose cues the caller's words match, or null. */
export function classifyRecords(text: string): RecordsClassification | null {
  // "power of attorney" contains "attorney", and the legal bucket matches the
  // bare word. Removing the phrase from the cue list was not enough — this is
  // exactly the substring the ticketing agent's backfill tripped on, and it
  // survived my first fix. Neutralise the false friend before matching rather
  // than trusting a list not to contain a prefix of itself.
  const t = fold(text).replace(/power of attorney/g, 'poa');
  if (!t.trim()) return null;
  for (const c of RECORDS_CLASSIFICATIONS) {
    if (c.cues.some((cue) => t.includes(fold(cue)))) return c;
  }
  return null;
}

/**
 * The classification for this request. Never null.
 *
 * Falls to department 16's own catch-all rather than to the first reason of a
 * default type. A classifier that can refuse hands the problem back to the
 * model, and the model is not the one holding the reason table.
 */
export function classifyRecordsRequest(text: string): {
  classification: RecordsClassification;
  isCatchAll: boolean;
} {
  const hit = classifyRecords(text);
  return hit
    ? { classification: hit, isCatchAll: false }
    : { classification: RECORDS_CATCHALL, isCatchAll: true };
}

/** Look up a pair the agent named explicitly, so it cannot invent one. */
export function recordsReasonById(reasonId: number): RecordsClassification | null {
  if (reasonId === RECORDS_CATCHALL.requestReasonId) return RECORDS_CATCHALL;
  return RECORDS_CLASSIFICATIONS.find((c) => c.requestReasonId === reasonId) ?? null;
}

/* -------------------------------------------------------------------------
 * THE CAP CLOCK
 *
 * Azul Vision is under a Corrective Action Plan with HHS OCR, entered into
 * after a complaint about being late with medical records. For two years the
 * practice must report on records timing. That is why a medical records
 * request becomes a CASE (`mr_cases`) and not merely a ticket.
 *
 * Operator, 2026-08-13: "the only thing that should be tracking that clock is
 * patient requests for medical records. If it's going to a patient, then it
 * should be on the clock. If it's going anywhere else to anyone else, then it
 * shouldn't be on that clock."
 *
 * WHY THIS CODE HAS TO EXIST, measured 2026-08-13:
 *
 *   mr_cases rows                                       470
 *   pathway 'roa_patient' / requestor 'patient'         470   — all of them
 *   created by the VOICE AGENT                          421
 *   with a requestor_name captured                        0
 *   with a relationship_to_patient captured               0
 *   whose linked ticket reads as third-party            >=77
 *
 * Every case is on the California 15-calendar-day clock because every field
 * took its database default, and the one fact that decides whether the clock
 * applies — who is asking — has never been captured on a single row. At least
 * 77 of them are health plans, records-retrieval firms, attorneys, Social
 * Security or another clinic. That is a floor from a conservative text match,
 * not a total.
 *
 * So the requester is not a nice-to-have on this queue. It is the field a
 * statutory clock keys on, and nothing downstream can reconstruct it.
 *
 * THE ONE CASE THAT IS NOT OBVIOUS, and it is a question for counsel rather
 * than for code: a patient may direct their OWN records to somebody else —
 * "send my chart to my new doctor". Read by destination, that is off the
 * clock. Read as a right of access, it is the patient exercising that right
 * and stays on it (45 CFR 164.524(c)(3)(ii) covers an individual's request to
 * transmit to a designated person). The two readings differ in exactly this
 * case and nowhere else.
 *
 * Until it is settled, this code treats PATIENT-INITIATED as on the clock
 * whatever the destination, because the two errors are not symmetric: being
 * wrongly ON the clock costs a self-imposed deadline, and being wrongly OFF it
 * is a CAP violation on the very obligation the CAP exists to police.
 * ---------------------------------------------------------------------- */

export type RequesterType =
  | 'patient'
  | 'personal_representative'
  | 'provider'
  | 'health_plan'
  | 'legal'
  | 'other';

export interface CapDetermination {
  requesterType: RequesterType;
  /** Does the statutory records clock apply? */
  onClock: boolean;
  /** `mr_cases.request_pathway`. */
  pathway: 'roa_patient' | 'third_party_treatment' | 'third_party_plan' | 'third_party_legal' | 'third_party_other';
  /** One line for the ticket, so a clerk can see the call it was made on. */
  note: string;
}

/**
 * A caller SPEAKING FOR SOMEBODY ELSE, which suppresses the first-person cues
 * below.
 *
 * "I am the patient's attorney" contains "i am the patient". Moving the patient
 * cues above the organisation lists without this guard would classify that
 * caller as the patient and put a law firm's request on a statutory clock —
 * the ticketing agent's 2026-08-13 error in mirror image. They matched
 * "attorney" inside "power of attorney" and took 9 personal representatives OFF
 * a clock that applies to them; this is the same substring trap pointing the
 * other way.
 */
const SPEAKING_FOR_ANOTHER = [
  "patient's", 'patients ', 'for the patient', 'on behalf of the patient',
  'our patient', 'mutual patient', 'the patient is my',
];

/** Cues for who is on the phone, keyed to how they actually introduce themselves. */
const REQUESTER_CUES: Array<{ type: RequesterType; cues: string[] }> = [
  // Checked before 'patient': a parent or guardian says "my daughter's
  // records", which contains neither "I am the patient" nor an organisation.
  { type: 'personal_representative', cues: [
    'power of attorney', 'personal representative', 'conservator', 'guardian', 'executor',
    "my mother's", "my father's", "my son's", "my daughter's", "my husband's", "my wife's",
    'my mother', 'my father', 'my son', 'my daughter', 'my husband', 'my wife',
    'i am her', 'i am his', 'on behalf of my', 'apoderado', 'tutor', 'mi madre', 'mi padre', 'mi hijo', 'mi hija',
  ] },
  // BEFORE the organisation lists. A caller who says "I am the patient" is
  // telling you who is speaking; "Social Security" in the same sentence is
  // telling you why. Purpose was outranking identity: "I am the patient, this
  // is for Social Security Disability" classified as legal and came OFF a clock
  // that applies to them — a false negative, which is the dangerous direction.
  //
  // Guarded by SPEAKING_FOR_ANOTHER so the possessive does not slip through.
  { type: 'patient', cues: [
    // THIRD TIME. A live call on 2026-08-13 said "the patient themselves" and
    // classified as `other`, taking a right-of-access request OFF the clock.
    // The list had himself and herself and not the one people actually say.
    //
    // So this is now a STEM — 'the patient' plus a self-referring word — rather
    // than an enumeration of pronouns, because enumerating them is how the last
    // two got missed. The possessive guard is what keeps "the patient's
    // attorney" out.
    'i am the patient', "i'm the patient", 'this is the patient',
    'the patient them', 'the patient him', 'the patient her',
    'patient themselves', 'patient himself', 'patient herself', 'patient myself',
    'the patient is calling', 'speaking with the patient', 'the patient themself',
    'my own records', 'my records', 'my chart', 'for myself',
    'soy el paciente', 'soy la paciente', 'mis registros', 'mi expediente',
  ] },
  { type: 'legal', cues: [
    'attorney', 'lawyer', 'law office', 'law firm', 'legal', 'subpoena', 'court', 'litigation',
    'lexitas', 'record retrieval', 'records retrieval', 'social security', 'ssa', 'disability determination',
    'workers comp', "worker's comp", 'immigration', 'abogado', 'seguro social',
  ] },
  { type: 'health_plan', cues: [
    'health plan', 'risk adjustment', 'hedis', 'chart review', 'chart audit',
    'scan health', 'blue shield', 'blue cross', 'anthem', 'molina', 'health net',
    'united healthcare', 'humana', 'aetna', 'cigna', 'medicare advantage',
    'insurance company', 'insurance carrier', 'claims department', 'ipa',
  ] },
  { type: 'provider', cues: [
    "doctor's office", 'doctors office', 'medical group', 'clinic', 'calling from dr',
    'primary care', 'referring provider', 'referring doctor', 'our patient', 'mutual patient',
    'i am a nurse', 'medical assistant', 'front office', 'consultorio',
  ] },
];

/** Who is asking, from whatever the caller said. Null when it cannot be told. */
export function classifyRequester(text: string): RequesterType | null {
  const t = fold(text);
  if (!t.trim()) return null;
  const speaksForAnother = SPEAKING_FOR_ANOTHER.some((c) => t.includes(fold(c)));
  for (const r of REQUESTER_CUES) {
    if (r.type === 'patient' && speaksForAnother) continue;
    if (r.cues.some((c) => t.includes(fold(c)))) return r.type;
  }
  return null;
}

const PATHWAYS: Record<RequesterType, CapDetermination['pathway']> = {
  patient: 'roa_patient',
  personal_representative: 'roa_patient',
  provider: 'third_party_treatment',
  health_plan: 'third_party_plan',
  legal: 'third_party_legal',
  other: 'third_party_other',
};

/**
 * Whether this request belongs on the CAP clock, and under which pathway.
 *
 * A personal representative stands in the patient's shoes under HIPAA, so
 * they are on the clock too — a daughter with power of attorney asking for
 * her mother's chart is the same right being exercised.
 */
export function determineCapClock(requesterType: RequesterType): CapDetermination {
  const onClock = requesterType === 'patient' || requesterType === 'personal_representative';
  return {
    requesterType,
    onClock,
    pathway: PATHWAYS[requesterType],
    note: onClock
      ? 'PATIENT REQUEST — on the records clock (CAP reportable).'
      : `Third-party request (${requesterType.replace(/_/g, ' ')}) — NOT on the patient records clock.`,
  };
}
