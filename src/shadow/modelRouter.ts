/**
 * Shadow model routing (Checkpoint 8). Policy: doc 05.
 * Only real, repo-configured model names (gpt-4o-mini / gpt-4o) — doc 01 §6.
 * Exists ONLY in the shadow path; production model selection is untouched.
 */
import type { ShadowConfig } from './config';
import type { ModelTier } from './contracts';

export interface RoutingSignals {
  ambiguityScore: number; // 0..1
  unresolvedFieldCount: number;
  candidateIntentCount: number;
  constraintCount: number;
  retryCount: number;
  conflictCount: number;
  policyComplexity: number;
  toolResultComplexity: number;
  escalationRequested: boolean;
}

export interface TierSelection {
  tier: ModelTier;
  model: string | null;
  reason: string;
  score: number;
}

export interface ModelCallLog {
  tier: ModelTier;
  model: string;
  reason: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  structuredOutputValid: boolean;
  fallbackUsed: boolean;
  error?: string;
  estCostUsd?: number;
}

/**
 * USD per 1M tokens (in/out). GPT-5.6 family verified against
 * developers.openai.com/api/docs/models on 2026-08-02; legacy 4o entries kept
 * for the pre-existing graders and for env overrides.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-5.6-sol': { in: 5, out: 30 },
  'gpt-5.6': { in: 5, out: 30 }, // alias of sol
  'gpt-5.6-terra': { in: 2, out: 12 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
};

export function estimateCostUsd(model: string, tokensIn = 0, tokensOut = 0): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function selectTier(
  signals: RoutingSignals,
  deterministicSufficient: boolean,
  cfg: ShadowConfig,
): TierSelection {
  if (deterministicSufficient || !cfg.modelRoutingEnabled) {
    return {
      tier: 'deterministic',
      model: null,
      reason: cfg.modelRoutingEnabled
        ? 'workflow state fully determines the next action'
        : 'model routing disabled (deterministic only)',
      score: 0,
    };
  }
  const score =
    2 * signals.ambiguityScore +
    (signals.candidateIntentCount > 1 ? 1 : 0) +
    signals.conflictCount +
    (signals.retryCount >= 2 ? 1 : 0) +
    (signals.constraintCount >= 3 ? 1 : 0) +
    signals.toolResultComplexity +
    signals.policyComplexity;

  if (signals.escalationRequested || score > 3) {
    return { tier: 'high', model: cfg.modelHigh, reason: `score=${score.toFixed(1)} or escalation`, score };
  }
  if (score === 0) {
    return { tier: 'low', model: cfg.modelLow, reason: 'routine interpretation (score=0)', score };
  }
  return { tier: 'mid', model: cfg.modelMid, reason: `elevated signals (score=${score.toFixed(1)})`, score };
}

/** Per-process budget ledger for shadow model spend. */
export class ModelBudget {
  private callsBySession = new Map<string, number>();
  private daySpendUsd = 0;
  private dayKey = '';
  readonly logs: ModelCallLog[] = [];

  constructor(private cfg: ShadowConfig) {}

  allow(sessionId: string, now: Date = new Date()): { allowed: boolean; reason: string } {
    const key = now.toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.daySpendUsd = 0;
    }
    if ((this.callsBySession.get(sessionId) ?? 0) >= this.cfg.modelMaxCallsPerSession) {
      return { allowed: false, reason: 'session model-call cap reached' };
    }
    if (this.daySpendUsd >= this.cfg.modelDailyCostCapUsd) {
      return { allowed: false, reason: 'daily model cost cap reached' };
    }
    return { allowed: true, reason: 'ok' };
  }

  record(sessionId: string, log: ModelCallLog): void {
    this.callsBySession.set(sessionId, (this.callsBySession.get(sessionId) ?? 0) + 1);
    if (log.estCostUsd) this.daySpendUsd += log.estCostUsd;
    this.logs.push(log);
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
  }

  releaseSession(sessionId: string): void {
    this.callsBySession.delete(sessionId);
  }
}
