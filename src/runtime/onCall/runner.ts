/**
 * THE ESCALATION RUNNER — what happens after the in-call transfer to the
 * on-call provider is not taken.
 *
 * The cadence (operator, 2026-11-23), per level of the chain:
 *   a. a text with the patient's details, then a call;
 *   b. no answer is logged as no answer, not as a failure;
 *   c. within 5 minutes of the level starting, a second call and a reminder
 *      text;
 *   d. a key press on any of our calls takes the patient and stops the chain;
 *   e/f. otherwise the next level (the region's medical director, then the
 *      final director) gets the same cadence.
 *
 * Level 0's first attempt is the in-call warm transfer, which the caller is
 * still on the line for. Everything after it is a callback: the patient is not
 * connected to the provider's call, so every text asks the provider to press a
 * key on our call (which stops the escalation) and then call the patient back.
 * The texts make no claim about whether the patient is still on the line with
 * the agent: when the reminder goes out they may well be.
 *
 * A key press anywhere stops the chain, and stays stopped: every move (a retry,
 * an escalation, the ringing guard) first looks for an accepted attempt on the
 * escalation and closes it as accepted instead of moving on, so a close that
 * lost a race with a tick is finished by the next move rather than undone.
 * Once a call is taken, any other call of ours still ringing for it is hung up.
 *
 * The state lives in the Hub (store.ts), not in this process. Every move is a
 * version-checked write, so a restart, a second process or a late webhook
 * cannot ring a level twice or skip one. A call whose status never comes back
 * is ended by the ringing guard (RING_GUARD_MS) and the chain carries on.
 */
import { buildUrgentTransferSms, urgentAlertTime } from "../../services/urgentTransferAlert";
import { ON_CALL_ACK_PATH, ON_CALL_STATUS_PATH, providerCallTwiml, type AckResult } from "./providerCall";
import type { OnCallConfig } from "./config";
import type { ChainLevel, ChainPlan } from "./rotation";
import type {
  AttemptOutcome,
  AttemptRow,
  EscalationPatch,
  EscalationRow,
  OnCallMode,
  OnCallStore,
  RoutingFacts,
  StoredDetails,
} from "./store";

/** The gap between a level's calls. */
export const RETRY_GAP_MS = 60_000;
/** A level's second call starts no later than this after the level started. */
export const LEVEL_RETRY_DEADLINE_MS = 240_000;
/** A call whose status never arrives is ended this long after it was placed. */
export const RING_GUARD_MS = 390_000;
export const CLAIM_LEASE_MS = 60_000;
export const TICK_MS = 10_000;
export const CLAIM_LIMIT = 10;
/**
 * A tick stops waiting for its rows after this long, so one send that never
 * answers (the Hub pool has no statement timeout) cannot hold every later tick
 * back. The row keeps going on its own: every send is made after the
 * version-checked "ringing" write, a row claimed again after its lease has a
 * new version, so a late step lands nothing over the next one, and a step
 * re-reads its row before it places a call (ring()).
 *
 * Shorter than the lease, so the tick that runs after a slow one finds the
 * slow one's rows still leased for the margin, and does not claim a row the
 * slow tick is still on in the ordinary case (review of #514, round 4: the two
 * were equal, so the lease ran out the moment the next tick could start).
 */
export const TICK_BUDGET_MS = CLAIM_LEASE_MS - 15_000;
/**
 * How many ticks may still be waiting past their budget before the runner
 * stops claiming more rows. Under a stalled store or Twilio every tick would
 * otherwise start another claim and more sends that hang beside the last ones
 * (review of #514, round 9). One or two slow ticks still let the next tick run,
 * which is what the budget is for.
 */
export const MAX_LATE_TICKS = 3;
/**
 * A late tick stops counting after this long, so work that never answers (a
 * pool connection that never returns) cannot stop the chain for good. The
 * ringing guard: by then every row such a tick was on is due again anyway.
 */
export const LATE_TICK_FORGET_MS = RING_GUARD_MS;
/** How long the provider's phone rings before Twilio gives up. */
export const PROVIDER_RING_SECONDS = 30;
/** The provider's call can never run longer than this. */
export const PROVIDER_CALL_LIMIT_SECONDS = 300;
/** Calls per level, the in-call transfer counted as level 0's first. */
export const ATTEMPTS_PER_LEVEL = 2;
/**
 * An escalation that comes due this long after it opened rings nobody. A
 * full chain takes about twenty minutes; a row this old means the runner was
 * down or a close kept failing, and a provider woken now would be hours late
 * for a call another level may already have taken. The urgent number is told
 * instead.
 */
export const STALE_ESCALATION_MS = 2 * 3_600_000;

const PRESS_A_KEY =
  "Press any key on the call we are placing to you now to take this patient (that stops the escalation), then call the patient back.";

/** A synthetic test level's id is negative; the foreign keys take a real one or nothing. */
function storedProviderId(id: number): number | null {
  return id > 0 ? id : null;
}

