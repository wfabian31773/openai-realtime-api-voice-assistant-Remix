/** Immediate, single-attempt SI Assistant calls, using the campaign ledger. */
import twilio from "twilio";
import { randomUUID } from "node:crypto";
import { resolveAppDomain } from "../config/environment";
import { callEnvironment } from "../runtime/callRecord";
import { callbackRoutingProblem, isClearTwilioRefusal, RING_TIMEOUT_SECONDS, STALE_CLAIM_MS, statusUrl, type OutboundTwilio } from "../runtime/outbound/dialer";
import type { DialerLock } from "../runtime/outbound/scheduler";
import { NOT_PLACED, type OutboundStore } from "../runtime/outbound/store";
import { operatorLineEnabled } from "./operatorLineSettings";
import { OPERATOR_SLUG, US_E164, operatorFromProblem, parseOperatorPayload } from "./operatorLine";
import { evaluateAndEnqueueCall, identityFromPreparePayload, siAssistantDialingProblem, siAssistantMayDial } from "./callEnqueue";
import { SI_ASSISTANT_SLUG, SI_ASSISTANT_CAMPAIGN_KEY, siAssistantNumber } from "./siAssistantConstants";
import type { ContactApprovalRow, PluginStore } from "./store";
import type { LiveCallRegistry } from "./liveSessions";

export interface LiveCallSender extends OutboundTwilio {
  endCall(callSid: string): Promise<unknown>;
}

export function createLiveCallSender(env: Record<string, string | undefined>): LiveCallSender | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, { timeout: 15_000, autoRetry: false });
  return {
    createCall: (opts) => client.calls.create(opts),
    endCall: (sid) => client.calls(sid).update({ status: "completed" }),
    voiceUrlFor: async (phoneNumber) => {
      const [number] = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      return number?.voiceUrl ?? null;
    },
  };
}

// Tests and embedded mounts need no database lock. Production injects the
// scheduler's distributed lock so its cap checks and the dial are serialized.
let locallyHeld = false;
export const localLiveCallLock: DialerLock = {
  async acquire() { if (locallyHeld) return false; locallyHeld = true; return true; },
  async release() { locallyHeld = false; },
};

type LiveResult =
  | { ok: true; callSid: string; sessionId: string }
  | { ok: false; reason: string; mayHaveSent: boolean; sessionId?: string };

