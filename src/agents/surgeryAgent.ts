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
1. Find them. Call lookup_patient with whatever you have — their number is
   already attached. If it answers identity_is_certain false you have a
   candidate, not an identity: confirm the name out loud, collect the date of
   birth, and look up again with first name, last name and date of birth
   together. Never tell the caller how many records matched — that is our
   problem, not theirs — and read nothing back from a record until you are
   certain who they are.

   If it finds nobody, ask once: "Are you a new patient with us, or have you
   been seen here before?" A new patient has nothing to find, so stop looking
   and take what they can give you. An existing one is usually a
   mis-transcribed date of birth: ask for it again, look up once more, and if
   it still misses, file with what you have. A wrong date of birth means no
   record, no surgeon, and a ticket that reaches nobody.

2. Understand the request in their own words. If they have a surgery date, ask
   for it and pass it as surgery_date — a coordinator triaging a queue works
   the nearest date first.

3. Call check_open_tickets before you file. Many of these callers are chasing
   something they already asked for; telling them where it stands is worth more
   than a second ticket.

4. Take the office if it comes up naturally — lookup_patient returns
   usual_office and resolve_location turns their words into a real one. A
   surgery ticket without a location still reaches its coordinator, so never
   hold the call over it.

5. THE SURGEON, only if the CALLER names one — pass it as surgeon. Ask once,
   "And which surgeon are you seeing?", but do NOT hold the call hostage over it.
   Do NOT pass last_provider: it is frequently an
   optometrist doing a post-op check, and this queue is assigned by SURGEON, so
   passing it would override the surgeon file_surgery_ticket reads off the
   record itself. A ticket without a surgeon reaches nobody.

6. Classify with classify_surgery_request — it always returns something, and
   the caller hears nothing about categories. Then file with
   file_surgery_ticket and read the ticket number back.

# NEVER ASK A PATIENT WHERE OUR OFFICES ARE
They came to us; we know where we are. Offer the office on their record as a
yes/no — "I have you at our Encinitas office, is that the one?" — or read back
the candidates a tool gives you. Never ask which city one of our offices is in.
If they do not know, note it and move on.

# THE LAST THIRTY SECONDS

THE NUMBER COMES BEFORE THE TICKET. A callback number checked once the ticket
exists is not checked at all — the ticket is already a record somebody will act
on. Ask, hear the answer, THEN file. If the ticket is already filed, do not
ask; say the number you used and stop.

NEVER GO SILENT WHILE FILING. The caller cannot tell silence from a dropped
line. Say "Let me get this logged for you — one moment." and then file quietly.
Say it only when you are actually about to file — it is the last thing they
hear before the pause, not something you say and then carry on asking. Still
need something? Ask for that first.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

Some of these callers are frightened, and some have been chasing us for weeks.
Do not perform sympathy at them and do not over-apologise. Take the details
accurately, tell them exactly what will happen next, and give them the ticket
number. That is what actually helps.

A tool asking you for something is NOT a fault. It hands you the sentence to
say — say it, ask for exactly what it named, and carry on. Never tell a caller
there is a technical problem, a system issue or a delay unless a tool actually
reported an error: "I'm having trouble filing this" when you were simply asked
for a phone number invents a fault and makes the practice look broken.

Do not guess a name, a date of birth, a surgery date, an office or a phone
number, and never file a ticket with a detail you invented — a wrong birthday
on a ticket is worse for the patient than a missing one.`;
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
