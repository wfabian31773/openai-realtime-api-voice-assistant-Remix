import {
  getPcpCallPurpose,
  type PcpCallPurposeSlug,
  type PcpDisposition,
  type PcpVerificationStatus,
} from './policy';
import { isLunchClosure } from '../utils/timeAware';

export const PCP_FACILITY_TYPES = [
  'pcp_office', 'referring_provider', 'health_plan', 'ipa_medical_group',
  'hospital_medical_facility', 'pharmacy', 'pharmaceutical_representative',
  'other_healthcare_organization',
] as const;
export type PcpFacilityType = (typeof PCP_FACILITY_TYPES)[number];

export interface PcpConversationState {
  callerName?: string;
  callerRole?: string;
  callerOrganization?: string;
  callerFacilityType?: PcpFacilityType;
  callbackNumber?: string;
  /**
   * TRUE while `callbackNumber` is only the inbound caller ID, and nobody has
   * said it is a line that answers.
   *
   * Traced 2026-09-24 from a referral coordinator's own complaint. Her office's
   * calls all filed; on one of them a staffer tried the number on the ticket
   * and resolved it "Processed callback but line is unavailable. Closing the
   * ticket as little to no information provided." The number was her ANI — an
   * out-of-state area code on a Southern California referral office, i.e. a trunk
   * identifier and not a desk. Nobody asked her for a number on any of eight
   * calls (`asked_callback` false on all eight), because the seed above makes
   * the field read ANSWERED and the intake then skips it silently.
   *
   * `record_pcp_intake` clears this the moment the caller states a number, so
   * a stated value is never labelled unverified.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO: add a question. v37 measured 18 of 25
   * PCP calls ENDING on a pre-filing question with 10 leaving NO ticket of any
   * provenance, and the teardown sweep did not catch them — so a new pre-filing
   * ask is the one change here that could cost more requests than it saves.
   * Whether to CONFIRM the number, and before or after the ticket, is an open
   * question for the operator; this flag is what makes either answer
   * measurable and is useful on its own, because the staffer who hit an
   * unreachable number was never told it was unverified.
   */
  callbackFromCallerIdOnly?: boolean;
  /**
   * HOW THIS CALLER WANTS THE ANSWER BACK — the operator's fifth field, and
   * the one that makes his fourth redundant.
   *
   * Operator, 2026-09-16, on the two we used to ask separately: "I think four
   * and five are completely redundant too, right? What's the best number to
   * reach you, and then how would you like us to get back to you?"  They are.
   * `pcpAgent.ts` already seeds `callbackNumber` from caller ID on every call,
   * so asking for it spends a turn on something we are holding. The channel is
   * the only part we do not know.
   *
   * And on which channel: "a lot of these people are calling from offices. So
   * that's why I wouldn't use SMS as a way to confirm that the ticket has been
   * logged. I would probably use email. I would try to get the email for
   * everyone that's on there, because if they're professionals, they have to
   * have an email."
   *
   * TWO FIELDS, ONE QUESTION. `callerEmail` is what the question funnels
   * toward, because it is what we want and RULE ZERO 2c says shape the
   * question so the answer arrives in the field's format.
   * `deliveryPreference` catches the caller who answers it with something
   * else — "fax is better", "just call the front desk" — and SATISFIES the
   * same slot, so answering the question a different way is still answering
   * it. Without that, a caller who says "no email, fax us" would be asked for
   * an email again.
   */
  callerEmail?: string;
  deliveryPreference?: string;
  statedRelationship?: string;
  callPurpose?: PcpCallPurposeSlug;
  patientFirstName?: string;
  patientLastName?: string;
  patientDob?: string;
  patientMrn?: string;
  verificationStatus: PcpVerificationStatus;
  toolFailures: Record<string, number>;
  completedTools: string[];
  /**
   * HOW MANY TIMES WE HAVE PUT EACH FIELD TO THE CALLER — see
   * MAX_ASKS_PER_FIELD. Written only by `noteAsked`, which only the intake
   * tool calls, because that is the one place a question is actually spoken.
   */
  askCounts?: Partial<Record<keyof PcpConversationState, number>>;
  dispositionRecorded?: PcpDisposition;
  handoffStatus?: 'HANDOFF_UNAVAILABLE' | 'NO_ANSWER' | 'FAILED' | 'CONNECTED';
  handoffFailureReason?: string;
  /**
   * The caller asked, in words, for a person. Operator directive 2026-08-09:
   * on this line that reaches the office queue during business hours, whatever
   * the call is about and whatever intake is still missing — the staffer who
   * picks up collects what they need. Interviewing a surgery-center nurse
   * before connecting her is the behavior being removed.
   */
  callerRequestedHuman?: boolean;
  /**
   * THE CALLER WAS WARNED AND CHOSE THE QUEUE, so no ticket is coming.
   *
   * Operator ruling, 2026-09-13: *"We Will Not create tickets for anyone that
   * chooses to be transferred. if they drop off, their record is lost. Their
   * choice."*
   *
   * This exists for ONE reader — `sweepPcpUnfiledCall`. On the blind path the
   * redirect ends the media stream, so teardown begins while `handoff_to_pcp`
   * is still awaiting its dial. The sweep's own early exits do not cover this
   * caller: no disposition was recorded (that is the point), and
   * `handoffStatus` is not yet `CONNECTED` (it never will be — a queue is not
   * a person). Without this flag the sweep would file "CALLER HUNG UP BEFORE
   * THE REQUEST WAS COMPLETE" for exactly the caller we promised not to file
   * for, and the promise would be broken by the safety net rather than by the
   * rule.
   *
   * Set BEFORE the dial, not after, because the race is with the dial itself.
   * Cleared again if the dial fails, which re-arms the sweep — a caller whose
   * transfer never happened is owed the ticket after all.
   */
  callerChoseTheQueue?: boolean;
  /**
   * THE CALLER IS THE PATIENT, and it stays true once established.
   *
   * `callPurpose` is not safe to read for this. The records tool reclassifies
   * it to `patient_medical_records_request` the moment it runs, so a patient
   * asking for their OWN records stops looking like a patient at exactly the
   * point the ticket requirements check whether we know who the call is about
   * — and they get asked separately for "the patient's name". Set ONLY by
   * the model's explicit signal — `patient_caller` covers "a patient or their
   * family", and a family member is not the patient. It survives a purpose
   * change because nothing else writes it; the model may still correct it.
   */
  callerIsThePatient?: boolean;
  /**
   * WHERE THE RECORDS GO, and how. Operator, 2026-09-08, after his own test
   * call took a records request without ever asking:
   *
   *   "if you want medical records, how would you like to receive them by
   *    fax? What's the fax number? By email. What's your email? ... gathering
   *    the information as we go, sort of filling out a form."
   *
   * The callback number does NOT answer this. It is seeded from caller ID
   * because a clinic's switchboard is the one contact detail we never have to
   * ask for — but it is not somewhere you send a medical record.
   */
  recordsDeliveryMethod?: PcpRecordsDeliveryMethod;
  recordsDeliveryDestination?: string;
}

