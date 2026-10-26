/**
 * WHAT THE CALL COST, ON THE RUNTIME.
 *
 * Asked by the operator on 2026-09-03: *"at what rate are we cacheing
 * tokens?"* The answer for the Grok runtime was that nobody could say. In the
 * seven and a half hours after the first cutover, 179 completed runtime calls
 * wrote NULL — not zero, null — to every token column on `call_logs`, while
 * the old core's 185 calls over the same window reported 80.1% of input TEXT
 * tokens served from cache, 47.3% of audio, 77.0% overall.
 *
 * Nothing in `src/runtime/` mentioned usage at all. So prompt size, which the
 * operator was actively asking about — *"grok requires minimal prompting, we
 * should not be near our ceilings"* — was not costable on the pipeline that
 * now answers most of the practice's calls.
 *
 * WHY THIS READS DEFENSIVELY INSTEAD OF DECLARING A SHAPE
 *
 * `wireTypes.ts` models `response.done` as `{ type: "response.done" }` with no
 * payload, and I have never seen what Grok actually puts on it. Writing an
 * interface from the OpenAI realtime docs and trusting it is how a silent
 * mis-parse gets shipped: the columns would stay null and look exactly like
 * they do today.
 *
 * So this reads whatever arrives, accepts the several spellings the realtime
 * APIs use for the same number, and — the important part — SAYS WHAT IT SAW.
 * `describeUsageShape` names the keys present on the first response of each
 * call, so one live call settles the schema question that no amount of reading
 * would. If Grok sends nothing at all, the marker says that too, and the gap
 * is the provider's rather than ours.
 */

export interface UsageTotals {
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  inputCachedTokens: number;
  inputCachedTextTokens: number;
  inputCachedAudioTokens: number;
}

export const ZERO_USAGE: UsageTotals = {
  inputTextTokens: 0,
  inputAudioTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
  inputCachedTokens: 0,
  inputCachedTextTokens: 0,
  inputCachedAudioTokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/**
 * The usage block, wherever the provider chose to hang it.
 *
 * Realtime implementations put it on `response.usage`; some put it at the top
 * level. Both are checked because guessing wrong costs the whole measurement
 * and checking both costs nothing.
 */
function usageBlock(event: unknown): Record<string, unknown> | undefined {
  const e = obj(event);
  if (!e) return undefined;
  return obj(obj(e.response)?.usage) ?? obj(e.usage);
}

/**
 * One response's usage, or null when the event carries none.
 *
 * Null and all-zero are DIFFERENT and the difference is the whole point: null
 * means the provider told us nothing, zero means it told us nothing was used.
 * Collapsing them is what makes a missing feed indistinguishable from a quiet
 * call, which is the state this module exists to end.
 */
export function readUsage(event: unknown): UsageTotals | null {
  const u = usageBlock(event);
  if (!u) return null;

  const inDetails = obj(u.input_token_details) ?? obj(u.input_tokens_details) ?? {};
  const outDetails = obj(u.output_token_details) ?? obj(u.output_tokens_details) ?? {};
  const cachedDetails =
    obj(inDetails.cached_tokens_details) ?? obj(inDetails.cached_token_details) ?? {};

  const inputTextTokens = num(inDetails.text_tokens);
  const inputAudioTokens = num(inDetails.audio_tokens);
  const cachedText = num(cachedDetails.text_tokens);
  const cachedAudio = num(cachedDetails.audio_tokens);
  // The total is reported directly on most shapes; where it is not, the two
  // halves are the total. Never the other way round — a reported total that
  // disagrees with its parts is the provider's arithmetic, not ours to correct.
  const cachedTotal = num(inDetails.cached_tokens) || cachedText + cachedAudio;

  return {
    inputTextTokens,
    inputAudioTokens,
    outputTextTokens: num(outDetails.text_tokens),
    outputAudioTokens: num(outDetails.audio_tokens),
    inputCachedTokens: cachedTotal,
    inputCachedTextTokens: cachedText,
    inputCachedAudioTokens: cachedAudio,
  };
}

/**
 * The KEY NAMES on a usage block, for the marker. Never a value — these are
 * counts rather than content, but the habit of logging only shapes is what
 * keeps a log safe to read out loud.
 */
export function describeUsageShape(event: unknown): string {
  const u = usageBlock(event);
  if (!u) return "none";
  const parts: string[] = Object.keys(u).sort();
  const inDetails = obj(u.input_token_details) ?? obj(u.input_tokens_details);
  if (inDetails) parts.push(`input_token_details{${Object.keys(inDetails).sort().join(",")}}`);
  return parts.join(",");
}

/** Sums usage across a call's responses. */
export class CallUsage {
  private totals: UsageTotals = { ...ZERO_USAGE };
  /** True once any response reported usage at all. */
  private sawAny = false;
  /** The first shape seen, logged once so a live call settles the schema. */
  private describedOnce = false;

  add(event: unknown): void {
    if (!this.describedOnce) {
      this.describedOnce = true;
      console.info(usageShapeMarker(describeUsageShape(event)));
    }
    const u = readUsage(event);
    if (!u) return;
    this.sawAny = true;
    this.totals = {
      inputTextTokens: this.totals.inputTextTokens + u.inputTextTokens,
      inputAudioTokens: this.totals.inputAudioTokens + u.inputAudioTokens,
      outputTextTokens: this.totals.outputTextTokens + u.outputTextTokens,
      outputAudioTokens: this.totals.outputAudioTokens + u.outputAudioTokens,
      inputCachedTokens: this.totals.inputCachedTokens + u.inputCachedTokens,
      inputCachedTextTokens: this.totals.inputCachedTextTokens + u.inputCachedTextTokens,
      inputCachedAudioTokens: this.totals.inputCachedAudioTokens + u.inputCachedAudioTokens,
    };
  }

  /**
   * The totals, or undefined when the provider never reported any.
   *
   * Undefined leaves the columns NULL, which is the truthful record of "we were
   * told nothing" and keeps it distinguishable from a call that genuinely used
   * nothing. Writing zeros here would erase exactly the signal that found this.
   */
  result(): UsageTotals | undefined {
    return this.sawAny ? { ...this.totals } : undefined;
  }
}

/**
 * DEPLOY MARKER, and the answer to a question reading the docs could not
 * settle. Prints once per call with the key names the provider actually sent,
 * so the first live call after the deploy says whether Grok reports usage and
 * under which spelling. "none" is a real answer and the one that would make
 * this the provider's gap rather than ours.
 */
export function usageShapeMarker(shape: string): string {
  return `[TOKENS] usage reported by the provider on this response: ${shape}`;
}

/** Printed at teardown, so the cache rate is readable per call in the log. */
export function usageSummaryMarker(u: UsageTotals): string {
  const input = u.inputTextTokens + u.inputAudioTokens;
  const pct = input > 0 ? Math.round((u.inputCachedTokens / input) * 1000) / 10 : 0;
  return (
    `[TOKENS] in ${input} (text ${u.inputTextTokens}, audio ${u.inputAudioTokens}), ` +
    `cached ${u.inputCachedTokens} = ${pct}%, out ${u.outputTextTokens + u.outputAudioTokens}`
  );
}
