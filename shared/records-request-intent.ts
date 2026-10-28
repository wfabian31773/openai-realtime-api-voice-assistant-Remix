/**
 * Item #8. Request evidence, never a phone line, template, requester or type id.
 * Kept identical in ticketing-app and voice-remix: independently deployed repos.
 * Ticketing owns the final taxonomy and case creation; voice uses this only to
 * avoid interviewing a scheduling caller about records delivery/signatures.
 */
import { SCHEDULING } from './scheduling-cues';

export type RecordsLinePurpose = 'records' | 'surgery' | 'scheduling' | 'referral' | 'professional' | 'optical' | 'clinical' | 'billing' | 'unknown';

/** Remove only known generated metadata; never use it as caller evidence. */
export function recordsRequestText(text: string): string {
  return text.split(/\r?\n/).map(line => line.replace(/^\s*REASON FOR CALL:\s*/i, '')).filter(line => !/^\s*(?:PATIENT REQUEST\s*[-—]|Third-party request\s*\(|Requested by:|Send to:|Dates needed:|Request Type:|Request Reason:|Category:|Medical Records Request\s*$|(?:Scheduling|Optical|Surgery|Medication) request\s*[-—].*routed here)/i.test(line)).join('\n').trim();
}

const fold = (text: string) => recordsRequestText(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘]/g, "'");
const DOC = /\b(?:documentation|records?|charts?|(?:progress|consult(?:ation)?|visit|office|surgery|surgical|operative) notes?|(?:medical|operative|surgical|optometry|consultation|op) reports?|(?:test|lab|exam|diagnostic) results?|imaging|oct|visual field|vf|drs|fundus|topography|expedientes?|registros?|historial|informes?|reportes? medicos?)\b/;
const DELIVERY = /\b(?:copy|copies|get|fax(?:ed|ing)?|send|sent|email(?:ed)?|mail(?:ed)?|forward|release|obtain|retrieve|provide|inspect|inspection|copia|copias|envi\w*|mand\w*)\b/;
// A delivery action asked of us is distinct from a past/future delivery
// mentioned while asking someone to interpret results. Causative requests
// ("have my test results sent") and passive requests ("need my results sent")
// must name the document immediately before the delivery.
const EXPLICIT_DELIVERY = new RegExp(
  String.raw`(?:^\s*(?:(?:please|just|only)\s+)*|\b(?:can|could|would|will) (?:you|someone) (?:please )?|\b(?:need|want|request|would like) (?:(?:you|someone) to |to )?(?:a |some )?)(?:send|fax|email|mail|forward|release|obtain|retrieve|provide|inspect|get|copy|copies|have\s+[^.!?;]{0,65}${DOC.source}\s+(?:sent|faxed|emailed|mailed|forwarded|released|provided))\b|\b(?:need|want|request|would like)\s+[^.!?;,]{0,65}${DOC.source}\s+(?:sent|faxed|emailed|mailed|forwarded|released|provided)\b`,
);
const ACCESS_QUESTION = new RegExp(
  String.raw`\bquestion about\s+(?:(?:the )?status of|getting|obtaining|requesting|receiving|accessing|(?:a )?(?:copy|copies) of)\b[^.!?;]{0,100}${DOC.source}`,
);
const INTERPRETATION = new RegExp([
  String.raw`\b(?:discuss|explain|interpret)\b`,
  String.raw`\b(?:understand|meaning of)\s+(?:(?:what|the|my|our|your|her|his|their|these|those|abnormal|normal|test|lab|exam|diagnostic)\s+)*results?\b`,
  String.raw`\bwhat (?:do|does)\b[^.!?;]{0,65}\bresults?\b[^.!?;]{0,30}\bmean\b`,
  String.raw`\bwhy (?:are|is|were|was)\b[^.!?;]{0,65}\bresults?\b[^.!?;]{0,30}\b(?:abnormal|normal|high|low)\b`,
  String.raw`\breview\b[^.!?]{0,40}\bresults?\b[^.!?]{0,40}\bwith\b`,
  String.raw`\bquestion about\s+(?:(?!(?:status|getting|get|obtaining|obtain|requesting|request|receiving|accessing|copy|copies|records?|charts?)\b)[a-z']+\s+){0,8}results?\b`,
].join('|'));
const BILLING = /\b(?:bills?|billing|copays?|payments?)\b/;
const PRESCRIPTION_ACTION = /\b(?:refill(?:s|ed|ing)?|renew(?:s|ed|ing|als?)?)\b/;
const MEDICATION = /\b(?:medication|medicine|drops?|pharmacy|medicina|medicamentos?|farmacia|gotas)\b/;
const PHARMACY = /\b(?:pharmac(?:y|ies)|walgreens|cvs|rite[- ]aid|costco)\b/;
const PRESCRIPTION_FULFILLMENT_ACTION = /\b(?:transfer(?:s|red|ring)?|call(?:s|ed|ing)?\b[^.!?;,]{0,65}\bin)\b/;
// Sending a prescription to be filled is clinical work. Explicit document
// copies still qualify through genericCopyRequest before this distinction.
const prescriptionFulfillment = (text: string) => /\b(?:prescriptions?|recetas?)\b/.test(text)
  && (PRESCRIPTION_ACTION.test(text) || PHARMACY.test(text) || PRESCRIPTION_FULFILLMENT_ACTION.test(text));