export async function placeLiveCall(
  deps: { store: OutboundStore; sender: LiveCallSender; sessions: LiveCallRegistry; env: Record<string, string | undefined>; lock?: DialerLock },
  approval: ContactApprovalRow,
  now: Date,
): Promise<LiveResult> {
  const refused = (reason: string): LiveResult => ({ ok: false, reason, mayHaveSent: false });
  const dialing = siAssistantDialingProblem(deps.env);
  if (dialing) return refused(dialing);
  const domain = resolveAppDomain({
    domain: deps.env.DOMAIN, replitDomains: deps.env.REPLIT_DOMAINS, replitDevDomain: deps.env.REPLIT_DEV_DOMAIN,
    isProduction: callEnvironment(deps.env) === "production",
  });
  if (domain.source === "fallback") return refused("no_public_host");
  const from = deps.env.SI_ASSISTANT_NUMBER!.trim();
  const lock = deps.lock ?? localLiveCallLock;
  if (!(await lock.acquire().catch(() => false))) return refused("dialer_busy");
  let sent = false;
  let sessionId: string | undefined;
  let contactId: string | undefined;
  try {
    if (callbackRoutingProblem(await deps.sender.voiceUrlFor(from), domain.domain, SI_ASSISTANT_SLUG)) {
      return refused("callback_route_unconfirmed");
    }
    const queued = await evaluateAndEnqueueCall(deps.store, {
      approvalId: approval.id, phone: String(approval.payload.phone ?? ""),
      ...identityFromPreparePayload(approval.payload), ticketNumber: approval.ticketNumber, ticketId: approval.ticketId,
      purpose: typeof approval.payload.purpose === "string" ? approval.payload.purpose : null,
    }, now, true);
    if (!queued.ok) return refused(queued.reason);
    const source = (await deps.store.sourceRows(queued.campaignId)).find((row) => row.externalRef === `plugin:${approval.id}`);
    if (!source) return refused("contact_missing");
    contactId = source.id;
    const contact = await deps.store.claimContact(source.id, now);
    if (!contact) return refused("call_already_queued");
    const failContact = async (reason: string): Promise<LiveResult> => {
      await deps.store.settleContact(contact.id, "rescheduled", { onlyIfCalling: true });
      return refused(reason);
    };
    // Recheck under the claim immediately before the attempt, as the dialer does.
    if (await deps.store.isDoNotContact(contact.phone)) return failContact("do_not_contact");
    const prior = await deps.store.priorAttempts(contact.id);
    const decision = siAssistantMayDial(now, prior);
    if (!decision.ok) return failContact(decision.reason);
    if (await deps.store.callOpenOnPhone(contact.id, new Date(now.getTime() - STALE_CLAIM_MS))) return failContact("call_already_queued");
    const attemptId = await deps.store.startAttempt(contact.id, queued.campaignId, prior.length + 1);
    const session = deps.sessions.create({ approvalId: approval.id, tokenJti: approval.tokenJti, contactId: contact.id, attemptId });
    sessionId = session.sessionId;
    const query = new URLSearchParams({ contact: contact.id, attempt: attemptId, liveSession: session.sessionId });
    let call: { sid: string };
    try {
      sent = true;
      // Explicit timeout also bounds injected senders; no timeout is retried.
      call = await boundedCall(deps.sender.createCall({
        to: contact.phone, from, url: `https://${domain.domain}/voice/si-assistant?${query}`,
        method: "POST", timeout: RING_TIMEOUT_SECONDS, machineDetection: "DetectMessageEnd", machineDetectionTimeout: 30,
        statusCallback: `${statusUrl(domain.domain, SI_ASSISTANT_SLUG, contact.id, attemptId)}&liveSession=${session.sessionId}`,
        statusCallbackMethod: "POST", statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      }));
    } catch (error) {
      if (isClearTwilioRefusal(error)) {
        sent = false;
        deps.sessions.setStatus(session.sessionId, "failed");
        await deps.store.finishAttempt(attemptId, { status: NOT_PLACED });
        return failContact("twilio_rejected");
      }
      // Keep the attempt open: a signed webhook may still find the real call.
      return { ok: false, reason: "send_unknown", mayHaveSent: true };
    }
    deps.sessions.bindCall(session.sessionId, call.sid);
    await deps.store.markContactDialled(contact.id);
    await deps.store.setAttemptCallSid(attemptId, call.sid);
    return { ok: true, callSid: call.sid, sessionId: session.sessionId };
  } catch {
    if (sessionId && !sent) deps.sessions.setStatus(sessionId, "failed");
    if (contactId && !sent) await deps.store.settleContact(contactId, "rescheduled", { onlyIfStatusIn: ["pending", "calling"] }).catch(() => false);
    return { ok: false, reason: sent ? "send_unknown" : "live_call_unavailable", mayHaveSent: sent };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

function boundedCall<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("call_timeout")), 15_000);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function operatorOptOutGuard(store: OutboundStore, plugin: PluginStore, phone: string): Promise<string | null> {
  // Keep the existing US voice/SMS identity and list unchanged. International
  // operator opt-outs have their own E.164 list because the legacy key is US-only.
  if (await plugin.isOperatorOptedOut(phone)) return "do_not_contact";
  if (US_E164.test(phone) && await directCallOptOutGuard(store, plugin, phone)) return "do_not_contact";
  return null;
}