export interface PcpDirectorDecision {
  nextQuestion?: { field: keyof PcpConversationState; prompt: string };
  /** Fields still unset that we have stopped asking for — see MAX_ASKS_PER_FIELD. */
  askBudgetSpent?: string[];
  disposition?: PcpDisposition;
  phiDisclosureAllowed: boolean;
  authoritativeToolAllowed: boolean;
  handoffEligible: boolean;
  mustCreateFallbackTicket: boolean;
  mayTerminate: boolean;
}

/**
 * WHY `callPurpose` IS FIRST, and what it cost to have it last.
 *
 * It used to be sixth of six here and third of three in PATIENT_INTAKE_ORDER —
 * the LAST thing collected. It is also the field that FOUR tools refuse to run
 * without: handoff_to_pcp, create_pcp_task, lookup_patient_appointments and
 * record_automated_resolution. So the agent had to complete a six-question
 * interview before it was permitted to do anything at all, and until it did,
 * every tool it reached for came back `call_purpose_required`.
 *
 * Measured over the ten days to 2026-08-16: handoff_to_pcp was called 240
 * times and refused 211 of them — 88%. On 08-07 alone, 207 attempts, 199
 * refused, 180 of those on the missing purpose. The day before, with lighter
 * traffic through the same code, it was 23 attempts and 2 refusals. That
 * Friday is the one the operator described as "the disasters I was seeing",
 * and the line came off the following morning.
 *
 * There is a second cost, and it is the one a caller feels. `next()` decides
 * whether it is speaking to a PATIENT by `callPurpose === 'patient_caller'`.
 * With the purpose collected last, the director could not know a patient was a
 * patient until AFTER it had asked them their role, their organisation and
 * their facility type. The final call this line ever took (bd89b226, 08-14)
 * was a woman asking how long she could go without her serum drops; she was
 * asked "What is your role at Optum Clinic?"
 *
 * The greeting already asks "How can I help you today?" and callers already
 * answer it — every transcript reviewed states the purpose in the opening
 * sentence. Asking for it first costs nothing and unblocks everything.
 */
/**
 * How a requester can receive records. Fax and email are the operator's own
 * two; mail is the obvious third and is flagged for his confirmation rather
 * than assumed silently. Nothing here decides POLICY about who may receive
 * what — it only records what the caller asked for, for the staffer who
 * fulfils it.
 */
export const PCP_RECORDS_DELIVERY_METHODS = ['fax', 'email', 'mail', 'unspecified'] as const;
export type PcpRecordsDeliveryMethod = (typeof PCP_RECORDS_DELIVERY_METHODS)[number];

/**
 * Asked ONLY on a records request, and appended to the same `required` list
 * every other field goes through — so they come out one at a time, in order,
 * like the rest of the form.
 */
export const RECORDS_FIELDS: Array<keyof PcpConversationState> = [
  'recordsDeliveryMethod', 'recordsDeliveryDestination',
];

/**
 * A QUESTION THE CALLER HAS NOT ANSWERED TWICE IS NOT ASKED A THIRD TIME.
 *
 * Operator, 2026-09-16, naming this as one of his three priorities for the
 * line: *"being able to quickly identify when we have an issue on the line
 * like that, one that asks somebody something seven times or something like
 * that, like that shouldn't be possible, right?"*
 *
 * SEVEN IS THE MEASURED NUMBER, NOT A FIGURE OF SPEECH.
 * `CA908f93dae322ed0e0dd862673ebf77fb`, 2026-09-15, 150 seconds, no ticket of
 * any provenance:
 *
 *   CALLER: Representative?
 *   AGENT:  What is the patient's first name?
 *     ... seven times, then the caller was gone
 *
 * NOTHING EXISTING COULD STOP IT, and that is the point of putting the bound
 * here rather than anywhere else:
 *
 *  - `toolCeiling`'s `identicalFailures` (3) and `perToolFailures` (6) count
 *    FAILURES. Every one of those `record_pcp_intake` calls SUCCEEDED — the
 *    model kept re-recording `statedRelationship` from the same word — so a
 *    success cleared the counters by design. `tool_call_count` reached 15,
 *    nowhere near `perCallDispatches` (40).
 *  - `ticketRequirements.MAX_BLOCKS` (3) bounds how many times a FILING may be
 *    HELD. No filing tool was ever called on that call, so that budget was
 *    never touched. It is a different question and stays untouched here.
 *
 * What was missing was a bound on the INTAKE FORM repeating itself, and that
 * is this. Two is a judgement, not a measurement: once to ask, once in case
 * the first answer was mis-heard. It is deliberately not 1 — a genuine ASR
 * drop on the first pass is common on this line and a second ask recovers it.
 *
 * WHAT IT DOES NOT DO. An exhausted field is skipped as a QUESTION; it is not
 * invented, and it does not become "answered". It rides onto the ticket as
 * NOT CAPTURED through the annotation path that already exists, which is the
 * #288 unassigned-exit shape the operator has already approved elsewhere: a
 * request that files short beats a request that never files.
 */
export const MAX_ASKS_PER_FIELD = 2;

/**
 * A FIELD MAY BE WORTH LESS THAN A SECOND ASK. Operator, 2026-09-16, on the
 * email question: "cut the email question to one ask."
 *
 * `MAX_ASKS_PER_FIELD` is two because a genuine ASR drop on the first pass is
 * common on this line and a second ask recovers it. That reasoning is about
 * the ANSWER being mis-heard. It does not hold for a field whose usual reply
 * is not a mis-hearing at all: an email address is spelled out letter by
 * letter, so a second ask is a second spelling, and the callers who have no
 * email to give ("I don't have access to email" — CA782b4da236a6cc80a485c50e55f4b2a1,
 * 2026-09-16) do not have one the second time either.
 *
 * ONE TABLE, THREE READERS. `noteAsked` and both filters in `next()` compare
 * against this, so a per-field budget cannot be enforced in one place and not
 * the other — which is how the two noun lists in `explicitAsk.ts` drifted.
 */
export const ASKS_FOR_FIELD: Partial<Record<keyof PcpConversationState, number>> = {
  callerEmail: 1,
};

export function askBudgetFor(field: keyof PcpConversationState): number {
  return ASKS_FOR_FIELD[field] ?? MAX_ASKS_PER_FIELD;
}

