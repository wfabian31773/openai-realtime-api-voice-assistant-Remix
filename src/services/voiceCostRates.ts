/**
 * src/services/voiceCostRates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * How a voice call is priced, as a pure decision.
 *
 * Extracted from callCostService because that module cannot be imported
 * without a database — which meant the pricing branch could not be tested
 * at all. A first attempt at a test for it silently ran ZERO assertions and
 * a mutation check counted the import failure as a caught mutation. The
 * rates and the decision have no business needing a connection pool.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * OpenAI Realtime, estimated from duration when no token counts exist.
 * Calibrated from historical billing (0.19 c/sec = 11.4 c/min).
 */
export const OPENAI_COST_CENTS_PER_SECOND = 0.19;

/**
 * Grok voice, billed flat per minute by xAI: 8 cents/min.
 *
 * A Grok-served call carries no OpenAI tokens, so the OpenAI estimate would
 * otherwise claim it — inventing OpenAI spend that never happened, and
 * reporting it against the one comparison this migration exists to make
 * (Codex review, PR #227).
 */
export const GROK_COST_CENTS_PER_SECOND = 8 / 60;

/** Which stack served a call. Rows written by src/runtime say 'grok'. */
export function isGrokServedCall(callLog: { voiceProvider?: string | null }): boolean {
  return callLog.voiceProvider === "grok";
}

export interface VoiceCallPricingInput {
  voiceProvider?: string | null;
  /** Non-null means a token-derived OpenAI cost already exists. */
  inputAudioTokens?: number | null;
  /** The cost already on the row, used when tokens are authoritative. */
  existingOpenaiCostCents?: number | null;
  durationSeconds: number;
  twilioCostCents: number;
  /**
   * Set when `grokCostReconciler` has already priced this call from xAI's
   * own bill. THE ESTIMATE MUST NOT OVERWRITE THE BILL.
   *
   * Found by Codex on PR #268. Every other writer of these columns — the
   * Twilio cost retry, the suspicious-duration repair, the status callback —
   * calls this function again after the call is over, and the Grok branch
   * below unconditionally returned duration x rate. On an early-UTC start
   * the four-hour Twilio retry and the previous-day reconciler run together,
   * so a reconciled row could be overwritten with the estimate WHILE KEEPING
   * `cost_reconciled_at` set: a wrong number wearing the badge of an
   * authoritative one, which is worse than never having reconciled at all.
   */
  costReconciledAt?: Date | string | null;
}

export interface VoiceCallPricing {
  /** Undefined means "leave the stored value alone". */
  providerCostCents?: number;
  totalCostCents: number;
  basis: "grok_duration" | "openai_duration" | "openai_tokens" | "reconciled";
}

/**
 * Price one call. Three cases, in order:
 *
 *   1. Grok served it  -> xAI's flat per-minute rate. Checked FIRST, because
 *      a runtime row's token columns are null exactly like an
 *      un-reconciled OpenAI row's, and the estimate below cannot tell them
 *      apart.
 *   2. No tokens yet   -> the calibrated OpenAI duration estimate.
 *   3. Tokens present  -> already authoritative; never clobber it.
 */
export function priceVoiceCall(input: VoiceCallPricingInput): VoiceCallPricing {
  // FIRST, ahead of everything: a reconciled row is finished. Its provider
  // cost came from xAI's invoice and no estimate may replace it. The total
  // is still rebuilt, because Twilio's own cost legitimately arrives later
  // and belongs in it.
  if (input.costReconciledAt) {
    return {
      totalCostCents: input.twilioCostCents + (input.existingOpenaiCostCents ?? 0),
      basis: "reconciled",
    };
  }
  if (isGrokServedCall(input)) {
    const providerCostCents = Math.ceil(input.durationSeconds * GROK_COST_CENTS_PER_SECOND);
    return {
      providerCostCents,
      totalCostCents: input.twilioCostCents + providerCostCents,
      basis: "grok_duration",
    };
  }
  if (input.inputAudioTokens == null) {
    const providerCostCents = Math.ceil(input.durationSeconds * OPENAI_COST_CENTS_PER_SECOND);
    return {
      providerCostCents,
      totalCostCents: input.twilioCostCents + providerCostCents,
      basis: "openai_duration",
    };
  }
  return {
    totalCostCents: input.twilioCostCents + (input.existingOpenaiCostCents ?? 0),
    basis: "openai_tokens",
  };
}
