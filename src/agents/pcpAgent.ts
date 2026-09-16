import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { buildPcpPublicKnowledgePrompt } from '../config/azulVisionKnowledge';
import { pcpSafetyGuardrails } from '../guardrails/pcpSafety';
import { escalationDetailsMap } from '../services/escalationStore';
import { markCallConcluded } from '../services/callConclusion';
import { recordingExecute } from '../services/toolTimeline';
import { withToolDirection } from '../services/toolDirection';
import { scheduleLookupService } from '../services/scheduleLookupService';
import {
  MAX_ASKS_PER_FIELD,
  PCP_FACILITY_TYPES,
  PROFESSIONAL_FIELDS,
  PATIENT_INTAKE_ORDER,
  PCP_RECORDS_DELIVERY_METHODS,
  pcpDirector,
  type PcpConversationState,
} from '../pcp/director';
import {
  PCP_CALL_PURPOSE_SLUGS,
  assertPcpDisposition,
  classifyPcpToolAccess,
  getPcpCallPurpose,
  type PcpCallPurposeSlug,
  type PcpDisposition,
  type PcpVerificationStatus,
} from '../pcp/policy';
import type { StatedSchedulingIntent } from '../tools/queueRouting';
import { refusePcp } from '../pcp/refusals';
import { asksForAPerson } from '../pcp/explicitAsk';
import { preTransferGaps, preTransferQuestion } from '../pcp/preTransferIntake';
import { QUEUE_CHOICE_WARNING, readQueueChoice, choseTheQueue } from '../pcp/queueChoice';
import { handoffAfterQueueDial } from '../pcp/queueDialSettlement';
import { callerLines, saidMoreThanTheirOwnIdentity } from '../runtime/requestSweep';
import { NARRATIVE_MAX_CHARS } from '../pcp/pcpTicketing';
import { persistSettlement, trimToBudget } from '../pcp/queueDialSettlement';
import {
  deliveryAskFor,
  isRecordsRequest,
  spokenDeliveryLine,
  syncDirectorFactsToLedger,
  ticketDeliveryNote,
} from '../pcp/recordsDelivery';
import { ticketReadiness, nextRequiredAsk, annotationFor, MAX_BLOCKS } from '../pcp/ticketRequirements';
import { submitPcpTicket, type PcpTicketPayload } from '../pcp/pcpTicketing';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';

export const pcpAgentConfig = {
  slug: 'pcp',
  name: 'PCP Support Agent',
  description: 'Professional-caller support for PCP offices, referring providers, health plans, facilities, pharmacies, and related healthcare organizations.',
  version: '1.0.0',
  /**
   * THE GREETING CONTRADICTED THE PROMPT — fixed 2026-08-14.
   *
   * The prompt says "Patients ring it too, and that is not their mistake to
   * fix", and there is a whole patient_caller path below it. The greeting then
   * opened with "This line is for healthcare professionals", which tells a
   * patient in the first six seconds that they have got it wrong. 117 of 419
   * callers on this line asked for a person and a large share were patients.
   *
   * Says what the line is FOR without telling anyone they should not have
   * called it.
   */
  /**
   * THE DISCLOSURE IS IN THE GREETING, not in the prompt.
   *
   * 219 calls on 2026-09-14 and not one told the caller the call was recorded.
   * California is a two-party-consent state and this is a healthcare practice,
   * so that is a compliance gap rather than a stylistic one. Task #79 carries
   * the same gap for the four queue lines; this fixes PCP only.
   *
   * The clause is `noIvrAgent`'s, verbatim — an operator-approved sentence
   * already live on another lane, not a new one written here. What is
   * deliberately NOT copied from it: "dial 911" and "our offices are currently
   * closed". no-ivr carries those because it is the after-hours line with no
   * humans behind it. PCP is a business-hours professional line, and adding a
   * clinical-safety instruction to it would be inventing a rule rather than
   * applying one (standing instruction 1).
   *
   * IT HAS TO LIVE HERE. On the runtime the bridge plays this as audio BEFORE
   * the model's first turn and `withGreetingAlreadyPlayed` then tells the model
   * not to repeat it — so a disclosure written into the prompt is one the model
   * MAY say, while a disclosure written here is on every call by construction.
   * Same reasoning #299 applied to the no-ivr greeting block a day earlier.
   */
  greeting:
    'Thank you for calling Azul Vision PCP Support. All calls are being recorded for quality assurance purposes. How can I help you today?',
  voice: 'sage',
  language: 'en',
} as const;

export interface PcpAgentMetadata {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  getTranscript?: () => string;
  /** Audit status maintained by staff after intake; never solicited on the call. */
  professionalVerificationStatus?: PcpVerificationStatus;
}

type PcpHandoffStatus = NonNullable<PcpTicketPayload['handoff']>['finalStatus'];
type HandoffOutcome = {
  ok: true;
  destination?: string;
  /**
   * The caller was put INTO the queue rather than connected to a person who
   * answered. Set only by the runtime's blind transfer (PCP, from
   * 2026-09-08); absent means the warm path's keypress proved a human.
   */
  handedToQueue?: true;
} | {
  ok: false;
  status?: 'HANDOFF_UNAVAILABLE' | 'NO_ANSWER' | 'FAILED';
  reason?: string;
  /**
   * WHERE WE ACTUALLY DIALLED, on a handoff that failed.
   *
   * It used to be recorded on success only, and the cost of that shows up in
   * the 90 days to 2026-08-13: 57 PCP handoffs attempted, 11 connected, and
   * every one of the 46 failures has pcp_handoff_destination NULL. So the
   * question that decides whether PCP can go back on — was the queue DID not
   * answering, or were we still dialling the retired PCP_AGENT_DIDS roster? —
   * cannot be answered from the data at all. Every ticket that could have
   * settled it recorded nothing.
   *
   * The failures that DID record a destination tell the opposite story: all 11
   * went to +17149564300 and 9 of them connected.
   */
  destination?: string;
} | void;
type HandoffCallback = () => Promise<HandoffOutcome>;

/**
 * THE PROMPT, rewritten 2026-08-13 to sound like the rest of the fleet.
 *
 * Operator, after calling the line: "this line is completely broken, sounds
 * nothing like the other lines you created... It still has the old prompt and
 * structure and I want it to sound exactly like our other agents."
 *
 * What was wrong was not the policy — the director, the dispositions and the
 * safety rules are all correct and all preserved below. It was that the prompt
 * READ like a specification: SERVER AUTHORITY, DISPOSITIONS, a bulleted table
 * of cover lines. A model given a policy document answers like one.
 *
 * So this is the same content in the shape the queue agents use: what you do,
 * what you cannot do, how a call runs, how you speak. Nothing has been relaxed.
 * Every constraint that was in the old prompt is still here, and the two the
 * operator hit on the queue lines this morning — the callback number before
 * filing, and never going silent while a tool runs — are stated the same way
 * they are on the other four.
 */
/**
 * THE INTAKE SCRIPT, RENDERED FROM THE DIRECTOR'S OWN LISTS.
 *
 * Operator, 2026-08-14, after a live call: "we should have maybe in the prompt
 * ask these questions in order and get a response and record them in order...
 * if it's a PCP you ask these questions, if it's a patient you do this,
 * because this shit sounds crazy."
 *
 * He is right, and the cause was structural. The prompt told the model to "ask
 * only the single next question record_pcp_intake gives you" and never showed
 * it WHAT the order was. So the model invented a sequence, the director
 * corrected it a turn later, and the caller heard both — on his call the agent
 * asked for his name, then asked for his name again bundled with the medical
 * group, then jumped to the callback number. His words: "the sequencing is
 * off."
 *
 * Generating the script from PROFESSIONAL_FIELDS / PATIENT_INTAKE_ORDER and
 * PROMPTS means the prompt and the director cannot drift apart. Add a field to
 * the director and it appears here; change the wording once and both follow.
 */
/**
 * THE MODEL MUST NOT SEE THE LIST. That is the whole change here.
 *
 * On 2026-08-14 the operator said the sequencing was "all over the place"
 * because the model invented its own order. My fix (#201) put the WHOLE
 * numbered intake into the prompt so it could not invent one. It stopped
 * inventing and started RECITING — reading ahead and firing several questions
 * per turn. From CAc88c6e9c, with the turn table beside it:
 *
 *   agent  "Which organization are you calling from?"        12:16:30.887
 *   agent  "Is this number ending in 7471 the best one?"     12:16:32.028   <- +1,141ms
 *   caller "You didn't give me a chance to respond..."       12:16:50.528
 *
 * No caller turn and NO TOOL CALL between those two. Two different fields,
 * asked in one breath, because the model could see both. The operator, on the
 * call before: "you gotta wait for a fucking answer. One answer at a time."
 *
 * The director already hands over exactly one field at a time, and has since
 * the beginning — `record_pcp_intake` returns `nextQuestion` and nothing else.
 * The list was redundant the day it was written; it was also the damage.
 *
 * So the prompt now describes the PROTOCOL and never the contents. The model
 * cannot read ahead through a list it was never given.
 */
function renderIntakeScript(): string {
  return `# ONE QUESTION. THEN STOP TALKING.

This is the rule the whole call runs on, and it outranks everything else in
this prompt:

  Ask ONE question. Say NOTHING else. Wait for the caller to answer.

Not a question plus an example. Not a question plus "and also". Not a question
followed by a second question because you can guess what comes next. One
question, then silence, until they have spoken.

If you catch yourself about to add another sentence after a question — don't.
That is the single thing callers on this line complain about most.

NEVER THANK SOMEONE FOR AN ANSWER THEY HAVE NOT GIVEN. "Thanks", "Great",
"Got it", "Perfect", "Understood" are all replies to something SAID. If the
caller has not spoken, you have nothing to acknowledge, and saying it anyway
tells them you are not listening. Do not write their half of the conversation.

Your turn ends the moment the question mark lands.

## HOW YOU KNOW WHAT TO ASK
record_pcp_intake tells you. It returns exactly one field, and that is the only
question you may ask next. You do not have the list and you do not need it — if
you find yourself deciding what comes after, you have already gone wrong.

  1. Record what the caller just told you with record_pcp_intake.
  2. It names ONE missing field. Ask that, in your own natural words.
  3. Stop. Wait.
  4. Repeat.

When it stops naming a field, stop asking and act.

## FIRST, ALWAYS: WHAT IS THIS CALL ABOUT?
Your greeting already asked, and almost every caller answers it in their
opening sentence — so usually you are not asking anything, you are RECORDING
what they just said. Call record_pcp_intake with callPurpose straight away.

Callers here are brief. "Referrals." "Authorization." "Appointments." That IS
the purpose — record it and move on. Do not ask them to elaborate.

If a caller is a PATIENT or their family, record callPurpose as patient_caller.
They then get a much shorter intake, and you must never ask them a professional
question — no role, no organization, no facility type.

AND SEPARATELY: if the person ON THE PHONE is the patient themselves, set
callerIsThePatient to true. Do it whatever else the call is about — someone
ringing for their OWN records is still the patient, and without this you will
end up asking them for "the patient's name" when you already have it. A family
member calling about someone else is NOT the patient; leave it off, because we
still need that person's name.

If the caller has already given you something before you asked — a name in
their opening sentence, an organization, why they are calling — record it and
skip it. Asking for what you were just told is the fastest way to lose a
professional's confidence.`;
}

export function buildPcpPrompt(metadata: PcpAgentMetadata = {} as PcpAgentMetadata): string {
  const time = getPacificTimeContext();
  const phone = metadata.callerPhone || '';

  const callbackLine = phone
    ? `You already have their number: ${formatPhoneForSpeech(phone)} (ending ${formatPhoneLast4(phone)}). It is seeded as the callback number, so do NOT ask for one unless they offer a different line. If they do, use theirs.`
    : `Their number was withheld, so you will have to ask for a callback number.`;

  return `You answer the PCP support line at Azul Vision. ${time}

This number is published for other healthcare organizations — a clinic calling
about a mutual patient, a referral coordinator, a health plan, a peer-to-peer
request. Patients ring it too, and that is not their mistake to fix.

# WHAT YOU DO
Find out who is calling and what they need, and get it to the right team. You
either answer from an approved lookup, file a request, or connect them to the
PCP team. Nothing else.

# THE DIRECTOR DECIDES, NOT YOU
Ask only the single next question record_pcp_intake gives you, and never re-ask
something already stored. It decides which fields are missing, whether a
transfer is available, and what happens at the end of the call. If it stops
asking, stop asking.

${renderIntakeScript()}

Never invent a patient, an organization, a callback number, a verification
result, an appointment, a provider, a plan or a location. If you do not have a
fact, say so.

You do not verify anyone on the call. Take the request and let it be checked
afterwards.

# IF A PATIENT REACHES YOU, TAKE THEIR REQUEST
The moment it is clear you are speaking to a patient or their family rather than
a clinic — they say so, they ask about their own eyes, their own medication,
their own appointment, or they simply cannot answer which organization they are
calling from — record the call purpose as patient_caller.

Then STOP asking professional questions. No role, no organization, no facility
type, no professional relationship. Ask their name, a callback number, and what
they need. File it with create_pcp_task; it routes their request to the right
team and tells you which in routed_to. Use THAT name when you say what happens
next.

You cannot transfer a patient — this queue is staffed to speak with clinics. Say
so plainly: "I'm not able to put you through from this line, but I'll take this
down and the right team will call you back." Then take it.

Never say "wrong number", "wrong extension", "you've reached the provider line"
or "you'll need to call another number". They rang us, and that is enough.

# TWO THINGS ABOUT THE LAST THIRTY SECONDS OF THE CALL

THE NUMBER COMES BEFORE THE TICKET, ALWAYS. Confirming a callback number after
you have filed is not confirming it — the ticket is already a record somebody
will act on. Ask, hear the answer, THEN file. If you have already filed, do not
ask; say the number you used and stop.

NEVER GO SILENT WHILE A TOOL RUNS. The caller cannot tell silence from a dropped
line. Say a short line FIRST, then call the tool, then be quiet while it works:

  intake            "Thank you — one moment while I get that into our system."
  a lookup          "One second while I look that up for you."
  appointments      "One moment while I pull up that patient's appointments."
  filing a task     "Let me get this logged for you — one moment."
  a records request "One moment while I log that records request for you."
  connecting them   nothing at all — see CONNECTING SOMEONE TO A PERSON

One line per chain is enough. Never call a tool cold. If you have been quiet for
more than a few seconds for any reason, say "Still with you — one moment."

# CONNECTING SOMEONE TO A PERSON
Only the director decides whether a transfer is available. When it is and they
ask to be put through — a representative, a person, the team — call
handoff_to_pcp on that turn, not after one more question. Never weigh a
transfer against taking the request.

THE FIRST CALL ASKS THEM TO CHOOSE and hands you the line to say. Say it, then
call handoff_to_pcp again with callerAcceptedQueue — true to connect them,
false if they would rather you took it. Never guess it; if they will not
choose, call again without it.

Yes means the queue, no ticket and nothing kept: do not warn them twice. No
means no transfer on this call — collect what is missing and file with
create_pcp_task.

SAY NOTHING BEFORE THE SECOND CALL; it moves the line and cuts you off mid-word.
Never promise you will stay with them, and never promise HOW they are reached —
one person, several, or a queue is a configuration decision. If the tool says it
did not go through, say exactly that; their request is recorded in that case.
Never say somebody answered unless they did.

# MEDICAL RECORDS
Use handle_patient_medical_records_request ONLY when the caller explicitly asks
for copies or release of a patient's medical record. Never for peer-to-peer, a
medical group, a referral, a grievance, or anything else — those stay in their
own purpose.

# SAFETY
No diagnosis, no triage, no treatment, medication or dosage advice. If somebody
describes an emergency, tell them to hang up and dial 911 — this line's transfer
is administrative and is not an emergency path.

Public practice information you may answer from an approved lookup. Plan
participation, accessibility and accommodation questions are filed as a request.

# HOW YOU SPEAK
${callbackLine}
Speak English unless the caller asks for another language. Short sentences. One
question at a time. Do not read lists aloud, do not spell anything unless asked,
and never use markdown or bullet characters — everything you say is spoken out
loud.

Do not end the call until terminate_call confirms the outcome was recorded.

# WHEN A TOOL SAYS NO
A tool refusing you is NOT a fault and NOT something the caller ever hears
about. It means do something else, and the reply tells you what.

  guidance   Instructions for YOU. Follow them. NEVER read this out — not a
             word of it, not a paraphrase of it. The caller must never learn a
             tool refused anything.
  say        A sentence for the CALLER. When it is there, say it in those
             words and do not add an apology to it.

If there is no "say", the caller is owed nothing about it — just do what the
guidance tells you and carry on as though nothing happened.

Never tell a caller that something is "unavailable", "not available for this
purpose", "not finalized", "still processing", or that you are having trouble
recording, submitting or completing anything. Never say goodbye twice. Never
apologize for a refusal. The only time you mention a problem at all is when a
tool reported a genuine failure AND handed you a "say" line for it.`;
}


