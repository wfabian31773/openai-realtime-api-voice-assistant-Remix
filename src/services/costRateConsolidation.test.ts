/**
 * ONE RATE, THE MODEL THAT RAN, AND WHAT GRADING COSTS.
 *
 * Steps 3-5 of the cost work. Steps 1-2 (guard the estimate, capture cached
 * audio) shipped in #205; these are the rest of what stopped `openai_cost_cents`
 * being auditable.
 *
 * Operator: *"if we can't get this to agree, we don't know if we are being
 * efficient and if we are getting an roi."*
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('step 3 — one duration rate, everywhere', () => {
  /**
   * Four values for one quantity is how the column became unauditable:
   *   0.19 c/sec = 11.4 c/min   callCostService (intended)
   *   19 c/min   = 1.67x that   voiceAgentRoutes status callback  <-- LIVE
   *   15 c/min                  routes.ts admin backfill, x2
   *   6 + 24 c/min at 70/30     callCostService.calculateOpenAICost
   *
   * The 19c/min path ran on every inbound call, and on five more numbers after
   * the Twilio callbacks were wired up on 08-15.
   */
  const files = ['../voiceAgentRoutes.ts', '../../server/routes.ts'];

  it('no file computes a duration cost from its own literal rate', () => {
    for (const f of files) {
      const src = read(f);
      // Strip block comments — the history is documented in prose and must not
      // trip its own check.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, `${f} still divides by 60 and multiplies by a rate`).not.toMatch(/\/\s*60\s*\*\s*\d/);
      expect(code, `${f} still uses a bare 0.19`).not.toMatch(/\*\s*0\.19\b/);
    }
  });

  it('both files route through the shared pricing decision', () => {
    // Consolidation moved one step further (Codex, PR #227 round 14): the
    // shared CONSTANT was still the wrong rate for a Grok-served row, so
    // both files now call priceVoiceCall — which keeps token-derived costs
    // and picks the provider's rate — instead of multiplying the raw
    // OpenAI rate themselves. The repo-wide scan in voiceCostRates.test.ts
    // enforces the absence of raw multiplications; this pins the presence
    // of the decision.
    for (const f of files) {
      expect(read(f), `${f} must price through priceVoiceCall`).toMatch(/priceVoiceCall\(\{/);
    }
  });

  it('the status callback no longer stamps a duration guess as authoritative', () => {
    /**
     * It set `costIsEstimated = false` whenever Twilio supplied a CallDuration
     * — but Twilio supplying a duration says nothing about how the OpenAI cost
     * was derived. The flag meant nothing, which is why it could not be used to
     * find the very rows this investigation was about.
     */
    const src = read('../voiceAgentRoutes.ts');
    expect(src).toMatch(/updateData\.costIsEstimated = !hasTokenDerivedCost/);
    // Token-derived is now what priceVoiceCall says it is, not a re-derived
    // null check that could drift from the decision.
    expect(src).toMatch(/const hasTokenDerivedCost = pricing\.basis === "openai_tokens"/);
  });
});

describe('step 4 — price the model that actually ran', () => {
  it('the teardown passes the A/B arm, not a literal', () => {
    /**
     * The cost flush hardcoded `'gpt-realtime'` while the session was swapped
     * to `abAssignment.challengerModel`. Every challenger call was priced as
     * the control — by hardcoded string, so adding rate rows would not have
     * fixed it. Nothing ever asked which model ran.
     */
    const src = read('../voiceAgentRoutes.ts');
    expect(src).toMatch(/String\(modelForCall \?\? 'gpt-realtime'\)/);
    const flush = src.slice(src.indexOf('updateCallCostsWithTokens'), src.indexOf('updateCallCostsWithTokens') + 1600);
    expect(flush, 'the literal must be gone from the flush').not.toMatch(/\n\s+'gpt-realtime',\n/);
  });

  it('an inherited rate is announced instead of silent', async () => {
    /**
     * `'gpt-realtime-2.1'.startsWith('gpt-realtime')` is true, so a new
     * generation inherits last generation's rates and the "unknown model"
     * warning NEVER fires. A wrong price with no signal is worse than an
     * unknown one with a warning.
     *
     * The rates themselves are deliberately NOT invented here — inheriting a
     * number is honest, guessing one would look researched.
     */
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
      const { getModelPricing } = await import('./modelPricing');
      getModelPricing('gpt-realtime-2.1');
    } finally {
      console.warn = orig;
    }
    expect(warnings.join(' ')).toMatch(/gpt-realtime-2\.1/);
    expect(warnings.join(' ')).toMatch(/inheriting/i);
  });

  it('an exact match stays quiet', async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
      const { getModelPricing } = await import('./modelPricing');
      getModelPricing('gpt-realtime');
    } finally {
      console.warn = orig;
    }
    expect(warnings).toEqual([]);
  });
});

