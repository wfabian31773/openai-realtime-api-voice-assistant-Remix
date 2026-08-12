/**
 * The Optical queue's own agent.
 *
 * WHY IT IS SMALL
 *
 * This agent answers ONE number. The answering service forwards optical
 * overflow to it, so the call is optical because of the line it rang — not
 * because a model decided. Almost all of the answering-service prompt (~4,900
 * tokens) is that decision: which department, which request type, which guard.
 * None of it is needed here, and none of it can be got wrong here.
 *
 * What is left is the job: work out who is calling, which office they use,
 * whether they have already asked, what kind of optical request it is, and file
 * it. That is five tools, and they come from the shared library rather than
 * being redeclared — the agent and the HTTP surface run the same code.
 *
 * NO HANDOFF. Operator ruling, 2026-08-12: "there is no handoff for any of the
 * answering service agents, only for PCP, Scheduling SD. All other agents
 * politely state they are unable to handoff and can only create a request for a
 * callback." This agent therefore has no transfer tool at all — not a disabled
 * one, not one that reports a request. A tool the agent cannot see is a promise
 * it cannot make.
 *
 * WHAT THE QUEUE ACTUALLY DOES, measured over 90 days (1,744 tickets, 97% from
 * a voice agent):
 *
 *   location missing on   2.1%   — the hard-require works, keep it
 *   no request type on   42.0%   — classification is the gap
 *   reason 153 on        54.6%   — a Technicians Support medication-refill
 *                                  reason, on optical tickets
 *
 * Optical's contract (`ticket-workflow/MASTER.md` §9, operator-dictated,
 * FINAL): anything optical EXCEPT appointment requests; LOCATION is
 * hard-required because there is one optician per office and assignment is
 * driven by location.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the HTTP server does it.
import '../tools/opticalTools';

export interface OpticalAgentMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  /**
   * Caller-ID pre-context — who this number matches, before the caller says
   * anything.
   *
   * Operator, 2026-08-12, on why this is not cosmetic: "it lets the person know
   * that, hey, I have your information in my hand so I'm able to help... if
   * they know my name, they might know when my next appointment is." Opening
   * cold with "can I get your name and date of birth" tells a patient the
   * opposite — that they are starting from nothing.
   */
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const opticalAgentConfig = {
  slug: 'optical',
  name: 'Optical Support Agent',
  description:
    'Answers the Optical queue. Takes optical requests — glasses, lenses, contacts, ' +
    'pickups — and files them for the optician at the caller\'s office.',
  version: '1.0.0',
  // Operator-dictated, 2026-08-12. Two jobs in one sentence: say why a person
  // is not answering, and say what WILL happen — so the caller does not spend
  // the call trying to reach a human this line has no way to reach. Also the
  // honest framing for compliance later: nobody is told they are talking to a
  // person.
  greeting:
    'Thank you for calling Azul Vision optical. All of our opticians are currently ' +
    'assisting other customers, but I can take a message and they will follow up with you. ' +
    'How can I help you today?',
  voice: 'sage',
  language: 'en',
};

/** The five tools this queue needs, and deliberately nothing else. */
export const OPTICAL_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_optical_request',
  'file_optical_ticket',
];