/**
 * Administrative fields we would LIKE on a ticket, and what to write when the
 * call did not produce them.
 *
 * These are placeholders, not defaults: they exist so a request still reaches a
 * human, and they say plainly that the field is missing so nobody mistakes
 * "Not provided" for something the caller said.
 */
const FIELD_PLACEHOLDERS = {
  callerName: 'Not provided by caller',
  callerRole: 'Not provided',
  callerOrganization: 'Not provided',
  callerFacilityType: 'other_healthcare_organization' as const,
  callbackNumber: 'NOT PROVIDED',
};

/** Human-readable names for the intake gap note on the ticket. */
const FIELD_LABELS: Record<string, string> = {
  callerName: 'caller name',
  callerRole: 'caller role',
  callerOrganization: 'organization',
  callerFacilityType: 'organization type',
  callbackNumber: 'callback number',
  statedRelationship: 'relationship to the patient',
  patientFirstName: 'patient first name',
  patientLastName: 'patient last name',
  patientDob: 'patient date of birth',
};

/**
 * Fields worth reporting as gaps on the ticket.
 *
 * TWO CLASSES, and missing the second is what made the first pass at this
 * incomplete. The director requires the professional block on every call, and
 * ADDITIONALLY the patient block whenever the purpose has
 * patientContextRequired and does not connect to a human — which includes
 * `patient_medical_records_request`. The live timeline showed one records call
 * burning ELEVEN attempts on `missing_required_field:statedRelationship`.
 *
 * None of these is required by the ticket schema (the patient block is all
 * optionalText), so they never block filing — but "we do not know which patient"
 * is exactly what the staffer needs told, not left to infer from a blank field.
 */
const TICKET_FIELDS = [
  'callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber',
  'statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob',
] as const;

/**
 * The state to file a ticket from, and which administrative fields are absent.
 *
 * NEVER THROWS. It used to: `requireState` raised
 * `missing_required_field:<field>` whenever the director still wanted anything,
 * and every ticket tool called it FIRST — so one uncaptured administrative
 * field discarded the entire request. The tool timeline shipped 2026-08-06 and
 * showed the shape within ten minutes of going live:
 *
 *   e0384db1 (253s): record_pcp_intake x5, then create_pcp_task, handoff x3 and
 *                    create_pcp_task again — all ten calls dying on
 *                    missing_required_field:callbackNumber.
 *   e761053a (215s): five attempts, all missing_required_field:callerName.
 *
 * The caller heard "it seems like there was an issue recording" and nothing was
 * filed. On the same day 21 medical-records requests reached this line and left
 * no ticket at all. A caller who will not recite their job title, or who says
 * "that's the number you already have" instead of reading one out, must not
 * lose their request over it — the gap belongs ON the ticket, for staff to
 * close, not in place of it.
 */
function ticketState(callId: string): { state: PcpConversationState; missing: string[] } {
  const state = pcpDirector.get(callId);
  const missing = TICKET_FIELDS.filter((field) => !state[field]).map(String);
  return { state, missing };
}

/** Note the intake gaps on the ticket itself, in the caller's terms, so the
 *  staffer working it knows what to ask for rather than wondering. */
/**
 * THE LAST HAND ON THE NARRATIVE, so this is where it is made to fit.
 *
 * `PcpTicketPayloadSchema` caps `narrative` at `NARRATIVE_MAX_CHARS` and
 * `submitPcpTicket` safeParses BEFORE the wire, so an over-long one files
 * NOWHERE: no POST, no 400 in `voice_agent_api_logs`, one console line.
 * (Codex P2 on #313, found after the merge and correct.)
 *
 * IT IS CLAMPED HERE RATHER THAN AT THE CALL SITE, and that is the whole
 * lesson of the first attempt at this fix. Budgeting the excerpt inside the
 * teardown sweep looked right and still filed nothing, because THIS function
 * appends its annotation AFTERWARDS — the call site cannot see the string
 * that is actually validated. Every PCP filing path goes through
 * `buildPayload` and every one of those through here, so one clamp covers
 * them all and no future caller can out-run it.
 *
 * THE ANNOTATION IS NEVER WHAT GETS CUT. It names the fields a staffer still
 * has to collect, it is bounded by the field list, and it is the more
 * actionable half of a long ticket; the body is trimmed to make room for it
 * instead. `trimToBudget` says on the ticket that it cut, and the full
 * conversation goes out separately in `transcript` (cap 50,000).
 */
function annotateGaps(narrative: string, missing: string[], callerPhone?: string): string {
  if (!missing.length) return trimToBudget(narrative, NARRATIVE_MAX_CHARS);
  const labels = missing.map((f) => FIELD_LABELS[f] ?? f).join(', ');
  const ani = callerPhone && !missing.includes('callbackNumber')
    ? ''
    : callerPhone
      ? ` Inbound caller ID was ${callerPhone}.`
      : ' Caller ID was withheld on this call.';
  const annotation = `[Intake incomplete — not captured on the call: ${labels}.${ani}]`;
  const body = trimToBudget(narrative, NARRATIVE_MAX_CHARS - annotation.length - '\n\n'.length);
  return `${body}\n\n${annotation}`.trim();
}

function buildPayload(
  metadata: PcpAgentMetadata,
  state: PcpConversationState,
  disposition: PcpDisposition,
  narrative: string,
  urgency: 'routine' | 'normal' | 'high' | 'urgent',
  handoff?: PcpTicketPayload['handoff'],
  failureInformation?: string,
  missing: string[] = [],
): PcpTicketPayload {
  return {
    callSid: metadata.callSid || metadata.callId,
    agentSlug: 'pcp',
    agentVersion: pcpAgentConfig.version,
    callerName: state.callerName || FIELD_PLACEHOLDERS.callerName,
    callerRole: state.callerRole || FIELD_PLACEHOLDERS.callerRole,
    callerOrganization: state.callerOrganization || FIELD_PLACEHOLDERS.callerOrganization,
    callerFacilityType: state.callerFacilityType || FIELD_PLACEHOLDERS.callerFacilityType,
    callerCallbackNumber: state.callbackNumber || FIELD_PLACEHOLDERS.callbackNumber,
    statedRelationship: state.statedRelationship,
    callPurpose: state.callPurpose!,
    disposition,
    // The director's explicit-ask grant travels WITH the ticket, so the one
    // sanctioned exception to allowedDispositions is visible to whoever reads
    // it later rather than inferred. See PcpTicketPayloadSchema.
    ...(disposition === 'HAND_OFF' && state.callerRequestedHuman
      ? { dispositionGrantedByExplicitAsk: true }
      : {}),
    urgency,
    verificationStatus: state.verificationStatus,
    patientFirstName: state.patientFirstName,
    patientLastName: state.patientLastName,
    patientDob: state.patientDob,
    patientMrn: state.patientMrn,
    narrative: annotateGaps(narrative, missing, metadata.callerPhone),
    transcript: metadata.getTranscript?.() || undefined,
    handoff,
    failureInformation,
  };
}

