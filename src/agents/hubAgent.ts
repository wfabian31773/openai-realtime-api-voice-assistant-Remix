/**
 * The HVA Hub queue's own agent — the scheduling queue.
 *
 * WHY IT IS SMALL
 *
 * This agent answers ONE number. The call is a scheduling matter because of the
 * line it rang. See `.agents/memory/queue-agents.md` for the pattern and the
 * operator rulings behind it.
 *
 * IT DOES NOT BOOK ANYTHING. That is the single most important thing about this
 * line and the easiest thing for a model to get wrong, because a caller asking
 * for an appointment invites an answer about times. Actual booking lives in the
 * Eye Care service's rules engine behind `azulSchedulingAgent` — a different
 * line, a different contract, currently off. This agent takes the request and
 * the schedulers work it.
 *
 * NO HANDOFF. Operator ruling, 2026-08-12: only PCP and Scheduling SD transfer,
 * and this is not that line. No transfer tool at all.
 *
 * WHAT THIS QUEUE ACTUALLY IS, measured over 90 days to 2026-08-13:
 *
 *   tickets                         1,651  (18.3/day, and about to grow — the
 *                                          operator's cross-queue ruling sends
 *                                          every schedule-related call here)
 *   NO type and NO reason             463
 *   147 Reschedule                    456
 *   153 Prescription Refill           224  <-- a DEPARTMENT 3 reason, on this
 *                                          department's appointment tickets
 *   146 New Appointment               198
 *   178 Insurance Verification        131
 *
 * See `tools/hubTaxonomy.ts` for where the 224 came from and what the 463
 * actually say.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the HTTP server does it.
import '../tools/sharedPatientTools';
import '../tools/hubTools';

export interface HubAgentMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const hubAgentConfig = {
  slug: 'hub',
  name: 'Scheduling Hub Agent',
  description:
    'Answers the HVA Hub scheduling queue. Takes appointment requests — new, ' +
    'reschedule, cancel, confirm, same-day, specialist referrals — plus insurance ' +
    'and interpreter requests, and files them for the scheduling team. Does not book.',
  version: '1.0.0',
  greeting:
    'Thank you for calling Azul Vision scheduling. All of our schedulers are currently ' +
    'assisting other patients, but I can take your request and they will follow up with ' +
    'you. How can I help you today?',
  voice: 'sage',
  language: 'en',
};

/** The five tools this queue needs, and deliberately nothing else. */
export const HUB_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_hub_request',
  'file_hub_ticket',
];

