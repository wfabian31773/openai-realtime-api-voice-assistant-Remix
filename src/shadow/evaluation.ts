/**
 * Evaluation framework (Checkpoint 14): deterministic verdicts + review queue.
 */
import type { SessionComparisonSummary, TurnComparison } from './comparison';

export type Verdict = 'better' | 'equivalent' | 'worse' | 'indeterminate' | 'human_review';

export interface SessionEvaluation {
  sessionId: string;
  verdict: Verdict;
  autoScores: Record<string, boolean | number>;
  reasons: string[];
  reviewPriority: number; // 0 = none, higher = review first
  reviewReasons: string[];
}

/** Deterministic, confidently-automatable checks only (doc 07 §5). */
export function evaluateSession(summary: SessionComparisonSummary, turns: TurnComparison[]): SessionEvaluation {
  const reasons: string[] = [];
  const reviewReasons: string[] = [];
  let priority = 0;

  const auto = {
    shadowRepeatedQuestions: summary.repeatedQuestionCount.shadow,
    productionRepeatedQuestions: summary.repeatedQuestionCount.production,
    shadowBundled: summary.bundledQuestionCount.shadow,
    productionBundled: summary.bundledQuestionCount.production,
    shadowPrematureTools: summary.prematureToolCount.shadow,
    productionPrematureTools: summary.prematureToolCount.production,
    duplicateActions: summary.duplicateActionCount,
    stateLoss: summary.stateLossCount,
    loops: summary.loopCount,
    n8nBudgetCompliant: summary.n8nExecutionEstimate <= 1,
    actionAgreementPct: summary.actionAgreementPct,
  };

  // Review-queue priorities (highest first), per Checkpoint 14.
  const codes = summary.disagreementCodeCounts;
  if ((codes['urgency_mismatch'] ?? 0) > 0) {
    priority = Math.max(priority, 100);
    reviewReasons.push('safety/urgency disagreement');
  }
  if ((codes['escalation_mismatch'] ?? 0) > 0) {
    priority = Math.max(priority, 90);
    reviewReasons.push('different escalation decisions');
  }
  if ((codes['tool_mismatch'] ?? 0) > 0) {
    priority = Math.max(priority, 80);
    reviewReasons.push('different tool choices');
  }
  if ((codes['n8n_workflow_mismatch'] ?? 0) > 0) {
    priority = Math.max(priority, 75);
    reviewReasons.push('different n8n involvement');
  }
  if ((codes['duplicate_action_risk'] ?? 0) > 0) {
    priority = Math.max(priority, 70);
    reviewReasons.push('duplicate-action risk');
  }
  if ((codes['state_loss_signal'] ?? 0) > 0) {
    priority = Math.max(priority, 60);
    reviewReasons.push('state-loss finding');
  }
  if ((codes['shadow_blocked_would_be_mutation'] ?? 0) > 0) {
    priority = Math.max(priority, 50);
    reviewReasons.push('shadow recommendation would have mutated production if not blocked');
  }
  if (auto.loops > 0) {
    priority = Math.max(priority, 40);
    reviewReasons.push('loop signals present');
  }
  if ((codes['shadow_premature_tool'] ?? 0) > 0 || (codes['production_premature_tool'] ?? 0) > 0) {
    priority = Math.max(priority, 35);
    reviewReasons.push('incomplete-field tool recommendation');
  }

  // Verdict — conservative. 'better'/'worse' only on hygiene dimensions the
  // rules can score confidently; anything caller-experience-shaped → review.
  let verdict: Verdict;
  const shadowHygieneWorse =
    auto.shadowRepeatedQuestions > auto.productionRepeatedQuestions ||
    auto.shadowBundled > auto.productionBundled ||
    auto.shadowPrematureTools > auto.productionPrematureTools;
  const shadowHygieneBetter =
    auto.shadowRepeatedQuestions < auto.productionRepeatedQuestions ||
    auto.shadowBundled < auto.productionBundled ||
    auto.shadowPrematureTools < auto.productionPrematureTools;

  if (priority >= 70) {
    verdict = 'human_review';
    reasons.push('high-priority disagreement present');
  } else if (summary.turns === 0) {
    verdict = 'indeterminate';
    reasons.push('no meaningful turns');
  } else if (shadowHygieneWorse && !shadowHygieneBetter) {
    verdict = 'worse';
    reasons.push('shadow hygiene metrics worse than production');
  } else if (shadowHygieneBetter && !shadowHygieneWorse && summary.actionAgreementPct >= 60) {
    verdict = 'better';
    reasons.push('shadow avoided hygiene defects production exhibited');
  } else if (summary.actionAgreementPct >= 80 && priority === 0) {
    verdict = 'equivalent';
    reasons.push('high agreement, no hygiene deltas');
  } else if (priority > 0) {
    verdict = 'human_review';
    reasons.push('meaningful disagreement below auto-verdict confidence');
  } else {
    verdict = 'indeterminate';
    reasons.push('mixed signals; no confident automated verdict');
  }

  return { sessionId: summary.sessionId, verdict, autoScores: auto, reasons, reviewPriority: priority, reviewReasons };
}

export interface ReviewQueueItem {
  sessionId: string;
  agentId: string;
  priority: number;
  reasons: string[];
  addedAt: string;
}

export class ReviewQueue {
  private items: ReviewQueueItem[] = [];

  add(summary: SessionComparisonSummary, evaln: SessionEvaluation): void {
    if (evaln.reviewPriority <= 0 && evaln.verdict !== 'human_review') return;
    this.items.push({
      sessionId: summary.sessionId,
      agentId: summary.agentId,
      priority: evaln.reviewPriority,
      reasons: evaln.reviewReasons,
      addedAt: new Date().toISOString(),
    });
    this.items.sort((a, b) => b.priority - a.priority);
    if (this.items.length > 500) this.items.length = 500;
  }

  list(): ReviewQueueItem[] {
    return [...this.items];
  }
}
