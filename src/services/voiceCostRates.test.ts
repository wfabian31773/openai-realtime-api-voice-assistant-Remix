import { describe, it, expect } from "vitest";
import {
  GROK_COST_CENTS_PER_SECOND,
  OPENAI_COST_CENTS_PER_SECOND,
  isGrokServedCall,
  priceVoiceCall,
} from "./voiceCostRates";

describe("who served the call decides whose rate applies", () => {
  it("recognises a runtime-served row", () => {
    expect(isGrokServedCall({ voiceProvider: "grok" })).toBe(true);
    expect(isGrokServedCall({ voiceProvider: null })).toBe(false);
    expect(isGrokServedCall({})).toBe(false);
  });

  it("prices a Grok call at xAI's flat rate, NOT the OpenAI estimate", () => {
    // The trap: a Grok row's token columns are null exactly like an
    // un-reconciled OpenAI row's, so the estimate cannot tell them apart.
    const pricing = priceVoiceCall({
      voiceProvider: "grok",
      inputAudioTokens: null,
      durationSeconds: 300,
      twilioCostCents: 10,
    });
    expect(pricing.basis).toBe("grok_duration");
    expect(pricing.providerCostCents).toBe(40); // 5 min at 8 c/min
    expect(pricing.totalCostCents).toBe(50);
    // What it would have been billed as, wrongly.
    expect(Math.ceil(300 * OPENAI_COST_CENTS_PER_SECOND)).toBe(57);
  });

  it("still estimates OpenAI from duration when no tokens exist", () => {
    const pricing = priceVoiceCall({
      inputAudioTokens: null,
      durationSeconds: 300,
      twilioCostCents: 10,
    });
    expect(pricing.basis).toBe("openai_duration");
    expect(pricing.providerCostCents).toBe(57);
  });

  it("never clobbers a token-derived OpenAI cost", () => {
    const pricing = priceVoiceCall({
      inputAudioTokens: 1234,
      existingOpenaiCostCents: 99,
      durationSeconds: 300,
      twilioCostCents: 10,
    });
    expect(pricing.basis).toBe("openai_tokens");
    expect(pricing.providerCostCents).toBeUndefined();
    expect(pricing.totalCostCents).toBe(109);
  });

  it("checks the provider BEFORE the token test — order is the whole fix", () => {
    // A Grok row that somehow carries tokens is still a Grok call.
    const pricing = priceVoiceCall({
      voiceProvider: "grok",
      inputAudioTokens: 500,
      existingOpenaiCostCents: 99,
      durationSeconds: 60,
      twilioCostCents: 0,
    });
    expect(pricing.basis).toBe("grok_duration");
    expect(pricing.providerCostCents).toBe(8);
  });

  it("matches xAI's published per-minute price exactly", () => {
    expect(Math.round(GROK_COST_CENTS_PER_SECOND * 60)).toBe(8);
  });
});
