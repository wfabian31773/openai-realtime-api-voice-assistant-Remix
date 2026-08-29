/**
 * src/runtime/sessionRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory registry of calls the webhook has issued TwiML for. Three jobs:
 *
 *   1. STREAM GATE. The media-stream WebSocket only accepts a start frame
 *      whose callSid + per-call random token were issued by OUR webhook.
 *      A stream for an unknown callSid, a wrong token, or a callSid whose
 *      stream already started is refused before any bridge exists. (Twilio
 *      does not support query parameters on a <Stream url>, so the gate
 *      runs at start-frame time rather than at upgrade time.)
 *   2. CALL CONTEXT. Carries {slug, callerPhone, dialedNumber} from the
 *      webhook POST body to the bridge. Context ONLY: nothing here marks
 *      anyone verified. A phone match is a candidate to confirm, never an
 *      identity — Wayne's own number resolves to eight records in the
 *      mirror.
 *   3. OUTCOME FOR THE POST-STREAM TwiML. Teardown records exactly one
 *      outcome per call; `POST /voice/:slug/after` reads it to choose
 *      between a clean hangup and the controlled trouble line.
 *
 * Process-local, like the SIP core's own session state: a restart drops
 * in-flight calls, and Twilio sees the socket close and runs the
 * post-<Connect> TwiML. Entries expire on a sweep so an abandoned webhook
 * (the caller hung up before the stream connected) cannot accumulate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CallOutcome } from "./mediaStreamBridge";

export interface CallEntry {
  callSid: string;
  /** Which lane answered. Decided by the URL the number posts to. */
  slug: string;
  /** Per-call random secret placed in the <Stream> parameters and required
   * again when the stream announces itself. */
  streamToken: string;
  callerPhone: string;
  dialedNumber: string;
  createdAtMs: number;
  streamStarted: boolean;
  outcome: CallOutcome | null;
}

/** How long a webhook-issued entry may wait for its stream and its after-
 * redirect before the sweep drops it. Generous: it has to cover Twilio's
 * webhook and stream setup plus the longest allowed call. */
const DEFAULT_ENTRY_TTL_MS = 30 * 60 * 1000;

export class CallSessionRegistry {
  private readonly entries = new Map<string, CallEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_ENTRY_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Called by the webhook when it issues <Connect><Stream> TwiML.
   *
   * IDEMPOTENT PER CallSid (Codex review, PR #227). Twilio retries a
   * webhook it considers unanswered, and the same CallSid can arrive more
   * than once. Minting a fresh entry each time breaks the stream gate in
   * both directions: a retry BEFORE the stream connects rotates the token,
   * so the one already sitting in the first TwiML no longer works and the
   * real call is refused; a retry AFTER it connects resets `streamStarted`,
   * so a second token can be claimed and one call gets two bridges talking
   * over each other.
   *
   * The first registration wins, and its token stays valid for the life of
   * the entry. A Twilio CallSid identifies one call, so preserving is
   * always the correct reading of a repeat.
   */
  register(input: {
    callSid: string;
    slug: string;
    callerPhone: string;
    dialedNumber: string;
  }): CallEntry {
    this.sweep();
    const existing = this.entries.get(input.callSid);
    if (existing) return existing;
    const entry: CallEntry = {
      callSid: input.callSid,
      slug: input.slug,
      streamToken: randomBytes(16).toString("hex"),
      callerPhone: input.callerPhone,
      dialedNumber: input.dialedNumber,
      createdAtMs: this.now(),
      streamStarted: false,
      outcome: null,
    };
    this.entries.set(input.callSid, entry);
    return entry;
  }

  get(callSid: string): CallEntry | undefined {
    this.sweep();
    return this.entries.get(callSid);
  }

  /**
   * Stream gate. Accepts only a callSid this registry issued, with the
   * matching token, whose stream has not already started — one stream per
   * issued call.
   */
  claimStream(callSid: string, streamToken: string): CallEntry | null {
    const entry = this.get(callSid);
    if (!entry) return null;
    if (!timingSafeEqualString(entry.streamToken, streamToken)) return null;
    if (entry.streamStarted) return null;
    entry.streamStarted = true;
    return entry;
  }

  /** First writer wins — teardown races cannot flip a recorded outcome. */
  recordOutcome(callSid: string, outcome: CallOutcome): void {
    const entry = this.entries.get(callSid);
    if (entry && entry.outcome === null) {
      entry.outcome = outcome;
    }
  }

  /** Read-and-remove for the post-stream redirect handler. */
  consumeOutcome(callSid: string): CallOutcome | null {
    const entry = this.entries.get(callSid);
    if (!entry) return null;
    this.entries.delete(callSid);
    return entry.outcome;
  }

  activeCount(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [callSid, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) this.entries.delete(callSid);
    }
  }
}

/** Constant-time compare for the stream token. The token is a secret and
 * the comparison is attacker-timed; length is compared first because
 * timingSafeEqual throws on a length mismatch. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