export function createPcpAgent(handoffCallback: HandoffCallback, metadata: PcpAgentMetadata): RealtimeAgent {
  const callId = metadata.callId;
  pcpDirector.update(callId, { verificationStatus: metadata.professionalVerificationStatus ?? 'pending' });

  // Seed the callback number from caller ID. We are ON A PHONE CALL with this
  // person: their number is the one piece of contact information we never have
  // to ask for, and on 2026-08-06 asking for it anyway was the single most
  // common reason a request was thrown away (`missing_required_field:
  // callbackNumber`). Professional callers routinely answer "that's the number
  // you have" — which is true, and which used to cost them their ticket.
  //
  // Seeded, not pinned: record_pcp_intake overwrites it the moment the caller
  // states a different number (a direct line or extension is better than the
  // main switchboard they happened to dial from).
  if (metadata.callerPhone && /^\+\d{10,15}$/.test(metadata.callerPhone)) {
    pcpDirector.update(callId, { callbackNumber: metadata.callerPhone });
  }

  /**
   * How many times each required field has already blocked a filing THIS CALL.
   *
   * The floor that stops this becoming 2026-08-06 again: a field may hold the
   * ticket twice, and after that it is annotated and the request goes through.
   * Per call, so it cannot leak between callers.
   */
  let ticketBlocksUsed = 0;
  /**
   * THE ONE ROUND OF INTAKE A TRANSFER MAY COST, per call.
   *
   * Deliberately NOT `ticketBlocksUsed`. That budget is three, shared across
   * every filing gate, and three questions standing between a caller and the
   * person they asked for is the interrogation this line keeps being corrected
   * for. Operator ruling, 2026-09-08: "the ask wins, one round then transfer
   * anyway." One is the whole budget, and it is spent whether or not the
   * caller answers.
   */
  let preTransferAskUsed = false;
  /**
   * A TRANSFER IS WAITING FOR A DURABLE TICKET SO IT CAN DIAL.
   *
   * Server-owned, per call, and the model can neither set nor clear it — which
   * is the whole reason it exists rather than a read of `create_pcp_task`'s
   * `disposition` argument (Codex P1, PR #298; the long note on
   * `fileSchedulingToHub`'s parameter has the chain).
   *
   * Set when `handoff_to_pcp` refuses `durable_ticket_required_before_handoff`
   * because its OWN ticket write failed with nothing yet on record — the one
   * refusal that tells the model to file and come back. Cleared the moment the
   * caller declines the queue, because then no dial is coming and their
   * scheduling request is an ordinary filing again.
   */
  let transferAwaitingTicket = false;
  /**
   * THE QUEUE CHOICE HAS BEEN PUT TO THIS CALLER, once, in words.
   *
   * A latch and not a parameter read, because it is what makes an acceptance
   * mean anything. `callerAcceptedQueue: true` on the FIRST invocation is a
   * model asserting consent from a caller who was never warned — and this is
   * the one place where consent buys the caller a worse outcome (their request
   * is filed nowhere). So the first attempt always speaks the warning and
   * always returns; only the attempt after it can reach the queue.
   *
   * Per call, like every other budget here, so it cannot leak between callers.
   */
  let queueChoiceOffered = false;

  // Tool timeline. The fleet got this on 2026-08-01; the PCP agent was added
  // on 08-03 and never inherited it, so on 08-06 all 167 PCP calls recorded
  // ZERO tool events while every other agent recorded — which is exactly why
  // "the system is blocking the ticket" could be heard on the call and not
  // explained from the data. Arguments are allow-listed inside the timeline
  // module, so no name, DOB or free text is persisted.
  // No callLogId on PcpAgentMetadata; the flush resolves by callSid, which is
  // the same fallback the other agents rely on when the id arrives late.
  const timelineCtx = { callId, callSid: metadata.callSid, agentSlug: 'pcp' };
  const recordedTool: typeof tool = ((def: any) =>
    tool({
      ...def,
      // CP-3: the approved next line rides inside the tool result (script-listing §6).
      execute: withToolDirection('pcp', callId, def.name, recordingExecute(timelineCtx, def.name, def.execute)),
    })) as typeof tool;

  const recordIntake = recordedTool({
    name: 'record_pcp_intake',
    description: 'Store professional caller and request facts. Send only facts the caller actually provided. Returns exactly one next question and server policy state.',
    parameters: z.object({
      callerName: z.string().min(1).optional(),
      callerRole: z.string().min(1).optional(),
      callerOrganization: z.string().min(1).optional(),
      callerFacilityType: z.enum(PCP_FACILITY_TYPES).optional(),
      callbackNumber: z.string().min(7).optional(),
      /**
       * WHERE A RECORDS REQUEST GOES. Operator, 2026-09-08 — his own test
       * call took a records request and never asked. The callback number does
       * not answer this: it is seeded from caller ID, and a switchboard is not
       * somewhere you send a medical record.
       */
      recordsDeliveryMethod: z.enum(PCP_RECORDS_DELIVERY_METHODS).optional(),
      recordsDeliveryDestination: z.string().min(3).optional(),
      statedRelationship: z.string().min(1).optional(),
      callPurpose: z.enum(PCP_CALL_PURPOSE_SLUGS).optional(),
      /**
       * Is the person on the phone the patient themselves?
       *
       * A separate question from the purpose, and it has to be, because the
       * purpose changes. A patient whose opening line is "I need my records"
       * classifies as `patient_medical_records_request` and never as
       * `patient_caller`, so inferring it from the slug misses them entirely
       * — and they get asked for "the patient's first and last name" about
       * themselves. Found on the second review pass, 2026-08-17.
       *
       * The model knows this from the conversation, which is the standing
       * rule: classification is its job. The server owns what follows.
       */
      callerIsThePatient: z.boolean().optional().describe(
        'TRUE only when the person ON THE PHONE is the patient themselves. False or omitted for a clinic, '
        + 'a plan, a pharmacy — and also for a family member calling ABOUT a patient, because then the patient '
        + 'is someone else and we still need their name. Set this as soon as you know; it decides whether we '
        + 'ask "who is the call about".',
      ),
      patientFirstName: z.string().min(1).optional(),
      patientLastName: z.string().min(1).optional(),
      patientDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      patientMrn: z.string().min(1).optional(),
    }).strict(),
    execute: async (facts) => {
      /**
       * A CHANGED DELIVERY METHOD INVALIDATES THE OLD DESTINATION.
       *
       * `update` merges, so "actually, email it" after a fax number left the
       * fax number in place and the ticket read "Deliver by EMAIL to
       * <fax number>" — records sent somewhere the caller never named. Codex
       * round 4. Cleared unless the same utterance carries a replacement.
       */
      {
        const prior = pcpDirector.get(callId).recordsDeliveryMethod;
        const changing = facts.recordsDeliveryMethod && facts.recordsDeliveryMethod !== prior;
        if (changing && !facts.recordsDeliveryDestination) {
          facts.recordsDeliveryDestination = undefined;
          pcpDirector.clearRecordsDestination(callId);
        }
      }
      pcpDirector.update(callId, facts);
      /**
       * THE OTHER DELIVERY SYSTEM HAS TO HEAR ABOUT THIS. Codex P1, PR #273.
       *
       * `gateBeforeExecution` has enforced its own records-delivery rule since
       * 2026-08-07, out of the call-facts ledger, and it runs BEFORE this
       * agent's tool bodies. Left unsynchronised it defaults the method to fax
       * and blocks on a fax number, so a caller choosing mail — or taking the
       * `'unspecified'` escape — is asked for a fax forever and the block
       * budget never advances, because the handler that owns it never runs.
       *
       * It carries the caller's organisation across as well, because the same
       * gate refuses on a missing `medicalGroup` — fixing one half of a
       * disagreement between two systems is not fixing it.
       *
       * Awaited rather than fired-and-forgotten: the very next tool call can be
       * the filing, and a sync that lands after it is a sync that did nothing.
       * It writes only into a ledger that already exists (see that module for
       * why creating one would be a worse bug) and swallows its own errors, so
       * this cannot throw into the intake.
       */
      await syncDirectorFactsToLedger(callId, pcpDirector.get(callId));
      const decision = pcpDirector.next(callId);
      /**
       * THE ONLY PLACE A PCP QUESTION IS SPOKEN, so the only place the ask
       * budget is charged. See `PcpDirector.noteAsked` for why this is not
       * inside `next()`.
       *
       * On CA908f93dae322ed0e0dd862673ebf77fb (2026-09-15) this tool handed
       * back `patientFirstName` seven times and the agent asked it seven
       * times. After MAX_ASKS_PER_FIELD the director stops offering it, the
       * form moves on, and the field rides onto the ticket as NOT CAPTURED.
       */
      if (decision.nextQuestion) pcpDirector.noteAsked(callId, decision.nextQuestion.field);
      if (decision.askBudgetSpent?.length) {
        // Console-visible AND, through toolTimeline, countable from SQL. The
        // tool ceiling's stops are console-only and this is not repeating that.
        console.log(`[PCP ASK BUDGET] ${callId}: stopped asking for ${decision.askBudgetSpent.join(', ')} after ${MAX_ASKS_PER_FIELD} attempts each`);
      }
      return decision;
    },
  });

  const publicKnowledge = recordedTool({
    name: 'get_public_practice_information',
    description: 'Retrieve authoritative public Azul Vision location, provider, or service information. Never use for patient, insurance participation, accessibility, or accommodation claims.',
    parameters: z.object({ topic: z.enum(['location', 'provider', 'service']) }),
    execute: async () => {
      const state = pcpDirector.get(callId);
      if (!state.callPurpose || !['service_inquiry', 'provider_information'].includes(state.callPurpose)) {
        return refusePcp('public_knowledge_not_allowed_for_purpose');
      }
      pcpDirector.recordToolSuccess(callId, 'knowledge_base');
      return { success: true, reference: buildPcpPublicKnowledgePrompt() };
    },
  });

  const appointmentLookup = recordedTool({
    name: 'lookup_patient_appointments',
    description: 'Look up schedule/attendance for a patient-specific request after the required caller and patient context is collected.',
    parameters: z.object({
      patientFirstName: z.string().min(1),
      patientLastName: z.string().min(1),
      patientDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    execute: async (patient) => {
      pcpDirector.update(callId, patient);
      const state = pcpDirector.get(callId);
      if (!state.callPurpose) return refusePcp('call_purpose_required');
      const access = classifyPcpToolAccess(state.callPurpose, state.verificationStatus);
      if (!access.allowed || access.source !== 'scheduling') return refusePcp(access.allowed ? 'scheduling_not_allowed' : access.reason);
      try {
        /**
         * RULE ZERO ON THIS LANE. `lookupByNameAndDOB` is ONE RUNG — the
         * Operations Hub appointment book, matched on name and date-of-birth
         * STRINGS. A real patient with no appointment inside its window cannot
         * be found by it, and the failure looks random from outside
         * (standing instruction 14).
         *
         * `lookupPatient` runs that same rung FIRST, so a book hit answers
         * exactly as it does today and nothing that works today changes. What
         * it adds is the tail #292 built: when every book rung returns
         * `emptyContext()`, the PERSON BASE (`patients_master`) is asked, and
         * a match there is joined to `Schedule` on `PersonID` — identity from
         * the mirror, history from the book, one key.
         *
         * WHY NO `phone`. `lookupPatient` accepts one, and passing the
         * caller's would be wrong here in a way that is easy to miss: on this
         * line the caller is a PROFESSIONAL and the lookup is about SOMEBODY
         * ELSE. A medical assistant who is also an Azul patient would match
         * herself and we would answer a question about the wrong person. The
         * patient's identity is the only thing that may key this lookup, so
         * only the three patient fields are passed. Do not add the phone.
         */
        const context = await scheduleLookupService.lookupPatient({
          firstName: patient.patientFirstName,
          lastName: patient.patientLastName,
          dateOfBirth: patient.patientDob,
          // Unchanged from the call this replaced. The book rungs log the
          // subject's name and date of birth by default; on this line the
          // subject is a third party the caller named, so they stay out of
          // the console exactly as they did before.
          logIdentifiers: false,
        });
        pcpDirector.recordToolSuccess(callId, 'scheduling');
        return {
          success: true,
          patientFound: context.patientFound,
          upcomingAppointments: context.upcomingAppointments,
          pastAppointments: context.pastAppointments,
        };
      } catch {
        pcpDirector.recordToolFailure(callId, 'scheduling');
        return refusePcp('schedule_lookup_failed', { retry: pcpDirector.next(callId).authoritativeToolAllowed });
      }
    },
  });

  const createTask = recordedTool({
    name: 'create_pcp_task',
    description: 'Create a durable PCP Support task. Does not send patient or caller SMS.',
    parameters: z.object({
      narrative: z.string().min(1).max(12000),
      urgency: z.enum(['routine', 'normal', 'high', 'urgent']).default('normal'),
      disposition: z.enum(['CREATE_TASK', 'HAND_OFF']).default('CREATE_TASK'),
      failureInformation: z.string().max(2000).optional(),
    }),
    execute: async ({ narrative, urgency, disposition, failureInformation }) => {
      const { state, missing } = ticketState(callId);
      // The purpose is the one thing a ticket cannot be filed without — it is
      // what routes the request to the right desk. Everything else degrades.
      if (!state.callPurpose) return refusePcp('call_purpose_required');
      /**
       * WHO IS CALLING, WHO IT IS ABOUT, HOW TO REACH THEM.
       *
       * Operator, 2026-08-17: "we should not create a ticket unless we have
       * enough information to do so, a ticket should be blocked without
       * required fields... the most important parts of a ticket are who is
       * calling, who is the call about and how do we contact you."
       *
       * Bounded at MAX_BLOCKS for the whole CALL — see the long note in
       * ticketRequirements.ts for why that floor is not optional, and why it
       * counts conversations rather than fields. A caller who will not answer
       * must never lose their request.
       */
      const readiness = ticketReadiness(state, ticketBlocksUsed);
      const ask = nextRequiredAsk(readiness);
      if (ask) {
        ticketBlocksUsed += 1;
        const lastChance = ticketBlocksUsed >= MAX_BLOCKS;
        return refusePcp(`missing_required_field:${ask.field}`, {
          say: ask.prompt,
          guidance:
            'NOT AN ERROR — do not apologize, do not mention a system, and do not tell the caller anything is wrong. ' +
            `Ask them: "${ask.prompt}" Then call create_pcp_task again with the answer recorded. ` +
            (lastChance
              ? 'If they will not or cannot give it, say so is fine — file anyway on the next attempt and it will go through with the gap noted.'
              : 'If they decline, ask once more in different words before giving up on it.'),
        });
      }
      // Struck out on something required: the ticket goes through, and says so
      // plainly. A blank field must never read as something the caller said.
      const gapNote = annotationFor(readiness.annotate);
      if (gapNote) {
        console.warn(`[PCP] filing with unanswered required field(s): ${readiness.annotate.join(', ')}`);
        narrative = `${narrative}\n\n${gapNote}`;
      }
      // Only the HAND_OFF direction is gated on the director. Filing a task is
      // always a safe floor, and refusing one because the director currently
      // prefers a transfer is how a request ends up as neither.
      if (disposition === 'HAND_OFF' && pcpDirector.next(callId).disposition !== 'HAND_OFF') {
        return refusePcp('director_disposition_mismatch');
      }
      // A PATIENT'S REQUEST DOES NOT BELONG IN DEPARTMENT 18.
      //
      // The PCP endpoint files a professional-caller record — caller role,
      // organisation, facility type, the CAP-adjacent records pathway. None of
      // that describes a patient ringing about their own eye drops, and a
      // ticket sitting in PCP Support is one a person has to move by hand.
      //
      // So a patient files through the SAME create-ticket path and the SAME
      // cross-queue routing every other line uses: a refill reaches Clinical
      // Tech Support, glasses reach Optical, an appointment reaches the
      // scheduling hub. Nothing new was built for this — it is the machinery
      // that is already live on four queues.
      //
      // When the words match nothing, it lands on department 18's own
      // "Other - See Description" rather than being guessed at.
      // The latch, not just the purpose — a patient whose call was later
      // reclassified is still a patient, and their request still does not
      // belong sitting in department 18. Same reason as director.next().
      if (state.callPurpose === 'patient_caller' || state.callerIsThePatient) {
        const [{ detectCrossQueue }, { otherReasonFor }, { ticketingApiClient }, { sanitizeForSms }] =
          await Promise.all([
            import('../tools/queueRouting'),
            import('../tools/otherReason'),
            import('../../server/services/ticketingApiClient'),
            import('../services/gsm7'),
          ]);

        // A PATIENT ASKING FOR THEIR OWN RECORDS GOES TO MEDICAL RECORDS, AND
        // ON THE CLOCK. Operator ruling, 2026-08-13.
        //
        // Nothing else routes INTO department 16 — a records team is not
        // somewhere to send a call on a keyword, and a request arriving there
        // without a known requester would let the ticketing app default the
        // `mr_cases` pathway to `roa_patient`, which is the defect that put all
        // 470 existing cases on a 15-day statutory clock.
        //
        // This path is the exception because it is the one place we KNOW: the
        // purpose IS patient_caller. So the requester is not inferred, and the
        // CAP fields go with it stated rather than defaulted. Left in
        // department 18 instead, a patient's right-of-access request is
        // invisible to the report the CAP exists to produce.
        const toMedicalRecords = await fileToMedicalRecords(callId, metadata, state, narrative, {
          route: 'patient',
          floorReached: ticketBlocksUsed >= MAX_BLOCKS,
          spendBlock: () => (ticketBlocksUsed += 1),
        });
        if (toMedicalRecords) return toMedicalRecords as never;

        const redirect = detectCrossQueue(narrative, PCP_DEPARTMENT_ID);
        // Never null for 18, but handled rather than asserted: a missing
        // catch-all must not silently file into another department's Other.
        const home = otherReasonFor(PCP_DEPARTMENT_ID);
        if (!redirect && !home) return refusePcp('no_catchall_for_pcp');
        const body = sanitizeForSms(
          [
            'Patient called the PCP Support line.',
            redirect ? redirect.note : null,
            '',
            narrative,
          ].filter((l) => l !== null).join('\n'),
        ).value;

        const nameParts = String(state.callerName ?? '').trim().split(/\s+/);
        const patientResult = await ticketingApiClient.createTicket({
          departmentId: redirect?.departmentId ?? PCP_DEPARTMENT_ID,
          requestTypeId: redirect?.requestTypeId ?? home!.requestTypeId,
          requestReasonId: redirect?.requestReasonId ?? home!.requestReasonId,
          patientFirstName: nameParts[0] || 'Unknown',
          patientLastName: nameParts.slice(1).join(' ') || 'Caller',
          patientPhone: String(state.callbackNumber ?? metadata.callerPhone ?? ''),
          preferredContactMethod: 'phone',
          description: body,
          priority: urgency === 'urgent' || urgency === 'high' ? 'high' : 'medium',
          callData: { agentUsed: 'pcp', ...(metadata.callSid ? { callSid: metadata.callSid } : {}) },
        });

        if (!patientResult.success || !patientResult.ticketNumber) {
          /**
           * A 4xx IS A REFUSAL, AND A REFUSAL RETRIED IS A REFUSAL REPEATED.
           *
           * This returned `retryable: true` for EVERY failure, and on
           * 2026-09-08 that cost a real call. `CAbf717457` reached this line
           * with department 2 (the caller said "Loma Linda Surgery Center", so
           * `detectCrossQueue` read a surgery cue), department 2 demands a
           * surgeon, and create-ticket answered HTTP 400 "Missing required
           * information: surgeon". The model obliged the retry flag SIX times
           * in eighteen seconds, asked the caller who the surgeon was on a PCP
           * call, filed nothing, and the caller hung up.
           *
           * That is the same shape as the 602 doomed POSTs across 181 surgery
           * calls measured on 2026-09-01 — fixed there, never here.
           * `CreateTicketResponse.statusCode` was added for exactly this
           * distinction and this call site had not read it.
           *
           * So: a status the server chose in the 4xx range will fail
           * identically forever, and the only useful thing to do with it is
           * hand the server's own words to the model as something to ASK. No
           * status at all is a timeout or a socket reset, which may well
           * succeed next time.
           */
          const status = patientResult.statusCode;
          const refused = typeof status === 'number' && status >= 400 && status < 500;
          return refusePcp(patientResult.error ?? 'ticket_creation_failed', {
            ...(refused ? {} : { retryable: true }),
            ...(refused
              ? {
                  guidance:
                    'The ticketing system refused this payload and will refuse it again unchanged — ' +
                    'do NOT call this tool again with the same details. Its own words were: ' +
                    `"${patientResult.error ?? 'no reason given'}". If that names something the ` +
                    'caller can answer, ask them for it in your own words and try once with it ' +
                    'added. If it does not, take the rest of their request, tell them it is ' +
                    'recorded, and move on.',
                }
              : {}),
          });
        }
        pcpDirector.recordDisposition(callId, 'CREATE_TASK');
        console.info(
          `[PCP] patient caller filed to ${redirect ? redirect.departmentName : 'PCP Support'} ` +
            `(dept ${redirect?.departmentId ?? PCP_DEPARTMENT_ID}) as ${patientResult.ticketNumber}`,
        );
        return {
          success: true,
          ticketNumber: patientResult.ticketNumber,
          ...(redirect ? { routed_to: redirect.departmentName } : {}),
          message: redirect
            ? `Filed as ${patientResult.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
            : `Filed as ${patientResult.ticketNumber}. Read the ticket number back to the caller.`,
        };
      }

      /**
       * THE THIRD DOOR TO A RECORDS FILING. Codex P1, PR #273.
       *
       * A professional call already classified `patient_medical_records_request`
       * can reach `create_pcp_task` instead of the records tool — the prompt
       * prefers the records tool, and a prompt preference is not a structural
       * guard. `ticketReadiness` above deliberately excludes the delivery
       * fields, so without this the request files with nowhere to send it, and
       * the whole point of asking was to stop exactly that.
       *
       * Placed AFTER the patient branch on purpose. A patient asking for their
       * own records leaves through `file_records_ticket`, which carries the
       * CAP-compliant `deliver_to` gate; asking here as well would put the same
       * question to them twice, which is the complaint this line keeps being
       * corrected for. This gate is for the path that reaches the PCP endpoint.
       *
       * Shares `ticketBlocksUsed` with every other gate on this call, so a
       * caller who will not answer cannot be held forever — the floor in
       * ticketRequirements.ts, not a second budget beside it.
       */
      /**
       * A PROFESSIONAL RECORDS REQUEST IS STILL A RECORDS REQUEST — operator
       * ruling, 2026-09-14: any professional caller's records request files to
       * Medical Records, off the clock.
       *
       * It has to be read off the NARRATIVE, because the purpose slug cannot
       * see it: only a patient request carries
       * `patient_medical_records_request`, since the records tool sets that
       * slug itself. A clinic asking for a chart is `peer_to_peer` or
       * `service_inquiry`, so `isRecordsRequest` returns false for every one
       * of them and both the delivery ask and the route would be skipped.
       *
       * Measured before this, over live PCP records tickets in department 18
       * (backfills excluded): 41 of them, 16 from a provider organisation, 6
       * from a medical assistant or referral coordinator, 6 from a health
       * plan. Literal "peer-to-peer" appears in 2 — which is why the rule
       * reads the CALLER rather than the phrase.
       */
      const recordsByNarrative =
        (await import('../tools/medicalRecordsTaxonomy')).mentionsRecordsIntent(narrative);
      const deliveryAsk = deliveryAskFor(state, recordsByNarrative);
      if (deliveryAsk && ticketBlocksUsed < MAX_BLOCKS) {
        ticketBlocksUsed += 1;
        return refusePcp(`missing_required_field:${deliveryAsk.field}`, {
          say: deliveryAsk.prompt,
          guidance:
            'NOT AN ERROR — say nothing about a system or a problem. This is a records request and we cannot send ' +
            `records without knowing where they go. Ask: "${deliveryAsk.prompt}" then call this tool again. ` +
            "If the caller does not know or will not say, record recordsDeliveryMethod as 'unspecified' and file — " +
            'the ticket will say so.',
        });
      }
      /**
       * ROUTED BEFORE THE NOTE IS APPENDED, and the order is the point.
       *
       * `file_records_ticket` writes its own "Send to:" line from the state,
       * so appending `ticketDeliveryNote` first would put the same sentence on
       * the case twice. The note is for the PCP ticket this falls back to when
       * the route declines — which it does whenever the narrative is not a
       * records request, or the caller cannot be established as a professional
       * one, or Medical Records refuses and the strike budget is spent.
       */
      const toMedicalRecords = await fileToMedicalRecords(callId, metadata, state, narrative, {
        route: 'professional',
        floorReached: ticketBlocksUsed >= MAX_BLOCKS,
        spendBlock: () => (ticketBlocksUsed += 1),
      });
      if (toMedicalRecords) return toMedicalRecords as never;

      /**
       * AFTER RECORDS, BEFORE THE PCP TICKET. Both halves of that are chosen.
       *
       * Records first because it is the narrower claim — a chart request that
       * happens to mention an appointment is still a chart request, and
       * Medical Records is a statutory destination where the Hub is an
       * operational one. Before `submitPcpTicket` because that is the floor
       * this route falls back to; see `fileSchedulingToHub`.
       */
      const toSchedulingHub = await fileSchedulingToHub(
        callId, metadata, state, narrative, disposition, urgency, missing, transferAwaitingTicket,
      );
      if (toSchedulingHub.filed) return toSchedulingHub.filed as never;
      // Only ever set when the Hub's answer was AMBIGUOUS — see the note on
      // that branch. A proven 4xx carries nothing, because warning a staffer
      // about a duplicate that cannot exist is noise.
      if (toSchedulingHub.pcpNote) narrative = `${narrative}\n\n${toSchedulingHub.pcpNote}`;

      if (isRecordsRequest(state, recordsByNarrative)) narrative = `${narrative}${ticketDeliveryNote(state)}`;
      const response = await submitPcpTicket(
        buildPayload(metadata, state, disposition, narrative, urgency, undefined, failureInformation, missing),
      );
      if (response.success) pcpDirector.recordDisposition(callId, disposition);
      return response;
    },
  });

  const recordAutomated = recordedTool({
    name: 'record_automated_resolution',
    description: 'Record a no-ticket automated outcome, but only after an authoritative tool succeeded.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      const { state, missing } = ticketState(callId);
      if (!state.callPurpose) return refusePcp('call_purpose_required');
      // The AUTOMATE gate is a real safety property and stays: an automated
      // resolution may only be claimed off an authoritative tool that actually
      // succeeded. It refuses structurally now rather than throwing.
      if (!getPcpCallPurpose(state.callPurpose).allowedDispositions.includes('AUTOMATE')) {
        return refusePcp('automate_not_allowed_for_purpose');
      }
      const source = getPcpCallPurpose(state.callPurpose).authoritativeSource;
      if (!source || !state.completedTools.includes(source)) return refusePcp('authoritative_tool_success_required');
      const response = await submitPcpTicket(buildPayload(metadata, state, 'AUTOMATE', narrative, 'routine', undefined, undefined, missing));
      if (response.success) pcpDirector.recordDisposition(callId, 'AUTOMATE');
      return response;
    },
  });

  const handoff = recordedTool({
    name: 'handoff_to_pcp',
    description: 'Create the required durable PCP ticket, then dial the configured PCP human queue. If transfer fails, update the same ticket as the fallback task.',
    parameters: z.object({
      narrative: z.string().min(1).max(12000),
      urgency: z.enum(['normal', 'high', 'urgent']).default('high'),
      /**
       * WHAT THE CALLER SAID WHEN WE OFFERED THEM THE CHOICE.
       *
       * Optional, and its absence is meaningful rather than neutral — see
       * `readQueueChoice`. Send it only after the caller has actually heard
       * the warning and answered it; the tool speaks the warning itself on the
       * first attempt and will not read this field then.
       */
      callerAcceptedQueue: z.boolean().optional(),
    }),
    execute: async ({ narrative, urgency, callerAcceptedQueue }) => {
      const { state, missing } = ticketState(callId);
      // An explicit request to be CONNECTED to a person. Deliberately narrow:
      // "caller from the front desk asking about a referral" is not a request
      // to be transferred, and dialing the queue on it would be worse than
      // the bug being fixed (review 2026-08-09).
      const askedThisTurn = asksForAPerson(narrative);
      if (askedThisTurn) pcpDirector.markCallerRequestedHuman(callId);
      /**
       * THE LATCH, NOT THIS TURN'S WORDS. Codex P1, PR #273.
       *
       * The one-round intake sends the model away and brings it back, and the
       * narrative it returns with describes THE ANSWER, not the original ask:
       * "Caller declined to give their name", or a purpose they finally
       * stated. Neither matches `asksForAPerson`, so reading only this turn
       * broke the ruling it was built for —
       *
       *   the purpose gate below refused with `call_purpose_required` on a
       *   caller who declined, and
       *   `escalationDetailsMap` recorded `callerRequestedHuman: false`, which
       *   makes `resolveHandoffDestination` withhold the number.
       *
       * "One round then transfer anyway" would have become "one round then
       * nothing" for exactly the caller the round exists to serve.
       *
       * `markCallerRequestedHuman` has always latched this on the director, and
       * the director's own `eligibleByAsk` has always read the latch. This
       * local copy was the only thing still asking "did they say it THIS
       * time?".
       *
       * MY TESTS HID IT by passing the same bare-ask narrative on every retry —
       * a shape no real call produces, since the model summarises what just
       * happened rather than repeating itself.
       */
      const askedForAPerson = askedThisTurn || Boolean(state.callerRequestedHuman);
      // A professional who asked for a person is not blocked by a missing
      // classification (operator 2026-08-09). The purpose is still recorded
      // on the ticket; it just no longer decides whether the phone rings.
      if (!state.callPurpose && !askedForAPerson) return refusePcp('call_purpose_required');
      // Not eligible to DIAL is not a reason to lose the request. Previously
      // this threw before it even reached the eligibility check, so the caller
      // got neither a transfer nor a ticket. Now the request is filed as a task
      // and the agent is told so, in the same shape it already handles for a
      // transfer that fails to connect.
      if (!pcpDirector.next(callId).handoffEligible) {
        const fallback = await submitPcpTicket(
          buildPayload(metadata, state, 'CREATE_TASK', narrative, urgency, undefined, 'handoff_not_eligible', missing),
        );
        if (fallback.success) pcpDirector.recordDisposition(callId, 'CREATE_TASK');
        // Which failure copy: the one that CONFIRMS a number, or the one that
        // ASKS for one. `callbackNumber` is seeded from caller ID above, so it
        // is empty only when the ANI was withheld, blocked or non-E.164 — and
        // then "Is this the best number to reach you on?" points at nothing.
        // (Codex P2, #300.) The `_task_created` sibling is unaffected: the
        // request is on record there, and the number question is not its job.
        const failureSlug = state.callbackNumber
          ? 'handoff_not_eligible'
          : 'handoff_not_eligible_no_callback';
        return refusePcp(fallback.success ? 'handoff_not_eligible_task_created' : failureSlug, {
          handoffStatus: 'HANDOFF_UNAVAILABLE',
          ticketNumber: fallback.ticketNumber,
          fallbackRecorded: fallback.success,
        });
      }
      /**
       * THE QUEUE IS A CHOICE, NOT A DESTINATION. Operator ruling, 2026-09-13.
       *
       *   "For anyone that requests to speak to a representative, that should
       *    trigger the warning... We Will Not create tickets for anyone that
       *    chooses to be transferred. if they drop off, their record is lost.
       *    Their choice. If they accept, we transfer them to the queue, if they
       *    want to continue, we create a ticket with all the information
       *    needed."
       *
       * PLACED AFTER THE ELIGIBILITY CHECK, for the reason the pre-transfer
       * intake is: offering a choice we cannot honour is worse than not
       * offering it. A caller the director will not transfer must not be asked
       * to pick the queue and then told no.
       *
       * PLACED BEFORE THE PRE-TRANSFER INTAKE, because the choice decides
       * whether there is a transfer to prepare for at all. Asking for a name
       * and a callback number and only then asking "did you want to be
       * connected?" spends a round on a caller who was about to decline, and
       * on the accept path it spends it on a briefing nobody will read.
       *
       * WHAT THIS COSTS THE ACCEPTING CALLER: one extra turn. They hear the
       * choice, say connect me, and are then asked the one intake question
       * before the dial. Whether that second question should be dropped on the
       * accept path — the warning has just told them nothing carries over, so
       * asking for their name immediately after is arguably incoherent — is a
       * question for the operator, not a decision to take here. The 2026-09-08
       * "one round then transfer anyway" ruling is left standing verbatim.
       *
       * THREE OUTCOMES, AND ONLY TWO OF THEM ARE NEW:
       *
       *   accepted          hand them over, file NOTHING. The only path that
       *                     dials with the request recorded nowhere, and the
       *                     only one that needs the durability gate relaxed.
       *   declined          no dial. Back to the intake; create_pcp_task files
       *                     it with its own readiness rules behind it.
       *   not_established   EXACTLY TODAY'S BEHAVIOUR — file, then dial.
       *
       * That third row is the safety property of this whole change. The new
       * rule only ever fires on words the caller actually said; anything
       * vague, anything the model failed to bring back, and anything after a
       * wandered-off turn falls through to the proven path. So the only way to
       * lose the ticket is an explicit yes, and the only way to lose the dial
       * is an explicit no.
       */
      /**
       * SCOPED TO A CALLER WHO ASKED, because that is what the ruling says:
       * *"for anyone that requests to speak to a representative."*
       *
       * `handoffEligible` is wider than the ask — `eligibleByAsk ||` a purpose
       * whose default disposition is HAND_OFF with a complete intake, which
       * dials somebody who never requested a person. Offering that caller a
       * choice would be inventing procedure, and honouring their yes would
       * suppress a ticket the operator never said to suppress. They keep
       * today's path untouched.
       *
       * The same latched `askedForAPerson` the rest of this tool reads, not a
       * fresh look at this turn's narrative — for the reason recorded above
       * it: the model comes back describing the ANSWER, not the original ask.
       */
      const choice = askedForAPerson ? readQueueChoice(callerAcceptedQueue) : 'not_established';
      if (askedForAPerson && !queueChoiceOffered) {
        queueChoiceOffered = true;
        return refusePcp('queue_choice', { say: QUEUE_CHOICE_WARNING });
      }
      if (choice === 'declined') {
        // No dial is coming. Their request is an ordinary filing again, so it
        // may route like one.
        transferAwaitingTicket = false;
        console.info(`[PCP] the caller chose to have it taken here rather than hold for the queue (${callId})`);
        return refusePcp('queue_choice_declined');
      }
      /**
       * ONE ROUND OF INTAKE, THEN THE DIAL — WHATEVER THEY SAID.
       *
       * Operator ruling, 2026-09-08: "the ask wins, one round then transfer
       * anyway." Until now `eligibleByAsk` carried NO field requirement at
       * all, so a caller whose first words were "can I speak to a
       * representative" reached the dial on an empty intake and the staffer
       * who picked up started from zero — which is exactly what he asked
       * about: "if someone just says representative, you don't know, how can
       * you warm transfer?"
       *
       * PLACED AFTER THE ELIGIBILITY CHECK on purpose. A caller the director
       * will not transfer must not be asked questions and then told no; only
       * a transfer that is actually going to happen pays for this turn.
       *
       * AND BEFORE THE TICKET WRITE, so the answers land ON the ticket rather
       * than arriving after it. The request is still filed either way — the
       * second attempt writes it — so a caller who says nothing loses nothing.
       *
       * The latch is checked, not the answers: it is spent on being ASKED, not
       * on being answered. That is what makes it impossible to loop. See
       * src/pcp/preTransferIntake.ts for why one turn beats three, and why the
       * patient's name is deliberately not on the list.
       */
      /**
       * AND A CALLER WHO SAID YES IS NOT ASKED ANYTHING ELSE. Operator,
       * 2026-09-13: *"they asked for a person, get them to a person."*
       *
       * This narrows the 2026-09-08 "one round then transfer anyway" ruling
       * to the paths where the round still buys something, and it does so on
       * the operator's word rather than on my reading of the transport.
       *
       * WHY THE ROUND IS EMPTY ON THIS PATH. It exists to fill the briefing
       * the staffer hears and the ticket the request lands on. A caller who
       * chose the queue gets neither: nothing is filed by rule, and a blind
       * redirect briefs nobody. Worse, the sentence immediately before it has
       * just told them that what we have gone over does not carry over — so
       * asking for their name straight afterwards contradicts the warning we
       * made them listen to, in the same breath.
       *
       * WHAT IT COSTS, and where the cost is paid instead: if the queue then
       * fails to answer, the fallback ticket carries less than it would have.
       * That is the right place to ask, because it is the first moment a
       * ticket is actually going to exist — and `handoff_no_answer`'s guidance
       * already tells the model to confirm the callback number and collect
       * what is missing. `callbackNumber` is seeded from caller ID before
       * anyone speaks, so the fallback is not blind even before that.
       *
       * Every other path — declined, unclear, no answer, and a transfer the
       * caller never asked for — still gets the round, unchanged.
       */
      /**
       * ONE NAME, ONE JOB. This decides what we ASK — not whether we FILE.
       *
       * It was `transferWithoutATicket` and it answered both questions with
       * one boolean until the operator reversed the filing half on
       * 2026-09-15. Keeping the old name while only one of its two meanings
       * survived is how `connectsToHuman` welded the length of the intake to
       * whether we dial; see the reversal note in `queueChoice.ts`.
       */
      const callerChoseTheQueue = choseTheQueue(choice);
      if (!callerChoseTheQueue && !preTransferAskUsed) {
        const question = preTransferQuestion(preTransferGaps(state));
        if (question) {
          preTransferAskUsed = true;
          return refusePcp('pre_transfer_intake', { say: question });
        }
      }
      const requestedAt = new Date().toISOString();
      // The ticket contract requires a purpose. When the caller simply asked
      // for a person before saying why, record the generic inquiry so the
      // durable ticket validates — the staffer who picks up learns the rest
      // from the caller. Without this the payload is rejected and the dial is
      // never reached (review 2026-08-09).
      const handoffState = state.callPurpose
        ? state
        : { ...state, callPurpose: 'service_inquiry' as const };
      /**
       * THE PRE-DIAL TICKET, ON EVERY PATH — Rosa's design, restored by the
       * operator on 2026-09-15 ("yes to the v14 reversal").
       *
       * This was `transferWithoutATicket ? undefined : ...` from 09-13, so a
       * caller who chose the queue was dialled with nothing written anywhere.
       * `initial` is now always defined, which means the two gates below —
       * "the request is on record" and "the call is still live" — protect the
       * accepted arm again as well. That is not a side effect to tolerate, it
       * is the invariant those gates exist for: CAa37f1a42 is a caller told
       * "give me one moment while I connect you" and connected to nobody,
       * with no record of the request anywhere.
       *
       * `REQUESTED` is what it says before the dial. The line below turns it
       * into DIALING / TRANSFERRED_TO_QUEUE once the redirect goes out, and
       * never into CONNECTED.
       */
      const preDialPayload = buildPayload(metadata, handoffState, 'HAND_OFF', narrative, urgency, {
        requested: true, requestedAt, attempted: false, finalStatus: 'REQUESTED',
      }, undefined, missing);
      const initial = await submitPcpTicket(preDialPayload);
      /**
       * THE PRECONDITION IS "THE REQUEST IS ON RECORD" — NOT "THIS WRITE
       * RETURNED 200". CAa37f1a42, 2026-09-04 16:11.
       *
       * A surgery-center coordinator asked for a representative, was told
       * "give me one moment while I connect you", and was connected to nobody.
       * The handoff write failed three times; create_pcp_task then filed
       * PCP-57486; and the gate below still refused, because it was reading
       * its OWN write rather than the invariant it exists to protect. The
       * request was durable and the caller was held back anyway.
       *
       * The failing write was the ticket API rejecting every HAND_OFF payload
       * — a strict schema that did not declare `dispositionGrantedByExplicitAsk`,
       * the field attached ONLY when a caller explicitly asks for a person.
       * That is fixed on the ticketing app, which makes this path rare rather
       * than impossible: any future write failure lands here the same way.
       *
       * AUTOMATE is deliberately not durable. It records a disposition and
       * files nothing — the ticket API returns before inserting — so treating
       * "a disposition was recorded" as "a ticket exists" would dial a caller
       * whose request is written down nowhere.
       */
      /**
       * ON RECORD **AND** STILL ON THE LINE. Codex P1 on PR #273.
       *
       * A recorded disposition alone is not enough to dial on, because
       * teardown writes one. `pcpDirector.get()` hands back the stored object
       * rather than a copy, and `sweepPcpUnfiledCall` — which runs when the
       * caller hangs up — files "CALLER HUNG UP BEFORE THE REQUEST WAS
       * COMPLETE" and records CREATE_TASK on that very object. A caller who
       * drops while this write is in flight would therefore satisfy the gate
       * and get the PCP team dialled for nobody: a staffer picking up to
       * silence, which is worse than the bug this gate change fixes.
       *
       * Liveness turns on when teardown STARTS, not when the sweep finishes.
       * The sweep is nearly the END of teardown — `voiceAgentRoutes.ts` marks
       * the call ended, awaits `cancelActiveOfficeLegs`, and only reaches the
       * sweep later behind a dynamic import — so waiting for the metadata to
       * disappear leaves a window in which a caller who has already gone still
       * reads as live. `pcpCallIsLive` closes it (Codex, round 2 on PR #273).
       *
       * It has to be checked HERE rather than left to the handoff callback:
       * on the sequential PCP path `voiceAgentRoutes.ts:1501` clears
       * `abortedPcpHandoffs` before the dial loop, wiping the evidence of the
       * very disconnect that check exists to detect.
       *
       * Reading the live field rather than a snapshot is deliberate. A
       * snapshot taken before the write was tried first and mutation-tested
       * out: it distinguished no case liveness does not already cover, and it
       * would have refused a legitimate concurrent create_pcp_task filing on
       * a call that is still up.
       */
      const requestIsOnRecord =
        state.dispositionRecorded === 'CREATE_TASK' || state.dispositionRecorded === 'HAND_OFF';
      const callStillLive = pcpCallIsLive(callId);
      /**
       * LIVENESS GATES THE DIAL, NOT ONE BRANCH OF IT. Codex round 4.
       *
       * The previous shape only consulted `callStillLive` when the ticket
       * write FAILED, so a caller who hung up while a SUCCESSFUL write was in
       * flight still reached handoffCallback(). Nothing downstream catches it:
       * the sequential path clears its abort marker before dialling. The
       * asymmetry was mine — refusing on failure and not on success has no
       * justification, and the race tests only ever covered the failure side.
       */
      if (!callStillLive) {
        console.warn(`[PCP] the call has ended — NOT dialling (${callId})`);
        return refusePcp('durable_ticket_required_before_handoff');
      }
      if (initial && !initial.success && !requestIsOnRecord) {
        // The dial is coming back the moment something durable exists, so the
        // filing the model is about to make belongs on the PCP endpoint with
        // the handoff columns — not routed to another department's queue.
        transferAwaitingTicket = true;
        return refusePcp('durable_ticket_required_before_handoff');
      }
      if (initial && !initial.success) {
        console.warn(
          `[PCP] handoff ticket write failed but the request is already durable (${state.dispositionRecorded}) — dialling`,
        );
      }
      /**
       * THE INVARIANT NOW HAS A SECOND SATISFIER, AND ONLY ONE.
       *
       * The gate above exists so we never dial a caller whose request is
       * recorded nowhere — CAa37f1a42, where a coordinator was told "give me
       * one moment while I connect you" and connected to nobody, with the
       * refusal reading its own failed write instead of the invariant. That
       * invariant is unchanged for every caller who did not choose the queue:
       * `initial` is defined for them, so both branches above still run.
       *
       * What the operator's ruling changes is not the invariant but who it
       * protects. A caller on this path was told, in the turn immediately
       * before, that nothing we have gathered goes with them — and chose it.
       * "Their choice" is the whole ruling, and a choice needs to have been
       * offered: `queueChoiceOffered` is a latch that always returns on the
       * first attempt, so there is no reachable path where `accepted` is read
       * from a caller who never heard the warning. That structure, not the
       * model's word, is what makes this safe.
       */

      escalationDetailsMap.set(callId, {
        agentSlug: 'pcp',
        /**
         * THE TICKET LEARNS WHAT THE DIAL DID — and it is registered HERE
         * because there is nowhere later to register it.
         *
         * On the blind path the redirect ends the Media Stream, so by the time
         * Twilio's `<Dial action>` callback lands there is no agent, no tool
         * invocation and no closure left. `runtimeTransfer` snapshots this into
         * the pending-dial entry exactly as it snapshots `briefingGaps`,
         * because this map is deleted in `attempt`'s finally.
         *
         * ONLY WHEN THE PRE-DIAL WRITE SUCCEEDED. The ticketing app updates a
         * ticket it can find by `callSid` and INSERTS when it cannot, so
         * registering this after a failed write could open a SECOND ticket
         * minutes after the call, carrying a dial outcome and none of the
         * intake. A failed pre-dial write is already handled above.
         *
         * WHAT IT HOLDS: `preDialPayload`, which carries the caller's name and
         * callback number, for as long as the dial runs (the runtime evicts a
         * pending entry after an hour). That is a real extension of how long
         * this process holds those fields; it is the same payload the call
         * already built, and the entry is dropped the moment the dial settles.
         */
        onBlindDialSettled: initial.success
          ? async (settlement) => {
              // No `destination` here on purpose: at registration time the
              // dial has not happened. `settlement.dialedNumber` carries the
              // number the runtime actually dialled, off the pending entry.
              const { handoff, disposition } = handoffAfterQueueDial(settlement, {
                requestedAt,
                attemptedAt,
              });
              /**
               * RETRIED, because nothing else will. Codex P1 on #313.
               *
               * `handleBlindDialResult` forgets the pending dial and answers
               * Twilio 200 before this resolves, so a transient failure here
               * used to be one log line and the ticket stayed at DIALING —
               * on a `no_answer` that means the request is never reopened as
               * an OPEN task and the caller is never called back, which is
               * the loss v30 exists to close.
               *
               * This does NOT delay the webhook: the callback is already
               * fired-and-forgotten by the transport, so the retry window
               * sits entirely after Twilio has its TwiML.
               */
              const res = await persistSettlement(
                () => submitPcpTicket({ ...preDialPayload, disposition, handoff }),
              );
              console.info(
                `[PCP] queue dial settled ${settlement.outcome} after ${settlement.ringSeconds}s ringing` +
                  `${settlement.connected ? `, ${settlement.talkSeconds ?? 0}s bridged` : ''}` +
                  ` — ticket ${res.ok ? `updated on attempt ${res.attempts}` : 'NOT updated'} (${callId})`,
              );
            }
          : undefined,
        callerRequestedHuman: askedForAPerson,
        callerType: state.callPurpose,
        reason: narrative,
        patientFirstName: state.patientFirstName,
        patientLastName: state.patientLastName,
        patientDob: state.patientDob,
        callbackNumber: state.callbackNumber,
        /**
         * BUILT FROM THE PARTS THAT EXIST. This was a template literal, and a
         * template literal stringifies `undefined` — a caller who said only
         * "representative" produced "undefined, undefined", which is truthy,
         * so the office heard it read out. `buildPcpTransferBriefing` now
         * refuses placeholder text as a floor; this is the source.
         */
        providerInfo: [state.callerRole, state.callerOrganization].filter(Boolean).join(', ') || undefined,
        /**
         * WHAT THE ONE ROUND DID NOT GET, recorded at the moment of the dial.
         *
         * Operator: "build it and the telemetry." Without it, "does one round
         * actually fill the briefing?" can only be answered by listening to
         * calls.
         *
         * COMPUTED HERE, FROM THIS INVOCATION'S `state`. An earlier version of
         * this comment claimed it was "recomputed from the live state rather
         * than reused from the gate above", implying a stale value was being
         * avoided — there is none. `state` comes from `ticketState(callId)` at
         * the top of THIS execute, which is the attempt AFTER the question, so
         * it already carries whatever the caller answered. Mutating it to the
         * director's own object changed no test, because
         * `pcpDirector.get()` returns the live reference `state` is derived
         * from: they are the same object. The claim was decoration on a line
         * that is correct for a simpler reason.
         *
         * What WOULD break it is hoisting the gap list to the top of the tool
         * and reusing it for both the question and this record — that would
         * report the gate's input as its output, and every call would read as
         * unanswered. The test named for it guards that shape.
         */
        briefingGaps: preTransferGaps(state),
        /**
         * FALSE BY DESIGN ON AN ACCEPTED TRANSFER, not by failure.
         *
         * The pair reads "we asked, and this is what we still did not get".
         * On the queue-choice accept path we deliberately do not ask, so this
         * is false and `briefingGaps` is full — which is the intended shape,
         * not a round that misfired. Anyone measuring "does one round fill the
         * briefing?" (the 2026-09-08 telemetry ask) must exclude those calls
         * rather than score them as empty answers; they are absent from the
         * population, not zeroes in it.
         */
        askedBeforeDial: preTransferAskUsed,
        /** The one field the operator named first, and the one never sent. */
        callerName: state.callerName,
      });
      const attemptedAt = new Date().toISOString();
      /**
       * ARM THE SWEEP EXEMPTION BEFORE THE DIAL, BECAUSE THE RACE IS THE DIAL.
       *
       * On the blind path `redirectCallerToQueue` ends the Media Stream, so
       * teardown starts while this await is still outstanding —
       * `voiceAgentRoutes.ts` marks the call ended and eventually reaches
       * `sweepPcpUnfiledCall`. None of that sweep's existing exits catch this
       * caller: no disposition is recorded (that is the promise), and
       * `handoffStatus` is not `CONNECTED` and never will be, because a queue
       * is not a person. It would file "CALLER HUNG UP BEFORE THE REQUEST WAS
       * COMPLETE" for the one caller we undertook not to file for.
       *
       * Setting it after the dial would lose that race every time the redirect
       * is fast, which is the normal case.
       */
      if (callerChoseTheQueue) pcpDirector.setCallerChoseTheQueue(callId, true);
      const outcome = await handoffCallback();
      const ok = Boolean(outcome && outcome.ok);
      /**
       * A DIAL THAT NEVER LANDED RE-ARMS THE SWEEP, AND OWES THEM A TICKET.
       *
       * "If they drop off, their record is lost — their choice" is about a
       * caller who LEFT. It is not about a caller still on the line because
       * the queue did not answer: their choice was the queue, and they did not
       * get it. So a failed dial withdraws the exemption, the fallback write
       * below files the CREATE_TASK, and `handoff_no_answer` — whose copy says
       * "I have your request recorded" — becomes true again rather than the
       * broken promise this line keeps being corrected for.
       */
      if (callerChoseTheQueue && !ok) pcpDirector.setCallerChoseTheQueue(callId, false);
      /**
       * A BLIND TRANSFER IS NOT A CONNECTION, and the ticket must not claim
       * one. Rosa's design, approved 2026-09-08: the PCP caller is put into
       * the call centre's own queue with a spoken warning, and a ticket is
       * filed either way "so it's searchable by phone number".
       *
       * That ticket's whole value is to the staffer who reads it AFTER the
       * caller gave up in the hold queue. `CONNECTED` tells them the
       * conversation already happened; `DIALING` tells them the caller was
       * put through and we stopped being able to see what happened, which is
       * exactly true. Both values already exist in the ticketing app's
       * `PCP_HANDOFF_STATUSES`, so this needs nothing from that team — and
       * `humanAnswerStatus` is free text there, which is where the
       * unambiguous word goes.
       *
       * `connectedAt` stays UNSET for the same reason: there is no instant a
       * human answered, and inventing one would put a timestamp on an event
       * nobody observed.
       */
      const handedToQueue = Boolean(outcome && outcome.ok && outcome.handedToQueue);
      const finalStatus: PcpHandoffStatus = ok
        ? (handedToQueue ? 'DIALING' : 'CONNECTED')
        : ((outcome && !outcome.ok && outcome.status) || 'FAILED');
      pcpDirector.recordHandoffResult(callId, { status: finalStatus as PcpConversationState['handoffStatus'], reason: outcome && !outcome.ok ? outcome.reason : undefined });
      const finalDisposition: PcpDisposition = ok ? 'HAND_OFF' : 'CREATE_TASK';
      // Re-read rather than reuse: the caller may have given more during the
      // transfer narration. Non-throwing — this runs AFTER the dial, so a throw
      // here loses the outcome record on a call that really did connect.
      const { state: rawFinalState, missing: finalMissing } = ticketState(callId);
      const finalState = rawFinalState.callPurpose
        ? rawFinalState
        : { ...rawFinalState, callPurpose: 'service_inquiry' as const };
      /**
       * THE POST-DIAL WRITE, ON EVERY PATH — the other half of the reversal.
       *
       * This was `transferWithoutATicket && ok ? undefined : ...`, so an
       * accepted transfer wrote nothing here either and the arm was INVISIBLE
       * in `tickets` — which is the instrument CLAUDE.md says to measure PCP
       * transfers from, and never `call_logs`. The 09-13 baseline (72
       * attempted, 12 reached a human) could not be continued past that line
       * for the callers it applied to.
       *
       * The fields carry Rosa's vocabulary exactly, and none of it is new:
       * `handedToQueue` gives `DIALING` with `humanAnswerStatus =
       * TRANSFERRED_TO_QUEUE` and NO `connectedAt`, so the ticketing app's
       * `humanHandoffOccurred = finalStatus === 'CONNECTED'` stays false. The
       * v20 rule — nothing on the blind path may record that a human answered
       * — is untouched by filing; it was never the ticket's existence that
       * claimed a person, it was the status.
       *
       * The app upserts on `callSid`, so this is an UPDATE of the pre-dial
       * row rather than a second ticket.
       */
      const updated = await submitPcpTicket(buildPayload(metadata, finalState, finalDisposition, narrative, urgency, {
        requested: true,
        requestedAt,
        attempted: true,
        attemptedAt,
        // Recorded whether or not it connected. A failed transfer with no
        // destination is an unanswerable question later; see HandoffOutcome.
        destination: outcome ? outcome.destination : undefined,
        humanAnswerStatus: handedToQueue ? 'TRANSFERRED_TO_QUEUE' : finalStatus,
        connectedAt: ok && !handedToQueue ? new Date().toISOString() : undefined,
        finalStatus,
        failureReason: outcome && !outcome.ok ? outcome.reason : undefined,
        fallbackTicketStatus: ok ? undefined : 'OPEN',
      }, outcome && !outcome.ok ? outcome.reason : undefined, finalMissing));
      if (updated?.success) pcpDirector.recordDisposition(callId, finalDisposition);
      if (callerChoseTheQueue && ok) {
        console.info(
          `[PCP] handed to the queue on the caller's own choice — ticket filed at ${finalStatus}, not CONNECTED (${callId})`,
        );
      }
      const settled = {
        handoffStatus: finalStatus,
        ticketNumber: initial?.ticketNumber ?? updated?.ticketNumber,
        fallbackRecorded: Boolean(updated?.success),
      };
      if (ok) return { success: true, ...settled };
      /**
       * A DIAL THAT FAILED HAS TO COME BACK WITH WORDS. CAa2a3a1c1, 2026-09-08.
       *
       * This return used to be `{success:false, ...settled}` and nothing else,
       * so the model was handed a bare failure and improvised — it resumed the
       * intake script mid-transfer while the caller asked "did you try to
       * connect?". See `handoff_no_answer` in refusals.ts for the transcript.
       *
       * The three statuses differ in what happened on OUR side and not at all
       * in what the caller is owed, so two of them share their copy and the
       * third reuses the eligibility line that was already written for it.
       * HANDOFF_UNAVAILABLE reaching here is the POLICY refusing at dial time
       * — the earlier eligibility check catches the director's refusal — and
       * the caller hears the same thing either way.
       *
       * `fallbackRecorded` is deliberately not what selects the copy. The
       * request is durable before the dial (`requestIsOnRecord`, above) and
       * `initial` has already written a ticket, so a failed FALLBACK write is
       * a lost outcome record, not a lost request: telling the caller their
       * request went nowhere would be the false statement, not the reassuring
       * one.
       */
      const slug =
        finalStatus === 'NO_ANSWER'
          ? 'handoff_no_answer'
          : finalStatus === 'HANDOFF_UNAVAILABLE'
            ? 'handoff_not_eligible_task_created'
            : 'handoff_failed';
      return refusePcp(slug, settled);
    },
  });

  const patientMedicalRecordsIntake = recordedTool({
    name: 'handle_patient_medical_records_request',
    description: 'Create an isolated PCP manual-review task only for an explicit request for copies or release of a patient medical record. Never use for peer-to-peer or medical-group requests.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      pcpDirector.update(callId, { callPurpose: 'patient_medical_records_request' });
      /**
       * THE 27-SECOND TICKET, and why this tool now waits.
       *
       * On CA7a5f2bfa the records ticket filed 27 seconds in and the caller
       * answered questions for the following minute — all of it discarded,
       * because there is no amend path. Operator, 2026-08-17: "27 seconds is
       * not enough to gather the right information, we should not create a
       * ticket unless we have enough information to do so."
       *
       * It files EARLY today for a good reason, and that reason has to survive:
       * on 2026-08-06 this tool threw on any missing administrative field and
       * 21 records requests reached this line with nothing filed behind them —
       * including patients asking for their own records, and one caller who
       * rang back eight minutes later and got nothing a second time.
       *
       * So it now blocks on the three fields that matter and NOTHING else, with
       * the same two-strike floor as create_pcp_task, and the hangup fallback
       * (sweepPcpUnfiledCall) catches a caller who drops mid-intake. A records
       * request is still not discardable for want of a job title — it is just
       * no longer filed before we know whose records they are.
       */
      {
        const { state: preState } = ticketState(callId);
        const readiness = ticketReadiness(preState, ticketBlocksUsed);
        const ask = nextRequiredAsk(readiness);
        if (ask) {
          ticketBlocksUsed += 1;
          return refusePcp(`missing_required_field:${ask.field}`, {
            say: ask.prompt,
            guidance:
              'NOT AN ERROR — say nothing about a system or a problem. A records request cannot be filed until we know ' +
              `whose records these are and how to reach the requester. Ask: "${ask.prompt}" then call this tool again.`,
          });
        }
        const gapNote = annotationFor(readiness.annotate);
        if (gapNote) narrative = `${narrative}\n\n${gapNote}`;
      }
      /**
       * DELIVERY IS GATED HERE, NOT ONLY IN THE DIRECTOR. Codex round 4.
       *
       * Two holes this closes, and both were real:
       *
       *   1. THE PATIENT PATH SKIPPED IT ENTIRELY. A patient or family member
       *      is stored as `patient_caller`, so the director's records branch —
       *      which keys on `patient_medical_records_request` — never fired.
       *      This tool then set that purpose ITSELF and filed immediately, so
       *      the destination-less request the change exists to prevent still
       *      went through.
       *   2. NOTHING FORCED THE PROFESSIONAL PATH BACK THROUGH INTAKE either.
       *      The director only shapes what `record_pcp_intake` returns; it
       *      cannot stop this tool being called straight out.
       *
       * And it shares `ticketBlocksUsed`, which is what my own commit message
       * claimed and was not true: MAX_BLOCKS only ever counted fields inside
       * `ticketReadiness`, so a caller who declined the delivery question was
       * asked it forever. Bounded here, by the budget that already exists.
       */
      {
        const { state: deliveryState } = ticketState(callId);
        const deliveryAsk = deliveryAskFor(deliveryState);
        if (deliveryAsk && ticketBlocksUsed < MAX_BLOCKS) {
          ticketBlocksUsed += 1;
          return refusePcp(`missing_required_field:${deliveryAsk.field}`, {
            say: deliveryAsk.prompt,
            guidance:
              'NOT AN ERROR — say nothing about a system or a problem. We cannot send records without knowing ' +
              `where they go. Ask: "${deliveryAsk.prompt}" then call this tool again. If the caller does not know ` +
              "or will not say, record recordsDeliveryMethod as 'unspecified' and file — the ticket will say so.",
          });
        }
      }
      const { state, missing } = ticketState(callId);
      /**
       * The delivery instruction goes ON the ticket, in words, because the
       * staffer who fulfils it cannot send anything without it. Appended to
       * the narrative rather than added to the API payload: the ticket schema
       * has no field for it, and inventing one would need the other team.
       */
      narrative = `${narrative}${ticketDeliveryNote(state)}`;
      /**
       * AND IT GOES TO MEDICAL RECORDS, which is the whole point of the tool.
       *
       * Operator, 2026-09-13: *"a medical records request should file a ticket
       * with medical records, not pcp."*
       *
       * IT DID NOT. This tool — the one NAMED for records — filed a plain PCP
       * ticket through `submitPcpTicket` into department 18 and never touched
       * the records library, the CAP fields, or department 16. The only route
       * that reached Medical Records lived inside `create_pcp_task`, gated on
       * the caller reading as a patient, and this tool sets
       * `callPurpose = 'patient_medical_records_request'` on entry — which
       * overwrites the `patient_caller` value that route keys on. So picking
       * the correctly-named tool actively defeated the correct route.
       *
       * MEASURED 2026-09-13, PCP tickets whose description mentions a medical
       * record: 54 in department 18, 2 in department 16 — and both of those 2
       * are dated 08-05 and 08-07, BEFORE the 2026-08-14 migration that wrote
       * the current route. Nothing has reached Medical Records from this lane
       * in the month since.
       *
       * The PCP filing below is kept as the FALLBACK, not the default: if the
       * narrative does not classify as a records request, or the library is
       * unavailable, the request is still taken here rather than lost. That
       * ordering is deliberate — `docs/BACKEND_HANDOFF.md`'s rule is that a
       * routing change must not cost a filing, and a request in the wrong
       * department is recoverable while a request nowhere is not.
       */
      const toMedicalRecords = await fileToMedicalRecords(callId, metadata, state, narrative, {
          route: 'patient',
          floorReached: ticketBlocksUsed >= MAX_BLOCKS,
          spendBlock: () => (ticketBlocksUsed += 1),
        });
      if (toMedicalRecords) return toMedicalRecords as never;

      const response = await submitPcpTicket(
        buildPayload(metadata, state, 'CREATE_TASK', narrative, 'high', undefined, 'patient_medical_records_request_isolated', missing),
      );
      if (response.success) pcpDirector.recordDisposition(callId, 'CREATE_TASK');
      /**
       * SAY SOMETHING BEFORE THE LINE GOES QUIET.
       *
       * On CAdc07bca1b6e2c7daf43c9f3a8f5ee4fa this tool returned bare success.
       * Nothing told the agent to speak, terminate_call became legal the
       * instant the disposition was recorded, and the caller got "let me get
       * this logged for you — one moment" followed by a dead line. The patient
       * path in create_pcp_task has carried a `message` for exactly this
       * reason; records never did.
       */
      if (!response.success) {
        return { ...response, recordsPathwayUsed: false, isolatedFromPcpPurposes: true };
      }
      const deliveryLine = spokenDeliveryLine(state);
      return {
        ...response,
        recordsPathwayUsed: false,
        isolatedFromPcpPurposes: true,
        message:
          `Filed as ${response.ticketNumber}. Read that number back to the caller and say our medical records ` +
          `team will follow up.${deliveryLine} Do not promise a date. Ask if there is anything else before ending the call.`,
      };
    },
  });

  const terminate = recordedTool({
    name: 'terminate_call',
    description: 'End the call only after the PCP director confirms the disposition is durably recorded.',
    parameters: z.object({ reason: z.enum(['completed', 'caller_declined', 'ghost_call', 'spam']) }),
    execute: async ({ reason }) => {
      if (!pcpDirector.next(callId).mayTerminate) return refusePcp('durable_disposition_required');
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return refusePcp('missing_api_key');
      const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) {
        pcpDirector.clear(callId);
        // Deliberate, successful hangup — SIP recovery must not transfer
        // this finished call.
        markCallConcluded(callId, `terminate_call:${reason}`);
      }
      return { success: response.ok, reason, status: response.status };
    },
  });

  // The sweep runs after this closure is gone, so it needs the metadata that
  // buildPayload depends on — the callSid and the transcript getter.
  pcpCallMetadata.set(callId, metadata);

  const agent = new RealtimeAgent({
    name: pcpAgentConfig.name,
    handoffDescription: pcpAgentConfig.description,
    instructions: buildPcpPrompt(metadata),
    tools: [recordIntake, publicKnowledge, appointmentLookup, createTask, recordAutomated, handoff, patientMedicalRecordsIntake, terminate],
  });
  agent.outputGuardrails = pcpSafetyGuardrails;
  return agent;
}

