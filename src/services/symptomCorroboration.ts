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

/**
 * Caller turns that ANSWER refusal 3's own question ("Are you calling from a
 * doctor's office, a hospital or a clinic, and which one?"), lowercased. Only
 * the runtime fills it, because only the runtime hands this module the agent's
 * lines in order (noteCallerTranscript); the old core's feed is caller lines
 * alone and keeps the anchored bare-answer reading.
 */
const providerAnswers = new Map<string, string[]>();

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
    providerAnswers.delete(oldest);
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
  const answers = answersToTheFacilityQuestion(lines);
  if (answers.length > 0) providerAnswers.set(callId, answers);
  else providerAnswers.delete(callId);
}

export function releaseCallerSpeech(callId: string | undefined): void {
  if (!callId) return;
  callerSpeech.delete(callId);
  providerAnswers.delete(callId);
}

/**
 * The agent asking refusal 3's question, in the gate's words or close to them,
 * in English or Spanish. It opens a window the way spokenDob's ask does.
 *
 * Loose on purpose (review r4 P3, #353): an Oxford comma, a small paraphrase
 * or a barge-in that cuts the line after "calling from a doctor's" must still
 * open it, or a real provider's answer falls back to the strict form. Every
 * branch still needs "calling from" near a facility word, or the gate's own
 * "doctor's office, hospital or clinic" list.
 */
const FACILITY_QUESTION = new RegExp(
  [
    String.raw`calling from [^.?!]{0,40}?(?:office|hospital|clinic|facility)`,
    String.raw`calling from (?:a |the )?doctor'?s?\b`,
    String.raw`doctor'?s office,? (?:a )?hospital,? or (?:a )?clinic`,
    String.raw`which (?:office|hospital|clinic|facility) are you calling from`,
    String.raw`(?:llama|habla) (?:usted )?(?:de|desde) (?:un |una |el |la )?(?:consultorio|hospital|cl[ií]nica)`,
  ].join('|'),
);

/**
 * The caller turns between an agent line asking the facility question and the
 * next agent line. Exported for tests.
 */
