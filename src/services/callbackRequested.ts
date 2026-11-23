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
 * The rule (v166): a caller who chose a contact method (call, text or email),
 * or who asked out loud to be called, texted or emailed back, wants a
 * follow-up.
 *
 * NARROWED IN v269 (operator, 2026-11-22: the agent says "we'll call you back"
 * even after the caller declines a callback). The prompt asks "Would you
 * prefer we call, text, or email you back?" on every after-hours call, so the
 * model fills `preferred_contact` on nearly every filing, including when the
 * caller answers "You don't need to call back." or "I'll call back." v166 let
 * that routine field outrank the model's explicit `requires_callback: false`,
 * so the declined callback was promised anyway and the ticket lost its
 * `[NO CALLBACK NEEDED]` tag. Measured, no-ivr `create_ticket` calls
 * 2026-11-15..23 (`tool_call_payloads`): 3 sent `requires_callback: false`,
 * all 3 were overridden on `preferred_contact` alone; 2 were declines
 * (CAc93e587d61e2905d35850a571c08ce97, CA25b3b9562772a9f881d266ab17eb1f29),
 * the third a caller who said "Just email me" (CAb7ae17c94d5bec743b5d171646f46985),
 * which the spoken ask below still catches.
 *
 * So, in order: a caller who ASKED out loud is a callback, whatever the model
 * sent (70202); otherwise the model's explicit FALSE stands; otherwise a
 * chosen contact method is a callback; otherwise the model's answer, else the
 * category default.
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
 * - The caller asked out loud to be contacted: TRUE.
 * - Otherwise the model's explicit FALSE: FALSE. A `preferred_contact` the
 *   prompt asks on every call is not the caller asking (v269).
 * - Otherwise a chosen contact method: TRUE.
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
  const fromModel = input.modelSays !== undefined ? input.modelSays : input.categoryDefault;
  if (callerAskedToBeContacted(input.callerWords)) return { required: true, overridden: fromModel === false };
  if (input.modelSays === false) return { required: false, overridden: false };
  const choseAMethod = Boolean(input.preferredContact && input.preferredContact.trim()) && input.fullyAnswered !== true;
  if (choseAMethod) return { required: true, overridden: fromModel === false };
  return { required: fromModel, overridden: false };
}
