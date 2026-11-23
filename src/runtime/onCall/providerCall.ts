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
 * records carries them.
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
export const PROVIDER_CALL_REPEAT = "Press any key to take this patient.";
export const PROVIDER_ACCEPTED_LINE =
  "Thank you. This patient is yours. The callback number is in the text message. Goodbye.";
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
export function providerCallTwiml(ackUrl: string): string {
  const action = xmlEscape(ackUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="dtmf" numDigits="1" finishOnKey="" timeout="8" action="${action}" method="POST">${say(PROVIDER_CALL_OPENING)}</Gather>` +
    `<Gather input="dtmf" numDigits="1" finishOnKey="" timeout="10" action="${action}" method="POST" actionOnEmptyResult="true">${say(PROVIDER_CALL_REPEAT)}</Gather>` +
    `</Response>`
  );
}

export type AckResult = "accepted" | "declined" | "already_taken" | "closed";

export function ackReplyTwiml(result: AckResult): WebhookResponse {
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
    onProviderAck(attemptId: number, digits: string): Promise<AckResult>;
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
    return twimlResponse(
      200,
      `${say("We could not record that. Please call the patient from the number in the text message. Goodbye.")}<Hangup/>`,
    );
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