/**
 * A RECORDS REQUEST GOES TO MEDICAL RECORDS, THROUGH THE ONE LIBRARY.
 *
 * Extracted 2026-09-13 from inside `create_pcp_task`, where it was the only
 * copy — and where `handle_patient_medical_records_request`, the tool actually
 * NAMED for records, could not reach it. That tool filed a plain PCP ticket
 * instead, so the route measured: 54 PCP records tickets in department 18
 * against 2 in department 16, and both of those 2 predate the 2026-08-14
 * migration to the shared library. Zero have reached Medical Records since the
 * route was written.
 *
 * Extracted rather than copied for the reason this file already records: the
 * previous copy DRIFTED. It carried its own CAP logic, never gained the
 * operator's 2026-08-13 hard gate, and opened `mr_cases` rows with no
 * destination and no date range — starting a statutory clock nobody could work.
 * One library, one records contract, and now one call site shape.
 *
 * Returns `null` when the narrative is not a records request, so the caller
 * carries on with its own routing. Otherwise returns the tool's own envelope:
 * a refusal goes back verbatim so the model speaks the library's `askAs`.
 */
/**
 * PCP Support. The home department for this lane, and the `homeDepartmentId`
 * every routing decision on it is made against.
 *
 * Module scope because two paths need it — the patient branch's
 * `detectCrossQueue` call and the scheduling route below — and a second `18`
 * written out by hand is how two routing rules start disagreeing.
 */
