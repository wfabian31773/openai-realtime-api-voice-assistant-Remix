/**
 * WHAT A RECORDING PUSH LEAVES BEHIND — Codex P2, #321 round 10.
 *
 * The recording push is partial and never marks a call delivered: the
 * five-minute sync (`ticketingSyncService`) selects `callDataSynced = false`
 * and carries the FULL payload, recording URL included, off the row. That
 * covers every ordering but one — a callback that lands AFTER the sync has
 * already finished the call. There the push is the URL's only path, and a
 * transient failure lost it for good: the URL sat on the row, the flag said
 * done, and no sweep would ever look again.
 *
 * So a failed push on an already-synced row RE-OPENS the sync: the flag goes
 * back to false, the next pass carries the full payload again — the same
 * values, idempotent on the app, the URL now on the row — and marks the call
 * itself. A row the sync has not finished needs nothing: the sync is coming.
 */
export type RecordingPushAftermath = "delivered" | "sync_will_carry" | "reopen_sync";

export function afterRecordingPush(delivered: boolean, alreadySynced: boolean): RecordingPushAftermath {
  if (delivered) return "delivered";
  return alreadySynced ? "reopen_sync" : "sync_will_carry";
}
