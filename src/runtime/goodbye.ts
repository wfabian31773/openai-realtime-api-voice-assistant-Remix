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

function onlyPhrases(text: string, phrases: string): boolean {
  return new RegExp(`^(?:(?:${phrases})(?: +|$))+$`).test(normalize(text));
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
