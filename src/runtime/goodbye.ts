/** Whole closing phrases only. Unknown words keep the call open.
 *
 * `thanks` (v169) is the weakest: a bare thank-you is ambiguous on its own, so
 * it closes the call ONLY when the agent's reply is itself a full sign-off
 * ("You're welcome, Irene. Take care.") — see `completesGoodbye`. */
export type CallerConclusion = "farewell" | "done" | "thanks";

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[’']/g, "").replace(/[.,!¡;:\-]/g, " ").replace(/\s+/g, " ").trim();
}

// v176: "have a good afternoon / morning" (the agent's sign-off on afternoon
// calls, 2026-11-04 CA5e11), and a blessing, which is how many Spanish
// callers say goodbye ("Okey. Igualmente, bendiciones. Adiós.", CAd598).
const FAREWELL = "goodbye|good bye|bye(?: bye)?|thats all|have a (?:good|great|nice) (?:day|evening|night|weekend|afternoon|morning)|take care|adios|hasta luego|hasta pronto|chao|chau|nos vemos|que (?:tenga|tengas|tengan) (?:un )?buen dia|que le vaya bien|eso es todo|bendiciones|(?:que )?dios (?:le|la|lo|los|las|te) bendiga|god bless(?: you)?";
// v169: "okey" is how Spanish callers' "okay" is transcribed; "a usted
// también" is Spanish "you too" (2026-11-02, CAe04c, CA5b3e).
const POLITE = "ok|okay|okey|yes|yeah|no|all right|alright|thanks|thank you|thank you very much|thanks so much|muchas gracias|gracias|vale|igualmente|you too|a usted tambien|usted tambien";
const THANKS = "thanks|thank you|thank you very much|thanks so much|muchas gracias|gracias";
// v176: "That's everything on my end." closes the agent's own part of the
// call; it is never a farewell by itself (the line still needs one). Its
// "that's all" form contains FAREWELL's "thats all", so the farewell test in
// `isAgentSignOff` reads the line with this phrase taken out (Codex P2, #429).
const MY_END = "(?:thats|that is) (?:everything|all) (?:on|from) my end";
const AGENT_POLITE = `${POLITE}|youre welcome|you are welcome|de nada|con gusto|thank you for calling(?: azul vision)?|gracias por llamar|glad i could help|${MY_END}`;
const DONE = "no|thats it|that is it|nothing else|nada mas|thanks|thank you|thank you very much|thanks so much|gracias|muchas gracias";

const MAX_WORDS = 24;
const MAX_PHRASE_WORDS = 8;

/** Deterministic word-level parse (no repeated-group regex: Codex P2, #396).
 * Each candidate slice is short and matched by a non-repeating regex. */
function onlyPhrases(text: string, phrases: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return false;
  const phrase = new RegExp(`^(?:${phrases})$`);
  const reachable = new Array<boolean>(words.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < words.length; i++) {
    if (!reachable[i]) continue;
    for (let j = i + 1; j <= Math.min(words.length, i + MAX_PHRASE_WORDS); j++) {
      if (!reachable[j] && phrase.test(words.slice(i, j).join(" "))) reachable[j] = true;
    }
  }
  return reachable[words.length];
}

/**
 * A NAME THE AGENT ADDRESSED THE CALLER BY is not a word the matcher knows,
 * and "unknown words keep the call open" turned every "You're welcome, Irene.
 * Take care." into an open line: on 2026-11-02, five of the day's dead-air
 * endings were exactly that. Only a VOCATIVE is removed — one capitalised
 * word set off by a comma and followed by punctuation or the end — so it can
 * never add a farewell that was not said: the phrase rules still decide.
 */
function withoutVocative(text: string): string {
  return text.replace(/,\s*\p{Lu}[\p{L}'’-]*(?=\s*[.!?,]|\s*$)/gu, "");
}

export function callerConclusion(text: string, previousAgentText: string): CallerConclusion | null {
  if (onlyPhrases(text, `${FAREWELL}|${POLITE}`) &&
      new RegExp(`(?:^| )(?:${FAREWELL})(?: |$)`).test(normalize(text))) return "farewell";
  // The agent said goodbye first and the caller answered it ("Gracias."): the
  // exchange is the caller's farewell even though their words carry none.
  if (previousAgentText && isAgentSignOff(previousAgentText) && onlyPhrases(text, POLITE)) return "farewell";
  // A short acknowledgement only closes an explicit offer of further help.
  // Anchor the question's tail so a later question cannot borrow this window.
  const closingQuestion = /(?:\banything else(?: i can (?:help(?: you)? with|do for you))?|\balgo mas(?: en que pueda ayudar(?:le|te))?)\s*\?\s*$/;
  if (closingQuestion.test(normalize(previousAgentText))) {
    // "Yes" means more help is needed; "okay" alone does not answer the offer.
    if (onlyPhrases(text, `${DONE}|ok|okay|all right|alright|vale`) &&
        new RegExp(`(?:^| )(?:${DONE})(?: |$)`).test(normalize(text))) return "done";
    return null;
  }
  // A bare thank-you is ambiguous on its own; it can close the call only if
  // the agent's reply is a full sign-off (completesGoodbye). Never as the
  // answer to a question the agent just asked: that caller has not answered.
  if (/\?\s*$/.test(previousAgentText.trim())) return null;
  return onlyPhrases(text, POLITE) && new RegExp(`(?:^| )(?:${THANKS})(?: |$)`).test(normalize(text))
    ? "thanks"
    : null;
}

export function isAgentSignOff(text: string): boolean {
  const bare = withoutVocative(text);
  const withoutMyEnd = normalize(bare).replace(new RegExp(`(?:^| )${MY_END}(?= |$)`, "g"), " ");
  return onlyPhrases(bare, `${FAREWELL}|${AGENT_POLITE}`) &&
    new RegExp(`(?:^| )(?:${FAREWELL})(?: |$)`).test(withoutMyEnd);
}

/** A direct caller farewell can also be answered with just "you're welcome";
 * a bare thank-you needs the agent's full sign-off. */
export function completesGoodbye(text: string, conclusion: CallerConclusion): boolean {
  return isAgentSignOff(text) ||
    (conclusion === "farewell" && onlyPhrases(withoutVocative(text), AGENT_POLITE));
}
