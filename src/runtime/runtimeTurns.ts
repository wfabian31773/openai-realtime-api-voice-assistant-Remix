/**
 * src/runtime/runtimeTurns.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITE A RUNTIME CALL'S TURNS TO `call_turns`, AT TEARDOWN.
 *
 * The old core records a turn as each transcript arrives; the runtime keeps
 * its lines in `CallTranscriptLog` with the moment each was first written
 * (`transcriptLog.ts`) and hands them over here once the call is over. See
 * `recordRuntimeTurns` in turnLog.ts for the write and for what it measured.
 *
 * THE STATE COLUMN IS HONEST OR EMPTY. `TurnState` was designed for the old
 * core's per-turn director; the runtime carries identity in `verifiedIdentity`
 * for the whole call, so every row of a call gets the same state: which
 * identity fields the record held when the call ended (names of fields, never
 * values — the turn table's own rule), whether the match was certain, and
 * `identityAsks: null` because this pipeline does not count asks per turn.
 */
import type { TurnState } from "../services/turnLog";
import { verifiedIdentityFor } from "../tools/verifiedIdentity";
import type { VoiceCallRecord } from "./mediaStreamBridge";

export function runtimeTurnState(callSid: string): TurnState {
  const v = verifiedIdentityFor(callSid);
  const known: string[] = [];
  if (v?.firstName) known.push("first_name");
  if (v?.lastName) known.push("last_name");
  if (v?.dateOfBirth) known.push("date_of_birth");
  return {
    known,
    identityVerified: v?.certain === true,
    identityAsks: null,
    intent: null,
  };
}

export async function persistRuntimeTurns(
  record: VoiceCallRecord,
  ids: { callLogId?: string } = {},
): Promise<number> {
  // LAZY, like every database-touching import on the runtime: turnLog pulls
  // in server/db, which validates DATABASE_URL at load. A static import here
  // would make the runtime refuse to boot — and its health check refuse to
  // answer — in any process without a database, which is exactly the
  // coupling voiceRuntime.ts avoids for the agents themselves.
  const { recordRuntimeTurns } = await import("../services/turnLog");
  return recordRuntimeTurns(record.callSid, record.turns ?? [], {
    callLogId: ids.callLogId,
    agentSlug: record.slug,
    state: runtimeTurnState(record.callSid),
  });
}