export function answersToTheFacilityQuestion(lines: readonly string[]): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    if (line.startsWith('AGENT:')) {
      open = FACILITY_QUESTION.test(line.slice('AGENT:'.length).toLowerCase().replace(/[’‘]/g, "'"));
    } else if (open && line.startsWith('CALLER:')) {
      const turn = line.slice('CALLER:'.length).trim().toLowerCase();
      if (turn) out.push(turn);
    }
  }
  return out.slice(-MAX_LINES);
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
    // And the words people use for pain without saying "pain": "my eye is
    // killing me", "it's agony", "it's stabbing", "the worst", "unbearable"
    // (review r2 P2, #353).
    // "my head is pounding", "a headache", "it's on fire" (review r3 P3, #353).
    spoken:
      /\bpain|\bhurt|\bach(e|es|ing|y)\b|\bsore\b|\bsting|\bburn|\bthrob|\bpressure\b|\bkill|\bagon|\bstab|\bsharp|\bsevere|\bworst|\bterrible|\bexcruciat|\bunbearab|\bpound|\bheadache|\bon fire\b|\bdolor|\bduele|\barde|\bardor|\bmolest/,
  },
  {
    label: 'vision change',
    claim: /vision (change|loss|blurr)|blurr(ed|y) vision|can'?t see|cannot see|losing (my )?(sight|vision)|lost (my )?(sight|vision)/,
    // WIDE ON PURPOSE, because a miss here refuses an emergency. A caller who
    // lost their sight rarely says "vision": they say they went blind, lost
    // their EYESIGHT (`sight` takes no leading \b so it matches inside it),
    // everything went black or dark, a curtain or a shadow came down, it's
    // gone, or "estoy ciego", "no veo", "perdí la vista", "se me nubló",
    // "todo se puso negro" (review P1, #353). And hazy, foggy, fuzzy, milky,
    // wavy, distorted, it went white, halos (review r3 P3, #353).
    spoken:
      /\bhaz|\bfog|\bfuzz|\bmilk|\bwav|\bdistort|\bwent white\b|\bhalo|\bvision\b|\bsee\b|\bseeing\b|sight\b|\bblind|\bblurr?|\bcloudy\b|\bdouble\b|\bdark|\bblack|\bcurtain|\bshadow|\bveil\b|\bgone\b|\bspots?\b|\bfloaters?\b|\bflash|\bvista\b|\bver\b|\bveo\b|\bborros|\bcieg[oa]s?\b|\bnubl|\bcortina|\bsombra|\bnegr[oa]\b/,
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
   * calling from a doctor's office, hospital, ER, lab or clinic. See
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
export const CALLER_SYMPTOM = new RegExp(
  [
    String.raw`\b(pain|painful|hurt|hurts|hurting|ache|aching|sore|red|redness|swollen|swelling|blur|blurry|blurred|flash|flashes|floaters?|curtain|shadow|discharge|pus|bleed|bleeding|blood|pressure|itch|itchy|burning|watering|nausea|vomit\w*|fever|injur\w*|trauma|chemical|can'?t see|cannot see|can not see|vision (?:loss|change|changes|problem|problems)|lost (?:his |her |my |their )?(?:vision|sight)|dolor|duele|ardor|arde|rojo|roja|hinchad\w*|sangr\w*)\b`,
    // Every specific sight-loss word the vision evidence above counts, so the
    // two cannot drift apart again (review r2 P1, #353). The GENERIC words
    // that list also counts — "see", "vision", "dark", "gone", "ver" — are
    // left out, or "I want to see Doctor Shah" would be a symptom; they count
    // here only inside a phrase.
    String.raw`\b(?:blind|eyesight|cieg[oa]|nubl|cortina|sombra|borros|veil\b|cloudy\b|double vision)`,
    String.raw`\bwent (?:black|dark)\b|\b(?:all|everything) (?:went |is |turned )?(?:black|dark)\b|\btodo (?:se puso |est[aá] )?negro\b`,
    String.raw`\bit'?s (?:all |just )?gone\b|\bno (?:veo|puedo ver|ve)\b|\bperd[ií] la vista\b`,
    // Pain and injury in the caller's words, without the word "pain".
    String.raw`\bkilling me\b|\bagon|\bstab(?:bing|bed|s)?\b|\bexcruciat|\bunbearab`,
    // "flew in" and "scratch" only about an EYE: "my son flew in from Texas"
    // and "I scratched my glasses" are not symptoms (review r3 P3, #353).
    String.raw`\bflew in(?:to)? (?:my|the|his|her|their) eyes?\b|\bscratch\w*(?: [a-z']+){0,2} (?:eyes?|cornea)\b|\b(?:eyes?|cornea)(?: [a-z']+){0,2} scratch`,
    String.raw`\bgot hit\b|\bhit in (?:the|my) eye|\bpoked?\b|\bsplash|\bsomething in my eye|\bforeign (?:object|body)`,
  ].join('|'),
);

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
 *
 * A LABORATORY IS A PROVIDER FACILITY (operator, 2026-10-21: "add lab and
 * laboratory to the provider list"). The corpus call is
 * CA02cebe2231c3f8208c099c8736ea5c7a (2026-10-21 00:20 UTC): a reference lab
 * calling stat results for one of our doctors named itself, answered the
 * refusal's question with the lab's name and "lab", and was taken as a
 * message because "lab" was not a facility word. Since July, 4 of the 6
 * after-hours escalations from callers who said "lab" were labs calling in
 * results. Two shapes are kept OUT, both measured on the same calls:
 *  - an OPTICAL lab is a supplier chasing a frame, not a provider: "optical
 *    lab" does not count. (A lab that names itself without "optical" — "the
 *    Bartley lab" — still reads as a facility; none of those callers has
 *    escalated since July, and routine business has its own refusal.)
 *  - "lab results", "lab work", "lab test" are a patient's words about their
 *    own care, not a place: "I had lab work I'm calling about".
 * Every exclusion holds through the punctuation, sentence breaks and fillers
 * a spoken answer carries, in both languages: "The optical, uh, lab.",
 * "Lab, uh, results.", "Resultados, eh, del laboratorio.", "Llamo del
 * laboratorio, uh, óptico" (Codex r1 and r2 on #359 — each read as a provider
 * and rang the on-call phone). ONE gap is used at every place two words of an
 * exclusion meet, so a fifth adjacency cannot be missed. A sentence break
 * counts as a gap on purpose: "Example lab. Results for Dr. Lin." then does
 * not count on its own, and that caller is asked which facility — the
 * direction that does not wake the on-call provider.
 *
 * The gap takes ONE separator character or ONE filler word per repetition, so
 * a long run of dots or spaces cannot backtrack exponentially.
 */
