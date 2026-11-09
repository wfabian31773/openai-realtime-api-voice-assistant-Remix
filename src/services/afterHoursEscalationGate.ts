/**
 * WHEN THE AFTER-HOURS LINE MAY WAKE A HUMAN.
 *
 * Operator, 2026-08-15, on the after-hours agent:
 *
 *   "It's an after-hours triage agent with the ability to file tickets. The
 *    only times it's supposed to fire is if it's calling from a provider's
 *    office, if it's calling from a hospital, or if it's a truly urgent
 *    situation with a patient. Not 'I need an urgent appointment tomorrow
 *    because I need an eye checkup.' No. You know what urgent is. I've been
 *    getting all kinds of different messages — 'I couldn't hear the patient'
 *    and all different kinds of weird stuff lately. That has to stop."
 *
 * He is describing the data exactly. Of 33 escalations over 14 days, 18 were
 * outside those three cases, and 11 of those 18 connected a live human:
 *
 *   "unable to understand caller's language or request"
 *   "repeated difficulty capturing medication details"
 *   "unable to confirm date of birth after multiple attempts"
 *   "caller declined to provide date of birth, unable to create ticket"
 *   "patient mentioned needing to provide an authorization and fax number
 *    for an upcoming appointment. Immediate assistance required"
 *   "patient reports they cannot see and urgently needs to know when their
 *    glasses will be ready"
 *   "fire alarm on site reported by caller"
 *
 * One call fired three of them; another fired two. Every one rang the on-call
 * provider out of hours.
 *
 * The cause was sanctioned, not accidental: `escalate_to_human` offered
 * `patient_unresponsive` — "cannot communicate after 3 attempts" — as a
 * transfer reason. But the whole point of this agent is that it can file a
 * ticket with whatever it managed to collect. Not understanding a caller is
 * the ordinary case for taking a message, not grounds for waking a doctor.
 *
 * WHY A DETERMINISTIC GATE AND NOT MORE PROMPT TEXT. The prompt already said
 * "RARE - TRUE EMERGENCIES ONLY" and the tool description already said "NEVER
 * ESCALATE FOR ... patient frustration". Prose did not hold. This runs on the
 * server, on the arguments the model actually sent, and a refusal returns a
 * directive telling it to file the ticket instead.
 *
 * ALLOW BY DEFAULT — the single most important property here. A refusal must
 * be POSITIVELY matched against the lists below. Anything this module cannot
 * classify is allowed through, because an unnecessary transfer costs somebody
 * a phone call and a wrongly refused one could cost somebody their sight.
 */

import { mentionsPostOpMedication } from './afterHoursRouting';

export type AfterHoursCallerType =
  | 'patient_urgent_medical'
  | 'healthcare_provider';

export interface EscalationRequest {
  callerType?: string;
  reason?: string;
  symptomsSummary?: string;
  providerInfo?: string;
  /**
   * What the CALLER actually said, from services/symptomCorroboration. Optional
   * so the gate stays a pure function for tests and for any path that has no
   * live transcript — absent means "cannot check", never "fabricated".
   */
  corroboration?: import('./symptomCorroboration').CorroborationResult;
}

export type EscalationVerdict =
  | { allowed: true; basis: 'provider_or_facility' | 'acute_clinical' | 'unclassified_default_open' }
  | {
      allowed: false;
      code:
        | 'communication_failure'
        | 'administrative_request'
        | 'symptoms_not_stated_by_caller'
        | 'post_op_medication'
        | 'provider_not_stated_by_caller'
        | 'records_request';
      directive: string;
    };

/**
 * A caller who IS the healthcare system. The operator's first two cases —
 * "calling from a provider's office" and "calling from a hospital" — and the
 * reason this list is checked first: a nurse ringing at 2am about a post-op
 * patient gets through whatever else her sentence happens to contain.
 */
const PROVIDER_TERMS = [
  'emergency room', ' er ', 'emergency department', 'hospital', 'urgent care',
  'healthcare provider', 'provider\'s office', 'physician', 'surgeon',
  'nurse', 'rn ', 'md ', 'dr.', 'doctor calling', 'clinic calling',
  'medical group', 'skilled nursing', 'facility',
];

