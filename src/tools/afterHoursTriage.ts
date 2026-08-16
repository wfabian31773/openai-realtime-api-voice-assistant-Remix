/**
 * ONE QUESTION, THEN A DECISION — the after-hours triage table.
 *
 * WHY THIS EXISTS
 *
 * Operator, 2026-08-13: *"the agent should triage and should be able to
 * determine what's truly urgent. Right now it seems like we're just going off
 * of keywords... I don't want the agent to be [a clinician] completely, but
 * let's put some logic into this at least."*
 *
 * He is describing a real defect. Urgency was decided by matching against a
 * flat list of twelve phrases in `config/knowledgeBase.ts`, and two entries on
 * that list give the game away:
 *
 *     'new floaters (especially with flashes)'
 *     'eye redness with severe pain'
 *
 * Those are not symptoms. They are CONDITIONALS written as prose, because the
 * list has no way to express "this word only means an emergency when that
 * other thing is also true". A model matching phrases cannot act on a
 * parenthesis. So the practice's own clinical knowledge was in the file and
 * unreachable.
 *
 * THE RULE THIS ENCODES, AND ITS LIMIT
 *
 * The question decides WHICH category. By default it does NOT decide whether
 * the call is urgent: asking only routes it to the right named reason.
 * Downgrading on an answer is the dangerous direction — an agent that can talk
 * a caller out of an emergency is a much worse product than one that
 * occasionally over-flags. After hours, a false positive is a ticket marked
 * urgent that was not. A false negative is a retinal detachment that waited
 * until morning.
 *
 * ONE EXCEPTION, added 2026-08-15 by operator ruling: *"redness should be
 * answer driven, leave bleeding and injury alone."*
 *
 * A presentation may carry `answerDecidesUrgency` when the presenting word
 * covers a large benign population and the discriminator is the whole of what
 * makes it serious. Redness is the only one today — conjunctivitis and a dozen
 * harmless causes are indistinguishable over the phone, and the practice's own
 * list already paired it as "eye redness with severe pain". Bleeding, injury
 * and detachment symptoms are deliberately NOT eligible: there is no benign
 * majority to protect there.
 *
 * Note what still escalates under the exception: any branch cue the caller
 * affirms. Red eye with pain, with a vision change, or after surgery all route
 * urgent. Only a caller answering NO to all of them becomes a callback — which
 * is what the 2026-08-15 10:20 caller wanted and asked for in her first
 * sentence, before the agent asked her a two-part question and reported both
 * halves as symptoms she never mentioned.
 *
 * NOTHING CLINICAL IS INVENTED HERE. Every destination is one of the
 * practice's own type-34 reasons, and every discriminator is a question of
 * FACT that a receptionist may ask — was there an injury, has your vision
 * changed, did you have surgery. None of them is a diagnosis. The agent never
 * says what it thinks is wrong.
 *
 * THE ONE GAP THAT REMAINS OPEN. There is no reason for bleeding on request
 * type 34, on either side — the ticketing agent found the same hole in their
 * table on 2026-08-13 and refused to invent a word for it, correctly. Until a
 * clinician rules, bleeding that clears every other discriminator files as 551
 * at urgent priority with the caller's words in the description. That is the
 * honest available box, not the right one.
 */
import { fold } from './queueRouting';

export interface TriageBranch {
  /** Words in the ANSWER that select this destination. */
  cues: string[];
  requestReasonId: number;
  requestReason: string;
}

export interface TriagePresentation {
  key: string;
  /** What the caller said that cannot be routed on its own. */
  cues: string[];
  /** The ONE question to ask. English, and the Spanish the line also takes. */
  ask: string;
  askEs: string;
  /** Why the word alone is not enough. Shown to nobody; read by the next person. */
  why: string;
  /** Answers, most specific first. */
  branches: TriageBranch[];
  /** Where it lands when the answer names none of the above. */
  fallbackReasonId: number;
  fallbackReason: string;
  /**
   * MAY A "NO" CLEAR THE URGENCY? Default false — the answer picks the
   * category and never clears the flag.
   *
   * Operator ruling 2026-08-15, after a red-eye-with-discharge call paged the
   * on-call provider: *"redness should be answer driven, leave bleeding and
   * injury alone."*
   *
   * Set ONLY where the presenting word covers a large benign population and
   * the discriminator is what makes it serious. Redness qualifies:
   * conjunctivitis and a dozen harmless causes look identical over the phone,
   * and the practice's own list already pairs it — "eye redness with severe
   * pain". Bleeding, injury and detachment symptoms do NOT: there is no
   * benign majority to protect, and a false negative there is the retinal
   * detachment that waited until morning.
   */
  answerDecidesUrgency?: boolean;
}

