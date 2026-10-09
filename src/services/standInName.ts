/**
 * THE STAND-IN NAME — one spelling for a ticket that must file with no name.
 *
 * Some tickets exist because something HAPPENED, not because a caller gave us
 * their details: the record of an after-hours caller connected to the on-call
 * provider (operator mandate 2026-07-25: every urgent outcome leaves a record
 * ticket in After Hours), the ticket a refused escalation files on the spot
 * (v80), and the setup-failure floor (v91). Each one files whether or not a
 * name was captured, so each one needs a name the ticketing app will accept.
 *
 * "UNKNOWN CALLER" IS NOT ONE. The app's `/submit-ticket` refuses any name
 * whose every word is on its placeholder list (`INVALID_NAME_PATTERNS` in
 * ticketing-app `lib/services/voice-agent-ticket-service.ts`) and answers
 * HTTP 400 "Could not parse patient name" — and `unknown` and `caller` are
 * BOTH on it. Measured in `voice_agent_api_logs`, 2026-08-11..10-09: of the
 * after-hours urgent transfer records, 64 filed and 22 were refused for the
 * name, every one on a call whose caller WAS connected to the on-call
 * provider, and none of the 22 has a ticket of any provenance.
 *
 * `Unnamed Caller` passes because `unnamed` is not on the list, and it is what
 * the setup-failure floor already sends — so a staffer learns one stand-in,
 * not three. A ticket carrying it always carries a note saying so.
 *
 * `APP_PLACEHOLDER_NAME_WORDS` is a PINNED COPY of the app's list, read on
 * 2026-10-09. `standInName.test.ts` holds the stand-in against it; if the app
 * ever adds `unnamed`, that copy is what has to move first.
 */

export const STAND_IN_FIRST_NAME = "Unnamed";
export const STAND_IN_LAST_NAME = "Caller";
export const STAND_IN_FULL_NAME = `${STAND_IN_FIRST_NAME} ${STAND_IN_LAST_NAME}`;

/** ticketing-app `INVALID_NAME_PATTERNS`, 2026-10-09. */
export const APP_PLACEHOLDER_NAME_WORDS: readonly string[] = [
  "unknown", "anonymous", "n/a", "na", "none", "test", "patient",
  "caller", "customer", "user", "guest", "no name", "noname",
];

/**
 * True when `/submit-ticket` would refuse this name: blank, or every word on
 * the placeholder list (which also covers "unknown unknown" and the like).
 * Mirrors the app's rule; it is not a judgement about what a name is.
 */
export function appWouldRefuseName(fullName: string): boolean {
  const cleaned = fullName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!cleaned) return true;
  if (APP_PLACEHOLDER_NAME_WORDS.includes(cleaned)) return true;
  return cleaned.split(" ").every((w) => APP_PLACEHOLDER_NAME_WORDS.includes(w));
}

/**
 * The name to file under: what the caller gave, or the stand-in when what
 * they gave (or the model wrote) would be refused. `standIn` says which, so
 * the caller of this can put the note on the ticket.
 */
export function nameOrStandIn(
  first: string | undefined,
  last: string | undefined,
): { fullName: string; standIn: boolean } {
  const given = [first, last].filter(Boolean).join(" ").trim().replace(/\s+/g, " ");
  return appWouldRefuseName(given)
    ? { fullName: STAND_IN_FULL_NAME, standIn: true }
    : { fullName: given, standIn: false };
}

/** The staff note beside a stand-in name. */
export const STAND_IN_NAME_NOTE =
  "NAME NOT CAPTURED — no patient name was recorded on this call, so the name " +
  `on this ticket ("${STAND_IN_FULL_NAME}") is a stand-in. The call recording ` +
  "and caller ID are the way back to who this is.";
