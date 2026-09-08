/**
 * WHAT HAPPENED AFTER WE LET GO — the `<Dial action>` callback of a blind
 * transfer.
 *
 * The warm path learns a human is there from a keypress. A blind transfer has
 * no keypress, so without this endpoint the record would stop at
 * `handed_to_queue` forever and "did the PCP queue actually answer?" would be
 * unanswerable from our own data — the exact shape of the `transfer_outcome`
 * blindness that made this week's PCP forensic impossible.
 *
 * Twilio posts here when the `<Dial>` ENDS, whichever way it ended, carrying
 * `DialCallStatus` and `DialCallDuration`. Two jobs, in this order:
 *
 *   1. RECORD what the dial did. This is the measurement.
 *   2. SAY something, if the caller is still on the line with nobody. When the
 *      dial never connected the caller is sitting on a leg whose agent died
 *      with the redirect, so the response TwiML is the only voice left.
 *
 * ## The status vocabulary, and why `completed` is not `accepted`
 *
 * `DialCallStatus: 'completed'` means the dialled leg ANSWERED and has since
 * ended. Against a call centre that is an ACD picking up, not a person
 * speaking — the caller may have spent all of it in hold music and hung up. So
 * it records as `queue_answered` with the bridge duration beside it, never as
 * `accepted`, which stays reserved for the warm path's proof-of-human. A
 * two-second `talkSeconds` is what tells those apart later, and it can only do
 * that if the two are not already collapsed into one word here.
 */
import { BLIND_TRANSFER_NO_ANSWER } from "./blindTransfer";
import {
  blindTransferVoice,
  buildDialCompletedTwiml,
  buildDialFailedTwiml,
} from "./transferTwilioOps";
import type { RuntimeTransferOutcome, TransferAttemptId } from "./transferOutcomeLog";
import { checkTwilioSignature, type WebhookRequest, type WebhookResponse } from "./voiceWebhook";

const XML = "text/xml";

function xml(body: string, status = 200): WebhookResponse {
  return { status, contentType: XML, body };
}

/** What the runtime remembers about a blind transfer while its dial runs. */
export interface PendingBlindDial {
  /** So a later attempt on the same call does not overwrite this one's record. */
  attemptId: TransferAttemptId;
  destination: string;
  /** When the redirect went out, for the ring calculation. */
  redirectedAtMs: number;
  briefingGaps?: string[];
  askedBeforeDial?: boolean;
}

export interface DialResultDeps {
  env: Record<string, string | undefined>;
  /** The pending dial for this caller, if the process still remembers it. */
  pendingFor: (callerCallSid: string) => PendingBlindDial | undefined;
  /** Dropped once the dial has settled. */
  forget: (callerCallSid: string) => void;
  /** Writes the outcome. Injected so this handler stays a pure decision. */
  record: (
    callerCallSid: string,
    outcome: Omit<RuntimeTransferOutcome, "pipeline" | "attempt" | "at">,
    attemptId: TransferAttemptId,
  ) => void;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Twilio's dial statuses, mapped to what we record.
 *
 * `answered` is a Twilio status only on `<Dial>` legs that are still up; it
 * cannot reach an `action` callback, but it is mapped rather than dropped so a
 * Twilio change adds a row instead of silently becoming `failed`.
 */
export function classifyDialStatus(status: string): {
  outcome: RuntimeTransferOutcome["outcome"];
  connected: boolean;
} {
  switch (status.trim().toLowerCase()) {
    case "completed":
    case "answered":
      return { outcome: "queue_answered", connected: true };
    case "no-answer":
    case "busy":
      return { outcome: "no_answer", connected: false };
    case "canceled":
    case "cancelled":
    case "failed":
      return { outcome: "failed", connected: false };
    default:
      // An unknown status is NOT quietly a failure — it is recorded verbatim in
      // `status` beside a `failed` outcome, so a new Twilio value shows up as a
      // named surprise rather than as a fake no-answer.
      return { outcome: "failed", connected: false };
  }
}

export function handleBlindDialResult(
  req: WebhookRequest,
  deps: DialResultDeps,
): WebhookResponse {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const voice = blindTransferVoice(deps.env);

  const sig = checkTwilioSignature(req, deps.env);
  if (sig === "no_auth_token" || sig === "invalid") {
    // Same fail-closed shape every runtime webhook uses: a 200 with controlled
    // TwiML, never a 5xx, because Twilio plays its own error handling on any
    // 5xx regardless of content. A forged POST here can only make us hang up a
    // call we no longer control, so hanging up is the safe answer.
    log(`[runtime-xfer] dial-result webhook refused: ${sig}`);
    return xml(buildDialCompletedTwiml());
  }

  const callerCallSid = String(req.body.CallSid ?? "").trim();
  const dialStatus = String(req.body.DialCallStatus ?? "").trim();
  const { outcome, connected } = classifyDialStatus(dialStatus);
  const talkSeconds = Number.parseInt(String(req.body.DialCallDuration ?? ""), 10);

  const pending = callerCallSid ? deps.pendingFor(callerCallSid) : undefined;
  if (pending) {
    // Ring time is what is LEFT after the bridge: Twilio calls this handler
    // when the dial ends, so the elapsed span covers ringing plus talking.
    // Clamped at zero rather than trusted — the two clocks are not the same
    // clock, and a negative ring second would be a lie with a minus sign.
    const elapsedSeconds = Math.round((now() - pending.redirectedAtMs) / 1000);
    const talked = Number.isFinite(talkSeconds) && talkSeconds >= 0 ? talkSeconds : 0;
    deps.record(
      callerCallSid,
      {
        outcome,
        // The provider's own word, verbatim. `outcome` is our reading of it and
        // a reading can be wrong; this is the evidence it was read from.
        status: dialStatus ? dialStatus.toUpperCase() : "NO_DIAL_STATUS",
        ...(connected ? {} : { reason: `queue_${outcome}` }),
        dialedNumber: pending.destination,
        ringSeconds: Math.max(0, elapsedSeconds - talked),
        ...(connected ? { talkSeconds: talked, acceptMethod: "dial_answered" as const } : {}),
        method: "blind" as const,
        ...(pending.briefingGaps ? { briefingGaps: pending.briefingGaps } : {}),
        ...(pending.askedBeforeDial !== undefined
          ? { askedBeforeDial: pending.askedBeforeDial }
          : {}),
      },
      pending.attemptId,
    );
    deps.forget(callerCallSid);
    log(
      `[runtime-xfer] blind dial for ${callerCallSid} ended ${dialStatus || "(no status)"} ` +
        `after ${talked}s bridged`,
    );
  } else {
    // No memory of this dial — a redeploy mid-call, or a callback for a leg
    // this process never redirected. The caller still deserves the right TwiML,
    // so the response below is decided from the status alone.
    log(
      `[runtime-xfer] dial-result for ${callerCallSid || "(no sid)"} had no pending record; ` +
        `status ${dialStatus || "(none)"} not written`,
    );
  }

  // CONNECTED means the two legs talked and the far end has now hung up;
  // there is nothing left to say and nobody to say it to. Anything else means
  // the caller is still holding a line with no agent behind it.
  return xml(
    connected ? buildDialCompletedTwiml() : buildDialFailedTwiml(BLIND_TRANSFER_NO_ANSWER, voice),
  );
}
