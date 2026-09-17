/**
 * src/services/recordingDelivery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO CARRIES A RECORDING URL TO THE TICKET — the recording callback, or the
 * post-call sync?
 *
 * Codex P1 on #321. The recording-status handler used to push the URL to the
 * ticketing app on its own and then stamp `callDataSynced: true`. That flag is
 * what `ticketingSyncService` selects on: a row marked synced is never swept
 * again, so the FULL post-call payload — transcript, duration, outcome,
 * grading — would never go out for any call whose recording landed before the
 * five-minute sweep. On the old core that race is narrow (the conference
 * recording finishes some time after the call); on the runtime (v44) the
 * dual-channel recording completes at hangup and its callback lands well
 * inside the window, so it would have been the COMMON case and every runtime
 * ticket would have carried a recording and nothing else.
 *
 * THE RULE: the sync payload already carries `recordingUrl` off the call row.
 * So if the sync has not run yet, saving the URL on the row is enough — the
 * sync will carry it, once, and set the flag itself. Only when the sync has
 * ALREADY run (the flag is true) does the callback push the URL directly,
 * because nothing else will — and it never touches the flag.
 */
export type RecordingDelivery = "push_now" | "leave_for_sync";

export function recordingDeliveryPlan(callLog: { callDataSynced?: boolean | null }): RecordingDelivery {
  return callLog.callDataSynced ? "push_now" : "leave_for_sync";
}
