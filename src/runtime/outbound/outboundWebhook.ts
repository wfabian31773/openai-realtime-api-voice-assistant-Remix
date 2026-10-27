/**
 * src/runtime/outbound/outboundWebhook.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The two webhooks Twilio calls for a call the runtime dialled.
 *
 *   POST /voice/outbound/:slug?contact=…&attempt=…          — answered
 *   POST /voice/outbound/:slug/status?contact=…&attempt=…   — finished
 *
 * Same security posture as the inbound webhook (voiceWebhook.ts), in the
 * same order: no TWILIO_AUTH_TOKEN fails closed, a missing or wrong
 * signature is a 403, and the signature covers the whole URL — so the
 * contact and attempt in the query are the ones the dialer put there.
 *
 * ANSWERED, three ways, decided by Twilio's answering-machine detection
 * BEFORE any agent exists:
 *   - fax              → hang up; the number is not a person's phone.
 *   - machine_*        → the campaign's voicemail line, then hang up. The
 *                        agent is never built, so nothing it could say about
 *                        the person can reach a recording somebody else plays.
 *   - human / unknown  → the same <Connect><Stream> an inbound call gets,
 *                        with the contact and attempt on the registry entry,
 *                        so the call runs through the one bridge, recording,
 *                        transcript, telemetry and teardown every lane uses.
 *                        "unknown" is treated as a person on purpose: hanging
 *                        up on somebody who said "hello" is the worse error.
 *
 * FINISHED: the attempt gets Twilio's verdict; the contact is settled from it
 * ONLY if the call itself has not already settled it (`onlyIfCalling`) —
 * a voicemail left, an opt-out, a booking all outrank "the call ended" —
 * and ONLY if this attempt is still the contact's newest
 * (`onlyIfCurrentAttempt`): a callback that arrives after the stale-claim
 * reaper has handed the row on must not settle the call that came after it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { liveCallRegistry, type LiveCallRegistry, type LiveCallStatus } from "../../plugin/liveSessions";
import { computeRuntimeReadiness } from "../readiness";
import type { CallSessionRegistry } from "../sessionRegistry";
import {
  VOICE_PATH_PREFIX,
  VOICE_STREAM_PATH,
  checkTwilioSignature,
  isValidSlug,
  resolveRequestBase,
  twimlResponse,
  xmlEscape,
  type WebhookRequest,
  type WebhookResponse,
} from "../voiceWebhook";
import type { OutboundLanePolicy } from "./campaign";
import { nextLookAt } from "./dialer";
import type { OutboundStore } from "./store";

/** Spoken to a person who answers when this process cannot run the call.
 * It names the practice — they did not call us, so they need to know who
 * rang — and claims nothing about why. */
export const OUTBOUND_UNAVAILABLE_LINE =
  "Hello, this is Azul Vision. I'm sorry, we're not able to complete this call right now. Goodbye.";

export interface OutboundWebhookDeps {
  env: Record<string, string | undefined>;
  registry: CallSessionRegistry;
  store: OutboundStore;
  /** The policy for a registered outbound lane, or null for any other slug. */
  policyFor: (slug: string) => Promise<OutboundLanePolicy | null> | OutboundLanePolicy | null;
  now?: () => Date;
  liveCalls?: LiveCallRegistry;
}

function gate(req: WebhookRequest, env: Record<string, string | undefined>): WebhookResponse | null {
  const sig = checkTwilioSignature(req, env);
  if (sig === "no_auth_token") {
    return twimlResponse(200, `<Say>${xmlEscape(OUTBOUND_UNAVAILABLE_LINE)}</Say><Hangup/>`);
  }
  if (sig === "invalid") return { status: 403, contentType: "text/plain", body: "invalid signature" };
  return null;
}

function queryOf(req: WebhookRequest): { contactId: string; attemptId: string } {
  const q = new URL(req.originalUrl, "https://x.invalid").searchParams;
  return { contactId: q.get("contact") ?? "", attemptId: q.get("attempt") ?? "" };
}

const hangup = (): WebhookResponse => twimlResponse(200, "<Hangup/>");

