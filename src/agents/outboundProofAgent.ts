/**
 * The outbound proving lane — the runtime's outbound layer end to end, on a
 * campaign only the operator's own numbers are queued in.
 *
 * Operator, 2026-10-20: "this is not the first time we will need outbound
 * agents." The layer (src/runtime/outbound/) is built for every campaign to
 * come; this lane exists so the dial, the voicemail branch, the stream, the
 * opt-out and the hangup can be proven on a real phone before the first real
 * campaign (NPX outreach) carries a patient's appointment. It says nothing
 * about anybody's care and books nothing.
 *
 * Rollout is the operator's: nothing dials unless RUNTIME_OUTBOUND_DIALING=1,
 * OUTBOUND_CAMPAIGN_OUTBOUND_PROOF=1 and OUTBOUND_CALLER_ID are set, and only
 * the contacts queued in the `outbound-proof` campaign are ever rung.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import type { OutboundContact, OutboundLanePolicy } from '../runtime/outbound/campaign';
import { OUTBOUND_RECORDING_CLAUSE } from '../runtime/outbound/campaign';
import { DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';

export const outboundProofAgentConfig = {
  slug: 'outbound-proof',
  name: 'Outbound Proving Agent',
  description:
    'Operator-only outbound proving lane: proves the runtime outbound layer (dial, voicemail, ' +
    'stream, opt-out, hangup) on the operator’s own phone. Books nothing.',
  version: '1.0.0',
  voice: 'sage',
  language: 'en',
} as const;

/** Who is being called, said as a question: the greeting confirms, it never
 * assumes — a phone answered by somebody else is the ordinary case. */
export function outboundProofGreeting(contact: OutboundContact): string {
  const who = contact.firstName?.trim()
    ? `Am I speaking with ${contact.firstName.trim()}?`
    : 'May I ask who I am speaking with?';
  return `Hello, this is an automated assistant calling for Azul Vision. ${OUTBOUND_RECORDING_CLAUSE}. ${who}`;
}

export const OUTBOUND_PROOF_VOICEMAIL =
  'Hello, this is a test call from Azul Vision’s phone system. No action is needed. Goodbye.';

export const outboundProofPolicy: OutboundLanePolicy = {
  campaignKey: 'outbound-proof',
  enableEnv: 'OUTBOUND_CAMPAIGN_OUTBOUND_PROOF',
  callerIdEnv: 'OUTBOUND_CALLER_ID',
  window: DEFAULT_CALLING_WINDOW,
  // Looser than a patient campaign, on purpose: the operator re-tests the
  // same number several times in a day. Still bounded, so a stuck queue row
  // cannot ring his phone all afternoon.
  caps: { perDay: 5, perWeek: 20, total: 50, minHoursBetween: 0 },
  concurrency: 1,
  greeting: outboundProofGreeting,
  voicemail: () => OUTBOUND_PROOF_VOICEMAIL,
};

function buildPrompt(contact: OutboundContact | undefined): string {
  const name = contact?.firstName?.trim() || 'the person you are calling';
  return `## Role & Persona
You are Azul Vision's automated calling assistant, placing a test call from the practice's phone system. You are calm, brief and friendly. You never pretend to be a person.

## Objective
Prove that the call works: confirm you have reached ${name}, check they can hear you clearly, and end the call politely.

## Conversation Flow
### Greeting
Your opening has already been spoken: who is calling, that it is automated, that the call is recorded, and whether you are speaking with ${name}. Do not say it again.
### Confirm who answered
If they say yes, say this is a test of Azul Vision's phone system and ask whether they can hear you clearly. If they say no, or that ${name} is not there, apologise for the interruption, call record_call_outcome with wrong_person, say goodbye and call end_call.
### Close
Once they have answered whether they can hear you, thank them, call record_call_outcome with done, say goodbye, and call end_call.

## Guardrails & Escalation
If they ask not to be called, or to be taken off the list, call opt_out_of_calls at once and say only what it tells you to say, then call end_call. Never discuss anybody's health, appointments or records on this call. If they ask what this is about, say it is a test of the practice's phone system and nothing is needed from them.

## Voice & Communication Style
Short sentences. One question at a time, then stop and listen.`;
}

export function createOutboundProofAgent(
  _handoffToHuman: () => Promise<void>,
  metadata: { outbound?: OutboundContact } = {},
): RealtimeAgent {
  return new RealtimeAgent({
    name: outboundProofAgentConfig.name,
    voice: outboundProofAgentConfig.voice,
    instructions: buildPrompt(metadata.outbound),
    // Nothing of its own: opt-out, outcome and hangup are the runtime's,
    // bound to every dialled call (laneRegistry RUNTIME_OUTBOUND_TOOLS).
    tools: [],
  });
}
