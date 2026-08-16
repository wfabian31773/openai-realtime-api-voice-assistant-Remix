/**
 * A MEASUREMENT MUST NEVER BE OVERWRITTEN BY AN ESTIMATE.
 *
 * Operator, 2026-08-16, on why the cost numbers matter: *"this is the most
 * important piece, if we can't get this to agree, we don't know if we are
 * being efficient and if we are getting an roi."*
 *
 * Measured that day across seven days of live traffic: of 2,318 calls carrying
 * real OpenAI token counts, **2,181 had a stored cost exactly equal to
 * `ceil(duration * 0.19)`** and only 29 — 1.3% — were priced from the tokens.
 *
 * Two independent defects produced that, and both are fixed here.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const { callCostService, OPENAI_COST_CENTS_PER_SECOND } = await import('./callCostService');

describe('defect 1 — the duration estimate destroyed the token cost', () => {
  /**
   * `recalculateOpenAICostFromDuration` is called from six places, including
   * the same teardown that has just flushed real token counts, plus retries at
   * 30s and 90s. Its two sibling functions both refuse to clobber a
   * token-derived cost; this one did not.
   *
   * The guard is `inputAudioTokens != null` — the same condition
   * `retryTwilioCostFetch` and `reconcileTwilioCallData` already use.
   */
  it('the guard reads the same field its siblings guard on', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./callCostService.ts', import.meta.url), 'utf8'),
    );
    const fn = src.slice(
      src.indexOf('async recalculateOpenAICostFromDuration'),
      src.indexOf('recalculateAllOpenAICosts'),
    );
    expect(fn, 'the duration estimator must not overwrite a token-derived cost')
      .toMatch(/if \(callLog\.inputAudioTokens != null\)/);
    // And it must bail BEFORE computing or writing anything.
    expect(fn.indexOf('inputAudioTokens != null')).toBeLessThan(fn.indexOf('OPENAI_COST_CENTS_PER_SECOND'));
  });

  it('still estimates when there are genuinely no tokens', () => {
    // The fallback has to keep working — a call that produced no usage events
    // still needs a number, and the duration proxy is the honest one to use.
    const e = callCostService.estimateOpenAICostFromDuration(600);
    expect(e.costCents).toBe(Math.ceil(600 * OPENAI_COST_CENTS_PER_SECOND));
    expect(e.isEstimated).toBe(true);
  });
});

describe('defect 2 — cached audio tokens were never captured', () => {
  /**
   * `input_cached_audio_tokens` was 0 on EVERY row ever written, while
   * OpenAI's own org usage reported cached audio at 96-133% of uncached audio
   * on the same days. Cached audio is $0.40/M against $32/M — eighty times
   * cheaper — so missing it over-prices the largest component of a voice call.
   */
  const base = {
    inputAudioTokens: 100_000,
    outputAudioTokens: 50_000,
    inputTextTokens: 10_000,
    outputTextTokens: 5_000,
  };

  it('prices reported cached audio at the cached rate, not the full one', () => {
    const withSplit = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 60_000, inputCachedAudioTokens: 60_000, inputCachedTextTokens: 0 } as never,
      'gpt-realtime',
    );
    const noneCached = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 0 } as never,
      'gpt-realtime',
    );
    // 60k audio tokens moving from $32/M to $0.40/M is ~$1.90 — the difference
    // must be large and in the right direction.
    expect(withSplit.totalCostCents).toBeLessThan(noneCached.totalCostCents);
    expect(noneCached.totalCostCents - withSplit.totalCostCents).toBeGreaterThan(150);
  });

  it('uses the REPORTED split rather than apportioning by input mix', () => {
    /**
     * The old code split one undifferentiated cached figure pro-rata by the
     * audio/text ratio. With 100k audio and 10k text, 60k cached would be
     * apportioned ~54.5k audio / ~5.5k text. If OpenAI actually says all 60k
     * were audio, the reported figure must win — and it prices lower, because
     * audio caching is 80x while text caching is only 10x.
     */
    const reported = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 60_000, inputCachedAudioTokens: 60_000, inputCachedTextTokens: 0 } as never,
      'gpt-realtime',
    );
    const apportioned = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 60_000 } as never,
      'gpt-realtime',
    );
    expect(reported.totalCostCents).not.toBe(apportioned.totalCostCents);
    expect(reported.totalCostCents).toBeLessThan(apportioned.totalCostCents);
  });

  it('falls back to apportioning when no split was reported', () => {
    // Every historical row, and any payload that omits the breakdown. A
    // missing split must mean "we don't know", never "no cached audio".
    const legacy = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 60_000 } as never,
      'gpt-realtime',
    );
    const uncached = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 0 } as never,
      'gpt-realtime',
    );
    expect(legacy.totalCostCents).toBeLessThan(uncached.totalCostCents);
  });

  it('clamps a reported figure that exceeds the audio we counted', () => {
    // Otherwise uncached audio goes negative and the cost under-reports.
    const v = callCostService.calculateOpenAICostFromTokens(
      { ...base, inputCachedTokens: 999_999, inputCachedAudioTokens: 999_999, inputCachedTextTokens: 0 } as never,
      'gpt-realtime',
    );
    expect(v.totalCostCents).toBeGreaterThan(0);
    expect(v.inputAudioCostCents).toBeGreaterThanOrEqual(0);
  });
});

describe('the accumulator captures what OpenAI sends', () => {
  it('reads cached_tokens_details, not just cached_tokens', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../voiceAgentRoutes.ts', import.meta.url), 'utf8'),
    );
    const fn = src.slice(src.indexOf('function accumulateUsage'), src.indexOf('function accumulateUsage') + 1400);
    expect(fn).toMatch(/cached_tokens_details/);
    expect(fn).toMatch(/inputCachedAudioTokens \+= /);
  });

  it('persists the split — the column existed, the data did not', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./callCostService.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/inputCachedAudioTokens: \(tokens as/);
  });
});