const FILLER_GAP = String.raw`(?:[\s,.;:!?-]|uhh?|umm?|uhm|ahh?|erm|ehh?|mmm?)*`;
const LAB_WORD =
  String.raw`(?<!optical${FILLER_GAP})(?:laboratory|lab)` +
  String.raw`(?!${FILLER_GAP}(?:results?|work|tests?|reports?|draws?|orders?|values?|slips?|appointments?)\b)`;
const NOT_OPTICAL_ES = String.raw`(?!${FILLER_GAP}[oó]ptico)`;
const LABORATORIO =
  String.raw`(?<!(?:resultados?|an[aá]lisis|ex[aá]men(?:es)?|pruebas?|estudios?|[oó]rden(?:es)?|trabajos?|citas?)` +
  String.raw`${FILLER_GAP}(?:del|de(?:${FILLER_GAP}la)?)(?:${FILLER_GAP}el)?${FILLER_GAP})laboratorio${NOT_OPTICAL_ES}`;
const PROVIDER_ROLE =
  String.raw`(?:dr\.?|doctor|doctora|nurse|nurse practitioner|physician|physician assistant|surgeon|resident|` +
  String.raw`ophthalmologist|optometrist|np|pa|rn|md|charge nurse|(?:er|emergency(?: room)?) (?:doctor|physician|nurse))`;
const FACILITY =
  String.raw`(?:hospital|medical (?:center|group|office|clinic)|clinic|e\.? ?r\b\.?|emergency (?:room|department)|` +
  String.raw`urgent care|surgery center|surgical center|nursing (?:home|facility)|skilled nursing|` +
  String.raw`rehab(?:ilitation)? (?:center|facility)|doctor'?s office|(?:dr\.?|doctor) [a-z'-]+'?s office|` +
  String.raw`office of (?:dr\.?|doctor) [a-z'-]+|optometry|ophthalmology|eye (?:center|clinic|institute)|icu|intensive care|` +
  LAB_WORD + String.raw`)`;

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
 * doctor's patient", "I'm Dr. Shah's wife". Rejects a possessive straight
 * after the role, or after the role and one name, ONLY when what is possessed
 * is a patient or a family member. "I'm Dr. Kim's nurse" and "this is Dr.
 * Lee's surgical coordinator" are office staff and must still count (review
 * r2 P2, #353).
 */
const RELATIVE =
  String.raw`(?:wife|husband|spouse|partner|son|daughter|mother|father|mom|mum|dad|parents?|kids?|child|children|` +
  String.raw`grandson|granddaughter|grandmother|grandfather|grandma|grandpa|grandchild|brother|sister|aunt|uncle|` +
  String.raw`niece|nephew|boyfriend|girlfriend|friend|neighbou?r|family)\b`;
