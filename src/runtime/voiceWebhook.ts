/**
 * src/runtime/voiceWebhook.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The runtime's Twilio webhook handlers, framework-neutral (plain
 * request/response value shapes) so every branch is testable without a
 * listening socket. voiceRuntime.ts glues them to Express.
 *
 * One path serves every lane: `POST /voice/:slug`. The slug in the URL is
 * what decides which agent answers — operator ruling: each queue gets its
 * own number, webhook and slug, and lanes are never multiplexed behind a
 * mode flag.
 *
 * SECURITY POSTURE, IN ORDER, ON EVERY POST:
 *   1. No TWILIO_AUTH_TOKEN -> fail CLOSED: controlled unavailable TwiML,
 *      served with status 200 so Twilio actually plays it. Never an
 *      unauthenticated accept.
 *   2. Missing/invalid X-Twilio-Signature -> 403. The check is the twilio
 *      package's own validateRequest (HMAC-SHA1 over URL + params), the
 *      same primitive this repo's production webhook already uses.
 *   3. Not live-ready (missing XAI key or database) -> an authenticated
 *      Twilio request gets a controlled spoken unavailable line and a
 *      hangup: never dead air, never a half-configured call.
 *   4. Unknown or disabled slug -> the same controlled line. A lane that is
 *      off is off; answering with some other lane's agent is how a surgery
 *      caller ends up in the optical prompt.
 *
 * TwiML SHAPE. `<Connect><Stream>` REPLACES the call — while the stream is
 * up the WebSocket owns the caller, and closing that socket is the hangup.
 * Twilio then continues with the NEXT verb, so the document deliberately
 * ends with a `<Redirect>` to `POST /voice/:slug/after`: that second
 * webhook reads the recorded outcome and either hangs up cleanly or speaks
 * the controlled technical-trouble line first (the session is dead by then,
 * so Twilio's own `<Say>` has to deliver it).
 *
 * Twilio does NOT support query parameters on a `<Stream url>`; custom data
 * travels as nested `<Parameter>` elements and comes back in the start
 * frame's `customParameters`. So the stream URL stays bare and the
 * callSid + token gate moves from upgrade time to start-frame time.
 *
 * WORDING. The only caller-audible strings in this whole runtime are the
 * two below, and neither makes any claim about what the practice will do
 * beyond following up. Everything a caller hears on a working call comes
 * from the agent's own prompt — asserted by mediaStreamBridge.test.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import twilio from "twilio";
import { computeRuntimeReadiness } from "./readiness";
import type { CallOutcome } from "./mediaStreamBridge";
import type { CallSessionRegistry } from "./sessionRegistry";

export const VOICE_PATH_PREFIX = "/voice";
export const VOICE_STREAM_PATH = "/voice/stream";

/** Spoken when the line is reachable but this process cannot run a call. */
export const RUNTIME_UNAVAILABLE_LINE =
  "I'm sorry, this line is temporarily unavailable. Our office will follow up with you. Goodbye.";

/** Spoken after a mid-call failure — the session is gone, so Twilio says
 * it. No claim about anything the caller asked for. */
export const RUNTIME_TECHNICAL_TROUBLE_LINE =
  "I'm sorry, we ran into technical trouble on our end during this call. " +
  "Our office will follow up with you directly. Goodbye.";

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Parsed application/x-www-form-urlencoded POST params. */
  body: Record<string, string>;
  /** Path + query as Twilio requested it (Express req.originalUrl). */
  originalUrl: string;
}

export interface WebhookResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface WebhookDeps {
  env: Record<string, string | undefined>;
  registry: CallSessionRegistry;
  /** Whether this slug can answer a call right now. Injected rather than
   * imported so the webhook stays testable without the agent tree. */
  laneIsAvailable: (slug: string) => boolean;
  /**
   * Starts Twilio's call recording, fire-and-forget — see callRecording.ts.
   *
   * The greeting tells the caller the call is being recorded and the
   * compliance check refuses a greeting that drops that sentence, so this is
   * what makes the sentence true (task #54). Injected, synchronous and
   * non-throwing: the caller is waiting on the TwiML below, and a REST round
   * trip in front of it is dead air.
   */
}

