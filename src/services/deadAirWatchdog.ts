/**
 * DEAD-AIR WATCHDOG — end a connected session that has stopped conversing.
 *
 * Why this exists (call 438e06f8, 2026-08-04 09:41): the agent said one line —
 * "Thanks for your patience — let's get started. Could you tell me your last
 * name, please?" — and then nothing happened for TWENTY MINUTES. total_turns=1,
 * tool_timeline null. The caller redialled a minute later from the same number
 * and got a fresh agent, so for the rest of that 20 minutes the practice was
 * paying Twilio and OpenAI to hold an empty line open.
 *
 * Nothing was watching. Two mechanisms look like they should have caught it and
 * neither does:
 *
 *   - The SIP watchdog's max-duration timer (getMaxDurationMs) is CLEARED by
 *     cancelSIPWatchdog the moment the OpenAI webhook arrives, because its job
 *     is orphaned calls that never connected. It did eventually cut this one at
 *     the 20-minute azul cap — 1201s is that cap to the second — which is the
 *     ceiling, not a safety net.
 *   - The DB reconciler only looks at rows still in 'in_progress' / 'ringing' /
 *     'initiated'. This call's status was 'completed' and Twilio agreed. It was
 *     never stuck in the database; it was stuck in the conversation.
 *
 * The prompt does ask the agent to handle silence (wait 5s, re-greet, wait 6s,
 * prompt once more, then terminate_call with reason ghost_call). That is the
 * same instruction-as-suggestion the director exists to backstop: on this call
 * the model simply stopped, and a prompt cannot enforce its own execution.
 *
 * So: a deterministic timer, independent of the model. If no conversational
 * activity reaches us for DEAD_AIR_TIMEOUT_MS, close the transport.
 *
 * TIMEOUT CHOICE. 120s, deliberately generous. The binding constraint is not
 * the prompt's ~30s silence ladder but the warm transfer: transfer_to_office
 * averages 28s and has been observed at 71.5s, during which a legitimate call
 * produces no transcript at all. 120s clears that worst case with headroom and
 * still turns a 20-minute hole into a two-minute one. Tunable with
 * DEAD_AIR_TIMEOUT_MS; 0 disables.
 */

/**
 * Session events that mean the call is still alive: WORDS, or WORK. Nothing else.
 *
 * Narrowed 2026-08-05 after call 822f7347 ran the full 20-minute azul cap on FOUR
 * turns — the agent's last line was "¿cuál es su fecha de nacimiento?" and the
 * transcript ends there. The first list included `conversation.item.created` and
 * `conversation.item.truncated`, which a line with nobody on it keeps producing:
 * semantic VAD opens an item on ambient noise, transcription yields nothing, and
 * the watchdog gets touched forever. `response.done` went too — it fires for
 * empty and cancelled responses, so it is not evidence anyone spoke.
 *
 * What remains: a CALLER transcript, an AGENT transcript, or tool traffic. If
 * none of those arrive for the timeout, nothing is happening on the call, whether
 * or not the transport is still chattering.
 */
const ACTIVITY_EVENTS = new Set([
  'conversation.item.input_audio_transcription.completed',
  'response.output_audio_transcript.done',
  'response.audio_transcript.done',
]);

export function isActivityEvent(eventType: unknown): boolean {
  const t = String(eventType ?? '');
  if (ACTIVITY_EVENTS.has(t)) return true;
  // Tool traffic: a tool in flight is work, not dead air.
  return t.includes('function_call');
}

export function deadAirTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEAD_AIR_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 120_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

interface Watch {
  lastActivity: number;
  timer: ReturnType<typeof setInterval>;
  onDeadAir: (idleMs: number) => void;
  fired: boolean;
}

export class DeadAirWatchdog {
  private watches = new Map<string, Watch>();
  /** Injectable for tests — Date.now() by default. */
  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Start watching a connected call. `onDeadAir` fires at most once.
   * A timeout of 0 disables the watchdog entirely.
   */
  arm(callId: string, onDeadAir: (idleMs: number) => void, timeoutMs = deadAirTimeoutMs()): void {
    if (!callId || timeoutMs <= 0) return;
    this.release(callId);
    // Check on a fraction of the timeout so the worst-case overshoot is small
    // without spinning a timer per second on every concurrent call.
    const tick = Math.max(5_000, Math.floor(timeoutMs / 4));
    const timer = setInterval(() => {
      const w = this.watches.get(callId);
      if (!w || w.fired) return;
      const idle = this.now() - w.lastActivity;
      if (idle < timeoutMs) return;
      w.fired = true;
      try {
        w.onDeadAir(idle);
      } catch {
        /* a watchdog failure must never break a call */
      }
    }, tick);
    // Never hold the process open on this timer alone.
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.watches.set(callId, { lastActivity: this.now(), timer, onDeadAir, fired: false });
  }

  /** The call did something. Cheap: called on every qualifying session event. */
  touch(callId: string): void {
    const w = this.watches.get(callId);
    if (w) w.lastActivity = this.now();
  }

  release(callId: string | undefined): void {
    if (!callId) return;
    const w = this.watches.get(callId);
    if (w) {
      clearInterval(w.timer);
      this.watches.delete(callId);
    }
  }

  /** Test/telemetry view. */
  idleMs(callId: string): number | null {
    const w = this.watches.get(callId);
    return w ? this.now() - w.lastActivity : null;
  }

  /** Test/telemetry view. */
  isWatching(callId: string): boolean {
    return this.watches.has(callId);
  }
}

export const deadAirWatchdog = new DeadAirWatchdog();
