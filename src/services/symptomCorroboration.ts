/**
 * DID THE CALLER ACTUALLY SAY THAT?
 *
 * Operator, 2026-08-15, on a transfer notification reading "red eye with pain
 * and vision changes reported": *"This is not a reason for the agent to pass
 * the call through as urgent."*
 *
 * He is right, and the reason is worse than an over-permissive rule. Call
 * d30ca58b, 10:20:35 Pacific, verbatim:
 *
 *     CALLER: Reaction
 *     CALLER: And my right eye. With discharge.
 *     AGENT:  I'm sorry to hear that you're experiencing discharge in your
 *             right eye. Is there any pain with it, and has your vision
 *             changed at all?
 *     CALLER: Hello
 *     AGENT:  Thank you for letting me know... Is there any pain with the
 *             redness, and has your vision changed at all?
 *     CALLER: Yes.
 *
 * The caller never said "pain". She never said "vision changed". She said
 * DISCHARGE, and her opening request was "I would like somebody to give me a
 * call". The agent asked a COMPOUND question, received one ambiguous "Yes",
 * and reported both symptoms to the on-call provider as facts.
 *
 * An escalation gate that reads the agent's own summary string cannot catch
 * that: by the time the reason says "pain", the pain has already been
 * invented. So this ledger keeps what the CALLER said, and the gate asks it
 * whether a claimed symptom has any support in the caller's own words.
 *
 * WHAT THIS IS NOT. It is not a second opinion on whether a symptom is
 * serious — that is the operator's ruling, encoded in
 * afterHoursEscalationGate. This answers one narrower question: did anybody on
 * the caller's side of the line ever say this, or did the agent supply it?
 *
 * A bare "yes" is deliberately NOT corroboration. It is exactly what the
 * compound question harvested, and treating it as agreement to both halves is
 * the defect.
 */

// The gate owns the acute lists; it imports only a TYPE from this module, so
// this is not a runtime cycle.
import { describesAcuteEvent } from './afterHoursEscalationGate';

/** Caller utterances for a live call, lowercased, most recent last. */
const callerSpeech = new Map<string, string[]>();

/** Cap per call: a long call must not grow unbounded in memory. */
const MAX_LINES = 400;

/**
 * Cap on calls held at once. Each pipeline releases its own call at the end,
 * so this only bites if a release is ever missed; the oldest call goes first.
 */
const MAX_CALLS = 500;

function store(callId: string, lines: string[]): void {
  callerSpeech.delete(callId); // re-insert so insertion order tracks recency
  callerSpeech.set(callId, lines);
  while (callerSpeech.size > MAX_CALLS) {
    const oldest = callerSpeech.keys().next().value;
    if (oldest === undefined) break;
    callerSpeech.delete(oldest);
  }
}

export function recordCallerSpeech(callId: string, text: string): void {
  if (!callId || !text?.trim()) return;
  const lines = callerSpeech.get(callId) ?? [];
  lines.push(text.toLowerCase());
  if (lines.length > MAX_LINES) lines.shift();
  store(callId, lines);
}

/**
 * THE RUNTIME'S WAY IN, which it did not have until v99.
 *
 * `recordCallerSpeech` is fed by the old core's transcript handler and by
 * nothing else, and the after-hours line moved to the runtime on 2026-10-01.
 * From that day `corroborate` found no caller speech on any after-hours call,
 * failed open as designed, and the check that refuses symptoms the caller
 * never said did nothing at all.
 *
 * The runtime posts its WHOLE transcript record on every caller turn, the way
 * it already feeds spokenDob and spokenPatientStatus, because a caller turn
 * is replaced in place as its transcript is re-emitted. So this replaces the
 * ledger rather than appending to it: appending would keep a caller's first
 * partial words beside their final ones.
 */
export function noteCallerTranscript(callId: string | undefined, lines: readonly string[]): void {
  if (!callId) return;
  const caller = lines
    .filter((line) => line.startsWith('CALLER:'))
    .map((line) => line.slice('CALLER:'.length).trim().toLowerCase())
    .filter(Boolean)
    .slice(-MAX_LINES);
  if (caller.length === 0) return;
  store(callId, caller);
}

export function releaseCallerSpeech(callId: string | undefined): void {
  if (callId) callerSpeech.delete(callId);
}

/** Everything the caller said on this call, joined. Empty when unknown. */
export function callerSaid(callId: string | undefined): string {
  return callId ? (callerSpeech.get(callId) ?? []).join(' ') : '';
}