const NOT_THEIR_PROVIDER = String.raw`(?:patients?\b|${RELATIVE})`;
const NOT_POSSESSIVE = String.raw`(?!'?s ${NOT_THEIR_PROVIDER})(?!\.? ?[a-z-]+'s ${NOT_THEIR_PROVIDER})`;
const OFFICE_STAFF =
  String.raw`(?:nurse|ma|medical assistant|assistant|coordinator|surgical coordinator|surgery coordinator|office|staff|` +
  String.raw`tech|technician|scheduler|front desk)\b`;

/**
 * THE BARE ANSWER TO THE REFUSAL'S OWN QUESTION. Refusal 3 asks "Are you
 * calling from a doctor's office, a hospital or a clinic, and which one?",
 * and the natural answers are "Yes, Pomona Valley Hospital.", "Dr. Lee's
 * office.", "St. Joe's ER.", "Sí, del hospital." — none of which carries a
 * lead-in the patterns below need (review r2 P2, #353).
 *
 * So a WHOLE caller turn that is nothing but an optional yes, an optional
 * "from"/"del", up to four name words and a facility counts. Anchored to the
 * whole turn, and the name words exclude pronouns, verbs and prepositions, so
 * "my husband is in the hospital", "he's in the hospital" and "I was at the
 * hospital yesterday" do not.
 */
const NAME_TOKEN =
  String.raw`(?!(?:i|i'?m|he|he'?s|she|she'?s|we|they|my|his|her|our|their|is|was|were|are|am|be|been|in|at|to|on|of|for|from|about|with|went|go|going|this|that|it|it'?s|a|an|and|but|not|no|bill|bills|billing|records?|visit|stay|yesterday|today|tonight|tomorrow|last|ago|there|here|mi|su|en|es|esta|está|estoy|ayer|hoy)(?![a-z0-9'&-]))[a-z0-9'&.-]+`;
const NAME_WORD = String.raw`${NAME_TOKEN} `;
const ANY_FACILITY = String.raw`(?:${FACILITY}|cl[ií]nica|consultorio|${LABORATORIO}|sala de emergencias?)(?![a-z])`;
/**
 * Also widened in review r3 (#353), because STT and real answers are messier
 * than the first form: fillers ("Yeah, uh, Pomona Valley Hospital."), a
 * subject before the answer ("Yes I am, …", "Yeah, it's Kaiser hospital."),
 * the facility FIRST ("Hospital, Kaiser Fontana.", "The ER at Cedars.",
 * "Hospital — Cedars-Sinai.") and a name after it ("Sí, del Hospital
 * General."). Still anchored to the whole turn, and every name word still
 * excludes pronouns, verbs, prepositions and time words.
 */
const BARE_FACILITY_ANSWER = new RegExp(
  String.raw`^(?:(?:yes|yeah|yep|yup|s[ií])(?![a-z])[,.!]?\s*)?` +
    String.raw`(?:(?:i am|i'?m|it is|it'?s|we are|we'?re|this is)(?![a-z])[,.!]?\s+)?` +
    String.raw`(?:(?:from|calling from|with) |del |de la |desde (?:el |la )?)?(?:the |el |la )?` +
    String.raw`(?:${NAME_WORD}){0,4}?` +
    ANY_FACILITY +
    String.raw`(?:(?:\s*,\s*|\s+(?:at|in|de|del)\s+|\s+)(?:the |el |la )?${NAME_TOKEN}(?: ${NAME_TOKEN}){0,3})?` +
    String.raw`[\s.,!?]*$`,
);

/** Lowercase, straight apostrophes, dashes to commas, STT fillers out. */
function normaliseAnswer(line: string): string {
  return line
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s*[—–]\s*|\s+-\s+/g, ', ')
    .replace(/\b(?:uh+|um+|uhm|ah+|hmm+|erm)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,(?:\s*,)*\s*/g, ', ')
    .replace(/^[,\s]+/, '')
    .trim();
}

