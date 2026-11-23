/**
 * The call we place to an on-call provider in the background, and the two
 * Twilio webhooks it answers on.
 *
 * The provider hears one line and is asked to press a key. A key press is the
 * only thing that counts as taking the patient: a voicemail greeting, a
 * screening assistant or a pocket answer cannot press a key, so a call that is
 * merely "answered" is never recorded as accepted (the same rule the in-call
 * warm transfer keeps, `transferAccept.ts`). The patient's details are in the
 * text sent just before the call, never in the TwiML, so nothing a machine
 * records carries them. When every text to that number failed, the opening
 * says so, and the callback number is read only in the reply to a key press
 * (review of #514, round 12): a machine cannot press a key, so it still hears
 * nothing about the patient.
 *
 *   POST /voice/on-call/ack?attempt=<id>     the <Gather> result
 *   POST /voice/on-call/status?attempt=<id>  the call's terminal status
 *
 * Both are signature-checked; the attempt id is in the signed URL.
 */
import {
  buildUnavailableTwiml,
  checkTwilioSignature,
  RUNTIME_UNAVAILABLE_LINE,
  twimlResponse,
  xmlEscape,
  type WebhookRequest,
  type WebhookResponse,
} from "../voiceWebhook";

export const ON_CALL_ACK_PATH = "/voice/on-call/ack";
export const ON_CALL_STATUS_PATH = "/voice/on-call/status";

const VOICE = "Polly.Joanna";

export const PROVIDER_CALL_OPENING =
  "This is the Azul Vision answering service. You have an urgent patient who needs a call back. " +
  "The details are in the text message we just sent you. Press any key to take this patient.";
/**
 * The opening when no text with the patient's details reached this number on
 * this escalation (every send to it failed). It claims no text, and tells the
 * provider the callback number is read to them once they press a key (review
 * of #514, round 12).
 */
export const PROVIDER_CALL_OPENING_NO_TEXT =
  "This is the Azul Vision answering service. You have an urgent patient who needs a call back. " +
  "We could not text you the details. Press any key to take this patient, and we will read you the callback number.";
export const PROVIDER_CALL_REPEAT = "Press any key to take this patient.";
export const PROVIDER_ACCEPTED_LINE =
  "Thank you. This patient is yours. The callback number is in the text message. Goodbye.";
/** Accepted, no details text reached this number, and there is no callback number to read. */
export const PROVIDER_ACCEPTED_NO_NUMBER_LINE =
  "Thank you. This patient is yours. We could not text you the details, and we cannot read you a callback number. Goodbye.";
/** The ack could not be recorded, on a call whose details text was sent. */
export const PROVIDER_ACK_FAILED_LINE =
  "We could not record that. Please call the patient from the number in the text message. Goodbye.";
/** The ack could not be recorded, on a call whose details text did not reach the provider. */
export const PROVIDER_ACK_FAILED_NO_TEXT_LINE =
  "We could not record that, and the text with the patient's details did not reach you, so we will keep calling other providers. Goodbye.";

/**
 * The query flag on the ack URL that says the details text did not reach this
 * number when the call was placed. The URL is signed, so it cannot be forged,
 * and the ack webhook reads it even when the store cannot be reached.
 */
export const NO_TEXT_PARAM = "texted";

/**
 * A phone number said digit by digit in three groups, so it can be written
 * down: "7 1 4, 5 5 5, 0 1 0 0". Any other length is said digit by digit.
 */
export function spokenDigits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (!digits) return null;
  const each = (s: string) => s.split("").join(" ");
  return digits.length === 10
    ? `${each(digits.slice(0, 3))}, ${each(digits.slice(3, 6))}, ${each(digits.slice(6))}`
    : each(digits);
}

/** The accepted line that reads the callback number, said twice. */
export function acceptedWithNumberLine(callbackNumber: string): string | null {
  const spoken = spokenDigits(callbackNumber);
  if (!spoken) return null;
  return (
    `Thank you. This patient is yours. We could not text you the details. ` +
    `The callback number is ${spoken}. Again, the callback number is ${spoken}. Goodbye.`
  );
}
export const PROVIDER_DECLINED_LINE = "Understood. Goodbye.";
export const PROVIDER_ALREADY_TAKEN_LINE = "This patient has already been taken. Thank you. Goodbye.";
export const PROVIDER_CLOSED_LINE = "This urgent call has already been closed. Thank you. Goodbye.";

function say(line: string): string {
  return `<Say voice="${VOICE}">${xmlEscape(line)}</Say>`;
}

/**
 * The TwiML the provider's call runs. Two gathers: the opening, and one
 * repeat that reports an empty result, so a call nobody presses a key on
 * still reaches the ack webhook and is recorded as declined rather than
 * waiting for the status callback alone. `finishOnKey=""` because Twilio's
 * default ends a gather on `#` with no digits, and "press any key" includes
 * `#`: an empty `#` on the repeat would read as a decline (review of #514,
 * round 10).
 */
