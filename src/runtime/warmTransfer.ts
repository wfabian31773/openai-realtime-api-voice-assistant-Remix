/**
 * A real call transfer on the Media Streams transport.
 *
 * This is the tool the runtime has been refusing. `laneRegistry.ts` hands every
 * factory a `refuseHandoff` that throws, and five lanes — `no-ivr`,
 * `no-ivr-v2`, `dev-no-ivr`, `azul-scheduling`, `pcp` — are declined outright
 * because "serving it would turn a sanctioned transfer into a guaranteed
 * failure". This module is what lets that refusal be lifted.
 *
 * ## The transport forces the ordering, and the ordering is the safety property
 *
 * On the SIP path the caller is already sitting in a Twilio conference, so a
 * transfer is `conferences(name).participants.create` — dial a human into the
 * room the caller is already in. If nobody answers, the caller is still there
 * with the agent.
 *
 * There is no conference here. `<Connect><Stream>` occupies the caller's TwiML
 * verb slot exclusively; moving them means `calls(sid).update({twiml})`, which
 * **ends the stream** — and with it the agent's ability to say anything at all.
 * So a transfer that moves the caller first and dials second would drop them
 * into an empty conference with no agent and no way to recover.
 *
 * Hence:
 *
 *   1. The caller keeps the agent. Nothing about their leg changes yet.
 *   2. Dial the office. It hears who is calling and why, and must press a key.
 *   3. ONLY on a positive accept, redirect the caller into the conference the
 *      office is already waiting in.
 *   4. On decline, no-answer, or any error — the caller still has the agent,
 *      the tool returns a failure, and the agent files a ticket instead.
 *
 * The caller is never moved until a human has demonstrably picked up. On the
 * SIP path a failed dial can leave someone holding alone; here that is
 * structurally impossible rather than carefully avoided.
 *
 * ## Why a keypress and not silence
 *
 * Answering-machine detection judges from the first audio on the line, so a
 * staffed hunt group with a recorded greeting scores `machine` and the handler
 * hangs up on live people — that is what happened to the first PCP transfers
 * (`voiceAgentRoutes.ts`, the AMD note). A digit is positive proof of a person
 * and needs no verdict. The briefing and its press prompt are built by
 * `buildWarmTransferScript`, which is tested to promise no other way in.
 *
 * ## Failure is reported, never swallowed
 *
 * Every failure path throws. A handoff callback that resolves on a blocked or
 * failed transfer lets the agent tell the caller "connecting you now" while
 * nobody was dialled — observed live on 2026-08-04, and the reason
 * `.agents/memory/handoff-silent-failures.md` exists. The error text the model
 * sees is a fixed status slug; the detailed reason stays in the server log.
 */
import { buildWarmTransferScript } from "../services/warmTransferBriefing";

/** How the office leg's outcome came back. */
export type TransferOutcome =
  | { ok: true; destination: string; officeCallSid: string }
  | {
      ok: false;
      status: "NO_ANSWER" | "DECLINED" | "FAILED" | "UNAVAILABLE";
      reason: string;
      destination?: string;
    };

/** The Twilio operations this needs, narrowed to exactly four. */
export interface TransferTwilioOps {
  /** Dial the office leg with the briefing TwiML. Resolves to its CallSid. */
  createOfficeLeg(input: {
    to: string;
    from: string;
    twiml: string;
    timeoutSeconds: number;
    /** Posted the leg's terminal status, so a dial that ends without ever
     * accepting — no-answer, busy, failed — settles the wait immediately
     * instead of running out the whole widened window (Codex, PR #230
     * round 2). */
    statusCallbackUrl?: string;
  }): Promise<{ sid: string }>;
  /** Move the caller's live leg into the conference. Ends the media stream. */
  redirectCallerToConference(input: {
    callerCallSid: string;
    conferenceName: string;
    callerId?: string;
  }): Promise<void>;
  /** Hang up an office leg we dialled but will not use. */
  endCall(callSid: string): Promise<void>;
}

/**
 * Resolves when the office presses a key, rejects when it declines or the
 * window closes. Supplied by the accept webhook, which is the only thing that
 * knows a digit arrived.
 */
