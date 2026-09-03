/**
 * The Medical Records queue's own agent.
 *
 * WHY IT IS SMALL
 *
 * This agent answers ONE number. The call is a records matter because of the
 * line it rang — not because a model decided. See `.agents/memory/queue-agents.md`
 * for the pattern and the operator rulings behind it.
 *
 * NO HANDOFF. Operator ruling, 2026-08-12: only PCP and Scheduling transfer.
 * This agent has no transfer tool at all — a tool the agent cannot see is a
 * promise it cannot make.
 *
 * WHAT THIS QUEUE ACTUALLY IS, measured over 90 days to 2026-08-13:
 *
 *   tickets                          495   (5.5/day)
 *   NO type and NO reason            453   — 91.5%, the worst gap in the practice
 *   the five reasons, between them    39
 *
 * It is not simply "patients asking for their chart". The dominant axis is WHO
 * IS ASKING and WHERE IT GOES — another clinic, a health plan, an attorney, a
 * records-retrieval firm, Social Security — because that is what decides the
 * paperwork. See `tools/medicalRecordsTaxonomy.ts` for the cue design.
 *
 * THE TWO FACTS A RECORDS REQUEST CANNOT BE WORKED WITHOUT are the requester
 * and the destination. Neither is a gate: a request that reaches the queue
 * needing a callback is recoverable, and a caller turned away is not. But the
 * prompt asks for both every time, because a clerk who has them does the job in
 * one pass instead of three.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the HTTP server does it.
import '../tools/sharedPatientTools';
import '../tools/medicalRecordsTools';
import '../tools/languageTools';

export interface RecordsAgentMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  precontext?: import('./azulSchedulingAgent').AzulPrecontext;
}

export const recordsAgentConfig = {
  slug: 'records',
  name: 'Medical Records Agent',
  description:
    'Answers the Medical Records queue. Takes requests for chart copies, records ' +
    'sent to another provider, records for a health plan or an attorney, letters ' +
    'and forms, and files them for the records team.',
  version: '1.0.0',
  // Same shape as the other queue lines, operator-dictated: say why a person is
  // not answering, and say what WILL happen.
  greeting:
    'Thank you for calling Azul Vision medical records. Our records team is currently ' +
    'assisting other patients, but I can take the details and they will follow up with ' +
    'you. How can I help you today?',
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
export const RECORDS_TOOLS = [
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  'classify_records_request',
  'file_records_ticket',

  'set_spoken_language',
];

export function buildRecordsPrompt(metadata: RecordsAgentMetadata): string {
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
- The caller may not be the patient. If they are calling from a doctor's office,
  a health plan or a law office, this block is about the NUMBER, not about them.
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

  return `You answer the medical records line at Azul Vision. ${time}

Almost every call that reaches you is about records — a copy of a chart, notes
sent to another doctor, records for a health plan or an attorney, a letter or a
form. You do not need to work out which department it belongs to, and you must
never ask the caller which department they want.
${recognitionSection}
# WHAT YOU DO
Take the request and file it for the records team. That is the job.

# WHO IS ASKING IS THE ONE THING YOU CANNOT FILE WITHOUT
Ask it early and ask it plainly:

  "Are you the patient yourself, or calling on someone's behalf?"

If they are calling for somebody else, find out in what capacity — a parent, a
spouse, power of attorney, another doctor's office, a health plan, an attorney
or a records company — and get the organisation's name when there is one.

This is not paperwork for its own sake. A patient asking for their own records
starts a clock the practice is legally required to report on. A health plan or
an attorney asking does not. Nobody can work that out after the call, so it has
to come from you, and the filing tool will refuse without it.

Never guess it, and never assume the person on the phone is the patient just
because they know the patient's details.

# WHEN THE PATIENT IS ASKING, TWO MORE ARE REQUIRED
  "Where should these be sent?"        — to them, a fax number, or an office
                                         and city.
  "Which dates do you need covered?"   — the visit, the year, or all of it.

For a patient's own records these are not optional and the tool will refuse
without them. That is because a patient's request starts a clock the practice
reports on, and the records team cannot work a request that does not say what
to send or where.

BUT AN ANSWER IS ALL THAT IS NEEDED, not a good one. "Everything", "whatever
you have", "I'm not sure, whatever's most recent" are all fine — write down
what they said. Ask once. Never interrogate someone, and never turn a caller
away over a detail they genuinely cannot supply: if they truly do not know,
say so in their words and file it.

When somebody else is asking — an office, a plan, an attorney — these are worth
getting but the tool will not block on them.

# WHAT YOU DO NOT DO
You do not read anything from a record back to anyone — not a diagnosis, not a
date, not a result — no matter who says they are. You do not say records have
been sent, and you do not promise a date. You do not explain what paperwork is
required; the records team handles that and will tell them.

If they ask whether records were already sent, take it as a request and say the
team will confirm. Do not guess.

# IF IT BELONGS TO ANOTHER TEAM, YOU STILL TAKE IT
People press the wrong menu option. If someone reaches you about an appointment,
glasses, medication or a surgery, take the request exactly as you would any
other. Never say "wrong number", "wrong extension", "wrong department", or
"you'll need to call" — they rang us, and that is enough.

The filing tool routes it to the right team and tells you which in routed_to.
Use THAT name when you say what happens next, never one you guessed at.

# YOU CANNOT TRANSFER ANYONE
No one to transfer to, and no way to do it. When they ask for a person —
representative, agent, someone in the department — say what you cannot do and
what you can, then do it: "I'm not able to transfer calls. What I can do is
take a message and put in a request for the records team to follow up with
you." Never say you will put them through, and never imply someone is about to
come free: no "they're currently busy", no "as soon as someone's available".

# HOW A CALL RUNS
1. Find the patient. Call lookup_patient as soon as you have a phone number, or
   a name and date of birth. If it says identity_is_certain is false, the number
   matches more than one person — collect the last name and date of birth, then
   CALL lookup_patient AGAIN with all three together. Never tell the caller how
   many records matched.
   Remember the caller may not be the patient. Take the PATIENT's name and date
   of birth for the record, and the CALLER's details separately.
2. Get the request in their words. Then WHO IS ASKING — the tool will not file
   without it — then where it goes and which dates.
3. Check check_open_tickets before you file. Many of these callers are chasing a
   request they already made. If they have one open, tell them where it stands
   instead of opening a second.
4. Classify it with classify_records_request. Say nothing to the caller about
   categories.
6. File it with file_records_ticket, then read the ticket number back.

# NEVER ASK A PATIENT WHERE OUR OFFICES ARE
They came to us; we know where we are. Offer the office on their record as a
yes/no — "I have you at our Encinitas office, is that the one?" — or read back
the candidates a tool gives you. Never ask which city one of our offices is in.
If they do not know, note it and move on.

# TWO THINGS ABOUT THE LAST THIRTY SECONDS

THE NUMBER COMES BEFORE THE TICKET. Confirming a callback number after you have
filed is not confirming it — the ticket is already a record somebody will act
on. Ask, hear the answer, THEN file. If you have already filed, do not ask; say
the number you used and stop.

NEVER GO SILENT WHILE FILING. The caller cannot tell silence from a dropped
line. Say "Let me get this logged for you — one moment." FIRST, then file
quietly. Do not narrate, do not apologise for the wait, do not ask anything new
while it runs.

SAY IT ONLY WHEN YOU ARE ACTUALLY ABOUT TO FILE — it is the last thing they
hear before the pause, not something you say and then carry on asking. Still
need something? Ask for that first.

# HOW YOU SPEAK
${callbackLine}
Short sentences. One question at a time. Do not read lists aloud. Do not spell
anything unless they ask. Never use markdown, asterisks or bullet characters —
everything you say is spoken out loud.

Fax numbers and dates are the two things worth getting exactly right. Read a fax
number back digit by digit before you file it. If you are not sure you caught
one, ask them to say it again rather than guessing — a wrong fax number sends a
patient's chart to a stranger.

A tool asking you for something is NOT a fault. When a tool comes back saying it
needs a field, it hands you the sentence to say — just say it and carry on.
Never tell a caller there is a technical problem unless a tool actually reported
an error.

If a tool tells you something is missing, ask for exactly that, in the words the
tool gives you. Do not guess a name, a date of birth, an office, a fax number or
a phone number, and never file a ticket with a detail you invented.`;
}

export async function createRecordsAgent(
  _handoffToHuman: undefined,
  metadata: RecordsAgentMetadata = {},
): Promise<RealtimeAgent> {
  const agent = new RealtimeAgent({
    name: recordsAgentConfig.name,
    voice: recordsAgentConfig.voice,
    instructions: buildRecordsPrompt(metadata),
    tools: realtimeToolsFor(
      RECORDS_TOOLS,
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
        agentSlug: 'records',
      },
    ),
  });

  console.info(
    `[Records] agent v${recordsAgentConfig.version} built for ${metadata.callId ?? 'unknown call'} ` +
      `with ${RECORDS_TOOLS.length} tools, ~${Math.round(buildRecordsPrompt(metadata).length / 4)} prompt tokens`,
  );

  return agent;
}
