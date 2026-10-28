import { ghostCallRefusal, hasCallerTranscript } from './ghostCallProtection';

// Give speech over the goodbye time to reach VAD/transcription before sending
// an irreversible SIP hangup. This window applies only to ghost calls.
const GHOST_HANGUP_GRACE_MS = 1_000;

export interface SipGhostHangupMetadata {
  getTranscript?: () => string;
  /** Subscribe for this attempt; notify immediately if the caller is speaking
   * or has already been transcribed. The returned function unsubscribes. */
  onCallerActivity?: (cancel: () => void) => () => void;
  pipeline?: 'runtime';
}

/** Per-session state, fed before the SIP route processes transcripts. VAD
 * cancels an attempt without permanently treating background noise as words. */
export class SipCallerActivity {
  private speaking = false;
  private awaitingTranscript = false;
  private heard = false;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (cancel: () => void): (() => void) => {
    this.listeners.add(cancel);
    if (this.speaking || this.awaitingTranscript || this.heard) cancel();
    return () => { this.listeners.delete(cancel); };
  };

  onTransportEvent(event: { type?: string; transcript?: string }): void {
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.speaking = false;
      this.awaitingTranscript = true;
      for (const cancel of this.listeners) cancel();
    } else if (event.type === 'input_audio_buffer.speech_started') {
      this.speaking = true;
      for (const cancel of this.listeners) cancel();
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.awaitingTranscript = false;
      if (event.transcript?.trim()) {
        this.heard = true;
        for (const cancel of this.listeners) cancel();
      }
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      this.awaitingTranscript = false;
    }
  }
}

interface HangupRefusal {
  success: false;
  error: string;
  fix?: string;
  say?: string;
}

type HangupResult = { response: Response; refusal?: never } | { refusal: HangupRefusal; response?: never };

/** Keep cancellation armed through dispatch. An HTTP abort cannot undo a
 * hangup already accepted upstream, so a late success must also be refused
 * instead of recording a deliberate conclusion based on stale permission. */
export async function requestSipHangup(
  reason: string,
  metadata: SipGhostHangupMetadata | undefined,
  dispatch: (signal?: AbortSignal) => Promise<Response>,
  beforeHangup?: () => HangupRefusal | null,
): Promise<HangupResult> {
  // The runtime bridge owns its own playback/cancellation window.
  if (reason !== 'ghost_call' || metadata?.pipeline === 'runtime') {
    return { response: await dispatch() };
  }

  const controller = new AbortController();
  const refusal = (): HangupRefusal | null =>
    ghostCallRefusal(reason, hasCallerTranscript(metadata?.getTranscript?.() ?? '')) ??
    (controller.signal.aborted ? {
      success: false,
      error: 'caller_speaking',
      fix: 'The caller may be speaking. Wait for their transcript and continue helping.',
    } : null);
  const unsubscribe = metadata?.onCallerActivity?.(() => controller.abort());
  try {
    let refused = refusal();
    if (refused) return { refusal: refused };

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, GHOST_HANGUP_GRACE_MS);
      controller.signal.addEventListener('abort', finish, { once: true });
    });
    refused = refusal() ?? beforeHangup?.() ?? null;
    if (refused) return { refusal: refused };

    const response = await dispatch(controller.signal);
    refused = refusal();
    return refused ? { refusal: refused } : { response };
  } catch (error) {
    const refused = refusal();
    if (refused) return { refusal: refused };
    throw error;
  } finally {
    unsubscribe?.();
  }
}