/**
 * THIS LINE IS AN ANSWERING SERVICE, NOT A FORM. Operator, 2026-09-16:
 *
 *   "ensure that the PCP line acts as a literal answering service. Meaning
 *    that it gathers the required fields, who is calling, what are you calling
 *    about, where are you calling from, who is this in regards to, and how
 *    would you like to receive the information. I think that is the crux of
 *    any request."
 *
 * MEASURED FIRST, over all 369 substantive PCP calls of 2026-09-14/15.
 *
 * **The order was inverted and the attrition proves it.** Where the call died,
 * by the last question the agent asked:
 *
 *   caller role      26 calls, 6 filed      organisation   11 calls, 2 filed
 *   caller name      23 calls, 2 filed      facility type   9 calls, 6 filed
 *   date of birth    20 calls, 1 filed      relationship    3 calls, 0 filed
 *   THE PATIENT       5 calls, 0 filed
 *
 * **97 calls died inside the caller-credential block and 17 filed — 17.5%.**
 * Almost nobody died on the patient questions because almost nobody survived
 * long enough to be asked one. We collected five facts about the CALLER before
 * asking who the call was ABOUT, so attrition ate the one field a staffer
 * cannot work without.
 *
 * **And these callers speak in fragments.** Median first utterance under five
 * words; 53% say three words or fewer. "Referrals." "Appointment."
 * "Representative?" Average 3.8 caller lines for a 138-second call. Every
 * question spent on a credential is a question not spent on the request.
 *
 * CAd00fa911 (1,148 seconds, no ticket) is the whole argument:
 *
 *   CALLER: Get, um, diagnosis codes and CPT codes.   <- the purpose, unasked
 *   AGENT:  May I have your full name?
 *   CALLER: Karina from Optum Medical Clinics.        <- name AND organisation
 *   AGENT:  What is your role?                        <- she just said
 *   CALLER: Medical receptionist.
 *   AGENT:  Is that a doctor's office or provider, a health plan...
 *   CALLER: Doctor office.
 *   AGENT:  And how are you involved in this patient's care?
 *   CALLER: Speak to representative.                  <- she quits
 *
 * She gave purpose, name, organisation and role. We asked four more questions
 * and never once asked which patient.
 *
 * WHAT IS NO LONGER ASKED, and why each one goes:
 *
 * - `callerRole` — the single biggest killer, 26 dead calls for 6 tickets.
 *   Callers volunteer it inside the name answer ("Karina from Optum Medical
 *   Clinics", "Jackie Pena, MA from Valentine Medical Clinic"). Extraction is
 *   the model's job, not a question's — standing instruction 3.
 * - `callerFacilityType` — an eight-value enum read aloud to somebody who has
 *   already named their organisation. The records route reads it FIRST but
 *   falls back to prose (`statedRelationship`, role, organisation) by design,
 *   so dropping the QUESTION does not drop the route.
 * - `statedRelationship` — drew the same answer as role, which this file has
 *   recorded twice.
 * - `patientDob` — 20 dead calls for 1 ticket. On a professional line the
 *   caller is reading a chart and gives an ID or nothing.
 *
 * NONE OF THEM IS DELETED FROM THE STATE. Each is still recorded when the
 * caller volunteers it, still travels on the ticket, and still feeds the
 * records route. What changes is that we stop SPENDING A TURN on it.
 */
export const PROFESSIONAL_FIELDS: Array<keyof PcpConversationState> = [
  'callPurpose', 'callerName', 'callerOrganization',
];
/**
 * THE SAME INTERVIEW, ASKED AFTER WE KNOW WHO THE CALL IS ABOUT — and the
 * split is the whole correction the operator made on 2026-09-16.
 *
 *   "I think that that was pretty hasteful of you to just go by and create the
 *    interview like that. Because we know who's calling... the medical
 *    assistants, referral coordinators, things of that nature. We have to
 *    tailor this around them... obviously, who's calling, what's your title,
 *    what organization are you calling from, who is this request in regards
 *    to, and then how would you like to receive this information."
 *
 * HE IS RIGHT AND MY FIRST ANSWER WAS WRONG. The measurement behind the
 * previous version (2026-09-14/15: `callerRole` last-asked on 26 calls for 6
 * tickets, the single biggest killer) says what KILLS a call. It does not say
 * what a staffer NEEDS, and I deleted a field on the first reading alone.
 *
 * What the measurement actually indicts is the POSITION, not the field. Role
 * was question two, so a caller who quit on it took the whole request with
 * them. Asked here — after purpose, name, organisation and the patient are
 * already in hand — the same hang-up costs a job title on a ticket that files
 * anyway. Nothing is gated on these; they are the part of the interview we
 * can afford to lose.
 *
 * NOT ASKED OF A CALLER HEADED FOR A PERSON. See `next()`: a purpose that
 * allows HAND_OFF skips this block entirely, so the dial is never waiting on
 * somebody's email address, and `handoffEligible`'s intake arm reads exactly
 * the value it read before.
 *
 * `callbackNumber` sits here rather than in the block above because
 * `pcpAgent.ts` seeds it from caller ID at the top of every call: in the
 * normal case it is already answered and this list skips it silently. A
 * withheld or blocked caller ID is the case where it is genuinely unknown,
 * and then it is asked — last, where a hang-up is cheapest — with the filing
 * gate's own three-strike budget still behind it as the backstop.
 */
export const PROFESSIONAL_ENRICHMENT: Array<keyof PcpConversationState> = [
  'callerRole', 'callerEmail', 'callbackNumber',
];
/**
 * ASKED AFTER THE TICKET EXISTS, NOT BEFORE IT.
 *
 * v35 put the enrichment block last on the reasoning that "by the time they
 * are asked, purpose, name, organisation and the patient are already in hand
 * and the request files whether or not the caller stays". THE SECOND HALF OF
 * THAT WAS NOT TRUE, and 2026-09-16 is the measurement that says so: of 25
 * substantive PCP calls asked for an email, 18 ENDED on that question and
 * **10 left no ticket of any provenance** — checked against `tickets` by
 * call SID, not inferred from `call_logs`. Three of the ten had spelled a
 * complete address out loud first.
 *
 * The request files when the model runs out of questions, so a question
 * standing in front of the filing is a gate whatever the filing tool is
 * willing to accept. `FILING_MAY_BE_HELD = false` opened the gate on the
 * TOOL; this opens it on the INTERVIEW, which is where these ten died.
 *
 * WHAT MAKES IT SAFE TO ASK AFTERWARDS: ticketing-app #275 makes a second
 * POST on the same `callSid` ENRICH the row rather than answer `cached` and
 * discard it, and `pcpCallerRole` / `pcpCallerEmail` are both in that
 * enrichment set (`lib/pcp/pcp-ticket.ts`). So a title or an email collected
 * after the ticket exists still lands on it.
 *
 * `callbackNumber` IS DELIBERATELY NOT IN THIS LIST. The prompt's own rule is
 * "THE NUMBER COMES BEFORE THE TICKET, ALWAYS" (standing instruction 12):
 * confirming a callback number after filing is not confirming it. It is
 * seeded from caller ID on every call with an E.164 ANI, so in the normal
 * case it is already answered and nobody is asked anything.
 *
 * WHAT IT COSTS: a caller who hangs up immediately after the ticket files is
 * never asked their title or their email, where today they are asked and the
 * request is lost. A job title is the cheaper thing to lose.
 */
