/**
 * src/runtime/callRecord.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes one finished runtime call to `call_logs` — the same table the
 * OpenAI SIP core writes, so a Grok-served call and an OpenAI-served call
 * appear side by side in every dashboard, grader and cost report already
 * built against it. A separate table would have made the migration
 * unmeasurable, which is exactly the failure `docs/BACKEND_HANDOFF.md`
 * exists to prevent.
 *
 * WHAT THIS WRITES AND WHAT IT DELIBERATELY DOES NOT
 *
 * It writes what the RUNTIME can see without interpreting anything: who
 * called, what number they dialed, which lane answered, how long it ran,
 * the transcript, the tool timeline (names and ok/failed only), and the
 * turn/interruption counts. Every one of those is a fact about the call.
 *
 * It does NOT derive patient identity by reading tool results. The
 * runtime is agent-agnostic: `lookup_schedule` returning a row means
 * something in one agent and something else in the next, and guessing
 * would be exactly the "filling in the gaps" that has cost this project
 * days. Identity columns are populated only from an explicit
 * `identity` the caller supplies — see RuntimeCallIdentity — and are
 * left NULL otherwise, which reads honestly as "the runtime did not know."
 *
 * That gap is worth naming, because it is measured: the queue agents
 * (surgery, optical, tech) contain zero identity-writing calls today, so
 * their caller-ID columns are 0% populated. That is a LOGGING gap, not a
 * verification failure — see docs/GROK_MIGRATION_BASELINE.md. This module
 * gives the runtime a place to close it honestly rather than by inference.
 *
 * The DB module is imported DYNAMICALLY so nothing here pulls a database
 * connection into the process at boot: the runtime must start, serve
 * health, and fail closed even with no database configured.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { VoiceCallRecord } from "./mediaStreamBridge";

/**
 * Identity the runtime was TOLD, never identity it inferred. Supplied by
 * the lane wiring (caller-ID pre-context, or an agent-specific adapter);
 * absent means the columns stay NULL.
 *
 * A phone match is a candidate to confirm, never an identity — Wayne's own
 * number resolves to eight records in the mirror — so `patientFound` means
 * "this call was matched to a patient record", not "this caller is that
 * patient."
 */
export interface RuntimeCallIdentity {
  patientName?: string | null;
  patientDob?: string | null;
  patientFound?: boolean;
}

/** The exact `call_logs` shape this module writes. Kept explicit so a
 * schema change breaks the typecheck here rather than silently dropping a
 * column at runtime. */
export interface RuntimeCallLogRow {
  callSid: string;
  direction: "inbound";
  from: string;
  to: string;
  dialedNumber: string;
  agentUsed: string;
  status: "completed" | "failed";
  startTime: Date;
  endTime: Date;
  duration: number;
  localDurationSeconds: number;
  transcript: string;
  totalTurns: number;
  interruptionCount: number;
  telemetrySource: "realtime_events";
  environment: string;
  /** Present ONLY when the runtime was told — see RuntimeCallIdentity. */
  patientName?: string;
  patientDob?: string;
  patientFound?: boolean;
}

/**
 * The columns a SECOND write may refresh.
 *
 * `call_sid` is unique, so a retry or a racing teardown upserts. The update
 * must therefore touch only what the runtime itself owns and knows at
 * teardown. Everything else on the row belongs to another writer running
 * DURING the call — the agents' own tool telemetry, `stampVerifiedIdentity`,
 * the ticket number — and a blanket `set` overwrites all of it, which is
 * how a green migration produces unclassifiable filing outcomes (Codex
 * review, PR #227). Identity is deliberately excluded even when supplied:
 * refreshing it can only ever replace a value someone better informed
 * already wrote.
 */
export function toConflictUpdate(row: RuntimeCallLogRow): Partial<RuntimeCallLogRow> {
  return {
    status: row.status,
    endTime: row.endTime,
    duration: row.duration,
    localDurationSeconds: row.localDurationSeconds,
    transcript: row.transcript,
    totalTurns: row.totalTurns,
    interruptionCount: row.interruptionCount,
    telemetrySource: row.telemetrySource,
  };
}

/** A call that never reached a conversation is recorded as failed; every
 * other ending is a call that happened. `dead_air` and `provider_failure`
 * are the two the runtime itself caused. */
