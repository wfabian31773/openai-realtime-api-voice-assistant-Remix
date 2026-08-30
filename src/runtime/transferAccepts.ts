/**
 * The waiting room between "we dialled the office" and "a human pressed a key".
 *
 * `performWarmTransfer` needs a promise that settles when the office accepts.
 * Only the accept webhook knows a digit arrived, and it is a different HTTP
 * request on a different Twilio leg — so something has to hold the pending
 * transfer in between. This is that something.
 *
 * ## A digit is the only accept
 *
 * Silence is a decline, not an unknown. The second `<Gather>` carries
 * `actionOnEmptyResult`, so a office that answered and pressed nothing still
 * POSTs here — with no `Digits`. That must settle as a decline rather than
 * time out, because the two mean different things to the caller's agent: a
 * decline is immediate, a timeout costs the caller another 45 seconds of hold.
 *
 * Answering-machine detection is deliberately not consulted. AMD judges from
 * the first audio on the line, so a staffed hunt group with a recorded greeting
 * scores `machine` and the handler hangs up on a live person — that is what
 * killed the first PCP transfers. A digit is positive proof of a human and
 * needs no verdict.
 *
 * ## Everything settles, exactly once
 *
 * A pending entry that never settles is a caller holding in silence until the
 * call ceiling. A timer that outlives its entry keeps the process alive. So
 * every path — accept, decline, timeout, abandon — clears the timer and drops
 * the entry, and a second settle is a no-op rather than an unhandled rejection.
 */

/** Why a pending transfer settled. `accepted` is the only success. */
export type AcceptResolution = "accepted" | "declined" | "timeout" | "abandoned";

export class TransferAcceptError extends Error {
  constructor(readonly resolution: Exclude<AcceptResolution, "accepted">) {
    super(resolution);
    this.name = "TransferAcceptError";
  }
}

interface Pending {
  resolve: () => void;
  reject: (err: TransferAcceptError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TransferAcceptRegistryOptions {
  /** How long to hold the line open for a keypress. */
  windowMs: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  log?: (line: string) => void;
  /** Clock for the terminal-status tombstones; injectable for tests. */
  now?: () => number;
}

export class TransferAcceptRegistry {
  private readonly pending = new Map<string, Pending>();
  /**
   * Terminal statuses that arrived BEFORE their wait registered.
   *
   * Twilio can POST a busy/failed status for the office leg before
   * `calls.create()` has even resolved on our side — the wait for that
   * CallSid does not exist yet, the abandon finds nothing to settle, and
   * without a memory of it the wait that registers moments later would
   * hold the caller in the transfer tool's silence for the full accept
   * window (Codex, PR #230 round 5). Entries are sid -> recorded-at and
   * are consumed by the wait's registration or pruned after windowMs —
   * a status older than the window could not belong to a wait that is
   * only being registered now.
   */
  private readonly terminalBeforeWait = new Map<string, number>();
  private readonly windowMs: number;
  private readonly setTimer: NonNullable<TransferAcceptRegistryOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<TransferAcceptRegistryOptions["clearTimer"]>;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: TransferAcceptRegistryOptions) {
    this.windowMs = opts.windowMs;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.log = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Wait for the office leg to accept.
   *
   * Resolves on a keypress; rejects with a `TransferAcceptError` naming which
   * of decline / timeout / abandon happened, because the caller's agent says
   * something different for each.
   */
  waitFor(officeCallSid: string): Promise<void> {
    // A second wait on the same leg would orphan the first, leaving a caller
    // holding on a promise nothing will ever settle.
    const existing = this.pending.get(officeCallSid);
    if (existing) {
      this.log(`[runtime-xfer] duplicate wait for ${officeCallSid}; abandoning the first`);
      this.settle(officeCallSid, "abandoned");
    }

    const promise = new Promise<void>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.settle(officeCallSid, "timeout");
      }, this.windowMs);
      this.pending.set(officeCallSid, { resolve, reject, timer });
    });
    // A terminal status already arrived for this leg — the dial died
    // before the wait even existed. Settle immediately instead of holding
    // the caller for the full window on a leg Twilio has already buried.
    if (this.terminalBeforeWait.delete(officeCallSid)) {
      this.log(`[runtime-xfer] ${officeCallSid} was terminal before its wait registered`);
      this.settle(officeCallSid, "abandoned");
    }
    return promise;
  }

  /**
   * The accept webhook's entry point.
   *
   * Returns whether the transfer was still pending — false means the office
   * pressed a key after the window closed, or on a leg nobody is waiting on,
   * and the webhook should say the transfer expired rather than bridge into
   * a call that has moved on.
   */
  recordDigits(officeCallSid: string, digits: string | null | undefined): boolean {
    if (!this.pending.has(officeCallSid)) {
      this.log(`[runtime-xfer] accept for unknown or expired leg ${officeCallSid}`);
      return false;
    }
    const pressed = (digits ?? "").trim();
    // No digits is a DECLINE, not an unknown: `actionOnEmptyResult` means the
    // briefing played out to someone who pressed nothing, or to a machine.
    return this.settle(officeCallSid, pressed ? "accepted" : "declined");
  }

  /** The caller hung up while the office was ringing, or the leg died a
   * terminal death (busy/failed/no-answer via the status webhook).
   * Nothing to bridge into. Returns whether a pending wait was settled;
   * when none exists yet, the event is remembered so a wait that
   * registers within the window still settles instantly. */
  abandon(officeCallSid: string): boolean {
    if (this.settle(officeCallSid, "abandoned")) return true;
    const cutoff = this.now() - this.windowMs;
    for (const [sid, at] of this.terminalBeforeWait) {
      if (at < cutoff) this.terminalBeforeWait.delete(sid);
    }
    this.terminalBeforeWait.set(officeCallSid, this.now());
    return false;
  }

  /** Pending legs, for a health endpoint. Never contains caller content. */
  pendingCount(): number {
    return this.pending.size;
  }

  private settle(officeCallSid: string, resolution: AcceptResolution): boolean {
    const entry = this.pending.get(officeCallSid);
    if (!entry) return false;

    // Drop first, so a reject handler that re-enters cannot settle twice.
    this.pending.delete(officeCallSid);
    this.clearTimer(entry.timer);

    if (resolution === "accepted") {
      this.log(`[runtime-xfer] keypress accept on ${officeCallSid}`);
      entry.resolve();
    } else {
      this.log(`[runtime-xfer] ${officeCallSid} settled as ${resolution}`);
      entry.reject(new TransferAcceptError(resolution));
    }
    return true;
  }
}