/**
 * A FACILITY WORD THE CALLER DENIES OR ASKS FOR IS NOT AN ANSWER (review r4
 * P2, #353). Refusal 3's question is put to the very callers the ruling is
 * about — a patient the model wrote up as a clinician, a patient asking for
 * their own doctor — and their natural replies echo the question's words:
 * "No, I'm not calling from a hospital", "No, I'm a patient of the Covina
 * clinic", "I want Dr. Shah's office", "No, no llamo de un hospital". Each of
 * those counted, and a provider answer rings the on-call phone ahead of every
 * other check.
 *
 * "Doctor Shah's office, please." is ambiguous as the answer to "which one?",
 * but "please" asks for something, and a provider names where they ARE; read
 * it as a want, the direction that does not wake the on-call provider.
 * "Dr. Lee's office." with no "please" still counts.
 */
const REFUSAL_OPENER = /^(?:no|nope|nah|not)(?![a-z])/;
/**
 * Review r5 P2 (#353): a want is read only from the words that GOVERN the
 * facility (the governor, an article, at most three name words straight
 * before it), never from the rest of its sentence. "Yes, calling about a
 * patient from Kaiser Fontana ER." governs the ER with "from", so it answers;
 * "I need Dr. Shah's office" and "I want the Covina clinic" still want it.
 * "calling for" is staff speaking for their doctor ("I'm calling for Dr. Lee's
 * office"), so like "work for" it is not a want.
 *
 * Review r7 P2 (#353): "would like" and a causative "have/get" are wants too —
 * "I'd like the doctor's office to call me back", "Please have the Covina
 * clinic call me", "Could you get the doctor's office to call me", "me
 * gustaría que la clínica me llame", "que me llame el consultorio". The
 * causative counts only as a REQUEST (after please / can you / could you /
 * would you, or opening its sentence: "Have the Covina clinic call me"),
 * because "we have a patient from Kaiser ER" is a provider.
 */
const WANTS_IT = new RegExp(
  String.raw`(?:^|[^a-z])(?:want|wanna|need|(?:i'?d|we'?d|would) like|(?:(?:please|can you|could you|would you) |(?<![a-z] ))(?:have|get)|looking for|trying to (?:reach|get)|speak (?:to|with)|talk (?:to|with)|` +
    String.raw`me gustar[ií]a|que me llamen?|` +
    String.raw`patient (?:of|at|with)|about|soy paciente(?: de| del)?|quiero|necesito|busco|` +
    String.raw`(?<!\b(?:work|works|working|calling) )for)` +
    String.raw`(?: (?:the|a|an|to|el|la|un|una|al|del|de))?(?: ${NAME_TOKEN}){0,3}[\s,]*$`,
);
/**
 * "FROM" IS NOT ALWAYS "I AM CALLING FROM". Narrowing the want to the words
 * governing the facility let "from" stand for the caller's own facility even
 * when the caller WANTS something from it — "I need someone from the Covina
 * clinic to call me", "I need my results from the Pasadena clinic, please" —
 * or tells what it did to them — "They sent me home from Kaiser hospital", "I
 * was told to call by the Covina clinic". Each is a patient replying to the
 * facility question, and each rang the on-call phone. A facility is not an
 * answer when it is governed by:
 *  - "from" (or "de/del/desde") straight after a want and a short object
 *    ("need someone from", "want a call from", "necesito que alguien de");
 *  - "from" after "me" ("sent me home from", "discharged me from");
 *  - "by" — the facility as the one acting on the caller.
 * "about" is not a want here: "calling about a patient from Kaiser Fontana ER"
 * is a provider's answer. A provider who says where they are calling from is
 * also read by the self-identification patterns, which this does not touch.
 * "like", "talk", "speak" and "hablar" are wants too ("I'd like to talk to
 * somebody from the Covina clinic", review r6 P2).
 */
