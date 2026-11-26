/**
 * Whether the Observatory can put a supervisor on a call muted.
 *
 * Listen-in joins the supervisor's phone into the call's Twilio CONFERENCE
 * (`conf_<CallSid>`). Only the old core runs a call through a conference; the
 * runtime connects the caller straight to a Media Stream (`<Connect><Stream>`)
 * and has none. Measured on the Hub over the 14 days to 2026-11-26: 8,501 of
 * 8,502 calls were runtime calls, so the button dialled nothing and answered
 * "No in-progress conference found for that call — it may have just ended",
 * which is false: the call was live, it just had no conference.
 *
 * So a runtime call is refused up front with the true reason, and the page
 * shows the button disabled with that reason. Live listening on a runtime
 * call would need the stream's audio forked to a supervisor leg, which is a
 * build of its own, not this check.
 */
export const RUNTIME_LISTEN_IN_REASON =
  'Listen-in is not available on this call: runtime calls stream straight to the voice AI and have no conference to join. The recording and transcript are on the call page once it ends.';

/** The refusal for a call that cannot be joined, or null when it may be. */
export function listenInRefusal(log: { voiceProvider?: string | null } | null | undefined): string | null {
  if (log && log.voiceProvider != null && log.voiceProvider !== '') return RUNTIME_LISTEN_IN_REASON;
  return null;
}