export const ENRICHMENT_AFTER_FILING: Array<keyof PcpConversationState> = [
  'callerRole', 'callerEmail',
];
/**
 * ONE SLOT, TWO PLACES THE ANSWER CAN LAND.
 *
 * The question funnels toward an email because that is the channel the
 * operator wants on a professional line. A caller who answers it with a
 * different channel has still answered it, and asking again would be the
 * `statedRelationship` mistake — putting the same question twice because the
 * reply went into a field we were not looking at.
 *
 * `recordsDeliveryMethod` IS THAT MISTAKE, CAUGHT BY ITS OWN TEST. A records
 * request is already asked "How would you like to receive the records — by
 * fax, by email, or by mail?", which is the operator's fifth question in
 * almost his own words. Without this entry the first draft asked it and then
 * asked for an email address as well, on the one purpose that had already
 * answered. `recordsDeliveryIntake.test.ts` went red rather than me noticing.
 */
export const SATISFIED_BY: Partial<Record<keyof PcpConversationState, Array<keyof PcpConversationState>>> = {
  callerEmail: ['deliveryPreference', 'recordsDeliveryMethod'],
};
/**
 * Who the call is ABOUT — and nothing else. `patientDob` and
 * `statedRelationship` were here and are not asked any more; see above.
 *
 * `patientLastName` stays a separate field so that a caller who answers the
 * one question with a full name fills BOTH and is never asked again, while a
 * caller who gives only a first name is still asked for the rest. The question
 * invites the whole name; the field list catches the half-answer.
 */
export const PATIENT_FIELDS: Array<keyof PcpConversationState> = ['patientFirstName', 'patientLastName'];
/**
 * What the director asks a PATIENT for, in order — and what `next()` itself
 * uses, so the two cannot disagree.
 *
 * Exported so the PROMPT can render the same list. Until 2026-08-14 the prompt
 * told the model "ask the single next question record_pcp_intake gives you"
 * and never showed it the order — so the model invented one, the director
 * corrected it a turn later, and the caller heard both. The operator, on a
 * live call: "the sequencing is off... this is just all over the place."
 *
 * `next()` used to carry its own inline copy of this list. Two literals for
 * one order is the drift this file already warns about elsewhere; there is now
 * one.
 */
export const PATIENT_INTAKE_ORDER: Array<keyof PcpConversationState> = ['callPurpose', 'callerName', 'callbackNumber'];
/**
 * RULE ZERO 2b/2c — THE FORMAT GOES IN THE QUESTION.
 *
 *   "Everything else that we need, we create a funnel towards — in the
 *    questioning — towards that answer in the way that we need it."
 *
 * Three of these were rewritten on 2026-09-15 against the PCP line's first
 * full day. None of them removes a question or changes which fields are
 * required — that is the interrogation, a POLICY matter and the operator's
 * under standing instruction 1. Only the wording moved.
 *
 * `callerFacilityType` is an EIGHT-VALUE ENUM (`PCP_FACILITY_TYPES`) and was
 * asked as an open question, so callers could not tell it was a multiple
 * choice. At least six answered with the ORGANISATION NAME AGAIN on 2026-09-14
 * — Regal Medical Group four times, Children's Surgery Centers, Optum. It now
 * names the common options; the list is deliberately short of all eight
 * because a spoken question that recites eight categories is not a question
 * anybody answers, and `other_healthcare_organization` is the catch-all the
 * classifier already has.
 *
 * `patientDob` was the one lane asking bare. CLAUDE.md's compliance table
 * records Rule 2b as satisfied on "all four lanes — opticalAgent.ts:193,
 * surgeryAgent.ts:203, techAgent.ts:189, recordsAgent.ts:192, plus no-ivr and
 * answering-service", and PCP is simply absent from that list. Month, then
 * day, then year is what makes the answer arrive parseable; `dobParts.ts`
 * records what the alternative costs.
 *
 * `statedRelationship` followed `callerRole` closely enough to read as a
 * rephrase of it, and CLAUDE.md already records the pair drawing the same
 * answer twice. It now asks plainly about the caller's connection to the
 * patient rather than about their role a second time.
 */
export const PROMPTS: Partial<Record<keyof PcpConversationState, string>> = {
  /**
   * INVITES THE ORGANISATION TOO, because that is how a professional answers
   * it anyway — measured, 2026-09-14/15: "Karina from Optum Medical Clinics",
   * "Jackie Pena, MA from Valentine Medical Clinic", "Calling from Doctor
   * [X]'s office". The old wording asked for a name, got a name AND an
   * organisation, and then asked for the organisation.
   *
   * THIS IS NOT BUNDLING TWO FIELDS IN ONE BREATH (RULE ZERO 2b). The rule is
   * about two facts a caller answers separately — name and date of birth. Who
   * you are and where you are calling from is one self-introduction, and the
   * measurement says they already give it as one. `callerOrganization` stays a
   * SEPARATE FIELD so the half-answer is still caught: give both and the
   * organisation is filled and never asked; give only a name and the next
   * question asks for the organisation, exactly as before.
   */
  callerName: 'And who am I speaking with, and where are you calling from?',
  /**
   * "TITLE", NOT "ROLE", AND IT IS THE OPERATOR'S WORD — 2026-09-16: "who's
   * calling, what's your title, what organization are you calling from".
   *
   * It also stops the collision this file already records twice. "What is your
   * role?" and "What is your professional relationship to this patient?" drew
   * the same answer from the same callers, because "role" is ambiguous between
   * a job and a connection to the patient. A title is unambiguously the job.
   *
   * "there" is doing work: this is now asked AFTER the organisation, so the
   * question is anchored to a place the caller has already named rather than
   * floating free.
   */
  callerRole: 'And what is your title there?',
  /**
   * THE FIFTH FIELD, FUNNELLED AT AN EMAIL ADDRESS (RULE ZERO 2c).
   *
   * "How would you like to receive this information?" is the operator's
   * phrasing of the INTENT, and asked literally it is an open question that
   * returns prose — the `callerFacilityType` mistake, where an eight-value
   * enum was asked openly and six callers answered with their organisation
   * name again. Naming the channel we want in the question is what makes the
   * answer arrive as the thing the field holds.
   *
   * A caller who wants it another way says so, and `SATISFIED_BY` means that
   * answer counts. It does not trap anybody into an email they do not have.
   */
  callerEmail: 'And what is the best email address to send this to?',
  callerOrganization: 'Which organization are you calling from?',
  callerFacilityType:
    "Is that a doctor's office or provider, a health plan, a medical group, a hospital, or something else?",
  callbackNumber: 'What is the best callback number?',
  callPurpose: 'What are you calling about today?',
  statedRelationship: 'And how are you involved in this patient\'s care?',
  /**
   * THE OPERATOR'S FOURTH FIELD — "who is this in regards to" — and it has
   * moved from sixth of ten to third of four.
   *
   * Over 2026-09-14/15 only 5 calls died on a patient question, and that is
   * not because the question is easy: it is because 97 calls had already died
   * on the caller-credential questions in front of it. This is the one field a
   * staffer genuinely cannot work without, and it was behind everything that
   * was optional.
   *
   * Worded to invite the whole name. `patientLastName` remains its own field,
   * so a caller who answers with a full name fills both and is never asked
   * again, and a caller who gives one word is still asked for the rest.
   */
  patientFirstName: 'And who is this in regards to — the patient\'s name?',
  patientLastName: "What is the patient's last name?",
  // The question mark is the turn boundary this line runs on (pcpAgent.ts:190),
  // and this was the only ask written as a statement. The wording is now the
  // four queue lanes' own, pointed at the patient: opticalAgent.ts:193,
  // surgeryAgent.ts:203, techAgent.ts:189, recordsAgent.ts:192. (Codex P2, #303.)
  patientDob:
    "And may I please have the patient's date of birth, starting with the month, then the day, then the year?",
  recordsDeliveryMethod: 'How would you like to receive the records — by fax, by email, or by mail?',
  // Replaced at ask-time by DESTINATION_PROMPTS once the method is known. A
  // generic "what is the destination?" is the thing this change exists to
  // stop: the question should be the one a person would actually ask.
  recordsDeliveryDestination: 'Where should we send the records?',
};

