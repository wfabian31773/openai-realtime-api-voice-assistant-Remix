import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROK_COST_CENTS_PER_SECOND,
  OPENAI_COST_CENTS_PER_SECOND,
  isGrokServedCall,
  priceVoiceCall,
} from "./voiceCostRates";

describe("every duration price goes through the provider-aware decision", () => {
  /**
   * The bug kept coming back one consumer at a time: retryTwilioCostFetch
   * (round 11), the five-minute fixSuspiciousDurations sweep and
   * recalculateOpenAICostFromDuration (round 13), then the admin backfill
   * and recalculate routes plus the Twilio status callback (round 14) —
   * each still multiplying a duration by the OpenAI rate on rows whose
   * null token columns look exactly like a Grok row's. A guard that read
   * one file missed the next module over, so this one walks the whole
   * tree: the raw rate may multiply a duration ONLY inside priceVoiceCall
   * itself and the explicitly OpenAI-named estimator no production code
   * calls. Any new site fails here until it routes through the decision.
   */
  it("the raw OpenAI per-second rate multiplies nothing outside the decision module and the named estimator", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    let estimatorSites = 0;
    let decisionSites = 0;

    for (const dir of ["src", "server"]) {
      const entries = readdirSync(join(repoRoot, dir), {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const path = join(entry.parentPath, entry.name);
        const src = readFileSync(path, "utf8");
        // A multiplication has an operand before the star ON THE SAME LINE —
        // a doc comment's leading `* OPENAI_…` has only a newline, and must
        // not count ([^\S\n] is whitespace that cannot cross lines).
        const sites = [
          ...src.matchAll(/[\w)\]][^\S\n]*\*[^\S\n]*OPENAI_COST_CENTS_PER_SECOND/g),
        ];
        if (sites.length === 0) continue;

        if (entry.name === "voiceCostRates.ts") {
          decisionSites += sites.length; // priceVoiceCall's own branch
          continue;
        }
        if (entry.name === "callCostService.ts") {
          const estimatorStart = src.indexOf(
            "estimateOpenAICostFromDuration(durationSeconds: number)",
          );
          const estimatorEnd = src.indexOf(
            "}",
            src.indexOf("isEstimated: true", estimatorStart),
          );
          for (const m of sites) {
            const at = m.index ?? -1;
            if (estimatorStart !== -1 && at > estimatorStart && at < estimatorEnd) {
              estimatorSites += 1;
            } else {
              offenders.push(path);
            }
          }
          continue;
        }
        offenders.push(...sites.map(() => path));
      }
    }

    expect(
      offenders,
      "a duration is priced at the OpenAI rate outside priceVoiceCall — route it through the provider-aware decision",
    ).toEqual([]);
    // Both allowlisted sites still exist — proves the scan reads real code
    // rather than passing vacuously on a renamed constant.
    expect(decisionSites).toBe(1);
    expect(estimatorSites).toBe(1);
  });
});

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
