/**
 * DID THE CALLER ASK TO BE CONTACTED? — v166.
 *
 * Ticket 70202 (after-hours, no-ivr): the caller chose "Call, please" when
 * asked how they wanted to be reached, and later asked whether the office
 * could call them when it opened. The ticket still read `[NO CALLBACK
 * NEEDED]`, because that tag came from the model's `requires_callback`
 * argument (or the category default) and nothing checked it against what the
 * caller had actually said.
 *
 * The rule: a caller who chose a contact method (call, text or email), or who
 * asked out loud to be called, texted or emailed back, wants a follow-up. The
 * model's FALSE never outranks that. It can only be FALSE when the caller did
 * neither.
 *
 * Reads the caller's own words only (`callerSaid`, the ledger both pipelines
 * feed). NOT `metadata.getTranscript`: the runtime supplies none, and the
 * after-hours line has been on the runtime since 2026-10-01.
 */

/**
 * A request to be contacted, in English or Spanish. Deliberately literal: a
 * miss leaves the model's answer standing, which is the behaviour before this.
 * Bare "call me" counts only before a word that ends or times the ask, so
 * "you can call me Mary" is not a callback request.
 */
const ASKED_TO_BE_CONTACTED = new RegExp(
  [
    String.raw`\bcall(?:ing)? us back\b`,
    String.raw`\bcall me(?= *(?:$|[.,;:!?]|back\b|when\b|tomorrow\b|today\b|tonight\b|later\b|at\b|on\b|in\b|first\b|after\b|before\b|about\b|if\b|please\b|anytime\b|as soon\b))`,
    String.raw`\bcall us (?:when|tomorrow|in the morning|first thing)\b`,
    String.raw`\b(?:could|can|would|will) (?:they|you|someone|somebody|the office|the team|a nurse|the doctor) (?:please )?(?:(?:text|email|phone|contact|reach) (?:me|us)|call us)\b`,
    String.raw`\b(?:have|get) (?:someone|somebody|them|the office|a nurse|the doctor) (?:to )?(?:call|text|email|contact) (?:me|us)\b`,
    String.raw`\b(?:give|send) me a (?:call|text|callback|call back)\b`,
    String.raw`\b(?:text|email) me\b`,
    String.raw`\b(?:i (?:need|want|would like)|i'd like) a (?:call|callback|call back)\b`,
    String.raw`\bcall,? please\b`,
    String.raw`\bplease call\b`,
    String.raw`\b(?:ll[aá]m(?:e|enme|ame)|me llamen|me pueden llamar|me puede llamar)\b`,
  ].join('|'),
  'gi',
);

/**
 * A negation in the same sentence, close before THIS match: "don't call me",
 * "no need to call me back", "no me llamen". Scoped to the match, so "don't
 * text me, call me back" still reads the second ask.
 */
const NEGATED_BEFORE = /(?:\b(?:don'?t|do not|never|not to|no need to|no reason to)\b[^.?!,]{0,20}|\bno(?: me)? *)$/i;

export function callerAskedToBeContacted(callerWords: string | undefined): boolean {
  if (!callerWords) return false;
  const words = callerWords.replace(/[’‘]/g, "'");
  for (const match of words.matchAll(ASKED_TO_BE_CONTACTED)) {
    if (!NEGATED_BEFORE.test(words.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * Whether the ticket needs a callback, decided from the caller rather than
 * from the model alone.
 *
 * - The caller chose a contact method, or asked to be contacted: TRUE.
 * - Otherwise the model's explicit answer, else the category default.
 */
export function callbackNeeded(input: {
  modelSays: boolean | undefined;
  categoryDefault: boolean;
  preferredContact?: string | null;
  /**
   * The model's `question_fully_answered`. A chosen contact method does not
   * reopen a question the model says was answered with nothing left to do —
   * the prompt fills `preferred_contact` routinely — but a caller who ASKED
   * to be called still does.
   */
  fullyAnswered?: boolean;
  /** What the caller said on this call (`callerSaid`). */
  callerWords?: string;
}): { required: boolean; overridden: boolean } {
  const choseAMethod = Boolean(input.preferredContact && input.preferredContact.trim()) && input.fullyAnswered !== true;
  const callerAsked = choseAMethod || callerAskedToBeContacted(input.callerWords);
  const fromModel = input.modelSays !== undefined ? input.modelSays : input.categoryDefault;
  if (callerAsked) return { required: true, overridden: fromModel === false };
  return { required: fromModel, overridden: false };
}