/** The destination question, in the words of the method the caller chose. */
export const DESTINATION_PROMPTS: Record<PcpRecordsDeliveryMethod, string> = {
  fax: 'What is the fax number?',
  email: 'What is the email address?',
  mail: 'What is the mailing address?',
  // 'unspecified' is the caller declining or not knowing. It is an ANSWER,
  // which is the point: it ends the question instead of leaving a field the
  // director would name forever. Nothing is asked after it.
  unspecified: '',
};

/** A method that names no destination — the recorded form of "they didn't say". */
export function deliveryDestinationNeeded(state: PcpConversationState): boolean {
  return Boolean(state.recordsDeliveryMethod) && state.recordsDeliveryMethod !== 'unspecified';
}

export class PcpDirector {
  private states = new Map<string, PcpConversationState>();

  constructor(private readonly options: { pharmaHandoffEnabled?: boolean; /** Injected by tests; production reads the Pacific clock. */ lunchClosure?: () => boolean } = {}) {}

  get(callId: string): PcpConversationState {
    let state = this.states.get(callId);
    if (!state) {
      state = { verificationStatus: 'pending', toolFailures: {}, completedTools: [] };
      this.states.set(callId, state);
    }
    return state;
  }

  update(callId: string, patch: Partial<Omit<PcpConversationState, 'toolFailures'>>): PcpConversationState {
    const state = this.get(callId);
    /**
     * A PLAIN ASSIGN, DELIBERATELY — and `callerIsThePatient` is the reason
     * this comment exists.
     *
     * An ABSENT key leaves the flag alone, which is all the stickiness that
     * was ever needed: the records tool patches only `callPurpose`, so the
     * flag survives the reclassification that started all of this.
     *
     * An explicit `false` DOES clear it, and that is on purpose. I first made
     * it refuse one, on the theory that a latch should never un-latch — but
     * the tool schema actively tells the model to send false for a family
     * member, so refusing the correction would make one early mis-classification
     * unrecoverable for the rest of the call and name the caller as the patient
     * on the ticket.
     *
     * IT NEVER COMES FROM THE PURPOSE. `patient_caller` covers "a patient OR
     * THEIR FAMILY", so setting it from that slug would tell the ticket that a
     * daughter calling about her mother IS the patient, and the mother's name
     * would never be asked for. Only the model's explicit signal writes it —
     * it is the one that knows which of the two is on the phone.
     */
    Object.assign(state, patch);
    return state;
  }

  recordToolFailure(callId: string, tool: string): void {
    const state = this.get(callId);
    state.toolFailures[tool] = (state.toolFailures[tool] ?? 0) + 1;
  }

  recordToolSuccess(callId: string, tool: string): void {
    const state = this.get(callId);
    if (!state.completedTools.includes(tool)) state.completedTools.push(tool);
  }

  recordDisposition(callId: string, disposition: PcpDisposition): void {
    this.get(callId).dispositionRecorded = disposition;
  }

  recordHandoffResult(callId: string, result: { status: PcpConversationState['handoffStatus']; reason?: string }): void {
    const state = this.get(callId);
    state.handoffStatus = result.status;
    state.handoffFailureReason = result.reason;
  }

  /**
   * Forget a destination gathered for a method the caller has since changed.
   * `update` merges, so without this "actually, email it" keeps the fax number
   * and the ticket reads "Deliver by EMAIL to <fax number>".
   */
  clearRecordsDestination(callId: string): void {
    const state = this.get(callId);
    state.recordsDeliveryDestination = undefined;
    /**
     * AND FORGET HOW MANY TIMES WE ASKED, because it is a DIFFERENT QUESTION
     * NOW. Codex P2, #315.
     *
     * `DESTINATION_PROMPTS` is per method: "What is the fax number?", "What is
     * the email address?", "What is the mailing address?". A caller who gives
     * a fax number and then says "actually, email it" is being asked something
     * they have never been asked before, so a LIFETIME count on the field name
     * is the wrong key — two asks spent on the fax number would leave the
     * email address with none, and the case files with nowhere to send it.
     * That is the 2026-08-13 hard gate's own failure arriving through a third
     * door (see the v16 marker row).
     *
     * Resetting here rather than scoping the counter by method keeps ONE
     * counter shape for every field: this function already exists to forget a
     * destination gathered for a method the caller changed, and forgetting the
     * asks that gathered it is the same act.
     */
    if (state.askCounts?.recordsDeliveryDestination !== undefined) {
      state.askCounts = { ...state.askCounts, recordsDeliveryDestination: 0 };
    }
  }

  /** Record that the caller explicitly asked to speak to a person. */
  markCallerRequestedHuman(callId: string): void {
    this.get(callId).callerRequestedHuman = true;
  }

  /**
   * Record — or withdraw — the caller's choice of the live queue over a ticket.
   *
   * Takes an explicit value rather than latching, because this one has to be
   * reversible: it is set before the dial and withdrawn if the dial fails.
   */
  setCallerChoseTheQueue(callId: string, chose: boolean): void {
    this.get(callId).callerChoseTheQueue = chose;
  }

