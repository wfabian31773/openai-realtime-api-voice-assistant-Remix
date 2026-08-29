/**
 * server/scheduling-core/providers/grok/wireTypes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * xAI/Grok realtime-voice wire protocol — event vocabulary and shapes.
 * Fully contained in this directory: nothing under server/scheduling-core/
 * outside providers/grok/ (schedulingCore.ts, ports.ts, any adapter) may
 * import from this file.
 *
 * PORTED VERBATIM from the sibling ticketing-app repo's production-proven
 * Grok wire layer (lib/answering-service/providers/grok/wire.ts there),
 * which was transcribed from the official xAI docs (docs.x.ai, Speech to
 * Speech / Voice Agent) and has carried real patient calls. The previous
 * revision of this file guessed the vocabulary from this repo's OpenAI
 * realtime conventions instead — nearly every event it sent or expected
 * differed from what Grok actually speaks (a `session.update` shape Grok
 * rejects, an invented `response.tool_call` event that never arrives, an
 * invented `tool_result` client event, a `session.close` handshake that
 * does not exist), which is why live DRS calls died at session setup.
 *
 * The API is OpenAI-Realtime-compatible with Grok extensions
 * (force_message, reasoning.effort, resumption, replace). Two shapes to
 * never "fix" toward OpenAI: turn_detection lives at the SESSION level
 * (not under audio.input), and scripted speech is a `force_message`
 * conversation item — the model is bypassed and the text is spoken
 * verbatim.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Tool / function-calling definitions ─────────────────────────────────

/** OpenAI-style function tool, plus the wire-required `type` discriminant. */
export interface GrokToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ── Session configuration (client -> server) ────────────────────────────

/** The `session` payload of a session.update — the exact shape the wire
 * accepts. Model is NOT in here: it rides the connection URL query. */
export interface GrokSessionConfig {
  voice: string;
  instructions: string;
  audio: {
    input: {
      format: { type: string; rate: number };
      transcription?: { language_hint?: string; keyterms?: string[] };
      transport: "json" | "binary";
    };
    output: {
      format: { type: string; rate: number };
      transport: "json" | "binary";
      speed?: number;
    };
  };
  turn_detection: {
    type: "server_vad";
    threshold?: number;
    silence_duration_ms?: number;
    prefix_padding_ms?: number;
    idle_timeout_ms?: number | null;
  } | null;
  reasoning: { effort: "high" | "none" };
  tools: GrokToolDefinition[];
}

// ── Client -> server events ──────────────────────────────────────────────

/** Scripted speech: the model is bypassed and the text is spoken VERBATIM.
 * The ONLY channel authorized speech reaches Grok's mouth through in this
 * design — the provider sends the renderer's exact output text as a
 * force_message, never lets Grok free-generate a reply. */
export interface GrokForceMessage {
  type: "conversation.item.create";
  item: {
    type: "force_message";
    role: "assistant";
    interruptible: boolean;
    content: Array<{ type: "output_text"; text: string }>;
  };
}

/** Answer to a function call. Every function call the provider receives
 * MUST be answered with one of these, or the conversation stalls. */
export interface GrokFunctionCallOutput {
  type: "conversation.item.create";
  item: {
    type: "function_call_output";
    call_id: string;
    output: string; // JSON string
  };
}

/** Constrained natural speech for languages without scripted medical
 * copy. `instructions` carry the authorized English/Spanish meaning as
 * facts — Grok may speak that meaning in the caller's language but must
 * not invent clinics, times, or addresses. Scripted EN/ES still uses
 * force_message. */
export interface GrokResponseCreate {
  type: "response.create";
  response?: { instructions?: string };
}

export type GrokClientEvent =
  | { type: "session.update"; session: GrokSessionConfig }
  | { type: "input_audio_buffer.append"; audio: string }
  | GrokForceMessage
  | GrokFunctionCallOutput
  | GrokResponseCreate
  /** Barge-in: cancel the model's in-flight response. ONLY valid while a
   * response is actually open at the wire — cancelling one the provider
   * already finished (or a force_message, which is not a response) draws
   * a provider error that tears down a healthy call. GrokVoiceSession
   * gates this on its response.created/response.done tracking. */
  | { type: "response.cancel" };

// ── Server -> client events ──────────────────────────────────────────────

/** A completed model function call. THE tool-call event on the real wire —
 * `arguments` arrives as a JSON string, not a parsed object. */
export interface GrokToolCallEvent {
  type: "response.function_call_arguments.done";
  name: string;
  call_id: string;
  arguments: string; // JSON string
}

export type GrokServerEvent =
  | { type: "session.created"; conversation?: { id: string } }
  | { type: "session.updated" }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "conversation.item.input_audio_transcription.updated"; transcript?: string; item_id?: string }
  | { type: "conversation.item.input_audio_transcription.completed"; transcript?: string; item_id?: string }
  | { type: "response.created" }
  /** Assistant speech audio, streamed. `delta` is base64 μ-law 8kHz
   * (audio/pcmu — the output format buildSessionConfig declares), which is
   * byte-compatible with a Twilio Media Streams `media.payload`, so the
   * telephony bridge passes it through without transcoding. */
  | { type: "response.output_audio.delta"; delta: string }
  | { type: "response.output_audio_transcript.delta"; delta?: string }
  /** The spoken transcript of one agent utterance, complete. There is NO
   * `response.output_audio.done` on this wire — this event is the
   * per-utterance completion signal, and it fires for force_messages too
   * (proven in ticketing-app production), which is what makes the
   * bridge's mark-gated hangup work for scripted closing lines. */
  | { type: "response.output_audio_transcript.done"; transcript?: string }
  | GrokToolCallEvent
  | { type: "response.done" }
  | { type: "error"; error?: { type?: string; message?: string; code?: string } };
