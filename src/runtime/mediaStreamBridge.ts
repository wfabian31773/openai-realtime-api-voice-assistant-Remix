/**
 * src/runtime/mediaStreamBridge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The bridge between ONE Twilio Media Streams WebSocket and ONE
 * GrokVoiceSession running ONE bound agent. Pure plumbing: audio
 * pass-through, barge-in, tool dispatch, mark-gated hangup, dead-air
 * watchdog and exactly-once teardown.
 *
 * It speaks NO words of its own. There is not one caller-audible string in
 * this file — every word a caller hears on this transport comes from the
 * agent's own prompt through the model. That is the whole point of the
 * runtime: "same exact agent, different voice pipeline."
 *
 * Ported from the 5Star DRS telephony bridge, whose rules were each paid
 * for by a live call. They are restated here because the port is the only
 * thing standing between this runtime and paying for them again:
 *
 *   BARGE-IN = BOTH SIGNALS, ALWAYS TOGETHER. When the caller talks over
 *   playback (Grok's server VAD -> onSpeechStarted), the bridge (a) cancels
 *   the in-flight response AND (b) sends Twilio a `clear` to discard its
 *   buffered audio. Cancel without clear = the caller keeps hearing seconds
 *   of stale speech; clear without cancel = the model keeps generating (and
 *   billing) into a void.
 *
 *   MARK-GATED HANGUP. Twilio `mark` echoes are the ONLY ground truth that
 *   audio actually played to the caller. After the final utterance's audio
 *   is fully sent, the bridge sends a named mark and hangs up when that
 *   mark comes back — with a bounded fallback DERIVED from the audio
 *   actually sent (μ-law 8kHz = 8 bytes/ms) plus a fixed jitter grace.
 *   Never an arbitrary constant, never an unbounded wait.
 *
 *   EXACTLY-ONCE TEARDOWN. Caller hangup, session error, session close,
 *   final-mark completion, dead air and the max-duration ceiling all funnel
 *   into one guarded teardown that records exactly one outcome.
 *
 * TWO THINGS ARE GENUINELY DIFFERENT HERE, and both come from the same
 * fact: on this runtime the agent's words are written by the MODEL, not by
 * a renderer that knew them in advance.
 *
 *   1. AGENT TEXT COMES OFF THE WIRE — EXCEPT THE GREETING. The scheduling
 *      bridge held each utterance's text from the moment it was queued.
 *      Here the only source is the transcript stream, so the bridge
 *      accumulates `response.output_audio_transcript.delta` and commits on
 *      `...done` — which also means a line cut off mid-sentence still has
 *      the words the caller actually heard, recorded as "[interrupted]".
 *
 *      The greeting is `deps.greeting`, spoken verbatim: its words are known
 *      at the handshake, so its line waits for nothing and is written the
 *      moment its first audio goes out. That is not an optimisation. Every
 *      other line is committed on its Twilio mark echo, and for the greeting
 *      that echo lands long after the caller events the line has to be
 *      ordered against — while the lock below means it cannot borrow
 *      barge-in's habit of committing early either. Deferring a line whose
 *      text was never in doubt produced five distinct ordering defects in the
 *      opening exchange (PR #241), each fix deciding "before or after" at a
 *      different point in the event stream and exposing the next seam.
 *      Writing it where its audio began produces none, because there is
 *      nothing left to order.
 *
 *   2. STALE UTTERANCES ARE IDENTIFIED BY RESPONSE EPOCH, not by a queue
 *      sequence assigned at render time. The wire is ordered and responses
 *      are serial — every event of response N arrives before response
 *      N+1's `response.created` — so recording the epoch a barge-in
 *      cancelled is sufficient to ignore everything that response emits
 *      afterwards. Its late completion must not send a mark, must not
 *      disarm a watchdog it does not own, and must not arm a hangup for
 *      audio that never played.
 *
 *   Audio from a cancelled epoch is also DROPPED rather than forwarded.
 *   The scheduling bridge forwarded it (harmlessly, since it only
 *   overcounted a derived timer), but forwarding audio after a `clear` is
 *   the one thing a `clear` exists to prevent.
 *
 * TRANSPORT NOTE — TERMINATE_CALL. Every Remix agent's hangup tool ends the
 * call by POSTing to `api.openai.com/v1/realtime/calls/{id}/hangup`. That is
 * an OpenAI SIP mechanism: on this transport there is no OpenAI call, so the
 * tool cannot end anything and the caller would sit in silence until the
 * max-duration ceiling. The runtime supplies the hangup instead.
 *
 * But ONLY the hangup. The tool still RUNS, because the checks in front of
 * that POST are not about transport at all and replacing the tool wholesale
 * threw them away (Codex review, PR #227):
 *
 *   - `pcpAgent` refuses to terminate until the disposition is durably
 *     recorded. Bypassed, a PCP caller is disconnected before their request
 *     is saved.
 *   - `noIvrAgent` refuses while an escalation is in flight, after a live
 *     call on 2026-08-04 where the model escalated and called terminate one
 *     second later. Its own comment: "the same second would hang up on
 *     sudden vision loss."
 *
 * So the tool is dispatched like any other, and the hangup follows only if
 * the agent's own guards let it through. Distinguishing the two is generic,
 * not per-agent: in every one of these tools the business checks run BEFORE
 * the fetch, so a result carrying an HTTP `status` (or `success: true`) is
 * proof the guards passed and the transport step was reached. A refusal
 * never carries one — it returns early with an `error`, and that result is
 * handed back to the model verbatim, wording included, so the agent can act
 * on its own refusal.
 *
 * Where the signal is ambiguous the bridge does NOT hang up. The asymmetry
 * decides it: a call held open too long ends at the caller's hangup or the
 * ceiling, and is recorded either way; a call hung up too early loses the
 * patient's request, which is the exact thing those guards exist to
 * prevent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BoundAgent } from "./agentBinding";
import { CallTranscriptLog } from "./transcriptLog";
import { CallUsage, usageSummaryMarker, type UsageTotals } from "./tokenUsage";
import type { TwilioInboundFrame, TwilioOutboundFrame } from "./twilioFrames";
import {
  ToolCallCeiling,
  ceilingRefusal,
  ceilingMarker,
  type CeilingLimits,
} from "./toolCeiling";

/**
 * A tool's answer as an object the wire layer can spread into its payload.
 *
 * `dispatch` hands back the exact JSON string a tool produced, because that
 * is the honest thing for a layer that must not interpret tool results. The
 * wire layer spreads its output into `{ok, …}`. Spreading a STRING yields
 * `{"0":"{","1":"\"", …}`, so the seam between them is here: parse once,
 * and give a non-object answer a name rather than scattering it into
 * characters. Never throws — an unanswered tool call stalls the turn.
 */
export function decodeToolOutput(output: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    // A tool that answered in plain prose still answered.
    return { result: output };
  }
}

/**
 * Did the agent's own terminate tool let the hangup through?
 *
 * Generic across every agent rather than a per-agent error list, because
 * they all share one shape: the business checks return EARLY with an
 * `error` and nothing else, and only after passing them does the tool
 * attempt its HTTP call. So an HTTP `status` in the result — or an outright
 * `success` — proves the guards ran and allowed it. `missing_api_key` and
 * `missing_call_id` are counted the same way for the same structural
 * reason: in every one of these tools they are checked AFTER the business
 * guards, so reaching them is itself proof the guards passed. (Without
 * that, a deployment with no OpenAI key could never hang up at all.)
 *
 * Anything else — an unrecognised error, a shape we do not understand — is
 * treated as a refusal and the call stays up. See the asymmetry argument in
 * the module doc: too long is recoverable, too early is not.
 */
export function guardsAllowedTermination(output: Record<string, unknown>): boolean {
  if (output.success === true) return true;
  if (typeof output.status === "number") return true;
  const error = output.error;
  return error === "missing_api_key" || error === "missing_call_id";
}

/** μ-law 8kHz mono = 8000 bytes/second = 8 bytes per millisecond. */
export const MULAW_BYTES_PER_MS = 8;

/** Fixed grace added ON TOP of the derived playback duration for the
 * final-mark fallback — covers network + Twilio buffering jitter. The
 * variable part of the timeout is always derived from the audio length. */
export const FINAL_MARK_GRACE_MS = 2_000;

/** Bounded ceiling on any single call — a connected session that stops
 * conversing must never run forever (sibling-repo zombie-call lesson:
 * 1,138 calls / ~143 hours of billed silence before a ceiling existed). */
export const DEFAULT_MAX_CALL_MS = 10 * 60 * 1000;

/** Dead-air watchdog. Armed only while the AGENT owes the caller sound —
 * from an utterance starting until its audio completes, and from the
 * caller finishing a turn until the agent speaks — fed by every audio
 * delta, and disarmed the moment the caller is talking. A session that
 * stalls mid-utterance, or never responds to an answer, becomes a
 * controlled failure instead of minutes of billed silence under the
 * max-duration ceiling. A caller quietly thinking about a question can
 * never trip it: the clock is cleared when the agent's audio finished
 * cleanly, and disarmed while the caller speaks. */
export const DEFAULT_DEAD_AIR_MS = 30_000;

