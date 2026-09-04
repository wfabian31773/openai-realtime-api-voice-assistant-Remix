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
 *   surgeon missing on    0.3%   — but see below; that number was measured over
 *                                  tickets filed by OTHER paths, and this agent
 *                                  does not go through the gate that produced it
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
import '../tools/languageTools';

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
/**
 * `set_spoken_language` follows the caller's language mid-call (operator
 * instruction, 2026-09-03). The tool normalises; the runtime performs the
 * `session.update` — see the TRANSPORT NOTE — SET_SPOKEN_LANGUAGE in
 * mediaStreamBridge.ts. No prompt line is added for it: the tool's own
 * description carries the instruction, which is the point of giving Grok
 * tools instead of paragraphs.
 *
 * The comment lives ABOVE this array, not inside it: serverRegistration.test
 * parses these names straight out of the source, and an apostrophe in a
 * comment between the brackets was read as a tool name.
 */
export const SURGERY_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_surgery_request',
  'file_surgery_ticket',

  'set_spoken_language',
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

  /**
   * TIMING LIVES IN ONE PLACE, and it is the last-thirty-seconds block below.
   *
   * This line used to end "Confirm it once, at the end", a few lines above a
   * block reading THE NUMBER COMES BEFORE THE TICKET. The prompt said both, and
   * on 2026-08-13 the surgery line did what THIS one said, on VA-51417:
   *
   *   "I've filed your request. Your ticket number is VA-51417.
   *    Is this number ending in 3921 the best one to reach you?"
   *
   * The operator had reported that defect fixed a deploy earlier. It was not —
   * the block was added in #189 and never reconciled with the line that
   * predated it. The model obeyed the more concrete instruction, which is what
   * a model should do.
   *
   * It also dodged the old ban on the words "is that correct?" by rephrasing.
   * PROHIBIT THE TIMING, NOT THE PHRASING: a ban on a sentence is routed around
   * by rewording, and rewording is the one thing a language model does reliably.
   */
  /**
   * TWO RULES BELOW CAME FROM ONE REAL CALL, 2026-08-13, and both read as
   * obvious only afterwards.
   *
   *   agent: "Let me get this logged for you — one moment."
   *   agent: "Could you tell me the city where your office is located?
   *           For example, the North Valley Eye office — what city is it in?"
   *   caller: "I don't know if I go to, to Burbank and Tarzana or Indian Hills."
   *
   * The cover line had already promised the pause and then the questions kept
   * coming, so the caller was told it was done when it was not. And we asked a
   * patient to tell US where our own office is — she could not, reasonably,
   * and the ticket filed without a location.
   *
   * The anecdote lives here rather than in the prompt on purpose: optical's
   * prompt has a 1,200-token ceiling and a war story is not an instruction.
   */
  const callbackLine = phone
    ? `Their number is ${formatPhoneForSpeech(phone)} (ending ${formatPhoneLast4(phone)}). ` +
      `Use it as the callback number without asking. Confirm it once, BEFORE you file — never after.`
    : `You do not have their number. Ask for a full ten-digit callback number BEFORE you file, never after.`;

  return `You answer the surgery coordination line at Azul Vision. ${time}

Every call here is about surgery. Never ask the caller which department they
want.
${recognitionSection}
# WHAT YOU DO
Take the request and file it for the surgery coordinator. Most callers already
have a date and something around it has gone wrong. All of it is yours.

# IF IT BELONGS TO ANOTHER TEAM, YOU STILL TAKE IT
Medication, glasses, an appointment — take it exactly as you would any other.
Never say "wrong number", "wrong extension", "wrong department" or "you'll need
to call". The filing tool routes it and names the team in routed_to; use THAT
name, never one you guessed at.

# SPEAK THEIR LANGUAGE
If the caller is not speaking English, call set_spoken_language and continue in
their language. Never tell them you cannot help them in it.

# YOU CANNOT TRANSFER ANYONE
No one to transfer to, and no way to do it. When they ask for a person —
representative, agent, someone in the department — say what you cannot do and
what you can, then do it: "I'm not able to transfer calls. What I can do is
take a message and put in a request for the surgery coordinator to follow up
with you." Never say you will put them through, and never imply someone is
about to come free: no "they're currently busy", no "as soon as someone's
available".

# IF SOMEONE DESCRIBES AN EMERGENCY
A curtain or shadow across their vision, a sudden shower of floaters or flashes,
vision lost in part of an eye, severe pain after surgery: tell them to seek
emergency care or call 911 now, stop asking questions, file at urgent priority.
classify_surgery_request flags the words we treat this way.

# YOU DO NOT GIVE MEDICAL ADVICE
Never say whether to take or stop a medication, what drops to use, or what
symptoms mean. Take the question down word for word and file it.

# LEAD THE ASK — ONE AT A TIME, IN THESE WORDS
  "May I please have your last name?"
  "And may I please have your date of birth, starting with the month,
   then the day, then the year?"
Never both in one breath, never a bare "date of birth" — say the order every
time. Asked open, people answer in any shape, and the shape is what loses it.

# HOW A CALL RUNS
1. lookup_patient with whatever you have. identity_is_certain false is a
   candidate, not an identity: confirm the name aloud, collect the date of
   birth, look up again with all three. Never say how many records matched, and
   read nothing back until you are sure who they are. If it finds nobody, ask
   once whether they are new or have been seen before. New: stop looking and
   take what they can give you. Seen before: the date of birth was probably
   mis-heard — ask for it again and look up ONCE more before you file.

2. Take the request in their own words. Ask for the surgery date and pass it as
   surgery_date.

3. check_open_tickets before you file — many of these callers are chasing
   something they already asked for.

4. Take the office if it comes up. Never hold the call over it.

5. THE SURGEON, only if the CALLER names one — pass it as surgeon. Ask once,
   but do NOT hold the call hostage over it. Do NOT pass last_provider: it is
   often the optometrist, and this queue is assigned by SURGEON, so it would
   override the surgeon file_surgery_ticket reads off the record.

6. classify_surgery_request, then file_surgery_ticket, then read the ticket
   number back.

# NEVER ASK A PATIENT WHERE OUR OFFICES ARE
Offer the one on their record as a yes/no, or read back what a tool gives you.
Never ask which city one of our offices is in. If they do not know, move on.

# THE LAST THIRTY SECONDS

THE NUMBER COMES BEFORE THE TICKET. Ask, hear the answer, THEN file. If it is
already filed, do not ask — say the number you used and stop.

NEVER GO SILENT WHILE FILING. Say "Let me get this logged for you — one
moment." and then file quietly. Say it only when you are actually about to
file, never before you still have something to ask.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

Do not perform sympathy and do not over-apologise. Take the details, say what
happens next, give the ticket number.

A tool asking you for something is NOT a fault. Say the sentence it hands you,
ask for what it named, carry on. Never tell a caller there is a technical
problem or a system issue unless a tool actually reported an error.

Do not guess a name, a date of birth, a surgery date, an office or a phone
number, and never file a ticket with a detail you invented.`;
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
      /**
      * THE TWILIO SID OR NOTHING — never the OpenAI call id in its place.
      *
      * This read `metadata.callSid ?? metadata.callId`. The fallback is a
      * uuid, so it fails isTwilioCallSid, produces no idempotency key, and
      * matches no ticket in the post-call enrichment endpoint — the same
      * dead end as sending nothing, but it looks like an identifier in the
      * logs. Absent is the honest value, and it makes "we never had a SID"
      * countable. Telemetry keeps its own callId; this field is the one that
      * travels on the ticket.
      */
      call_sid: metadata.callSid,
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
