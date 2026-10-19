/**
 * FIRST-EVENT RETRY ON THE xAI REALTIME SOCKET.
 *
 * xAI accepts the WebSocket (HTTP 101, ~0.2 s) and sometimes never sends
 * `session.created`. The runtime used to wait
 * `PROVIDER_SETUP_DEADLINE_MS` (15 s) for the whole handshake, then tear
 * the call down. The caller heard nothing and no ticket filed. Production
 * saw that shape on ~1 in 18 connections (worst ~1 in 7, 2026-10-05/06).
 *
 * The stall is on their side — 90 off-production probes, same model and
 * session setup, 5 hung 20 s with no error and no close. The fix is here:
 * wait a short time for the FIRST event, detach the stalled socket so its
 * close cannot end the call, and open a new one. Two retries (three
 * attempts). A handshake that never upgrades is bounded at ~5 s.
 *
 * THIS MODULE DOES NOT SPEAK TO THE CALLER. Wording is Wayne's. The
 * technical-trouble TwiML already fires on `provider_failure`.
 *
 * PHI-free on purpose: timestamps, attempt counts, upgrade headers
 * (`x-trace-id`, `CF-RAY`), close code/reason. Never a name, a number or
 * a transcript.
 */

export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 2_500;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 5_000;
/** Retries AFTER the first attempt — three attempts in total. */
export const DEFAULT_CONNECT_RETRIES = 2;

const FIRST_EVENT_MIN_MS = 1_000;
const FIRST_EVENT_MAX_MS = 10_000;
const HANDSHAKE_MIN_MS = 2_000;
const HANDSHAKE_MAX_MS = 15_000;
const RETRIES_MIN = 0;
const RETRIES_MAX = 4;

const STALL_WINDOW = 30;
const STALL_ALERT_AT = 4;
const STALL_SMS_COOLDOWN_MS = 15 * 60 * 1000;

export function clampEnvMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function firstEventTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return clampEnvMs(
    env.RUNTIME_FIRST_EVENT_TIMEOUT_MS,
    DEFAULT_FIRST_EVENT_TIMEOUT_MS,
    FIRST_EVENT_MIN_MS,
    FIRST_EVENT_MAX_MS,
  );
}

export function handshakeTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return clampEnvMs(
    env.RUNTIME_WS_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_WS_HANDSHAKE_TIMEOUT_MS,
    HANDSHAKE_MIN_MS,
    HANDSHAKE_MAX_MS,
  );
}

export function connectRetries(
  env: Record<string, string | undefined> = process.env,
): number {
  return clampEnvMs(
    env.RUNTIME_CONNECT_RETRIES,
    DEFAULT_CONNECT_RETRIES,
    RETRIES_MIN,
    RETRIES_MAX,
  );
}

export interface ProviderConnectHeaders {
  xTraceId?: string;
  cfRay?: string;
}

export interface OpenedProviderSocket {
  headers: ProviderConnectHeaders;
  /**
   * Resolves true when any first message arrives within `ms`.
   * False on timeout, error or close — the socket is still open so the
   * caller can detach it.
   */
  waitForFirstEvent(ms: number): Promise<boolean>;
  /** Strip every listener, then close. A stalled close must not reach the session. */
  detachAndClose(): void;
}

export interface ProviderConnectAttempt {
  attempt: number;
  connectAt: string;
  openAt?: string;
  firstEventAt?: string;
  outcome: "first_event" | "first_event_stall" | "handshake_failed" | "aborted";
  headers: ProviderConnectHeaders;
  error?: string;
}

export class FirstEventStallError extends Error {
  readonly attempts: ProviderConnectAttempt[];
  constructor(attempts: ProviderConnectAttempt[]) {
    super(
      `provider first event never arrived after ${attempts.length} attempt(s)`,
    );
    this.name = "FirstEventStallError";
    this.attempts = attempts;
  }
}

export class ProviderConnectAbortedError extends Error {
  constructor() {
    super("provider connect aborted — the Twilio socket is gone");
    this.name = "ProviderConnectAbortedError";
  }
}

