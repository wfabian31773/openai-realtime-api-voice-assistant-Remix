/**
 * #6/#7: narrow correction for surgery-line/HVA intake. Keep this pure contract
 * aligned with the other repo's request-classification module. Ticketing makes
 * the final decision; the voice copy prevents asking for surgery-only facts.
 * Ambiguous surgery requests retain the existing surgery workflow. No records
 * requests or records-line decisions are classified here.
 */
export interface RequestClassification {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
}

export function withoutSurgeryFields(text: string): string {
  return text.replace(/^\s*(?:request type|department|agent|line|surgeon|surgery (?:date(?: given by caller)?|type|center|centre))\s*:[^\n]*(?:\n|$)/gim, '').trim();
}

function requestContent(text: string): string {
  return withoutSurgeryFields(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    // A line name and an explicit denial are not a request for an operation.
    .replace(/\b(?:the )?surgery (?:line|department|queue)\b/g, '')
    .replace(/\b(?:not|no)\s+(?:(?:about|for|a|my|any|cataract)\s+)*(?:surgery|lasik)\b/g, '');
}

export function isSurgeryRequest(text: string): boolean {
  return /\b(?:surgery|surgical|lasik|prk|operation|pre[- ]?op|post[- ]?op|cirugia|operacion)\b/.test(requestContent(text));
}

export function classifyNonSurgicalRequest(text: string): RequestClassification | null {
  const t = requestContent(text);
  // Deliberately leave records handling to its existing owner (#8).
  if (/\b(?:medical records?|records? request|copy of|copies of)\b/.test(t)) return null;
  if (isSurgeryRequest(text) || /\bsurgeon\b/.test(t)) return null;
  const result = (departmentId: number, requestTypeId: number, requestReasonId: number) =>
    ({ departmentId, requestTypeId, requestReasonId });
  const contacts = /\b(?:contacts|contact[- ]lens(?:es)?|cl|cls|lentes de contacto)\b/.test(t);
  const exam = /\b(?:eye[- ]exam|annual (?:eye )?exam|routine (?:eye )?exam|vision exam|glaucoma[- ](?:test|testing)|visual field|oct test|examen de (?:la vista|ojos)|prueba de glaucoma)\b/.test(t);
  // Medication authorizations stay with the existing medication logic.
  const medication = /\b(?:medication|medicine|drops?|pharmacy|medicamento|gotas|farmacia)\b/.test(t);
  if (!medication && /\b(?:insurance|coverage|eligibility|benefits|deductible|copay|seguro|cobertura|aseguranza)\b/.test(t)) {
    const reason = /\b(?:prior auth|authorization|autorizacion)\b/.test(t) ? 180
      : /\b(?:benefits|deductible|copay)\b/.test(t) ? 179
      : /\b(?:accept|take|in[- ]network|out[- ]of[- ]network|covered by|aceptan)\b/.test(t) ? 181 : 178;
    return result(9, 37, reason);
  }
  if (exam && !medication) {
    if (/\b(?:results?|resultados?)\b/.test(t)) return result(3, 72, 542);
    const reason = /\b(?:cancel|cancelar)\b/.test(t) ? 148
      : /\b(?:reschedule|reprogram\w*|cambiar|move|change)\b/.test(t) ? 147
      : /\b(?:confirm|confirmar|what time)\b/.test(t) ? 149 : 146;
    return result(9, 32, reason);
  }
  if (contacts) {
    if (/\b(?:renew|renewal|renovar)\b/.test(t) && /\b(?:prescription|rx|receta)\b/.test(t)) return result(3, 33, 157);
    if (/\b(?:status|ready|pickup|pick up|arriv\w*|estado|listos)\b/.test(t)) return result(1, 5, 21);
    if (/\b(?:order\w*|reorder\w*|buy|purchase|more|box|ordenar)\b/.test(t)) return result(1, 3, 11);
    return result(1, 66, 536);
  }
  if (!medication && /\b(?:optical|glasses|eyeglasses|spectacles|frames?|gafas|armazon|lentes)\b/.test(t)) return result(1, 66, 536);
  if (/\b(?:technician support|tech support)\b/.test(t)) return result(3, 72, 542);
  return null;
}

/** Only the two affected intake domains; other lanes keep their own rules. */
export function correctSurgeryIntake(text: string, departmentId?: number): RequestClassification | null {
  return departmentId === 2 || departmentId === 9 ? classifyNonSurgicalRequest(text) : null;
}