  clear(callId: string): void {
    this.states.delete(callId);
  }

  /**
   * RECORD THAT WE PUT A FIELD TO THE CALLER. Counts toward MAX_ASKS_PER_FIELD.
   *
   * SEPARATE FROM `next()` ON PURPOSE. `next()` is read five times per call by
   * callers that want `handoffEligible`, `disposition` or `mayTerminate` and
   * are not asking anybody anything (`pcpAgent.ts` 785, 842, 1154, 1852).
   * Counting inside `next()` would charge the budget for those reads and burn
   * a caller's two asks without a word being spoken. Only the intake tool —
   * the one place a question is handed back to the model to say out loud —
   * calls this.
   */
  /**
   * RETURNS whether this field is now SPENT — and that return value is the
   * whole point. Codex P2, #315.
   *
   * `next()` computes `askBudgetSpent` from the counts as they stand, and the
   * caller charges the ask AFTERWARDS. So on the turn that hands out the LAST
   * permitted ask, the decision already returned says the field is not yet
   * spent, and the field only appears in `askBudgetSpent` on the NEXT
   * invocation. A caller who hangs up after that final unanswered prompt
   * produces no next invocation — so the SQL signal missed exactly the calls
   * that end at the cap, which are the ones worth counting. That is the tool
   * ceiling's uncountability reappearing in the instrument written not to
   * repeat it.
   *
   * Reporting it from HERE rather than recomputing the whole list is
   * deliberate: charging one ask can only ever exhaust the one field being
   * charged, so this cannot drift from `next()`'s own view of what is
   * required — there is no second copy of that list.
   */
  noteAsked(callId: string, field: keyof PcpConversationState): boolean {
    const state = this.get(callId);
    const counts = state.askCounts ?? {};
    const charged = (counts[field] ?? 0) + 1;
    state.askCounts = { ...counts, [field]: charged };
    return charged >= askBudgetFor(field);
  }

  /**
   * THE NEXT QUESTION, AND THE RECORD THAT WE ASKED IT — in one call.
   *
   * `next()` stays pure and public because four call sites read it for
   * `handoffEligible`, `disposition` or `mayTerminate` without speaking to
   * anybody (`pcpAgent.ts` 785, 842, 1154, 1852). Those must not charge a
   * caller's asks.
   *
   * But the ONE caller that does speak has to do three things in the right
   * order — decide, charge, then re-report the exhaustion the charge just
   * caused — and getting that order wrong is silent: the field that hit the
   * cap simply does not appear in `askBudgetSpent`, and a caller who hangs up
   * on that final prompt never produces the next invocation that would have
   * shown it. Codex P2 (#315) found exactly that, and a test helper written
   * to mirror the call site reproduced the bug rather than catching it.
   *
   * So the sequence lives here, once, and `record_pcp_intake` calls this
   * instead of orchestrating it.
   */
  askNext(callId: string): PcpDirectorDecision {
    const decision = this.next(callId);
    if (!decision.nextQuestion) return decision;

    const field = decision.nextQuestion.field;
    const nowSpent = this.noteAsked(callId, field);
    if (!nowSpent) return decision;

    // The question we just charged STILL GOES TO THE CALLER — only the
    // reporting changes. Suppressing it here would spend the ask without
    // asking.
    const already = decision.askBudgetSpent ?? [];
    const name = String(field);
    return already.includes(name)
      ? decision
      : { ...decision, askBudgetSpent: [...already, name] };
  }

