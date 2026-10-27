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
const DOC = /\b(?:records?|charts?|(?:progress|consult(?:ation)?|visit|office|surgery|surgical|operative) notes?|(?:operative|surgical|optometry|consultation|op) reports?|(?:test|lab|exam|diagnostic) results?|expedientes?|historial|informes?)\b/;
const DELIVERY = /\b(?:copy|copies|fax(?:ed|ing)?|send|sent|email(?:ed)?|mail(?:ed)?|forward|release|obtain|retrieve|provide|inspect|inspection|review|copia|copias|envi\w*|mand\w*)\b/;
const WANT = /\b(?:need|want|request(?:ing|s|ed)?|would like|asking for|necesit\w*|solicit\w*|quiero)\b/;
const SCHEDULE_ACTION = /\b(?:reschedul\w*|schedul\w*|cancel\w*|confirm\w*|book\w*|change|move|reprogram\w*|cambiar)\b[^.!?]{0,65}\b(?:appointments?|visits?|exam|date|cita)\b|\b(?:appointment|cita)\b[^.!?]{0,40}\b(?:change|cancel\w*|confirm\w*|reschedul\w*)\b/;
const NEGATED_RECORDS = /\b(?:(?:don't|do not|doesn't|does not) (?:need|want|request)|not (?:requesting|asking for|about|a request for)|no (?:necesito|quiero))\b[^.!?;]{0,35}\b(?:records?|charts?|copies|expedientes?)\b|\bno records (?:needed|required|requested)\b/;

export function recordsLinePurpose(text: string): RecordsLinePurpose {
  const t = fold(text);
  // An actual delivery/access request wins even if its purpose is an upcoming
  // appointment, operation, referral or payer audit. The requester never vetoes it.
  const clauses = t.split(/[.!?;\n]+/).filter(c => !NEGATED_RECORDS.test(c));
  if (clauses.some(c => {
    const document = DOC.test(c) || /\b(?:doctor'?s? note|notes? from|report from)\b/.test(c);
    const prescription = /\b(?:prescription|receta)\b/.test(c) && !/\b(?:refill|renew|pharmacy|medication|medicine|drops?)\b/.test(c);
    if ((document || prescription || /\b(?:notes?|reports?|results?|imaging)\b/.test(c)) && DELIVERY.test(c)) return true;
    if (/\b(?:discuss|explain|interpret|question about)\b/.test(c)) return false;
    if ((document || prescription) && WANT.test(c) && !SCHEDULE_ACTION.test(c) && !/\b(?:records? (?:line|department|office)|on (?:my |the )?record)\b/.test(c)) return true;
    if (/\b(?:release of information|subpoena|authorization to release|medical release|disability (?:form|paperwork)|fmla)\b/.test(c)) return true;
    // Short document requests and follow-ups need not repeat "send" each turn.
    return document && !SCHEDULE_ACTION.test(c) && !/\b(?:records? (?:line|department|office)|on (?:my |the )?record|note (?:that|my)|eligibility|claim|vendor)\b/.test(c)
      && /\b(?:my|her|his|their|our|medical|patient|some|the|for|from|review|status|follow.up|not received|has not|haven't)\b/.test(c);
  })) return 'records';
  if (/\b(?:surgery|surgical|surgeon|operation|pre-op|post-op|lasik|cirugia)\b/.test(t)) return 'surgery';
  if (SCHEDULE_ACTION.test(t) || /\b(?:appointment|cita|eye exam|visit tomorrow)\b/.test(t)) return 'scheduling';
  if (/\b(?:referral|referido|autorizacion)\b/.test(t)) return 'referral';
  if (/\b(?:payer|payor|health plan|vendor|insurance|eligibility|claim)\b/.test(t)) return 'professional';
  if (/\b(?:glasses|frames?|contact lenses|eyeglasses|lentes|gafas)\b/.test(t)) return 'optical';
  if (/\b(?:refill|medication|medicine|drops?|pharmacy|prescription|receta|gotas|results?)\b/.test(t)) return 'clinical';
  if (/\b(?:bill|billing|copay|payment)\b/.test(t)) return 'billing';
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
  let [departmentId, departmentName, requestTypeId, requestReasonId]: [number, string, number, number] = [...targets[purpose]];
  let requestReason = 'Other - See Description';
  if (purpose === 'scheduling') {
    const scheduling = /\breferral\b/.test(t) ? [152, 'Specialist Referral Appointment'] as const
      : /\b(?:cancel\w*|cannot make|can't make)\b/.test(t) ? [148, 'Cancel Appointment'] as const
      : /\b(?:reschedul\w*|change|move|reprogram\w*|cambiar)\b/.test(t) ? [147, 'Reschedule Existing Appointment'] as const
      : /\b(?:confirm\w*|what time|when is)\b/.test(t) ? [149, 'Appointment Confirmation Call'] as const
      : /\b(?:need|new|schedule|book|make|agendar)\b/.test(t) ? [146, 'New Appointment Request'] as const
      : null;
    if (scheduling) { requestTypeId = 32; [requestReasonId, requestReason] = scheduling; }
  }
  return { departmentId, departmentName, requestTypeId, requestReasonId, requestReason,
    note: `${departmentName} request — taken on the records line and routed here.` };
}