const WANTS_FROM_IT = new RegExp(
  String.raw`(?:(?:^|[^a-z])(?:want|wanna|need|needs|like|talk|speak|looking for|trying to (?:reach|get)|quiero|necesito|busco|hablar)(?: [a-z'\u00e0-\u00ff-]+){1,3} (?:from|de|del|desde)` +
    String.raw`|(?:^|[^a-z])me(?: [a-z'-]+){0,2} from|(?:^|[^a-z])by)` +
    String.raw`(?: (?:the|a|an|el|la|un|una))?(?: ${NAME_TOKEN}){0,3}[\s,]*$`,
);
/**
 * Review r6 P2 (#353): two more shapes are not an answer, whatever governs the
 * facility:
 * - a first-person possessive straight before it ("I just want MY doctor's
 *   office to call me back", "quiero que me llame mi clínica"); a provider
 *   says "our" or "the";
 * - "calling for my husband / mi esposo …": a relative, not a provider. A
 *   relative only: "calling for my patient from Methodist Hospital ER" is a
 *   clinician (review r7 P2).
 */
const MY_FACILITY = new RegExp(String.raw`(?:^|[^a-z])(?:my|mi|mis)(?: ${NAME_TOKEN}){0,2}[\s,]*$`);
const CALLING_FOR_A_RELATIVE = new RegExp(String.raw`\bcalling for (?:my|mi) ${RELATIVE}`);
/**
 * "please" asks for something only when it is all the turn adds to a bare
 * facility ("Doctor Shah's office, please."). "Yes, Pomona Valley Hospital ER,
 * please have the on-call call me back." answers, then asks (review r5 P2).
 */
const PLEASE_AROUND = /^(?:please|por favor),?\s+|,?\s*(?:please|por favor)[\s.!]*$/;
function asksForItAlone(text: string): boolean {
  const bare = text.replace(PLEASE_AROUND, '').trim();
  return bare !== text && BARE_FACILITY_ANSWER.test(bare);
}
/** A sentence end that is not an abbreviation's dot ("Dr.", "St."). */
const SENTENCE_END = /(?<!\b(?:dr|st|mr|mrs|ms|mt|jr|sr))[.?!]\s/g;

/** The sentence holding text[start, end), from its beginning up to end. */
function clauseThrough(text: string, start: number, end: number): string {
  let from = 0;
  for (const m of text.slice(0, start).matchAll(SENTENCE_END)) from = (m.index ?? 0) + m[0].length;
  return text.slice(from, end);
}

/**
 * The caller refuses the facility, denies it, or names it as what they want.
 * The negator test is DENIES (below), the one negation list, scoped to the
 * facility's own sentence so "Sorry, I can't hear you well. Yes, Pomona Valley
 * Hospital." still answers; a turn that OPENS with a refusal is refused
 * whatever follows.
 */
function deniesOrWantsTheFacility(text: string, start: number, end: number): boolean {
  if (REFUSAL_OPENER.test(text) || asksForItAlone(text)) return true;
  const clause = clauseThrough(text, start, end);
  const governing = clauseThrough(text, start, start);
  return (
    DENIES.test(clause) ||
    CALLING_FOR_A_RELATIVE.test(clause) ||
    WANTS_IT.test(governing) ||
    WANTS_FROM_IT.test(governing) ||
    MY_FACILITY.test(governing)
  );
}

function answersWithAFacility(line: string): boolean {
  const text = normaliseAnswer(line);
  if (!BARE_FACILITY_ANSWER.test(text)) return false;
  const hit = FACILITY_ANYWHERE.exec(text);
  return !deniesOrWantsTheFacility(text, hit?.index ?? text.length, text.length);
}

/**
 * INSIDE A PROVEN ANSWER WINDOW — the caller's turn after the agent asked
 * refusal 3's question — a facility word anywhere in the turn is the answer.
 * Three shapes still are not: a person who IS somewhere ("my husband is in
 * the hospital", "I was at the ER yesterday", "mi esposo está en el
 * hospital"), a bare "At the hospital." with no name, and a question back
 * ("Is this Dr. Lee's office?").
 */