/**
 * Extra headroom the dead-air window gets while a tool dispatch is in
 * flight. The filing tools' own timeouts are 30 seconds — the exact span
 * of this watchdog — and the window is armed before dispatch() reaches
 * the tool, so an EQUAL window always loses the race to a tool that
 * legitimately exhausts its own timeout: teardown fired first, and the
 * tool's controlled timeout result was discarded by the ended check
 * instead of reaching the model (Codex, PR #227 round 21). Half the
 * budget again covers the dispatch overhead around the tool's own clock
 * plus its settle — a longer bound, still never immunity.
 */
export const TOOL_DISPATCH_GRACE_MS = 15_000;

/** The hangup tools shipped by the Remix agents. Intercepted rather than
 * dispatched — see the TRANSPORT NOTE in the module doc. */
export const DEFAULT_END_CALL_TOOL_NAMES = ["terminate_call", "end_call"];

/**
 * TRANSPORT NOTE — SET_SPOKEN_LANGUAGE. Same shape as the hangup above, and
 * for the same reason: the tool decides, the transport acts.
 *
 * `set_spoken_language` (src/tools/languageTools.ts) normalises and validates
 * the language the model heard, and returns the tag. Retargeting Grok's STT
 * `language_hint` means a `session.update` on the live wire, which only the
 * session can send — so the tool runs like any other and the switch follows
 * ONLY on a result that says it should. A refusal (already speaking it,
 * unreadable) reaches the model verbatim and nothing is sent.
 *
 * Operator instruction 2026-09-03: follow the caller's language mid-stream.
 */
export const DEFAULT_LANGUAGE_TOOL_NAMES = ["set_spoken_language"];

/**
 * DEPLOY MARKER AND LIVE COUNTER. Prints only when a call actually changes
 * language, so its first appearance proves the build carrying this is live and
 * its rate afterwards is how often callers were being ignored before. Carries
 * the language tag and nothing else — never a transcript line, never a name.
 */
export function languageMarker(language: string): string {
  return `[LANGUAGE] switching this call to ${language} — following the caller`;
}

/** The normalized tag a successful set_spoken_language result carries, or
 * undefined when the tool refused. Deliberately strict — an empty or
 * non-string language must not reach the wire as a hint. */
export function languageToSwitchTo(output: Record<string, unknown>): string | undefined {
  if (output.success !== true) return undefined;
  const lang = output.language;
  return typeof lang === "string" && lang.trim() ? lang.trim() : undefined;
}

/** How the call ended. One value per call, recorded exactly once. */
export type CallOutcome =
  | "completed"
  | "caller_hangup"
  | "agent_ended"
  | "transferred"
  | "provider_failure"
  | "dead_air"
  | "max_duration";

/** One tool call as the runtime saw it. Names and outcomes only — the
 * runtime never interprets a tool's arguments or its result. */
export interface ToolEvent {
  name: string;
  /**
   * The tool RAN. Not that it worked.
   *
   * `dispatch` answers ok whenever it reached the handler at all — a
   * `missing([...])` refusal comes back `ok: true` with no `error`, because
   * nothing went wrong at the transport. Anything asking "did this tool do
   * its job?" must read `succeeded`, not this.
   */
  ok: boolean;
  /**
   * The tool DID ITS JOB — `ok`, and its own envelope did not say
   * `success: false`.
   *
   * Required, not optional, and that is the point: `alreadyFiledByTool` in
   * the request sweep was written against `ok` and would therefore have read
   * every REFUSED `file_*_ticket` as a filed ticket — skipping the sweep on
   * exactly the calls it exists to recover. Making this a field every
   * producer must fill is what stops the next reader making the same
   * assumption. The bridge already computed the value for the tool ceiling;
   * it just was not written down.
   */
  succeeded: boolean;
  /**
   * The tool reported an EXISTING open ticket for this caller.
   *
   * Only `check_open_tickets` sets it, and it exists because `succeeded` is
   * not the same question. That tool answers `success: true` with
   * `has_open_tickets: false` when the caller has nothing open — so
   * "it ran and worked" says nothing about whether anything was found, and
   * every queue prompt tells the agent to run it before filing. Reading
   * `succeeded` alone would therefore treat an ORDINARY call as a status
   * check (Codex, PR #268 round 2).
   */
  foundOpenTicket?: boolean;
  /** ms from call start, so a timeline is readable without timestamps. */
  atMs: number;
  error?: string;
}

/** Everything the finished call leaves behind for the durable record. */
export interface VoiceCallRecord {
  callSid: string;
  streamSid: string;
  /** The lane slug that answered — 'optical', 'surgery', 'no-ivr', … */
  slug: string;
  callerPhone: string;
  dialedNumber: string;
  outcome: CallOutcome;
  /** CALLER/AGENT lines in spoken order — '' when nothing was said. */
  transcript: string;
  toolEvents: ToolEvent[];
  /** Agent utterances that completed. The turn count for telemetry. */
  agentTurns: number;
  /** Barge-ins: times the caller talked over the agent. */
  interruptions: number;
  startedAtMs: number;
  endedAtMs: number;
  /** When the caller's first transcribed word arrived, or undefined when
   * nothing was ever transcribed. The cutover gate is measured on the delay
   * from call start to this, so it has to be a real timestamp rather than
   * inferred from the transcript's shape. */
  firstTranscriptAtMs?: number;
  /** When the last transcript of any kind arrived. */
  lastTranscriptAtMs?: number;
  /**
   * What the provider reported this call cost, or undefined when it reported
   * nothing. Undefined leaves the columns NULL on purpose — see CallUsage.
   */
  usage?: UsageTotals;
}

export interface VoiceCallContext {
  callSid: string;
  streamSid: string;
  slug: string;
  /** Context ONLY. A phone match is a candidate to confirm, never an
   * identity — the agent's own prompt owns what is done with it. */
  callerPhone: string;
  dialedNumber: string;
}

/** The narrow session surface the bridge needs. GrokVoiceSession satisfies
 * it structurally; tests substitute a fake with no wire at all. */
export interface BridgeSession {
  appendAudio(base64Audio: string): void;
  cancelResponse(): void;
  sendToolResult(callId: string, ok: boolean, output: Record<string, unknown>): void;
  requestResponse(): void;
  /** A response-gated turn whose content the RUNTIME decides and the model
   * phrases — the guardrail correction is exactly that case. Not used for
   * ordinary turns, where the agent's own prompt must drive. */
  speakNatural(instructions: string): void;
  /** Speak EXACTLY these words. The greeting uses this rather than
   * speakNatural so the practice's opening line is identical on every call
   * and the model has no opportunity to reword it. */
  /** Scripted, verbatim. `interruptible: false` protects a line the caller
   * must hear whole — see `greetingLocked`. */
  speak(text: string, opts?: { interruptible?: boolean }): void;
  close(): void;
  getResponseEpoch(): number;
  /** Retarget the provider's STT `language_hint` mid-call and tell the model
   * to follow the caller. See the TRANSPORT NOTE — SET_SPOKEN_LANGUAGE. */
  setSpokenLanguage(language: string): void;
}

export interface TwilioSocket {
  sendFrame(frame: TwilioOutboundFrame): void;
  close(): void;
}

export interface VoiceCallBridgeDeps {
  context: VoiceCallContext;
  agent: BoundAgent;
  /**
   * The line the practice answers with, spoken verbatim before the agent
   * takes its first turn. Optional: a lane without one simply opens on the
   * agent's own words, which is what every lane did before this existed.
   */
  greeting?: string | null;
  twilio: TwilioSocket;
  /** The bridge hands its handlers to this factory and the factory returns
   * the session wired to them — the only way the two can be constructed
   * against each other without a settable-handlers mutation seam. */
  createSession: (handlers: BridgeSessionHandlers) => BridgeSession;
  /** Invoked EXACTLY ONCE per call, however many teardown triggers race. */
  onOutcome: (outcome: CallOutcome) => void;
  /** Persist the finished call — fire-and-forget at teardown, with every
   * failure swallowed: losing the record must never break teardown, and
   * teardown never throws. Absent in offline tests. */
  persistCallRecord?: (record: VoiceCallRecord) => Promise<void>;
  /** Hangup tools to intercept. Defaults to DEFAULT_END_CALL_TOOL_NAMES. */
  endCallToolNames?: string[];
  /** Overridable for the same reason endCallToolNames is: tests name their
   * own, and a lane could rename the tool without touching the bridge. */
  languageToolNames?: string[];
  /** The lane's configured spoken language, so a switch to the language the
   * session already uses is refused rather than sent. */
  initialLanguage?: string;
  /**
   * What a tripped output guardrail does. "enforce" (default) cuts the line
   * mid-air and requests a safe replacement — the same interruption the SDK
   * performs on the SIP path, so moving a lane here does not weaken its
   * rules. "log" records the trip and lets the audio play, for measuring a
   * rule's false-positive rate before trusting it with live interruptions.
   */
  guardrailMode?: "enforce" | "log";
  maxCallMs?: number;
  deadAirMs?: number;
  /**
   * When the call actually began — the moment the stream was claimed.
   *
   * The bridge is constructed several steps later: after the bounded
   * pre-context lookup, the agent factory's own lookups, and the call-row
   * insert. Twilio is streaming and billing throughout all of it, so
   * starting the clock at construction understates every duration and every
   * tool offset by seconds, and manufactures duration mismatches on short
   * calls (Codex review, PR #227). Defaults to now for direct construction.
   */
  startedAtMs?: number;
  /** Injectable timers for tests. Defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Override the repeated-failure ceiling. Tests use it to reach the limits
   * without a hundred iterations; production uses the defaults.
   */
  toolCeiling?: Partial<CeilingLimits>;
}

