/**
 * A create-ticket failure's `error`, safe to print (v116 — Codex thread
 * PRRT_kwDORVukLs6vzf35 on #371).
 *
 * Messages `ticketingApiClient` writes itself (a timeout, an unreachable host,
 * an unreadable body, missing config) pass through. Anything else is the far
 * side's text — a 5xx body, or an HTTP 200 answering `success:false` — which
 * can read `Location "<office>" not found`, and since v116 that office is the
 * one on the PATIENT'S RECORD. So only its status is printed.
 *
 * Its own module, not an export of the client, because many suites mock the
 * client wholesale and a log helper must not need mocking.
 */
const OWN_ERROR_PREFIXES = [
  'Ticketing API timeout',
  'Ticketing system unreachable',
  'Invalid JSON response from ticketing API',
  'Ticketing API client not properly initialized',
  'TICKETING_SYSTEM_URL not configured',
  'TICKETING_API_KEY not configured',
  'API returned success=false with no ticket number',
];

export function loggableTicketingError(error: string | undefined, statusCode?: number): string {
  if (!error) {
    return statusCode !== undefined ? `HTTP ${statusCode}, no reason given` : 'no ticket number returned';
  }
  if (OWN_ERROR_PREFIXES.some((p) => error.startsWith(p))) return error;
  return `${statusCode !== undefined ? `HTTP ${statusCode}` : 'no HTTP status'} ` +
    `(response text withheld — it can name the patient's office)`;
}

/**
 * A `/lookup` result's failure, safe to print (stand-in review of #371,
 * P2-1). On a directory outage the result's `error` is the app's text, or the
 * message of a thrown HTTP error, and either can echo the office on the
 * patient's record. The result keeps the raw text for any logic that needs
 * it; a `Cause:` line prints this.
 */
export function loggableLookupError(result: { error?: string; statusCode?: number }): string {
  if (!result.error) {
    return result.statusCode !== undefined ? `HTTP ${result.statusCode}, no reason given` : 'no reason given';
  }
  return loggableTicketingError(result.error, result.statusCode);
}