const FACILITY_ANYWHERE = new RegExp(String.raw`(?:^|[^a-z])${ANY_FACILITY}`);
const SOMEONE_AT_A_FACILITY = new RegExp(
  String.raw`\b(?:i|he|she|they|you|my|his|her|their|mi|su|[eé]l|ella|yo)\b[^.?!]*?` +
    String.raw`\b(?:in|at|to|into|en|al|a la)\s+(?:the |el |la |a |an )?(?:[a-z0-9'&.-]+ ){0,3}?${ANY_FACILITY}`,
);
const BARE_AT_A_FACILITY = new RegExp(String.raw`^(?:at|in|en|al) (?:the |el |la )?${ANY_FACILITY}[\s.,!?]*$`);
const ASKS_BACK = /^(?:is|are|was|do|does|can|could|es|est[aá])\b[^?]*\?/;
/**
 * A NO IS NOT A YES. The question is a yes-or-no question, and a patient's
 * answer to it names the facility while denying it: "No, I'm not calling from
 * a hospital", "No, I'm a patient of the Pasadena clinic", "Nope, not a
 * hospital", "No soy de una clínica, soy paciente". Read as a facility
 * answer, each of those rang the on-call phone for a patient — the ruling
 * this window exists to serve, reversed. Any negator in the turn refuses it:
 * a provider answering the question does not say no, and one who somehow
 * does is asked again or taken as a message, the ruling's safe direction.
 */
const DENIES = /(?:^|[^a-z])(?:no|nope|nah|not|never|neither|none|nunca|tampoco|ni)(?![a-z])|n't(?![a-z])/;

function answerNamesAFacility(turn: string): boolean {
  const text = normaliseAnswer(turn);
  const hit = FACILITY_ANYWHERE.exec(text);
  if (!hit) return false;
  if (ASKS_BACK.test(text) || BARE_AT_A_FACILITY.test(text) || SOMEONE_AT_A_FACILITY.test(text)) return false;
  return !deniesOrWantsTheFacility(text, hit.index, hit.index + hit[0].length);
}

const PROVIDER_SELF_IDENTIFICATION: RegExp[] = [
  // "this is Dr. Brown", "this is an emergency room doctor"
  new RegExp(String.raw`\b(?:this is|i'?m|i am)\s+(?:a |an |the |your )?${STRONG_ROLE}\b${NOT_POSSESSIVE}`),
  // "I'm a PA calling", "I'm the resident on call", "I'm an NP with the clinic"
  new RegExp(
    String.raw`\b(?:this is|i'?m|i am)\s+(?:a |an |the |your )?${AMBIGUOUS_ROLE}\b` +
      String.raw`(?: [a-z-]+)?? (?:calling|on call|from|with|at|on behalf)\b`,
  ),
  // "I'm Dr. Kim's nurse", "this is Dr. Lee's surgical coordinator", "I'm
  // Doctor Patel's MA, calling about a patient" — office staff naming their
  // doctor (review r2 P2, #353).
  new RegExp(
    String.raw`\b(?:this is|i'?m|i am)\s+(?:a |an |the |your )?${STRONG_ROLE}(?:\.? ?[a-z-]+)?'s ${OFFICE_STAFF}`,
  ),
  // "my name is Doctor Perez"
  new RegExp(String.raw`\bmy name is (?:a |an |the )?${PROVIDER_ROLE}\b${NOT_POSSESSIVE}`),
  // "referring doctor on the phone", "a doctor calling"
  new RegExp(String.raw`\b${PROVIDER_ROLE} (?:here|calling|on the (?:phone|line))\b`),
  // "calling from St. Joe's emergency room", "speaking on behalf of a clinic"
  new RegExp(
    String.raw`\b(?:calling|speaking|reaching out)\s+(?:from|with|on behalf of)\s+(?:the |a |an |our )?` +
      String.raw`(?:${NAME_WORD}){0,5}?${FACILITY}(?![a-z])`,
  ),
  // "this is the emergency room", "this is St. Joe's hospital"
  new RegExp(String.raw`\bthis is (?:the |a |an )?(?:${NAME_WORD}){0,4}?${FACILITY}(?![a-z])`),
  // "the emergency room at Huntington calling"
  new RegExp(String.raw`${FACILITY}(?![a-z])(?: [a-z0-9'&.-]+){0,3} calling\b`),
  // "I'm with the ER", "we're from the clinic"
  new RegExp(String.raw`\b(?:i'?m|i am|we'?re|we are) (?:from|with) (?:the |a |an )?(?:${NAME_WORD}){0,5}?${FACILITY}(?![a-z])`),
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
  new RegExp(
    String.raw`\b(?:llamo|hablo|estoy llamando|le llamo|le hablo|llamamos|hablamos) (?:de|del|desde) (?:el |la |un |una )?(?:[a-z\u00e0-\u00ff'.-]+ ){0,4}?` +
      String.raw`(?:hospital|cl[ií]nica|consultorio|laboratorio${NOT_OPTICAL_ES}|sala de emergencias?|emergencias|centro m[eé]dico|oficina del (?:doctor|dr\.?))`,
  ),
  /\b(?:nuestr[oa]|tengo un[a]?) paciente\b/,
];