function isPhone(p: string | undefined | null): p is string {
  return typeof p === "string" && /^\+\d{10,15}$/.test(p);
}

export type WarmOutcome = "accepted" | "no_answer" | "declined" | "busy" | "failed";

export interface InCallTransferResult {
  callSid: string;
  mode: OnCallMode;
  plan: ChainPlan;
  routing: RoutingFacts;
  details: StoredDetails | null;
  callerNumber: string | null;
  warm: { outcome: WarmOutcome; dialedTo: string; endedAt: Date; providerCallSid?: string | null };
  /** When the in-call transfer started: level 0's clock. */
  levelStartedAt: Date;
  /** The full-details text sent to level 0 before the in-call dial. */
  preDialSms?: { ok: boolean; sid: string | null; at: Date } | null;
}

/** What a throw inside `ringLevel` left behind: the call's attempt, and whether Twilio has the call. */
interface RingState {
  call: AttemptRow | null;
  placed: boolean;
}

export interface OnCallRunnerDeps {
  store: OnCallStore;
  config: OnCallConfig;
  /** The public host the provider-call webhooks are reached on. */
  host: string;
  sendSms(input: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  placeCall(input: {
    to: string;
    from: string;
    twiml: string;
    statusCallback: string;
    timeout: number;
    timeLimit: number;
  }): Promise<{ sid: string }>;
  /**
   * The text that says nobody took the call: to URGENT_NOTIFICATION_NUMBER in
   * live mode, and to the test list when the chain or the rotation is in test
   * mode, so a test chain never tells a real person to call a test caller.
   * `plan` is the chain's own plan: a test chain still open after the
   * rotation is switched to live has no test list to read, and its plan's
   * numbers are test numbers by construction (review of #514, round 6).
   */
  notifyUrgent(body: string, mode: OnCallMode, plan?: ChainPlan): Promise<void>;
  /** Hang up one of our provider calls (Twilio status=completed). */
  endCall(providerCallSid: string): Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /** For tests: how long a tick waits for its rows. TICK_BUDGET_MS. */
  tickBudgetMs?: number;
  /** For tests: how long a late tick counts. LATE_TICK_FORGET_MS. */
  lateTickForgetMs?: number;
}

export interface OnCallRunner {
  afterInCallTransfer(r: InCallTransferResult): Promise<EscalationRow | null>;
  tick(): Promise<void>;
  onProviderAck(attemptId: number, digits: string): Promise<AckResult>;
  onProviderStatus(attemptId: number, callStatus: string): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Twilio's terminal call status, as an attempt outcome. Anything else is ignored.
 *
 * `completed` means the phone was picked up (by a person or a voicemail) and
 * the call ended with no key pressed, usually a hang-up during the prompt: the
 * same `declined` the key-press webhook records for a pickup that presses
 * nothing, not a call that rang out (review of #514, round 8). A pickup that
 * pressed a key was already ended as `accepted`, so this status moves nothing.
 */
export function outcomeForCallStatus(status: string): Exclude<AttemptOutcome, "in_progress"> | null {
  switch (status) {
    case "completed":
      return "declined";
    case "no-answer":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

/** The note that heads a background text: why it is coming and what to do. */
export function attemptNote(e: Pick<EscalationRow, "levelIndex" | "attemptNo" | "plan" | "routing" | "mode">): string {
  const parts: string[] = [];
  if (e.attemptNo > 1) {
    parts.push(
      e.levelIndex === 0
        ? "REMINDER — the urgent transfer to you was not taken. We are calling you again now."
        : "REMINDER — we are calling you again now.",
    );
  } else if (e.levelIndex > 0) {
    const prev = e.plan.levels[e.levelIndex - 1];
    parts.push(`ESCALATED — ${prev?.name ?? "the on-call provider"} did not take this urgent call.`);
  }
  parts.push(PRESS_A_KEY);
  if (e.routing.note) parts.push(e.routing.note);
  const note = parts.join(" ");
  return e.mode === "test" ? `[TEST MODE] ${note}` : note;
}

export function staleNote(e: Pick<EscalationRow, "mode">): string {
  const note =
    "THE ON-CALL ESCALATION STOPPED — it was more than two hours old when it came due, so nobody else will be called. " +
    "If no provider has reached this patient, please call them back now.";
  return e.mode === "test" ? `[TEST MODE] ${note}` : note;
}

/** A chain stopped before it rang a level it had planned. */
export function stoppedNote(e: Pick<EscalationRow, "mode">, why: string): string {
  const note =
    `THE ON-CALL ESCALATION STOPPED — ${why}, so nobody else will be called. ` +
    "If no provider has reached this patient, please call them back now.";
  return e.mode === "test" ? `[TEST MODE] ${note}` : note;
}

export function exhaustedNote(e: Pick<EscalationRow, "plan" | "mode">): string {
  const n = e.plan.levels.length;
  const note =
    `NOBODY TOOK THIS URGENT CALL — all ${n} on-call level${n === 1 ? " was" : "s were"} tried and none took it. ` +
    "Please call this patient back now.";
  return e.mode === "test" ? `[TEST MODE] ${note}` : note;
}

export function createOnCallRunner(deps: OnCallRunnerDeps): OnCallRunner {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  // The ticks still waiting past their budget, each until its work settles or
  // LATE_TICK_FORGET_MS passes, whichever is first.
  const lateTicks = new Set<symbol>();
  let pauseLogged = false;

  const url = (path: string, attemptId: number) => `https://${deps.host}${path}?attempt=${attemptId}`;

  const textFor = (e: EscalationRow, note: string) =>
    buildUrgentTransferSms(
      {
        callerNumber: e.callerNumber ?? undefined,
        escalationDetails: (e.details ?? undefined) as any,
        note,
        kind: "callback",
      },
      urgentAlertTime(now()),
    );

  /**
   * Never rings a number outside the test list while either side is in test
   * mode. A level with no phone rings nobody either way, so it is not outside
   * the list: it is skipped below as it would be live (review of #514).
   */
  const outsideTheTestList = (e: EscalationRow, level: ChainLevel) =>
    (e.mode === "test" || config.mode === "test") &&
    isPhone(level.phone) &&
    !config.testPhones.includes(level.phone);

  async function notifyQuietly(body: string, callSid: string, mode: OnCallMode, plan: ChainPlan) {
    try {
      await deps.notifyUrgent(body, mode, plan);
    } catch (err) {
      log(`[ON-CALL] ${callSid}: the urgent notification failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Hang up one of our calls; a failure is logged, never thrown. */
  async function hangUp(providerCallSid: string | null, callSid: string) {
    if (!providerCallSid) return;
    try {
      await deps.endCall(providerCallSid);
    } catch (err) {
      log(`[ON-CALL] ${callSid}: could not hang up a provider call: ${(err as Error)?.message ?? err}`);
    }
  }

  /** The attempt on this escalation that took the patient, if any. */
  async function acceptedAttempt(e: EscalationRow): Promise<AttemptRow | null> {
    const attempts = await store.attemptsFor(e.callSid);
    return attempts.find((a) => a.escalationId === e.id && a.outcome === "accepted") ?? null;
  }

  /**
   * Close the escalation as accepted by this attempt, then hang up any other
   * call of ours still ringing for it. Retries on a version race. Answers the
   * row as it ends up and whether this call closed it, or a null row when it
   * could not be closed (the next move finds the accepted attempt and closes
   * it then).
   */
  async function closeAsTaken(
    escalationId: number,
    by: AttemptRow,
  ): Promise<{ row: EscalationRow | null; byThis: boolean }> {
    let row: EscalationRow | null = null;
    let byThis = false;
    for (let i = 0; i < 5 && !row; i++) {
      const cur = await store.getEscalation(escalationId);
      if (!cur) return { row: null, byThis: false };
      if (cur.status !== "active") {
        row = cur;
        break;
      }
      row = await store.closeEscalation(cur.id, cur.version, {
        status: "accepted",
        acceptedBy: by.providerId,
        acceptedAt: by.endedAt ?? now(),
        acceptedAttemptId: by.id,
        nextAt: null,
      });
      byThis = row !== null;
    }
    if (!row) {
      log(`[ON-CALL] ${by.callSid}: taken at level ${by.levelIndex}, but the close lost five races; the next move closes it`);
      return { row: null, byThis: false };
    }
    if (row.status === "accepted") {
      const others = (await store.attemptsFor(by.callSid)).filter(
        (a) => a.escalationId === escalationId && a.id !== by.id && a.kind === "call" && a.outcome === "in_progress",
      );
      for (const a of others) {
        // Ended first, so the status the hang-up brings back moves nothing.
        await store.endAttempt(a.id, "taken_elsewhere", now());
        await hangUp(a.providerCallSid, a.callSid);
      }
    }
    return { row, byThis };
  }

  /**
   * Move the chain on from (level, attempt) once that attempt's call is over.
   * Read fresh every time, and only from the attempt it names, so a late or a
   * duplicate webhook cannot move it twice.
   */
  async function advance(
    escalationId: number,
    levelIndex: number,
    attemptNo: number,
    opts: { retryThisLevel?: boolean } = {},
  ): Promise<void> {
    // A level with no number cannot be rung on a retry either, so it goes
    // straight to the next level instead of waiting out a retry gap.
    const retryThisLevel = opts.retryThisLevel ?? true;
    for (let i = 0; i < 3; i++) {
      const e = await store.getEscalation(escalationId);
      if (!e || e.status !== "active" || e.levelIndex !== levelIndex || e.attemptNo !== attemptNo || e.phase !== "ringing") {
        return;
      }
      // A key press anywhere on the chain stops it, even one whose close lost a race.
      const taken = await acceptedAttempt(e);
      if (taken) {
        await closeAsTaken(e.id, taken);
        return;
      }
      const t = now().getTime();
      if (retryThisLevel && attemptNo < ATTEMPTS_PER_LEVEL) {
        const deadline = e.levelStartedAt.getTime() + LEVEL_RETRY_DEADLINE_MS;
        const next = Math.max(t, Math.min(t + RETRY_GAP_MS, deadline));
        const patch: EscalationPatch = { attemptNo: attemptNo + 1, phase: "due", nextAt: new Date(next), releaseLease: true };
        if (await store.updateEscalation(e.id, e.version, patch)) return;
      } else if (levelIndex + 1 < e.plan.levels.length) {
        const at = new Date(t);
        const patch: EscalationPatch = {
          levelIndex: levelIndex + 1,
          attemptNo: 1,
          phase: "due",
          nextAt: at,
          levelStartedAt: at,
          releaseLease: true,
        };
        if (await store.updateEscalation(e.id, e.version, patch)) {
          log(`[ON-CALL] ${e.callSid}: escalated to level ${levelIndex + 1} (${e.plan.levels[levelIndex + 1].role})`);
          return;
        }
      } else {
        const closed = await store.closeEscalation(e.id, e.version, { status: "exhausted", nextAt: null });
        if (closed) {
          log(`[ON-CALL] ${e.callSid}: every level tried, nobody took it`);
          await notifyQuietly(textFor(e, exhaustedNote(e)), e.callSid, e.mode, e.plan);
          return;
        }
      }
    }
    // Every try lost a race. Bring the row due instead of leaving it for the
    // ringing guard: the next tick reads it as a ringing row past its time and
    // runs this move again, seconds from now rather than minutes.
    log(`[ON-CALL] escalation ${escalationId}: could not advance after three tries; bringing it due`);
    try {
      await dueNow(escalationId);
    } catch (err) {
      log(`[ON-CALL] escalation ${escalationId}: could not bring it due: ${(err as Error)?.message ?? err}`);
    }
  }

  async function endAndAdvance(a: AttemptRow, outcome: Exclude<AttemptOutcome, "in_progress">) {
    const ended = await store.endAttempt(a.id, outcome, now());
    if (ended) await advance(a.escalationId, a.levelIndex, a.attemptNo);
  }

  /** Ring the level a due row is at: the text, then the call. */
  async function ring(row: EscalationRow): Promise<void> {
    const taken = await acceptedAttempt(row);
    if (taken) {
      await closeAsTaken(row.id, taken);
      return;
    }
    if (now().getTime() - row.createdAt.getTime() > STALE_ESCALATION_MS) {
      const closed = await store.closeEscalation(row.id, row.version, { status: "failed", nextAt: null });
      if (closed) {
        log(`[ON-CALL] ${row.callSid}: came due more than two hours after it opened; closed as failed, nobody rung`);
        await notifyQuietly(textFor(row, staleNote(row)), row.callSid, row.mode, row.plan);
      }
      return;
    }
    const level = row.plan.levels[row.levelIndex];
    if (!level) {
      const closed = await store.closeEscalation(row.id, row.version, { status: "failed", nextAt: null });
      if (closed) {
        log(`[ON-CALL] ${row.callSid}: level ${row.levelIndex} is not in the plan; closed as failed`);
        await notifyQuietly(
          textFor(row, stoppedNote(row, "its next level could not be read")),
          row.callSid,
          row.mode,
          row.plan,
        );
      }
      return;
    }
    if (outsideTheTestList(row, level)) {
      const closed = await store.closeEscalation(row.id, row.version, { status: "cancelled", nextAt: null });
      if (closed) {
        log(`[ON-CALL] ${row.callSid}: test mode would have rung a number outside the test list; cancelled`);
        // Test mode never rings a real number, but a live chain's patient is
        // real: say so to the urgent number rather than stop in silence.
        await notifyQuietly(
          textFor(row, stoppedNote(row, "the rotation is in test mode and the next level is not a test number")),
          row.callSid,
          row.mode,
          row.plan,
        );
      }
      return;
    }
    const t = now();
    const ringing = await store.updateEscalation(row.id, row.version, {
      phase: "ringing",
      nextAt: new Date(t.getTime() + RING_GUARD_MS),
      releaseLease: true,
    });
    if (!ringing) return;

    // Everything from here to the placed call reads and writes the store, and
    // any of it can throw. A throw before the call is placed must not leave the
    // row "ringing" until the guard (6.5 minutes, with nobody being called):
    // the chain moves on as it would after a call that failed (review of #514,
    // round 9). Once Twilio has the call, nothing here moves the chain; its
    // status callback does.
    const state: RingState = { call: null, placed: false };
    try {
      await ringLevel(row, level, ringing.version, t, state);
    } catch (err) {
      if (state.placed) {
        log(`[ON-CALL] ${row.callSid}: level ${row.levelIndex} is ringing; a later step failed: ${(err as Error)?.message ?? err}`);
        return;
      }
      log(
        `[ON-CALL] ${row.callSid}: ringing level ${row.levelIndex} failed before its call was placed: ${(err as Error)?.message ?? err}; moving on`,
      );
      if (state.call) {
        try {
          await store.endAttempt(state.call.id, "failed", now());
        } catch {
          // The guard ends it as "no_status" if this cannot.
        }
      }
      try {
        // A level with no number is not retried, as ringLevel itself decides.
        await advance(row.id, row.levelIndex, row.attemptNo, { retryThisLevel: isPhone(level.phone) });
      } catch (e2) {
        log(
          `[ON-CALL] ${row.callSid}: could not move on from level ${row.levelIndex}; the ringing guard moves it in ${Math.round(RING_GUARD_MS / 1000)} s: ${(e2 as Error)?.message ?? e2}`,
        );
      }
    }
  }

  /**
   * The text and the call for one level of a row that is now "ringing". Writes
   * the call's attempt into `state` once it is logged and marks `state.placed`
   * once Twilio has the call, so `ring` knows what a throw left behind.
   */
  async function ringLevel(
    row: EscalationRow,
    level: ChainLevel,
    ringingVersion: number,
    t: Date,
    state: RingState,
  ): Promise<void> {
    const base = {
      escalationId: row.id,
      callSid: row.callSid,
      levelIndex: row.levelIndex,
      role: level.role,
      providerId: storedProviderId(level.providerId),
      attemptNo: row.attemptNo,
      mode: row.mode,
      routingReason: row.routing.reason,
    };

    if (!isPhone(level.phone)) {
      const a = await store.logAttempt({ ...base, kind: "call", dialedTo: null, outcome: "failed", endedAt: t });
      log(`[ON-CALL] ${row.callSid}: level ${row.levelIndex} (${level.role}) has no phone number; moving to the next level`);
      await advance(a.escalationId, a.levelIndex, a.attemptNo, { retryThisLevel: false });
      return;
    }

    let smsSid: string | null = null;
    let smsOk = false;
    try {
      smsSid = (
        await deps.sendSms({ to: level.phone, from: config.callerId, body: textFor(row, attemptNote(row)) })
      ).sid;
      smsOk = true;
    } catch (err) {
      log(`[ON-CALL] ${row.callSid}: text to level ${row.levelIndex} failed: ${(err as Error)?.message ?? err}`);
    }
    await store.logAttempt({
      ...base,
      kind: row.attemptNo === 1 ? "sms" : "nudge_sms",
      dialedTo: level.phone,
      outcome: smsOk ? "sent" : "send_failed",
      smsSid,
      endedAt: now(),
    });

    const logged = await store.logAttempt({ ...base, kind: "call", dialedTo: level.phone });
    state.call = logged;
    // The text and the two writes above can each take a while (Twilio's own
    // request timeout is 30 s, and the Hub pool has none), and a ringing row
    // is due again at the ringing guard. If the chain moved on meanwhile, a
    // call placed now would ring a level the chain has left, so the row is
    // read once more first: anything that touched it since the "ringing"
    // write bumped its version (review of #514, round 4).
    const current = await store.getEscalation(row.id);
    if (!current || current.status !== "active" || current.version !== ringingVersion) {
      // The chain moved on, so nothing here moves it again, even if this
      // write fails (an attempt left open here rang nobody).
      try {
        await store.endAttempt(logged.id, "failed", now());
      } catch (err) {
        log(`[ON-CALL] ${row.callSid}: could not end level ${row.levelIndex}'s unplaced call: ${(err as Error)?.message ?? err}`);
      }
      log(
        `[ON-CALL] ${row.callSid}: the chain moved on while level ${row.levelIndex}'s text was being sent; that level is not called`,
      );
      return;
    }
    let placed: { sid: string };
    try {
      placed = await deps.placeCall({
        to: level.phone,
        from: config.callerId,
        twiml: providerCallTwiml(url(ON_CALL_ACK_PATH, logged.id)),
        statusCallback: url(ON_CALL_STATUS_PATH, logged.id),
        timeout: PROVIDER_RING_SECONDS,
        timeLimit: PROVIDER_CALL_LIMIT_SECONDS,
      });
    } catch (err) {
      log(`[ON-CALL] ${row.callSid}: the call to level ${row.levelIndex} could not be placed: ${(err as Error)?.message ?? err}`);
      await endAndAdvance(logged, "failed");
      return;
    }
    state.placed = true;
    // Twilio has the call and the phone is ringing. A failed write of its sid
    // must not read as a call that was never placed: the attempt stays open,
    // and the ack and status webhooks find it by the attempt id in their URLs.
    // Without the sid it cannot be hung up if another call takes the patient;
    // it rings out on its own after PROVIDER_RING_SECONDS.
    try {
      await store.setAttemptCallSid(logged.id, placed.sid);
    } catch (err) {
      log(
        `[ON-CALL] ${row.callSid}: the call to level ${row.levelIndex} is ringing but its call sid could not be saved: ${(err as Error)?.message ?? err}`,
      );
    }
    log(`[ON-CALL] ${row.callSid}: calling level ${row.levelIndex} (${level.role}), attempt ${row.attemptNo}`);
  }

  /** A ringing row past its guard: the call's status never came back. */
  async function guardExpired(row: EscalationRow): Promise<void> {
    const open = (await store.attemptsFor(row.callSid)).filter(
      (a) =>
        a.escalationId === row.id &&
        a.kind === "call" &&
        a.levelIndex === row.levelIndex &&
        a.attemptNo === row.attemptNo &&
        a.outcome === "in_progress",
    );
    for (const a of open) {
      // The call should be over by now (its time limit is shorter than the
      // guard), but hang it up anyway so a lost status cannot leave it ringing.
      // Ended first, so the status the hang-up brings back moves nothing.
      await store.endAttempt(a.id, "no_status", now());
      await hangUp(a.providerCallSid, a.callSid);
    }
    log(`[ON-CALL] ${row.callSid}: no status for level ${row.levelIndex} attempt ${row.attemptNo}; moving on`);
    await advance(row.id, row.levelIndex, row.attemptNo);
  }

  /** Bring an active row due now, so the next tick reads it. */
  async function dueNow(escalationId: number): Promise<EscalationRow | null> {
    for (let i = 0; i < 3; i++) {
      const cur = await store.getEscalation(escalationId);
      if (!cur || cur.status !== "active") return cur;
      const due = await store.updateEscalation(cur.id, cur.version, { nextAt: now(), releaseLease: true });
      if (due) return due;
    }
    return await store.getEscalation(escalationId);
  }

  /**
   * Close an escalation whose in-call transfer was taken. With the transfer's
   * accepted row logged, a close that cannot land brings the row due now: the
   * next tick finds that row and closes the chain on it, instead of the row
   * sitting active for a day. Without it, the row is closed directly, and if
   * even that fails it is left for the stale guard, which rings nobody.
   */
  async function settleAccepted(
    escalationId: number,
    warm: AttemptRow | null,
    fallback: { acceptedBy: number | null; acceptedAt: Date },
  ): Promise<EscalationRow | null> {
    if (warm) {
      const { row } = await closeAsTaken(escalationId, warm);
      if (row) return row;
      log(`[ON-CALL] escalation ${escalationId}: the taken transfer's close did not land; brought due so the next tick closes it`);
      return await dueNow(escalationId);
    }
    for (let i = 0; i < 3; i++) {
      const cur = await store.getEscalation(escalationId);
      if (!cur || cur.status !== "active") return cur;
      const closed = await store.closeEscalation(cur.id, cur.version, {
        status: "accepted",
        ...fallback,
        acceptedAttemptId: null,
        nextAt: null,
      });
      if (closed) return closed;
    }
    return await store.getEscalation(escalationId);
  }

  async function step(row: EscalationRow): Promise<void> {
    if (row.phase === "ringing") await guardExpired(row);
    else await ring(row);
  }

  const runner: OnCallRunner = {
    async afterInCallTransfer(r) {
      if (r.plan.levels.length === 0) return null;
      const first = r.plan.levels[0];
      const accepted = r.warm.outcome === "accepted";
      const takenBy = { acceptedBy: storedProviderId(first.providerId), acceptedAt: r.warm.endedAt };
      let opened: EscalationRow | null = null;
      let joined: EscalationRow | null = null;
      let warm: AttemptRow | null = null;
      try {
        opened = await store.openEscalation({
          callSid: r.callSid,
          mode: r.mode,
          routing: r.routing,
          plan: r.plan,
          details: r.details,
          callerNumber: r.callerNumber,
          // An accepted transfer is closed straight away; until then nothing may claim it.
          nextAt: accepted
            ? new Date(r.warm.endedAt.getTime() + 24 * 3_600_000)
            : new Date(
                Math.min(
                  r.warm.endedAt.getTime() + RETRY_GAP_MS,
                  r.levelStartedAt.getTime() + LEVEL_RETRY_DEADLINE_MS,
                ),
              ),
          levelStartedAt: r.levelStartedAt,
          attemptNo: 2,
        });
        const logHandOff = async (escalationId: number): Promise<AttemptRow> => {
          const base = {
            escalationId,
            callSid: r.callSid,
            levelIndex: 0,
            role: first.role,
            providerId: storedProviderId(first.providerId),
            attemptNo: 1,
            mode: r.mode,
            routingReason: r.routing.reason,
          };
          if (r.preDialSms) {
            await store.logAttempt({
              ...base,
              kind: "sms",
              dialedTo: first.phone,
              outcome: r.preDialSms.ok ? "sent" : "send_failed",
              smsSid: r.preDialSms.sid,
              endedAt: r.preDialSms.at,
            });
          }
          return await store.logAttempt({
            ...base,
            kind: "warm_transfer",
            dialedTo: r.warm.dialedTo,
            outcome: r.warm.outcome,
            providerCallSid: r.warm.providerCallSid ?? null,
            endedAt: r.warm.endedAt,
          });
        };

        if (!opened) {
          /**
           * THIS CALL'S CHAIN WAS ALREADY OPEN, so this hand-off opened
           * nothing (review of #514, round 8). Reached when the call's chain
           * claim was released after `HANDOFF_SETTLE_MS` while the first
           * hand-off's open was still in flight, and a second escalation then
           * rang level 0 again. Its text and its call are still logged, on
           * the open chain, because they happened. The answer is the open
           * chain only while it is paging: a chain somebody has taken is
           * closed here rather than reported as carrying on, and when this
           * hand-off's own call was taken, the open chain is closed on it.
           */
          const existing = await store.getEscalationByCall(r.callSid);
          joined = existing;
          if (!existing) {
            log(`[ON-CALL] ${r.callSid}: the escalation could not be opened and none is on record; nothing is carried on`);
            return null;
          }
          log(
            `[ON-CALL] ${r.callSid}: this call's chain was already open (escalation ${existing.id}); this hand-off opened nothing and its attempts are logged on that chain`,
          );
          warm = await logHandOff(existing.id);
          // A chain that has finished is answered as it is: both helpers below
          // stop on a row that is no longer active and hand back its fresh read.
          if (accepted) return await settleAccepted(existing.id, warm, takenBy);
          const taken = await acceptedAttempt(existing);
          if (taken) {
            const { row } = await closeAsTaken(existing.id, taken);
            return row ?? (await store.getEscalation(existing.id));
          }
          return existing;
        }

        warm = await logHandOff(opened.id);

        if (!accepted) {
          log(`[ON-CALL] ${r.callSid}: the transfer was not taken (${r.warm.outcome}); the chain will carry on`);
          return opened;
        }
        return await settleAccepted(opened.id, warm, takenBy);
      } catch (err) {
        log(`[ON-CALL] ${r.callSid}: the escalation could not be recorded: ${(err as Error)?.message ?? err}`);
        if (accepted) {
          // The provider has the patient. Close what was opened, or the
          // open chain this hand-off joined, best effort; nothing is rung
          // either way.
          const chain = opened ?? joined;
          if (chain) {
            try {
              await settleAccepted(chain.id, warm, takenBy);
            } catch (again) {
              log(`[ON-CALL] ${r.callSid}: the taken transfer's escalation is still open: ${(again as Error)?.message ?? again}`);
            }
          }
        } else if (opened) {
          // The chain's row is open and due: the next tick rings attempt 2 and
          // the levels after it. Only the first attempt's log rows are missing,
          // so nobody is told the chain did not start.
          log(
            `[ON-CALL] ${r.callSid}: the chain is open and carries on; its first attempt may be missing from on_call_attempts`,
          );
          return opened;
        } else if (joined) {
          // Another hand-off's chain is open for this call, so the urgent
          // number is not told the escalation could not start. Whether it is
          // still paging was not confirmed, so nothing says it is.
          log(
            `[ON-CALL] ${r.callSid}: this call's chain (escalation ${joined.id}) is open; this hand-off's attempts may be missing from on_call_attempts`,
          );
        } else {
          const note =
            (r.mode === "test" ? "[TEST MODE] " : "") +
            "THE ON-CALL ESCALATION COULD NOT START — the transfer was not taken and nobody else will be called. " +
            "Please call this patient back now.";
          await notifyQuietly(
            buildUrgentTransferSms(
              {
                callerNumber: r.callerNumber ?? undefined,
                escalationDetails: (r.details ?? undefined) as any,
                note,
                kind: "callback",
              },
              urgentAlertTime(now()),
            ),
            r.callSid,
            r.mode,
            r.plan,
          );
        }
        return null;
      }
    },

    async tick() {
      if (running) return;
      if (lateTicks.size >= MAX_LATE_TICKS) {
        if (!pauseLogged) {
          pauseLogged = true;
          log(
            `[ON-CALL] ${lateTicks.size} ticks are still waiting on a send or the store; no new rows are claimed until one of them answers`,
          );
        }
        return;
      }
      pauseLogged = false;
      running = true;
      // Each claimed row is stepped on its own, side by side: a row whose text
      // or call never answers does not hold the rows claimed with it.
      const work = (async () => {
        if (!(await store.available())) return;
        const rows = await store.claimDue(now(), CLAIM_LEASE_MS, CLAIM_LIMIT);
        await Promise.allSettled(
          rows.map(async (row) => {
            try {
              await step(row);
            } catch (err) {
              log(`[ON-CALL] ${row.callSid}: step failed: ${(err as Error)?.message ?? err}`);
            }
          }),
        );
      })().catch((err) => {
        log(`[ON-CALL] tick failed: ${(err as Error)?.message ?? err}`);
      });
      let budget: NodeJS.Timeout | undefined;
      const outOfTime = new Promise<"late">((resolve) => {
        budget = setTimeout(() => resolve("late"), deps.tickBudgetMs ?? TICK_BUDGET_MS);
        budget.unref?.();
      });
      try {
        if ((await Promise.race([work.then(() => "done" as const), outOfTime])) === "late") {
          log("[ON-CALL] a tick is still waiting on a send or the store; the next tick runs without it");
          const token = Symbol("late tick");
          lateTicks.add(token);
          const forget = setTimeout(() => lateTicks.delete(token), deps.lateTickForgetMs ?? LATE_TICK_FORGET_MS);
          forget.unref?.();
          void work.finally(() => {
            clearTimeout(forget);
            lateTicks.delete(token);
          });
        }
      } finally {
        if (budget) clearTimeout(budget);
        running = false;
      }
    },

    async onProviderAck(attemptId, digits) {
      const a = await store.getAttempt(attemptId);
      if (!a || a.kind !== "call") return "closed";
      const e = await store.getEscalation(a.escalationId);
      if (!e) return "closed";
      if (e.status !== "active") {
        if (e.status !== "accepted") return "closed";
        // The same call's key press arriving twice is still the call that took it.
        return e.acceptedAttemptId === a.id ? "accepted" : "already_taken";
      }

      if (!digits) {
        // Picked up and pressed nothing: today's warm transfer reads that as
        // declined, and so does this. Either way the chain carries on.
        await endAndAdvance(a, "declined");
        return "declined";
      }

      let by = await store.endAttempt(a.id, "accepted", now());
      if (!by) {
        // This call is already over in our records. Another of the chain's
        // calls took the patient and hung this one up; or the provider is on
        // a call we had marked over (a dial we recorded as failed that Twilio
        // placed after all, or the ringing guard); or its key press came
        // twice. A provider pressing a key while the chain is still running
        // has the patient, so the late press takes it (review of #514, round
        // 10): telling them it is closed would keep ringing the next level.
        // acceptLate refuses a call another took (taken_elsewhere), one
        // already accepted, and any call of a chain that has ended; the read
        // after it says which.
        const was = (await store.getAttempt(a.id))?.outcome;
        by = await store.acceptLate(a.id, now());
        if (by) {
          log(`[ON-CALL] ${a.callSid}: a key press on a call recorded ${was ?? "over"} at level ${a.levelIndex}; it takes the patient`);
        } else {
          const after = await store.getAttempt(a.id);
          if (after?.outcome === "taken_elsewhere") return "already_taken";
          if (after?.outcome !== "accepted") {
            // The chain ended between the read above and this press: another
            // call took the patient, or nobody did.
            return (await store.getEscalation(e.id))?.status === "accepted" ? "already_taken" : "closed";
          }
          by = after;
        }
      }
      let { row, byThis } = await closeAsTaken(e.id, by);
      if (!row) {
        // The close did not land. Bring the row due, as the in-call transfer's
        // settle does, so the next tick finds this key press and closes the
        // chain on it now, instead of the row reading active until the ringing
        // guard. Nothing is rung meanwhile: every move looks for the accepted
        // attempt before it moves on.
        try {
          const due = await dueNow(e.id);
          if (due && due.status !== "active") {
            row = due;
            byThis = false;
          }
        } catch (err) {
          log(`[ON-CALL] ${a.callSid}: could not bring the taken chain due: ${(err as Error)?.message ?? err}`);
        }
      }
      if (row && row.status !== "accepted") return "closed";
      if (row && !byThis && row.acceptedAttemptId !== by.id) {
        // Closed by someone else: by another call's key press, or by a move
        // that found theirs. The escalation row names the call that took the
        // patient, and only that call is told it has them. It names the CALL,
        // not the provider: a test-mode chain's synthetic levels store no
        // provider id, so two of them would both read null in accepted_by.
        // (A lower attempt id is not the winner: two key presses can each
        // record `accepted` before either close lands, and the close that
        // lands first is the one the row keeps.)
        return "already_taken";
      }
      // Taken, whether or not the close won its race: the attempt says
      // accepted, and the next move closes the escalation on it.
      log(`[ON-CALL] ${a.callSid}: taken at level ${a.levelIndex} (${a.role}), attempt ${a.attemptNo}`);
      return "accepted";
    },

    async onProviderStatus(attemptId, callStatus) {
      const outcome = outcomeForCallStatus(callStatus);
      if (!outcome) return;
      const a = await store.getAttempt(attemptId);
      if (!a || a.kind !== "call") return;
      await endAndAdvance(a, outcome);
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void runner.tick(), TICK_MS);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return runner;
}
