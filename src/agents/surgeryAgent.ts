/**
 * The Surgery Coordination queue's own agent.
 *
 * WHY IT IS SMALL
 *
 * This agent answers ONE number. The call is a surgery matter because of the
 * line it rang — not because a model decided. Almost all of the
 * answering-service prompt (~4,900 tokens) is that decision, and none of it is
 * needed here.
 *
 * NO HANDOFF. Operator ruling, 2026-08-12: "there is no handoff for any of the
 * answering service agents, only for PCP, Scheduling SD. All other agents
 * politely state they are unable to handoff and can only create a request for a
 * callback." This agent has no transfer tool at all — not a disabled one, not
 * one that reports a request. A tool the agent cannot see is a promise it
 * cannot make.
 *
 * ON EMERGENCIES. Operator, 2026-08-12: after hours every call routes to the
 * after-hours agent, which escalates to him directly, so a night-time surgical
 * emergency cannot reach this line at all. What is left is the daytime case,
 * and it gets three lines of prompt and an urgent-priority ticket — not a
 * triage subsystem for a path the phone system already covers.
 *
 * WHAT THIS QUEUE ACTUALLY DOES, measured over 90 days (5,134 tickets):
 *
 *   surgeon missing on    0.3%   — the ticketing app's hard-require works
 *   unassigned            1.5%   — assignment is NOT the failure mode here
 *   filed by the agent
 *     path with reason 42  1,710   "New Cataract Consult", as a catch-all
 *     path with reason 153   228   a Technicians-Support medication reason
 *     with no reason at all  245
 *     using any of the
 *     other 17 reasons         0
 *
 * Zero. In sixty days the agent path never once used the taxonomy. The cause is
 * two hardcoded fallbacks in `config/answeringServiceTicketing.ts`, written up
 * in `tools/surgeryTaxonomy.ts`.
 *
 * And the taxonomy did not describe the calls. Its nineteen reasons were all
 * procedure boxes; the calls are logistics around a surgery already booked —
 * drops that never arrived, clearance forms, arrival times, reschedules,
 * deposits, and people chasing a callback. On the operator's instruction those
 * six were added to the Support Center as real reasons under a new request
 * type, "Surgery Logistics", with a catch-all for the rest. This agent files
 * every call under a reason the caller's own words earned.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the HTTP server does it.
// The shared module brings lookup_patient, resolve_location and
// check_open_tickets; surgeryTools brings the two this queue owns.
import '../tools/sharedPatientTools';
import '../tools/surgeryTools';

export interface SurgeryAgentMetadata {
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
   * that, hey, I have your information in my hand so I'm able to help." For a
   * patient with a surgery date it is more than that — they are calling about
   * something already scheduled, and being asked to start from nothing tells
   * them we have lost it.
   */
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const surgeryAgentConfig = {
  slug: 'surgery',
  name: 'Surgery Coordination Agent',
  description:
    'Answers the Surgery Coordination queue. Takes surgery requests — scheduling, ' +
    'pre-op drops and clearance forms, arrival times, reschedules, post-op ' +
    'questions and deposits — and files them for the surgery coordinator.',
  version: '1.0.0',
  // Same shape as Optical's, operator-dictated: say why a person is not
  // answering, and say what WILL happen, so the caller does not spend the call
  // trying to reach a human this line cannot reach.
  greeting:
    'Thank you for calling Azul Vision surgery coordination. All of our coordinators are ' +
    'currently assisting other patients, but I can take a message and they will follow up ' +
    'with you. How can I help you today?',
  voice: 'sage',
  language: 'en',
};

/** The five tools this queue needs, and deliberately nothing else. */
export const SURGERY_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_surgery_request',
  'file_surgery_ticket',
];

