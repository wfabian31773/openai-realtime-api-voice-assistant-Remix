/**
 * Item #8. Request evidence, never a phone line, template, requester or type id.
 * Kept identical in ticketing-app and voice-remix: independently deployed repos.
 * Ticketing owns the final taxonomy and case creation; voice uses this only to
 * avoid interviewing a scheduling caller about records delivery/signatures.
 */
export type RecordsLinePurpose = 'records' | 'surgery' | 'scheduling' | 'referral' | 'professional' | 'optical' | 'clinical' | 'billing' | 'unknown';

/** Remove only known generated metadata; never use it as caller evidence. */
export function recordsRequestText(text: string): string {
  return text.split(/\r?\n/).map(line => line.replace(/^\s*REASON FOR CALL:\s*/i, '')).filter(line => !/^\s*(?:PATIENT REQUEST\s*[-—]|Third-party request\s*\(|Requested by:|Send to:|Dates needed:|Request Type:|Request Reason:|Category:|Medical Records Request\s*$|(?:Scheduling|Optical|Surgery|Medication) request\s*[-—].*routed here)/i.test(line)).join('\n').trim();
}

const fold = (text: string) => recordsRequestText(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘]/g, "'");
const DOC = /\b(?:documentation|records?|charts?|(?:progress|consult(?:ation)?|visit|office|surgery|surgical|operative) notes?|(?:operative|surgical|optometry|consultation|op) reports?|(?:test|lab|exam|diagnostic) results?|imaging|oct|visual field|vf|drs|fundus|topography|expedientes?|registros?|historial|informes?)\b/;
const DELIVERY = /\b(?:copy|copies|get|fax(?:ed|ing)?|send|sent|email(?:ed)?|mail(?:ed)?|forward|release|obtain|retrieve|provide|inspect|inspection|copia|copias|envi\w*|mand\w*)\b/;
const WANT = /\b(?:need|want|request(?:ing|s|ed)?|would like|asking for|necesit\w*|solicit\w*|quiero)\b/;
const SCHEDULE_ACTION = /\b(?:reschedul\w*|schedul\w*|cancel\w*|confirm\w*|book\w*|change|move|reprogram\w*|cambiar)\b[^.!?]{0,65}\b(?:appointments?|visits?|exam|date|cita)\b|\b(?:appointment|cita)\b[^.!?]{0,40}\b(?:change|cancel\w*|confirm\w*|reschedul\w*)\b/;
// A refusal to send/get documents is not an access request. Split contrasted
// clauses below so a denied chart copy cannot suppress a separate report ask.
// Reuse the document vocabulary so refusing results, notes or imaging has
// the same effect as refusing a chart. Bare delivery objects count here too.
const NEGATED_RECORDS = new RegExp(
  String.raw`\b(?:(?:don't|do not|doesn't|does not) (?:need|want|request|send|fax|mail|email|get)|not (?:requesting|asking for|about|a request for)|no (?:need to|necesito|quiero))\b[^.!?;]{0,50}(?:${DOC.source}|\b(?:notes?|reports?|results?|copies)\b)|\bno records (?:needed|required|requested)\b`,
);
const RECORDS_WORKFLOW = /\b(?:roi|release of information|subpoena|authorization to release|medical release|disability (?:form|paperwork)|fmla|(?:inspect|inspection of)\b[^.!?]{0,30}\b(?:file|chart|records?)|(?:work|school|doctor'?s?) note|dmv (?:form|paperwork)|jury duty|verification of treatment|proof of treatment|(?:letter|carta) (?:for|from|stating|del)|fill out (?:a|this|my) form|paperwork to be filled|school form|constancia|comprobante|revisar mi expediente|ver mi expediente|send (?:me |us )?everything)\b/;

// These are the scheduling workflows the existing queue router supports. Keep
// specific requests ahead of the ordinary new-appointment fallback.
function schedulingReason(t: string): readonly [number, string] | null {
  if (/\b(?:same.day|seen today|get in today|squeeze me in|earlier appointment|sooner appointment|move my appointment up|cita para hoy|hoy mismo)\b/.test(t)) return [151, 'Same-Day Appointment Request'];
  if (/\b(?:cancel\w*|cannot make|can't make)\b/.test(t)) return [148, 'Cancel Appointment'];
  if (/\b(?:reschedul\w*|change|move|mover|reprogram\w*|cambiar)\b/.test(t)) return [147, 'Reschedule Existing Appointment'];
  if (/\b(?:confirm\w*|what time|when is|is my appointment)\b/.test(t)) return [149, 'Appointment Confirmation Call'];
  if (/\b(?:openings|availability|next available|what times do you have|disponibilidad|que horarios)\b/.test(t)) return [150, 'Appointment Availability Inquiry'];
  if (/\b(?:need|new|schedule|book|make|agendar|hacer|sacar|pedir|solicita\w*|quiere|quiero|necesita|desea)\b/.test(t)) return [146, 'New Appointment Request'];
  return null;
}

export function recordsLinePurpose(text: string): RecordsLinePurpose {
  const t = fold(text);
  // An actual delivery/access request wins even if its purpose is an upcoming
  // appointment, operation, referral or payer audit. The requester never vetoes it.
  const clauses = t.split(/[.!?;\n]+|\bbut\b|,\s*(?=(?:just|only)\b)/).filter(c => !NEGATED_RECORDS.test(c));
  if (clauses.some(c => {
    const document = DOC.test(c) || /\b(?:doctor'?s? note|notes? from|report from)\b/.test(c);
    const prescription = /\b(?:prescription|receta)\b/.test(c) && !/\b(?:refill|renew|pharmacy|medication|medicine|drops?)\b/.test(c);
    // Past delivery does not turn an interpretation question into access.
    if (/\b(?:discuss|explain|interpret|question about)\b/.test(c)
      || /\breview\b[^.!?]{0,40}\bresults?\b[^.!?]{0,40}\bwith\b/.test(c)) return false;
    if ((document || prescription || /\b(?:notes?|reports?|results?|imaging)\b/.test(c)) && DELIVERY.test(c)) return true;
    if (RECORDS_WORKFLOW.test(c)) return true;
    if ((document || prescription) && WANT.test(c) && !/\b(?:records? (?:line|department|office)|on (?:my |the )?record)\b/.test(c)) return true;
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
  if (SCHEDULE_ACTION.test(request) || /\b(?:appointment|cita|eye exam|visit tomorrow|seen today|get in today|openings|availability|disponibilidad)\b/.test(request)) return 'scheduling';
  if (/\b(?:referral|referido|autorizacion)\b/.test(request)) return 'referral';
  if (/\b(?:payer|payor|health plan|vendor|insurance|eligibility|claim)\b/.test(request)) return 'professional';
  if (/\b(?:glasses|frames?|contact lenses|eyeglasses|lentes|gafas)\b/.test(request)) return 'optical';
  if (/\b(?:refill|medication|medicine|drops?|pharmacy|prescription|receta|gotas|results?)\b/.test(request)) return 'clinical';
  if (/\b(?:bill|billing|copay|payment)\b/.test(request)) return 'billing';
  if (/\b(?:surgery|surgical) cent(?:er|re)s?\b/.test(request)) return 'surgery';
  return 'unknown';
}

/** Legacy transport adapter. Ticketing re-evaluates this before persistence. */
export function recordsLineRedirect(text: string) {
  const purpose = recordsLinePurpose(text);
  if (purpose === 'records') return null;
  const t = fold(text);
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
    const scheduling = /\breferral\b/.test(t) ? [152, 'Specialist Referral Appointment'] as const : schedulingReason(t);
    if (scheduling) { requestTypeId = 32; [requestReasonId, requestReason] = scheduling; }
  }
  return { departmentId, departmentName, requestTypeId, requestReasonId, requestReason,
    note: `${departmentName} request — taken on the records line and routed here.` };
}