const PCP_DEPARTMENT_ID = 18;

/**
 * A SCHEDULING REQUEST REACHES THE TEAM THAT SCHEDULES — standing instruction
 * 10, 2026-08-13: "anything that's schedule related that comes through any of
 * these should go to the HVA hub."
 *
 * PCP was the one queue it had never come through. The four lane agents route
 * on `detectCrossQueue`, and on this line that call sits inside
 * `create_pcp_task`'s `patient_caller || callerIsThePatient` branch, so a
 * PROFESSIONAL's scheduling request never passed it. Everything else files
 * through `/api/voice-agent/pcp-ticket`, which is pinned to department 18
 * server-side.
 *
 * MEASURED BEFORE THIS, over all 217 PCP tickets on 2026-09-14: **75 carry one
 * of the three scheduling slugs and ZERO have ever reached department 9.** 56
 * of them attempted a transfer instead and 10 connected — so the request was
 * neither scheduled by a human nor filed with the schedulers.
 *
 * IT ROUTES ON THE STATED SLUG, NOT THE PROSE, and that is deliberate twice
 * over:
 *
 *   IT SEES MORE. 25 of the 75 contain no scheduling cue at all — the intake
 *   captured the purpose as an enum and the narrative summarised around it.
 *   Prose alone leaves a third of them behind.
 *
 *   IT CANNOT FIRE ON AN EMPLOYER. `detectCrossQueue` is NOT called here, and
 *   that is a guard rather than an omission: `'surgery center'` in its cue
 *   list routed a Loma Linda Surgery Center caller's ticket to department 2 on
 *   2026-09-08 (CAbf717457), which is still open. Running the full classifier
 *   over a professional's narrative would adopt that defect on this lane for
 *   subjects nobody asked me to reroute. The narrative is read for ONE thing —
 *   the surgery exception — inside `schedulingRedirectForStatedIntent`.
 *
 * THE PCP TICKET IS THE FLOOR. A declined route, a refused POST, anything but
 * a ticket number back, and this returns null so `submitPcpTicket` files as it
 * always did. Losing the request is the one outcome this must never produce —
 * the guard on this change is that PCP requests filing NOWHERE must not rise.
 * A failed POST creates nothing, so falling through cannot duplicate; the one
 * narrow case it could is a success carrying no ticket number, and a possible
 * duplicate the hub can close beats a request nobody holds.
 */