/** One approved operator attempt on a separate lane and caller ID. No retries. */
export async function placeOperatorCall(
  deps: { store: OutboundStore; plugin: PluginStore; sender: LiveCallSender; sessions: LiveCallRegistry; env: Record<string, string | undefined> },
  approval: ContactApprovalRow,
  now: Date,
): Promise<LiveResult> {
  const refused = (reason: string): LiveResult => ({ ok: false, reason, mayHaveSent: false });
  if (!(await operatorLineEnabled(deps.env, deps.plugin))) return refused("operator_line_disabled");
  const problem = operatorFromProblem(deps.env);
  if (problem) return refused(problem);
  const parsed = parseOperatorPayload(approval.payload, deps.env);
  if (!parsed.ok) return refused("invalid_operator_payload");
  const input = parsed.payload;
  const domain = resolveAppDomain({
    domain: deps.env.DOMAIN, replitDomains: deps.env.REPLIT_DOMAINS, replitDevDomain: deps.env.REPLIT_DEV_DOMAIN,
    isProduction: callEnvironment(deps.env) === "production",
  });
  if (domain.source === "fallback") return refused("no_public_host");
  let sessionId: string | undefined;
  let contactId: string | undefined;
  let attemptId: string | undefined;
  let sent = false;
  try {
    if (await operatorOptOutGuard(deps.store, deps.plugin, input.phone)) return refused("do_not_contact");
    // NO daily cap and NO peak window: operator attempts bypass campaign admission.
    const campaignId = await deps.store.ensureCampaign(OPERATOR_SLUG, OPERATOR_SLUG);
    if (!campaignId) return refused("no_campaign");
    const externalRef = `plugin:operator:${approval.id}`;
    await deps.store.upsertSourceContacts(campaignId, [{
      externalRef, phone: input.phone, firstName: null, lastName: null,
      data: { source: OPERATOR_SLUG, plugin_live: true, plugin_operator: true },
    }]);
    const source = (await deps.store.sourceRows(campaignId)).find((row) => row.externalRef === externalRef);
    if (!source) return refused("contact_missing");
    contactId = source.id;
    if (!(await deps.store.claimContact(contactId, now))) return refused("call_unavailable");
    attemptId = await deps.store.startAttempt(contactId, campaignId, 1);
    const session = deps.sessions.create({
      approvalId: approval.id, tokenJti: approval.tokenJti, contactId, attemptId, operatorCall: input,
      hardStop: (sid) => deps.sender.endCall(sid), persist: (record) => deps.plugin.saveOperatorCall(record),
    });
    sessionId = session.sessionId;
    // Fail closed before dialing if the transcript table is unavailable.
    await deps.sessions.persist(session);
    const query = new URLSearchParams({ contact: contactId, attempt: attemptId, liveSession: sessionId });
    if (await operatorOptOutGuard(deps.store, deps.plugin, input.phone)) throw new Error("do_not_contact");
    if (!(await operatorLineEnabled(deps.env, deps.plugin))) throw new Error("operator_line_disabled");
    if (session.endedAt) throw new Error("operator_deadline_exceeded");
    sent = true;
    const call = await boundedCall(deps.sender.createCall({
      to: input.phone, from: deps.env.OPERATOR_LINE_FROM_NUMBER!.trim(),
      url: `https://${domain.domain}/voice/${OPERATOR_SLUG}?${query}`,
      method: "POST", timeout: RING_TIMEOUT_SECONDS, timeLimit: input.maxDurationSec,
      statusCallback: `${statusUrl(domain.domain, OPERATOR_SLUG, contactId, attemptId)}&liveSession=${sessionId}`,
      statusCallbackMethod: "POST", statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    }));
    deps.sessions.bindCall(sessionId, call.sid);
    await deps.store.markContactDialled(contactId);
    await deps.store.setAttemptCallSid(attemptId, call.sid);
    return { ok: true, callSid: call.sid, sessionId };
  } catch (error) {
    if (isClearTwilioRefusal(error)) sent = false;
    if (!sent) {
      if (sessionId) deps.sessions.setStatus(sessionId, "failed");
      if (attemptId) await deps.store.finishAttempt(attemptId, { status: NOT_PLACED }).catch(() => undefined);
      if (contactId) await deps.store.settleContact(contactId, "rescheduled", { onlyIfCalling: true }).catch(() => false);
    }
    return { ok: false, reason: sent ? "send_unknown" : error instanceof Error && ["do_not_contact", "operator_line_disabled"].includes(error.message) ? error.message : "operator_call_unavailable",
      mayHaveSent: sent, ...(sessionId ? { sessionId } : {}) };
  }
}

// OPT-OUT GUARD (removable): the same durable voice DNC / SMS STOP stores
// used by callEnqueue. Keep all direct-call opt-out policy in this function.
export async function directCallOptOutGuard(store: OutboundStore, plugin: PluginStore, phone: string): Promise<string | null> {
  if (await store.isDoNotContact(phone) || await plugin.isSmsOptedOut(phone.slice(-10))) return "do_not_contact";
  return null;
}