describe('step 5 — grading and transcription are no longer invisible', () => {
  it('the call log carries what grading cost', () => {
    expect(read('../../shared/schema.ts')).toMatch(/gradingCostCents: integer\("grading_cost_cents"\)/);
  });

  it('the grader prices its own completion and stores it', () => {
    const src = read('./callGradingService.ts');
    expect(src).toMatch(/gradingCostCents/);
    expect(src, 'must price from the response usage, not a guess').toMatch(/response\.usage/);
    expect(src, 'must use the shared rate table').toMatch(/getModelPricing\('gpt-4o-mini'\)/);
  });

  it('a pricing failure cannot lose the grade', () => {
    // The analysis is the point; the cost is bookkeeping.
    const src = read('./callGradingService.ts');
    const block = src.slice(src.indexOf('let gradingCostCents'), src.indexOf('await storage.updateCallLog(callLogId, {'));
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/catch/);
  });

  it('the current transcribers have rates instead of falling through to realtime', async () => {
    /**
     * With no row, `gpt-live-transcribe` matched no prefix and fell through to
     * `gpt-realtime` — $32/M audio in against the $3-6/M a transcriber costs.
     * The rates added are the nearest KNOWN figure and are marked provisional
     * in the source; approximately right beats confidently wrong by an order
     * of magnitude.
     */
    const { getModelPricing } = await import('./modelPricing');
    for (const m of ['gpt-live-transcribe', 'gpt-transcribe']) {
      const p = getModelPricing(m);
      expect(p.audioInputPerM, `${m} must not inherit realtime audio pricing`).toBeLessThan(32);
      expect(p.audioOutputPerM, `${m} does not emit audio`).toBe(0);
    }
  });
});

describe('the billing alert compares like with like', () => {
  /**
   * `actualUsd` was the WHOLE organisation while `estimatedUsd` was a sum over
   * `call_logs` — voice only. The split already existed twenty lines further
   * down and was already used when writing `daily_openai_costs`, so one run
   * persisted a scope-matched comparison in one table and an apples-to-oranges
   * one in another, and alarmed on the second.
   *
   * Worth stating plainly because I reported this as the CAUSE of the 43% gap
   * and it was not: `other_cost_cents` measured $0.00 every day. A real defect
   * with almost no effect. Fixed because a comparison should be correct by
   * construction, not by the accident of running one workload.
   */
  it('splits realtime from other spend', async () => {
    const { splitRealtimeSpend } = await import('./orgBillingLedger');
    const r = splitRealtimeSpend([
      { lineItem: 'gpt-realtime audio input', costDollars: 40 },
      { lineItem: 'gpt-4o-mini text input', costDollars: 3 },
      { lineItem: 'whisper transcription', costDollars: 1 },
    ]);
    expect(r.realtimeCostDollars).toBe(41);
    expect(r.otherCostDollars).toBe(3);
  });

  it('the alert uses the realtime figure, not the org total', () => {
    const src = read('./orgBillingLedger.ts');
    expect(src).toMatch(/const actualUsd = realtimeCostDollars;/);
    expect(src, 'the org total must no longer be the comparison basis')
      .not.toMatch(/const actualUsd = orgCosts\.totalCostDollars/);
  });

  it('computes the split once, not twice', () => {
    const src = read('./orgBillingLedger.ts');
    const calls = src.match(/splitRealtimeSpend\(/g) ?? [];
    // One definition, one call site inside reconcileDay.
    expect(calls.length).toBe(2);
  });
});
