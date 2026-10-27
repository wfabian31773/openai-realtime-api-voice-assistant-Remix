/**
 * #6/#7: narrow correction for surgery-line/HVA intake. Keep this pure contract
 * aligned with the other repo's request-classification module. Ticketing makes
 * the final decision; the voice copy prevents asking for surgery-only facts.
 * Ambiguous surgery requests retain the existing surgery workflow. No records
 * requests or records-line decisions are classified here.
 */
import { classifySurgery } from './surgeryTaxonomy';

export interface RequestClassification {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
}

export const SURGERY_REQUEST_TYPE_IDS: ReadonlySet<number> = new Set([10, 11, 12, 13, 14, 65]);

export function withoutSurgeryFields(text: string): string {
  return text.replace(/^\s*(?:request type|department|agent|line|surgeon|surgery (?:date(?: given by caller)?|type|center|centre))\s*:[^\n]*(?:\n|$)/gim, '').trim();
}

function requestContent(text: string): string {
  return withoutSurgeryFields(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(is|are|was|were|do|does|did|has|have|had|would|should|could)n['’]t\b/g, '$1 not')
    // A line name and an explicit denial are not a request for an operation.
    .replace(/\b(?:the )?surgery (?:line|department|queue)\b/g, '')
    // Stay within explicit denials; "not sure" and "not cancel" still carry
    // surgical intent. Never consume a later affirmative clause.
    .replace(/\b(?:not|no)\s+(?:(?:about|for|a|an|the|my|any|need|want|planning|to|have|having|undergo|cataract|eye)\s+)*(?:surgery|lasik|prk|operation|procedure)\b/g, '');
}

export function isSurgeryRequest(text: string): boolean {
  const t = requestContent(text);
  // Generic operation words stay, so "cataract procedure" / "sx" still count
  // when the taxonomy box needs a longer scheduling phrase.
  if (/\b(?:surgery|surgical|lasik|prk|operation|cataracts?|procedures?|sx|pre[- ]?op|post[- ]?op|cirugia|operacion)\b/.test(t)) {
    return true;
  }
  // Named operations come from the procedure boxes, not a second list. A new
  // row in SURGERY_CLASSIFICATIONS (vitrectomy, blepharoplasty, …) counts
  // here. Logistics and the catch-all do not — those are not operations.
  return classifySurgery(t) !== null;
}

function isResultsRequest(t: string): boolean {
  return /\b(?:results?|resultados?)\b/.test(t);
}

/** Affirmative Hub scheduling only. A negated cancel does not win over a move. */
function hubSchedulingReason(t: string): number | null {
  if (/\b(?:cornea specialist|retina specialist|glaucoma specialist|oculoplastics?|neuro[- ]ophthalm\w*|pediatric (?:optometrist|ophthalm\w*)|peds|see a specialist|specialist (?:consult|appointment)|referral appointment|referred to|was referred|referral from my|cataract (?:consult|evaluation)|consult for my cataract|low vision|uveitis|especialista|consulta con especialista)\b/.test(t)) {
    return 152;
  }
  if (/\b(?:same[- ]day|today if|get in today|seen today|squeeze me in|sooner appointment|earlier appointment|move my appointment up|cita para hoy|hoy mismo)\b/.test(t)) {
    return 151;
  }
  const cancel = /\b(?:cancel\w*|cannot make|can't make)\b/.test(t);
  const cancelNegated = /\b(?:not|no|do not|don't)\s+(?:to\s+)?(?:cancel\w*)\b/.test(t);
  const reschedule = /\b(?:reschedul\w*|reprogram\w*|cambiar|mover|move|chang\w*|different day for my appointment)\b/.test(t);
  if (cancel && !cancelNegated) return 148;
  if (reschedule) return 147;
  if (/\b(?:confirm\w*|what time|is my appointment)\b/.test(t)) return 149;
  if (/\b(?:openings|what times do you have|next available|availability|disponibilidad|que horarios (?:tienen|hay))\b/.test(t)) {
    return 150;
  }
  if (/\b(?:schedul\w*|book\w*|make an appointment|set[- ]?up|need an appointment|get an appointment|agendar|sacar una cita|pedir una cita|hacer una cita|solicitud de cita|nueva cita|cita para)\b/.test(t)) {
    return 146;
  }
  return null;
}

/** A conservative veto, not a triage decision: preserve the existing workflow. */
export function hasClinicalComplaint(text: string): boolean {
  return /\b(?:pain|painful|hurts?|hurting|burning|swollen|swelling|redness|(?:red|bloodshot) eyes?|eyes?(?: is| are)? (?:very |really )?(?:red|bloodshot)|bleeding|discharge|blurry|blurred|flashes|floaters|vision loss|loss of vision|(?:cannot|can't) see|light sensitivity|dolor|duele|hinchado|sangrado|borroso|ojo rojo|no puedo ver)\b/.test(requestContent(text));
}

export function classifyNonSurgicalRequest(text: string): RequestClassification | null {
  const t = requestContent(text);
  // Deliberately leave records handling to its existing owner (#8).
  if (/\b(?:medical records?|records? request|copy of|copies of)\b/.test(t)) return null;
  if (isSurgeryRequest(text) || /\bsurgeon\b/.test(t) || hasClinicalComplaint(text)) return null;
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
    // Results only when the caller is asking for them, not booking around them.
    if (isResultsRequest(t) && !hubSchedulingReason(t)) return result(3, 72, 542);
    return result(9, 32, hubSchedulingReason(t) ?? 146);
  }
  if (contacts) {
    if (/\b(?:renew|renewal|renovar)\b/.test(t) && /\b(?:prescription|rx|receta)\b/.test(t)) return result(3, 33, 157);
    // Appointment language wins over order/status. Change/confirm/what-time
    // on an order, and a pickup time, stay Optical.
    const scheduled = hubSchedulingReason(t);
    const appointmentish = /\b(?:appointment|cita|exam|examen|fitting|reschedul\w*|schedul\w*|book\w*|make an appointment|set[- ]?up|need an appointment|get an appointment|agendar|sacar una cita|pedir una cita|hacer una cita|nueva cita|cita para)\b/.test(t);
    if (scheduled && appointmentish) return result(9, 32, scheduled);
    if (/\b(?:status|ready|pickup|pick up|arriv\w*|estado|listos)\b/.test(t)) return result(1, 5, 21);
    if (/\b(?:order\w*|reorder\w*|buy|purchase|more (?:contacts|contact[- ]lenses)|box|ordenar)\b/.test(t)) return result(1, 3, 11);
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