export function providerCallTwiml(ackUrl: string, opts: { textSent: boolean }): string {
  const action = xmlEscape(ackUrl);
  const opening = opts.textSent ? PROVIDER_CALL_OPENING : PROVIDER_CALL_OPENING_NO_TEXT;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="dtmf" numDigits="1" finishOnKey="" timeout="8" action="${action}" method="POST">${say(opening)}</Gather>` +
    `<Gather input="dtmf" numDigits="1" finishOnKey="" timeout="10" action="${action}" method="POST" actionOnEmptyResult="true">${say(PROVIDER_CALL_REPEAT)}</Gather>` +
    `</Response>`
  );
}

export type AckResult = "accepted" | "declined" | "already_taken" | "closed";

/**
 * What the ack webhook answers. A key press that takes the patient on a call
 * whose details text never reached that number carries the callback number to
 * read instead of the line that points at the text (review of #514, round 12).
 */
export type AckReply = AckResult | { result: "accepted"; noText: true; callbackNumber: string | null };

export function ackResultOf(reply: AckReply): AckResult {
  return typeof reply === "string" ? reply : reply.result;
}

export function ackReplyTwiml(reply: AckReply): WebhookResponse {
  if (typeof reply !== "string") {
    const line =
      (reply.callbackNumber ? acceptedWithNumberLine(reply.callbackNumber) : null) ?? PROVIDER_ACCEPTED_NO_NUMBER_LINE;
    return twimlResponse(200, `${say(line)}<Hangup/>`);
  }
  const result = reply;
  const line =
    result === "accepted"
      ? PROVIDER_ACCEPTED_LINE
      : result === "declined"
        ? PROVIDER_DECLINED_LINE
        : result === "already_taken"
          ? PROVIDER_ALREADY_TAKEN_LINE
          : PROVIDER_CLOSED_LINE;
  return twimlResponse(200, `${say(line)}<Hangup/>`);
}

/** The details-text flag from the signed URL: false when it says `texted=0`, true otherwise. */
export function textedFlagFrom(originalUrl: string): boolean {
  const q = originalUrl.indexOf("?");
  if (q < 0) return true;
  return new URLSearchParams(originalUrl.slice(q + 1)).get(NO_TEXT_PARAM) !== "0";
}

/** The attempt id from the signed URL, or null. */
export function attemptIdFrom(originalUrl: string): number | null {
  const q = originalUrl.indexOf("?");
  if (q < 0) return null;
  const raw = new URLSearchParams(originalUrl.slice(q + 1)).get("attempt");
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

function field(body: Record<string, unknown>, key: string): string {
  const v = body?.[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** The fail-closed entry gate the call webhooks use (voiceWebhook's own rule). */
function gate(req: WebhookRequest, env: Record<string, string | undefined>): WebhookResponse | null {
  const sig = checkTwilioSignature(req, env);
  if (sig === "no_auth_token") return buildUnavailableTwiml(200, RUNTIME_UNAVAILABLE_LINE);
  if (sig === "invalid") return { status: 403, contentType: "text/plain", body: "invalid signature" };
  return null;
}

export interface ProviderCallWebhookDeps {
  env: Record<string, string | undefined>;
  runner: {
    onProviderAck(attemptId: number, digits: string): Promise<AckReply>;
    onProviderStatus(attemptId: number, callStatus: string): Promise<void>;
  };
  log?: (line: string) => void;
}

export async function handleOnCallAck(req: WebhookRequest, deps: ProviderCallWebhookDeps): Promise<WebhookResponse> {
  const refused = gate(req, deps.env);
  if (refused) return refused;
  const id = attemptIdFrom(req.originalUrl);
  if (id === null) return ackReplyTwiml("closed");
  const digits = field(req.body as Record<string, unknown>, "Digits").trim();
  try {
    return ackReplyTwiml(await deps.runner.onProviderAck(id, digits));
  } catch (e) {
    // The provider pressed a key and we could not record it. Saying "closed"
    // would be false; saying "yours" could leave two providers each thinking
    // the other has it. Tell them what happened and let the chain carry on.
    (deps.log ?? console.error)(`[ON-CALL] ack for attempt ${id} failed: ${(e as Error)?.message ?? e}`);
    // A call placed after every text to this number failed carries
    // `texted=0` in its signed URL, so this line is right even when the store
    // is what failed (review of #514, round 12).
    const line = textedFlagFrom(req.originalUrl) === false ? PROVIDER_ACK_FAILED_NO_TEXT_LINE : PROVIDER_ACK_FAILED_LINE;
    return twimlResponse(200, `${say(line)}<Hangup/>`);
  }
}

export async function handleOnCallStatus(req: WebhookRequest, deps: ProviderCallWebhookDeps): Promise<WebhookResponse> {
  const refused = gate(req, deps.env);
  if (refused) return refused;
  const id = attemptIdFrom(req.originalUrl);
  const status = field(req.body as Record<string, unknown>, "CallStatus").trim().toLowerCase();
  if (id !== null && status) {
    try {
      await deps.runner.onProviderStatus(id, status);
    } catch (e) {
      // Twilio does not retry a 200; the ringing guard is the backstop.
      (deps.log ?? console.error)(`[ON-CALL] status for attempt ${id} failed: ${(e as Error)?.message ?? e}`);
    }
  }
  return { status: 200, contentType: "text/plain", body: "" };
}
