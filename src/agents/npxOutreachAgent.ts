/**
 * The NPX outreach lane (v109) — the first real campaign on the runtime's
 * outbound layer.
 *
 * Operator, 2026-10-20: call Azul Vision patients whose routine eye exam is
 * weeks away and offer them a sooner one at an NPX partner practice that
 * takes their medical group. "3 weeks sooner is definitely worth a call." On
 * a yes, book it in NPX and cancel the Azul appointment.
 *
 * Who is called: the Console's live movable list (v107), re-checked per
 * person at the dial. What the call does: confirm who answered by their date
 * of birth, offer up to two sooner slots (NPX, EPC #281), book the one they
 * choose, cancel the Azul appointment, report it to NPX
 * (src/tools/npxOutreachTools.ts). A patient who rings the number back
 * reaches this same lane (v106).
 *
 * DARK UNTIL THE OPERATOR SAYS: nothing dials unless RUNTIME_OUTBOUND_DIALING=1,
 * OUTBOUND_CAMPAIGN_NPX_OUTREACH=1 and NPX_OUTREACH_CALLER_ID are set, the
 * caller-ID number's Voice URL points back at /voice/npx-outreach, and
 * NPX_OUTREACH_API_KEY is set (without it no slot can be offered).
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import type { ContactSource, OutboundContact, OutboundLanePolicy, SourceContact } from '../runtime/outbound/campaign';
import { OUTBOUND_RECORDING_CLAUSE } from '../runtime/outbound/campaign';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from '../runtime/outbound/callingWindow';
import { consoleMovableContactSource } from '../runtime/outbound/consoleMovable';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  NPX_OUTREACH_TOOLS,
} from '../tools/npxOutreachTools';

export const npxOutreachAgentConfig = {
  slug: 'npx-outreach',
  name: 'NPX Outreach Agent',
  description:
    'Outbound: offers patients on the Console movable list a sooner routine eye exam at an NPX partner ' +
    'that takes their medical group, books it, and cancels the Azul appointment it replaces.',
  version: '1.0.0',
  voice: 'sage',
  language: 'en',
} as const;

/** Confirms, never assumes: a phone answered by somebody else is the ordinary case. */
export function npxOutreachGreeting(contact: OutboundContact): string {
  const who = contact.firstName?.trim()
    ? `Am I speaking with ${contact.firstName.trim()}?`
    : 'May I ask who I am speaking with?';
  return `Hello, this is an automated assistant calling for Azul Vision. ${OUTBOUND_RECORDING_CLAUSE}. ${who}`;
}

/** Heard by whoever plays the machine back, so nothing about why we called. */
export const NPX_OUTREACH_VOICEMAIL =
  'Hello, this is Azul Vision calling with a message. Please call us back at this number when you have a moment. Thank you.';

/** Said to somebody who rang back, once identify_callback_caller has settled
 * who they are — still nothing about an appointment until their date of
 * birth is confirmed. */
export const NPX_OUTREACH_CALLBACK_PURPOSE =
  'we were calling with some information for them, and before going over it you need to confirm their date of birth.';

/**
 * THE PILOT LEVERS, both optional, both read at every refresh:
 *  - NPX_OUTREACH_GROUPS: medical groups to call, comma-separated, matched on
 *    the Console's payer name ignoring case ("Regal CAP"). Unset: every group.
 *  - NPX_OUTREACH_LIMIT: at most this many appointments queued, earliest
 *    first (the list's own order). Unset: no limit.
 * A row the levers leave out is simply not queued; one already queued is
 * re-checked at the dial like any other.
 */
export function pilotSource(source: ContactSource, env: Record<string, string | undefined> = process.env): ContactSource {
  return {
    ...source,
    async list(now) {
      const all: SourceContact[] = await source.list(now);
      const groups = (env.NPX_OUTREACH_GROUPS ?? '')
        .split(',')
        .map((g) => g.trim().toLowerCase())
        .filter(Boolean);
      const inGroup = groups.length
        ? all.filter((c) => groups.includes(String(c.data.medical_group ?? '').trim().toLowerCase()))
        : all;
      const limit = Number(env.NPX_OUTREACH_LIMIT);
      return Number.isInteger(limit) && limit > 0 ? inGroup.slice(0, limit) : inGroup;
    },
  };
}