/**
 * Unambiguously acute. Every one of these describes something happening to an
 * eye NOW, and none of them is a thing somebody says about an appointment.
 *
 * Deliberately ABSENT: "cannot see" / "can't see". It reads acute and is the
 * exact phrase somebody uses about glasses that are not ready yet — which is
 * how the 08-11 07:47 caller reached the on-call provider. It is handled
 * below instead: acute unless the same sentence names an administrative
 * subject.
 */
const ACUTE_TERMS = [
  'bleeding', 'blood in', 'injury', 'injured', 'trauma', 'hit in the eye',
  'chemical', 'splash', 'burn', 'foreign body', 'something in my eye',
  'intense pain', 'excruciating', 'unbearable',
  'vision loss', 'lost vision', 'losing vision', 'went blind', 'sudden blur',
  'curtain', 'shadow over', 'flash', 'floater', 'detach',
  'post-op', 'post op',
  'urgente', 'sangrado', 'dolor severo', 'perdida de vision', 'pérdida de visión',
];

/**
 * Acute phrases with a word allowed to sit in the middle.
 *
 * A plain substring list misses the way people actually speak. The 14-day
 * backtest caught three: "severe EYE pain" does not contain "severe pain",
 * "recent EYE surgery" does not contain "recent surgery", and "large floaTER"
 * does not contain "floaters". All three still passed the gate — but only via
 * the default-open fallback, which means the moment such a sentence ALSO said
 * "appointment" it would have been refused. An acute case must be recognised
 * as acute, not merely survive by default.
 */