export type AcceptSignal = (officeCallSid: string) => Promise<void>;

export interface WarmTransferDeps {
  twilio: TransferTwilioOps;
  awaitAccept: AcceptSignal;
  /** Absolute URL the office leg's `<Gather>` posts its digit to. */
  acceptUrl: string;
  /** Absolute URL the office leg posts its terminal status to, so a dial
   * that dies without accepting settles the wait early. Optional — the
   * window is still a hard backstop without it. */
  statusUrl?: string;
  /** The number the office sees as the caller. */
  fromNumber: string;
  /** Caller ID to present when the caller is redirected, if the lane sets one. */
  callerId?: string;
  /** Invoked immediately BEFORE the caller's leg is redirected — the
   * redirect ends the Media Stream, and the resulting close must be
   * recorded as a transfer, not a caller hangup; the close can race the
   * redirect's own resolution, so the mark has to precede it (Codex,
   * PR #230 round 2). */
  onCallerRedirectStarting?: () => void;
  /** Invoked FIRST in the redirect's failure path, so a later genuine
   * hangup on the still-live call is not mislabeled as a transfer. */
  onCallerRedirectFailed?: () => void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface WarmTransferRequest {
  /** The caller's live Twilio leg — the one carrying the media stream. */
  callerCallSid: string;
  /** Where to send them. Resolved by policy; the model never supplies it. */
  destination: string | null | undefined;
  /** Who is calling and why, spoken to the office before it accepts. */
  briefing: string;
  /** Conference both legs meet in. Derived from the caller's SID. */
  conferenceName?: string;
}

/** Twilio rings this long before giving up on the office leg. */
export const OFFICE_DIAL_TIMEOUT_SECONDS = 45;

/**
 * Time budgeted for the office to HEAR the briefing and press a key once
 * it answers: the press prompt, the briefing (≤MAX_BRIEFING_CHARS
 * spoken), the first Gather's 8s, and most of the repeat cycle.
 */
export const BRIEFING_BUDGET_MS = 75_000;

/**
 * The budget above ASSUMES a briefing this long — the cap is what makes
 * the assumption true. Escalation reasons are model-written and the
 * schemas allow narratives far past it (PCP up to 12,000 characters), and
 * a briefing that long still had the staffer listening to details when
 * the accept window expired and hung up their leg (Codex, PR #230
 * round 4). Same 800 the SIP path slices to (voiceAgentRoutes) — the
 * head of the briefing carries the identity and the reason; the tail is
 * detail the humans exchange once bridged.
 */
export const MAX_BRIEFING_CHARS = 800;

/**
 * The accept window: the full ring window PLUS the briefing budget.
 *
 * Measured on the real PCP queue, ring-to-accept ran 17, 20, 27, 28, 29,
 * 30, 35, 35, 35, 40, 40 and 41 seconds — ten of twelve longer than
 * twenty. The window used to EQUAL the 45s dial timeout, and it starts
 * when the dial is created: an office answering at the measured 40–41s
 * had seconds or nothing left to hear the briefing and press before the
 * registry expired its leg (Codex, PR #230 round 2). The window is a
 * hard backstop only — a keypress, a decline, and (via the status
 * webhook) a dial that dies unanswered all settle it early, so widening
 * it costs nothing on the paths that resolve.
 */
export const ACCEPT_WINDOW_MS = OFFICE_DIAL_TIMEOUT_SECONDS * 1000 + BRIEFING_BUDGET_MS;

export function conferenceNameFor(callerCallSid: string): string {
  return `runtime_xfer_${callerCallSid}`;
}

/**
 * Attempt a warm transfer. Resolves only when the caller has been moved to a
 * human who accepted; throws otherwise.
 */
export async function performWarmTransfer(
  request: WarmTransferRequest,
  deps: WarmTransferDeps,
): Promise<TransferOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const destination = request.destination?.trim();

  if (!destination) {
    // No number configured is not a dial failure — nothing was attempted, and
    // saying so lets the agent take a message instead of implying it tried.
    return {
      ok: false,
      status: "UNAVAILABLE",
      reason: "transfer_destination_not_configured",
    };
  }

