/**
 * The endpoint the office leg's `<Gather>` posts its keypress to.
 *
 * This is the other half of the accept registry: the registry holds the
 * pending transfer, and this turns an HTTP request from Twilio into a settle.
 * Pure, like the other runtime webhooks — it returns a `WebhookResponse` and
 * touches no Express types, so the whole decision table is testable without a
 * server.
 *
 * ## Signature validation is not optional here
 *
 * A forged POST to this path bridges an arbitrary caller into a conference
 * with whoever is on the office leg. It fails closed the same way
 * `voiceWebhook.ts` does: no auth token configured is a 200 with a controlled
 * hangup rather than a 5xx, because Twilio treats ANY 5xx as a failure and
 * plays its own error handling instead of ours.
 */
import {
  buildDeclinedTransferTwiml,
  buildExpiredTransferTwiml,
  buildOfficeAcceptTwiml,
} from "./transferTwilioOps";
import type { TransferAcceptRegistry } from "./transferAccepts";
import { checkTwilioSignature, type WebhookRequest, type WebhookResponse } from "./voiceWebhook";

export interface TransferAcceptDeps {
  env: Record<string, string | undefined>;
  accepts: TransferAcceptRegistry;
  /** The conference this office leg was dialled for. */
  conferenceFor: (officeCallSid: string) => string | undefined;
  log?: (line: string) => void;
}

const XML = "text/xml";

function xml(body: string, status = 200): WebhookResponse {
  return { status, contentType: XML, body };
}

export function handleTransferAccept(
  req: WebhookRequest,
  deps: TransferAcceptDeps,
): WebhookResponse {
  const log = deps.log ?? ((line: string) => console.log(line));

  // The same gate every runtime webhook uses (voiceWebhook.ts) — one
  // signature implementation, not two that can drift.
  const sig = checkTwilioSignature(req, deps.env);
  if (sig === "no_auth_token") {
    // 200 with a controlled hangup, never a 5xx: Twilio treats any 5xx as a
    // failure regardless of content and plays its own handling instead of
    // ours (server/index.ts:93).
    log("[runtime-xfer] accept webhook refused: no TWILIO_AUTH_TOKEN configured");
    return xml(buildExpiredTransferTwiml());
  }
  if (sig === "invalid") {
    // A forged accept would bridge a stranger into a live conference.
    log("[runtime-xfer] accept webhook refused: bad or missing signature");
    return xml(buildExpiredTransferTwiml(), 403);
  }

  const officeCallSid = String(req.body.CallSid ?? "").trim();
  if (!officeCallSid) return xml(buildExpiredTransferTwiml());

  // The conference must be read BEFORE settling: recordDigits drops the entry,
  // and resolving the waiter can let the transfer proceed before this handler
  // has finished building its own response.
  const conferenceName = deps.conferenceFor(officeCallSid);

  const wasPending = deps.accepts.recordDigits(officeCallSid, req.body.Digits);
  if (!wasPending) {
    // Pressed after the window shut, or on a leg nobody is waiting on. The
    // caller has already been told the transfer failed; bridging now is worse
    // than saying so.
    return xml(buildExpiredTransferTwiml());
  }

  const pressed = String(req.body.Digits ?? "").trim();
  if (!pressed) {
    log(`[runtime-xfer] ${officeCallSid} heard the briefing and pressed nothing`);
    return xml(buildDeclinedTransferTwiml());
  }

  if (!conferenceName) {
    // Accepted, but we do not know where to put them. Hanging up is the only
    // honest answer — the caller's agent has already been told the transfer
    // failed by the registry settling, and a conference guess could drop a
    // staffer into a stranger's call.
    log(`[runtime-xfer] ${officeCallSid} accepted but no conference is known for it`);
    return xml(buildExpiredTransferTwiml());
  }

  return xml(buildOfficeAcceptTwiml({ conferenceName }));
}

/**
 * The office leg's terminal-status callback.
 *
 * A dial that dies without ever accepting — no-answer, busy, failed —
 * used to run out the entire accept window before the caller's agent
 * learned anything; with the window widened past the ring time (so a
 * late answer still gets its briefing), that silence would have grown to
 * two minutes. The terminal status settles the wait the moment Twilio
 * knows (Codex, PR #230 round 2). A status for a leg that already
 * settled — accepted, declined, or ended by us — is a no-op.
 */
export function handleTransferStatus(
  req: WebhookRequest,
  deps: Pick<TransferAcceptDeps, "env" | "accepts" | "log">,
): WebhookResponse {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sig = checkTwilioSignature(req, deps.env);
  if (sig === "no_auth_token" || sig === "invalid") {
    // A forged status can only abandon a pending wait early — the caller
    // keeps the agent and gets the ticket fallback — but there is no
    // reason to accept one. Status callbacks ignore the body; 403 either
    // way except the unconfigured case, which stays a controlled 200
    // like every runtime webhook.
    log(`[runtime-xfer] status webhook refused: ${sig}`);
    return xml("<Response/>", sig === "invalid" ? 403 : 200);
  }
  const officeCallSid = String(req.body.CallSid ?? "").trim();
  const status = String(req.body.CallStatus ?? "").trim();
  if (officeCallSid && ["completed", "busy", "failed", "no-answer", "canceled"].includes(status)) {
    if (deps.accepts.abandon(officeCallSid)) {
      log(`[runtime-xfer] office leg ${officeCallSid} ended (${status}) before accepting`);
    }
  }
  return xml("<Response/>");
}