export const npxOutreachPolicy: OutboundLanePolicy = {
  campaignKey: 'npx-outreach',
  enableEnv: 'OUTBOUND_CAMPAIGN_NPX_OUTREACH',
  // Its own number, not the proving lane's: the number patients see is the
  // number they ring back, and its Voice URL can point at one lane only.
  callerIdEnv: 'NPX_OUTREACH_CALLER_ID',
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 2,
  greeting: npxOutreachGreeting,
  voicemail: () => NPX_OUTREACH_VOICEMAIL,
  callbackPurpose: NPX_OUTREACH_CALLBACK_PURPOSE,
  source: async () => {
    const live = await consoleMovableContactSource();
    return live ? pilotSource(live) : null;
  },
  tools: NPX_OUTREACH_TOOLS,
};

function buildPrompt(contact: OutboundContact | undefined, returnedCall: boolean): string {
  const name = contact?.firstName?.trim() || 'the patient';
  const opening = returnedCall
    ? `### Greeting
Your opening has already been spoken: that this is Azul Vision's automated assistant, that the call is recorded, and a question about who is calling. Do not say it again.
### Who rang
Find out who is calling with identify_callback_caller. Once it answers identified, say why we called in the words it gives you, then ask for their date of birth.`
    : `### Greeting
Your opening has already been spoken: who is calling, that it is automated, that the call is recorded, and whether you are speaking with ${name}. Do not say it again.
### Who answered
- Yes: ask for their date of birth.
- ${name} is not available: ask nothing else and say nothing about why we called. Call record_call_outcome with call_back_later, thank them, say goodbye and call end_call.
- Nobody by that name at this number: apologise, call record_call_outcome with wrong_person, say goodbye and call end_call.`;
  return `## Role & Persona
You are Azul Vision's automated calling assistant. You are warm, clear and brief, and you never pretend to be a person.

## Objective
Offer the patient a sooner routine eye exam at a partner practice that takes their medical group, and book it if they want it. Booking it cancels their current appointment with Azul Vision.

## Conversation Flow
${opening}
### Confirm who you are speaking with
Ask: "And your date of birth, starting with the month, then the day, then the year?" Then call ${CONFIRM_DOB_TOOL_NAME} with what they say. Until it answers verified you know nothing about their appointments, so say nothing about any.
### The offer
When it answers verified, tell them what it says about their current appointment, and that we may be able to get them seen sooner. If they want to hear the options, call ${FIND_SOONER_TOOL_NAME} and read each option in order. If they would rather keep their current appointment, thank them, call record_call_outcome with not_interested, say goodbye and call end_call.
### Booking
When they choose, say the option back in full, say that booking it cancels their current appointment with us, and ask them to confirm. On a yes, call ${BOOK_SOONER_TOOL_NAME} with the option number and say the confirmation it gives you, word for word.
### Close
Ask if there is anything else about this, then say goodbye and call end_call.

## Guardrails & Escalation
- Never say a date of birth, and never say whether one was close.
- If they ask not to be called again, call opt_out_of_calls at once, say only what it tells you, then call end_call.
- You cannot transfer calls. If they want to talk to someone, say you cannot transfer this call and that their current appointment stays exactly as it is unless they choose to move it.
- Medical questions: say you can only help with the appointment on this call.
- When a tool tells you what to say or do next, do that.

## Voice & Communication Style
Short sentences. One question at a time, then stop and listen. Say dates and times the way a person would.`;
}

export function createNpxOutreachAgent(
  _handoffToHuman: () => Promise<void>,
  metadata: { outbound?: OutboundContact; callback?: unknown } = {},
): RealtimeAgent {
  return new RealtimeAgent({
    name: npxOutreachAgentConfig.name,
    voice: npxOutreachAgentConfig.voice,
    instructions: buildPrompt(metadata.outbound, Boolean(metadata.callback)),
    // None of its own: every tool this call uses is the runtime's — the three
    // every dialled call carries, identify_callback_caller on a returned
    // call, and this lane's own (npxOutreachPolicy.tools).
    tools: [],
  });
}