  next(callId: string): PcpDirectorDecision {
    const state = this.get(callId);
    const purpose = state.callPurpose ? getPcpCallPurpose(state.callPurpose) : undefined;

    // A PATIENT IS NOT ASKED FOR A ROLE, AN ORGANISATION OR A FACILITY TYPE.
    //
    // PROFESSIONAL_FIELDS is the right intake for a clinic calling about a
    // mutual patient and absurd for the patient themselves: "What type of
    // healthcare organization is that?" is not a question a person ringing
    // about their own eye drops can answer, and the transcripts show those
    // calls dying in the intake.
    //
    // What a callback actually needs from a patient is a name, a number and
    // what they want. That is the whole list.
    /**
     * One list, from PATIENT_INTAKE_ORDER.
     *
     * READ THE LATCH, NOT JUST THE PURPOSE. `handle_patient_medical_records_request`
     * reclassifies callPurpose to `patient_medical_records_request`, so a
     * purpose-only test flips a patient back to the PROFESSIONAL list mid-call
     * — and they get asked their role, their organisation, their facility type
     * and "the patient's first name" about themselves. That is the bd89b226
     * interrogation, arriving by a different door.
     *
     * It also matters for `askedForAPerson` below: with isPatient wrongly
     * false, a patient who asked for a person becomes handoff-eligible into
     * the PCP clinic queue, which policy.ts exists to prevent.
     *
     * Found on the SECOND review pass, 2026-08-17 — the first fix added the
     * latch and then only read it in one of the three places that needed it.
     */
    const isPatient = state.callPurpose === 'patient_caller' || Boolean(state.callerIsThePatient);
    const required: Array<keyof PcpConversationState> = isPatient
      ? [...PATIENT_INTAKE_ORDER]
      : [...PROFESSIONAL_FIELDS];

    // Purposes whose destination is a live human do not gate the transfer on patient
    // context: minimum professional identity is enough to connect. Details may be
    // collected for the record, but must not delay the connection — peer-to-peer
    // because it is time-sensitive, scheduling because this line cannot schedule at
    // all and the staffer taking the call collects what they need anyway. Blocking on
    // a DOB the caller may not have to hand is how a scheduling request silently
    // became a task instead of a transfer.
    //
    // READ `allowedDispositions`, NOT THE DEFAULT — and the difference is the
    // whole reason the intake did not lengthen when scheduling stopped
    // defaulting to HAND_OFF (2026-09-14).
    //
    // This asked `defaultDisposition === 'HAND_OFF'`, which welded the LENGTH
    // OF THE INTAKE to WHETHER WE DIAL FIRST. Those are two different
    // questions: a purpose that may end at a human must not open with "what is
    // the patient's date of birth" whether or not we dial on this particular
    // call. Left as it was, flipping the three scheduling slugs to CREATE_TASK
    // would have pushed PATIENT_FIELDS back onto a scheduling caller — the
    // four-question block whose first line is "What is your professional
    // relationship to this patient?" — which is the bd89b226 interrogation and
    // the 2026-08-06 precedent that blocking fields destroy requests.
    //
    // PROVABLY INERT ON THE DAY IT WAS WRITTEN, and `policy.test.ts` asserts
    // it: no purpose differs between the two readings in a way that reaches
    // this line. The only purposes where they disagree at all are
    // `pharmaceutical_representative` and the three scheduling slugs, and the
    // clause below is guarded by `patientContextRequired`, which pharma does
    // not set. So this is a decoupling, not a behaviour change — the behaviour
    // change is in policy.ts and is stated there.
    const connectsToHuman = Boolean(purpose?.allowedDispositions.includes('HAND_OFF'));
    /**
     * AND NOT TO A PATIENT, EITHER.
     *
     * PATIENT_FIELDS is `statedRelationship, patientFirstName, patientLastName,
     * patientDob` — the block a PROFESSIONAL supplies about someone else. Asked
     * of the patient themselves it opens with "What is your professional
     * relationship to this patient?", which is the bd89b226 interrogation
     * verbatim.
     *
     * The first two attempts at this fixed the BASE list and left this line
     * alone, so a latched patient whose purpose had been reclassified still
     * walked straight into it. Caught on the third review pass by running the
     * director rather than reading it, 2026-08-17.
     */
    if (!isPatient && purpose?.patientContextRequired && !connectsToHuman) required.push(...PATIENT_FIELDS);
    /**
     * A RECORDS REQUEST IS NOT COMPLETE UNTIL WE KNOW WHERE IT GOES.
     *
     * Appended here rather than made a fourth entry in ticketRequirements.ts
     * on purpose. That file's three-field list is deliberate and its history
     * is that blocking fields destroyed 21 records requests on 2026-08-06 —
     * so these are asked by the form, and the existing strike budget still
     * decides whether a missing answer may ever hold the filing.
     */
    if (state.callPurpose === 'patient_medical_records_request') {
      required.push('recordsDeliveryMethod');
      // 'unspecified' is a recorded refusal, so it must not lead to a second
      // question. Without this the escape hatch reopens the loop it closes.
      if (deliveryDestinationNeeded(state)) required.push('recordsDeliveryDestination');
    }
    /**
     * THE ENRICHMENT BLOCK GOES LAST, AND NEVER IN FRONT OF A DIAL.
     *
     * Last, because these are the questions we can afford to lose: by the time
     * they are asked, purpose, name, organisation and the patient are already
     * in hand. Putting `callerRole` second is what made it the biggest single
     * killer on 2026-09-14/15 — 26 calls died on it for 6 tickets.
     *
     * LAST WAS NOT LATE ENOUGH. This note used to end "and the request files
     * whether or not the caller stays"; on 2026-09-16 ten calls that died on
     * the email question left no ticket of any provenance, because the model
     * files when it runs out of questions and these were still questions.
     * `ENRICHMENT_AFTER_FILING` is the fix — see the note on that list.
     *
     * `!connectsToHuman` is the load-bearing half and it is a guard on
     * something worse than a long intake. `handoffEligible`'s second arm reads
     * `intakeIncomplete`, which is computed from this list — so adding three
     * fields to a HAND_OFF purpose would leave that arm false until somebody
     * recited their email address, and the caller headed for a person would be
     * waiting on it. Skipping the block there leaves `intakeIncomplete`
     * bit-for-bit what it was for every one of those purposes, which is the
     * claim `interviewIsAnAnsweringService.test.ts` pins rather than asserts.
     */
    if (!isPatient && !connectsToHuman) required.push(...PROFESSIONAL_ENRICHMENT);
    const answered = (field: keyof PcpConversationState): boolean => {
      if (state[field]) return true;
      // One slot, several places the answer can land — see SATISFIED_BY.
      return (SATISFIED_BY[field] ?? []).some((alternate) => Boolean(state[alternate]));
    };
    const stillUnset = required.filter((field) => !answered(field));
    /**
     * WHAT WE MAY ASK RIGHT NOW, which is not the same as what is missing.
     *
     * `ENRICHMENT_AFTER_FILING` stays in `stillUnset` and out of this, until a
     * disposition is on the record. THAT ASYMMETRY IS THE WHOLE POINT and it
     * is the v33 decoupling reused: `intakeIncomplete` below is computed from
     * `stillUnset`, and `handoffEligible`'s second arm reads it, so anything
     * that shortened the missing list would grant the AUTO-transfer the
     * operator withdrew on 2026-09-04 two questions sooner. Only what the
     * agent SAYS changes here; who we dial does not move at all.
     */
    const askableNow = stillUnset.filter(
      (field) => Boolean(state.dispositionRecorded) || !ENRICHMENT_AFTER_FILING.includes(field),
    );
    /**
     * TWO QUESTIONS, TWO ANSWERS — AND WELDING THEM IS THE BUG THIS AVOIDS.
     *
     * `intakeIncomplete` is whether the form is genuinely short of something.
     * `missing` is what we will ASK FOR NEXT, which the budget bounds.
     *
     * They must not be one boolean. `handoffEligible`'s SECOND arm reads
     * "a complete intake on a HAND_OFF purpose", and that arm is the
     * AUTO-transfer the operator withdrew on 2026-09-04 ("never
     * auto-transfer; transfer only when the caller ASKS and is an entity").
     * If it read the budget-aware value, spending the budget would silently
     * complete the intake and DIAL — a caller dialled into the PCP queue
     * because we gave up asking them a question. That is the exact
     * `connectsToHuman` welding this file already records, pointed at
     * something worse than a long intake.
     *
     * So the budget changes what the agent SAYS and nothing about who we
     * connect. `directorAskBudget.test.ts` fails if these are collapsed.
     */
    const intakeIncomplete = stillUnset.length > 0;
    const askBudgetSpent = stillUnset.filter(
      (field) => (state.askCounts?.[field] ?? 0) >= askBudgetFor(field),
    );
    const missing = askableNow.find(
      (field) => (state.askCounts?.[field] ?? 0) < askBudgetFor(field),
    );

    let disposition = purpose?.defaultDisposition;
    if (state.callPurpose === 'pharmaceutical_representative' && this.options.pharmaHandoffEnabled) {
      disposition = 'HAND_OFF';
    }
    if (purpose?.containsPhi && disposition === 'AUTOMATE' && state.verificationStatus === 'failed') disposition = 'CREATE_TASK';
    const handoffFailed = state.handoffStatus && state.handoffStatus !== 'CONNECTED';
    if (handoffFailed) disposition = 'CREATE_TASK';
    const source = purpose?.authoritativeSource;
    const retryExhausted = source ? (state.toolFailures[source] ?? 0) >= 2 : false;
    if (retryExhausted) disposition = 'CREATE_TASK';
    // LUNCH CLOSURE, 12:00-13:00 Pacific weekdays (operator directive
    // 2026-08-06): the desk is unstaffed, so a transfer can only ring out
    // while the caller holds. Downgraded HERE, in the director, rather than
    // only at the dial — the prompt tells the agent that the director decides
    // handoff eligibility, so turning it off here means the agent offers a
    // callback instead of promising "one moment while I connect you" and then
    // failing. handoffPolicy refuses the dial too, as the backstop.
    //
    // Administrative PCP traffic only. The clinical/urgent path does not pass
    // through this director and is deliberately never gated on lunch.
    const lunchClosure = this.options.lunchClosure?.() ?? isLunchClosure();
    if (lunchClosure && disposition === 'HAND_OFF') disposition = 'CREATE_TASK';

    const phiDisclosureAllowed = Boolean(purpose && (!purpose.containsPhi || state.verificationStatus !== 'failed'));
    const authoritativeToolAllowed = Boolean(source && !retryExhausted && (!purpose?.containsPhi || state.verificationStatus !== 'failed'));
    // An explicit ask for a person is eligible on its own: no purpose
    // required, no completed intake required. Lunch closure and a previously
    // failed handoff still apply — those are about whether anyone can pick up.
    //
    // NOT for a patient, however plainly they ask. The destination is the PCP
    // queue — staffed to talk to clinics — and dialling a patient into it is
    // worse than the honest answer that this line will take a message and the
    // right team will call back. 117 of 419 callers asked for a person on this
    // line, and a large share of them were patients.
    const askedForAPerson = Boolean(state.callerRequestedHuman) && !isPatient;
    /**
     * WHERE THIS GRANT LEADS, and the deadlock it caused on 2026-08-14.
     *
     * An explicit ask from a professional grants HAND_OFF whatever the purpose
     * — operator directive, and deliberately so: "the staffer who picks up
     * collects what they need."
     *
     * But the purpose's own allowedDispositions still gate the TICKET. On the
     * operator's test call CA62a1245d that combination locked every exit:
     *
     *   handoff_to_pcp  -> durable_ticket_required_before_handoff
     *   create_pcp_task -> disposition_not_allowed: HAND_OFF is not allowed
     *                      for PCP purpose check_patient_scheduled
     *   terminate_call  -> durable_disposition_required   (x4)
     *
     * 188 seconds, no ticket, no transfer, and the agent could not even hang
     * up. Each guard was individually correct; together they had no floor.
     *
     * The grant stays (it is the ruling). What changed is downstream: the
     * durable ticket a handoff files is no longer rejected for carrying the
     * disposition the director just granted, and mayTerminate below no longer
     * demands that a recorded disposition still match a recomputed one.
     */
    const eligibleByAsk = askedForAPerson && !handoffFailed && !lunchClosure;
    if (eligibleByAsk && disposition !== 'HAND_OFF') disposition = 'HAND_OFF';
    /**
     * A PATIENT IS NEVER DIALLED INTO THE PCP QUEUE — on either branch.
     *
     * `eligibleByAsk` has carried `&& !isPatient` since it was written. This
     * branch did not, and it did not need to while `isPatient` was false for
     * everyone whose purpose was not literally `patient_caller`: the long
     * professional field list guaranteed `missing` was truthy, so the branch
     * could not fire.
     *
     * Widening isPatient with `callerIsThePatient` (third review pass) removed
     * that accident. A self-identified patient on a HAND_OFF purpose now
     * completes the SHORT list, `missing` becomes undefined, and this branch
     * flips true — dialling them into a queue staffed to talk to clinics,
     * which the note on `patient_caller` in policy.ts exists to prevent.
     *
     * Caught on the fifth review pass by running the director rather than
     * reading it: `{callerIsThePatient, callerName, callbackNumber,
     * callPurpose:'reschedule_appointment'}` returned handoffEligible true
     * where the parent commit returned false.
     */
    const handoffEligible =
      eligibleByAsk || Boolean(!isPatient && purpose && disposition === 'HAND_OFF' && !intakeIncomplete && !handoffFailed);

    return {
      nextQuestion: missing
        ? {
            field: missing,
            prompt:
              (missing === 'recordsDeliveryDestination' && state.recordsDeliveryMethod
                ? DESTINATION_PROMPTS[state.recordsDeliveryMethod]
                : undefined)
              ?? PROMPTS[missing]
              ?? `Please provide ${String(missing)}.`,
          }
        : undefined,
      /**
       * Fields we have stopped asking for. Field NAMES only — no caller data —
       * so it is safe on the ticket and in `tool_timeline`, and it is what
       * makes "the line got stuck on a question" countable from SQL. The tool
       * ceiling's own stops are console-only and uncountable; this one is not
       * repeating that.
       */
      askBudgetSpent: askBudgetSpent.length ? askBudgetSpent.map(String) : undefined,
      disposition,
      phiDisclosureAllowed,
      authoritativeToolAllowed,
      handoffEligible,
      mustCreateFallbackTicket: Boolean(handoffFailed),
      /**
       * A RECORDED DISPOSITION IS ENOUGH. It no longer has to be the one the
       * director happens to compute at this instant.
       *
       * The old rule was `dispositionRecorded === disposition`, which reads as
       * "we did the thing we currently intend". But `disposition` is
       * recomputed every turn from live state, so anything that moves it after
       * a disposition is recorded — a late "can I speak to someone", a purpose
       * reclassification — retroactively invalidates a record that is already
       * durable, and the call can never be ended.
       *
       * That is what CA62a1245d hit: terminate_call refused four times on a
       * call where work HAD been recorded. The caller sat through it.
       *
       * The guarantee this check exists to give is "no PCP call ends without a
       * durable record of what happened". A recorded disposition satisfies
       * that, whatever the director would choose now. Belt and braces with the
       * fix above: that one stops the mismatch arising, this one stops any
       * future mismatch trapping a live caller.
       */
      mayTerminate: Boolean(state.dispositionRecorded),
    };
  }
}