function headerValue(
  headers: WebhookRequest["headers"],
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(status: number, innerXml: string): WebhookResponse {
  return {
    status,
    contentType: "text/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${innerXml}</Response>`,
  };
}

export function buildUnavailableTwiml(status: number, line: string): WebhookResponse {
  return twimlResponse(status, `<Say>${xmlEscape(line)}</Say><Hangup/>`);
}

/** Host/protocol derivation for both the signature URL and the stream URL,
 * anchored to the request with the forwarded-header preference this repo's
 * existing webhook established. */
export function resolveRequestBase(req: WebhookRequest): { protocol: string; host: string } {
  const host =
    headerValue(req.headers, "x-forwarded-host") ??
    headerValue(req.headers, "host") ??
    "localhost";
  const protocol =
    headerValue(req.headers, "x-forwarded-proto") ??
    (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return { protocol, host };
}

export type SignatureCheck = "valid" | "invalid" | "no_auth_token";

export function checkTwilioSignature(
  req: WebhookRequest,
  env: Record<string, string | undefined>,
): SignatureCheck {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) return "no_auth_token";
  const signature = headerValue(req.headers, "x-twilio-signature");
  if (!signature) return "invalid";
  const { protocol, host } = resolveRequestBase(req);
  const url = `${protocol}://${host}${req.originalUrl}`;
  try {
    return twilio.validateRequest(authToken, signature, url, req.body) ? "valid" : "invalid";
  } catch {
    // Fail closed on any validation error — no dev-mode escape hatch.
    return "invalid";
  }
}

/** Shared entry gate. Returns a response to send immediately (fail-closed),
 * or null when the request is authenticated. */
function gateRequest(req: WebhookRequest, deps: WebhookDeps): WebhookResponse | null {
  const sig = checkTwilioSignature(req, deps.env);
  if (sig === "no_auth_token") {
    // Without the auth token nothing can be authenticated, so nothing gets
    // a stream. Status 200, NOT 503: "Twilio treats ANY 5xx as failure
    // regardless of content — must be 200 with valid TwiML"
    // (server/index.ts:93). A 5xx here means the controlled line this
    // branch exists to speak is never played, and the caller gets Twilio's
    // own failure handling instead. The 503 was carried over from the
    // sibling repo, which had not learned this one (Codex review, #227).
    return buildUnavailableTwiml(200, RUNTIME_UNAVAILABLE_LINE);
  }
  if (sig === "invalid") {
    return { status: 403, contentType: "text/plain", body: "invalid signature" };
  }
  return null;
}

/** A slug is a lane name, not a path. Anything else is a probe. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

/**
 * POST /voice/:slug — a number's Voice webhook. On a valid, live-ready
 * request for an available lane: registers the call and returns
 * `<Connect><Stream>` carrying the callSid and a single-use token, followed
 * by the post-stream `<Redirect>`.
 */
export function handleVoiceWebhook(
  slug: string,
  req: WebhookRequest,
  deps: WebhookDeps,
): WebhookResponse {
  const gated = gateRequest(req, deps);
  if (gated) return gated;

  if (!isValidSlug(slug)) {
    return { status: 404, contentType: "text/plain", body: "unknown lane" };
  }

  const readiness = computeRuntimeReadiness(deps.env);
  if (!readiness.liveReady) {
    // Authenticated Twilio request, but this process cannot run a real
    // call. Controlled spoken line — never a half-configured stream.
    return buildUnavailableTwiml(200, RUNTIME_UNAVAILABLE_LINE);
  }

  if (!deps.laneIsAvailable(slug)) {
    // Unknown or disabled lane. Same controlled line: whether a line takes
    // calls is the operator's decision, and this is not the place to
    // substitute a different agent for the one that is off.
    return buildUnavailableTwiml(200, RUNTIME_UNAVAILABLE_LINE);
  }

  const callSid = req.body.CallSid ?? "";
  if (!callSid) {
    return { status: 400, contentType: "text/plain", body: "missing CallSid" };
  }

  const { host } = resolveRequestBase(req);

  const entry = deps.registry.register({
    callSid,
    slug,
    callerPhone: req.body.From ?? "",
    dialedNumber: req.body.To ?? "",
    // Carried so the start frame can build a status-callback URL on the same
    // origin Twilio actually reached us on.
    host,
  });
  const streamUrl = `wss://${host}${VOICE_STREAM_PATH}`;

  // RECORDING IS NOT STARTED HERE. It used to be, and that was a race the
  // recording could only lose: an inbound call is not `in-progress` until
  // Twilio has received and begun executing the TwiML below, and this ran
  // BEFORE that response was even written. `recordings.create` would be
  // rejected with 21220 — the exact error callRecording.test.ts models — and
  // the greeting's recording disclosure would be false on every call, which
  // is the whole thing #54 exists to prevent (Codex, PR #247).
  //
  // It now fires on the Media Streams `start` frame instead, which Twilio
  // only sends once it is executing this TwiML. See `startCall` in
  // voiceRuntime.ts. The host is carried on the registry entry.

  return twimlResponse(
    200,
    `<Connect><Stream url="${xmlEscape(streamUrl)}">` +
      `<Parameter name="callSid" value="${xmlEscape(callSid)}"/>` +
      `<Parameter name="token" value="${xmlEscape(entry.streamToken)}"/>` +
      `</Stream></Connect>` +
      `<Redirect method="POST">${xmlEscape(`${VOICE_PATH_PREFIX}/${slug}/after`)}</Redirect>`,
  );
}

/**
 * POST /voice/:slug/after — runs when the media stream has ended and Twilio
 * continues past `</Connect>`. A runtime-side failure speaks the controlled
 * trouble line; every other ending hangs up cleanly. Signature-gated like
 * any other endpoint that can speak to a caller.
 */
export function handleAfterRedirect(
  req: WebhookRequest,
  deps: WebhookDeps,
): WebhookResponse {
  const gated = gateRequest(req, deps);
  if (gated) return gated;

  const callSid = req.body.CallSid ?? "";
  const outcome: CallOutcome | null = callSid ? deps.registry.consumeOutcome(callSid) : null;

  if (outcome === "provider_failure" || outcome === "dead_air") {
    // The two endings the runtime itself caused. A caller who was cut off
    // mid-sentence is owed an explanation, not a silent hangup.
    return twimlResponse(
      200,
      `<Say>${xmlEscape(RUNTIME_TECHNICAL_TROUBLE_LINE)}</Say><Hangup/>`,
    );
  }
  // completed / agent_ended / caller_hangup / max_duration / unknown: the
  // conversation is over — end the call cleanly.
  return twimlResponse(200, `<Hangup/>`);
}
