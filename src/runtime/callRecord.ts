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
import { peekParkedRecording, releaseParkedRecording } from "./parkedRecordings";
import { resolveAgentId, type AgentIdLookup } from "./agentIdentity";
import { type RuntimeTransferOutcome } from "./transferOutcomeLog";

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
  /** Present ONLY when a recording callback landed before this row existed
   * and was parked (parkedRecordings.ts). Otherwise the callback writes the
   * column itself and this write must not touch it. */
  recordingUrl?: string;
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
 * review, PR #227). Identity is written when the runtime holds a CERTAIN one and
 * omitted otherwise, never nulled: it can add a name the row lacks and can
 * never erase one another writer established (v51 — before it, the update
 * excluded identity entirely and the runtime's rows carried none, 0 of
 * 2,471 in the seven days to 2026-09-17).
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
    ...(row.recordingUrl ? { recordingUrl: row.recordingUrl } : {}),
    // Identity, when established — see the note above. Present means the
    // lookup matched ONE person and nobody denied it; absent means unknown,
    // and unknown never overwrites known.
    ...(row.patientFound !== undefined ? { patientFound: row.patientFound } : {}),
    ...(row.patientName ? { patientName: row.patientName } : {}),
    ...(row.patientDob ? { patientDob: row.patientDob } : {}),
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

/**
 * A call that never reached a conversation is recorded as failed; every
 * other ending is a call that happened.
 *
 * `dead_air` used to be failed unconditionally, and that read the WATCHDOG
 * as the call: it fires after 30s of silence at ANY point, including after a
 * whole conversation whose caller then walked away. Measured 2026-09-17:
 * 58 dead_air calls on 2026-09-14 averaging 131s and 5.9 caller lines, 18 on
 * 09-15 averaging 7.2 — real conversations, all `status = 'failed'`, and
 * therefore never graded (the backfill selects completed rows) and never
 * synced to their tickets (`ticketingSyncService` does too). Twilio's own
 * meaning of the column is the one every other reader assumes: completed is
 * answered-and-ended, failed is never-connected. So dead_air is failed only
 * when the caller never spoke; `provider_failure` stays failed regardless.
 */