const STATED_SCHEDULING_INTENT: Partial<Record<PcpCallPurposeSlug, StatedSchedulingIntent>> = {
  schedule_appointment: 'new',
  reschedule_appointment: 'reschedule',
  cancel_appointment: 'cancel',
};

/**
 * What the route did. `filed` is the tool result when the Hub took it;
 * otherwise the PCP ticket files and `pcpNote`, when present, is appended to
 * its narrative.
 *
 * A plain `null` was not enough once an AMBIGUOUS Hub failure had to be told
 * apart from a declined route: the caller has to be able to write something on
 * the PCP ticket, and returning the note is the only way out of this function.
 */
type HubRouteOutcome =
  | { filed: Record<string, unknown> }
  | { filed: null; pcpNote?: string };

async function fileSchedulingToHub(
  callId: string,
  metadata: PcpAgentMetadata,
  state: PcpConversationState,
  narrative: string,
  disposition: PcpDisposition,
  urgency: 'routine' | 'normal' | 'high' | 'urgent',
  missing: string[],
  /**
   * SERVER-OWNED, and that is the whole point — Codex P1, PR #298.
   *
   * True while `handoff_to_pcp` is waiting for a durable ticket so it can
   * retry the dial. Set by that tool when its own write failed and nothing was
   * on record; cleared when the caller declines the queue.
   *
   * The guard below used to read `disposition`, which is a MODEL argument with
   * `.default('CREATE_TASK')`. So the filing a mid-transfer caller's model is
   * TOLD to make — by `durable_ticket_required_before_handoff`, in those words
   * — arrived here indistinguishable from an ordinary one. It routed to the
   * Hub, `recordDisposition('CREATE_TASK')` satisfied `requestIsOnRecord`, and
   * the retried dial then rested on a department-9 scheduling ticket carrying
   * none of the `pcp_handoff_*` columns and no `dispositionGrantedByExplicitAsk`
   * — the field whose absence is what killed this transfer on 2026-08-27.
   *
   * The dial is not new: before this change the same fallback filed a PCP
   * ticket and recorded the same disposition. What moved is WHERE the durable
   * record lives, and a transfer must not rest on a ticket filed into another
   * department's queue.
   */
  transferAwaitingTicket: boolean,
): Promise<HubRouteOutcome> {
  const intent = state.callPurpose ? STATED_SCHEDULING_INTENT[state.callPurpose] : undefined;
  if (!intent) return { filed: null };
  if (transferAwaitingTicket) return { filed: null };
  /**
   * A TRANSFER IN FLIGHT KEEPS ITS OWN TICKET.
   *
   * HAND_OFF here means the director granted it on the caller's explicit ask,
   * and that ticket is the durable record the dial is gated on: it carries
   * `dispositionGrantedByExplicitAsk`, the `pcp_handoff_*` columns and the
   * transfer telemetry, none of which exist on a generic create-ticket
   * payload. Under the v14 queue choice an accepted queue files nothing at
   * all. Routing that ticket elsewhere would take the sanction off the
   * transfer — which is how the transfer died once already, on 2026-08-27.
   *
   * 14 of the 75 measured tickets carry HAND_OFF, so this is a real branch and
   * not a theoretical one.
   */
  if (disposition !== 'CREATE_TASK') return { filed: null };

  const [{ schedulingRedirectForStatedIntent }, { ticketingApiClient }, { sanitizeForSms }] =
    await Promise.all([
      import('../tools/queueRouting'),
      import('../../server/services/ticketingApiClient'),
      import('../services/gsm7'),
    ]);

  const redirect = schedulingRedirectForStatedIntent(intent, narrative, PCP_DEPARTMENT_ID, [
    // The caller's own organisation and role, so the surgery exception reads
    // the REQUEST and not the letterhead — Codex round 3, PR #298. On this
    // line the intake records both, so they are available as stated values
    // rather than having to be found in the prose.
    String(state.callerOrganization ?? ''),
    String(state.callerRole ?? ''),
  ]);
  // Null is the surgery exception: "surgery is an exception to that hva hub
  // rule" (operator, 2026-08-13). It stays on the PCP ticket for a coordinator
  // rather than being guessed into another department.
  if (!redirect) return { filed: null };

  /**
   * WHOSE NUMBER GOES ON THE TICKET, and why it is the caller's.
   *
   * `CreateTicketParams` has one phone field. On this lane the person the hub
   * has to ring is the REQUESTING OFFICE, not the patient — measured over the
   * 75: every one carries a caller callback number and only 35 carry a real
   * patient first name. So the callback number goes in the field and the
   * description says plainly whose it is, rather than the hub dialling a
   * number that was never the patient's.
   *
   * The patient name is NOT asked for to fill this. These purposes take the
   * short intake (`connectsToHuman`), and adding a blocking field to a filing
   * path is the 2026-08-06 failure that lost 21 records requests in a day.
   * `annotateGaps` already writes what was not captured onto the ticket.
   */
  const callback = String(state.callbackNumber ?? metadata.callerPhone ?? '');
  const who = [state.callerName, state.callerRole, state.callerOrganization]
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0 && !/^not /i.test(v))
    .join(', ');
  const body = sanitizeForSms(
    [
      'Taken on the PCP Support line.',
      redirect.note,
      who ? `Requested by ${who}.` : null,
      callback ? `Callback ${callback} reaches the requesting office, not the patient.` : null,
      '',
      // The same gap annotation `buildPayload` puts on a PCP ticket. Routing a
      // request to another department must not quietly drop the note saying
      // what the intake did not capture — the hub is the team that has to ask
      // for it, so it is the team that most needs to know.
      annotateGaps(narrative, missing, metadata.callerPhone),
    ].filter((l) => l !== null).join('\n'),
  ).value;

  const result = await ticketingApiClient.createTicket({
    departmentId: redirect.departmentId,
    requestTypeId: redirect.requestTypeId,
    requestReasonId: redirect.requestReasonId,
    patientFirstName: String(state.patientFirstName ?? '').trim() || 'Unknown',
    patientLastName: String(state.patientLastName ?? '').trim() || 'Patient',
    patientPhone: callback,
    preferredContactMethod: 'phone',
    description: body,
    /**
     * THE TOOL'S OWN URGENCY, mapped exactly as the patient branch maps it —
     * Codex P2, PR #298. This was hardcoded `medium`, so a `create_pcp_task`
     * called with `high` or `urgent` reached the Hub deprioritised, where
     * before the change `buildPayload` carried it onto the PCP ticket. A
     * routing change must not quietly reorder somebody's queue.
     */
    priority: urgency === 'urgent' || urgency === 'high' ? 'high' : 'medium',
    /**
     * ONE HUB TICKET PER CALL. `create_pcp_task` is a tool the model can call
     * more than once — the refusal paths above it exist precisely to send it
     * back — and without a key each attempt opens another department-9 ticket.
     * CLAUDE.md measured the keyed duplicate rate at 3 calls in 2,086 (0.14%).
     */
    idempotencyKey: `${metadata.callSid || callId}-scheduling-hub`,
    callData: { agentUsed: 'pcp', ...(metadata.callSid ? { callSid: metadata.callSid } : {}) },
  });

  if (!result.success || !result.ticketNumber) {
    /**
     * A STATUSLESS FAILURE IS NOT A PROVEN REFUSAL — Codex P2, PR #298, and it
     * corrects a claim this PR made out loud: "a failed POST creates nothing,
     * so falling through cannot duplicate."
     *
     * `CreateTicketResponse.statusCode` exists for exactly this distinction:
     * it is set when the server answered and said no, and ABSENT for a
     * timeout, a DNS failure or a socket reset — where the POST may have
     * landed and committed before the answer was lost. A `success: true`
     * carrying no ticket number is ambiguous in the same way.
     *
     * The floor does not move: a request must never file NOWHERE, so the PCP
     * ticket still goes. What changes is that a possible duplicate stops being
     * SILENT. An idempotency key cannot help here — the second write is to a
     * different endpoint — so the answer is to write it on the ticket a person
     * will read, and let them close one.
     */
    const provenRefusal = typeof result.statusCode === 'number'
      && result.statusCode >= 400 && result.statusCode < 500;
    console.warn(
      `[PCP] scheduling route to the HVA Hub declined (${result.error ?? 'no ticket number'}` +
        `${provenRefusal ? `, HTTP ${result.statusCode}` : ', no HTTP status — outcome unknown'}) — ` +
        'filing the PCP ticket instead',
    );
    return {
      filed: null,
      ...(provenRefusal
        ? {}
        : {
            pcpNote:
              '[The scheduling hub may already hold a scheduling ticket for this call — the '
              + 'request to it did not come back with an answer, so it may have been recorded '
              + 'there as well. Check before acting, and close whichever is the duplicate.]',
          }),
    };
  }

  pcpDirector.recordDisposition(callId, 'CREATE_TASK');
  console.info(
    `[PCP] ${intent} appointment filed to the HVA Hub (dept ${redirect.departmentId}, ` +
      `reason ${redirect.requestReasonId}) as ${result.ticketNumber}`,
  );
  return {
    filed: {
      success: true,
      ticketNumber: result.ticketNumber,
      routed_to: redirect.departmentName,
      message:
        `Filed as ${result.ticketNumber} with our scheduling team. Read the ticket number back and say ` +
        'the scheduling team will follow up. Do NOT offer to transfer or connect them.',
    },
  };
}

