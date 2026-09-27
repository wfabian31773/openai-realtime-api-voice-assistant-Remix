/**
 * THE TICKET API'S FIELD REFUSAL, READ AS A LIST OF FIELDS — IN WHICHEVER OF
 * ITS TWO SPELLINGS ARRIVES.
 *
 * `CA42f5b35d3924b8a1e5e66c00ee927742`, no-ivr, 2026-09-27 20:48 UTC, 217 s,
 * 14 caller lines: a reschedule request whose caller asked to be reached by
 * EMAIL and spelled the address out on the call. The model called
 * `create_ticket` with `preferred_contact: "email"` and NO `email` argument.
 * The ticketing app refused it, HTTP 400, and its body — read from
 * `voice_agent_api_logs`, not inferred — was:
 *
 *   { "error": "Missing required fields: patientEmail. Please collect these
 *               from the patient before submitting., missing: patientEmail",
 *     "success": false,
 *     "validationErrors": [ "Missing required fields: patientEmail. …",
 *                           "missing: patientEmail" ] }
 *
 * No `missingFields` key reaches the client: `makeRequest` throws on a 4xx
 * with the body's `error` TEXT as the message and nothing else, `submitTicket`
 * catches that into `{ errorCode: 'request_failed', error: <text> }`, so
 * `submitSimplifiedTicket` saw `response.missingFields` undefined and returned
 * the raw text. Every agent on that path matches the refusal on the OTHER
 * spelling — `Missing required information: …`, the shape `submitSimplifiedTicket`
 * itself writes when the array IS present — so the no-ivr handler's
 * `includes('Missing required information')` missed, the refusal fell through
 * to the generic branch, and the agent spoke *"I'm experiencing a technical
 * issue on my end right now. I have your information and our team will call
 * you back"* — to a caller whose request was never filed, and no ticket of any
 * provenance exists for that call.
 *
 * Two spellings of one refusal, and every reader knew one of them. This is the
 * ONE place either spelling is turned into a field list, so no agent has to
 * know there are two. The sink (`submitSimplifiedTicket`) normalises through
 * it for every lane on that path; the no-ivr handler reads it again on the way
 * out so it can name the field to the model in words rather than in the app's
 * column names.
 *
 * WHAT IT DOES NOT DO: it does not decide whether a field is required. The
 * app decides that (`lib/services/voice-agent-ticket-service.ts` on the
 * ticketing side); this only reads what the app said.
 */

/**
 * The field names the app's `/submit-ticket` refusal can carry, in the words
 * an agent should use when asking for them. RULE ZERO 2b: the format rides in
 * the question, so the date of birth names its order and the phone number its
 * length. An unknown field falls through as itself rather than being dropped —
 * a refusal we cannot translate is still a refusal the model must act on.
 */
const SPOKEN_FIELD: Record<string, string> = {
  patientEmail: 'the email address to reach them at, spelled out letter by letter',
  patientPhone: 'a callback phone number, all ten digits',
  patientDOB: 'the date of birth, month first, then the day, then the year',
  patientFullName: "the patient's first and last name",
  preferredContactMethod: 'how they would like to be reached (a call, a text, or an email)',
  reasonForCalling: 'what they are calling about',
};

export function spokenFieldName(field: string): string {
  return SPOKEN_FIELD[field] ?? field;
}

export function spokenMissingFields(fields: string[]): string {
  return fields.map(spokenFieldName).join('; ');
}

/**
 * Read the missing fields out of a refusal's error text.
 *
 * Two shapes are accepted and nothing else is:
 *
 *   "Missing required information: a, b"                 — the sink's own
 *   "Missing required fields: a, b. Please collect …, missing: a, b"
 *                                                       — the app's, verbatim
 *
 * The app's shape is read from its `missing:` tail when it has one — that is
 * the machine-readable half of the sentence, and the head repeats it — and
 * from the head otherwise. Anything that is not a field refusal answers null,
 * so a caller cannot mistake an outage or a timeout for a question: the two
 * are handled differently downstream and only one of them is the caller's to
 * answer.
 */
export function missingFieldsFromRefusal(error: string | null | undefined): string[] | null {
  if (!error) return null;
  const text = String(error).trim();

  const tail = /\bmissing:\s*([^.\n]+?)\s*\.?\s*$/i.exec(text);
  const head = /^Missing required (?:information|fields):\s*([^.\n]+)/i.exec(text);
  const list = tail?.[1] ?? head?.[1];
  if (!list) return null;

  const fields = list
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return fields.length > 0 ? fields : null;
}