/** Exactly the GrokVoiceSessionHandlers subset the bridge supplies. Kept
 * structural so the bridge does not import the session class. */
export interface BridgeSessionHandlers {
  onToolCall: (callId: string, name: string, args: Record<string, unknown>) => void;
  onConfigured: () => void;
  onAudioDelta: (base64Audio: string) => void;
  onAgentTranscriptDelta: (delta: string) => void;
  onAudioDone: (transcript?: string) => void;
  onSpeechStarted: () => void;
  onSpeechStopped: () => void;
  /** The carrying response finished delivering everything — the boundary
   * the post-tool follow-up waits for. */
  /** Carries the raw event: usage rides on it (tokenUsage.ts). */
  onResponseDone: (raw?: unknown) => void;
  onCallerTranscript: (transcript: string, itemId?: string) => void;
  onError: (err: Error) => void;
  onClosed: () => void;
}

export class VoiceCallBridge {
  private readonly session: BridgeSession;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly endCallToolNames: Set<string>;
  private readonly languageToolNames: Set<string>;
  /** What the session is currently listening in. Seeded from the lane's
   * configured language and moved only by a successful switch, so the tool
   * can refuse a no-op instead of the wire carrying a redundant update. */
  private spokenLanguage: string;

  private ended = false;
  private endedOutcome: CallOutcome | null = null;

  private utteranceSeq = 0;
  /** The utterance currently being spoken, opened by its first audio or
   * transcript delta and closed by its completion. `epoch` is what makes a
   * cancelled utterance's late completion recognisable (module doc). */
  private current: { seq: number; epoch: number; text: string; bytes: number } | null = null;
  /** The response epoch a barge-in cancelled. Everything that epoch emits
   * afterwards is stale: dropped, not forwarded, not recorded. */
  private cancelledEpoch: number | null = null;

  private assistantAudioPlaying = false;
  /**
   * The opening has been spoken — the handshake ran. Guards
   * `handleSessionConfigured` against a second entry; see there for why.
   */
  private opened = false;
  /**
   * The greeting is playing and may not be cut short.
   *
   * `interruptible: false` on the force_message tells the PROVIDER not to
   * stop generating, but the truncation this guards against is ours: on
   * caller speech the bridge cancels the response and sends Twilio a
   * `clear`, which discards whatever of the greeting is still buffered.
   * The provider flag cannot prevent that; only this can.
   *
   * Held until Twilio ECHOES the greeting's mark, because a mark echo is
   * the only ground truth that audio actually reached the caller —
   * `onAudioDone` means the provider finished sending, with the tail still
   * buffered. Unlocking there would leave the last seconds of the greeting
   * discardable, which on the after-hours line is exactly where the
   * recording disclosure sits.
   *
   * Bounded by its OWN timer. An earlier version of this comment claimed
   * the dead-air watchdog covered the window; it does not, and the order in
   * `handleAudioDone` is why — the clock is cleared BEFORE the mark is even
   * sent. A greeting whose mark never echoed would have held the lock for
   * the rest of the call, so no later agent response could be interrupted
   * either. The fallback is derived the way `armFinalMark` derives its own:
   * the audio's playback time plus a grace. Raised by Codex on #240.
   */
  private greetingLocked = false;
  /** The mark whose echo releases `greetingLocked`. */
  private greetingMarkName: string | null = null;
  /** Releases the lock if that echo never arrives. */
  private greetingLockTimer: unknown = null;
  /**
   * The caller finished a turn while the greeting still had the lock.
   *
   * A response is owed to them, but the greeting's remaining audio deltas
   * re-arm the watchdog as `"utterance"`, and its completion then clears the
   * clock — losing the debt. Before the lock existed this could not happen:
   * the caller's speech cancelled the greeting outright, so no further
   * deltas followed. The lock created the window, so the lock carries the
   * debt across it. Raised by Codex on #240.
   */
  private responseOwedFromGreeting = false;
  /**
   * The greeting's scripted text, from the handshake until the utterance
   * carrying it starts playing — or until it is clear no such utterance is
   * coming.
   *
   * `deps.greeting` is spoken verbatim, so unlike every other line on this
   * runtime its words are known before the model produces them, which is what
   * lets its transcript line be written at playback instead of at its mark
   * echo (module doc).
   *
   * Two things retire it unwritten, and between them they cover every way the
   * greeting can fail to reach the caller: `greetingEpoch` refuses audio from
   * any LATER response, and `handleAudioDone` drops it at a completion of its
   * own response — the one case an epoch cannot see, since a second utterance
   * of one response carries the same epoch. A greeting whose audio never
   * played gets no line, the rule every other utterance follows.
   */
  private greetingPending: string | null = null;
  /**
   * The response epoch whose audio may write the greeting's line.
   *
   * `handleSessionConfigured` speaks the greeting and requests nothing else,
   * and at the handshake `speak()` sends immediately rather than queueing —
   * so the greeting IS the first response created after it, one past the
   * epoch observed there. Comparing against that is the only way to tell the
   * greeting's own audio from a later response's.
   *
   * A response superseded before emitting a SINGLE delta never opens an
   * utterance at all, so nothing downstream has a handle on it. Without this
   * the replacement's first audio would write the greeting's line and then
   * swallow its own transcript at that line's mark, because the line is
   * flagged as already committed (Codex, #243).
   */
  private greetingEpoch: number | null = null;
  /**
   * The greeting's line once written: which utterance it belongs to, where it
   * sits in the record, and the exact words it claims.
   *
   * Kept because that line is committed BEFORE its playback is proved. If the
   * audio is then cut — a hangup mid-greeting, a guardrail, a barge-in once
   * the lock has lapsed — the record must say the caller heard only part of
   * it, and the only honest way to say so is to amend the line already there.
   */
  private greetingLine: { seq: number; index: number; text: string } | null = null;
  /** The most recent mark sent, and whether media went out AFTER it: an
   * OLDER mark's echo must not clear the playback flag, or the next
   * barge-in early-returns and the caller is talked over. */
  private latestMarkName: string | null = null;
  private mediaSinceLastMark = false;
  /** Lines whose audio the session finished SENDING but Twilio has not yet
   * confirmed PLAYING. Marks are the only playback ground truth: committing
   * at completion claims full delivery for audio still buffered when a
   * barge-in or hangup cuts it. Committed on echo; downgraded to
   * "[interrupted]" when the window is cut.
   *
   * The greeting rides here too — the mark still gates the lock's release,
   * the interruption accounting and the hangup path — but its line is
   * already in the record, so its entry carries that line's index and the
   * echo writes nothing. Only the transcript write moved. */
  private readonly awaitingMark: Array<{
    name: string;
    text: string;
    /** Set when this line was written at playback start. The echo must not
     * write it again, and a cut amends it rather than appending. */
    committedIndex?: number;
  }> = [];

  private finalMarkName: string | null = null;
  private finalFallbackTimer: unknown = null;
  /** Exposed for tests: the derived fallback duration that was armed. */
  public lastArmedFinalFallbackMs: number | null = null;
  /** The agent's hangup tool ran and its guards allowed the termination. */
  private endRequested = false;
  /** Audio bytes of the most recently COMPLETED utterance, kept so a mark
   * already in flight can be adopted as the final one with a fallback
   * derived from its own audio rather than a constant. */
  private lastCompletedUtteranceBytes = 0;

  private maxCallTimer: unknown = null;
  private deadAirTimer: unknown = null;
  /** WHY the watchdog is armed. 'utterance' = an utterance's audio is
   * owed; 'response' = the caller finished a turn and a new response is
   * owed. The distinction exists for barge-in: a cancelled utterance's
   * completion can arrive after the caller's next turn armed the response
   * clock, and an unconditional clear would disarm exactly the protection
   * that sequence needs. */
  private deadAirCause: "utterance" | "response" | null = null;

  private readonly transcriptLog = new CallTranscriptLog();
  /** What the provider says this call cost. See tokenUsage.ts. */
  private readonly usage = new CallUsage();
  private readonly toolEvents: ToolEvent[] = [];
  private readonly ceiling: ToolCallCeiling;
  private agentTurns = 0;
  private interruptions = 0;
  private readonly startedAtMs: number;
  /** First and last transcript arrival, for the latency columns. */
  private firstTranscriptAtMs: number | undefined;
  private lastTranscriptAtMs: number | undefined;

