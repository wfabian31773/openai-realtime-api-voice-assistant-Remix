/**
 * HOW THE REQUESTER WANTS THE RECORDS — v188.
 *
 * Operator, 2026-11-08: *"for medical records, we are never asking, how would
 * you like to receive the records and that is never being passed back to the
 * request. We need to add that to the agent for medical records requests just
 * like we should be doing for the pcp line as well."*
 *
 * Measured the same morning, 2026-10-25..11-07, calls of 30 s or more that ran
 * a records tool: the PCP line asked the method on 103 of 108; the records line
 * asked it on 0 of 152 (46 were asked only where to send them). And on the
 * ticketing side `mr_cases.delivery_method_requested` is written by no voice
 * path at all — only a staffer on the case screen sets it — so even PCP's 103
 * answers reached the case as free text on the ticket and nowhere a report or
 * a fulfilment screen reads.
 *
 * One vocabulary, one question, one mapping, used by the records tool and
 * forwarded by PCP.
 */

/** What the agent offers and accepts. `pickup` is accepted, never offered. */
export const RECORDS_DELIVERY_METHODS = ['fax', 'email', 'mail', 'pickup'] as const;
export type RecordsDeliveryMethod = (typeof RECORDS_DELIVERY_METHODS)[number];

/**
 * The question, in PCP's own words (`DIRECTOR_PROMPTS.recordsDeliveryMethod`),
 * so a caller hears the same sentence on either line. A test holds the two
 * equal.
 */
export const DELIVERY_METHOD_QUESTION =
  'How would you like to receive the records — by fax, by email, or by mail?';

/** The destination question in the words of the method the caller chose. */
export const DELIVERY_DESTINATION_QUESTION: Record<Exclude<RecordsDeliveryMethod, 'pickup'>, string> = {
  fax: 'What fax number should we send them to?',
  email: 'What email address should we send them to? Please spell it out for me.',
  mail: 'What mailing address should we send them to?',
};

/**
 * The model's word for the method, read once. `null` is "not stated"; an
 * explicit "they don't know" or "not sure" is `unspecified`, which is an
 * ANSWER and ends the question.
 */
export function normalizeDeliveryMethod(raw: unknown): RecordsDeliveryMethod | 'unspecified' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/['’]/g, '').replace(/[\s_-]+/g, ' ');
  if (!s) return null;
  if (/^(e ?fax|fax|facsimile)\b/.test(s)) return 'fax';
  if (/^(e ?mail|secure e ?mail|email)\b/.test(s)) return 'email';
  if (/^(mail|postal|post|us mail|by mail|regular mail|snail mail)\b/.test(s)) return 'mail';
  if (/^(pick ?up|in person|collect|come (in|by))\b/.test(s)) return 'pickup';
  if (/^(unspecified|unknown|not sure|don ?t know|dont know|declined|none|any)\b/.test(s)) return 'unspecified';
  return null;
}

/**
 * The ticketing app's `CASE_DELIVERY_METHODS` value for `mr_cases.
 * delivery_method_requested` (ticketing-app lib/medical-records/
 * delivery-format.ts). An email of records is `secure_email` there.
 */
export function caseDeliveryMethod(
  m: RecordsDeliveryMethod | 'unspecified' | null,
): 'fax' | 'secure_email' | 'mail' | 'pickup' | undefined {
  switch (m) {
    case 'fax':
      return 'fax';
    case 'email':
      return 'secure_email';
    case 'mail':
      return 'mail';
    case 'pickup':
      return 'pickup';
    default:
      return undefined;
  }
}

/** The ticket line a records clerk reads, beside "Send to:". */
export function deliveryLine(m: RecordsDeliveryMethod | 'unspecified' | null, onTheForm: boolean): string {
  if (onTheForm) return '\nDelivery: on the signed form.';
  switch (m) {
    case 'fax':
      return '\nDelivery: by fax';
    case 'email':
      return '\nDelivery: by email';
    case 'mail':
      return '\nDelivery: by mail';
    case 'pickup':
      return '\nDelivery: pick up at the office';
    default:
      return '\nDelivery: NOT CAPTURED — ask the requester how they want the records.';
  }
}