/**
 * Pure, for tests: does this caller text identify the caller as a provider?
 * Given the caller's turns one by one, a turn that is only a facility answer
 * ("Yes, Pomona Valley Hospital.") counts too; a single string is one turn.
 */
export function callerSaysTheyAreAProvider(spoken: string | readonly string[]): boolean {
  const turns = typeof spoken === 'string' ? [spoken ?? ''] : spoken;
  const text = ` ${turns.join(' ').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')} `;
  return PROVIDER_SELF_IDENTIFICATION.some((re) => affirmed(text, re)) || turns.some(answersWithAFacility);
}

/**
 * A self-identification the caller DENIED is not one. "I'm not calling from a
 * hospital", "no llamo de una clínica" and "this is not the hospital" all
 * contain a pattern above, and each is a patient answering refusal 3's
 * question — read as a provider, the on-call phone rang for them. A match is
 * refused when a negator sits inside it or straight before it (one word may
 * come between: "not really calling from").
 *
 * "NO" IS A NEGATOR ONLY IN SPANISH. In English it opens a sentence as an
 * interjection — "No this is the ER at Huntington", "No it's Dr. Lee from the
 * emergency room", answering "are you the patient?" — and refusing those turned
 * a real clinician away, comma or no comma. In Spanish it negates the verb
 * straight after it ("no llamo de", "no soy", "no tengo"), so it counts there
 * and only there.
 */
const NEGATED_BEFORE = /(?:^|[^a-z])(?:not|never|n't)\s+(?:[a-z']+\s+)?$/;
const SPANISH_VERB_FIRST = /^(?:soy|llamo|hablo|estoy|le |llamamos|hablamos|tengo)\b/;
const NO_STRAIGHT_BEFORE = /(?:^|[^a-z])no\s+$/;
function affirmed(text: string, re: RegExp): boolean {
  // Every occurrence, not only the first: in "I'm not calling from Mercy. I'm
  // calling from St. Joe's hospital." the second one stands.
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...text.matchAll(all)].some((m) => {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 24), at);
    if (DENIES.test(m[0]) || NEGATED_BEFORE.test(before)) return false;
    return !(SPANISH_VERB_FIRST.test(m[0]) && NO_STRAIGHT_BEFORE.test(before));
  });
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
    providerStated:
      callerSaysTheyAreAProvider(callId ? (callerSpeech.get(callId) ?? []) : []) ||
      (callId ? (providerAnswers.get(callId) ?? []) : []).some(answerNamesAFacility),
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