/** Destinations, all of them existing department 8 / type 34 reasons. */
const INJURY = { requestReasonId: 162, requestReason: 'Eye Injury/Trauma' };
const VISION = { requestReasonId: 161, requestReason: 'Sudden Vision Loss' };
const DETACH = { requestReasonId: 165, requestReason: 'Retinal Detachment Symptoms' };
const PAIN = { requestReasonId: 163, requestReason: 'Severe Eye Pain' };
const POSTOP = { requestReasonId: 160, requestReason: 'Post-Surgery Complication' };
/** "Urgent Request - Symptom Not Specified" — the interim home. See the header. */
const UNSPECIFIED = { requestReasonId: 551, requestReason: 'Urgent Request - Symptom Not Specified' };

const INJURY_CUES = ['hit', 'poked', 'scratch', 'injur', 'accident', 'fell', 'foreign', 'something went in',
  'golpe', 'lastim', 'accidente', 'me pegue', 'me pegué', 'se me metio', 'se me metió'];
const VISION_CUES = ['cannot see', "can't see", 'lost my vision', 'lost vision', 'vision is worse', 'blurry',
  'blurred', 'went dark', 'cannot read', 'double vision', 'no puedo ver', 'borroso', 'perdi la vista', 'vision doble'];
const DETACH_CUES = ['flash', 'curtain', 'shadow', 'veil', 'floater', 'destello', 'cortina', 'sombra', 'moscas'];
const PAIN_CUES = ['pain', 'hurts', 'hurting', 'painful', 'burning', 'aching', 'dolor', 'duele', 'arde'];
const POSTOP_CUES = ['surgery', 'operation', 'operated', 'post-op', 'post op', 'cirugia', 'operacion', 'me operaron'];

export const AFTER_HOURS_TRIAGE: TriagePresentation[] = [
  {
    key: 'bleeding',
    // The gap the ticketing agent found in their table and I then found in
    // mine. Before today every one of these filed as General/Other, NOT
    // urgent, on the line that answers at 2am.
    cues: ['bleeding', 'bleed', 'blood', 'hemorrhag', 'haemorrhag', 'sangre', 'sangrado', 'sangrando'],
    ask: 'Was there any injury to the eye?',
    askEs: '¿Hubo alguna lesión en el ojo?',
    why:
      'Blood in or around the eye spans a subconjunctival haemorrhage, which looks ' +
      'alarming and resolves on its own, to a hyphema or a vitreous bleed, which do not. ' +
      'The word carries none of that. Injury, vision change and recent surgery are the ' +
      'facts that separate them, and a caller can answer all three.',
    branches: [
      { cues: POSTOP_CUES, ...POSTOP },
      { cues: INJURY_CUES, ...INJURY },
      { cues: VISION_CUES, ...VISION },
      { cues: PAIN_CUES, ...PAIN },
    ],
    ...UNSPECIFIED_FALLBACK(),
  },
  {
    key: 'floaters',
    // Already a conditional on the practice's own list — "new floaters
    // (especially with flashes)" — and unreachable as a phrase match.
    cues: ['floater', 'spots in my vision', 'black spots', 'specks', 'moscas volantes', 'manchas'],
    ask: 'Are you also seeing any flashes of light, or a shadow or curtain across your vision?',
    askEs: '¿También ve destellos de luz, o una sombra o cortina en su visión?',
    why:
      'Floaters alone are extremely common and usually benign. Floaters WITH flashes ' +
      'or a curtain are the classic retinal detachment presentation. The practice list ' +
      'already said so in a parenthesis that nothing could act on.',
    branches: [
      { cues: DETACH_CUES, ...DETACH },
      { cues: VISION_CUES, ...VISION },
    ],
    ...UNSPECIFIED_FALLBACK(),
  },
  {
    key: 'redness',
    // The other conditional already on the list: "eye redness with severe pain".
    cues: ['red eye', 'my eye is red', 'redness', 'bloodshot', 'ojo rojo', 'enrojecimiento'],
    /**
     * ONE QUESTION, AND IT USED TO BE TWO.
     *
     * This read "Is there any pain with it, and has your vision changed at
     * all?" — a compound question inside the very taxonomy whose prompt says
     * "ask ONE question, do not stack them". The agent obeyed it verbatim on
     * call d30ca58b (2026-08-15 10:20 PT), got a single "Yes", and paged the
     * on-call provider with "red eye with pain and vision changes reported".
     * The caller had said DISCHARGE and asked for a callback. She never
     * mentioned pain and never mentioned her vision.
     *
     * Operator: *"This is not a reason for the agent to pass the call through
     * as urgent."*
     *
     * A yes to a two-part question answers neither part. If the vision
     * discriminator is needed it is a SEPARATE turn — and the branch list
     * below already routes on VISION_CUES when the caller raises it in their
     * own words.
     */
    ask: 'Is there any pain with it?',
    askEs: '¿Tiene dolor?',
    why:
      'Redness alone covers conjunctivitis and a dozen harmless causes. Redness with ' +
      'severe pain or vision change is a different call entirely, and the practice list ' +
      'already paired them.',
    branches: [
      { cues: PAIN_CUES, ...PAIN },
      { cues: VISION_CUES, ...VISION },
      { cues: POSTOP_CUES, ...POSTOP },
    ],
    // The operator's ruling. A red eye whose owner reports no pain, no vision
    // change and no recent surgery is a callback, not a page at 2am.
    answerDecidesUrgency: true,
    ...UNSPECIFIED_FALLBACK(),
  },
];