  constructor(private readonly deps: VoiceCallBridgeDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.endCallToolNames = new Set(deps.endCallToolNames ?? DEFAULT_END_CALL_TOOL_NAMES);
    this.languageToolNames = new Set(deps.languageToolNames ?? DEFAULT_LANGUAGE_TOOL_NAMES);
    this.spokenLanguage = deps.initialLanguage ?? "en";
    this.startedAtMs = deps.startedAtMs ?? Date.now();
    this.ceiling = new ToolCallCeiling(deps.toolCeiling ?? {});

    this.session = deps.createSession({
      onToolCall: (callId, name, args) => this.handleToolCall(callId, name, args),
      onConfigured: () => this.handleSessionConfigured(),
      onAudioDelta: (b64) => this.handleAudioDelta(b64),
      onAgentTranscriptDelta: (delta) => this.handleAgentTranscriptDelta(delta),
      onAudioDone: (transcript) => this.handleAudioDone(transcript),
      onSpeechStarted: () => this.handleCallerSpeechStarted(),
      onSpeechStopped: () => this.handleCallerSpeechStopped(),
      onResponseDone: (raw) => this.handleResponseDone(raw),
      onCallerTranscript: (text, itemId) => {
        if (this.ended) return;
        this.noteTranscript("caller");
        // Straight through, greeting or no greeting. Where the greeting's own
        // line sits was settled when its audio started, so there is no
        // "before or after it" left to decide here — which is the point:
        // deciding it here, and at four other points, was PR #241.
        this.transcriptLog.callerCompleted(text, itemId);
      },
      onError: (err) => this.handleSessionFailure(err),
      onClosed: () => this.handleSessionClosed(),
    });

    this.maxCallTimer = this.setTimer(
      () => this.teardown("max_duration"),
      deps.maxCallMs ?? DEFAULT_MAX_CALL_MS,
    );
  }

  getSession(): BridgeSession {
    return this.session;
  }

  getOutcome(): CallOutcome | null {
    return this.endedOutcome;
  }

  /** The spoken record so far — CALLER/AGENT lines in order. */
  getTranscript(): string {
    return this.transcriptLog.render();
  }

  // ── Twilio -> bridge ─────────────────────────────────────────────────

  handleTwilioFrame(frame: TwilioInboundFrame): void {
    if (this.ended) return;
    switch (frame.event) {
      case "media":
        // Caller audio: base64 μ-law pass-through, no transcoding.
        this.session.appendAudio(frame.media.payload);
        break;
      case "mark":
        this.handleTwilioMark(frame.mark.name);
        break;
      case "stop":
        this.teardown("caller_hangup");
        break;
      case "connected":
      case "start":
        // connected precedes start; start is consumed by the server glue
        // that constructs this bridge. Nothing to do here.
        break;
    }
  }

  /** Raw WebSocket close without a stop frame = the caller (or Twilio) is
   * gone. Same single teardown path. */
  handleSocketClosed(): void {
    this.teardown("caller_hangup");
  }

  /** For the server glue: a session that failed before/while connecting
   * (the Grok WebSocket never opened) uses the same failure path as a
   * mid-call error. */
  failSession(err: Error): void {
    this.handleSessionFailure(err);
  }

  private handleTwilioMark(name: string): void {
    // A mark echo is ground truth that everything sent BEFORE it played to
    // the caller: commit the held AGENT lines up to and including it.
    if (this.awaitingMark.some((e) => e.name === name)) {
      while (this.awaitingMark.length > 0) {
        const head = this.awaitingMark.shift()!;
        // The greeting's line went in when its audio started; this echo only
        // confirms what it already claimed. Writing it again would record the
        // opening twice — but this IS where its delivery is proved, and a
        // caller turn open across it has to be told so.
        if (head.committedIndex === undefined) this.transcriptLog.agentLine(head.text);
        else this.transcriptLog.agentLineDelivered();
        if (head.name === name) break;
      }
    }
    // Playback is over only if this echo is the NEWEST mark sent and no
    // media went out after it — an older utterance's echo while a queued
    // one is playing proves nothing about current audio.
    if (name === this.latestMarkName && !this.mediaSinceLastMark) {
      this.assistantAudioPlaying = false;
    }
    // The greeting reached the caller in full. Barge-in works normally from
    // here — this protects the opening, not the conversation.
    if (this.greetingMarkName !== null && name === this.greetingMarkName) {
      this.releaseGreetingLock();
    }
    if (this.finalMarkName !== null && name === this.finalMarkName) {
      // Ground truth: the final utterance actually played to the caller.
      this.teardown(this.endRequested ? "agent_ended" : "completed");
    }
  }

  // ── Session -> bridge ────────────────────────────────────────────────

  private handleSessionConfigured(): void {
    if (this.ended) return;
    // ONCE PER CALL. The practice picks up the phone one time.
    //
    // `GrokVoiceSession` now only reports the handshake here, so this is
    // defence in depth rather than the fix — but it is the invariant stated
    // where the opening actually happens, so no future caller of
    // `onConfigured` can reopen a call that is already underway. The harm is
    // not only the repeated words: the greeting is spoken LOCKED
    // (`greetingLocked`), so a replay also takes barge-in away from a caller
    // mid-conversation. Measured on Spanish callers, 2026-09-04 — see
    // `handshakeConfirmed` in grokSession.ts.
    if (this.opened) return;
    this.opened = true;
    // The handshake landed. Two turns, in this order.
    //
    // First the practice's own greeting, spoken VERBATIM — scripted, not
    // generated, so it is the same sentence on every call and the model
    // cannot reword it. It comes from the agent's config rather than from
    // here, so there is still one source of truth for what the practice
    // says when it picks up the phone.
    //
    // This is not a nicety. The SIP path plays that greeting before the
    // agent takes over, and the queue prompts are written on that premise —
    // optical's says "Your greeting has already played. Do NOT greet again.
    // Go straight to confirming: Am I speaking with …?". This runtime never
    // played it, so the agent obeyed an instruction whose premise was false
    // and every call opened cold on the caller's own name (operator, three
    // calls, 2026-08-31). The greeting also covers the caller-ID lookup:
    // it is speaking while the 1.5s pre-context window runs.
    // and then NOTHING. The greeting ends in a question the CALLER answers —
    // "How can I help you today?", or for a recognised caller the confirm
    // that personalisation swapped in — so the next voice is theirs.
    //
    // Requesting an agent turn here was wrong twice over: it speaks a second
    // opening over a question already asked, and on PCP it takes a turn
    // before the call purpose its greeting just requested has been given
    // (Codex review, PR #240). The watchdog concern that argued for owing a
    // turn goes with it: after a delivered line with nothing owed, clearing
    // the window is correct, and a caller taking their time to answer must
    // never trip it.
    //
    // Only a lane with NO greeting needs the agent to open, and it gets the
    // turn it always got.
    if (this.deps.greeting) {
      // A greeting that ASKS something leaves the caller holding the turn,
      // which is the whole reason nothing is requested after it. A
      // DECLARATIVE one ("Thank you for calling Azul Vision.") leaves nobody
      // holding it: the agent is not speaking and the caller was not asked,
      // and once this line completes the watchdog clears because a delivered
      // line owes nothing — so the call sits silent to the ten-minute
      // ceiling. `welcome_greeting` is free text and the admin field does
      // not require a question, so this is a greeting someone can simply
      // save. The agent takes its own turn after one (Codex, #240).
      if (!/\?\s*$/.test(this.deps.greeting.trim())) {
        this.followUpOwed = true;
      }
      // LOCKED. A caller who says "hello" over the opening must not be able
      // to truncate it: on the after-hours line it carries the closed-office
      // notice, the 911 direction and the recording disclosure, and
      // noIvrAgent requires the whole thing before anything else. The
      // operator asked for the same thing in the same words — the greeting
      // should not be barge-able (2026-08-31).
      this.greetingLocked = true;
      // Its words are known NOW, so the record does not have to wait for
      // them — see `greetingPending` and the module doc. Read the epoch
      // BEFORE speaking: the response `speak()` is about to create is the
      // next one, and only its audio may write that line.
      this.greetingPending = this.deps.greeting;
      this.greetingEpoch = this.session.getResponseEpoch() + 1;
      this.session.speak(this.deps.greeting, { interruptible: false });
    } else {
      // No per-response instructions: `response.instructions` OVERRIDES the
      // session's, so words here would switch the agent's prompt and the
      // knowledge pack off for the caller's first sentence.
      this.session.requestResponse();
    }
    this.armDeadAir("response");
  }