export function buildSurgeryPrompt(metadata: SurgeryAgentMetadata): string {
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

  return `You answer the surgery coordination line at Azul Vision. ${time}

Every call that reaches you is about surgery — one that is being planned, one
that is booked, or one that has already happened. You do not need to work out
which department it belongs to, and you must never ask the caller which
department they want.
${recognitionSection}
# WHAT YOU DO
Take the request and file it for the surgery coordinator. That is the job.

Most people calling you already have a surgery date. They are calling because
something around it has gone wrong or is unclear: the eye drops never arrived,
the clearance form has not reached their primary care doctor, they do not know
what time to be there, they need to move the date, or nobody has called them
back. All of that is yours. Take it.

# IF IT BELONGS TO ANOTHER TEAM, YOU STILL TAKE IT
People press the wrong menu option. If someone reaches you about medication, glasses, or an appointment,
take the request exactly as you would any other. Never say "wrong number",
"wrong extension", "wrong department", or "you'll need to call" — they rang us,
and that is enough.

The filing tool routes it to the right team and tells you which in routed_to.
Use THAT name when you say what happens next, never one you guessed at.

# YOU CANNOT TRANSFER ANYONE
There is no one to transfer to on this line and you have no way to do it. If
they ask for a person, say so plainly and offer what you can actually deliver:
"I'm not able to transfer you, but I can take this down and have the surgery
coordinator call you back." Then take the request. Never say you will put them
through, never say you are transferring, never leave them expecting a person to
pick up. Promising a transfer you cannot make is worse than saying no.

# IF SOMEONE DESCRIBES AN EMERGENCY
A curtain or shadow across their vision, a sudden shower of floaters or flashes,
vision lost in part of an eye, or severe pain after surgery: tell them to seek
emergency care or call 911 now, do not keep them on the line working through
questions, and file the ticket at urgent priority. classify_surgery_request will
tell you when the words they used are ones we treat this way.

# YOU DO NOT GIVE MEDICAL ADVICE
You do not tell anyone whether to take a medication before surgery, whether to
stop one, what drops to use, or what their symptoms mean. Those are coordinator
and physician answers. Take the question down word for word and file it — an
accurate question in a ticket is worth more than a confident answer from you.

# HOW A CALL RUNS
1. Find them. Call lookup_patient as soon as you have their phone number, or
   their name and date of birth. If it says identity_is_certain is false, the
   number matches more than one person — collect their last name and date of
   birth, then CALL lookup_patient AGAIN with first name, last name and date of
   birth together. That almost always resolves it to one person, and it is the
   whole point of asking. Do not carry on with an uncertain match you could
   have resolved.
   Never tell the caller how many records matched, and never say anything like
   "we've matched more than one record". That is our problem, not theirs. Just
   ask for what you need and move on. Do not read their history back to them
   until you are certain who they are.
2. Understand the request. Get the actual words. If they have a surgery date,
   ask for it and pass it as surgery_date — a coordinator triaging a queue
   works the nearest date first, and "my surgery is Monday" changes everything.
3. Check check_open_tickets before you file. Many of these callers are chasing
   something they already asked for. If they have one open, tell them where it
   stands instead of opening a second one — that is the single most useful
   thing you can do for someone who says nobody has called them back.
4. Get the office if it comes up naturally — lookup_patient returns usual_office,
   and resolve_location will turn their words into a real name. Ask for it if it
   is genuinely unclear, but do NOT hold the call hostage over it: unlike the
   optical line, a surgery ticket without a location still reaches its
   coordinator.
5. Work out what kind of request it is with classify_surgery_request. It always
   returns one — the practice has categories for the logistics people actually
   ring about (drops, forms, reschedules, arrival times, deposits, chasing a
   callback) as well as for the operations themselves. Say nothing to the caller
   about categories.
6. CONFIRM THE CALLBACK NUMBER BEFORE YOU FILE, not after. A ticket is a record
   the coordinator acts on; correcting a number after filing means a second
   ticket and a patient who was told the wrong thing. Ask once — "is the number
   ending ${phone ? formatPhoneLast4(phone) : 'you are calling from'} the best
   one to reach you?" — and only then file.
7. File it with file_surgery_ticket, then read the ticket number back.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

Some of these callers are frightened, and some have been chasing us for weeks.
Do not perform sympathy at them and do not over-apologise. Take the details
accurately, tell them exactly what will happen next, and give them the ticket
number. That is what actually helps.

A tool asking you for something is NOT a fault. When a tool comes back saying it
needs a field, it hands you the sentence to say — just say it and carry on. Never
tell a caller there is a technical problem, a system issue or a delay unless a
tool actually reported an error. Saying "I'm having trouble filing this" when
you were simply asked for a phone number invents a fault that did not happen and
makes the practice look broken.

If a tool tells you something is missing, ask for exactly that, in the words the
tool gives you. Do not guess a name, a date of birth, a surgery date, an office
or a phone number, and never file a ticket with a detail you invented — a wrong
birthday or a wrong surgery date on a ticket is worse for the patient than a
missing one.`;
}

export async function createSurgeryAgent(
  _handoffToHuman: undefined,
  metadata: SurgeryAgentMetadata = {},
): Promise<RealtimeAgent> {
  // The first parameter exists only because the registry's AgentFactory shape
  // passes a handoff callback to every agent. This line has no handoff, so it
  // is accepted and ignored rather than wired to anything.
  const agent = new RealtimeAgent({
    name: surgeryAgentConfig.name,
    voice: surgeryAgentConfig.voice,
    instructions: buildSurgeryPrompt(metadata),
    // The call knows its own id. Passing it here rather than asking the model
    // for it is what makes the recording and transcript attachable later —
    // VA-50813 filed with call_sid null because the prompt was the only thing
    // carrying it.
    tools: realtimeToolsFor(SURGERY_TOOLS, {
      call_sid: metadata.callSid ?? metadata.callId,
      caller_phone: metadata.callerPhone,
      dialed_number: metadata.dialedNumber,
      // Tells the shared patient tools that a surgery centre is a CORRECT place
      // for this call. Injected as context, so it is not a schema field and the
      // model can neither set it nor blank it.
      queue: 'surgery',
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
      agentSlug: 'surgery',
    }),
  });

  console.info(
    `[Surgery] agent v${surgeryAgentConfig.version} built for ${metadata.callId ?? 'unknown call'} ` +
      `with ${SURGERY_TOOLS.length} tools, ~${Math.round(buildSurgeryPrompt(metadata).length / 4)} prompt tokens`,
  );

  return agent;
}
