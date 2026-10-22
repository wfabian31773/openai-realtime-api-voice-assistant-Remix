/**
 * SI Assistant lane — the Support Center bot's dedicated number
 * (+1 909-255-3213). The runtime outbound layer places approved single-
 * contact calls; this same lane answers when the person rings that number
 * back (operator, 2026-10-21: there is no redirect).
 *
 * Identifies itself as an AI assistant. Never pretends to be a person.
 * Dials nobody unless RUNTIME_OUTBOUND_DIALING=1,
 * OUTBOUND_CAMPAIGN_SI_ASSISTANT=1 and SI_ASSISTANT_NUMBER are set, and
 * that number's Voice URL points at /voice/si-assistant.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import type { OutboundContact, OutboundLanePolicy } from '../runtime/outbound/campaign';
import { OUTBOUND_RECORDING_CLAUSE } from '../runtime/outbound/campaign';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import {
  SI_ASSISTANT_CALLER_ID_ENV,
  SI_ASSISTANT_CAMPAIGN_KEY,
  SI_ASSISTANT_ENABLE_ENV,
  SI_ASSISTANT_SLUG,
} from '../plugin/siAssistantConstants';
import { TAKE_MESSAGE_TOOL_NAME } from '../tools/siAssistantTools';

export const SI_ASSISTANT_TOOLS = [TAKE_MESSAGE_TOOL_NAME] as const;

export const siAssistantAgentConfig = {
  slug: SI_ASSISTANT_SLUG,
  name: 'SI Assistant',
  description:
    'Azul Vision SI Assistant: approved callbacks, texts and emails from the Support Center. ' +
    'Identifies as an AI assistant. Never pretends to be a person.',
  version: '1.0.0',
  voice: 'sage',
  language: 'en',
} as const;

export function siAssistantGreeting(contact: OutboundContact): string {
  const who = contact.firstName?.trim()
    ? `Am I speaking with ${contact.firstName.trim()}?`
    : 'May I ask who I am speaking with?';
  return `Hello, this is Azul Vision's SI Assistant, an automated AI assistant. ${OUTBOUND_RECORDING_CLAUSE}. ${who}`;
}

export const SI_ASSISTANT_VOICEMAIL =
  "Hello, this is Azul Vision's SI Assistant, an automated AI assistant. Please call us back at this number when you have a moment. Thank you.";

export const SI_ASSISTANT_CALLBACK_PURPOSE =
  'we called about a request our support team is working on for them.';

export const siAssistantPolicy: OutboundLanePolicy = {
  campaignKey: SI_ASSISTANT_CAMPAIGN_KEY,
  enableEnv: SI_ASSISTANT_ENABLE_ENV,
  callerIdEnv: SI_ASSISTANT_CALLER_ID_ENV,
  window: DEFAULT_CALLING_WINDOW,
  caps: { ...DEFAULT_ATTEMPT_CAPS, perDay: 1, perWeek: 3 },
  concurrency: 1,
  greeting: siAssistantGreeting,
  voicemail: () => SI_ASSISTANT_VOICEMAIL,
  callbackPurpose: SI_ASSISTANT_CALLBACK_PURPOSE,
  tools: SI_ASSISTANT_TOOLS,
};

function buildPrompt(contact: OutboundContact | undefined, returnedCall: boolean): string {
  const name = contact?.firstName?.trim() || 'the person you are calling';
  const opening = returnedCall
    ? `### Greeting
Your opening has already been spoken: that this is Azul Vision's SI Assistant, an automated AI assistant, and that the call is recorded, and a question about who is calling. Do not say it again.
### Once they are identified
Tell them you called about a request our support team is working on, and ask how you can help.`
    : `### Greeting
Your opening has already been spoken: who is calling, that you are an automated AI assistant, that the call is recorded, and whether you are speaking with ${name}. Do not say it again.
### Confirm who answered
If they say yes, say you are following up on a request our support team is working on and ask how you can help. If they say no, or that ${name} is not there, apologise for the interruption, call record_call_outcome with wrong_person, say goodbye and call end_call.`;

  const objective = returnedCall
    ? 'Somebody has rung back the SI Assistant number. Identify them, tell them the missed call was from Azul Vision\'s AI assistant about a support request, take a short message if they have one, and end the call politely.'
    : `Confirm you have reached ${name}, say this is Azul Vision's SI Assistant following up on a support request, take their reply, and end the call politely.`;

  return `## Role & Persona
You are Azul Vision's SI Assistant, an automated AI assistant on the practice's phone system. You are calm, brief and friendly. You never pretend to be a person. If asked whether you are human, say you are an AI assistant.

## Objective
${objective}

## Conversation Flow
${opening}
### Close
Thank them, call record_call_outcome with done, say goodbye, and call end_call.

## Guardrails & Escalation
You cannot transfer this call or schedule an appointment. If they ask for a person, or have a message for the support team, ask what they would like the team to know, then call take_si_assistant_message with their words. Say only what that tool tells you to say. You cannot transfer. If they ask not to be called, call opt_out_of_calls at once and say only what it tells you to say, then call end_call. Do not invent clinical advice.

## Voice & Communication Style
Short sentences. One question at a time, then stop and listen. Always identify as an AI assistant if there is any doubt.`;
}

export function createSiAssistantAgent(
  _handoffToHuman: () => Promise<void>,
  metadata: { outbound?: OutboundContact; callback?: unknown } = {},
): RealtimeAgent {
  return new RealtimeAgent({
    name: siAssistantAgentConfig.name,
    voice: siAssistantAgentConfig.voice,
    instructions: buildPrompt(metadata.outbound, Boolean(metadata.callback)),
    tools: [],
  });
}