/**
 * Symptom claims that must be traceable to the caller's own words, and the
 * words that count as the caller having said them.
 *
 * English and Spanish, because this line takes both and a Spanish-speaking
 * caller describing real pain must not be treated as uncorroborated.
 */
const CLAIM_EVIDENCE: Array<{ claim: RegExp; spoken: RegExp; label: string }> = [
  {
    label: 'pain',
    claim: /\bpain(ful)?\b|\bhurt|\baching\b|\bsore\b/,
    // STEMS, not whole words. "it stings so much" did not match `\bstinging\b`
    // and would have been read as an invented symptom — the exact false
    // accusation this module must never make.
    spoken: /\bpain|\bhurt|\bach(e|es|ing|y)\b|\bsore\b|\bsting|\bburn|\bthrob|\bpressure\b|\bdolor|\bduele|\barde|\bmolest/,
  },
  {
    label: 'vision change',
    claim: /vision (change|loss|blurr)|blurr(ed|y) vision|can'?t see|cannot see|losing (my )?(sight|vision)|lost (my )?(sight|vision)/,
    // WIDE ON PURPOSE, because a miss here refuses an emergency. A caller who
    // lost their sight rarely says "vision": they say they went blind, lost
    // their EYESIGHT (`sight` takes no leading \b so it matches inside it),
    // everything went black or dark, a curtain or a shadow came down, it's
    // gone, or "estoy ciego", "no veo", "perdí la vista", "se me nubló",
    // "todo se puso negro" (review P1, #353).
    spoken:
      /\bvision\b|\bsee\b|\bseeing\b|sight\b|\bblind|\bblurr?|\bcloudy\b|\bdouble\b|\bdark|\bblack|\bcurtain|\bshadow|\bveil\b|\bgone\b|\bspots?\b|\bfloaters?\b|\bflash|\bvista\b|\bver\b|\bveo\b|\bborros|\bcieg[oa]s?\b|\bnubl|\bcortina|\bsombra|\bnegr[oa]\b/,
  },
];

export interface CorroborationResult {
  /** Claims made by the agent with NO support anywhere in the caller's words. */
  unsupported: string[];
  /** Claims made and supported. */
  supported: string[];
  /** False when we have no record of the caller speaking at all. */
  haveSpeech: boolean;
  /**
   * The caller said, in their own words, that they are a provider or are
   * calling from a doctor's office, hospital, ER or clinic. See
   * callerSaysTheyAreAProvider. False whenever haveSpeech is false.
   */
  providerStated: boolean;
  /**
   * The caller described a symptom in their own words (CALLER_SYMPTOM). The
   * unstated-provider refusal steps aside for this and only this — never for a
   * symptom the model wrote into its reason. False whenever haveSpeech is false.
   */
  symptomStated: boolean;
  /**
   * The caller's own lines carry one of the gate's acute terms or phrases
   * ("went blind", "curtain", "after surgery", "something in my eye"). Like
   * symptomStated, it lets the caller back in on every check that would
   * otherwise refuse them for words the model wrote. False whenever haveSpeech
   * is false.
   */
  acuteStated: boolean;
}

/**
 * ANY SYMPTOM IN THE CALLER'S OWN WORDS, for the gate's unstated-provider
 * refusal only. A caller who describes a symptom is judged as a patient call,
 * the way it was before the 2026-10-19 ruling, so the refusal can never catch
 * somebody describing an emergency in words the gate's acute lists happen to
 * miss ("he had surgery today and he is in extreme pain").
 *
 * It reads the CALLER, not the reason. It first read the reason, and the
 * reason is the model's sentence: a model that wrote "redness" into the reason
 * of a caller who said only "Operator." skipped the refusal and rang through
 * default-open (Codex P1, #353).
 *
 * Narrower than the gate's SYMPTOM_PATTERN on purpose: "see" and "vision"
 * would match "can you speak to Doctor Shah, I want to see him" and "Azul
 * Vision", which are exactly the calls the refusal exists for.
 */
