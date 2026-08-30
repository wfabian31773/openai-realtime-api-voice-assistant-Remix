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
 *   1. AGENT TEXT COMES OFF THE WIRE. The scheduling bridge held each
 *      utterance's text from the moment it was queued. Here the only source
 *      is the transcript stream, so the bridge accumulates
 *      `response.output_audio_transcript.delta` and commits on
 *      `...done` — which also means a line cut off mid-sentence still has
 *      the words the caller actually heard, recorded as "[interrupted]".
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
import type { TwilioInboundFrame, TwilioOutboundFrame } from "./twilioFrames";

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

/** The hangup tools shipped by the Remix agents. Intercepted rather than
 * dispatched — see the TRANSPORT NOTE in the module doc. */
export const DEFAULT_END_CALL_TOOL_NAMES = ["terminate_call", "end_call"];

/** How the call ended. One value per call, recorded exactly once. */
export type CallOutcome =
  | "completed"
  | "caller_hangup"
  | "agent_ended"
  | "provider_failure"
  | "dead_air"
  | "max_duration";

/** One tool call as the runtime saw it. Names and outcomes only — the
 * runtime never interprets a tool's arguments or its result. */
export interface ToolEvent {
  name: string;
  ok: boolean;
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
  requestResponse(): void;
  close(): void;
  getResponseEpoch(): number;
}

export interface TwilioSocket {
  sendFrame(frame: TwilioOutboundFrame): void;
  close(): void;
}

export interface VoiceCallBridgeDeps {
  context: VoiceCallContext;
  agent: BoundAgent;
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
  onCallerTranscript: (transcript: string, itemId?: string) => void;
  onError: (err: Error) => void;
  onClosed: () => void;
}

export class VoiceCallBridge {
  private readonly session: BridgeSession;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly endCallToolNames: Set<string>;

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
  /** The most recent mark sent, and whether media went out AFTER it: an
   * OLDER mark's echo must not clear the playback flag, or the next
   * barge-in early-returns and the caller is talked over. */
  private latestMarkName: string | null = null;
  private mediaSinceLastMark = false;
  /** Lines whose audio the session finished SENDING but Twilio has not yet
   * confirmed PLAYING. Marks are the only playback ground truth: committing
   * at completion claims full delivery for audio still buffered when a
   * barge-in or hangup cuts it. Committed on echo; downgraded to
   * "[interrupted]" when the window is cut. */
  private readonly awaitingMark: Array<{ name: string; text: string }> = [];

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
  private readonly toolEvents: ToolEvent[] = [];
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
    this.startedAtMs = deps.startedAtMs ?? Date.now();

    this.session = deps.createSession({
      onToolCall: (callId, name, args) => this.handleToolCall(callId, name, args),
      onConfigured: () => this.handleSessionConfigured(),
      onAudioDelta: (b64) => this.handleAudioDelta(b64),
      onAgentTranscriptDelta: (delta) => this.handleAgentTranscriptDelta(delta),
      onAudioDone: (transcript) => this.handleAudioDone(transcript),
      onSpeechStarted: () => this.handleCallerSpeechStarted(),
      onSpeechStopped: () => this.handleCallerSpeechStopped(),
      onCallerTranscript: (text, itemId) => {
        if (this.ended) return;
        this.noteTranscript("caller");
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
        this.transcriptLog.agentLine(head.text);
        if (head.name === name) break;
      }
    }
    // Playback is over only if this echo is the NEWEST mark sent and no
    // media went out after it — an older utterance's echo while a queued
    // one is playing proves nothing about current audio.
    if (name === this.latestMarkName && !this.mediaSinceLastMark) {
      this.assistantAudioPlaying = false;
    }
    if (this.finalMarkName !== null && name === this.finalMarkName) {
      // Ground truth: the final utterance actually played to the caller.
      this.teardown(this.endRequested ? "agent_ended" : "completed");
    }
  }

  // ── Session -> bridge ────────────────────────────────────────────────