function UNSPECIFIED_FALLBACK() {
  return { fallbackReasonId: UNSPECIFIED.requestReasonId, fallbackReason: UNSPECIFIED.requestReason };
}

/**
 * NEGATION, which is the whole reason a keyword list cannot do this job.
 *
 * We ask "was there any injury, and has your vision changed?" — so the answers
 * are full of the very words we are looking for, in the negative. Caught by
 * the first run of this file's own tests:
 *
 *   "no injury but my vision is blurry now"  matched INJURY, not vision
 *   "no flashes"                             matched RETINAL DETACHMENT
 *
 * Both are the failure a yes/no question invites, and neither is findable by
 * reading the cue list — the cue is right, its position is wrong.
 *
 * Look back a short window before each hit. A negator inside it means the
 * caller said the opposite. The window is deliberately SHORT (a clause, not a
 * sentence) so that "I have no pain but there is blood" still affirms blood.
 */
const NEGATORS = [
  'no', 'not', "n't", 'nt', 'never', 'without', 'denies', 'deny', 'nothing', 'none',
  'sin', 'ningun', 'ninguna', 'nada', 'tampoco',
];
const NEGATION_WINDOW = 16;

function isNegated(text: string, at: number): boolean {
  const start = Math.max(0, at - NEGATION_WINDOW);
  const window = text.slice(start, at);
  // A clause break resets it — "no pain, but there is blood" affirms blood.
  const afterBreak = window.split(/[,;]| but | pero | and | y /).pop() ?? window;
  return NEGATORS.some((n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(afterBreak));
}

/** True when the cue appears and is NOT inside a negated clause. */
export function affirms(text: string, cue: string): boolean {
  const t = fold(text);
  const c = fold(cue);
  if (!c) return false;
  let i = t.indexOf(c);
  while (i !== -1) {
    if (!isNegated(t, i)) return true;
    i = t.indexOf(c, i + 1);
  }
  return false;
}

/** The presentation this text needs a question for, or null. */
export function triageNeededFor(text: string): TriagePresentation | null {
  if (!String(text ?? '').trim()) return null;
  for (const p of AFTER_HOURS_TRIAGE) {
    if (p.cues.some((c) => affirms(text, c))) return p;
  }
  return null;
}

/**
 * UNCERTAINTY IS NOT A DENIAL.
 *
 * "I don't know", "no idea", "not sure" all contain a negator and none of them
 * says the symptom is absent. Neither does silence, nor a garbled answer. The
 * prompt has always said "if they cannot answer, or the answer is unclear,
 * treat it as urgent" — this is the code half of that promise, and it is what
 * stops `answerDecidesUrgency` turning a failed question into a downgrade.
 */
const UNCERTAINTY = [
  'idea', 'know', 'sure', 'maybe', 'perhaps', 'possibly', 'think so', 'guess',
  'no se', 'no sé', 'quizas', 'quizás', 'tal vez', 'creo',
];

/**
 * Did the caller clearly say NO to the discriminator?
 *
 * Deliberately strict: an explicit negator, and no hedge. Anything else — an
 * empty answer, "asdfgh", "it is fine", "I don't think so" — leaves the call
 * urgent. Over-flagging is the cheap mistake here and this is the one place in
 * the file that can lower a flag.
 */
export function isClearDenial(answer: string): boolean {
  const raw = String(answer ?? '').toLowerCase().trim();
  const t = fold(raw).trim();
  if (!t) return false;
  if (UNCERTAINTY.some((u) => t.includes(fold(u)))) return false;
  /**
   * Contracted negatives, checked on the RAW text before folding.
   *
   * "it doesn't hurt and I can see fine" is as plain a denial as English
   * offers, and it was landing as urgent: fold() drops the apostrophe, leaving
   * "doesnt", where the standalone-word test for "nt" cannot fire. Caught by
   * this file's own tests rather than by reading the regex.
   */
  if (/\b\w+n['’]?t\b/.test(raw)) return true;
  return NEGATORS.some((n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(t));
}

/**
 * Route a presentation once the caller has answered.
 *
 * URGENT BY DEFAULT. The answer picks the category and does not clear the
 * flag — a false positive after hours is a ticket marked urgent that was not,
 * a false negative is a retinal detachment that waited until morning.
 *
 * THE ONE EXCEPTION, by operator ruling on 2026-08-15: a presentation carrying
 * `answerDecidesUrgency` may come back NOT urgent when the caller affirms none
 * of its discriminators. Today that is redness alone, and only redness.
 *
 *   *"redness should be answer driven, leave bleeding and injury alone."*
 *
 * Note what still escalates: any branch cue the caller affirms. A red eye with
 * pain routes to Severe Eye Pain, with blurred vision to Sudden Vision Loss,
 * after surgery to Post-Surgery Complication. Only the caller answering NO to
 * all of them lands as a routine callback — which is what the 10:20 caller
 * actually wanted, and asked for in her first sentence.
 */
export function resolveTriage(
  presentation: TriagePresentation,
  answer: string,
): { requestTypeId: 34; requestReasonId: number; requestReason: string; urgent: boolean } {
  for (const b of presentation.branches) {
    if (b.cues.some((c) => affirms(answer ?? '', c))) {
      return { requestTypeId: 34, requestReasonId: b.requestReasonId, requestReason: b.requestReason, urgent: true };
    }
  }
  return {
    requestTypeId: 34,
    requestReasonId: presentation.fallbackReasonId,
    requestReason: presentation.fallbackReason,
    // Downgrade ONLY on an explicit denial. Silence, a garbled answer or a
    // hedge all stay urgent — see isClearDenial.
    urgent: !(presentation.answerDecidesUrgency && isClearDenial(answer)),
  };
}

/**
 * The block rendered into the after-hours prompt.
 *
 * GENERATED FROM THE TABLE, including which presentations the answer may
 * downgrade. The compound-question defect on 2026-08-15 happened because the
 * prompt said "ask ONE question, do not stack them" while the table shipped
 * "is there any pain with it, AND has your vision changed?" — the model obeyed
 * the data. Prose and data must not be able to disagree, so both the questions
 * and the urgency rule below come from the same objects.
 */
export function renderTriagePrompt(): string {
  const line = (p: TriagePresentation) =>
    `- If they mention ${p.cues.slice(0, 3).join(', ')}: ask exactly one question —\n` +
    `  "${p.ask}"\n` +
    `  (Spanish: "${p.askEs}")` +
    (p.answerDecidesUrgency ? '\n  → THE ANSWER DECIDES. See below.' : '');

  const items = AFTER_HOURS_TRIAGE.map(line).join('\n');

  const alwaysUrgent = AFTER_HOURS_TRIAGE.filter((p) => !p.answerDecidesUrgency);
  const answerDriven = AFTER_HOURS_TRIAGE.filter((p) => p.answerDecidesUrgency);

  const answerDrivenBlock = answerDriven.length
    ? `
THESE ONES THE ANSWER DECIDES: ${answerDriven.map((p) => p.key).join(', ')}.

If the caller affirms ANY of the things you asked about — pain, a vision
change, recent surgery — it is urgent and you hand it off.

If they say NO, it is NOT urgent. Take it as a normal callback request with
create_ticket, in their own words, and tell them the team will call them back.
Do not page the on-call provider, and do not write down a symptom they did not
describe. A red eye with discharge and no pain is the ordinary reason people
ring this line.
`
    : '';

  return `# TRIAGE — ASK ONE QUESTION, THEN DECIDE

Some things a caller says do not tell you how serious they are. For these, ask
ONE short question, WAIT for the answer, and let the answer decide. Ask ONE.
Never join two questions with "and" — a caller who says "yes" to a two-part
question has answered neither, and you must not record both as reported.

${items}

THESE ONES STAY URGENT HOWEVER THEY ARE ANSWERED: ${alwaysUrgent.map((p) => p.key).join(', ')}.
The question only decides WHICH kind of urgent, so the right person gets it. If
they answer "no" to everything, it is still urgent and you still hand it off —
you simply have less to tell the on-call team.
${answerDrivenBlock}
YOU ARE NOT DIAGNOSING. Ask the question, take the answer in their own words,
and pass it on. Never say what you think is wrong, never reassure them that it
sounds minor, and never tell them it can wait. If they cannot answer, or the
answer is unclear, treat it as urgent and move on.

IF THEY DESCRIBE AN EMERGENCY, THE QUESTION CAN WAIT. Chemical in the eye, an
injury that just happened, sudden total vision loss — hand off first.`;
}
