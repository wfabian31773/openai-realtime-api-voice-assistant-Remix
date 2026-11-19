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
import { operatorLineEnabled } from "../../plugin/operatorLineSettings";
import { boundPluginStore } from "../../plugin/bindings";
import type { PluginStore } from "../../plugin/store";
import { OPERATOR_SLUG } from "../../plugin/operatorLine";
import { SI_ASSISTANT_SLUG } from "../../plugin/siAssistantConstants";
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
import { callerAudioVerdict } from "../callerAudioTelemetry";

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
  operatorStore?: () => PluginStore | null;
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

  if (slug === OPERATOR_SLUG && !(await operatorLineEnabled(deps.env, deps.operatorStore?.() ?? boundPluginStore()))) return hangup();

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
  if (slug === OPERATOR_SLUG && (!live || live.endedAt)) return hangup();
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
    if (slug === OPERATOR_SLUG) {
      // NO daily cap, peak window, or campaign retry scheduling for operator calls.
      await deps.store.settleContact(contactId, "voicemail", { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId });
      return twimlResponse(200, `<Say>${xmlEscape(policy.voicemail())}</Say><Hangup/>`);
    }
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
      ...(slug === OPERATOR_SLUG ? {} : { nextAttemptAt: nextLookAt(now, "too_soon", policy) }),
    });
    return twimlResponse(200, `<Say>${xmlEscape(OUTBOUND_UNAVAILABLE_LINE)}</Say><Hangup/>`);
  }

  // Durable before a word is spoken: the status webhook reads it to tell a
  // call somebody could hear from a pick-up that never reached us (v249).
  await markStreamed(attemptId, deps);
  const entry = deps.registry.register({
    callSid,
    slug,
    // The person we rang is the "caller" every downstream reader expects:
    // the number on the far end of the call.
    callerPhone: req.body.To ?? "",
    dialedNumber: req.body.From ?? "",
    outbound: { campaignKey: policy.campaignKey, contactId, attemptId },
    ...(live ? { liveSessionId: live.sessionId } : {}),
    ...(live && live.operatorCall ? { retentionMs: (live.operatorCall.maxDurationSec + 600) * 1000 } : {}),
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

  // A lost live session (e.g. restart) only skips the in-memory update; the
  // signed, URL-bound callback still settles the durable attempt below.
  const live = liveSessionFor(slug, req, deps);
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

  if (status === "completed" && !(await nobodyHeardUs(slug, req, deps))) {
    // A person answered and the call ended without the agent settling the
    // contact. Not retried automatically: somebody heard us, and ringing
    // them again on a guess is how a campaign becomes a nuisance.
    await deps.store.settleContact(contactId, "answered", { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId });
    return ok;
  }

  if (slug === OPERATOR_SLUG) {
    await deps.store.settleContact(contactId, "no_answer", { onlyIfCalling: true, onlyIfCurrentAttempt: attemptId });
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

/**
 * A DIALLED CALL TWILIO REPORTS `completed` WITH NO ANSWERING-MACHINE VERDICT
 * IS A PICK-UP NOBODY HEARD (v249, operator 2026-11-18: "build the no-answer
 * fix in tonight's pass"). The dialler asks for synchronous detection
 * (`DetectMessageEnd`), and Twilio requests the answer URL only once detection
 * has decided, so a call that ends before it decides never reaches the answer
 * webhook: no greeting is played, no stream opens, no call row is written. The
 * terminal status then arrives with no `AnsweredBy`, and the branch above it
 * marked the contact `answered`, a status the dialler never rings again.
 *
 * Measured, npx-outreach, every outbound attempt Twilio reported `completed`
 * to 2026-11-19 02:41 UTC (614; the newest dial 2026-11-18 17:01 UTC): 246
 * carried no verdict and none of the 246 has a call row (0 to 30 s, median
 * 19); 368 carried one (human or unknown) and 365 of them have a call row. 233 of the 246 are still the contact's newest attempt
 * and still read `answered`. The status webhook asks for both signals, no
 * verdict here AND no stream (`streamOpened`: the attempt's stamp, written by
 * the answer webhook before it streams, or a call row), so a call that did
 * stream is never re-rung whatever Twilio sends. Such a call is settled as the ring-out branch
 * below settles one: `no_answer` with the next look at the policy's gap, or
 * `max_attempts` once the caps are spent, only while the call still holds the
 * row (`onlyIfCalling`), only for its own attempt.
 *
 * Not for a live call (the SI Assistant and the operator line carry a
 * `liveSession`, and 13 SI Assistant attempts with no verdict on their status
 * callback did have a call row) and not for the operator slug: their rings
 * are approved one at a time and are not a campaign's retries.
 */
export function pickupNobodyHeard(slug: string, req: WebhookRequest): boolean {
  if (slug === OPERATOR_SLUG || slug === SI_ASSISTANT_SLUG) return false;
  if (new URL(req.originalUrl, "https://x.invalid").searchParams.has("liveSession")) return false;
  return (req.body.CallStatus ?? "") === "completed" && !(req.body.AnsweredBy ?? "").trim();
}

/** Both signals: Twilio gave no verdict, and no stream opened (v249). */
async function nobodyHeardUs(slug: string, req: WebhookRequest, deps: OutboundWebhookDeps): Promise<boolean> {
  return pickupNobodyHeard(slug, req) && !(await streamOpened(req, deps));
}

/**
 * The second signal, independent of Twilio's: the answer webhook stamped the
 * attempt before it handed the call to the stream (`markAttemptStreamed`), or
 * the call has a call_logs row. The stamp is the durable one: the call row
 * can be written as late as teardown when its opening insert misses its
 * deadline (Codex P1 on #495; measured, npx-outreach outbound calls of 15 s
 * or more in the 14 days to 2026-11-19, 0 of 325 had their row written only
 * at hangup, so the call row alone was never wrong there, but nothing made it
 * right). Either one means a person could have heard us. A read that fails
 * counts as opened, so a database blip keeps the old `answered` and never
 * rings a person again; a status with no CallSid is checked by its attempt.
 */
async function streamOpened(req: WebhookRequest, deps: OutboundWebhookDeps): Promise<boolean> {
  const { attemptId } = queryOf(req);
  try {
    if (attemptId && (await deps.store.attemptWasStreamed(attemptId))) return true;
  } catch {
    return true;
  }
  const callSid = req.body.CallSid ?? "";
  if (!callSid) return true;
  try {
    return await deps.store.callRowExists(callSid);
  } catch {
    return true;
  }
}

/** How long the answer webhook waits on the stamp before it streams anyway. */
export const MARK_STREAMED_BUDGET_MS = 1_500;

/**
 * Stamp the attempt, bounded: a slow or failing write must never hold up the
 * greeting, and the call row is the fallback signal when the stamp is lost.
 */
async function markStreamed(attemptId: string, deps: OutboundWebhookDeps): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.store.markAttemptStreamed(attemptId),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MARK_STREAMED_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[outbound] could not stamp attempt ${attemptId} as streamed: ${(err as Error)?.message ?? err}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when the transcript holds a line the caller actually said. */
export function callerWasHeard(transcript: string): boolean {
  return /^CALLER:[ \t]*\S/m.test(transcript);
}

/**
 * Which dialled call, if any, a teardown should settle as an unheard pickup.
 * Null for a call we did not dial, for the operator line, and for a LIVE call
 * (an SI Assistant or operator session): the runtime blanks a live call's
 * transcript before teardown, so its emptiness says nothing about whether the
 * person spoke, and re-queueing a call somebody answered would ring them again.
 *
 * Null too when the caller's audio was VOICED (Codex P1 on #459): a missing
 * transcript is not silence. The socket meter (`CallerAudioMeter`) counts
 * speech-loud frames whether or not the transcriber wrote anything, and a
 * voiced pickup may be a person who answered and was not transcribed, or who
 * hung up before the transcript landed. Measured, NPX outbound calls
 * 2026-11-07..12 with no caller line: 25; 14 a silent line (0% voiced), 11
 * voiced (3 at 5% or more). Only the silent ones are settled; a voiced pickup
 * stays `answered`, as before v213, and is still texted.
 */
export function unheardPickupToSettle(call: {
  slug: string;
  outbound?: { contactId: string; attemptId: string };
  liveCall: boolean;
  transcript: string;
  callerAudio: { frames: number; voiced: number };
}): { contactId: string; attemptId: string } | null {
  if (!call.outbound || call.liveCall || call.slug === OPERATOR_SLUG) return null;
  if (callerWasHeard(call.transcript)) return null;
  if (callerAudioVerdict(call.callerAudio) === "voiced") return null;
  return { contactId: call.outbound.contactId, attemptId: call.outbound.attemptId };
}

/**
 * A DIALLED CALL THAT CONNECTED AND ON WHICH THE CALLER NEVER SAID A WORD is
 * not an answer (v213, operator 2026-11-12: "if they dont answer, send them a
 * text"). Twilio reports it `completed`, and the status webhook above would
 * mark the contact `answered`, which is never dialled again. On the
 * campaign's first evening, 2 of 2 connected NPX calls (2026-11-12 00:33 and
 * 00:37 UTC) were a silent line, 0% of the caller's audio voiced, cut by the
 * silence ladder after three prompts. This settles such a call the way the
 * webhook settles a ring-out: `no_answer` with the next look at the policy's
 * gap, or `max_attempts` once the caps are spent. The text is unchanged: both
 * statuses are textable.
 *
 * The runtime calls it at teardown, which is before Twilio's terminal status
 * on this path (the sign-off TwiML still has to play). It also replaces an
 * `answered` the status webhook may have written first, and nothing else: a
 * voicemail, an opt-out, a booking or any outcome the call recorded stands.
 * Only the attempt this call was is settled (`onlyIfCurrentAttempt`).
 */
export async function settleUnheardPickup(
  slug: string,
  contactId: string,
  attemptId: string,
  deps: Pick<OutboundWebhookDeps, "store" | "policyFor" | "now">,
): Promise<boolean> {
  if (slug === OPERATOR_SLUG) return false;
  const policy = await deps.policyFor(slug);
  if (!policy) return false;
  const now = (deps.now ?? (() => new Date()))();
  const prior = await deps.store.priorAttempts(contactId);
  return deps.store.settleContact(
    contactId,
    prior.length >= policy.caps.total ? "max_attempts" : "no_answer",
    {
      onlyIfStatusIn: ["calling", "answered"],
      onlyIfCurrentAttempt: attemptId,
      nextAttemptAt: nextLookAt(now, "too_soon", policy),
    },
  );
}

/** Called only after signature verification; the URL binds all three ids. */
function liveSessionFor(slug: string, req: WebhookRequest, deps: OutboundWebhookDeps) {
  const id = new URL(req.originalUrl, "https://x.invalid").searchParams.get("liveSession");
  if (!id) return null;
  const registry = deps.liveCalls ?? liveCallRegistry;
  const session = registry.get(id);
  const { contactId, attemptId } = queryOf(req);
  if ((slug !== "si-assistant" && slug !== OPERATOR_SLUG) || !session ||
      (slug === OPERATOR_SLUG) !== Boolean(session.operatorCall) || session.contactId !== contactId || session.attemptId !== attemptId ||
      !registry.bindCall(id, req.body.CallSid ?? "")) return false;
  return session;
}