export interface ProviderConnectResult {
  socket: OpenedProviderSocket;
  attempts: ProviderConnectAttempt[];
}

export interface ConnectWithFirstEventRetryOpts {
  open: () => Promise<OpenedProviderSocket>;
  shouldAbort?: () => boolean;
  firstEventTimeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  log?: (line: string) => void;
  noteStall?: () => void;
  /**
   * Called once per attempt: true = the first event arrived. On a failure the
   * second argument names WHAT failed (`connectFailureKind`), so the alert
   * can say "HTTP 503" instead of calling every failure a stall.
   */
  noteFirstEventWait?: (arrived: boolean, failure?: string) => void;
  /** Called once per call: connected (on any attempt) or lost after every retry. */
  noteConnectSettled?: (outcome: ConnectOutcome) => void;
}

export type ConnectOutcome = "connected" | "lost";

/**
 * What a failed attempt was, in words an operator reads on an SMS.
 *
 * 2026-10-19 18:34–18:49 UTC is why: the alert said "STALL RATE 11/30 —
 * reconnecting is not absorbing it", and the deployment log said ten of the
 * eleven were xAI answering the upgrade with HTTP 503 and one was a handshake
 * timeout. No socket stalled, and seven of the eight calls behind them
 * reconnected on a retry. The message strings are the `ws` library's own.
 */
export function connectFailureKind(message: string): string {
  const http = /Unexpected server response:\s*(\d{3})/i.exec(message);
  if (http) return `HTTP ${http[1]}`;
  if (/handshake has timed out/i.test(message)) return "handshake timeout";
  return "handshake error";
}

/** An open socket that sent nothing — the shape v91 was built for. */
export const SILENT_STALL = "silent (open, no first event)";
/** The first-event wait itself threw: the socket errored or closed after the upgrade. */
export const DROPPED_AFTER_OPEN = "dropped after open";

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function headerBits(headers: ProviderConnectHeaders): string {
  const bits: string[] = [];
  if (headers.xTraceId) bits.push(`x-trace-id=${headers.xTraceId}`);
  if (headers.cfRay) bits.push(`cf-ray=${headers.cfRay}`);
  return bits.length > 0 ? bits.join(" ") : "no-upgrade-headers";
}