const ACUTE_PATTERNS: RegExp[] = [
  /(severe|sharp|sudden|worst|terrible)\s+(\w+\s+){0,2}pain/,
  /(recent|after|following|post)[\s-]*(\w+\s+){0,2}(surgery|surgical|operation|procedure)/,
  /(sudden|complete|total)\s+(\w+\s+){0,2}(vision|sight)\s+(loss|change)/,
  /(cannot|can't|can not)\s+(\w+\s+){0,2}(see|open)\s+(\w+\s+){0,2}eye/,
];

/**
 * "I could not do my job" — never a reason to transfer on this line. The
 * agent's job when this happens is to file a ticket with whatever it has.
 */
const COMMUNICATION_FAILURE_TERMS = [
  'unable to understand', 'cannot understand', 'could not understand',
  'unable to capture', 'unable to gather', 'unable to collect',
  'unable to confirm', 'unable to complete', 'unable to finalize',
  'unable to obtain', 'unable to verify',
  'not communicating', 'incoherent', 'unclear', 'unresponsive',
  'multiple attempts', 'repeated attempts', 'repeated difficulty',
  'declined to provide', 'refused to provide', 'would not provide',
  'cannot hear', 'could not hear', 'couldn\'t hear', 'hard to hear',
  'language barrier', 'language is unclear', 'do not speak',
  'no response', 'silence', 'poor connection', 'bad connection',
];

/**
 * Routine practice business. The operator's own example: "I need an urgent
 * appointment tomorrow because I need an eye checkup" is not urgent, and
 * neither is a fax number for a prior authorization.
 */
const ADMINISTRATIVE_SUBJECTS = [
  'appointment', 'reschedul', 'cancel', 'confirm', 'booking',
  'refill', 'prescription', 'medication name', 'pharmacy',
  'glasses', 'contacts', 'lenses', 'frames', 'order', 'ready for pickup',
  'will be ready', 'when will', 'status of',
  'authorization', 'referral', 'fax', 'insurance', 'billing', 'copay',
  'invoice', 'balance', 'statement', 'records request', 'paperwork',
  'office hours', 'directions', 'parking', 'address',
];

/**
 * ANY symptom, for the post-op medication carve-out only. Deliberately wide —
 * a word here sends the call back to the acute check, i.e. toward ringing.
 */
const SYMPTOM_PATTERN =
  /\b(pain|painful|hurt|hurts|hurting|ache|aching|sore|red|redness|swollen|swelling|vision|blur|blurry|blurred|see|seeing|sight|light|flash|flashes|floater|floaters|curtain|shadow|discharge|pus|bleed|bleeding|blood|pressure|itch|itchy|burning|watering|nausea|vomit|fever|dolor|duele|rojo|roja|hinchad\w*|vision|borros\w*|sangr\w*|veo|ver)\b/;

const norm = (s?: string) => ` ${(s ?? '').replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' ')} `;

/**
 * A MEDICAL RECORDS REQUEST. Operator ruling, 2026-11-09: "records requests
 * never ring the on-call." Whoever is asking — a provider's office, a hospital,
 * a health plan, the patient — a request for records is a message for Medical
 * Records on the next business day, never a page.
 *
 * Read from the model's own sentence (reason, symptoms, provider info), the
 * same text every other check here reads, and only where an ASKING word
 * governs a document: "requesting the patient's records", "needs records
 * faxed", "a copy of her chart", "asking for the operative report". A
 * document merely mentioned does not count — "I have her chart from your
 * office", "the records show", "her medical record number" — because an ER
 * physician with an emergency mentions the chart they are holding. The window
 * between the two stops at punctuation and at a new clause (a pronoun or
 * "has"/"and"), so "needs the on-call, I have her chart" is not a request for
 * the chart. "Calling on a recorded line" (labs) has no asking word.
 */
const RECORDS_ASK =
  "(?:request(?:s|ed|ing)?|need(?:s|ed|ing)?|want(?:s|ed|ing)?|ask(?:s|ed|ing)? for|looking for|" +
  "obtain(?:s|ed|ing)?|get(?:ting)?|send(?:s|ing)?|fax(?:es|ed|ing)?|e-?mail(?:s|ed|ing)?|forward(?:s|ed|ing)?|" +
  "cop(?:y|ies) of|release(?: of)?)";
const RECORDS_WINDOW =
  "(?:(?!(?:and|but|i|we|she|he|they|has|have|had|is|was|with|who|because)\\b)[a-z0-9'-]+ ){0,4}";
const RECORDS_DOC =
  "(?:(?:medical|health|eye|patient'?s?|office|visit|clinic|chart|exam|progress|consult(?:ation)?|" +
  "operative|op|surgical|surgery|pathology|imaging|oct|lab|test) )*" +
  "(?:records?(?! number| no\\b| #)|charts?|notes|(?:operative|op|surgical|surgery|pathology|imaging|consult(?:ation)?|exam|visit|lab|oct) reports?)";
export const RECORDS_REQUEST = new RegExp(
  `\\b(?:${RECORDS_ASK} ${RECORDS_WINDOW}${RECORDS_DOC}\\b|records? requests?|requests? for (?:medical )?records|release of information|records release)`,
);
const hits = (haystack: string, needles: string[]) => needles.some((n) => haystack.includes(n));

/**
 * One of the acute terms or phrases above, in any text. Exported so the
 * corroboration ledger can ask it of the CALLER's own lines (`acuteStated`):
 * a caller who said "I went blind" or "a curtain came down" has described an
 * emergency whatever the model wrote.
 */
export function describesAcuteEvent(raw: string): boolean {
  const text = norm(raw.replace(/[’‘]/g, "'"));
  return hits(text, ACUTE_TERMS) || ACUTE_PATTERNS.some((re) => re.test(text));
}

/**
 * Decide whether this escalation is one of the operator's three cases.
 *
 * Order matters and encodes the ruling: identity first (a provider who SAID
 * so gets through regardless of what else the sentence says), then acuity,
 * then the refusals (a provider claim the caller never made is the last of
 * them), then open.
 */
export function judgeEscalation(req: EscalationRequest): EscalationVerdict {
  const text = norm([req.reason, req.symptomsSummary, req.providerInfo].filter(Boolean).join(' . '));
  const callerType = (req.callerType ?? '').toLowerCase();

  /**
   * RECORDS REQUESTS NEVER RING (operator, 2026-11-09). Checked FIRST, ahead
   * of the provider case: on 2026-11-07 a provider's office asking for a
   * patient's records was case 1 here and rang the on-call phone twice in four
   * minutes (CAbccc433f0627622f50d32ff4abd7cec8, 47 s, declined;
   * CAe8f5c1f0daedc324c21dc244dce7832d, 24 s, no answer).
   *
   * No exception here, deliberately: records about an eye condition name it
   * ("records for her retinal detachment repair", "post-op notes"), so an
   * acute-word exception let records requests ring. A caller who wants records
   * AND has an emergency happening now is told, below, to escalate again with
   * the emergency alone — that second call is judged on its own.
   */
  if (RECORDS_REQUEST.test(text)) {
    return {
      allowed: false,
      code: 'records_request',
      directive:
        'A medical records request is never a transfer on this line, whoever is asking. Do not call ' +
        'escalate_to_human for it again. Take it as a message for Medical Records. If the caller is asking for ' +
        "someone else's records (a doctor's office, hospital, health plan, attorney or family member), ask " +
        'their name and the office or organization first, then ONE question at a time: the PATIENT\'s first and ' +
        'last name, then the patient\'s date of birth starting with the month, then the day, then the year — ' +
        'never the caller\'s own — then where the records should be sent. Then call create_ticket with ' +
        'request_category medical_records_request, records_requester and requester_name, and tell the caller ' +
        'Medical Records will follow up on the next business day. Only if the caller ALSO says, in their own words, ' +
        'that an eye emergency is happening right now (sudden loss of vision, a curtain, a chemical or an injury ' +
        'to the eye) call escalate_to_human again at once with a reason that describes only that emergency.',
    };
  }

  /**
   * CASE 1 + 2 — a provider's office or a hospital. Highest precedence, BUT
   * ONLY WHEN THE CALLER SAID SO.
   *
   * Operator, 2026-10-19: "no escalation unless the caller themselves said
   * they are a provider." Until then this case took the agent's word for it,
   * and the agent's word was cheap. `callerType` is the agent's guess and the
   * reason is the agent's sentence, so a reason that merely NAMES a doctor
   * ("caller requesting Doctor Nair") matched `dr.` above and rang the
   * on-call phone. Over 75 days of after-hours escalations, patients asking
   * for their own doctor by name rang through this way, and on 2026-10-18 a
   * caller who said only "Operator." was written up as "operator/clinician"
   * and connected (CA4079341a0d7e7cbbc9daf36da56bb7c0).
   *
   * So the provider case now needs the caller's own self-identification (see
   * callerSaysTheyAreAProvider). Without it the call is judged on everything
   * else below — a patient who describes an eye emergency in their own words
   * still rings, as case 3 — and only if nothing else lets it through is it
   * refused, with a directive to ask the caller which office or facility they
   * are calling from. No record of the caller speaking at all still fails
   * open, as every check here does.
   */
  const providerClaimed = callerType === 'healthcare_provider' || hits(text, PROVIDER_TERMS);
  const corrForProvider = req.corroboration;
  const providerUnstated = providerClaimed && Boolean(corrForProvider?.haveSpeech) && !corrForProvider?.providerStated;
  if (providerClaimed && !providerUnstated) {
    return { allowed: true, basis: 'provider_or_facility' };
  }

  /**
   * DID THE CALLER SAY IT, OR DID THE AGENT?
   *
   * Checked BEFORE the acute terms, because an invented symptom will always
   * match them — that is the whole problem. Call d30ca58b (2026-08-15 10:20
   * PT): the agent asked "is there any pain with the redness, and has your
   * vision changed at all?", took one "Yes", and paged the on-call provider
   * with "red eye with pain and vision changes reported". The caller had said
   * DISCHARGE and asked for a callback.
   *
   * Operator: *"This is not a reason for the agent to pass the call through as
   * urgent."*
   *
   * Refuses only when EVERY acute claim in the reason is unsupported and none
   * is supported. A caller who genuinely said "it hurts" corroborates the pain
   * claim and goes straight through; a caller we have no speech for at all
   * fails open. The bar is "did they raise this", not "did they use this word"
   * — see CLAIM_EVIDENCE, where "stings", "burns" and "cloudy" all count.
   */
  const corr = req.corroboration;
  /**
   * AND NEVER WHEN THE CALLER DESCRIBED AN ACUTE EVENT in their own words,
   * whatever the claim lists matched. A caller who said "my eye is bleeding"
   * or "there's something in my eye" while the model wrote "sudden vision
   * loss" is the call this line exists to ring through; the per-claim
   * evidence lists can always be one wording short, and a miss there refused
   * an emergency (review P1, #353).
   *
   * ACUTE, NOT ANY SYMPTOM. An earlier fix let any symptom word lift this
   * refusal, and that reopened the call it was built for: d30ca58b's caller
   * said "discharge" and asked for a callback, the agent wrote "pain and
   * vision changes", and the operator ruled on 2026-08-15 that this "is not a
   * reason for the agent to pass the call through as urgent". Red, itchy,
   * watering, discharge and pressure are what the caller should be ASKED
   * about one question at a time — the directive below — not a licence for
   * the symptoms the agent added. The refusal costs a real emergency one
   * question, after which an honest re-escalation passes.
   *
   * A SUPPORTED claim counts as the caller describing something for the
   * provider refusal and the acute door below: the caller's own words backed
   * what the model wrote. Without it, a patient who said "I lost my eyesight"
   * while the model wrote "sudden vision loss, requesting the on-call
   * physician" was refused as an unstated provider — "physician" made it a
   * provider claim, and the acute door and refusal 3 read only
   * symptomStated/acuteStated (review r2 P1, #353).
   */
  const callerDescribedSomething = Boolean(
    corr?.symptomStated || corr?.acuteStated || (corr?.supported.length ?? 0) > 0,
  );
  if (
    corr &&
    corr.haveSpeech &&
    corr.unsupported.length > 0 &&
    corr.supported.length === 0 &&
    !corr.acuteStated
  ) {
    return {
      allowed: false,
      code: 'symptoms_not_stated_by_caller',
      directive:
        `The caller never mentioned ${corr.unsupported.join(' or ')}. Do not report symptoms they did not ` +
        'describe — the on-call provider acts on what you write. Ask ONE question at a time and wait for a ' +
        'real answer: "Is there any pain?" then, separately, "Has your vision changed?" A single "yes" to a ' +
        'two-part question answers neither. If the caller has not described an emergency, call create_ticket ' +
        'with what they actually said and tell them the team will call them back.',
    };
  }

  /**
   * A POST-OP MEDICATION PROBLEM WITH NO SYMPTOM IS NOT A TRANSFER.
   *
   * Operator, 2026-10-02, asked whether a patient whose post-op drops never
   * reached the pharmacy is "post-surgical trouble": "no, it should record an
   * urgent ticket in after hours." Checked BEFORE the acute terms because
   * "post-op" and "after surgery" ARE acute terms here — on their own they
   * mean post-surgical trouble and ring the on-call provider, which is right
   * when the patient describes a symptom and wrong when the subject is a
   * prescription.
   *
   * So the carve-out needs all three: the operation already happened, a
   * medication is the subject, and NO symptom is named. Any symptom word —
   * pain, vision, redness, swelling, discharge — and this steps aside and the
   * acute check below rings as before. It errs toward ringing on purpose: a
   * needless call costs the on-call provider a phone call, a wrongly refused
   * one could cost somebody their sight. A provider or a hospital calling
   * about a post-op patient never reaches here (case 1/2 above).
   *
   * The refusal files the ticket itself (v80), URGENT and to After Hours —
   * see the no-IVR agent's fileRefusedEscalationTicket.
   */
  if (mentionsPostOpMedication(text) && !SYMPTOM_PATTERN.test(text)) {
    return {
      allowed: false,
      code: 'post_op_medication',
      directive:
        'A post-operative medication or prescription problem with no new symptom is not a transfer on this ' +
        'line. It files URGENT for the After Hours team. If the caller then describes a symptom in their own ' +
        'words — pain, a change in vision, redness, swelling, discharge — that is post-surgical trouble.',
    };
  }

  const administrative = hits(text, ADMINISTRATIVE_SUBJECTS);

  /**
   * A PROVIDER CLAIM THE CALLER NEVER MADE MUST NOT RING THROUGH THE ACUTE
   * DOOR EITHER. The acute lists read the model's sentence, so "clinician
   * calling about a post-op patient" for a caller who said "Operator. Page
   * Dr. Hart." rang as acute_clinical and skipped refusal 3 below (review P2,
   * #353). When the provider claim is unstated, an acute match counts only if
   * the CALLER described a symptom or an acute event; otherwise the call falls
   * through to refusal 3, which asks one question and lets a real provider or
   * a described emergency back in. A provider who said so never reaches here,
   * and with no record of the caller speaking `providerUnstated` is false, so
   * that path — the old core's when it feeds nothing — is unchanged.
   */
  const acuteCorroborated = !providerUnstated || callerDescribedSomething;

  // CASE 3 — a truly urgent patient. An unambiguous acute term wins outright.
  if (acuteCorroborated && (hits(text, ACUTE_TERMS) || ACUTE_PATTERNS.some((re) => re.test(text)))) {
    return { allowed: true, basis: 'acute_clinical' };
  }

  /**
   * The ambiguous middle: "cannot see". Acute on its own, and the everyday
   * phrasing for "my new glasses have not arrived". It counts as acute ONLY
   * when nothing administrative is named alongside it — which is exactly the
   * distinction the 08-11 07:47 escalation got wrong ("cannot see and
   * urgently needs to know when their glasses will be ready").
   */
  const softVision = /(cannot|can't|can not|couldn't|unable to) see|blurr|double vision|vision (is |has )?(gone|worse|blurry)/.test(text);
  if (softVision && !administrative && acuteCorroborated) {
    return { allowed: true, basis: 'acute_clinical' };
  }

  // REFUSAL 1 — the agent could not do its job. File the ticket.
  if (hits(text, COMMUNICATION_FAILURE_TERMS) || callerType === 'patient_unresponsive') {
    return {
      allowed: false,
      code: 'communication_failure',
      directive:
        'Not being able to collect a detail is not an emergency, and this line does not transfer for it. ' +
        'Call create_ticket now with whatever you DID manage to get — a partial ticket reaches the right ' +
        'team, an unnecessary transfer wakes the on-call provider. Tell the caller their message is going ' +
        'to the team and someone will call them back.',
    };
  }

  // REFUSAL 2 — routine practice business dressed as urgent.
  if (administrative) {
    return {
      allowed: false,
      code: 'administrative_request',
      directive:
        'This is a routine request, however urgently the caller phrased it. Appointments, refills, glasses, ' +
        'authorizations, faxes and billing are never transfers on this line. Call create_ticket now and tell ' +
        'the caller the team will follow up. Transfer only for an eye emergency, or a provider or hospital ' +
        'calling about a patient.',
    };
  }

  // REFUSAL 3 — the agent called this a provider call and the caller never
  // said so. Last, so an emergency the caller described still rings above,
  // and never when the CALLER described a symptom (see symptomStated). The
  // reason is the model's sentence, so a symptom in it proves nothing: a
  // model that writes "redness" into the reason of a caller who said only
  // "Operator." would otherwise skip this refusal and ring through
  // default-open (Codex P1, #353).
  if (providerUnstated && !callerDescribedSomething) {
    return {
      allowed: false,
      code: 'provider_not_stated_by_caller',
      directive:
        'The caller has not said they are a doctor, a nurse, or calling from a doctor\'s office, hospital, ER, ' +
        'lab or clinic, and this line transfers a provider call only when the caller says so. Asking for a ' +
        'doctor by name, or for an operator, does not make someone a provider. Ask ONE question: "Are you ' +
        'calling from a doctor\'s office, a hospital, a clinic or a laboratory, and which one?" If they name ' +
        'one — a laboratory reporting results counts — call escalate_to_human once more. If not, take their ' +
        'message.',
    };
  }

  // Anything else goes through. Deliberate.
  return { allowed: true, basis: 'unclassified_default_open' };
}