async function fileToMedicalRecords(
  callId: string,
  metadata: PcpAgentMetadata,
  state: PcpConversationState,
  narrative: string,
  /**
   * PCP'S FLOOR OUTRANKS THE LIBRARY'S REQUIREMENTS — and this parameter is
   * the whole reason the routing does not cost a filing.
   *
   * The two rules genuinely conflict. PCP's is "after the strike budget, file
   * with whatever we have" (2026-08-06, when 21 records requests were lost in
   * a day to blocking fields). The records library's is "these fields are
   * required" — `callback_number` among them, on a `required` list enforced
   * before the handler runs, which no `on_clock_ask_exhausted` flag can reach.
   *
   * Routing through the library without this made the library's rule win, and
   * `pcpIntakeDegradation` said so in the plainest possible terms: "never
   * filed after 6 attempts — the floor is broken". A degraded call that used
   * to leave a PCP ticket would have left nothing.
   *
   * So: while the budget is intact a refusal is returned and the agent asks —
   * that is the library working. Once the floor is reached, a refusal returns
   * `null` instead and the caller files its own ticket. Medical Records is the
   * preference; never losing the request is the rule.
   *
   * A LIBRARY REFUSAL SPENDS A STRIKE, and without that the floor is
   * unreachable — Codex P1, #296.
   *
   * `ticketBlocksUsed` was only ever advanced by PCP's OWN gates: the intake
   * readiness check and the delivery ask. A call whose intake is complete and
   * whose destination is already captured spends neither, so a refusal from
   * the library's own `required` list came back with the budget still at zero
   * — `callback_number` is on that list, enforced before the handler, and it
   * refuses under ten digits or over eleven while `record_pcp_intake` accepts
   * the same answer. Every retry then returned the identical refusal,
   * `floorReached` could never become true, and the fallback below never ran:
   * the request filed NOWHERE, where before this route existed it left a PCP
   * ticket. That is the exact number this change promised not to move.
   */
  budget: {
    /**
     * WHICH CALLER THIS IS, STATED RATHER THAN SNIFFED — operator ruling,
     * 2026-09-14, when professional records requests were let through.
     *
     * The two routes read WHO IS ASKING from different evidence and must not
     * borrow each other's. `patient` reads only the prose of
     * `statedRelationship`, exactly as it did before this parameter existed.
     * `professional` may read `callerFacilityType`, an enum a PROFESSIONAL
     * intake fills from a closed list and a patient has no business carrying.
     *
     * One shared rule would run the dangerous direction: a caller the model
     * classified `patient_caller` who somehow also carried a facility type
     * would read as a provider and come OFF the statutory clock. A patient's
     * own deadline can only be switched off by a mistake nobody sees, so the
     * routes are separated at the call site rather than inferred here.
     */
    route: 'patient' | 'professional';
    floorReached: boolean;
    spendBlock: () => number;
  },
): Promise<Record<string, unknown> | null> {
  const { classifyRecords, classifyRequester, requesterTypeForFacility, mentionsRecordsIntent } =
    await import('../tools/medicalRecordsTaxonomy');
  /**
   * INTENT FIRST, CLASSIFICATION SECOND — Codex P1, #297.
   *
   * `classifyRecords` picks WHICH records reason applies and carries bare
   * organisation words to do it ("primary care", "referring provider",
   * "legal"). It cannot be asked WHETHER this is a records request: on the
   * professional route that reads an `outside_referral_status` call as one.
   *
   * The patient route is left keyed on the classifier alone, exactly as v15
   * shipped it. That path is reached only from the `patient_caller` branch,
   * where the caller is the subject of their own request, and changing its
   * population is a separate before-and-after measurement rather than
   * something to slip into this one.
   */
  if (budget.route === 'professional' && !mentionsRecordsIntent(narrative)) return null;
  const recordsHit = classifyRecords(narrative);
  if (!recordsHit) return null;

  const { getTool } = await import('../tools/registry');
  await import('../tools/medicalRecordsTools');
  const fileRecords = getTool('file_records_ticket');
  if (!fileRecords) return refusePcp('records_tool_unavailable', { retryable: true }) as never;

  /**
   * A PROFESSIONAL RELATIONSHIP IS NOT A PERSONAL ONE — Codex P1, #296.
   *
   * `statedRelationship`'s own question is *"What is your PROFESSIONAL
   * relationship to this patient?"*, so the modal caller on this line — a
   * medical assistant or coordinator at a doctor's office, 49% of it — answers
   * "primary care provider" or "referring provider". Mapping every non-empty
   * answer to `personal_representative` filed all of them as the patient's
   * personal representative on the `roa_patient` pathway with the statutory
   * clock running: the wrong requester on a CAP record, and a deadline
   * invented for records that are not going back to the patient.
   *
   * `resolveRequesterType` cannot correct it downstream. Its guard is
   * deliberately one-directional — never OFF the clock — so a stated on-clock
   * value beats an off-clock `provider` read from the prose. The stated value
   * has to be right at the source.
   *
   * Only the three OFF-clock professional types are taken from the classifier,
   * and only when the caller has not said they are the patient. Everything
   * else keeps the previous answer, so the daughter this ternary was written
   * for is still a personal representative and still on the clock. The guard
   * still stands behind it either way: a professional label can never pull a
   * request the narrative put on the clock off it.
   */
  const stated = String(state.statedRelationship ?? '').trim();
  const offClockType = (t: unknown) =>
    t === 'provider' || t === 'health_plan' || t === 'legal' || t === 'other';
  const professional = budget.route === 'professional'
    ? (() => {
        /**
         * A PHARMA REP IS THE ONE EXCLUSION from "any professional caller".
         *
         * They have no treatment relationship to the patient, so their asking
         * for a chart is not a request to route anywhere automatically — it is
         * something a person should look at. Returning null leaves it in PCP
         * Support, which is exactly where it goes today.
         */
        if (state.callerFacilityType === 'pharmaceutical_representative'
          || state.callPurpose === 'pharmaceutical_representative') return null;
        // The enum first. It is picked from a closed list, so unlike a cue
        // list matched against free speech there is nothing in it to drift.
        const fromFacility = requesterTypeForFacility(state.callerFacilityType);
        // A SPECIFIC facility wins outright; the generic bucket does not.
        // `other_healthcare_organization` is what a law firm picks, because the
        // enum has no attorney value — so letting it return here would file an
        // attorney on `third_party_other` and never reach the legal cues below
        // (Codex P2, #297). It still answers if the prose says nothing.
        if (fromFacility && fromFacility !== 'other') return fromFacility;
        // Then what they said about themselves, most specific first.
        for (const text of [stated, state.callerRole, state.callerOrganization]) {
          const t = text ? classifyRequester(String(text)) : null;
          if (offClockType(t)) return t;
        }
        return fromFacility;
      })()
    : state.callerIsThePatient === true
      ? null
      : (() => {
          const fromRelationship = stated ? classifyRequester(stated) : null;
          return fromRelationship === 'provider'
            || fromRelationship === 'health_plan'
            || fromRelationship === 'legal'
            ? fromRelationship
            : null;
        })();

  /**
   * THE PROFESSIONAL ROUTE FILES ONLY WHEN IT KNOWS WHO IS ASKING.
   *
   * The patient route has a sound default — a caller on the patient branch who
   * named no relationship IS the patient, and `patient` is the on-clock answer
   * that protects them. The professional route has no such default: falling
   * back to it there would put a stranger's request on the patient's own
   * right-of-access clock and name them as the requester on a CAP record.
   *
   * So an unidentifiable professional caller is not routed at all, and their
   * request files to PCP Support exactly as it does today. Declining to route
   * costs the department-16 improvement on that call; guessing costs a
   * statutory deadline on somebody else's.
   */
  if (budget.route === 'professional' && !professional) return null;

  const requesterType = professional ?? (stated ? 'personal_representative' : 'patient');
  /** Who the CAP record names as the requester when it is not the patient. */
  const professionalDescriptor = [state.callerRole, state.callerOrganization]
    .map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');

  const nameBits = String(state.callerName ?? '').trim().split(/\s+/).filter(Boolean);
  const recordsResult = (await fileRecords.handler({
    first_name: state.patientFirstName || nameBits[0] || 'Unknown',
    last_name: state.patientLastName || nameBits.slice(1).join(' ') || 'Caller',
    date_of_birth: state.patientDob ?? '',
    callback_number: String(state.callbackNumber ?? metadata.callerPhone ?? ''),
    request_description: `Patient called the PCP Support line.\n\n${narrative}`,
    request_reason_id: String(recordsHit.requestReasonId),
    /**
     * STATED, NOT DESCRIBED — and this is the line the whole extraction is for.
     *
     * It read `requester: 'the patient themselves'`, hardcoded, so a daughter
     * ringing about her mother filed as the patient: `requestor_type` wrong,
     * `requestor_name` hers reported as the patient's. The fix was attempted
     * once with a ternary and withdrawn, because the fallback wording
     * "…calling on the patient's behalf" matches SPEAKING_FOR_ANOTHER in the
     * taxonomy, resolving to `other` and taking a family member OFF the
     * statutory clock. Trading a naming error for a clock error under an OCR
     * Corrective Action Plan was not a trade to make on prose.
     *
     * `requester_type` removes the round trip: the director already HOLDS this
     * as `callerIsThePatient` and `statedRelationship`, so it is asserted
     * rather than re-derived from a sentence. And it is now safe to assert,
     * because the operator settled the clock on 2026-09-13 — *"personal rep
     * stands in for the patient"* — so both values this line can produce are
     * ON the clock. Getting the label right can no longer move the deadline;
     * it only fixes who the record says was asking. `resolveRequesterType`
     * refuses to let any stated value drop a request off the clock regardless.
     */
    requester_type: requesterType,
    requester: budget.route === 'professional'
      ? `${state.callerName ?? 'the caller'} — ${professionalDescriptor || stated || 'professional caller'}`
      : stated
        ? professional
          ? `${state.callerName ?? 'the caller'} — ${stated}`
          : `${state.callerName ?? 'the caller'} — ${stated} of the patient`
        : `the patient themselves${state.callerName ? ` (${state.callerName})` : ''}`,
    /**
     * PASS THE DELIVERY PCP ALREADY HOLDS — without this the route refuses.
     *
     * `file_records_ticket` hard-gates `deliver_to` and `date_range` when the
     * request is on the clock (operator, 2026-08-13: *"can we hard gate the
     * records to require the appropriate fields"*), because an `mr_cases` row
     * with no destination starts a statutory clock nobody can work.
     *
     * PCP collects the destination already, through its own records-delivery
     * intake, and the first version of this extraction did not forward it. The
     * suite caught it: every on-clock request came back as a refusal instead
     * of a filing. That is precisely the failure `docs/BACKEND_HANDOFF.md`
     * exists to stop — a routing change costing filings — and it would have
     * hit every patient records call on the lane.
     *
     * `date_range` is deliberately NOT invented here. PCP has never asked for
     * one, and filling it with "all records" would put words in a caller's
     * mouth on a compliance record. So the request files WITHOUT it and the
     * gap is written on the ticket — `on_clock_ask_exhausted` below.
     */
    ...(state.recordsDeliveryDestination
      ? { deliver_to: `${state.recordsDeliveryMethod ?? 'as arranged'} to ${state.recordsDeliveryDestination}` }
      : state.recordsDeliveryMethod && state.recordsDeliveryMethod !== 'unspecified'
        ? { deliver_to: String(state.recordsDeliveryMethod) }
        : {}),
    /**
     * PCP CANNOT ASK, SO IT SAYS SO. Operator ruling, 2026-09-13, choosing this
     * over adding a date-range question to this lane.
     *
     * The library hard-gates `deliver_to` and `date_range` on an on-clock
     * request. PCP forwards the destination it already collects and has never
     * collected a range — so without this flag every patient records call comes
     * back a refusal and the request stays in department 18, which is the
     * defect this whole change exists to fix.
     *
     * The flag does not skip a question we could ask; it declares that this
     * lane has none left. The records lane, which does ask, never sets it and
     * its gate is untouched.
     */
    on_clock_ask_exhausted: true,
    ...(metadata.callSid ? { call_sid: metadata.callSid } : {}),
    ...(metadata.callerPhone ? { caller_phone: metadata.callerPhone } : {}),
  })) as Record<string, any>;

  // A refusal here is a question for the caller, not a fault. Hand it back
  // verbatim so the model speaks the tool's own askAs — unless the caller's
  // own floor is spent, in which case the request must land somewhere.
  if (recordsResult?.success === false) {
    // An ask costs a strike wherever it comes from, and this one is the
    // library's. Read the floor AFTER spending, or the budget is exhausted one
    // invocation before anything notices — and on this lane the next
    // invocation is the one that never comes.
    const spent = budget.spendBlock();
    if (budget.floorReached || spent >= MAX_BLOCKS) {
      console.warn(
        `[PCP] Medical Records refused (${String(recordsResult.error ?? 'unknown')}) and the intake floor ` +
          'is spent — falling back to a PCP ticket rather than losing the request',
      );
      return null;
    }
    return recordsResult;
  }

  /**
   * `ticket_number`, NOT `ticketNumber` — and this was live.
   *
   * `file_records_ticket` returns snake_case (`ticket_number`, `requester_type`,
   * `cap_clock_applies`); the code extracted here read `recordsResult.ticketNumber`,
   * which is always undefined. So the one path that DID reach Medical Records
   * told the agent *"Filed as undefined with our medical records team. Read the
   * ticket number back"* — and the agent would have read it out.
   *
   * Not caught before because the path is nearly untravelled: 2 tickets ever,
   * both before the 2026-08-14 migration. Surfaced only when the extraction
   * put it under a test that asserts the number a caller is told. Filing a
   * ticket the caller cannot quote is most of the way to not filing one.
   */
  const filedNumber = recordsResult.ticket_number ?? recordsResult.ticketNumber;

  pcpDirector.recordDisposition(callId, 'CREATE_TASK');
  console.info(
    `[PCP] records request filed to Medical Records as ${filedNumber} ` +
      `(${recordsHit.requestReason}, requester ${recordsResult.requester_type}, ` +
      `clock ${recordsResult.cap_clock_applies ? 'ON' : 'off'})`,
  );
  return {
    success: true,
    ticketNumber: filedNumber,
    routed_to: 'Medical Records',
    message: `Filed as ${filedNumber} with our medical records team. Read the ticket number back and say that team will follow up. Do not promise a date.`,
  };
}

