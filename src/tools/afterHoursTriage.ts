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
 * The question decides WHICH category, never WHETHER it is urgent. Every
 * presentation below stays urgent on this line no matter how it is answered;
 * asking only routes it to the right named reason. Downgrading on an answer is
 * the dangerous direction and is deliberately not built — an agent that can
 * talk a caller out of an emergency is a different and much worse product than
 * one that occasionally over-flags. After hours, a false positive is a ticket
 * marked urgent that was not. A false negative is a retinal detachment that
 * waited until morning.
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
  /** Where it lands when the answer names none of the above. Always urgent. */
  fallbackReasonId: number;
  fallbackReason: string;
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
 * Route a presentation once the caller has answered.
 *
 * ALWAYS urgent. The answer picks the category; it never clears the flag.
 */
export function resolveTriage(
  presentation: TriagePresentation,
  answer: string,
): { requestTypeId: 34; requestReasonId: number; requestReason: string; urgent: true } {
  for (const b of presentation.branches) {
    if (b.cues.some((c) => affirms(answer ?? '', c))) {
      return { requestTypeId: 34, requestReasonId: b.requestReasonId, requestReason: b.requestReason, urgent: true };
    }
  }
  return {
    requestTypeId: 34,
    requestReasonId: presentation.fallbackReasonId,
    requestReason: presentation.fallbackReason,
    urgent: true,
  };
}

/** The block rendered into the after-hours prompt. */
export function renderTriagePrompt(): string {
  const items = AFTER_HOURS_TRIAGE.map(
    (p) =>
      `- If they mention ${p.cues.slice(0, 3).join(', ')}: ask exactly one question —\n` +
      `  "${p.ask}"\n` +
      `  (Spanish: "${p.askEs}")`,
  ).join('\n');

  return `# TRIAGE — ASK ONE QUESTION, THEN DECIDE

Some things a caller says do not tell you how serious they are. For these, ask
ONE short question, WAIT for the answer, and let the answer decide. Do not ask
a second one, and do not stack them.

${items}

WHAT THE QUESTION IS FOR. It decides WHICH kind of urgent this is, so the right
person gets it. It NEVER decides that the call is not urgent. If they answer
"no" to everything, it is still urgent and you still hand it off — you simply
have less to tell the on-call team.

YOU ARE NOT DIAGNOSING. Ask the question, take the answer in their own words,
and pass it on. Never say what you think is wrong, never reassure them that it
sounds minor, and never tell them it can wait. If they cannot answer, or the
answer is unclear, treat it as urgent and move on.

IF THEY DESCRIBE AN EMERGENCY, THE QUESTION CAN WAIT. Chemical in the eye, an
injury that just happened, sudden total vision loss — hand off first.`;
}