export function statusFor(
  outcome: VoiceCallRecord["outcome"],
  transcript: string = "",
): "completed" | "failed" {
  if (outcome === "provider_failure") return "failed";
  if (outcome === "dead_air") return /(^|\n)CALLER: /.test(transcript) ? "completed" : "failed";
  return "completed";
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
    status: statusFor(record.outcome, record.transcript),
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
    /**
     * The transfer column the SIP path writes and the dashboards read.
     * Omitted (never false) except on a transferred outcome, so this writer
     * cannot erase a transfer someone else recorded.
     *
     * A BLIND TRANSFER IS EXCLUDED, because nothing on that path observes a
     * human. The caller is redirected into an ACD queue and we let go of the
     * leg; Rosa's design reserves the claim for the warm path's keypress. On
     * 2026-09-14 this column carried `true` into `humanHandoffOccurred` on 23
     * PCP tickets whose handoff status was DIALING or NOT_REQUESTED, and a
     * staffer reading "handoff occurred" skips the callback — the one thing
     * that ticket exists to prevent.
     *
     * An UNSET method reads as warm rather than blind: warm is the per-lane
     * default everywhere except pcp, so defaulting the other way would trade
     * this bug for its mirror image and zero the metric instead.
     */
    ...(record.outcome === "transferred" && record.transferMethod !== "blind"
      ? { transferredToHuman: true as const }
      : {}),
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

/**
 * THE ONLY WRITER OF `transfer_outcome`, called when a transfer settles.
 *
 * Teardown deliberately does not touch this column. It used to, from a
 * snapshot of an in-memory store, and five rounds of review each found another
 * consequence of having two writers race over one value — see the long note in
 * transferOutcomeLog.ts. One writer, at the moment the answer exists, removes
 * the class rather than the instance.
 *
 * A TARGETED UPDATE, not an upsert. The row already exists: `openRuntimeCall`
 * creates it when the call begins, long before any transfer settles. Touching
 * one column is the whole point — an upsert here would re-assert this caller's
 * view of every other column over whatever the agents' own telemetry wrote
 * during the call.
 *
 * Never throws. A lost telemetry update must not surface anywhere near a call.
 */
/**
 * The tail of each call's write chain, so two settlements cannot land out of
 * order. Keyed per call, so different calls still write in parallel.
 */
const transferOutcomeWrites = new Map<string, Promise<unknown>>();

/** Test hook: how many calls still have a write chain open. Must return to 0. */
export function transferOutcomeWriteDepth(): number {
  return transferOutcomeWrites.size;
}

export async function persistTransferOutcome(
  callSid: string,
  transferOutcome: RuntimeTransferOutcome,
  update: (callSid: string, outcome: RuntimeTransferOutcome) => Promise<void> = defaultTransferOutcomeUpdate,
): Promise<boolean> {
  /**
   * SERIALISED PER CALL. Codex found this race on the single-writer redesign.
   *
   * A call can settle a transfer twice — attempt one fails, attempt two
   * connects — and each settlement fires its write without awaiting, so the
   * caller's path is never held behind a database round trip. Two round trips
   * in flight can COMPLETE in either order, and if the earlier attempt's
   * failure lands last it overwrites the success. The row would then say a
   * caller who reached a human did not.
   *
   * Chaining per call fixes completion order. Enqueue order is already
   * correct: attempts are strictly sequential — attempt two cannot settle
   * until attempt one has returned to the agent — so the writes are queued in
   * the order the outcomes happened, and this only stops them overtaking.
   *
   * A FAILED PREDECESSOR MUST NOT BLOCK ITS SUCCESSOR: the chain is joined
   * through a swallowed rejection, so one transient database error does not
   * strand every later write for that call. Its own caller still learns it
   * failed, from the return value.
   *
   * The map holds only the TAIL, and drops it when this write is still the
   * tail — so a finished call leaves nothing behind and the map cannot grow
   * with call volume.
   */
  const prior = transferOutcomeWrites.get(callSid) ?? Promise.resolve();
  const mine = prior.then(() => update(callSid, transferOutcome));
  const queued = mine.catch(() => undefined);
  transferOutcomeWrites.set(callSid, queued);
  try {
    await mine;
    return true;
  } catch (error) {
    console.error(
      `[voice-runtime] transfer_outcome update failed for ${callSid}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    if (transferOutcomeWrites.get(callSid) === queued) transferOutcomeWrites.delete(callSid);
  }
}

async function defaultTransferOutcomeUpdate(
  callSid: string,
  transferOutcome: RuntimeTransferOutcome,
): Promise<void> {
  const [{ db }, { callLogs }, { eq }] = await Promise.all([
    import("../../server/db"),
    import("../../shared/schema"),
    import("drizzle-orm"),
  ]);
  await db
    .update(callLogs)
    .set({ transferOutcome } as never)
    .where(eq(callLogs.callSid, callSid));
}

/**
 * The teardown write is retried on a short, bounded backoff. Until #321 round
 * 4 a single failed upsert — a database blip at hangup, the kind the Hub had
 * at 05:30 on 2026-09-17 — lost the call's whole row, and with it the parked
 * recording URL, and nothing ever tried again. Two retries, ~4s in total: a
 * caller is not waiting on this, and a row that lands a few seconds late is
 * a row.
 */
export const PERSIST_RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000];

async function withRetry<T>(
  fn: () => Promise<T>,
  backoffMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= backoffMs.length) throw error;
      await sleep(backoffMs[attempt]);
    }
  }
}

export interface PersistRuntimeCallOptions {
  /** Test seam: the backoff between attempts. Defaults to PERSIST_RETRY_BACKOFF_MS. */
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function persistRuntimeCall(
  record: VoiceCallRecord,
  identity: RuntimeCallIdentity = {},
  upsert: CallLogUpsert = defaultUpsert,
  options: PersistRuntimeCallOptions = {},
): Promise<boolean> {
  const row = toCallLogRow(record, identity);
  const backoffMs = options.backoffMs ?? PERSIST_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A recording callback that beat this row is parked by CallSid
  // (parkedRecordings.ts). Read it onto the write WITHOUT consuming it, and
  // look once more after the write so a callback landing between the two
  // cannot fall in the gap. The entry is released only once the write that
  // carried it has succeeded: a write that throws leaves the URL parked for
  // the retry below, or for the reaper's TTL (Codex P2, #321 round 4).
  const parkedUrl = peekParkedRecording(record.callSid);
  if (parkedUrl) row.recordingUrl = parkedUrl;
  /**
   * THE ANSWER IS ABOUT THE ROW, NOT ABOUT THE SECOND WRITE (Codex P2, #322
   * round 5). There are two upserts here: the call row, and a top-up carrying a
   * recording URL that landed between the two peeks. Both used to share one
   * try/catch and one `false`, so a blip on the SECOND one reported the whole
   * operation failed — and the one consumer of this boolean is v58's identity
   * telemetry, which turns it into `row_write_failed`: the write-stage
   * measurement corrupted during exactly the intermittent database failures it
   * exists to diagnose, on a call whose identity DID reach `call_logs`.
   *
   * So the primary write's outcome is tracked on its own. The top-up keeps its
   * retries and, on failure, keeps the URL parked for the reaper's TTL exactly
   * as before (#321 round 4) — it just no longer speaks for the row.
   */
  let rowWritten = false;
  try {
    await withRetry(() => upsert(row, toConflictUpdate(row)), backoffMs, sleep);
    rowWritten = true;
    if (parkedUrl) releaseParkedRecording(record.callSid, parkedUrl);
    const lateUrl = peekParkedRecording(record.callSid);
    if (lateUrl) {
      const withUrl = { ...row, recordingUrl: lateUrl };
      await withRetry(() => upsert(withUrl, toConflictUpdate(withUrl)), backoffMs, sleep);
      releaseParkedRecording(record.callSid, lateUrl);
    }
    return true;
  } catch (error) {
    // Log the failure rather than the record: a transcript in an error log
    // is patient data in a place nobody is watching. Two lines, because "the
    // row did not land" and "the row landed without its recording URL" are
    // different facts and the first one is the alarming one.
    const why = error instanceof Error ? error.message : String(error);
    if (rowWritten) {
      console.error(
        `[voice-runtime] call_logs row landed for ${record.callSid} but the late recording URL did not (still parked):`,
        why,
      );
    } else {
      console.error(`[voice-runtime] call_logs write failed for ${record.callSid}:`, why);
    }
    return rowWritten;
  }
}
