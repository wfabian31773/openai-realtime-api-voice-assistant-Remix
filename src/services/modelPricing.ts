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
  'gpt-4o-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.15, textInputCachedPerM: 0.075, textOutputPerM: 0.60 },
  'gpt-4o': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 2.50, textInputCachedPerM: 1.25, textOutputPerM: 10 },
  'gpt-4.1-mini': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 0.40, textInputCachedPerM: 0.10, textOutputPerM: 1.60 },
  'gpt-5': { audioInputPerM: 0, audioInputCachedPerM: 0, audioOutputPerM: 0, textInputPerM: 1.25, textInputCachedPerM: 0.125, textOutputPerM: 10 },
};

const SORTED_PREFIXES = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

export function getModelPricing(model: string): ModelPricing {
  for (const prefix of SORTED_PREFIXES) {
    if (model.startsWith(prefix)) {
      return MODEL_PRICING[prefix];
    }
  }
  console.warn(`[PRICING] Unknown model "${model}", falling back to gpt-realtime pricing`);
  return MODEL_PRICING['gpt-realtime'];
}
