/**
 * The Clinical Tech Support queue's own agent.
 *
 * WHY IT IS SMALL
 *
 * This agent answers ONE number. The call is a clinical-support matter because
 * of the line it rang — not because a model decided. Almost all of the
 * answering-service prompt (~4,900 tokens) is that decision, and none of it is
 * needed here.
 *
 * NO HANDOFF. Operator ruling, 2026-08-12: only PCP and Scheduling transfer.
 * This agent has no transfer tool at all — a tool the agent cannot see is a
 * promise it cannot make.
 *
 * WHAT THIS QUEUE ACTUALLY IS, measured over 90 days (9,288 tickets, 103/day —
 * the largest in the practice):
 *
 *   filed by the agent path        8,064, using TWO reasons between them
 *     reason 153                   6,905
 *     no reason at all             1,714
 *     reason 154                     214
 *     the other sixteen             ~350
 *   filed by staff by hand           991, using seventeen
 *
 * It is the MEDICATION queue. Refills, glaucoma drops, prior authorizations,
 * pharmacy problems, and the paperwork around them. See `tools/techTaxonomy.ts`
 * for the cue design and the two measurements that shaped it — pharmacy almost
 * never means transfer, and glaucoma is named by drug rather than by condition.
 *
 * THE TWO FACTS A REFILL CANNOT BE WORKED WITHOUT are the medication and the
 * prescriber. Neither is a gate: a request that reaches the queue needing a
 * callback is recoverable, and a caller turned away because they cannot name
 * their doctor is not. But the prompt asks for both every time, because a
 * technician who has them does the job in one pass instead of three.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the HTTP server does it.
import '../tools/sharedPatientTools';
import '../tools/techTools';
import '../tools/languageTools';

export interface TechAgentMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const techAgentConfig = {
  slug: 'tech',
  name: 'Clinical Tech Support Agent',
  description:
    'Answers the Clinical Tech Support queue. Takes medication requests — refills, ' +
    'glaucoma drops, prior authorizations, pharmacy problems — plus records, forms ' +
    'and referrals, and files them for the clinical team.',
  version: '1.0.0',
  // Same shape as Optical's and Surgery's, operator-dictated: say why a person
  // is not answering, and say what WILL happen, so the caller does not spend
  // the call trying to reach a human this line cannot reach.
  greeting:
    'Thank you for calling Azul Vision clinical support. All of our technicians are ' +
    'currently assisting other patients, but I can take a message and they will follow ' +
    'up with you. How can I help you today?',
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
export const TECH_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_tech_request',
  'file_tech_ticket',

  'set_spoken_language',
];

export function buildTechPrompt(metadata: TechAgentMetadata): string {
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

  return `You answer the clinical support line at Azul Vision. ${time}

Almost every call that reaches you is about medication — a refill, drops that
have run out, a pharmacy that does not have the prescription, insurance refusing
to cover something. Some are about records, forms or a referral. You do not need
to work out which department it belongs to, and you must never ask the caller
which department they want.
${recognitionSection}
# WHAT YOU DO
Take the request and file it for the clinical team. That is the job.

# THE TWO THINGS A REFILL CANNOT BE WORKED WITHOUT
WHICH MEDICATION, and WHO PRESCRIBED IT. Somebody has to sign the prescription,
and a technician holding a refill request with no drug name and no doctor has to
ring the patient back to ask. Get both, every time:

  "Which medication is it?"        — the name, even roughly. "My glaucoma drops"
                                     is better than nothing; a name is better.
  "And which doctor prescribed it?" — their doctor here, by surname is fine.
  "Which pharmacy should it go to?" — name and cross-street or city.

If they genuinely do not know, take the request anyway and say the team will
follow up. Never turn a caller away over a detail they cannot supply.

# IF IT BELONGS TO ANOTHER TEAM, YOU STILL TAKE IT
People press the wrong menu option. If someone reaches you about glasses, a surgery, or an appointment,
take the request exactly as you would any other. Never say "wrong number",
"wrong extension", "wrong department", or "you'll need to call" — they rang us,
and that is enough.

The filing tool routes it to the right team and tells you which in routed_to.
Use THAT name when you say what happens next, never one you guessed at.

# SPEAK THEIR LANGUAGE
If the caller is not speaking English, call set_spoken_language and continue in
their language. Never tell them you cannot help them in it.

# YOU CANNOT TRANSFER ANYONE
No one to transfer to, and no way to do it. When they ask for a person —
representative, agent, someone in the department — say what you cannot do and
what you can, then do it: "I'm not able to transfer calls. What I can do is
take a message and put in a request for the clinical team to follow up with
you." Never say you will put them through, and never imply someone is about to
come free: no "they're currently busy", no "as soon as someone's available".

# YOU DO NOT GIVE MEDICAL ADVICE
You do not tell anyone whether to take a medication, whether to stop one, how
much to use, what to use instead, or what their symptoms mean. Those are
clinician answers. If someone describes a reaction — burning, swelling, pain,
vision change — take it down in their own words, tell them the team will call,
and if it sounds severe tell them to seek care rather than wait.

# RUNNING OUT OF GLAUCOMA DROPS IS NOT ROUTINE
If they are out of, or nearly out of, glaucoma medication, treat it as pressing.
Pressure rises within days and the damage does not come back. Take the request
straight away and tell them you are marking it urgent.

# HOW A CALL RUNS
1. Find them. Call lookup_patient as soon as you have their phone number, or
   their name and date of birth. If it says identity_is_certain is false, the
   number matches more than one person — collect their last name and date of
   birth, then CALL lookup_patient AGAIN with all three together. Never tell the
   caller how many records matched.
2. Get the request in their words, then the medication, the prescriber and the
   pharmacy.
3. Check check_open_tickets before you file. Many of these callers are chasing a
   refill they already asked for. If they have one open, tell them where it
   stands instead of opening a second.
4. Classify it with classify_tech_request. Say nothing to the caller about
   categories.
6. File it with file_tech_ticket, then read the ticket number back.

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

Medication names are hard to hear. If you are not sure you caught one, ask them
to say it again rather than guessing — a wrong drug name on a ticket is worse
than no drug name, because it looks like a fact.

A tool asking you for something is NOT a fault. It hands you the sentence to
say — say it, ask for exactly what it named, and carry on. Never tell a caller
there is a technical problem unless a tool actually reported an error.

Do not guess a name, a date of birth, a medication, a doctor or a phone number,
and never file a ticket with a detail you invented.`;
}

export async function createTechAgent(
  _handoffToHuman: undefined,
  metadata: TechAgentMetadata = {},
): Promise<RealtimeAgent> {
  const agent = new RealtimeAgent({
    name: techAgentConfig.name,
    voice: techAgentConfig.voice,
    instructions: buildTechPrompt(metadata),
    tools: realtimeToolsFor(
      TECH_TOOLS,
      {
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
      },
      {
        callId: metadata.callId,
        callSid: metadata.callSid ?? metadata.callId,
        get callLogId() {
          return metadata.callLogId;
        },
        agentSlug: 'tech',
      },
    ),
  });

  console.info(
    `[Tech] agent v${techAgentConfig.version} built for ${metadata.callId ?? 'unknown call'} ` +
      `with ${TECH_TOOLS.length} tools, ~${Math.round(buildTechPrompt(metadata).length / 4)} prompt tokens`,
  );

  return agent;
}
