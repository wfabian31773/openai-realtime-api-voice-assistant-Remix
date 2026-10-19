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
        | 'provider_not_stated_by_caller';
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

/**
 * ANY SYMPTOM IN THE REASON, for the unstated-provider refusal only. A reason
 * that describes a symptom is judged as a patient call, the way it was before
 * the 2026-10-19 ruling, so the refusal can never catch a caller who is
 * describing an emergency in words the acute lists above happen to miss
 * ("extreme pain after surgery today" is in neither). Narrower than
 * SYMPTOM_PATTERN on purpose: "see" and "vision" would match "wants to see
 * Doctor Shah" and "calling from Azul Vision", which are exactly the calls
 * this refusal exists for.
 */
const REASON_SYMPTOM =
  /\b(pain|painful|hurt|hurts|hurting|ache|aching|sore|red|redness|swollen|swelling|blur|blurry|blurred|flash|flashes|floaters?|curtain|shadow|discharge|pus|bleed|bleeding|blood|pressure|itch|itchy|burning|watering|nausea|vomit\w*|fever|injur\w*|trauma|chemical|can'?t see|cannot see|vision (?:loss|change|changes|problem|problems)|lost (?:his |her |my |their )?(?:vision|sight)|dolor|duele|rojo|roja|hinchad\w*|sangr\w*)\b/;

const norm = (s?: string) => ` ${(s ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
const hits = (haystack: string, needles: string[]) => needles.some((n) => haystack.includes(n));

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
  if (corr && corr.haveSpeech && corr.unsupported.length > 0 && corr.supported.length === 0) {
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

  // CASE 3 — a truly urgent patient. An unambiguous acute term wins outright.
  if (hits(text, ACUTE_TERMS) || ACUTE_PATTERNS.some((re) => re.test(text))) {
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
  if (softVision && !administrative) {
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
  // and never when the reason describes a symptom (see REASON_SYMPTOM).
  if (providerUnstated && !REASON_SYMPTOM.test(text)) {
    return {
      allowed: false,
      code: 'provider_not_stated_by_caller',
      directive:
        'The caller has not said they are a doctor, a nurse, or calling from a doctor\'s office, hospital, ER ' +
        'or clinic, and this line transfers a provider call only when the caller says so. Asking for a ' +
        'doctor by name, or for an operator, does not make someone a provider. Ask ONE question: "Are you ' +
        'calling from a doctor\'s office, a hospital or a clinic, and which one?" If they name one, call ' +
        'escalate_to_human once more. If not, take their message.',
    };
  }

  // Anything else goes through. Deliberate.
  return { allowed: true, basis: 'unclassified_default_open' };
}