  /** Opens the current utterance on its first event, whichever arrives
   * first — audio delta or transcript delta. Returns null when the event
   * belongs to a cancelled epoch (stale). */
  private openOrGetCurrent(): { seq: number; epoch: number; text: string; bytes: number } | null {
    const epoch = this.session.getResponseEpoch();
    if (this.cancelledEpoch !== null && epoch === this.cancelledEpoch) return null;
    if (this.current && this.current.epoch !== epoch) {
      // The previous utterance never completed (it was superseded without
      // a completion event). Its audio is finished either way; drop it
      // rather than attributing its words to this response.
      //
      // If it was the GREETING and it had already started playing, its line
      // is in the record claiming the whole thing was spoken when only the
      // beginning was — and no mark was ever sent, so `awaitingMark` holds
      // nothing to correct it with. This is the last moment the line can be
      // reached at all: `recordCutLine` matches the greeting by utterance
      // sequence, and the sequence is about to move on (Codex, #243).
      const startedGreeting = this.greetingLine;
      if (startedGreeting !== null && this.current.seq === startedGreeting.seq) {
        this.transcriptLog.amendAgentLine(
          startedGreeting.index,
          `${startedGreeting.text} [interrupted]`,
        );
        // Words the caller heard, committed — so the tail is measured from
        // here, the same invariant the barge-in and teardown cuts follow.
        this.noteTranscript("agent");
      }
      this.current = null;
    }
    if (!this.current) {
      this.utteranceSeq += 1;
      this.current = { seq: this.utteranceSeq, epoch, text: "", bytes: 0 };
    }
    return this.current;
  }

  private handleAgentTranscriptDelta(delta: string): void {
    if (this.ended) return;
    const current = this.openOrGetCurrent();
    if (!current) return;
    current.text += delta;
    // The agent has begun answering, so what is owed is now THIS
    // utterance's audio, not a response. The scheduling bridge set this at
    // render time, when the renderer handed it the line; here the wire is
    // the first sign a response exists at all.
    this.armDeadAir("utterance");
    this.checkGuardrails(current);
  }

  /** Utterance sequences already checked-and-tripped, so one violation is
   * one interruption, not one per remaining delta. */
  private trippedUtterances = new Set<number>();

  /**
   * Run the agent's own output guardrails over the text spoken so far.
   *
   * Checked on every delta rather than at completion because audio streams
   * AHEAD of this transcript: by the time the line is complete the caller
   * has heard most of it. Each check sees the full accumulated text, so a
   * violation that spans deltas is still caught.
   *
   * The verdict is asynchronous, so it is epoch-guarded like everything
   * else on this wire: a verdict landing after a barge-in already cancelled
   * the response — or after the next response began — must not cancel the
   * NEW line. Same stale-utterance discipline as audio and completions.
   */
  private checkGuardrails(current: { seq: number; epoch: number; text: string }): void {
    const guardrails = this.deps.agent.guardrails;
    if (guardrails.length === 0 || this.trippedUtterances.has(current.seq)) return;
    const { seq, epoch, text } = current;
    for (const guardrail of guardrails) {
      void guardrail
        .execute({ agentOutput: text })
        .then((verdict) => {
          if (!verdict.tripwireTriggered || this.ended) return;
          if (this.trippedUtterances.has(seq)) return;
          if (this.current?.seq !== seq || this.current.epoch !== epoch) return;
          this.trippedUtterances.add(seq);
          this.handleGuardrailTrip(guardrail);
        })
        .catch((err) => {
          // A broken guardrail must not take the call down — but a rule that
          // stopped running is a silent safety regression, so it is loud.
          console.error(
            `[bridge] output guardrail '${guardrail.name}' threw and is NOT protecting this call:`,
            err,
          );
        });
    }
  }

  /**
   * The line the caller was hearing violated one of the agent's own safety
   * rules. In "enforce" (the default), this is the SIP path's behaviour on
   * this transport: cut it mid-air and ask the agent for a safe replacement.
   *
   * The cut reuses the barge-in's exact bookkeeping — cancel the epoch,
   * clear Twilio's buffer, mark what was partially heard — because it IS an
   * interruption; the only difference is who interrupted.
   */
  private handleGuardrailTrip(guardrail: { name: string; policyHint?: string }): void {
    if (this.deps.guardrailMode === "log") {
      console.error(`[bridge] GUARDRAIL TRIPPED (log mode, audio not cut): ${guardrail.name}`);
      return;
    }
    console.error(`[bridge] GUARDRAIL TRIPPED, cutting the line: ${guardrail.name}`);
    // Same invariant as the barge-in and teardown cuts: words the caller
    // heard, committed, move the clock. The cancelled response's own
    // completion cannot — it is discarded by the epoch check — and if the
    // safe replacement never completes either (the caller hangs up on it),
    // nothing else in the call would stamp a transcript that plainly has
    // caller-audible agent words in it (Codex, #243).
    if (this.recordCutLine(`[cut by guardrail: ${guardrail.name}]`)) {
      this.noteTranscript("agent");
    }
    this.awaitingMark.length = 0;
    this.cancelledEpoch = this.session.getResponseEpoch();
    this.current = null;
    // A goodbye that violated a safety rule did not finish either: the armed
    // hangup is revoked exactly as a barge-in revokes it, and the agent must
    // re-request termination through its own guards.
    this.endRequested = false;
    this.finalMarkName = null;
    if (this.finalFallbackTimer !== null) {
      this.clearTimer(this.finalFallbackTimer);
      this.finalFallbackTimer = null;
    }
    this.session.cancelResponse();
    this.sendFrame({ event: "clear", streamSid: this.deps.context.streamSid });
    this.assistantAudioPlaying = false;
    // The replacement turn. Content decided here, phrasing left to the
    // model — the case speakNatural exists for. The rule's own policyHint
    // is the instruction, so each guardrail corrects in its own terms.
    this.session.speakNatural(
      `Your previous reply was stopped by a safety rule: ${
        guardrail.policyHint ?? guardrail.name
      } Give the caller a brief, safe replacement for what you were saying — do not repeat the ` +
        `removed statement or mention that anything was blocked; offer to take their request ` +
        `for the care team instead.`,
    );
  }

  private handleAudioDelta(base64Audio: string): void {
    if (this.ended) return;
    const current = this.openOrGetCurrent();
    // Stale audio from a cancelled response is DROPPED, not forwarded:
    // Twilio was just told to `clear`, and pushing the tail of the
    // cancelled line straight back is the one thing `clear` exists to
    // prevent.
    if (!current) return;
    current.bytes += Buffer.from(base64Audio, "base64").length;
    // PLAYBACK BEGINS HERE — and for the greeting that is when its line is
    // written. Its words are scripted, so none of them is waiting on the
    // wire, and this is the one moment that sits in its true place among the
    // caller's events. Every other line still waits for its mark echo,
    // because for every other line the mark is the only proof the words were
    // spoken at all.
    if (this.greetingPending !== null) {
      if (current.epoch !== this.greetingEpoch) {
        // A response past the greeting's is speaking, so the greeting's own
        // never reached audio: drop it rather than let these bytes write its
        // line and swallow the words they are actually carrying.
        this.greetingPending = null;
      } else {
        const text = this.greetingPending;
        this.greetingPending = null;
        // `openingLine`, not `agentLine`: it must not close a caller turn
        // that is still open, or a cumulative re-emission of that same turn
        // appends on the far side of the greeting instead of refining in
        // place.
        this.greetingLine = {
          seq: current.seq,
          index: this.transcriptLog.openingLine(text),
          text,
        };
      }
    }
    this.assistantAudioPlaying = true;
    this.mediaSinceLastMark = true;
    // Audio is flowing — the stall clock restarts from every delta, and
    // what is owed is this utterance (see handleAgentTranscriptDelta).
    // Stale deltas cannot reach this line: openOrGetCurrent() returns null
    // for a cancelled epoch, which is what keeps a stale delta from
    // downgrading a response-owed clock its stale completion could clear.
    this.armDeadAir("utterance");
    this.sendFrame({
      event: "media",
      streamSid: this.deps.context.streamSid,
      media: { payload: base64Audio },
    });
  }

  /**
   * Stamp the transcript-timing window the latency and tail graders read.
   *
   * FIRST is caller-only: `first_transcript_delay_ms` is defined as "ms from
   * session start to first CALLER transcript" (shared/schema.ts), and on
   * every normal call the agent's greeting completes before the caller says
   * a word — so letting the greeting open the window scores greeting
   * generation instead of caller transcription, and the documented cutover
   * metric reads systematically optimistic (Codex, PR #227 round 11).
   * LAST is any-kind: the tail window measures silence after the final
   * words, whoever spoke them.
   */
  private noteTranscript(source: "caller" | "agent"): void {
    const now = Date.now();
    if (source === "caller" && this.firstTranscriptAtMs === undefined) {
      this.firstTranscriptAtMs = now;
    }
    this.lastTranscriptAtMs = now;
  }