/** POST /voice/outbound/:slug — the person, a machine or a fax answered. */
export async function handleOutboundAnswer(
  slug: string,
  req: WebhookRequest,
  deps: OutboundWebhookDeps,
): Promise<WebhookResponse> {
  const gated = gate(req, deps.env);
  if (gated) return gated;
  if (!isValidSlug(slug)) return { status: 404, contentType: "text/plain", body: "unknown lane" };

  const policy = await deps.policyFor(slug);
  const { contactId, attemptId } = queryOf(req);
  const callSid = req.body.CallSid ?? "";
  if (!policy || !contactId || !attemptId || !callSid) {
    // Nobody we meant to call, or a request we did not make. Hang up; there
    // is no one to apologise to on our behalf.
    return hangup();
  }

  const live = liveSessionFor(slug, req, deps);
  if (live === false) return hangup();
  if (live) (deps.liveCalls ?? liveCallRegistry).setStatus(live.sessionId, "in_progress");

  const answeredBy = req.body.AnsweredBy ?? "";
  const now = (deps.now ?? (() => new Date()))();

  if (answeredBy === "fax") {
    await deps.store.finishAttempt(attemptId, { status: "fax", answeredBy, ended: false });
    await deps.store.settleContact(contactId, "wrong_number", { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId });
    return hangup();
  }

  if (answeredBy.startsWith("machine")) {
    await deps.store.finishAttempt(attemptId, { status: "voicemail", answeredBy, ended: false });
    const prior = await deps.store.priorAttempts(contactId);
    await deps.store.settleContact(
      contactId,
      prior.length >= policy.caps.total ? "max_attempts" : "voicemail",
      { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId, nextAttemptAt: nextLookAt(now, "too_soon", policy) },
    );
    return twimlResponse(200, `<Say>${xmlEscape(policy.voicemail())}</Say><Hangup/>`);
  }

  if (!computeRuntimeReadiness(deps.env).liveReady) {
    if (live) (deps.liveCalls ?? liveCallRegistry).setStatus(live.sessionId, "failed");
    await deps.store.finishAttempt(attemptId, { status: "not_ready", answeredBy, ended: false });
    await deps.store.settleContact(contactId, "no_answer", {
      onlyIfCalling: true,
      onlyIfCurrentAttempt: attemptId,
      nextAttemptAt: nextLookAt(now, "too_soon", policy),
    });
    return twimlResponse(200, `<Say>${xmlEscape(OUTBOUND_UNAVAILABLE_LINE)}</Say><Hangup/>`);
  }

  const entry = deps.registry.register({
    callSid,
    slug,
    // The person we rang is the "caller" every downstream reader expects:
    // the number on the far end of the call.
    callerPhone: req.body.To ?? "",
    dialedNumber: req.body.From ?? "",
    outbound: { campaignKey: policy.campaignKey, contactId, attemptId },
    ...(live ? { liveSessionId: live.sessionId } : {}),
  });
  const { host } = resolveRequestBase(req);
  return twimlResponse(
    200,
    `<Connect><Stream url="${xmlEscape(`wss://${host}${VOICE_STREAM_PATH}`)}">` +
      `<Parameter name="callSid" value="${xmlEscape(callSid)}"/>` +
      `<Parameter name="token" value="${xmlEscape(entry.streamToken)}"/>` +
      `<Parameter name="host" value="${xmlEscape(host)}"/>` +
      `</Stream></Connect>` +
      `<Redirect method="POST">${xmlEscape(`${VOICE_PATH_PREFIX}/${slug}/after`)}</Redirect>`,
  );
}

/** Twilio's terminal CallStatus values. Anything else is a progress event. */
const TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/** POST /voice/outbound/:slug/status — the call finished. */
export async function handleOutboundStatus(
  slug: string,
  req: WebhookRequest,
  deps: OutboundWebhookDeps,
): Promise<WebhookResponse> {
  const gated = gate(req, deps.env);
  if (gated) return gated;
  const ok: WebhookResponse = { status: 204, contentType: "text/plain", body: "" };

  const live = liveSessionFor(slug, req, deps);
  if (live === false) return ok;
  const status = req.body.CallStatus ?? "";
  if (live) {
    const mapped: Record<string, LiveCallStatus> = {
      queued: "dialing", initiated: "dialing", ringing: "ringing", answered: "in_progress", "in-progress": "in_progress",
      completed: "completed", busy: "no_answer", "no-answer": "no_answer", failed: "failed", canceled: "failed",
    };
    if (mapped[status]) {
      const end = TERMINAL.has(status) ? live.controls?.end : undefined;
      (deps.liveCalls ?? liveCallRegistry).setStatus(live.sessionId, mapped[status]);
      end?.();
    }
  }
  const policy = await deps.policyFor(slug);
  const { contactId, attemptId } = queryOf(req);
  if (!policy || !contactId || !attemptId || !TERMINAL.has(status)) return ok;

  const now = (deps.now ?? (() => new Date()))();
  const duration = Number.parseInt(req.body.CallDuration ?? "", 10);
  await deps.store.finishAttempt(attemptId, {
    // A machine or fax was already recorded by the answer webhook; this only
    // fills what is missing, and never overwrites that status.
    status: status === "completed" ? "completed" : status,
    answeredBy: req.body.AnsweredBy || null,
    durationSeconds: Number.isFinite(duration) ? duration : null,
  });

  if (status === "completed") {
    // A person answered and the call ended without the agent settling the
    // contact. Not retried automatically: somebody heard us, and ringing
    // them again on a guess is how a campaign becomes a nuisance.
    await deps.store.settleContact(contactId, "answered", { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId });
    return ok;
  }

  const prior = await deps.store.priorAttempts(contactId);
  await deps.store.settleContact(
    contactId,
    prior.length >= policy.caps.total ? "max_attempts" : "no_answer",
    { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId, nextAttemptAt: nextLookAt(now, "too_soon", policy) },
  );
  return ok;
}

/** Called only after signature verification; the URL binds all three ids. */
function liveSessionFor(slug: string, req: WebhookRequest, deps: OutboundWebhookDeps) {
  const id = new URL(req.originalUrl, "https://x.invalid").searchParams.get("liveSession");
  if (!id) return null;
  const registry = deps.liveCalls ?? liveCallRegistry;
  const session = registry.get(id);
  const { contactId, attemptId } = queryOf(req);
  if (slug !== "si-assistant" || !session || session.contactId !== contactId || session.attemptId !== attemptId ||
      !registry.bindCall(id, req.body.CallSid ?? "")) return false;
  return session;
}