export const CALLER_SYMPTOM =
  /\b(pain|painful|hurt|hurts|hurting|ache|aching|sore|red|redness|swollen|swelling|blur|blurry|blurred|flash|flashes|floaters?|curtain|shadow|discharge|pus|bleed|bleeding|blood|pressure|itch|itchy|burning|watering|nausea|vomit\w*|fever|injur\w*|trauma|chemical|can'?t see|cannot see|vision (?:loss|change|changes|problem|problems)|lost (?:his |her |my |their )?(?:vision|sight)|dolor|duele|rojo|roja|hinchad\w*|sangr\w*)\b/;

/**
 * WHO IS CALLING, IN THE CALLER'S OWN WORDS.
 *
 * Operator, 2026-10-19: "no escalation unless the caller themselves said they
 * are a provider." The gate's provider case took the agent's word for it, and
 * the agent's word was cheap: a caller who said only "Operator." was written
 * up as "operator/clinician" and rang the on-call phone, and patients asking
 * for their own doctor by name ("can you speak to Doctor Sean please?") were
 * written up as "clinician calls" and rang it too, because the reason then
 * names a doctor.
 *
 * So this asks for SELF-IDENTIFICATION, not for the word "doctor". A patient
 * says "doctor" all the time ("I need the doctor to call me back", "I'm a
 * patient of Dr. Choi"); a provider says who they are or where they are
 * calling from ("this is Dr. Brown", "I'm a PA calling from St. Joe's
 * emergency room", "the patient is on our ER", "peer-to-peer"). Paging
 * language on its own ("page the on-call physician") is NOT counted: the
 * refusal asks the caller which office or facility they are calling from,
 * and their answer is what lets the transfer through.
 *
 * English and Spanish, like the symptom evidence above.
 */
const PROVIDER_ROLE =
  String.raw`(?:dr\.?|doctor|doctora|nurse|nurse practitioner|physician|physician assistant|surgeon|resident|` +
  String.raw`ophthalmologist|optometrist|np|pa|rn|md|charge nurse|(?:er|emergency(?: room)?) (?:doctor|physician|nurse))`;
const FACILITY =
  String.raw`(?:hospital|medical (?:center|group|office|clinic)|clinic|e\.? ?r\b\.?|emergency (?:room|department)|` +
  String.raw`urgent care|surgery center|surgical center|nursing (?:home|facility)|skilled nursing|` +
  String.raw`rehab(?:ilitation)? (?:center|facility)|doctor'?s office|(?:dr\.?|doctor) [a-z'-]+'?s office|` +
  String.raw`office of (?:dr\.?|doctor) [a-z'-]+|optometry|ophthalmology|eye (?:center|clinic|institute)|icu|intensive care)`;

/**
 * The roles a patient also says about themselves: "I am a resident of
 * Covina", "I'm on my PA's list". Counted only with a calling or facility word
 * after them (review P2, #353).
 */
const AMBIGUOUS_ROLE = String.raw`(?:resident|np|pa|md)`;
const STRONG_ROLE =
  String.raw`(?:dr\.?|doctor|doctora|nurse|nurse practitioner|physician|physician assistant|surgeon|` +
  String.raw`ophthalmologist|optometrist|rn|charge nurse|(?:er|emergency(?: room)?) (?:doctor|physician|nurse))`;
/**
 * A role that is somebody ELSE's: "I'm Dr. Shah's patient", "I'm the
 * doctor's patient". Rejects a possessive straight after the role, or after
 * the role and one name.
 */
const NOT_POSSESSIVE = String.raw`(?!'?s\b)(?!\.? ?[a-z-]+'s\b)`;

const PROVIDER_SELF_IDENTIFICATION: RegExp[] = [
  // "this is Dr. Brown", "this is an emergency room doctor"
  new RegExp(String.raw`\b(?:this is|i'?m|i am)\s+(?:a |an |the |your )?${STRONG_ROLE}\b${NOT_POSSESSIVE}`),
  // "I'm a PA calling", "I'm the resident on call", "I'm an NP with the clinic"
  new RegExp(
    String.raw`\b(?:this is|i'?m|i am)\s+(?:a |an |the |your )?${AMBIGUOUS_ROLE}\b` +
      String.raw`(?: [a-z-]+)?? (?:calling|on call|from|with|at|on behalf)\b`,
  ),
  // "my name is Doctor Perez"
  new RegExp(String.raw`\bmy name is (?:a |an |the )?${PROVIDER_ROLE}\b${NOT_POSSESSIVE}`),
  // "referring doctor on the phone", "a doctor calling"
  new RegExp(String.raw`\b${PROVIDER_ROLE} (?:here|calling|on the (?:phone|line))\b`),
  // "calling from St. Joe's emergency room", "speaking on behalf of a clinic"
  new RegExp(
    String.raw`\b(?:calling|speaking|reaching out)\s+(?:from|with|on behalf of)\s+(?:the |a |an |our )?` +
      String.raw`(?:[a-z0-9'&.-]+ ){0,5}?${FACILITY}(?![a-z])`,
  ),
  // "this is the emergency room", "this is St. Joe's hospital"
  new RegExp(String.raw`\bthis is (?:the |a |an )?(?:[a-z0-9'&.-]+ ){0,4}?${FACILITY}(?![a-z])`),
  // "the emergency room at Huntington calling"
  new RegExp(String.raw`${FACILITY}(?![a-z])(?: [a-z0-9'&.-]+){0,3} calling\b`),
  // "I'm with the ER", "we're from the clinic"
  new RegExp(String.raw`\b(?:i'?m|i am|we'?re|we are) (?:from|with) (?:the |a |an )?(?:[a-z0-9'&.-]+ ){0,5}?${FACILITY}(?![a-z])`),
  // "calling on behalf of Dr. Smith"
  /\bon behalf of (?:dr\.?|doctor) [a-z]/,
  // "our mutual patient", "I have a post-operative patient", "the patient is on our ER"
  /\b(?:our|a mutual) (?:mutual )?patients?\b/,
  // At most ONE word between the article and "patient" ("a post-operative
  // patient"), never "been": "I have been a patient there for years" and "we
  // have a patient appointment tomorrow" are patients (review P2, #353).
  /\b(?:i|we) (?:have|'?ve got|got) (?:a |an |the |this )?(?:(?!been )[a-z-]+ )?patient\b(?! portal| id\b| number| account| appointment| here\b| there\b| of\b)/,
  /\bpatient (?:is |that'?s |who'?s |who is )?(?:on|in|at) (?:our|the) (?:e\.? ?r\b|emergency|unit|floor|icu|facility)/,
  /\b(?:on|in) our (?:e\.? ?r\b|emergency|unit|floor|icu)/,
  /\bour (?:physician|provider|surgeon|nurse)\b/,
  /\bpeer[- ]?to[- ]?peer\b/,
  // Spanish: "soy la doctora", "llamo del hospital", "nuestro paciente"
  /\bsoy (?:el |la |un |una )?(?:doctor|doctora|dr\.?|m[eé]dic[oa]|enfermer[oa])\b/,
  /\b(?:llamo|hablo|estoy llamando|le llamo|le hablo|llamamos|hablamos) (?:de|del|desde) (?:el |la |un |una )?(?:[a-z\u00e0-\u00ff'.-]+ ){0,4}?(?:hospital|cl[ií]nica|consultorio|sala de emergencias?|emergencias|centro m[eé]dico|oficina del (?:doctor|dr\.?))/,
  /\b(?:nuestr[oa]|tengo un[a]?) paciente\b/,
];

/** Pure, for tests: does this caller text identify the caller as a provider? */
export function callerSaysTheyAreAProvider(spoken: string): boolean {
  const text = ` ${(spoken ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')} `;
  return PROVIDER_SELF_IDENTIFICATION.some((re) => re.test(text));
}

/**
 * Check an escalation's stated symptoms against what the caller actually said.
 *
 * DELIBERATELY GENEROUS. `spoken` is much broader than `claim`: a caller who
 * says "it stings" corroborates a claim of "pain", and one who says "it's
 * cloudy" corroborates "vision change". The bar is *did they raise this at
 * all*, not *did they use the same word*. Anything we cannot positively show
 * the agent invented is treated as supported.
 */
export function corroborate(callId: string | undefined, claimText: string): CorroborationResult {
  const spoken = callerSaid(callId).toLowerCase().replace(/[’‘]/g, "'");
  const claim = (claimText ?? '').toLowerCase();
  const out: CorroborationResult = {
    unsupported: [],
    supported: [],
    haveSpeech: Boolean(spoken.trim()),
    providerStated: callerSaysTheyAreAProvider(spoken),
    symptomStated: CALLER_SYMPTOM.test(spoken),
    acuteStated: Boolean(spoken.trim()) && describesAcuteEvent(spoken),
  };

  // No record of caller speech — a transcription gap, a very short call, or a
  // path that does not feed this ledger. Never treat that as evidence of
  // fabrication: fail open.
  if (!out.haveSpeech) return out;

  for (const { claim: claimRe, spoken: spokenRe, label } of CLAIM_EVIDENCE) {
    if (!claimRe.test(claim)) continue;
    if (spokenRe.test(spoken)) out.supported.push(label);
    else out.unsupported.push(label);
  }
  return out;
}