  private handleAudioDone(transcript?: string): void {
    if (this.ended) return;
    const epoch = this.session.getResponseEpoch();
    if (this.cancelledEpoch !== null && epoch === this.cancelledEpoch) {
      // A cancelled utterance's late completion delivers nothing that was
      // owed: it must not disarm a watchdog it does not own, not send a
      // mark, not arm a hangup for audio that never played — and not stamp
      // the transcript clock. The interrupted line was stamped when the
      // barge-in committed it; stamping here would move `lastTranscriptAtMs`
      // forward with no words delivered, understating the tail
      // (Codex review, PR #227 round 14).
      return;
    }
    this.noteTranscript("agent");
    // A greeting whose response completed without ever sending audio never
    // reached the caller, so it gets no line — the rule every utterance
    // follows. Before the `!done` return, because a completion that opened no
    // utterance at all has to drop it too.
    //
    // `greetingEpoch` does NOT cover this one: a second utterance of the SAME
    // response carries the same epoch, so without this clear the greeting's
    // line would be written over the words that utterance actually carried.
    // Every other way a pending greeting can go stale ends up on a later
    // response, which the epoch bind refuses on its own.
    this.greetingPending = null;
    const done = this.current;
    this.current = null;
    if (!done) return;
    this.agentTurns += 1;
    this.lastCompletedUtteranceBytes = done.bytes;

    // The utterance is delivered: the agent owes nothing for IT, so a
    // caller taking their time over the question can never trip the
    // watchdog. A response-owed clock is different and stays armed: it
    // means the caller answered while this line's tail was still landing,
    // so a NEW reply is owed and this completion did not deliver it.
    // And a spoken line is not the whole TURN when the same response also
    // carried a tool whose dispatch is still running — the follow-up owes
    // the caller words. Clearing here left that hung tool bounded only by
    // the ten-minute ceiling whenever its function-call event arrived
    // before the line's completion (Codex review, PR #227 round 19).
    if (this.deadAirCause !== "response") {
      if (this.pendingToolCalls > 0) this.armDeadAir("response", TOOL_DISPATCH_GRACE_MS);
      // A caller who answered while the greeting still held the lock is owed
      // words, and this completion did not deliver them — the greeting was
      // already speaking when they spoke.
      else if (this.responseOwedFromGreeting) this.armDeadAir("response");
      else this.clearDeadAir();
    }
    this.responseOwedFromGreeting = false;

    // Prefer the wire's own completed transcript over the accumulated
    // deltas: it is the authoritative text and it arrives whole.
    const text = (transcript ?? done.text).trim();
    const markName = `utt-${done.seq}`;
    // The greeting's own mark: its echo is what releases the lock.
    if (this.greetingLocked && this.greetingMarkName === null) {
      this.greetingMarkName = markName;
      // Nothing else covers the wait for this echo, so it covers itself.
      this.greetingLockTimer = this.setTimer(() => {
        console.warn(
          `[bridge] greeting mark ${markName} never echoed on ` +
            `${this.deps.context.callSid} — releasing the barge-in lock`,
        );
        this.releaseGreetingLock();
      }, Math.ceil(done.bytes / MULAW_BYTES_PER_MS) + FINAL_MARK_GRACE_MS);
    }
    // The greeting's line is already in the record. Its entry still rides in
    // `awaitingMark` — the mark gates the lock, the interruption accounting
    // and the hangup path — but it carries that line's index, so the echo
    // writes nothing and a cut amends instead of appending. Its own scripted
    // words, not the wire's transcript: the committed line already says them,
    // and an amendment has to agree with what it is amending.
    const greetingDone = this.greetingLine?.seq === done.seq ? this.greetingLine : null;
    if (greetingDone) {
      this.awaitingMark.push({
        name: markName,
        text: greetingDone.text,
        committedIndex: greetingDone.index,
      });
    } else if (text) {
      this.awaitingMark.push({ name: markName, text });
    }
    this.latestMarkName = markName;
    this.mediaSinceLastMark = false;
    this.sendFrame({
      event: "mark",
      streamSid: this.deps.context.streamSid,
      mark: { name: markName },
    });

    if (this.endRequested) {
      // The agent said its goodbye and asked to hang up. Hang up ONLY when
      // this line's mark echoes back, with a bounded fallback derived from
      // the audio actually sent (bytes/8 = playback ms) plus jitter grace.
      this.armFinalMark(markName, done.bytes);
    }
  }

  /**
   * The agent's guards allowed the termination: end the call, but only once
   * the caller has actually heard the goodbye.
   *
   * Three states, because the tool result comes back asynchronously and the
   * goodbye's audio may be anywhere by then:
   *   - an utterance is still streaming -> its completion arms the hangup;
   *   - an utterance finished and its mark is already in flight -> ADOPT
   *     that mark. It was not final when it was sent (endRequested was
   *     still false), so without this its echo would only clear playback
   *     and the call would run to the ceiling — the ordering that is in
   *     fact the normal one (Codex review, PR #227);
   *   - nothing playing and nothing outstanding -> mint a fresh mark, so
   *     the hangup still waits for a Twilio round trip rather than cutting
   *     the line mid-buffer.
   */
  private requestHangup(): void {
    if (this.ended || this.endRequested) return;
    this.endRequested = true;
    if (this.current !== null) return; // its completion will arm the mark
    const outstanding = this.awaitingMark[this.awaitingMark.length - 1];
    if (outstanding) {
      this.armFinalMark(outstanding.name, this.lastCompletedUtteranceBytes);
      return;
    }
    this.utteranceSeq += 1;
    const markName = `utt-${this.utteranceSeq}`;
    this.latestMarkName = markName;
    this.mediaSinceLastMark = false;
    this.sendFrame({
      event: "mark",
      streamSid: this.deps.context.streamSid,
      mark: { name: markName },
    });
    this.armFinalMark(markName, 0);
  }

  private armFinalMark(markName: string, bytes: number): void {
    this.finalMarkName = markName;
    const derivedPlaybackMs = Math.ceil(bytes / MULAW_BYTES_PER_MS);
    const fallbackMs = derivedPlaybackMs + FINAL_MARK_GRACE_MS;
    this.lastArmedFinalFallbackMs = fallbackMs;
    if (this.finalFallbackTimer !== null) this.clearTimer(this.finalFallbackTimer);
    this.finalFallbackTimer = this.setTimer(() => this.teardown("agent_ended"), fallbackMs);
  }

  /** One way out of the lock, whether the echo arrived or the wait expired.
   * Barge-in is all it governs: the transcript has nothing waiting on it. */
  private releaseGreetingLock(): void {
    this.greetingLocked = false;
    this.greetingMarkName = null;
    if (this.greetingLockTimer !== null) {
      this.clearTimer(this.greetingLockTimer);
      this.greetingLockTimer = null;
    }
  }

  /**
   * Record the words of a line the call cut short — by a barge-in, by a
   * guardrail, or by ending underneath it.
   *
   * Twilio plays serially, so the line that was actually playing is the
   * OLDEST un-echoed finished one if there is any; everything queued behind
   * it never reached the caller and is dropped. Failing that, it is the line
   * still streaming.
   *
   * The GREETING is the case that needs care, because its line is already in
   * the record — written when its audio started. Appending here would report
   * the opening twice, whole and then cut, so its committed line is AMENDED
   * to carry the suffix. That is also what leaves a caller who hangs up
   * mid-greeting a record saying the greeting was cut short, rather than one
   * claiming they heard all of it.
   *
   * Returns whether anything was recorded, so callers stamp the transcript
   * clock only when words actually reached it.
   */
  private recordCutLine(suffix: string): boolean {
    const heardPartial = this.awaitingMark.shift();
    if (heardPartial) {
      if (heardPartial.committedIndex !== undefined) {
        this.transcriptLog.amendAgentLine(
          heardPartial.committedIndex,
          `${heardPartial.text} ${suffix}`,
        );
      } else {
        this.transcriptLog.agentLine(`${heardPartial.text} ${suffix}`);
      }
      return true;
    }
    const greeting = this.greetingLine;
    if (greeting !== null && this.current?.seq === greeting.seq) {
      // Still streaming when it was cut. Amended with its own scripted words
      // rather than the partial deltas — the line already says them.
      this.transcriptLog.amendAgentLine(greeting.index, `${greeting.text} ${suffix}`);
      return true;
    }
    if (this.current && this.current.text.trim()) {
      this.transcriptLog.agentLine(`${this.current.text.trim()} ${suffix}`);
      return true;
    }
    return false;
  }

