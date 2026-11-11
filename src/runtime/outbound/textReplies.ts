/**
 * src/runtime/outbound/textReplies.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A PERSON TEXTS BACK TO A CAMPAIGN'S NUMBER (v211).
 *
 *   POST /voice/outbound/<slug>/sms   Twilio's messaging webhook for the
 *                                      campaign's caller-ID number
 *
 * STOP (and its synonyms) writes a `do_not_contact` row with source
 * `sms_stop`, and any row of any source blocks both texts and calls
 * (channelDnc.ts). START deletes only that `sms_stop` row, never a voice
 * "don't call me". The same rule the SI Assistant number keeps
 * (plugin/sms.ts), with the same keyword reader, so the two numbers cannot
 * disagree about what STOP means.
 *
 * NOT the SI Assistant's inbound handler: that one replies in the SI
 * Assistant's name and files every other text into the SI Assistant's
 * messages, neither of which is right for a patient answering an outreach
 * text. This one answers Twilio with an empty response and leaves STOP, START
 * and HELP replies to Twilio's own opt-out handling on the number.
 *
 * Signed by Twilio or refused, like every outbound webhook. Logs the keyword
 * and the campaign, never the number or the words.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { classifyInboundSms } from "../../plugin/sms";
import { SMS_DNC_SOURCE } from "./channelDnc";
import type { OutboundLanePolicy } from "./campaign";
import type { OutboundStore } from "./store";
import { checkTwilioSignature, type WebhookRequest, type WebhookResponse } from "../voiceWebhook";

export interface TextReplyDeps {
  env: Record<string, string | undefined>;
  store: () => Promise<OutboundStore>;
  policyFor: (slug: string) => Promise<OutboundLanePolicy | null>;
  log?: (line: string) => void;
}

/** The webhook's path for one lane. */
export function textReplyPath(prefix: string, slug: string): string {
  return `${prefix}/${slug}/sms`;
}

const EMPTY: WebhookResponse = { status: 200, contentType: "text/xml", body: "<Response/>" };

export async function handleTextReply(slug: string, req: WebhookRequest, deps: TextReplyDeps): Promise<WebhookResponse> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sig = checkTwilioSignature(req, deps.env);
  // Nothing can be authenticated without the token: nothing is written.
  if (sig === "no_auth_token") return EMPTY;
  if (sig === "invalid") return { status: 403, contentType: "text/plain", body: "invalid signature" };
  const policy = await deps.policyFor(slug);
  if (!policy?.textOutreach) return EMPTY;
  const from = String(req.body.From ?? "");
  const command = classifyInboundSms(String(req.body.Body ?? ""));
  if (from && (command === "stop" || command === "start")) {
    const store = await deps.store();
    if (command === "stop") await store.stampDoNotContact(from, SMS_DNC_SOURCE);
    else await store.clearSmsStop(from);
  }
  log(`[outbound] ${policy.campaignKey}: text reply — ${command}`);
  return EMPTY;
}
