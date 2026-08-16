/**
 * Shared Model Pricing — Single source of truth for OpenAI model costs.
 *
 * All prices are in USD per 1 million tokens.
 * Update this file when OpenAI publishes new pricing.
 */

export interface ModelPricing {
  audioInputPerM: number;
  audioInputCachedPerM: number;
  audioOutputPerM: number;
  textInputPerM: number;
  textInputCachedPerM: number;
  textOutputPerM: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-realtime': { audioInputPerM: 32, audioInputCachedPerM: 0.40, audioOutputPerM: 64, textInputPerM: 4, textInputCachedPerM: 0.40, textOutputPerM: 16 },
  'gpt-4o-realtime-preview': { audioInputPerM: 40, audioInputCachedPerM: 2.50, audioOutputPerM: 80, textInputPerM: 5, textInputCachedPerM: 2.50, textOutputPerM: 20 },
  'gpt-4o-mini-transcribe': { audioInputPerM: 3, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  'gpt-4o-transcribe': { audioInputPerM: 6, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  /**
   * THE CURRENT TRANSCRIBERS — PROVISIONAL RATES, FLAGGED AS SUCH.
   *
   * Production has defaulted to `gpt-live-transcribe` since 2026-08-04 and
   * neither it nor `gpt-transcribe` had a row here. With no row they matched no
   * prefix and fell all the way through to `gpt-realtime` — $32/M audio in
   * against the $3-6/M the previous transcriber generation costs. That is a
   * five-to-tenfold over-estimate wherever a transcription line item is priced.
   *
   * These carry `gpt-4o-transcribe`'s rates as the nearest KNOWN figure. That
   * is a placeholder, not a researched price, and it is written down here
   * rather than guessed silently: confirm against a bill and correct it. The
   * point of the entry is that being approximately right beats being
   * confidently wrong by an order of magnitude, and that the number now has a
   * name and a note instead of arriving through a fall-through nobody sees.
   *
   * Note this affects the ORG-level estimate only — the per-call path never
   * prices transcription, because accumulateUsage reads `response.usage` and
   * OpenAI bills transcription as its own line item.
   */
  'gpt-live-transcribe': { audioInputPerM: 6, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  'gpt-transcribe': { audioInputPerM: 6, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0, textInputCachedPerM: 0, textOutputPerM: 6 },
  'gpt-4o-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.15, textInputCachedPerM: 0.075, textOutputPerM: 0.60 },
  'gpt-4o': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 2.50, textInputCachedPerM: 1.25, textOutputPerM: 10 },
  'gpt-4.1-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.40, textInputCachedPerM: 0.10, textOutputPerM: 1.60 },
  'gpt-5': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 1.25, textInputCachedPerM: 0.125, textOutputPerM: 10 },
};

const SORTED_PREFIXES = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/**
 * Models we have priced by PREFIX but never verified rates for.
 *
 * `'gpt-realtime-2.1'.startsWith('gpt-realtime')` is true, so a new generation
 * inherits the previous generation's rates and the "unknown model" warning
 * below NEVER FIRES. That is the dangerous case: a wrong price with no signal,
 * as opposed to an unknown one with a warning.
 *
 * Production has been running `gpt-realtime-2` and `gpt-realtime-2.1` since
 * 2026-08-02. Their true rates are NOT known here and are deliberately not
 * guessed — inventing a number would be worse than inheriting one, because it
 * would look researched. This warns once per model per process so the gap is
 * visible in the logs until someone confirms the rates against an invoice and
 * adds explicit rows.
 */
const inheritedWarned = new Set<string>();

export function getModelPricing(model: string): ModelPricing {
  for (const prefix of SORTED_PREFIXES) {
    if (model.startsWith(prefix)) {
      if (model !== prefix && !inheritedWarned.has(model)) {
        inheritedWarned.add(model);
        console.warn(
          `[PRICING] "${model}" has no rate row of its own — inheriting "${prefix}" rates. ` +
            'Confirm against billing and add an explicit entry in modelPricing.ts.',
        );
      }
      return MODEL_PRICING[prefix];
    }
  }
  console.warn(`[PRICING] Unknown model "${model}", falling back to gpt-realtime pricing`);
  return MODEL_PRICING['gpt-realtime'];
}
