/** Whole closing phrases only. Unknown words keep the call open. */
export type CallerConclusion = "farewell" | "done";

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[’']/g, "").replace(/[.,!¡;:\-]/g, " ").replace(/\s+/g, " ").trim();
}

const FAREWELL = "goodbye|good bye|bye(?: bye)?|thats all|have a (?:good|great|nice) (?:day|evening|night|weekend)|take care|adios|hasta luego|hasta pronto|chao|chau|nos vemos|que (?:tenga|tengas|tengan) (?:un )?buen dia|eso es todo";
const POLITE = "ok|okay|yes|yeah|no|all right|alright|thanks|thank you|thank you very much|thanks so much|muchas gracias|gracias|vale|igualmente|you too";
const AGENT_POLITE = `${POLITE}|youre welcome|you are welcome|de nada|con gusto|thank you for calling(?: azul vision)?|gracias por llamar|glad i could help`;
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

export function callerConclusion(text: string, previousAgentText: string): CallerConclusion | null {
  if (onlyPhrases(text, `${FAREWELL}|${POLITE}`) &&
      new RegExp(`(?:^| )(?:${FAREWELL})(?: |$)`).test(normalize(text))) return "farewell";
  // A short acknowledgement only closes an explicit offer of further help.
  // Anchor the question's tail so a later question cannot borrow this window.
  const closingQuestion = /(?:\banything else(?: i can (?:help(?: you)? with|do for you))?|\balgo mas(?: en que pueda ayudar(?:le|te))?)\s*\?\s*$/;
  if (!closingQuestion.test(normalize(previousAgentText))) return null;
  // "Yes" means more help is needed; "okay" alone does not answer the offer.
  return onlyPhrases(text, `${DONE}|ok|okay|all right|alright|vale`) &&
    new RegExp(`(?:^| )(?:${DONE})(?: |$)`).test(normalize(text)) ? "done" : null;
}

export function isAgentSignOff(text: string): boolean {
  return onlyPhrases(text, `${FAREWELL}|${AGENT_POLITE}`) &&
    new RegExp(`(?:^| )(?:${FAREWELL})(?: |$)`).test(normalize(text));
}

/** A direct caller farewell can also be answered with just "you're welcome". */
export function completesGoodbye(text: string, conclusion: CallerConclusion): boolean {
  return isAgentSignOff(text) || (conclusion === "farewell" && onlyPhrases(text, AGENT_POLITE));
}
