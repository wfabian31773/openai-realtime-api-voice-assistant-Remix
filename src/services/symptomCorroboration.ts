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

/** Caller utterances for a live call, lowercased, most recent last. */
const callerSpeech = new Map<string, string[]>();

/** Cap per call: a long call must not grow unbounded in memory. */
const MAX_LINES = 400;

export function recordCallerSpeech(callId: string, text: string): void {
  if (!callId || !text?.trim()) return;
  const lines = callerSpeech.get(callId) ?? [];
  lines.push(text.toLowerCase());
  if (lines.length > MAX_LINES) lines.shift();
  callerSpeech.set(callId, lines);
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
    spoken: /\bvision\b|\bsee\b|\bseeing\b|\bsight\b|\bblurr?|\bcloudy\b|\bdouble\b|\bdark\b|\bspots?\b|\bfloaters?\b|\bflash|\bvista\b|\bver\b|\bveo\b|\bborros/,
  },
];

export interface CorroborationResult {
  /** Claims made by the agent with NO support anywhere in the caller's words. */
  unsupported: string[];
  /** Claims made and supported. */
  supported: string[];
  /** False when we have no record of the caller speaking at all. */
  haveSpeech: boolean;
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
  const spoken = callerSaid(callId);
  const claim = (claimText ?? '').toLowerCase();
  const out: CorroborationResult = { unsupported: [], supported: [], haveSpeech: Boolean(spoken.trim()) };

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