function statusFor(outcome: VoiceCallRecord["outcome"]): "completed" | "failed" {
  return outcome === "provider_failure" || outcome === "dead_air" ? "failed" : "completed";
}

/** Pure mapping, exported so it can be asserted without a database. */
export function toCallLogRow(
  record: VoiceCallRecord,
  identity: RuntimeCallIdentity = {},
  env: Record<string, string | undefined> = process.env,
): RuntimeCallLogRow {
  const durationSeconds = Math.max(
    0,
    Math.round((record.endedAtMs - record.startedAtMs) / 1000),
  );
  return {
    callSid: record.callSid,
    direction: "inbound",
    from: record.callerPhone,
    to: record.dialedNumber,
    dialedNumber: record.dialedNumber,
    agentUsed: record.slug,
    status: statusFor(record.outcome),
    startTime: new Date(record.startedAtMs),
    endTime: new Date(record.endedAtMs),
    duration: durationSeconds,
    // Both columns get the SAME measured number: the runtime owns the
    // whole call, so its local duration IS the call duration. The
    // duration-mismatch detector compares this against Twilio's own,
    // which is the point of keeping the column.
    localDurationSeconds: durationSeconds,
    transcript: record.transcript,
    // `toolTimeline` and `toolCallCount` are deliberately NOT written here.
    // The agents' own `recordedTool` telemetry already fills them, in a
    // richer shape the dashboards read (`{tool, args, outcome, ms}` plus the
    // purpose/result classification), and it runs on this transport exactly
    // as it does on SIP. A second writer with a different shape would
    // overwrite that record and make filing outcomes unclassifiable — which
    // would corrupt the very measurement this migration is judged by
    // (docs/BACKEND_HANDOFF.md). The runtime keeps its own view of the tool
    // calls on VoiceCallRecord, for logs and tests, and off the row.
    totalTurns: record.agentTurns,
    interruptionCount: record.interruptions,
    // Counted from real wire events, not estimated from wall time — the
    // distinction the column exists to record.
    telemetrySource: "realtime_events",
    environment: env.NODE_ENV === "production" ? "production" : "development",
    // Omitted entirely when unknown rather than written as null: the queue
    // agents' own stampVerifiedIdentity may already have set these during
    // the call, and a null would erase what it learned.
    ...(identity.patientName !== undefined && identity.patientName !== null
      ? { patientName: identity.patientName }
      : {}),
    ...(identity.patientDob !== undefined && identity.patientDob !== null
      ? { patientDob: identity.patientDob }
      : {}),
    ...(identity.patientFound !== undefined ? { patientFound: identity.patientFound } : {}),
  };
}

/**
 * Persist one finished call. Never throws: a lost record must not break
 * teardown, and teardown is the only caller. Returns whether the row was
 * written, so the runtime's own logs can say so honestly rather than
 * assuming.
 *
 * `call_sid` is UNIQUE, so a retry or a racing teardown updates the
 * existing row instead of failing the insert or duplicating the call.
 */
export type CallLogUpsert = (
  row: RuntimeCallLogRow,
  update: Partial<RuntimeCallLogRow>,
) => Promise<void>;

/** The real write. Kept separate and injectable so a test can prove the
 * NARROW update is what reaches the database — asserting `toConflictUpdate`
 * in isolation never showed that the writer actually used it, and a
 * mutation putting the whole row back passed the entire suite. */
async function defaultUpsert(
  row: RuntimeCallLogRow,
  update: Partial<RuntimeCallLogRow>,
): Promise<void> {
  const [{ db }, { callLogs }] = await Promise.all([
    import("../../server/db"),
    import("../../shared/schema"),
  ]);
  await db.insert(callLogs).values(row).onConflictDoUpdate({
    target: callLogs.callSid,
    set: update,
  });
}

export async function persistRuntimeCall(
  record: VoiceCallRecord,
  identity: RuntimeCallIdentity = {},
  upsert: CallLogUpsert = defaultUpsert,
): Promise<boolean> {
  const row = toCallLogRow(record, identity);
  try {
    await upsert(row, toConflictUpdate(row));
    return true;
  } catch (error) {
    // Log the failure rather than the record: a transcript in an error log
    // is patient data in a place nobody is watching.
    console.error(
      `[voice-runtime] call_logs write failed for ${record.callSid}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