  private handleCallerSpeechStarted(): void {
    if (this.ended) return;
    // The caller is talking: not dead air, and any open caller line in the
    // record crossed a speech boundary (transcript correlation only). Applied
    // HERE, as it arrives. Buffering these alongside the caller lines they
    // separate and replaying them later is what collapsed two utterances into
    // one, because `callerBoundary()` only marks a line that is already open
    // and a replay puts them back in the wrong order (PR #241).
    this.clearDeadAir();
    this.transcriptLog.callerBoundary();
    // The greeting is not barge-able WHILE IT PLAYS — that is what the lock
    // is for. Their audio keeps arriving and is still transcribed, so nothing
    // about the caller is dropped and the provider answers them once the line
    // finishes; but the cancel and the `clear` below do not run, and the rest
    // of the opening plays. Not counted as an interruption either: nothing
    // was interrupted.
    //
    // The lock is tested EXPLICITLY here. It used to be implied by a
    // buffering branch that returned before this point, and that branch
    // answered its question ONCE per utterance and never re-answered it — so
    // a caller who spoke before the greeting started and again over it
    // arrived with the answer already "no" and fell straight through to the
    // barge-in below, cutting the very line the lock exists to protect.
    //
    // PR #242 fixed that same defect inside the buffering, by splitting the
    // two questions it had conflated: where this utterance's line belongs
    // (answered once, carried) versus whether the greeting may be interrupted
    // (answered live). Here only the second question survives — the first has
    // no answer to carry, because a line written when its audio starts is
    // already in its place. This guard is #242's `greetingPlaying` return and
    // its `assistantAudioPlaying` return, which together are exactly this.
    if (this.greetingLocked || !this.assistantAudioPlaying) return;
    this.interruptions += 1;
    // BARGE-IN: both signals, always together (see module doc). The line
    // that was PLAYING was partially heard, and the record says so —
    // `recordCutLine` decides which line that was.
    //
    // Committing words the caller heard stamps the transcript clock: a
    // cancelled response may never emit its transcript.done, so this is the
    // interrupted line's ONLY chance to move `lastTranscriptAtMs`. Without it
    // the tail is measured from an older line — or, for a greeting
    // interrupted before anything completed, not at all (Codex review,
    // PR #227 round 13).
    if (this.recordCutLine("[interrupted]")) this.noteTranscript("agent");
    this.awaitingMark.length = 0;
    // Everything this response emits from here is stale.
    this.cancelledEpoch = this.session.getResponseEpoch();
    this.current = null;
    // A barge-in also revokes a hangup armed for a line the caller just
    // talked over: the goodbye did not finish, so the call has not ended.
    // `endRequested` is cleared WITH the mark and the timer — leaving it
    // set let the answer to the caller's new question arm its own mark as
    // final and hang up on them, which is the opposite of what a barge-in
    // means (Codex review, PR #227). A fresh termination has to be
    // requested by the agent again, through its own guards.
    this.endRequested = false;
    this.finalMarkName = null;
    if (this.finalFallbackTimer !== null) {
      this.clearTimer(this.finalFallbackTimer);
      this.finalFallbackTimer = null;
    }
    this.session.cancelResponse();
    this.sendFrame({ event: "clear", streamSid: this.deps.context.streamSid });
    this.assistantAudioPlaying = false;
  }

  private handleCallerSpeechStopped(): void {
    if (this.ended) return;
    // The caller finished a turn: a response is now OWED. If neither an
    // utterance nor its audio arrives before the ceiling, the call is
    // stuck in dead air — tear down rather than bill silence.
    this.armDeadAir("response");
    // Under the greeting lock this arm does not survive: the greeting is
    // still playing, its deltas re-arm the clock as `"utterance"`, and its
    // completion clears it. Remember the debt so completion can re-arm it.
    //
    // Only while the greeting is STILL BEING DELIVERED — `greetingMarkName`
    // is set at its completion, so a null one is the honest test for that.
    // The lock outlives the audio, waiting on Twilio's echo, and a caller who
    // answers in THAT window is answering a greeting already finished: the
    // next completion is the agent's real reply to them. Arming a debt then
    // would hang up on a caller who pauses after hearing it, as `dead_air`.
    // Raised by Codex on #240.
    if (this.greetingLocked && this.greetingMarkName === null) {
      this.responseOwedFromGreeting = true;
    }
  }

  // ── Tool dispatch ────────────────────────────────────────────────────

  /**
   * Tool calls of the current turn still awaiting their output, and whether
   * a follow-up response is owed once the last one lands. One response can
   * carry SEVERAL function calls, and a `requestResponse()` per tool did
   * two wrong things: each extra queued request released another
   * unsolicited reply after the first one's `response.done`, and a slower
   * tool could see the first reply begin before its output existed
   * (Codex review, PR #227 round 14).
   *
   * Counting settled dispatches is NOT enough on its own: a fast first
   * tool can settle before the wire has even delivered the next
   * function-call event of the SAME response, so the count touches zero
   * twice and queues two follow-ups again (Codex review, PR #227
   * round 17). The response boundary is the only proof everything the
   * response carries has arrived — so the follow-up also waits for the
   * carrying response's `response.done`. Responses are serial on this
   * wire, so one flag and one counter only ever describe one turn.
   */
  private pendingToolCalls = 0;
  private followUpOwed = false;
  private awaitingToolResponseDone = false;

  /** One tool answered. Records what is owed; the request itself fires
   * only when the LAST outstanding tool has settled AND the carrying
   * response has finished delivering. */
  private toolCallSettled(owesFollowUp: boolean): void {
    this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
    if (owesFollowUp) this.followUpOwed = true;
    this.maybeRequestFollowUp();
  }

  /** The wire finished delivering a response — every function call it
   * carried has been observed by now. */
  private handleResponseDone(raw?: unknown): void {
    // Usage is accumulated even on a torn-down call: the response that just
    // finished was still billed, and a teardown racing the last response
    // should not silently drop its tokens.
    if (raw !== undefined) this.usage.add(raw);
    if (this.ended) return;
    this.awaitingToolResponseDone = false;
    this.maybeRequestFollowUp();
  }

  private maybeRequestFollowUp(): void {
    if (this.pendingToolCalls !== 0 || !this.followUpOwed) return;
    if (this.awaitingToolResponseDone) return;
    this.followUpOwed = false;
    // A termination the guards allowed is already arming the hangup on
    // the goodbye's mark; a follow-up would speak over that gate.
    if (!this.endRequested) {
      this.session.requestResponse();
      // The follow-up is a response owed ANEW: it gets its own window,
      // not whatever remains of the tool's (Codex review, PR #227
      // round 19).
      this.armDeadAir("response");
    }
  }

  private handleToolCall(callId: string, name: string, args: Record<string, unknown>): void {
    if (this.ended) return;
    // Function-call events precede their response's `response.done` on the
    // ordered wire, so at this moment the carrying response is still
    // delivering — arm the boundary wait for this turn.
    this.awaitingToolResponseDone = true;
    this.pendingToolCalls += 1;
    // This event IS the model acting on the caller's turn, and the
    // dispatch it starts has a budget of its own — the queue filing tools
    // are allowed up to 30 seconds, the same span as this watchdog. A
    // clock still ticking from speech-stop bills the tool's whole budget
    // against the model's and tears down a valid dispatch as dead_air
    // moments before its result lands (Codex review, PR #227 round 19).
    // Restart the window with headroom past the tool's own timeout
    // (round 21): a fresh budget for the tool, never immunity.
    this.armDeadAir("response", TOOL_DISPATCH_GRACE_MS);
    // Every tool call must be answered or the turn stalls forever, so the
    // dispatch that answers it is the one that never throws (agentBinding).
    // The hangup tool goes through this same path: its guards are the
    // agent's, and only its transport step is ours (see the TRANSPORT NOTE).
    void (async () => {
      /**
       * THE REPEATED-FAILURE CEILING (toolCeiling.ts).
       *
       * On 2026-09-03 the optical lane's fourteenth runtime call spent 144
       * seconds calling `file_optical_ticket` 110 times, refused every time
       * for the same missing date of birth, and the caller hung up with no
       * ticket. The tool was right to refuse; the model was wrong to keep
       * asking instead of speaking. Across 2,972 old-core queue calls in the
       * fourteen days to that date, the highest tool-call count on any call
       * is 24 — so this is a property of the model on THIS transport, which
       * is why the ceiling is here and not in the tools.
       *
       * A stopped dispatch is still ANSWERED — with the tool's own last
       * refusal wording — because an unanswered tool call stalls the turn
       * forever, which is worse than the loop.
       */
      const verdict = this.ceiling.begin(name, args);
      if (!verdict.allow) {
        console.warn(ceilingMarker(name, verdict));
        this.toolEvents.push({
          name,
          ok: false,
          succeeded: false,
          atMs: Date.now() - this.startedAtMs,
          error: `ceiling:${verdict.reason}`,
        });
        if (this.ended) return;
        this.session.sendToolResult(
          callId,
          false,
          ceilingRefusal(name, verdict.reason, this.ceiling.lastFailureOutput(name)),
        );
        // The agent still owes the caller words, so this settles like any
        // other refusal rather than short-circuiting the follow-up.
        this.toolCallSettled(true);
        return;
      }

      const result = await this.deps.agent.dispatch(name, args);
      const output = decodeToolOutput(result.output);
      /**
       * `dispatch` answers `ok: true` whenever the tool RAN — a
       * `missing([...])` refusal comes back ok. The ceiling counts what the
       * tool actually decided, so the predicate has to read `success` out of
       * the tool's own envelope, not the transport's.
       *
       * Computed BEFORE the event is recorded, so the record carries the same
       * answer the ceiling acts on. It used to be worked out below the push,
       * which is how the durable record ended up with only the transport's
       * `ok` on it and the sweep ended up reading the wrong field.
       */
      const toolSucceeded =
        result.ok &&
        !(
          output !== null &&
          typeof output === "object" &&
          (output as Record<string, unknown>).success === false
        );
      // What the tool's own envelope said it FOUND, as distinct from whether
      // it worked. Read generically off the declared field rather than by
      // special-casing a tool name here, so the transport keeps knowing
      // nothing about any particular tool's meaning.
      const declaredOpenTicket =
        output !== null && typeof output === "object"
          ? (output as Record<string, unknown>).has_open_tickets
          : undefined;
      this.toolEvents.push({
        name,
        ok: result.ok,
        succeeded: toolSucceeded,
        ...(typeof declaredOpenTicket === "boolean"
          ? { foundOpenTicket: declaredOpenTicket }
          : {}),
        atMs: Date.now() - this.startedAtMs,
        ...(result.error ? { error: result.error } : {}),
      });
      this.ceiling.settle(name, args, toolSucceeded, output);
      if (this.ended) return;
      this.session.sendToolResult(callId, result.ok, output);
      /**
       * THE TRANSPORT STEP FOR A LANGUAGE SWITCH.
       *
       * Ordered exactly like the hangup below: the result reaches the model
       * FIRST, then the wire changes. Reversed, a `session.update` could land
       * between the model's call and its answer, and the turn that follows
       * would be generated against a config the model has not been told about.
       *
       * `settled` is left to the shared path at the bottom — the agent still
       * owes the caller words, now in their language, and this is not a
       * terminal tool.
       */
      if (this.languageToolNames.has(name)) {
        const next = languageToSwitchTo(output);
        // A switch to the language already in use is dropped here rather than
        // in the tool: this is the only place that knows what the session is
        // actually listening in right now.
        if (next && next !== this.spokenLanguage) {
          this.spokenLanguage = next;
          this.session.setSpokenLanguage(next);
          console.info(languageMarker(next));
        }
      }
      if (this.endCallToolNames.has(name)) {
        if (guardsAllowedTermination(output)) {
          this.requestHangup();
          this.toolCallSettled(false);
        } else {
          // A refusal still needs the agent to speak — its `say` wording
          // is in the result.
          this.toolCallSettled(true);
        }
        return;
      }
      // Submitting a function_call_output adds a conversation item; it does
      // NOT make the model speak. Without a follow-up the caller hears
      // nothing after a ticket is filed until the dead-air watchdog
      // disconnects them (Codex review, PR #227). requestResponse is
      // response-gated, so it is released only once the tool-carrying
      // response finishes — and coalesced above, so it fires once however
      // many tools that response carried.
      this.toolCallSettled(true);
    })().catch(() => {
      // dispatch() is documented never to throw; if it somehow does, the
      // call still gets an answer rather than a stalled turn — and the
      // ceiling's reservation is released, or one throw would wedge this
      // tool shut for the rest of the call.
      this.ceiling.settle(name, args, false, undefined);
      if (!this.ended) {
        this.session.sendToolResult(callId, false, { error: "dispatch_failed" });
        this.toolCallSettled(true);
      }
    });
  }

