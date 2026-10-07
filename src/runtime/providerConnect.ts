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
  /** Called once per first-event wait: true = event arrived. */
  noteFirstEventWait?: (arrived: boolean) => void;
}

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
      opts.noteFirstEventWait?.(false);
      if (n === maxAttempts) throw new FirstEventStallError(attempts);
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
      opts.noteFirstEventWait?.(false);
      if (n === maxAttempts) throw new FirstEventStallError(attempts);
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

    opts.noteFirstEventWait?.(arrived);

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

  throw new FirstEventStallError(attempts);
}

/** Sliding window of the last N first-event waits. Testable; one process. */
export function createStallRateWindow(opts?: {
  window?: number;
  alertAt?: number;
  alert?: (text: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}): { note: (arrived: boolean) => { stalls: number; samples: number; alerted: boolean } } {
  const size = opts?.window ?? STALL_WINDOW;
  const alertAt = opts?.alertAt ?? STALL_ALERT_AT;
  const samples: boolean[] = [];
  let lastAlertAt = 0;
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? ((line: string) => console.warn(line));

  return {
    note(arrived: boolean) {
      samples.push(arrived);
      if (samples.length > size) samples.shift();
      const stalls = samples.filter((ok) => !ok).length;
      const rate = samples.length > 0 ? stalls / samples.length : 0;
      let alerted = false;
      if (
        stalls >= alertAt &&
        (lastAlertAt === 0 || now() - lastAlertAt >= STALL_SMS_COOLDOWN_MS)
      ) {
        lastAlertAt = now();
        alerted = true;
        const text =
          `[PROVIDER CONNECT] STALL RATE ${stalls}/${samples.length}` +
          ` (${(rate * 100).toFixed(0)}%) — reconnecting is not absorbing it`;
        log(text);
        opts?.alert?.(text);
      }
      return { stalls, samples: samples.length, alerted };
    },
  };
}

const defaultStallWindow = createStallRateWindow({
  alert: (text) => {
    void sendStallRateSms(text);
  },
});

/** Production counter. Tests build their own window. */
export function noteFirstEventWait(arrived: boolean): void {
  defaultStallWindow.note(arrived);
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
      body: `Azul voice: xAI session stall spike. ${text}`.slice(0, 1600),
      from,
      to,
    });
    console.log("[PROVIDER CONNECT] stall-rate SMS sent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PROVIDER CONNECT] stall-rate SMS failed: ${message}`);
  }
}