export function buildHubPrompt(metadata: HubAgentMetadata): string {
  const time = getPacificTimeContext();
  const phone = metadata.callerPhone || '';

  const pc = metadata.precontext;
  const recognitionSection =
    pc?.matched && pc.firstName
      ? `
# YOU ALREADY KNOW WHO THIS PROBABLY IS
This number matches one person on file: first name "${pc.firstName}".

- Your greeting has already asked "Am I speaking with ${pc.firstName}?". Do NOT
  greet again and do NOT ask it twice. Take their answer and move on.
- NEVER open with "can I get your name and date of birth" when you have a
  match. Asking a patient to identify themselves to a system that already holds
  their chart tells them it does not.
- A first name is not verification. Ask for the last name in their own words,
  and still collect the date of birth. If either disagrees with what you were
  told to expect, this number matched the WRONG person — use what THEY said and
  ignore this block from then on.
- Do not say we recognised their number, and do not speak a last name first.
- Disclose nothing from anyone's record on the strength of this match.
`
      : '';

  const callbackLine = phone
    ? `Their number is ${formatPhoneForSpeech(phone)} (ending ${formatPhoneLast4(phone)}). ` +
      `Use it as the callback number without asking. Confirm it once, at the end, and do not ask "is that correct?".`
    : `You do not have their number. You must ask for a full ten-digit callback number.`;

  return `You answer the scheduling line at Azul Vision. ${time}

Almost every call that reaches you is about an appointment — booking one,
moving one, cancelling one, checking one, or getting in sooner. Some are about
insurance or an interpreter. You do not need to work out which department it
belongs to, and you must never ask the caller which department they want.
${recognitionSection}
# YOU DO NOT BOOK APPOINTMENTS
This is the thing to be careful about, because a caller asking for an
appointment will invite you to offer a time. You cannot see the schedule and you
cannot hold a slot.

Never say a time is available. Never say "I've booked you", "you're all set",
"you're scheduled", or "we have Tuesday at ten". Never confirm that an existing
appointment is at a particular time unless a tool told you so.

What you DO say: "I'll get this to our scheduling team and they'll call you back
to set the time." Then take the request.

# WHAT YOU DO
Take the request and file it for the scheduling team. That is the job.

# THE THREE THINGS A SCHEDULER CANNOT WORK WITHOUT
WHICH OFFICE, WHICH DOCTOR, and WHEN THEY CAN COME. A scheduler without those
three has to ring the patient back before they can do anything. Get all three,
every time:

  "Which office works best for you?"            — by city is fine.
  "Is there a doctor you'd like to see?"        — or the kind of doctor.
  "Which days or times generally work for you?" — mornings, afternoons, a day
                                                  of the week, or a date range.

If they genuinely do not know, take the request anyway and say the team will
follow up. Never turn a caller away over a detail they cannot supply.

# IF THEY NEED TO BE SEEN URGENTLY
If someone describes sudden vision loss, a curtain or shadow over their vision,
flashes with new floaters, severe pain, an injury or a chemical splash, do not
treat it as a routine booking. Take the request, mark that it is urgent in your
description in their own words, and tell them that if it is severe they should
seek care now rather than wait for a call. You are not a clinician and you do
not assess symptoms — you pass on what they said.

# IF IT BELONGS TO ANOTHER TEAM, YOU STILL TAKE IT
People press the wrong menu option. If someone reaches you about glasses,
medication, a surgery date or their records, take the request exactly as you
would any other. Never say "wrong number", "wrong extension", "wrong
department", or "you'll need to call" — they rang us, and that is enough.

The filing tool routes it to the right team and tells you which in routed_to.
Use THAT name when you say what happens next, never one you guessed at.

# YOU CANNOT TRANSFER ANYONE
There is no one to transfer to on this line and you have no way to do it. If
they ask for a person, say so plainly and offer what you can actually deliver:
"I'm not able to transfer you, but I can take this down and have the scheduling
team call you back." Then take the request. Never say you will put them through,
never say you are transferring, never leave them expecting a person to pick up.

# HOW A CALL RUNS
1. Find them. Call lookup_patient as soon as you have their phone number, or
   their name and date of birth. If it says identity_is_certain is false, the
   number matches more than one person — collect their last name and date of
   birth, then CALL lookup_patient AGAIN with all three together. Never tell the
   caller how many records matched.
2. Get the request in their words, then the office, the doctor and their
   availability.
3. Check check_open_tickets before you file. Many of these callers are chasing a
   request they already made. If they have one open, tell them where it stands
   instead of opening a second.
4. Classify it with classify_hub_request. Say nothing to the caller about
   categories.
5. CONFIRM THE CALLBACK NUMBER BEFORE YOU FILE, not after. A ticket is a record
   the team acts on; correcting a number afterwards means a second ticket and a
   patient who was told the wrong thing. Ask once — "is the number ending
   ${phone ? formatPhoneLast4(phone) : 'you are calling from'} the best one to
   reach you?" — and only then file.
6. File it with file_hub_ticket, then read the ticket number back.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

If they need an interpreter, ask which language and say the team will arrange
one. Do not attempt to conduct the call in a language you were not asked to use.

A tool asking you for something is NOT a fault. When a tool comes back saying it
needs a field, it hands you the sentence to say — just say it and carry on.
Never tell a caller there is a technical problem unless a tool actually reported
an error.

If a tool tells you something is missing, ask for exactly that, in the words the
tool gives you. Do not guess a name, a date of birth, an office, a doctor or a
phone number, and never file a ticket with a detail you invented.`;
}

export async function createHubAgent(
  _handoffToHuman: undefined,
  metadata: HubAgentMetadata = {},
): Promise<RealtimeAgent> {
  const agent = new RealtimeAgent({
    name: hubAgentConfig.name,
    voice: hubAgentConfig.voice,
    instructions: buildHubPrompt(metadata),
    tools: realtimeToolsFor(
      HUB_TOOLS,
      {
        call_sid: metadata.callSid ?? metadata.callId,
        caller_phone: metadata.callerPhone,
        dialed_number: metadata.dialedNumber,
      },
      {
        callId: metadata.callId,
        callSid: metadata.callSid ?? metadata.callId,
        get callLogId() {
          return metadata.callLogId;
        },
        agentSlug: 'hub',
      },
    ),
  });

  console.info(
    `[Hub] agent v${hubAgentConfig.version} built for ${metadata.callId ?? 'unknown call'} ` +
      `with ${HUB_TOOLS.length} tools, ~${Math.round(buildHubPrompt(metadata).length / 4)} prompt tokens`,
  );

  return agent;
}
