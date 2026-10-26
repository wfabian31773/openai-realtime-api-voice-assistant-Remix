/**
 * PHI that must never appear in plugin_audit_log, console lines about a
 * plugin call, or the ticket-resolved webhook log. A phone, a message body
 * and a transcript are the three the operator named; names, emails and
 * dates of birth go with them.
 */

export const PHI_FIELD_NAMES = [
  "phone",
  "patientPhone",
  "patient_phone",
  "from",
  "to",
  "body",
  "message",
  "text",
  "html",
  "transcript",
  "patientFirstName",
  "patientLastName",
  "patientEmail",
  "patient_email",
  "email",
  "dateOfBirth",
  "date_of_birth",
  "birthMonth",
  "birthDay",
  "birthYear",
  "resolutionNotes",
] as const;

const PHONE_WHOLE = /^(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}$/;
const EMAIL_WHOLE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export function looksLikePhi(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Whole-value only: a hex id or a route that happens to contain ten
  // digits is not a phone number.
  if (PHONE_WHOLE.test(trimmed)) return true;
  if (EMAIL_WHOLE.test(trimmed)) return true;
  return false;
}

/** True when a log/audit object carries a forbidden field or a phone/email string. */
export function auditContainsPhi(entry: Record<string, unknown>): boolean {
  for (const key of PHI_FIELD_NAMES) {
    if (key in entry && entry[key] != null && entry[key] !== "") return true;
  }
  for (const value of Object.values(entry)) {
    if (looksLikePhi(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (auditContainsPhi(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}

/** Fields the ticket-resolved webhook may log. No names, phones, emails, notes. */
export function ticketResolvedLogFields(input: {
  ticketId?: unknown;
  ticketNumber?: unknown;
  preferredContactMethod?: unknown;
}): Record<string, unknown> {
  return {
    ticketId: input.ticketId ?? null,
    ticketNumber: input.ticketNumber ?? null,
    contactMethod: input.preferredContactMethod ?? null,
  };
}
