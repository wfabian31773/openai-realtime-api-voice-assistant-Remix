/**
 * The age at which the Live Calls board shades a row as stale and the
 * admin-only "Cleanup Stale" button may close it (2026-11-26). It is the
 * server's MANUAL_CLEANUP_MIN_AGE_MS (server/services/staleCallSweep.logic.ts)
 * in minutes; server/staleCallCleanup.test.ts fails if the two drift.
 *
 * It was 5 minutes. A runtime call may run to its 10-minute ceiling, so the
 * board shaded, and the button acted on, calls that were still going.
 */
export const STALE_CALL_AFTER_MINUTES = 15

export const CLEANUP_BUTTON_TITLE =
  `Closes call rows open longer than ${STALE_CALL_AFTER_MINUTES} minutes whose call Twilio says has ended. ` +
  'It never hangs up a call. Admins only.'
