/**
 * One interface, several ears.
 *
 * Operator directive 2026-08-09: the agent's logic is right and its input is
 * garbage — "Wayne Fabian" heard as "20 Fabian", "Latanoprost" as "Ja,
 * lieutenantpros", and words invented out of silence. So we stop guessing
 * which transcriber is best and run them side by side on the SAME phone call.
 *
 * Every engine gets the identical audio: Twilio's native 8 kHz G.711 μ-law,
 * unconverted. Both AssemblyAI and Deepgram take μ-law at 8 kHz directly, and
 * both document that upsampling phone audio makes accuracy WORSE — so nothing
 * here resamples anything.
 */

/** A finished caller utterance, from one engine. */
export interface TranscriptTurn {
  engine: string;
  text: string;
  /** False for interim/partial hypotheses. Only finals drive the agent. */
  isFinal: boolean;
  /** Engine-reported confidence, when it gives one. */
  confidence?: number;
}

export interface TranscriberOptions {
  /** Words this practice says that a general model gets wrong. */
  keyterms: string[];
  /** Plain-sentence description of the audio (both vendors take one). */
  prompt: string;
  /** Called for every turn the engine produces. Must never throw. */
  onTurn: (turn: TranscriptTurn) => void;
  /** Called when the engine detects the caller started speaking. */
  onSpeechStarted?: () => void;
  /** Called on a fatal engine error; the call continues without this engine. */
  onError?: (err: unknown) => void;
}

export interface Transcriber {
  readonly name: string;
  /** Open the connection. Resolves once it is ready for audio. */
  start(opts: TranscriberOptions): Promise<void>;
  /** Raw 8 kHz μ-law bytes, exactly as Twilio sent them. */
  sendAudio(mulaw: Buffer): void;
  /**
   * Tell the engine what the agent just SAID. AssemblyAI biases the next turn
   * on this and it is the single most relevant feature for our failure mode:
   * right after we ask "and the patient's date of birth?", the transcriber
   * should be expecting a date. Engines without the feature ignore it.
   */
  setAgentContext?(text: string): void;
  /** Close cleanly. An abandoned session bills until the provider's cap. */
  stop(): Promise<void>;
}
