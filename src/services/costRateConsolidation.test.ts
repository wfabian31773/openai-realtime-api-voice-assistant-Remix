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
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // Authoritative is whatever priceVoiceCall SAYS it is, not a re-derived
    // null check that could drift from the decision.
    expect(src).toMatch(/hasTokenDerivedCost =\s*\n?\s*pricing\.basis === "openai_tokens"/);
    /**
     * And a reconciled row is authoritative too. This widened on 2026-09-04:
     * a Grok row already priced from xAI's invoice fell through the
     * tokens-only question and had `costIsEstimated = true` stamped on it
     * while `cost_reconciled_at` stayed populated. The cost survived —
     * priceVoiceCall's own guard holds — but the row then claimed to be both
     * estimated and reconciled, and the Observatory and the QVO exports read
     * the flag (Codex, PR #268 round 3).
     *
     * This assertion is a source scan and therefore proves only that the line
     * exists. What it BEHAVES like is pinned in voiceCostRates.test.ts, where
     * priceVoiceCall is called for real and asserted to return the
     * `reconciled` basis rather than either estimate.
     */
    expect(src).toMatch(/pricing\.basis === "reconciled"/);
  });

  /**
   * THE GUARD AND THE WINDOW AROUND IT ARE DIFFERENT PROBLEMS.
   *
   * `priceVoiceCall`'s `costReconciledAt` check reads a snapshot taken before
   * the Twilio fetch, and that fetch is slow enough for reconciliation to
   * commit inside the window — after which the writer puts a duration
   * estimate over xAI's own number while the timestamp stays populated
   * (Codex, PR #268 round 8; round 2 added the guard, this closes the race).
   *
   * The decision is now made by the database in the same statement as the
   * write, so every writer that prices a call has to go through it.
   */
  /**
   * A SEPARATE LIST, because `files` above exists for the literal-rate check
   * and never included callCostService — which is the file with THREE
   * pricing sites. Reverting one of its writers passed the whole suite until
   * this was noticed, which is the same mistake in a test that the code
   * keeps making: the thing you did not look at is where it lives.
   */
  const pricingFiles = [
    '../voiceAgentRoutes.ts',
    '../../server/routes.ts',
    './callCostService.ts',
  ];

  it('EVERY pricing site has a protected write, counted one for one', () => {
    // Counted rather than merely present: a file with three pricing blocks
    // and one protected write passed the presence check while two writers
    // still clobbered a reconciled cost.
    const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
    for (const f of pricingFiles) {
      const text = read(f);
      const prices = count(text, /priceVoiceCall\(\{/g);
      if (prices === 0) continue;
      const protectedWrites =
        count(text, /updateCallLogPreservingReconciledCost\(/g) +
        // A direct db.update is fine when it carries the same guard in its WHERE.
        count(text, /isNull\(callLogs\.costReconciledAt\)/g);
      expect(protectedWrites, `${f}: ${prices} pricing site(s), ${protectedWrites} protected write(s)`)
        .toBeGreaterThanOrEqual(prices);
    }
  });

  /**
   * AND THE ONE ABOVE COULD NOT SEE THE WRITER THAT WAS ACTUALLY BROKEN.
   *
   * It counts `priceVoiceCall` sites against protected writes, so a writer
   * that prices some OTHER way contributes nothing to either side and is
   * invisible. `updateCallCosts` — the admin recalculate button — computed
   * its own OpenAI estimate from synthesised audio metrics and wrote it
   * raw, and this file said the file was fully protected the whole time
   * (Codex, PR #268 round 11). Three more went the same way unnoticed: two
   * teardown writes setting cost_is_estimated and the Twilio backfill sweep
   * rebuilding total_cost_cents.
   *
   * So the invariant is stated over the COLUMNS instead of over the pricing
   * calls, and it walks the whole tree rather than a hand-kept list — the
   * two things every previous version of this pin got wrong. It needs no
   * knowledge of how a number was arrived at: these three columns are not
   * written through the unguarded door, by anyone, ever.
   */
  it('NOTHING writes the three defended columns through the raw door', () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const DEFENDED = ['openaiCostCents', 'totalCostCents', 'costIsEstimated'];

    /** The argument list of the call whose opening paren is at `open`. */
    const callArguments = (src: string, open: number): string => {
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
      }
      return src.slice(open);
    };

    /**
     * THE BLOCK THE CALL SITS IN, walked backwards through braces.
     *
     * The first version of this scan read only the text between the call's own
     * parentheses, so it saw an inline object literal and nothing else. A
     * writer that builds `updateData` over twenty lines and then passes the
     * NAME was invisible to it, and `twilioInsightsService.ts` was doing
     * exactly that with total_cost_cents and cost_is_estimated while this test
     * reported the tree clean (Codex, PR #268 round 12). Two levels out
     * reaches past the enclosing `if`/`try` to the method body, which is where
     * such an object is assembled.
     */
    const enclosingBlock = (src: string, at: number, levels = 2): string => {
      let start = at;
      for (let level = 0; level < levels; level++) {
        let depth = 0;
        let found = -1;
        for (let i = start; i >= 0; i--) {
          if (src[i] === '}') depth++;
          else if (src[i] === '{') {
            if (depth === 0) { found = i; break; }
            depth--;
          }
        }
        if (found === -1) return src.slice(0, at);
        start = found - 1;
      }
      return src.slice(start, at);
    };

    /** The braced object literal that starts at or after `from`. */
    const objectLiteralAt = (src: string, from: number): string => {
      const open = src.indexOf('{', from);
      if (open === -1) return '';
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
      }
      return src.slice(open);
    };

    const offenders: string[] = [];
    for (const dir of ['src', 'server', 'client']) {
      const entries = readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name);
        const src = readFileSync(path, 'utf8');
        // `.updateCallLog(` cannot match the preserving method — the next
        // character after updateCallLog there is 'P', not '('.
        for (const m of src.matchAll(/\.updateCallLog\(/g)) {
          const args = callArguments(src, m.index + m[0].length - 1);
          // Inline literal: the columns are right there.
          const wrote = new Set(DEFENDED.filter((c) => new RegExp(`\\b${c}\\s*:`).test(args)));

          /**
           * Identifier argument: the columns were put on the object earlier.
           * Every name mentioned after the id is a candidate — `updateData`,
           * `{ ...updateData }`, `patch` — and each is confirmed against the
           * enclosing block in one of the only two ways such an object is
           * built. Over-approximating the CANDIDATES is safe; the two
           * confirmations are what keep it from crying wolf on an inline
           * literal's own keys and values.
           */
          const secondArgOnward = args.slice(args.indexOf(',') + 1);
          const candidates = new Set(
            [...secondArgOnward.matchAll(/[A-Za-z_$][\w$]*/g)].map((r) => r[0]),
          );
          if (candidates.size > 0) {
            const block = enclosingBlock(src, m.index);
            for (const name of candidates) {
              for (const c of DEFENDED) {
                if (wrote.has(c)) continue;
                // 1. assigned onto it:  updateData.totalCostCents = ...
                //                       updateData['totalCostCents'] = ...
                const assigned = new RegExp(
                  `\\b${name}\\s*(?:\\.${c}\\b|\\[\\s*['"\`]${c}['"\`]\\s*\\])\\s*=`,
                );
                if (assigned.test(block)) { wrote.add(c); continue; }
                // 2. declared with it:  const patch = { totalCostCents: 1 }
                const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*\\{`);
                const dm = decl.exec(block);
                if (dm && new RegExp(`\\b${c}\\s*:`).test(objectLiteralAt(block, dm.index))) {
                  wrote.add(c);
                }
              }
            }
          }
          if (wrote.size === 0) continue;
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(
            `${relative(repoRoot, path)}:${line} writes ${[...wrote].join(', ')} through storage.updateCallLog`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * THESE TWO CHECKS USED TO READ server/storage.ts AS TEXT, and both are
   * gone — replaced, not dropped, by something strictly stronger.
   *
   * They asserted that the SET clause named the column and consumed the
   * resolved Twilio value. A source scan is all that was possible while the
   * clause lived inside a method that needs a database to reach, and its
   * limits showed twice on this PR: a mutation ignoring the incoming value
   * passed cleanly (round 9), and so did a total rebuilt from the stale
   * column (round 10). Drizzle renders a query with no connection, so the
   * clause now lives in server/preservedCostSet.ts and
   * server/preservedCostSet.test.ts reads THE GENERATED SQL for every case
   * these two approximated.
   *
   * What is left here is the structural half a rendering test cannot cover:
   * that the clause stays somewhere it can be rendered at all.
   */
  it('the preserving clause is built where a test can render it', () => {
    const storage = read('../../server/storage.ts');
    // storage.ts delegates and does not assemble SQL of its own...
    expect(storage).toMatch(/buildPreservedCostSet\(/);
    expect(
      storage.slice(
        storage.indexOf('async updateCallLogPreservingReconciledCost'),
        storage.indexOf('async getCallLogBySid'),
      ),
      'the clause has drifted back into the untestable place',
    ).not.toMatch(/CASE WHEN/);
    // ...and the module it delegates to imports no database.
    const clause = read('../../server/preservedCostSet.ts');
    expect(clause).not.toMatch(/from ['"]\.\/db['"]/);
    // The guard is read from the COLUMN. A CASE over a constant would pass a
    // shape check and protect nothing.
    expect(clause).toMatch(/callLogs\.costReconciledAt\} IS NOT NULL/);
    expect(clause).toMatch(/resolveTwilioCostWrite\(/);
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
