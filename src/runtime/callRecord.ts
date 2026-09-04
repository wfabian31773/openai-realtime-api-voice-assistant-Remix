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
import { resolveAgentId, type AgentIdLookup } from "./agentIdentity";

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
  /** Marks the row as this runtime's, so OpenAI cost estimation skips it. */
  voiceProvider: "grok";
  /** The runtime's own outcome, durably — `status` collapses six into two. */
  runtimeOutcome: VoiceCallRecord["outcome"];
  /** Ms from call start to the caller's first transcribed word. Null when
   * the caller never said anything the transcriber returned. */
  firstTranscriptDelayMs?: number;
  /** Ms from the last transcript to the end of the call — the tail a caller
   * spends listening to nothing. */
  postTranscriptTailMs?: number;
  /** Seconds between the first and last transcript. */
  transcriptWindowSeconds?: number;
  totalTurns: number;
  interruptionCount: number;
  telemetrySource: "realtime_events";
  environment: string;
  /** Set ONLY when the outcome is `transferred`: the caller was moved to
   * a human who accepted. Written as true or omitted — never false — so
   * a racing writer that recorded a transfer is not overwritten by this
   * one's omission (Codex, PR #230 round 2). */
  transferredToHuman?: true;
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
    voiceProvider: row.voiceProvider,
    runtimeOutcome: row.runtimeOutcome,
    ...(row.transferredToHuman ? { transferredToHuman: row.transferredToHuman } : {}),
    ...(row.firstTranscriptDelayMs !== undefined
      ? { firstTranscriptDelayMs: row.firstTranscriptDelayMs }
      : {}),
    ...(row.postTranscriptTailMs !== undefined
      ? { postTranscriptTailMs: row.postTranscriptTailMs }
      : {}),
    ...(row.transcriptWindowSeconds !== undefined
      ? { transcriptWindowSeconds: row.transcriptWindowSeconds }
      : {}),
  };
}

/**
 * The environment tag reporting filters on.
 *
 * Production is declared by ANY of the signals this repo actually deploys
 * with, because none implies the others: `.replit` deployments set
 * `APP_ENV=production` — the value the SIP path stores in this same
 * column — the shared resolver recognizes `REPLIT_DEPLOYMENT=1` and a
 * published `.replit.app` domain, and none of those sets `NODE_ENV`.
 * Testing `NODE_ENV` alone tagged every live Replit call 'development',
 * so environment-scoped reporting and the migration measurements omitted
 * exactly the calls they exist to count (Codex review, PR #227 round 20).
 * `getEnvironmentConfig()` is deliberately NOT reused here: it validates
 * the full secret schema and throws on a missing one, and a logging path
 * must never be the thing that dies over configuration.
 */
