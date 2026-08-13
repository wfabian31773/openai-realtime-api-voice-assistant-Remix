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
  'proof of service', 'power of attorney', 'personal representative',
  'immigration', 'abogado', 'demanda',
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
  const t = fold(text);
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