  private handleSessionConfigured(): void {
    if (this.ended) return;
    // The handshake landed. The agent's own prompt owns the opening line,
    // so the runtime asks for a turn and supplies no words at all: a
    // greeting written here would be a second source of truth for what the
    // practice says when it picks up the phone, and — because
    // `response.instructions` OVERRIDES the session's — it would also
    // switch the agent's prompt and the knowledge pack off for exactly the
    // sentence the caller hears first.
    this.session.requestResponse();
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
    this.noteTranscript("agent");
    const epoch = this.session.getResponseEpoch();
    if (this.cancelledEpoch !== null && epoch === this.cancelledEpoch) {
      // A cancelled utterance's late completion delivers nothing that was
      // owed: it must not disarm a watchdog it does not own, not send a
      // mark, and not arm a hangup for audio that never played.
      return;
    }
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
    if (this.deadAirCause !== "response") this.clearDeadAir();

    // Prefer the wire's own completed transcript over the accumulated
    // deltas: it is the authoritative text and it arrives whole.
    const text = (transcript ?? done.text).trim();
    const markName = `utt-${done.seq}`;
    if (text) this.awaitingMark.push({ name: markName, text });
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

  private handleCallerSpeechStarted(): void {
    if (this.ended) return;
    // The caller is talking: not dead air, and any open caller line in the
    // record crossed a speech boundary (transcript correlation only).
    this.clearDeadAir();
    this.transcriptLog.callerBoundary();
    if (!this.assistantAudioPlaying) return;
    this.interruptions += 1;
    // BARGE-IN: both signals, always together (see module doc). The line
    // that was PLAYING was partially heard, and the record says so —
    // Twilio plays serially, so it is the OLDEST un-echoed finished line
    // if one exists (its audio was still buffered when the clear discarded
    // it), else the line currently streaming. Everything behind it never
    // reached the caller and is dropped.
    const heardPartial = this.awaitingMark.shift();
    this.awaitingMark.length = 0;
    if (heardPartial) {
      this.transcriptLog.agentLine(`${heardPartial.text} [interrupted]`);
    } else if (this.current && this.current.text.trim()) {
      this.transcriptLog.agentLine(`${this.current.text.trim()} [interrupted]`);
    }
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
  }

  // ── Tool dispatch ────────────────────────────────────────────────────

  private handleToolCall(callId: string, name: string, args: Record<string, unknown>): void {
    if (this.ended) return;
    // Every tool call must be answered or the turn stalls forever, so the
    // dispatch that answers it is the one that never throws (agentBinding).
    // The hangup tool goes through this same path: its guards are the
    // agent's, and only its transport step is ours (see the TRANSPORT NOTE).
    void (async () => {
      const result = await this.deps.agent.dispatch(name, args);
      this.toolEvents.push({
        name,
        ok: result.ok,
        atMs: Date.now() - this.startedAtMs,
        ...(result.error ? { error: result.error } : {}),
      });
      if (this.ended) return;
      const output = decodeToolOutput(result.output);
      this.session.sendToolResult(callId, result.ok, output);
      if (this.endCallToolNames.has(name)) {
        if (guardsAllowedTermination(output)) this.requestHangup();
        // A refusal still needs the agent to speak — its `say` wording is
        // in the result — so fall through to the request below.
        else this.session.requestResponse();
        return;
      }
      // Submitting a function_call_output adds a conversation item; it does
      // NOT make the model speak. Without this the caller hears nothing
      // after a ticket is filed until the dead-air watchdog disconnects
      // them (Codex review, PR #227). requestResponse is response-gated, so
      // it is released only once the tool-carrying response finishes.
      this.session.requestResponse();
    })().catch(() => {
      // dispatch() is documented never to throw; if it somehow does, the
      // call still gets an answer rather than a stalled turn.
      if (!this.ended) {
        this.session.sendToolResult(callId, false, { error: "dispatch_failed" });
      }
    });
  }

  // ── Dead-air watchdog ────────────────────────────────────────────────

  private armDeadAir(cause: "utterance" | "response"): void {
    this.clearDeadAir();
    this.deadAirCause = cause;
    this.deadAirTimer = this.setTimer(
      () => this.teardown("dead_air"),
      this.deps.deadAirMs ?? DEFAULT_DEAD_AIR_MS,
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

  private teardown(outcome: CallOutcome): void {
    if (this.ended) return;
    this.ended = true;

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
    // could hear are dropped. The oldest un-echoed finished line is the
    // one that was playing, if any.
    if (this.assistantAudioPlaying) {
      const heardPartial = this.awaitingMark.shift();
      if (heardPartial) {
        this.transcriptLog.agentLine(`${heardPartial.text} [interrupted]`);
      } else if (this.current && this.current.text.trim()) {
        this.transcriptLog.agentLine(`${this.current.text.trim()} [interrupted]`);
      }
    }
    this.awaitingMark.length = 0;
    this.transcriptLog.close();

    // Record the outcome BEFORE closing the socket: closing is what
    // advances Twilio past the stream.
    this.endedOutcome = outcome;
    this.deps.onOutcome(outcome);

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