export function buildOpticalPrompt(metadata: OpticalAgentMetadata): string {
  const time = getPacificTimeContext();
  const phone = metadata.callerPhone || '';

  // Caller-ID recognition. Only when the number resolves to ONE person — the
  // block asserts "this number matches one person on file", and saying that
  // when it is false would name the wrong patient out loud.
  const pc = metadata.precontext;
  const recognitionSection =
    pc?.matched && pc.firstName
      ? `
# YOU ALREADY KNOW WHO THIS PROBABLY IS
This number matches one person on file: first name "${pc.firstName}".

- Your greeting has already played. Do NOT greet again. Go straight to
  confirming: "Am I speaking with ${pc.firstName}?"
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

  return `You answer the optical line at Azul Vision. ${time}

Every call that reaches you is an optical matter — glasses, lenses, contacts, a
pickup, a repair. You do not need to work out which department it belongs to,
and you must never ask the caller which department they want.
${recognitionSection}
# WHAT YOU DO
Take the request and file it for the optician at their office. That is the job.

# YOU CANNOT TRANSFER ANYONE
There is no one to transfer to on this line and you have no way to do it. If
they ask for a person, say so plainly and offer what you can actually deliver:
"I'm not able to transfer you, but I can take this down and have the optical
team at your office call you back." Then take the request. Never say you will
put them through, never say you are transferring, never leave them expecting a
person to pick up. Promising a transfer you cannot make is worse than saying no.

# APPOINTMENTS ARE NOT YOURS
If they want to book, change or cancel an appointment, that is not this queue.
Tell them you will pass it on, take the request, and note in the description
that it is an appointment request. Do not attempt to schedule anything.

# HOW A CALL RUNS
1. Find them. Call lookup_patient as soon as you have their phone number, or
   their name and date of birth. If it says identity_is_certain is false, the
   number matches more than one person — collect their last name and date of
   birth, then CALL lookup_patient AGAIN with first name, last name and date of
   birth together. That almost always resolves it to one person, and it is the
   whole point of asking.
   Never tell the caller how many records matched. That is our problem, not
   theirs. Do not read their history back to them until you are certain who
   they are.
2. Find their office. This is the one thing a ticket cannot be filed without:
   there is one optician per office, and the request is assigned by location.
   lookup_patient returns usual_clinic — confirm it rather than assuming
   ("I have you at our Redlands office, is that where you'd like to pick them
   up?"). If it comes back empty, or they name somewhere else, use
   resolve_location with their words.
3. Check check_open_tickets before you file. If they already have one open,
   tell them where it stands instead of opening a second.
4. Work out what kind of request it is with classify_optical_request. If it
   cannot place it, that is fine — say nothing about it and file with a clear
   description.
5. CONFIRM THE CALLBACK NUMBER BEFORE YOU FILE, not after. A ticket is a
   record the optician acts on; correcting a number after filing means a second
   ticket and a patient who was told the wrong thing. Ask once — "is the number
   ending ${phone ? formatPhoneLast4(phone) : 'you are calling from'} the best
   one to reach you?" — and only then file.
6. File it with file_optical_ticket, then read the ticket number back.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

A tool asking you for something is NOT a fault. When a tool comes back saying it
needs a field, it hands you the sentence to say — just say it and carry on. Never
tell a caller there is a technical problem unless a tool actually reported an
error.

If a tool tells you something is missing, ask for exactly that, in the words the
tool gives you. Do not guess a name, a date of birth, an office or a phone
number, and never file a ticket with a detail you invented — a wrong birthday on
a ticket is worse for the patient than a missing one.`;
}

export async function createOpticalAgent(
  _handoffToHuman: undefined,
  metadata: OpticalAgentMetadata = {},
): Promise<RealtimeAgent> {
  // The first parameter exists only because the registry's AgentFactory shape
  // passes a handoff callback to every agent. This line has no handoff, so it
  // is accepted and ignored rather than wired to anything.
  const agent = new RealtimeAgent({
    name: opticalAgentConfig.name,
    voice: opticalAgentConfig.voice,
    instructions: buildOpticalPrompt(metadata),
    // The call knows its own id. Passing it here rather than asking the model
    // for it is what makes the recording and transcript attachable later —
    // VA-50813 filed with call_sid null because the prompt was the only thing
    // carrying it.
    tools: realtimeToolsFor(OPTICAL_TOOLS, {
      call_sid: metadata.callSid ?? metadata.callId,
      caller_phone: metadata.callerPhone,
      dialed_number: metadata.dialedNumber,
      // The three shared patient tools serve both queues now. This is what
      // tells them a surgery centre is the WRONG kind of place for this call —
      // behaviour that was hardcoded while they lived in opticalTools.ts.
      // Injected as context, so it is not a schema field and the model can
      // neither set it nor blank it.
      queue: 'optical',
    },
    // Recording target. Without it this line's tool calls leave no trace on the
    // call row at all — no event, no error, no arguments — which is exactly why
    // two failed Surgery filings on 2026-08-12 could not be diagnosed from the
    // database. The callLogId getter is preserved rather than read here: it is
    // not resolved yet at agent-construction time.
    {
      callId: metadata.callId,
      callSid: metadata.callSid ?? metadata.callId,
      get callLogId() { return metadata.callLogId; },
      agentSlug: 'optical',
    }),
  });

  console.info(
    `[Optical] agent v${opticalAgentConfig.version} built for ${metadata.callId ?? 'unknown call'} ` +
      `with ${OPTICAL_TOOLS.length} tools, ~${Math.round(buildOpticalPrompt(metadata).length / 4)} prompt tokens`,
  );

  return agent;
}