export async function connectWithFirstEventRetry(
  opts: ConnectWithFirstEventRetryOpts,
): Promise<ProviderConnectResult> {
  const firstMs = opts.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const retries = opts.maxRetries ?? DEFAULT_CONNECT_RETRIES;
  const maxAttempts = retries + 1;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const attempts: ProviderConnectAttempt[] = [];

  for (let n = 1; n <= maxAttempts; n++) {
    if (opts.shouldAbort?.()) {
      attempts.push({
        attempt: n,
        connectAt: iso(now),
        outcome: "aborted",
        headers: {},
      });
      log(`[PROVIDER CONNECT] aborted before attempt ${n}`);
      throw new ProviderConnectAbortedError();
    }

    const connectAt = iso(now);
    log(`[PROVIDER CONNECT] attempt ${n}/${maxAttempts} connecting at ${connectAt}`);
    let socket: OpenedProviderSocket;
    try {
      socket = await opts.open();
    } catch (error) {
      if (
        error instanceof ProviderConnectAbortedError ||
        opts.shouldAbort?.()
      ) {
        attempts.push({
          attempt: n,
          connectAt,
          outcome: "aborted",
          headers: {},
        });
        log(`[PROVIDER CONNECT] aborted during handshake on attempt ${n}`);
        throw error instanceof ProviderConnectAbortedError
          ? error
          : new ProviderConnectAbortedError();
      }
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        attempt: n,
        connectAt,
        outcome: "handshake_failed",
        headers: {},
        error: message,
      });
      log(`[PROVIDER CONNECT] attempt ${n} handshake failed: ${message}`);
      opts.noteStall?.();
      opts.noteFirstEventWait?.(false, connectFailureKind(message));
      if (n === maxAttempts) {
        opts.noteConnectSettled?.("lost");
        throw new FirstEventStallError(attempts);
      }
      continue;
    }

    if (opts.shouldAbort?.()) {
      socket.detachAndClose();
      attempts.push({
        attempt: n,
        connectAt,
        outcome: "aborted",
        headers: socket.headers,
      });
      log(`[PROVIDER CONNECT] aborted after open on attempt ${n}`);
      throw new ProviderConnectAbortedError();
    }

    const openAt = iso(now);
    log(
      `[PROVIDER CONNECT] attempt ${n} open at ${openAt} ${headerBits(socket.headers)}`,
    );

    let arrived = false;
    try {
      arrived = await socket.waitForFirstEvent(firstMs);
    } catch (error) {
      socket.detachAndClose();
      if (
        error instanceof ProviderConnectAbortedError ||
        opts.shouldAbort?.()
      ) {
        attempts.push({
          attempt: n,
          connectAt,
          openAt,
          outcome: "aborted",
          headers: socket.headers,
        });
        log(`[PROVIDER CONNECT] aborted during first-event wait on attempt ${n}`);
        throw error instanceof ProviderConnectAbortedError
          ? error
          : new ProviderConnectAbortedError();
      }
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        attempt: n,
        connectAt,
        openAt,
        outcome: "handshake_failed",
        headers: socket.headers,
        error: message,
      });
      log(`[PROVIDER CONNECT] attempt ${n} first-event wait threw: ${message}`);
      opts.noteStall?.();
      opts.noteFirstEventWait?.(false, DROPPED_AFTER_OPEN);
      if (n === maxAttempts) {
        opts.noteConnectSettled?.("lost");
        throw new FirstEventStallError(attempts);
      }
      continue;
    }

    if (opts.shouldAbort?.()) {
      socket.detachAndClose();
      attempts.push({
        attempt: n,
        connectAt,
        openAt,
        outcome: "aborted",
        headers: socket.headers,
      });
      log(`[PROVIDER CONNECT] aborted after first-event wait on attempt ${n}`);
      throw new ProviderConnectAbortedError();
    }

    if (arrived) opts.noteFirstEventWait?.(true);
    else opts.noteFirstEventWait?.(false, SILENT_STALL);

    if (arrived) {
      const firstEventAt = iso(now);
      attempts.push({
        attempt: n,
        connectAt,
        openAt,
        firstEventAt,
        outcome: "first_event",
        headers: socket.headers,
      });
      log(
        `[PROVIDER CONNECT] attempt ${n} first event at ${firstEventAt} ${headerBits(socket.headers)}`,
      );
      opts.noteConnectSettled?.("connected");
      return { socket, attempts };
    }

    opts.noteStall?.();
    socket.detachAndClose();
    attempts.push({
      attempt: n,
      connectAt,
      openAt,
      outcome: "first_event_stall",
      headers: socket.headers,
    });
    log(
      `[PROVIDER CONNECT] attempt ${n} first-event stall after ${firstMs}ms — detaching ${headerBits(socket.headers)}`,
    );
  }

  opts.noteConnectSettled?.("lost");
  throw new FirstEventStallError(attempts);
}

interface AttemptSample {
  arrived: boolean;
  failure?: string;
  /** Which call made the attempt, so the alert can count calls, not attempts. */
  call?: number;
}

export interface StallWindowNote {
  stalls: number;
  samples: number;
  alerted: boolean;
}

/**
 * Sliding window of the last N connection attempts. Testable; one process.
 *
 * WHEN IT FIRES IS UNCHANGED: a failed attempt that takes the window to
 * `alertAt` failures, at most once per cooldown. What changed on
 * 2026-10-19 is WHAT IT SAYS. Every failure used to be called a stall and
 * every alert said "reconnecting is not absorbing it" — on the first one
 * that fired, xAI was refusing the upgrade with HTTP 503, nothing stalled,
 * and seven of the eight calls behind it reconnected. The text now names
 * each kind of failure with its count, and counts the CALLS behind them:
 * how many reconnected on a retry, how many dropped after every retry, and
 * how many were still connecting when it fired.
 */
