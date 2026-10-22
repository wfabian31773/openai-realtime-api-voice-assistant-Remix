/**
 * The NPX outreach lane (v110) — the first real campaign on the runtime's
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
 * OUTBOUND_CAMPAIGN_NPX_OUTREACH=1 and NPX_OUTREACH_CALLER_ID are set and the
 * caller-ID number's Voice URL points back at /voice/npx-outreach.
 *
 * DEMO UNTIL SOMEBODY WRITES `live` (v112). NPX_OUTREACH_MODE decides who is
 * called and where they are booked; nothing else changes at the switch — the
 * lane, the caller ID, the Voice URL, the agent and the voice are the same
 * (operator, 2026-10-22: "switching over to production should be a env
 * switch"):
 *  - unset or anything but `live`: the synthetic patients in
 *    src/agents/npxOutreachDemo.ts on NPX_OUTREACH_DEMO_PHONES, the demo NPX
 *    with NPX_OUTREACH_DEMO_API_KEY, the Azul cancel and the staff ticket
 *    simulated, test caps, the `npx-outreach-demo` campaign row;
 *  - `live`: the Console's movable list, production NPX with
 *    NPX_OUTREACH_API_KEY, the real Azul cancel and staff ticket, patient
 *    caps, the `npx-outreach` campaign row.
 * Each mode rings nobody without its own key, so a half-configured switch
 * fails closed. Read when used, so a republish is what moves it.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import type { ContactSource, OutboundContact, OutboundLanePolicy, SourceContact } from '../runtime/outbound/campaign';
import { OUTBOUND_RECORDING_CLAUSE } from '../runtime/outbound/campaign';
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW, type AttemptCaps } from '../runtime/outbound/callingWindow';
import { consoleMovableContactSource } from '../runtime/outbound/consoleMovable';
import { createNpxOutreachClient } from '../services/npxOutreachClient';
import {
  BOOK_SOONER_TOOL_NAME,
  CONFIRM_DOB_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  FIND_SOONER_TOOL_NAME,
  NPX_OUTREACH_DEMO_CAMPAIGN_KEY,
  NPX_OUTREACH_LIVE_CAMPAIGN_KEY,
  NPX_OUTREACH_TOOLS,
  STAFF_CALLBACK_TOOL_NAME,
  npxOutreachMode,
} from '../tools/npxOutreachTools';
import { NPX_OUTREACH_DEMO_CAPS, npxOutreachDemoSource } from './npxOutreachDemo';

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

/**
 * Who is calling, that it is automated and that it is recorded, then asks
 * for the patient by first name (operator, 2026-10-21: "may I speak to … I'm
 * looking for whoever"). Asks, never assumes: a phone answered by somebody
 * else is the ordinary case, and why we called waits for their answer.
 */
export function npxOutreachGreeting(contact: OutboundContact): string {
  const who = contact.firstName?.trim()
    ? `May I speak with ${contact.firstName.trim()}?`
    : 'May I ask who I am speaking with?';
  return `Hello, this is an automated assistant calling for Azul Vision. ${OUTBOUND_RECORDING_CLAUSE}. ${who}`;
}

/** Heard by whoever plays the machine back, so nothing about why we called. */
export const NPX_OUTREACH_VOICEMAIL =
  'Hello, this is Azul Vision calling with a message. Please call us back at this number when you have a moment. Thank you.';

/** Said to somebody who rang back, once identify_callback_caller has settled
 * who they are: the same opening as a dialled call, from the same tool, so a
 * returned call hears what the call they missed would have said. */
export const NPX_OUTREACH_CALLBACK_PURPOSE =
  `we called about their upcoming appointment. Call ${DESCRIBE_TOOL_NAME} and say what it gives you, word for word.`;

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

let warnedNoKey = false;

/**
 * The campaign's people, or null — and null means the dialler rings nobody.
 * Without NPX_OUTREACH_API_KEY no slot can be offered, so a deployment with
 * the two switches and the caller ID set but no key would ring patients, take
 * their date of birth and spend their attempts on an offer that cannot exist
 * (Codex P1, #361). The key is read through the client's own check, so the
 * rule that refuses the call and the rule that refuses the offer are one rule.
 */
export async function npxOutreachSource(
  env: Record<string, string | undefined> = process.env,
  liveSource: () => Promise<ContactSource | null> = consoleMovableContactSource,
): Promise<ContactSource | null> {
  if (!createNpxOutreachClient(env).configured) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn('[NPX OUTREACH] NOT dialling: NPX_OUTREACH_API_KEY is not set, so no sooner exam could be offered');
    }
    return null;
  }
  const live = await liveSource();
  return live ? pilotSource(live, env) : null;
}

/**
 * One policy for both modes. The fields the mode moves are getters, read by
 * the dialler, the answer webhook and the runtime at the moment they act, so
 * every reader in one process sees one mode. The campaign ROW differs by mode
 * on purpose: test calls never land among the live campaign's contacts,
 * attempts or counts, and a test number is never a candidate when a patient
 * rings back in live mode.
 */