  // ── Dead-air watchdog ────────────────────────────────────────────────

  private armDeadAir(cause: "utterance" | "response", extraMs = 0): void {
    this.clearDeadAir();
    this.deadAirCause = cause;
    this.deadAirTimer = this.setTimer(
      () => this.teardown("dead_air"),
      // transferWaitExtraMs joins EVERY window while a transfer attempt is
      // open — see noteTransferWaitStarting for why it is a state and not
      // a one-shot extension.
      (this.deps.deadAirMs ?? DEFAULT_DEAD_AIR_MS) + extraMs + this.transferWaitExtraMs,
    );
  }

  private clearDeadAir(): void {
    this.deadAirCause = null;
    if (this.deadAirTimer !== null) {
      this.clearTimer(this.deadAirTimer);
      this.deadAirTimer = null;
    }
  }

  private handleSessionFailure(err: Error): void {
    if (this.ended) return;
    void err;
    this.teardown("provider_failure");
  }

  private handleSessionClosed(): void {
    // Expected after our own teardown closed the session; anything else is
    // an unexpected mid-call death.
    if (this.ended) return;
    this.teardown("provider_failure");
  }

  private sendFrame(frame: TwilioOutboundFrame): void {
    try {
      this.deps.twilio.sendFrame(frame);
    } catch {
      // A socket that died mid-frame is a hangup, handled by its own close
      // path — never an exception thrown up through an event handler.
    }
  }

  // ── Exactly-once teardown ────────────────────────────────────────────

  /**
   * A warm transfer is about to replace the caller's stream. The redirect
   * ENDS the Media Stream, and the resulting stop/close was recorded as
   * caller_hangup — every successful runtime handoff persisted as an
   * ordinary hangup with transferred_to_human=false, corrupting exactly
   * the transfer metrics the migration is judged by (Codex, PR #230
   * round 2). Armed BEFORE the redirect, because the close can race the
   * redirect's own resolution; cleared when a redirect fails, so a later
   * genuine hangup is not mislabeled.
   */
  noteTransferStarting(): void {
    this.transferInFlight = true;
  }

  noteTransferFailed(): void {
    this.transferInFlight = false;
  }

  private transferInFlight = false;

  /**
   * A transfer attempt began: the handoff runs as an ordinary tool
   * dispatch, but its legitimate span is the office dial plus the
   * briefing-and-keypress wait — the accept window, far past any tool
   * budget. On the tool budget alone the watchdog tore the caller down as
   * dead_air at 45 seconds and onOutcome abandoned the office leg, so a
   * staffer who answered near the 40-45s ring limit was disconnected
   * mid-briefing before they could press a key (Codex, PR #230 round 3).
   *
   * The added budget is a STATE, not a one-shot re-arm: the spoken
   * "connecting you now" line completes mid-wait and its utterance-done
   * re-arms the watchdog (as does a caller remark), which would shrink
   * the window straight back to the tool budget. While the wait is open,
   * every armed window carries the wait's span on top of its own.
   */
  noteTransferWaitStarting(expectedWaitMs: number): void {
    if (this.ended) return;
    this.transferWaitExtraMs = expectedWaitMs;
    this.armDeadAir("response", TOOL_DISPATCH_GRACE_MS);
  }

  /** The attempt settled — accepted, failed, or abandoned. Normal budgets
   * apply again, and the tool window re-arms fresh: the agent owes the
   * caller its next words (the failure line, or nothing if the redirect
   * is already tearing the stream down). */
  noteTransferWaitSettled(): void {
    if (this.ended) return;
    this.transferWaitExtraMs = 0;
    this.armDeadAir("response", TOOL_DISPATCH_GRACE_MS);
  }

  private transferWaitExtraMs = 0;

  private teardown(outcome: CallOutcome): void {
    if (this.ended) return;
    this.ended = true;
    // Whatever close event won the race — Twilio's stop frame, the socket
    // closing, the provider session dying as the stream ends — the caller
    // was moved to a human on purpose. That is the outcome.
    if (this.transferInFlight) outcome = "transferred";

    if (this.finalFallbackTimer !== null) {
      this.clearTimer(this.finalFallbackTimer);
      this.finalFallbackTimer = null;
    }
    if (this.maxCallTimer !== null) {
      this.clearTimer(this.maxCallTimer);
      this.maxCallTimer = null;
    }
    this.clearDeadAir();

    // A line still mid-delivery when the call ends was partially heard —
    // record it as interrupted; lines that never produced audio the caller
    // could hear are dropped.
    if (this.assistantAudioPlaying) {
      // Same invariant as the barge-in commit: audio was playing right up to
      // the end of the call, so the tail from these words is ~zero —
      // truthful, where measuring from an older line overstates dead air and
      // a caller who hung up mid-greeting got no tail at all.
      if (this.recordCutLine("[interrupted]")) this.noteTranscript("agent");
    }
    this.awaitingMark.length = 0;
    // Nothing to flush. The caller's lines were written as they arrived and
    // the greeting's was written when it started playing, so the record is
    // already in order. Teardown used to replay a buffer of held caller
    // lines here, and placing that replay correctly against a greeting still
    // in flight took three attempts (PR #241).
    this.transcriptLog.close();

    // Record the outcome BEFORE closing the socket: closing is what
    // advances Twilio past the stream.
    this.endedOutcome = outcome;
    this.deps.onOutcome(outcome);

    const usageAtTeardown = this.usage.result();
    if (usageAtTeardown) console.info(usageSummaryMarker(usageAtTeardown));

    if (this.deps.persistCallRecord) {
      const persist = this.deps.persistCallRecord;
      const record: VoiceCallRecord = {
        callSid: this.deps.context.callSid,
        streamSid: this.deps.context.streamSid,
        slug: this.deps.context.slug,
        callerPhone: this.deps.context.callerPhone,
        dialedNumber: this.deps.context.dialedNumber,
        outcome,
        transcript: this.transcriptLog.render(),
        toolEvents: [...this.toolEvents],
        ...(usageAtTeardown ? { usage: usageAtTeardown } : {}),
        agentTurns: this.agentTurns,
        interruptions: this.interruptions,
        startedAtMs: this.startedAtMs,
        endedAtMs: Date.now(),
        // Independently: a greeting-only call has no caller-latency number
        // (first stays absent, never fabricated) but its tail window — from
        // the last words spoken to session end — is still real.
        ...(this.firstTranscriptAtMs !== undefined
          ? { firstTranscriptAtMs: this.firstTranscriptAtMs }
          : {}),
        ...(this.lastTranscriptAtMs !== undefined
          ? { lastTranscriptAtMs: this.lastTranscriptAtMs }
          : {}),
      };
      void persist(record).catch(() => {
        // Losing the record must never break teardown.
      });
    }

    try {
      this.session.close();
    } catch {
      // Session/transport may already be dead — teardown never throws.
    }
    try {
      this.deps.twilio.close();
    } catch {
      // Socket may already be closed — teardown never throws.
    }
  }
}