export function createStallRateWindow(opts?: {
  window?: number;
  alertAt?: number;
  alert?: (text: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}): {
  note: (arrived: boolean, failure?: string, call?: number) => StallWindowNote;
  settle: (call: number, outcome: ConnectOutcome) => void;
} {
  const size = opts?.window ?? STALL_WINDOW;
  const alertAt = opts?.alertAt ?? STALL_ALERT_AT;
  const samples: AttemptSample[] = [];
  const outcomes = new Map<number, ConnectOutcome>();
  let lastAlertAt = 0;
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? ((line: string) => console.warn(line));

  const inWindow = (call: number) => samples.some((s) => s.call === call);

  const alertText = (stalls: number): string => {
    const rate = samples.length > 0 ? stalls / samples.length : 0;
    const kinds = new Map<string, number>();
    const hit = new Set<number>();
    for (const s of samples) {
      if (s.arrived) continue;
      const kind = s.failure ?? "failed";
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (s.call != null) hit.add(s.call);
    }
    const kindText = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind} x${count}`)
      .join(", ");
    let text =
      `[PROVIDER CONNECT] CONNECT FAILURES ${stalls}/${samples.length}` +
      ` attempts (${(rate * 100).toFixed(0)}%): ${kindText}.`;
    if (hit.size > 0) {
      let reconnected = 0;
      let lost = 0;
      let connecting = 0;
      for (const call of hit) {
        const outcome = outcomes.get(call);
        if (outcome === "connected") reconnected += 1;
        else if (outcome === "lost") lost += 1;
        else connecting += 1;
      }
      const parts: string[] = [];
      if (reconnected > 0) parts.push(`${reconnected} reconnected on a retry`);
      parts.push(
        lost > 0 ? `${lost} dropped after every retry` : "none dropped",
      );
      if (connecting > 0) parts.push(`${connecting} still connecting`);
      text += ` Calls affected: ${hit.size} (${parts.join(", ")}).`;
    }
    return text;
  };

  return {
    note(arrived: boolean, failure?: string, call?: number) {
      samples.push({ arrived, failure, call });
      if (samples.length > size) {
        const gone = samples.shift();
        if (gone?.call != null && !inWindow(gone.call)) outcomes.delete(gone.call);
      }
      const stalls = samples.filter((s) => !s.arrived).length;
      let alerted = false;
      if (
        stalls >= alertAt &&
        (lastAlertAt === 0 || now() - lastAlertAt >= STALL_SMS_COOLDOWN_MS)
      ) {
        lastAlertAt = now();
        alerted = true;
        const text = alertText(stalls);
        log(text);
        opts?.alert?.(text);
      }
      return { stalls, samples: samples.length, alerted };
    },
    settle(call: number, outcome: ConnectOutcome) {
      // A call whose attempts have already left the window says nothing
      // about the attempts in it, and keeping it would leak.
      if (inWindow(call)) outcomes.set(call, outcome);
    },
  };
}

const defaultStallWindow = createStallRateWindow({
  alert: (text) => {
    void sendStallRateSms(text);
  },
});
let nextConnectCall = 0;

/**
 * Production counter, one per call: spread into `connectWithFirstEventRetry`
 * so every attempt and the call's outcome land on the process's window under
 * one call id. Tests build their own window.
 */
export function trackConnect(): Pick<
  ConnectWithFirstEventRetryOpts,
  "noteFirstEventWait" | "noteConnectSettled"
> {
  const call = ++nextConnectCall;
  return {
    noteFirstEventWait: (arrived, failure) => {
      defaultStallWindow.note(arrived, failure, call);
    },
    noteConnectSettled: (outcome) => defaultStallWindow.settle(call, outcome),
  };
}

async function sendStallRateSms(text: string): Promise<void> {
  if (process.env.VITEST) return;
  const to = process.env.HUMAN_AGENT_NUMBER;
  if (!to) return;
  try {
    const { default: twilio } = await import("twilio");
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) return;
    const client = twilio(sid, token);
    await client.messages.create({
      body: `Azul voice: xAI connection trouble. ${text}`.slice(0, 1600),
      from,
      to,
    });
    console.log("[PROVIDER CONNECT] connect-failure SMS sent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PROVIDER CONNECT] connect-failure SMS failed: ${message}`);
  }
}