/** Open line: no approval, identity, calling window, caps or routing probe. */
export async function placeDirectCall(
  deps: { store: OutboundStore; plugin: PluginStore; sender: LiveCallSender; sessions: LiveCallRegistry; env: Record<string, string | undefined> },
  input: { phone: string; purpose: string; name?: string; tokenJti: string },
  now: Date,
): Promise<LiveResult> {
  const refused = (reason: string): LiveResult => ({ ok: false, reason, mayHaveSent: false });
  const from = siAssistantNumber(deps.env);
  const dialing = siAssistantDialingProblem({ ...deps.env, SI_ASSISTANT_NUMBER: from });
  if (dialing) return refused(dialing);
  const domain = resolveAppDomain({
    domain: deps.env.DOMAIN, replitDomains: deps.env.REPLIT_DOMAINS, replitDevDomain: deps.env.REPLIT_DEV_DOMAIN,
    isProduction: callEnvironment(deps.env) === "production",
  });
  if (domain.source === "fallback") return refused("no_public_host");

  let sessionId: string | undefined;
  let contactId: string | undefined;
  let attemptId: string | undefined;
  let sent = false;
  try {
    const blocked = await directCallOptOutGuard(deps.store, deps.plugin, input.phone);
    if (blocked) return refused(blocked);
    const campaignId = await deps.store.ensureCampaign(SI_ASSISTANT_CAMPAIGN_KEY, SI_ASSISTANT_SLUG);
    if (!campaignId) return refused("no_campaign");
    const externalRef = `plugin:direct:${randomUUID()}`;
    // plugin_live excludes this single attempt from scheduler retries. Keep
    // purpose/persona in the live registry, never in the campaign ledger.
    await deps.store.upsertSourceContacts(campaignId, [{
      externalRef, phone: input.phone, firstName: null, lastName: null,
      data: { source: "si-assistant", plugin_live: true, plugin_direct: true },
    }]);
    const source = (await deps.store.sourceRows(campaignId)).find((row) => row.externalRef === externalRef);
    if (!source) return refused("contact_missing");
    contactId = source.id;
    const contact = await deps.store.claimContact(contactId, now);
    if (!contact) return refused("call_unavailable");
    attemptId = await deps.store.startAttempt(contactId, campaignId, 1);
    const session = deps.sessions.create({
      approvalId: null, tokenJti: input.tokenJti, contactId, attemptId,
      directCall: { purpose: input.purpose, ...(input.name ? { name: input.name } : {}) },
    });
    sessionId = session.sessionId;
    const query = new URLSearchParams({ contact: contactId, attempt: attemptId, liveSession: sessionId });
    sent = true;
    const call = await boundedCall(deps.sender.createCall({
      to: input.phone, from, url: `https://${domain.domain}/voice/si-assistant?${query}`,
      method: "POST", timeout: RING_TIMEOUT_SECONDS,
      statusCallback: `${statusUrl(domain.domain, SI_ASSISTANT_SLUG, contactId, attemptId)}&liveSession=${sessionId}`,
      statusCallbackMethod: "POST", statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    }));
    deps.sessions.bindCall(sessionId, call.sid);
    await deps.store.markContactDialled(contactId);
    await deps.store.setAttemptCallSid(attemptId, call.sid);
    return { ok: true, callSid: call.sid, sessionId };
  } catch (error) {
    if (isClearTwilioRefusal(error)) sent = false;
    if (!sent) {
      if (sessionId) deps.sessions.setStatus(sessionId, "failed");
      if (attemptId) await deps.store.finishAttempt(attemptId, { status: NOT_PLACED }).catch(() => undefined);
      if (contactId) await deps.store.settleContact(contactId, "rescheduled", { onlyIfCalling: true }).catch(() => false);
    }
    // An ambiguous send is never retried. Signed callbacks can still bind it.
    return { ok: false, reason: sent ? "send_unknown" : "direct_call_unavailable", mayHaveSent: sent, ...(sessionId ? { sessionId } : {}) };
  }
}