export const npxOutreachPolicy: OutboundLanePolicy = {
  get campaignKey(): string {
    return npxOutreachMode() === 'live' ? NPX_OUTREACH_LIVE_CAMPAIGN_KEY : NPX_OUTREACH_DEMO_CAMPAIGN_KEY;
  },
  enableEnv: 'OUTBOUND_CAMPAIGN_NPX_OUTREACH',
  // Its own number, not the proving lane's: the number patients see is the
  // number they ring back, and its Voice URL can point at one lane only. The
  // same number in both modes, so going live needs no Twilio change.
  callerIdEnv: 'NPX_OUTREACH_CALLER_ID',
  window: DEFAULT_CALLING_WINDOW,
  get caps(): AttemptCaps {
    return npxOutreachMode() === 'live' ? DEFAULT_ATTEMPT_CAPS : NPX_OUTREACH_DEMO_CAPS;
  },
  get concurrency(): number {
    return npxOutreachMode() === 'live' ? 2 : 1;
  },
  greeting: npxOutreachGreeting,
  voicemail: () => NPX_OUTREACH_VOICEMAIL,
  callbackPurpose: NPX_OUTREACH_CALLBACK_PURPOSE,
  source: () => (npxOutreachMode() === 'live' ? npxOutreachSource() : npxOutreachDemoSource()),
  tools: NPX_OUTREACH_TOOLS,
  mode: (env) => npxOutreachMode(env),
};

/**
 * THE ORDER IS THE OPERATOR'S (2026-10-21), the same both ways: the patient is
 * asked for (or, on a returned call, greeted) by first name; on their answer
 * the agent says the kind of visit they have booked and its date, that we
 * would like to offer a sooner appointment, and asks if that interests them;
 * on a yes it confirms their date of birth, month then day then year, and
 * only then offers times. Before the date of birth matches, the visit and its
 * date are all that is said — not the time, the office or the doctor — and
 * both come from describe_upcoming_appointment, never from this prompt, which
 * carries nothing from the record (the v47 lesson).
 */
function buildPrompt(contact: OutboundContact | undefined, returnedCall: boolean): string {
  const name = contact?.firstName?.trim() || 'the patient';
  const opening = returnedCall
    ? `### Greeting
Your opening has already been spoken: thanks for calling, that this is Azul Vision's automated assistant, and that the call is recorded. When their number matched one person it greeted them by first name. Do not say it again.
### Who rang
Find out who is calling with identify_callback_caller, as the returned-call steps say. Once it answers identified, call ${DESCRIBE_TOOL_NAME} and say what it gives you, word for word.`
    : `### Greeting
Your opening has already been spoken: who is calling, that it is automated, that the call is recorded, and a request to speak with ${name}. Do not say it again.
### Who answered
- It is ${name} ("yes", "speaking", "this is them"): call ${DESCRIBE_TOOL_NAME} and say what it gives you, word for word.
- ${name} is not available: ask nothing else and say nothing about why we called. Call record_call_outcome with call_back_later, thank them, say goodbye and call end_call.
- Nobody by that name at this number: apologise, call record_call_outcome with wrong_person, say goodbye and call end_call.`;
  return `## Role & Persona
You are Azul Vision's automated calling assistant. You are warm, clear and brief, and you never pretend to be a person.

## Objective
Offer the patient a sooner appointment at a partner practice that takes their medical group, and book it if they want it. Booking it cancels their current appointment with Azul Vision.

## Conversation Flow
${opening}
### Confirm who you are speaking with
If they want to hear about a sooner appointment, say: "In order to continue, let me confirm your identity. Can I please have your date of birth, starting with the month, then the day, then the year?" Then call ${CONFIRM_DOB_TOOL_NAME} with what they say. If they would rather keep their current appointment, thank them, call record_call_outcome with not_interested, say goodbye and call end_call.
### The options
When it answers verified, call ${FIND_SOONER_TOOL_NAME} and read each option in order.
### Booking
When they choose, say the option back in full, say that booking it cancels their current appointment with us, and ask them to confirm. On a yes, call ${BOOK_SOONER_TOOL_NAME} with the option number and say the confirmation it gives you, word for word.
### Close
Ask if there is anything else about this, then say goodbye and call end_call.

## Guardrails & Escalation
- Until ${CONFIRM_DOB_TOOL_NAME} answers verified, say nothing about their appointment beyond what ${DESCRIBE_TOOL_NAME} gives you: the kind of visit and its date. Never the time, the office or the doctor.
- Never say a date of birth, and never say whether one was close.
- If they ask not to be called again, call opt_out_of_calls at once, say only what it tells you, then call end_call.
- You cannot transfer calls. If they ask for a person, or for something this call cannot do, call ${STAFF_CALLBACK_TOOL_NAME} with what they want and say what it tells you.
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