export function callEnvironment(env: Record<string, string | undefined>): string {
  const domains = env.REPLIT_DOMAINS ?? "";
  const publishedDomain = domains.includes(".replit.app") && !domains.includes(".replit.dev");
  return env.APP_ENV === "production" ||
    env.NODE_ENV === "production" ||
    env.REPLIT_DEPLOYMENT === "1" ||
    publishedDomain
    ? "production"
    : "development";
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
    // Not an OpenAI call. Cost reconciliation estimates OpenAI spend from
    // duration whenever the token columns are null, and they always are
    // here, so without this every Grok call is priced at the OpenAI rate
    // (Codex review, PR #227).
    voiceProvider: "grok",
    // The outcome, durably. `status` maps six endings onto two, and the
    // registry copy is consumed by the post-stream redirect — so an hour
    // later nothing could tell dead air from a provider failure, which is
    // what the runbook tells an operator to check.
    runtimeOutcome: record.outcome,
    // Split by what each column MEANS (Codex, PR #227 round 12 — the
    // greeting-only case fixed in the bridge was still dropped here, one
    // layer downstream, and gradeTailSafety fell back to its no-data score):
    // the tail measures silence after the final words, WHOEVER spoke them,
    // so it derives from the last transcript alone; the caller-latency delay
    // and the caller-anchored window exist only once a caller has spoken.
    ...(record.lastTranscriptAtMs !== undefined
      ? {
          postTranscriptTailMs: Math.max(
            0,
            record.endedAtMs - record.lastTranscriptAtMs,
          ),
        }
      : {}),
    ...(record.firstTranscriptAtMs !== undefined
      ? {
          firstTranscriptDelayMs: Math.max(
            0,
            record.firstTranscriptAtMs - record.startedAtMs,
          ),
          transcriptWindowSeconds: Math.max(
            0,
            Math.round(
              ((record.lastTranscriptAtMs ?? record.firstTranscriptAtMs) -
                record.firstTranscriptAtMs) /
                1000,
            ),
          ),
        }
      : {}),
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
    /**
     * WHAT THE CALL COST — the columns the old core has always written and the
     * runtime never did.
     *
     * Spread conditionally, so a call the provider reported nothing for leaves
     * them NULL rather than writing zeros. That distinction is the finding:
     * on 2026-09-03, 179 completed runtime calls carried NULL in every one of
     * these while the old core's 185 over the same hours reported 77.0% of
     * input tokens served from cache. Zeros here would have made a missing
     * feed look like a free call and hidden it again.
     */
    ...(record.usage
      ? {
          inputTextTokens: record.usage.inputTextTokens,
          inputAudioTokens: record.usage.inputAudioTokens,
          outputTextTokens: record.usage.outputTextTokens,
          outputAudioTokens: record.usage.outputAudioTokens,
          inputCachedTokens: record.usage.inputCachedTokens,
          inputCachedTextTokens: record.usage.inputCachedTextTokens,
          inputCachedAudioTokens: record.usage.inputCachedAudioTokens,
        }
      : {}),
    // Counted from real wire events, not estimated from wall time — the
    // distinction the column exists to record.
    telemetrySource: "realtime_events",
    environment: callEnvironment(env),
    // The transfer column the SIP path writes and the dashboards read.
    // Omitted (never false) except on a transferred outcome, so this
    // writer cannot erase a transfer someone else recorded.
    ...(record.outcome === "transferred" ? { transferredToHuman: true as const } : {}),
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
/** The row opened when a call starts, before the agent can do anything. */
export interface RuntimeCallOpenRow {
  callSid: string;
  direction: "inbound";
  from: string;
  to: string;
  dialedNumber: string;
  agentUsed: string;
  /**
   * The agents-table uuid. `agentUsed` carries the slug, but every per-agent
   * report joins on THIS — so a row without it is not mis-attributed, it is
   * absent. See src/runtime/agentIdentity.ts for the measurement that found
   * 239 runtime calls missing from the Observatory for exactly this reason.
   * Optional because a lane with no agents row must still be logged.
   */
  agentId?: string;
  agentVersion?: string;
  status: "in_progress";
  startTime: Date;
  environment: string;
  /** The pricing discriminator, from call START. Twilio's completion
   * callback can race the teardown upsert; `priceVoiceCall` reads the
   * row's provider, and an open row without it priced the call as OpenAI
   * — a wrong charge `toConflictUpdate` deliberately never repairs,
   * because cost columns belong to other writers (Codex review, PR #227
   * round 20). */
  voiceProvider: "grok";
}

/** Returns the new row's id when the database supplies one. */
export type CallLogInsert = (row: RuntimeCallOpenRow) => Promise<string | undefined>;

async function defaultOpenInsert(row: RuntimeCallOpenRow): Promise<string | undefined> {
  const [{ db }, { callLogs }, { eq }] = await Promise.all([
    import("../../server/db"),
    import("../../shared/schema"),
    import("drizzle-orm"),
  ]);
  // A duplicate webhook or a reconnect must not fail the call.
  const inserted = await db
    .insert(callLogs)
    .values(row)
    .onConflictDoNothing({ target: callLogs.callSid })
    .returning({ id: callLogs.id });
  if (inserted[0]?.id) return inserted[0].id;
  // Conflict: the row already exists, so read back the id the agents need.
  const existing = await db
    .select({ id: callLogs.id })
    .from(callLogs)
    .where(eq(callLogs.callSid, row.callSid))
    .limit(1);
  return existing[0]?.id;
}

/**
 * Open the call's row at the START of the call, the way the SIP transport
 * has always done (voiceAgentRoutes.ts creates it with status
 * 'in_progress' before the agent runs).
 *
 * This is not bookkeeping — it is what makes every other writer work.
 * `flushAzulTimeline` issues `UPDATE call_logs ... WHERE call_sid = ?` and
 * then marks its events flushed whether or not a row was touched
 * (toolTimeline.ts:559-569); `stampVerifiedIdentity` and the ticket number
 * update the same row. With no row until teardown, each of those writes
 * lands on nothing and the timeline in particular is lost permanently,
 * because the reaper sees it as already flushed (Codex review, PR #227).
 *
 * Never throws and never blocks the call: a caller who cannot be logged is
 * still a caller to be answered. Returns the row's ID — the agents poll for
 * it through `metadata.callLogId` before writing what they learned about the
 * caller, and without it that write never happens — or undefined when the
 * row could not be opened.
 */
export async function openRuntimeCall(
  context: {
    callSid: string;
    slug: string;
    callerPhone: string;
    dialedNumber: string;
    agentVersion?: string | null;
    /** When the stream was claimed — NOT when this insert runs. */
    startedAtMs: number;
  },
  insert: CallLogInsert = defaultOpenInsert,
  env: Record<string, string | undefined> = process.env,
  agentIdLookup?: AgentIdLookup,
): Promise<string | undefined> {
  try {
    // Resolved BEFORE the insert, not patched on afterwards: the row is
    // read the moment it lands (flushAzulTimeline, stampVerifiedIdentity),
    // and a row that is briefly unattributed is a row some report samples
    // while it is. Awaiting it costs one cached map read after the first
    // call on each lane, and a failure yields undefined rather than
    // throwing, so the call is still logged exactly as it is today.
    const agentId = await resolveAgentId(context.slug, agentIdLookup);
    return await insert({
      callSid: context.callSid,
      direction: "inbound",
      from: context.callerPhone,
      to: context.dialedNumber,
      dialedNumber: context.dialedNumber,
      agentUsed: context.slug,
      ...(agentId ? { agentId } : {}),
      ...(context.agentVersion ? { agentVersion: context.agentVersion } : {}),
      status: "in_progress",
      // The claim time, not `new Date()`: this insert runs only after the
      // precontext lookup and the lane factory, while teardown derives
      // `duration` from the earlier claim and deliberately never updates
      // startTime on conflict — so an insertion-time startTime leaves a
      // permanent row where endTime - startTime is short by the whole
      // setup delay (Codex review, PR #227 round 13).
      startTime: new Date(context.startedAtMs),
      environment: callEnvironment(env),
      voiceProvider: "grok",
    });
  } catch (error) {
    console.error(
      `[voice-runtime] could not open call_logs row for ${context.callSid}:`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

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