  const conferenceName = request.conferenceName ?? conferenceNameFor(request.callerCallSid);
  // RAW slice, before the script builder escapes it — slicing escaped text
  // could cut an entity in half, and the budget is about SPOKEN length.
  const twiml = buildWarmTransferScript({
    say: request.briefing.slice(0, MAX_BRIEFING_CHARS),
    acceptUrl: deps.acceptUrl,
  });

  let officeCallSid: string;
  try {
    const created = await deps.twilio.createOfficeLeg({
      to: destination,
      from: deps.fromNumber,
      twiml,
      timeoutSeconds: OFFICE_DIAL_TIMEOUT_SECONDS,
      ...(deps.statusUrl ? { statusCallbackUrl: deps.statusUrl } : {}),
    });
    officeCallSid = created.sid;
  } catch (err) {
    log(
      `[runtime-xfer] dial to ${destination} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, status: "FAILED", reason: "dial_failed", destination };
  }

  log(`[runtime-xfer] office leg ${officeCallSid} ringing ${destination}; caller still with the agent`);

  try {
    await deps.awaitAccept(officeCallSid);
  } catch (err) {
    // Declined, machine, or the window closed. The caller has not moved and
    // still has the agent, so the only cleanup is the leg we dialled.
    const reason = err instanceof Error ? err.message : String(err);
    log(`[runtime-xfer] office leg ${officeCallSid} did not accept: ${reason}`);
    await endQuietly(deps, officeCallSid, log);
    return {
      ok: false,
      status: reason === "declined" ? "DECLINED" : "NO_ANSWER",
      reason: reason === "declined" ? "office_declined" : "office_no_answer",
      destination,
    };
  }

  // A human is on the line and has pressed a key. Only now does the caller move.
  try {
    // Marked BEFORE the redirect: the redirect ends the Media Stream, and
    // the resulting close can race this await's own resolution — an
    // unmarked close records the transfer as a caller hangup (Codex,
    // PR #230 round 2).
    deps.onCallerRedirectStarting?.();
    await deps.twilio.redirectCallerToConference({
      callerCallSid: request.callerCallSid,
      conferenceName,
      callerId: deps.callerId,
    });
  } catch (err) {
    // FIRST: the caller never moved, so a later genuine hangup on this
    // still-live call must not be mislabeled as a transfer.
    deps.onCallerRedirectFailed?.();
    // The office is holding an empty conference and the caller never left the
    // agent. Ending the office leg is what stops a staffer sitting in silence.
    log(
      `[runtime-xfer] caller redirect failed after an accept: ${err instanceof Error ? err.message : String(err)}`,
    );
    await endQuietly(deps, officeCallSid, log);
    return {
      ok: false,
      status: "FAILED",
      reason: "caller_redirect_failed",
      destination,
    };
  }

  log(`[runtime-xfer] caller ${request.callerCallSid} joined ${conferenceName} with ${destination}`);
  return { ok: true, destination, officeCallSid };
}

/**
 * Cleanup must never mask the reason we are cleaning up.
 *
 * If ending the office leg throws, the transfer still failed for the reason
 * that got us here, and that is what the caller's agent needs to act on.
 */
async function endQuietly(
  deps: WarmTransferDeps,
  callSid: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await deps.twilio.endCall(callSid);
  } catch (err) {
    log(
      `[runtime-xfer] could not end office leg ${callSid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The callback shape agent factories expect, wrapping the transfer above.
 *
 * Factories take `() => Promise<void>`: resolve means transferred, throw means
 * it did not happen. The thrown text is a fixed slug because it reaches the
 * model — a raw provider error in a prompt is how internal vocabulary ends up
 * spoken to a patient.
 */
export function handoffCallbackFor(
  request: () => WarmTransferRequest,
  deps: WarmTransferDeps,
): () => Promise<void> {
  return async () => {
    const outcome = await performWarmTransfer(request(), deps);
    if (!outcome.ok) {
      throw new Error(`handoff_failed:${outcome.status}`);
    }
  };
}
