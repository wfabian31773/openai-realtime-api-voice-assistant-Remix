/**
 * SI Assistant SMS. Sent from SI_ASSISTANT_NUMBER through Twilio on this
 * fleet — not delegated to the ticketing app — because the dedicated
 * number (+1 909-255-3213) lives here and the dialer already uses it.
 *
 * STOP / HELP / START are honoured on the inbound webhook. STOP writes
 * an SMS opt-out row (source `sms_stop`). Any do_not_contact row, of any
 * source, blocks both texts and calls. HELP always replies (CTIA): the
 * program name, a contact number and how to opt out, even to a number
 * that any do_not_contact row blocks. START deletes only the
 * `sms_stop` row and never a voice "don't call me" — so a number with a
 * voice row stays blocked for both, and START then sends no reply.
 */

import { dncKey } from "../runtime/outbound/store";
import { siAssistantNumber, smsIdentifiedBody } from "./siAssistantConstants";
import type { PluginStore } from "./store";
import { SendOutcomeError, failureFromUnknown, type SendFailure } from "./sendFailure";

export interface SmsSender {
  send(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

export const HELP_REPLY =
  "Azul Vision SI Assistant (AI). This is an automated assistant, not a person. For help, call (909) 255-3213. Reply STOP to opt out of texts. Reply START to opt back in. Msg&data rates may apply.";

export const STOP_REPLY =
  "Azul Vision SI Assistant (AI): you are opted out of texts from this number. Reply START to opt back in.";

export const START_REPLY =
  "Azul Vision SI Assistant (AI): you are opted back in to texts from this number. Reply STOP to opt out.";

export type InboundSmsCommand = "stop" | "help" | "start" | "other";

/** Body preview for an unmatched inbound text. Empty after trim is skipped. */
export const INBOUND_SMS_PREVIEW_MAX = 280;

export function inboundSmsPreview(body: string): string | null {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  if (trimmed.length <= INBOUND_SMS_PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, INBOUND_SMS_PREVIEW_MAX - 1).trimEnd()}…`;
}

export function classifyInboundSms(body: string): InboundSmsCommand {
  const normalized = body.trim().toLowerCase().replace(/[!.]/g, "");
  if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(normalized)) return "stop";
  if (["help", "info"].includes(normalized)) return "help";
  if (["start", "unstop", "yes"].includes(normalized)) return "start";
  return "other";
}

export async function sendApprovedSms(
  store: PluginStore,
  sender: SmsSender,
  input: { phone: string; body: string },
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; sid: string } | SendFailure> {
  const key = dncKey(input.phone);
  if (!key) return { ok: false, reason: "invalid_phone", mayHaveSent: false };
  try {
    if (await store.isSmsOptedOut(key)) return { ok: false, reason: "sms_opted_out", mayHaveSent: false };
  } catch (err) {
    return { ...failureFromUnknown(err), reason: "sms_opt_out_read_failed", mayHaveSent: false };
  }
  const from = siAssistantNumber(env);
  const body = smsIdentifiedBody(input.body);
  try {
    const sent = await sender.send({ to: `+1${key}`, from, body });
    return { ok: true, sid: sent.sid };
  } catch (err) {
    return failureFromUnknown(err);
  }
}

export async function handleInboundSms(
  store: PluginStore,
  sender: SmsSender | null,
  input: { from: string; body: string },
  env: Record<string, string | undefined> = process.env,
): Promise<{ command: InboundSmsCommand; replied: boolean }> {
  const key = dncKey(input.from);
  const command = classifyInboundSms(input.body);
  if (!key) return { command, replied: false };

  if (command === "stop") {
    await store.setSmsOptOut(key, true);
    if (sender) {
      await sender.send({ to: `+1${key}`, from: siAssistantNumber(env), body: STOP_REPLY });
    }
    return { command, replied: Boolean(sender) };
  }
  if (command === "help") {
    // HELP always replies, even to a number an SMS STOP or a voice
    // "don't call me" blocks: carriers and CTIA expect a HELP response
    // whatever the opt-out state.
    if (sender) {
      await sender.send({ to: `+1${key}`, from: siAssistantNumber(env), body: HELP_REPLY });
    }
    return { command, replied: Boolean(sender) };
  }
  if (command === "start") {
    await store.setSmsOptOut(key, false);
    // START clears only sms_stop. If another row (a voice opt-out) still
    // blocks the number, texting "you are opted back in" would be false and
    // would itself be a text to a blocked number: send nothing.
    if (await store.isSmsOptedOut(key)) return { command, replied: false };
    if (sender) {
      await sender.send({ to: `+1${key}`, from: siAssistantNumber(env), body: START_REPLY });
    }
    return { command, replied: Boolean(sender) };
  }
  return { command, replied: false };
}

export const SMS_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("sms_timeout");
      err.name = "AbortError";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createTwilioSmsSender(env: Record<string, string | undefined> = process.env): SmsSender | null {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return {
    async send(opts) {
      const twilio = await import("twilio");
      const client = twilio.default(sid, token);
      try {
        const msg = await withTimeout(
          client.messages.create({ to: opts.to, from: opts.from, body: opts.body }),
          SMS_TIMEOUT_MS,
        );
        return { sid: msg.sid };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new SendOutcomeError("sms_timeout", true);
        }
        const status =
          err && typeof err === "object"
            ? (err as { status?: number; statusCode?: number }).status ??
              (err as { status?: number; statusCode?: number }).statusCode
            : undefined;
        if (typeof status === "number" && status >= 400 && status < 500) {
          throw new SendOutcomeError("twilio_rejected", false);
        }
        throw err instanceof SendOutcomeError ? err : new SendOutcomeError("twilio_send_failed", true);
      }
    },
  };
}