export const pcpDirector = new PcpDirector({
  pharmaHandoffEnabled: process.env.PCP_PHARMA_HANDOFF_ENABLED === 'true',
});

/**
 * Deploy marker — printed once when this module loads.
 *
 * `callPurpose` moving to the front of both intake orders is the fix for the
 * refusal storm that took this line off the air: over 2026-08-06/07,
 * `handoff_to_pcp` was called 230 times and refused 199 (86.5%), 148 of them on
 * `call_purpose_required`, with another 34 across `create_pcp_task` and
 * `lookup_patient_appointments`. `record_pcp_intake` itself refused nothing —
 * the intake worked, and everything downstream of it was blocked.
 *
 * That fix is invisible from the outside: a build without it answers the phone
 * and sounds normal for one turn. Wayne republishes by pulling on Replit, and a
 * failed pull looks exactly like a failed fix (2026-08-11, a GitHub rate limit
 * at 00:34 cost a whole round of analysis on stale code).
 *
 * So this prints the order it actually resolved, not a version string. If the
 * line reads `callPurpose` first, the fix is live. If it reads `callerName`
 * first, the build is stale and no call on it proves anything.
 */
console.log(
  `[PcpDirector] intake order — professional: ${PROFESSIONAL_FIELDS.join(' -> ')}; ` +
    `patient: ${PATIENT_INTAKE_ORDER.join(' -> ')}`,
);