// An explicit copy request can name a document outside our vocabulary (e.g.
// an MRI or a file). Require an object and evidence that the copy is requested.
// Exclude billing objects here; a billing purpose for a medical copy still counts.
const GENERIC_COPY = new RegExp(String.raw`\b(?:(?:copy|copies) of|(?:copia|copias) de)\s+(?!(?:(?:a|an|the|my|our|your|his|her|their|this|that|last|latest|recent|medical|hospital)\s+)*${BILLING.source})[a-z0-9]`);
const GENERIC_COPY_REQUEST = /(?:^\s*(?:(?:please|just|only)\s+)*|\b(?:necesit\w*|solicit\w*|quiero)\s+(?:(?:una|unas)\s+)?)(?:copy|copies|copia|copias)\s+(?:of|de)\s+[a-z0-9]/;
const GENERIC_COPY_ACCESS = /\bquestion about\s+(?:(?:the )?status of|getting|obtaining|requesting|receiving|accessing)\b[^.!?;]{0,100}\b(?:copy|copies) of\s+[a-z0-9]/;
const WANT = /\b(?:need|want|request(?:ing|s|ed)?|would like|asking for|necesit\w*|solicit\w*|quiero)\b/;
const SCHEDULE_ACTION = /\b(?:reschedul\w*|schedul\w*|cancel\w*|confirm\w*|book\w*|change|move|reprogram\w*|cambiar)\b[^.!?]{0,65}\b(?:appointments?|visits?|exam|date|cita)\b|\b(?:schedul\w*|book\w*)\b[^.!?;]{0,65}\b(?:oct|visual field|vf|drs|fundus|topography)\b|\b(?:appointment|cita)\b[^.!?]{0,40}\b(?:change|cancel\w*|confirm\w*|reschedul\w*)\b/;
// Delivery must take a document as its object. Do not join an incidental
// records-office mention to "get an appointment" or "get a ride".
const DELIVERY_OBJECT = String.raw`(?:${DOC.source}|\b(?:notes?|reports?|results?|copies|copy|copia|copias|prescription|receta)\b)(?!\s+(?:line|department|office)\b)`;
const DELIVERY_TO_DOCUMENT = new RegExp(String.raw`${DELIVERY.source}\s+(?:(?!(?:so|and|appointments?|ride)\b)[a-z0-9'-]+\s+){0,10}${DELIVERY_OBJECT}`);
const DOCUMENT_TO_DELIVERY = new RegExp(String.raw`${DELIVERY_OBJECT}\s+(?:to be\s+)?(?:sent|faxed|emailed|mailed|forwarded|released|provided)\b`);
const documentDelivery = (text: string) => DELIVERY_TO_DOCUMENT.test(text) || DOCUMENT_TO_DELIVERY.test(text);
const PASSIVE_DELIVERY_REQUEST = new RegExp(String.raw`^(?:i|we) (?:need|want|would like)\s+[^.!?;,]{0,65}${DOC.source}\s+(?:sent|faxed|emailed|mailed|forwarded|released|provided)\b`);
// A refusal to send/get documents is not an access request. Split contrasted
// clauses below so a denied chart copy cannot suppress a separate report ask.
// Reuse the document vocabulary so refusing results, notes or imaging has
// the same effect as refusing a chart. Bare delivery objects count here too.
const NEGATED_RECORDS = new RegExp(
  String.raw`\b(?:(?:don't|do not|doesn't|does not) (?:need|want|request|send|fax|mail|email|get)|not (?:requesting|asking for|about|a request for)|no (?:need to|necesito|quiero))\b[^.!?;]{0,50}(?:${DOC.source}|\b(?:notes?|reports?|results?|copy|copies|copia|copias)\b)|\bno records (?:needed|required|requested)\b`,
);
const RECORDS_WORKFLOW = /\b(?:roi|release of information|subpoena|authorization to release|medical release|disability (?:form|paperwork)|fmla|(?:inspect|inspection of)\b[^.!?]{0,30}\b(?:file|chart|records?)|(?:work|school|doctor'?s?) note|note for (?:work|school)|write a letter|dmv (?:form|paperwork)|jury duty|verification of treatment|proof of (?:treatment|service)|proof that|(?:letter|carta) (?:for|from|stating|del)|fill out (?:a|this|my) form|paperwork to be filled|school form|constancia|comprobante|revisar mi expediente|ver mi expediente|send (?:me |us )?everything)\b/;
// Preserve the specialist cues used by the existing queue router as well as
// the literal referral cue. This only refines an already-scheduling request.
const SPECIALIST_APPOINTMENT = /\b(?:referral|cornea specialist|retina specialist|glaucoma specialist|oculoplastics?|neuro[- ]ophthalm\w*|pediatric (?:optometrist|ophthalm\w*)|peds|see a specialist|specialist (?:consult\w*|appointment)|referred to|was referred|cataract (?:consult\w*|evaluation)|consult for my cataract|low vision|uveitis|especialista|consulta con especialista)\b/;
const REQUEST_CONJUNCTION = new RegExp(
  String.raw`\b(?:and|but|because)\s+(?=(?:(?:i|we)\s+)?(?:${WANT.source}|${NEGATED_RECORDS.source})|(?:i|we) have (?:a|an) (?:[a-z'-]+ )?question\b|(?:just|only|please|(?:can|could|would|will) (?:you|someone)|reschedule|cancel|confirm|schedule|book|change|move|send|fax|email|mail|forward|release|obtain|retrieve|provide|inspect|get|refill|renew)\b)`,
);

function requestClauses(text: string): string[] {
  // A subject starting a new clause can correct a refusal even without an
  // imperative. Keep comma-separated document lists within the refusal.
  return fold(text).split(/[.!?;\n]+|,\s*(?=(?:(?:i|we|you|he|she|they)\b|(?:my|our|your|his|her|their|the)\s+(?:[a-z'-]+\s+){1,5}(?:is|are|was|were|has|have|needs?|broke)\b|(?:just|only|please|(?:can|could|would|will) (?:you|someone)|reschedule|cancel|confirm|schedule|book|send|fax|email|mail)\b))/)
    // Split independent instructions before discarding the refusal. Keep
    // document lists together and preserve interpretation/delivery context
    // in affirmative clauses ("explain my results and send me a copy").
    .flatMap(c => NEGATED_RECORDS.test(c)
      ? c.split(REQUEST_CONJUNCTION)
      : c.split(/\bbut\b/))
    .filter(c => !NEGATED_RECORDS.test(c));
}

function requestedDeliveryAfterInterpretation(clause: string, interpretation: number): boolean {
  return clause.slice(interpretation).split(/\b(?:and|then)\s+/).slice(1).some(part => {
    // Only a new instruction to us, not a description of what was or will be
    // sent, can turn a discussion request into a delivery request.
    const instruction = /^(?:(?:please|just|only)\s+)*(?:send|fax|email|mail|forward|release|obtain|retrieve|provide|inspect|get|have)\b|^(?:can|could|would|will) (?:you|someone)\b|^(?:i|we) (?:need|want|would like) (?:(?:you|someone) to|(?:a |some )?(?:copy|copies)\b)/.test(part)
      || PASSIVE_DELIVERY_REQUEST.test(part);
    const match = EXPLICIT_DELIVERY.exec(part);
    const reference = DOC.test(part) || /\b(?:notes?|reports?|results?|copy|copies|copia|copias)\b/.test(part)
      || /\b(?:send|fax|email|mail|forward|release|obtain|retrieve|provide|inspect|get)\s+(?:(?:me|us)\s+)?(?:it|them)\b/.test(part);
    const gettingClinician = /\bget\s+(?:(?:a|the|my|our)\s+)?(?:doctor|physician|specialist|nurse)\b/.test(part);
    return instruction && match !== null && /^(?:(?:i|we)\s+)?$/.test(part.slice(0, match.index))
      && reference && (DOC.test(clause) || /\b(?:notes?|reports?|results?|copy|copies|copia|copias)\b/.test(clause))
      && (!gettingClinician || /\b(?:send|fax|email|mail|forward|release|provide)\b/.test(part));
  });
}

// These are the scheduling workflows the existing queue router supports. Keep
// specific requests ahead of the ordinary new-appointment fallback.
function schedulingCue(t: string) {
  return SCHEDULING.find(row => row.cues.some(cue => t.includes(fold(cue))));
}

function schedulingReason(t: string): readonly [number, string] | null {
  if (/\b(?:same.day|seen today|get in today|squeeze me in|earlier appointment|sooner appointment|move my appointment up|cita para hoy|hoy mismo)\b/.test(t)) return [151, 'Same-Day Appointment Request'];
  if (/\b(?:cancel\w*|cannot make|can't make)\b/.test(t)) return [148, 'Cancel Appointment'];
  if (/\b(?:reschedul\w*|change|move|mover|reprogram\w*|cambiar)\b/.test(t)) return [147, 'Reschedule Existing Appointment'];
  if (/\b(?:confirm\w*|what time|when is|is my appointment)\b/.test(t)) return [149, 'Appointment Confirmation Call'];
  if (/\b(?:openings|availability|next available|what times do you have|disponibilidad|que horarios)\b/.test(t)) return [150, 'Appointment Availability Inquiry'];
  const cue = schedulingCue(t);
  if (cue) return [cue.reasonId, cue.reason];
  if (/\b(?:need|new|schedule|book|make|agendar|hacer|sacar|pedir|solicita\w*|quiere|quiero|necesita|desea)\b/.test(t)) return [146, 'New Appointment Request'];
  return null;
}

export function recordsLinePurpose(text: string): RecordsLinePurpose {
  // An actual delivery/access request wins even if its purpose is an upcoming
  // appointment, operation, referral or payer audit. The requester never vetoes it.
  const clauses = requestClauses(text);
  if (clauses.some(clause => {
    // Keep interpretation clinical unless the caller also requests delivery.
    const interpretation = clause.search(INTERPRETATION);
    const c = interpretation < 0 ? clause : clause.slice(0, interpretation);
    const accessQuestion = ACCESS_QUESTION.test(c);
    const genericCopyRequest = GENERIC_COPY.test(c) && (EXPLICIT_DELIVERY.test(c) || GENERIC_COPY_REQUEST.test(c) || GENERIC_COPY_ACCESS.test(c));
    if (interpretation >= 0 && requestedDeliveryAfterInterpretation(clause, interpretation)) return true;
    if (interpretation >= 0 && !EXPLICIT_DELIVERY.test(c) && !accessQuestion && !genericCopyRequest) return false;
    const document = DOC.test(c) || /\b(?:doctor'?s? note|notes? from|report from)\b/.test(c);
    const prescription = /\b(?:prescription|receta)\b/.test(c) && !MEDICATION.test(c) && !prescriptionFulfillment(c);
    if (accessQuestion) return true;
    if (genericCopyRequest) return true;
    const schedulingStart = c.search(SCHEDULE_ACTION);
    const beforeScheduling = schedulingStart < 0 ? c : c.slice(0, schedulingStart);
    if ((document || prescription || /\b(?:notes?|reports?|results?|imaging)\b/.test(c)) && documentDelivery(c)
      && (schedulingStart < 0 || (DOC.test(beforeScheduling) && documentDelivery(beforeScheduling)) || documentDelivery(c.slice(schedulingStart)))) return true;
    if (RECORDS_WORKFLOW.test(c)) return true;
    const independentlyRequestedDocument = schedulingStart < 0 || ((DOC.test(beforeScheduling) || /\b(?:prescription|receta)\b/.test(beforeScheduling)) && WANT.test(beforeScheduling))
      || c.slice(schedulingStart).split(/\band\s+(?=(?:(?:i|we)\s+)?(?:need|want|request|would like)\b)/).slice(1).some(part => WANT.test(part) && DOC.test(part));
    if ((document || prescription) && WANT.test(c) && independentlyRequestedDocument && !/\b(?:records? (?:line|department|office)|on (?:my |the )?record)\b/.test(c)) return true;
    // Short document requests and follow-ups need not repeat "send" each turn.
    return document && !SCHEDULE_ACTION.test(c) && !/\b(?:records? (?:line|department|office)|on (?:my |the )?record|note (?:that|my)|eligibility|claim|vendor)\b/.test(c)
      && /\b(?:my|her|his|their|our|medical|patient|some|the|for|from|review|status|follow.up|not received|has not|haven't)\b/.test(c);
  })) return 'records';
  // Refused documents are not evidence for the fallback queue either.
  const request = clauses.join('; ');
  // A surgery center can be the caller's employer, not the requested work.
  // Preserve the surgery-date exception when an operation is actually named.
  const operationText = request.replace(/\b(?:surgery|surgical) cent(?:er|re)s?\b/g, ' ');
  if (/\b(?:surgery|surgical|surgeon|operation|pre-op|post-op|lasik|cirugia)\b/.test(operationText)) return 'surgery';
  if (schedulingCue(request) || SCHEDULE_ACTION.test(request) || /\b(?:appointment|cita|eye exam|visit tomorrow|seen today|get in today|openings|availability|disponibilidad)\b/.test(request)) return 'scheduling';
  if (/\b(?:referral|referido|autorizacion)\b/.test(request)) return 'referral';
  if (/\b(?:payer|payor|health plan|vendor|insurance|eligibility|claim)\b/.test(request)) return 'professional';
  if (PRESCRIPTION_ACTION.test(request) || prescriptionFulfillment(request)) return 'clinical';
  if (/\b(?:glasses|frames?|contact lenses|eyeglasses|lentes|gafas)\b/.test(request)) return 'optical';
  if (MEDICATION.test(request) || /\b(?:prescription|receta|results?)\b/.test(request)) return 'clinical';
  if (BILLING.test(request)) return 'billing';
  if (/\b(?:surgery|surgical) cent(?:er|re)s?\b/.test(request)) return 'surgery';
  return 'unknown';
}

/** Legacy transport adapter. Ticketing re-evaluates this before persistence. */
export function recordsLineRedirect(text: string) {
  const purpose = recordsLinePurpose(text);
  if (purpose === 'records') return null;
  const t = requestClauses(text).join('; ');
  const targets = {
    surgery: [2, 'Surgery Coordination', 65, 535],
    referral: [18, 'PCP Support', 80, 550],
    professional: [18, 'PCP Support', 80, 550],
    optical: [1, 'Optical Support', 66, 536],
    clinical: [3, 'Clinical Tech Support', 72, 542],
    billing: [4, 'Billing', 78, 548],
    unknown: [9, 'HVA Hub', 69, 539],
    scheduling: [9, 'HVA Hub', 69, 539],
  } as const;
  const [departmentId, departmentName, defaultRequestTypeId, defaultRequestReasonId] = targets[purpose];
  let requestTypeId: number = defaultRequestTypeId;
  let requestReasonId: number = defaultRequestReasonId;
  let requestReason = 'Other - See Description';
  if (purpose === 'scheduling') {
    const scheduling = SPECIALIST_APPOINTMENT.test(t) ? [152, 'Specialist Referral Appointment'] as const : schedulingReason(t);
    if (scheduling) { requestTypeId = 32; [requestReasonId, requestReason] = scheduling; }
  }
  return { departmentId, departmentName, requestTypeId, requestReasonId, requestReason,
    note: `${departmentName} request — taken on the records line and routed here.` };
}