/** Live PCP calls, so the teardown sweep can build a payload after the fact. */
const pcpCallMetadata = new Map<string, PcpAgentMetadata>();

/**
 * TEARDOWN HAS BEGUN — the earliest signal there is, and it has to be.
 *
 * Codex, round 2 on PR #273. `pcpCallMetadata` is not early enough on its own:
 * production teardown (`voiceAgentRoutes.ts`) adds the abort marker, then
 * `await cancelActiveOfficeLegs(callId)`, and only reaches
 * `sweepPcpUnfiledCall` much later behind a dynamic import. Across that whole
 * window the metadata is still present, so a handoff write that fails inside
 * it would read the call as live and dial a caller who has already gone.
 *
 * This is set SYNCHRONOUSLY at the top of that teardown, before any await, so
 * there is no window between the call ending and the dial being refused.
 *
 * Bounded rather than unbounded: the sweep clears its own id, and a size cap
 * catches any path that ends a call without one.
 */
const endedPcpCalls = new Set<string>();

/** Record that this PCP call is over. Call it synchronously, first thing. */
export function markPcpCallEnded(callId: string): void {
  if (!callId) return;
  endedPcpCalls.add(callId);
  if (endedPcpCalls.size > 500) {
    // Oldest-first: Set preserves insertion order.
    for (const id of endedPcpCalls) {
      endedPcpCalls.delete(id);
      if (endedPcpCalls.size <= 250) break;
    }
  }
}

/** Is this call still up? False the moment teardown starts. */
/**
 * EXPORTED so the OLD CORE's sequential dial path can consult it too.
 *
 * `voiceAgentRoutes.ts` has its own disconnect marker, `abortedPcpHandoffs`,
 * and CLEARS it immediately before the dial loop — so a teardown that lands
 * while `addHumanAgent` is awaiting its Twilio client is erased by the very
 * code the marker exists to stop (Codex P1, PR #273). This registry is the one
 * the dial path does not own and cannot clear, which is exactly why it is the
 * one to ask.
 */
export function pcpCallIsLive(callId: string): boolean {
  return !endedPcpCalls.has(callId) && pcpCallMetadata.has(callId);
}

/**
 * THE HANGUP FALLBACK — what makes "file later" safe to do at all.
 *
 * Blocking a ticket until we know who is calling, who it is about and how to
 * reach them (ticketRequirements.ts) is the operator's ruling, and on its own
 * it would simply move the lost-request failure later: a caller who drops
 * during the intake now leaves NOTHING, where before they left a thin ticket
 * filed at 27 seconds. This closes that.
 *
 * If the call ends with no durable disposition recorded, file what was
 * gathered, annotated so nobody mistakes a gap for something the caller said.
 *
 * THE GATE IS DELIBERATELY TIGHT, and the reason is on the record: azul's
 * equivalent sweep ran for every call on 2026-07-30 and put ~30 false "call
 * them back" tickets into the staff queue in two hours. A ghost call is not a
 * request. So this files only when the caller actually told us something —
 * a purpose AND some identity. `callbackNumber` is deliberately NOT enough on
 * its own: it is seeded from caller ID before anyone speaks, so it is present
 * on a silent call too.
 *
 * Never throws: the call is already over, and a failed sweep must not surface
 * anywhere near the caller.
 */
export async function sweepPcpUnfiledCall(callId: string): Promise<void> {
  const metadata = pcpCallMetadata.get(callId);
  pcpCallMetadata.delete(callId);
  try {
    const state = pcpDirector.get(callId);
    if (state.dispositionRecorded) return; // something durable already exists
    /**
     * A CONNECTED TRANSFER IS NOT AN UNFILED CALL.
     *
     * `dispositionRecorded` alone is not enough. handoff_to_pcp files its
     * durable ticket BEFORE it dials and updates the same ticket after, so a
     * call that connected can reach teardown while that second write is still
     * in flight — and this would file "CALLER HUNG UP BEFORE THE REQUEST WAS
     * COMPLETE" for someone sitting on the line with a staffer.
     *
     * That is the same error azul's sweep made in the other direction on
     * 2026-07-28: 9 of 12 spurious tickets were callbacks for patients who had
     * already been helped. Caught in review here rather than in the queue.
     */
    if (state.handoffStatus === 'CONNECTED') {
      console.info(`[PCP] SWEEP: ${callId} connected to a person — nothing to file`);
      return;
    }
    /**
     * NOR IS A CALLER WHO CHOSE THE QUEUE, and this one needs its own exit.
     *
     * Operator ruling, 2026-09-13: no ticket for anyone who chooses to be
     * transferred, and if they drop off their record is lost — their choice.
     * Neither exit above reaches them. There is no disposition, because not
     * filing IS the ruling; and `handoffStatus` is `DIALING`, not `CONNECTED`,
     * because on a blind transfer nothing ever observes a human answering.
     *
     * So without this the safety net would break the promise the rule makes,
     * a second or two after the rule kept it — and it would break it with the
     * worst possible wording, telling a staffer the caller hung up before
     * finishing when in fact they are in the queue where they asked to be.
     *
     * `handoff_to_pcp` withdraws the flag if the dial fails, so a caller whose
     * transfer never happened still falls through to the filing below.
     */
    if (state.callerChoseTheQueue) {
      console.info(`[PCP] SWEEP: ${callId} chose the live queue over a ticket — nothing to file, by design`);
      return;
    }

    const toldUsSomething = Boolean(
      state.callPurpose &&
        (state.callerName || state.patientFirstName || state.patientLastName || state.statedRelationship),
    );
    /**
     * AN UNHONOURED ASK FOR A PERSON IS A REQUEST, even with no name attached.
     *
     * The identity rule above selects against exactly the population it exists
     * to serve, and 2026-09-14 is the measurement that finally says so: all 17
     * callers whose requests were lost that day reached this line and were
     * turned away by it. Each had said one thing — "speak to a
     * representative" — refused to give a name when asked, and been told, in
     * words, that we had taken it down. `callPurpose` was `patient_caller` on
     * every one of them, so the first clause held; none of the four identity
     * fields did, so `toldUsSomething` was false and the safety net skipped
     * them. CLAUDE.md carries this as an open question ("no name, no ticket",
     * 47 of 53 skipped). For this one shape it is answerable.
     *
     * WHY THIS CASE AND NOT THE GENERAL ONE. `callerRequestedHuman` is a
     * latched, explicit ask for a person that we did not honour — not an
     * absence of information but a request in its own right, and the only one
     * a caller can make without volunteering anything about themselves. The
     * two exits above have already removed the callers who DID get a person
     * (`CONNECTED`) and the ones who chose the queue and accepted the cost
     * (operator, 2026-09-13), so what is left here asked and was refused.
     *
     * AND WE USUALLY HAVE A CALLBACK NUMBER: caller ID seeds it at the top of
     * `createPcpAgent`, so "this number asked for a person and did not get
     * one" is normally a complete, workable ticket rather than a stub.
     *
     * NOT ALWAYS, and this comment said "never short of" until the withheld-ANI
     * fork in `refusals.ts` proved otherwise (Cursor, #300). The seeding regex
     * correctly rejects a non-E.164 ANI — "anonymous", blocked, restricted —
     * so a caller who withholds their number AND hangs up before giving one
     * leaves a ticket with no way to reach them. That is still better than
     * silence: a staffer sees the request and the timestamp rather than
     * nothing at all. Closing it properly means either declining to file or
     * inventing a placeholder, and both are routing decisions rather than code
     * ones — OPEN FOR WAYNE (standing instruction 1).
     *
     * THE NARROWNESS IS THE POINT. Filing on every unidentified call would
     * recreate azul's 2026-07-28 sweep, where 9 of 12 spurious tickets were
     * callbacks for patients who had already been helped.
     *
     * STILL GATED ON `callPurpose`, deliberately. `buildPayload` reads
     * `state.callPurpose!` and the payload schema takes an enum, so filing
     * without one is refused before it reaches the wire — a silent loss of
     * exactly the kind this block is closing. Picking a slug to stand in would
     * be choosing a department for the request, which is a routing rule and
     * the operator's to make (standing instruction 1). All 17 carried a
     * purpose, so this covers them; a caller who asks for a person with no
     * purpose recorded at all is a narrower residual gap, and it is noted for
     * Wayne rather than papered over here.
     */
    const askedForAPersonAndDidNotGetOne = Boolean(state.callPurpose && state.callerRequestedHuman);
    /**
     * A CALL NOBODY CLASSIFIED IS STILL A CALL SOMEBODY MADE.
     *
     * Operator, 2026-09-15, answering all three of his own questions in one
     * go: *"are we capturing the transcripts for these calls? … if we're
     * capturing the transcripts then why are we not reading the transcripts
     * for the call purpose … actually now that I think about it, why don't we
     * just leave it in the PCP queue and let the PCP agents route it manually
     * to where it needs to go — rather safe than sorry rather than dump it
     * into medical records and create a case unnecessarily."*
     *
     * READ THE TRANSCRIPT, DO NOT CLASSIFY FROM IT. That third sentence
     * supersedes the second and it is the whole design: the transcript goes
     * ON the ticket so a human can route it, and the SLUG is
     * `unclassified_call`, which lands in PCP Support (department 18) where a
     * person already looks. Machine-guessing a department here would be the
     * `'surgery center'` mistake of 2026-09-08 with worse consequences — an
     * `mr_cases` row opened on a guess starts a statutory clock on a request
     * nobody has read.
     *
     * MEASURED 2026-09-15, PCP's first 2h23m on the current build: 32 real
     * conversations that did not transfer, 18 with no ticket of ANY
     * provenance. Every existing exit above turns them away, and the gate
     * below is why: `toldUsSomething` demands a purpose AND an identity
     * field, and the model never recorded a purpose at all.
     *
     * THE ADMISSION IS `saidMoreThanTheirOwnIdentity`, NOT A NEW PREDICATE.
     * `requestSweep.ts` is the queue lanes' teardown filer and CLAUDE.md
     * lists it under "do NOT rebuild these"; that function is deliberately
     * the narrowest possible version — it suppresses a call only when every
     * caller line is exhausted by their own name and a spoken date — and its
     * own docstring already says it "does NOT try to decide what a request
     * is … meaning is the model's job and not a regex's". That is the
     * operator's conclusion, already written down, so it is reused rather
     * than reasoned about again.
     *
     * THE NARROWNESS IS STILL THE POINT. A caller who said nothing beyond
     * "yes" and their date of birth files nothing, exactly as before — which
     * is what keeps this from recreating azul's 2026-07-28 sweep, where 9 of
     * 12 spurious tickets were callbacks for patients already helped.
     */
    const transcript = metadata?.getTranscript?.() ?? '';
    /**
     * EVERY NAME WE HOLD, WHICH ON THIS ARM IS USUALLY NONE — and that is a
     * real weakening of the guard, stated rather than hidden.
     *
     * `saidMoreThanTheirOwnIdentity` subtracts the caller's own name from
     * their lines, so a call that was only an identity interview files
     * nothing. It can only subtract a name we CAPTURED, and a call the model
     * never classified is usually one where it never recorded a name either
     * — so "This is <name>." and a hang-up WILL file on this arm, where on
     * the others it would not.
     *
     * ACCEPTED, and the direction is deliberate. That predicate's own
     * docstring already chose it: *"the failure mode it accepts is filing the
     * occasional identity-only ticket, which is the right direction to err on
     * a path whose whole purpose is not losing requests."* A department-18
     * ticket a staffer discards costs ten seconds; a lost request costs a
     * caller. And the alternative is a name DETECTOR, which is standing
     * instruction 3 in as many words — *"why are you trying to determine what
     * a first name is? You'll never ever get it to work like that."*
     *
     * `callerName` is passed beside the patient's because on the PCP line the
     * two are often the same person and the model may have recorded one
     * without the other.
     */
    const spokeBeyondTheirOwnIdentity = saidMoreThanTheirOwnIdentity(transcript, {
      firstName: state.patientFirstName ?? state.callerName,
      lastName: state.patientLastName,
    });
    const unclassified = !state.callPurpose && spokeBeyondTheirOwnIdentity;
    if (!toldUsSomething && !askedForAPersonAndDidNotGetOne && !unclassified) {
      console.info(`[PCP] SWEEP: ${callId} ended with nothing to file (no purpose or no identity) — no ticket`);
      return;
    }
    if (!metadata) {
      console.warn(`[PCP] SWEEP: ${callId} has intake but no metadata — cannot build a payload`);
      return;
    }

    const { missing } = ticketState(callId);
    const readiness = ticketReadiness(state, MAX_BLOCKS);
    const gaps = annotationFor([...readiness.blocking, ...readiness.annotate]);
    /**
     * Two different calls reach this point and a staffer must be able to tell
     * them apart from the ticket alone. One drifted off mid-intake; the other
     * asked for a person, was refused, and was left holding nothing — which is
     * a worse experience and a more urgent callback.
     */
    const headline = unclassified
      ? 'THIS CALL WAS NOT CLASSIFIED AND NEEDS ROUTING BY HAND. The caller spoke but the agent never established what the call was about, so nothing here has been routed to a department — please read what they said below and send it where it belongs.'
      : askedForAPersonAndDidNotGetOne && !toldUsSomething
      ? 'CALLER ASKED TO SPEAK TO A PERSON AND WAS NOT CONNECTED, and the request was not captured on the call. Filed so it is not lost. They gave no further detail.'
      : 'CALLER HUNG UP BEFORE THE REQUEST WAS COMPLETE. Filed from what was gathered on the call so it is not lost.';
    /**
     * THE CALLER'S OWN WORDS ARE THE ROUTING INSTRUCTION on this arm, so they
     * go in the narrative rather than only in the `transcript` field: the
     * headline says a person has to route this, and a person cannot route it
     * from a line that says we do not know what they wanted. Agent lines are
     * stripped — a staffer needs what the CALLER said, not our questions back
     * at them.
     */
    /**
     * NOT TRIMMED HERE. `annotateGaps` clamps the finished narrative to
     * `NARRATIVE_MAX_CHARS` on its way into the payload — the first attempt at
     * this budgeted the excerpt at THIS call site and still filed nothing,
     * because the annotation is appended afterwards and the call site cannot
     * see the string that is actually validated.
     */
    const theirWords = unclassified
      ? `What the caller said:\n${callerLines(transcript).map((l) => `  - ${l}`).join('\n')}`
      : '';
    const narrative = [
      headline,
      theirWords,
      gaps,
      'Please call back to complete this request.',
    ]
      .filter(Boolean)
      .join('\n\n');

    console.warn(
      `[PCP] SWEEP: ${callId} ended with no disposition — filing what we have` +
        (unclassified ? ' as unclassified_call, for a person to route' : ''),
    );
    /**
     * `unclassified_call` is the ticketing app's slug for exactly this, added
     * in its #270. It resolves to `General / Other` -> `Other - See
     * Description` in department 18 — the same pair `patient_caller` already
     * proves live — and is CREATE_TASK only, because a call we could not
     * classify is certainly not one we can establish asked for a person.
     */
    const sweptState = unclassified
      ? { ...state, callPurpose: 'unclassified_call' as const }
      : state;
    const response = await submitPcpTicket(
      buildPayload(metadata, sweptState, 'CREATE_TASK', narrative, 'high', undefined, unclassified ? 'call_not_classified' : 'caller_hung_up_before_completion', missing),
    );
    if (response.success) {
      pcpDirector.recordDisposition(callId, 'CREATE_TASK');
      console.info(`[PCP] SWEEP: filed ${response.ticketNumber} for the incomplete call`);
    } else {
      console.error(`[PCP] SWEEP: could not file for ${callId}: ${response.error ?? 'unknown'}`);
    }
  } catch (e) {
    console.error('[PCP] SWEEP failed (call already ended):', e);
  } finally {
    pcpDirector.clear(callId);
    endedPcpCalls.delete(callId);
  }
}
