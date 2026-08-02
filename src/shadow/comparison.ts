/**
 * Production-versus-shadow comparison engine (Checkpoint 13). Spec: doc 07.
 *
 * HARD LIMITATION, stated on every session summary: the shadow observes caller
 * responses to PRODUCTION's questions. When shadow proposes a different
 * question, subsequent caller turns answer production, not shadow — so shadow
 * "would-have" paths are counterfactual and never claimed as certain outcomes.
 */
import { z } from 'zod';
import { digest, type LoopSignal, type ShadowConversationState, type ShadowReasoningResult } from './contracts';
import type { EngineDecision } from './workflowEngine';
import { countQuestions } from './loopDetector';

export const DISAGREEMENT_CODES = [
  'intent_mismatch',
  'action_mismatch',
  'tool_mismatch',
  'tool_args_mismatch',
  'n8n_workflow_mismatch',
  'production_bundled_questions',
  'shadow_bundled_questions',
  'production_repeated_question',
  'shadow_repeated_question',
  'production_premature_tool',
  'shadow_premature_tool',
  'production_premature_n8n',
  'shadow_premature_n8n',
  'state_loss_signal',
  'escalation_mismatch',
  'urgency_mismatch',
  'duplicate_action_risk',
  'shadow_blocked_would_be_mutation',
] as const;
export type DisagreementCode = (typeof DISAGREEMENT_CODES)[number];

export const turnComparisonSchema = z.object({
  turn: z.number(),
  productionIntentInferred: z.string().nullable(),
  productionAssistantMessage: z.string().nullable(),
  productionToolRequest: z.string().nullable(),
  productionToolArgsDigest: z.string().nullable(),
  productionN8nEndpoint: z.string().nullable(),
  observedProductionState: z.string().nullable(),
  shadowIntent: z.string(),
  shadowStep: z.string(),
  shadowAction: z.string(),
  shadowQuestion: z.string().nullable(),
  shadowResponse: z.string().nullable(),
  shadowTool: z.string().nullable(),
  shadowToolArgsDigest: z.string().nullable(),
  shadowN8nWorkflow: z.string().nullable(),
  modelTier: z.string(),
  intentMatch: z.boolean().nullable(),
  actionMatch: z.boolean(),
  toolMatch: z.boolean(),
  n8nMatch: z.boolean(),
  reviewRequired: z.boolean(),
  disagreementCodes: z.array(z.enum(DISAGREEMENT_CODES)),
});
export type TurnComparison = z.infer<typeof turnComparisonSchema>;

export interface SessionComparisonSummary {
  sessionId: string;
  agentId: string;
  turns: number;
  intentAgreementPct: number | null;
  actionAgreementPct: number;
  toolAgreementPct: number;
  toolArgsAgreementPct: number;
  n8nAgreementPct: number;
  repeatedQuestionCount: { production: number; shadow: number };
  bundledQuestionCount: { production: number; shadow: number };
  loopCount: number;
  prematureToolCount: { production: number; shadow: number };
  prematureN8nCount: { production: number; shadow: number };
  duplicateActionCount: number;
  stateLossCount: number;
  escalationAgreement: boolean | null;
  productionOutcome: string | null;
  shadowPredictedOutcome: string | null;
  modelTierDistribution: Record<string, number>;
  avgReasoningLatencyMs: number;
  estShadowCostUsd: number;
  n8nExecutionEstimate: number;
  reviewRequiredPct: number;
  disagreementCodeCounts: Record<string, number>;
  limitation: string;
}

export const LIMITATION_TEXT =
  'Counterfactual limitation: callers answered PRODUCTION questions. Shadow paths after any divergence are hypothetical; no claim is made that the shadow conversation would have completed successfully.';

export interface ProductionTurnFacts {
  turn: number;
  assistantMessage: string | null;
  toolRequest: { tool: string; argsDigest: string; prematureFields?: string[] } | null;
  n8nEndpoint: string | null;
  inferredIntent: string | null;
  inferredState: string | null;
  escalated: boolean;
}

export function compareTurn(
  state: ShadowConversationState,
  prod: ProductionTurnFacts,
  reasoning: ShadowReasoningResult,
  decision: EngineDecision,
  loopSignals: LoopSignal[],
): TurnComparison {
  const codes: DisagreementCode[] = [];

  const shadowTool = decision.finalTool ?? null;
  const prodTool = prod.toolRequest?.tool ?? null;
  const toolMatch = (shadowTool ?? '') === (prodTool ?? '');
  if (!toolMatch && (shadowTool || prodTool)) codes.push('tool_mismatch');

  let argsMatch = true;
  if (toolMatch && shadowTool && prod.toolRequest && reasoning.simulatedToolArgs) {
    argsMatch = digest(reasoning.simulatedToolArgs) === prod.toolRequest.argsDigest;
    if (!argsMatch) codes.push('tool_args_mismatch');
  }

  const prodActedWithTool = prodTool !== null;
  const shadowActsWithTool = decision.finalAction === 'simulate_tool_call';
  const actionMatch =
    (prodActedWithTool && shadowActsWithTool) ||
    (!prodActedWithTool && !shadowActsWithTool);
  if (!actionMatch) codes.push('action_mismatch');

  const intentMatch = prod.inferredIntent ? prod.inferredIntent === reasoning.intent : null;
  if (intentMatch === false) codes.push('intent_mismatch');

  const shadowN8n = state.simulatedN8nHistory.find((r) => r.atTurn === state.turnCount)?.workflow ?? null;
  const prodN8n = prod.n8nEndpoint;
  const n8nMatch = !!shadowN8n === !!prodN8n;
  if (!n8nMatch) codes.push('n8n_workflow_mismatch');

  if (prod.assistantMessage && countQuestions(prod.assistantMessage) >= 2) codes.push('production_bundled_questions');
  if (reasoning.userFacingQuestion && countQuestions(reasoning.userFacingQuestion) >= 2) codes.push('shadow_bundled_questions');

  for (const s of loopSignals) {
    if (s.repeatAtTurn !== state.turnCount) continue;
    if (s.loopType === 'repeated_question' || s.loopType === 'ignored_answer') {
      codes.push(s.source === 'production' ? 'production_repeated_question' : 'shadow_repeated_question');
    }
    if (s.loopType === 'state_regression' || s.loopType === 'unchanged_state') codes.push('state_loss_signal');
    if (s.loopType === 'duplicate_completed_action') codes.push('duplicate_action_risk');
  }

  if (prod.toolRequest?.prematureFields?.length) codes.push('production_premature_tool');
  const shadowSim = state.simulatedToolHistory.find((t) => t.atTurn === state.turnCount);
  if (shadowSim && !shadowSim.allowed && shadowSim.validationCode === 'missing_required_fields') {
    codes.push('shadow_premature_tool');
  }
  if (shadowSim && shadowSim.mutating && shadowSim.allowed) {
    // Every allowed mutating simulation is, by definition, a mutation the
    // shadow was technically blocked from making. Recorded for review priority.
    codes.push('shadow_blocked_would_be_mutation');
  }

  const prodEscalated = prod.escalated;
  const shadowEscalates = decision.finalAction === 'escalate' || decision.finalAction === 'transfer';
  if (prodEscalated !== shadowEscalates) codes.push('escalation_mismatch');
  if (reasoning.urgency !== 'none' && !prodEscalated && shadowEscalates) codes.push('urgency_mismatch');

  const reviewRequired = codes.some((c) =>
    ['tool_mismatch', 'escalation_mismatch', 'urgency_mismatch', 'duplicate_action_risk', 'state_loss_signal', 'n8n_workflow_mismatch'].includes(c),
  );

  return {
    turn: state.turnCount,
    productionIntentInferred: prod.inferredIntent,
    productionAssistantMessage: prod.assistantMessage,
    productionToolRequest: prodTool,
    productionToolArgsDigest: prod.toolRequest?.argsDigest ?? null,
    productionN8nEndpoint: prodN8n,
    observedProductionState: prod.inferredState,
    shadowIntent: reasoning.intent,
    shadowStep: decision.nextStep,
    shadowAction: decision.finalAction,
    shadowQuestion: reasoning.userFacingQuestion ?? null,
    shadowResponse: reasoning.proposedResponse ?? null,
    shadowTool,
    shadowToolArgsDigest: reasoning.simulatedToolArgs ? digest(reasoning.simulatedToolArgs) : null,
    shadowN8nWorkflow: shadowN8n,
    modelTier: reasoning.selectedModelTier,
    intentMatch,
    actionMatch,
    toolMatch,
    n8nMatch,
    reviewRequired,
    disagreementCodes: [...new Set(codes)],
  };
}

export function summarizeSession(
  state: ShadowConversationState,
  turns: TurnComparison[],
  extras: { avgReasoningLatencyMs?: number; estShadowCostUsd?: number } = {},
): SessionComparisonSummary {
  const n = Math.max(1, turns.length);
  const pct = (k: (t: TurnComparison) => boolean | null): number => {
    const applicable = turns.filter((t) => k(t) !== null);
    if (applicable.length === 0) return 100;
    return Math.round((applicable.filter((t) => k(t) === true).length / applicable.length) * 100);
  };
  const codeCounts: Record<string, number> = {};
  for (const t of turns) for (const c of t.disagreementCodes) codeCounts[c] = (codeCounts[c] ?? 0) + 1;
  const tierDist: Record<string, number> = {};
  for (const t of turns) tierDist[t.modelTier] = (tierDist[t.modelTier] ?? 0) + 1;

  const intentApplicable = turns.some((t) => t.intentMatch !== null);
  const prodEsc = turns.some((t) => t.disagreementCodes.includes('escalation_mismatch'));

  return {
    sessionId: state.sessionId,
    agentId: state.agentId,
    turns: turns.length,
    intentAgreementPct: intentApplicable ? pct((t) => t.intentMatch) : null,
    actionAgreementPct: pct((t) => t.actionMatch),
    toolAgreementPct: pct((t) => t.toolMatch),
    toolArgsAgreementPct: pct((t) => (t.toolMatch && t.productionToolRequest ? t.shadowToolArgsDigest === t.productionToolArgsDigest : null)),
    n8nAgreementPct: pct((t) => t.n8nMatch),
    repeatedQuestionCount: {
      production: state.loopSignals.filter((s) => s.source === 'production' && (s.loopType === 'repeated_question' || s.loopType === 'ignored_answer')).length,
      shadow: state.loopSignals.filter((s) => s.source === 'shadow' && s.loopType === 'repeated_question').length,
    },
    bundledQuestionCount: {
      production: turns.filter((t) => t.disagreementCodes.includes('production_bundled_questions')).length,
      shadow: turns.filter((t) => t.disagreementCodes.includes('shadow_bundled_questions')).length,
    },
    loopCount: state.loopSignals.length,
    prematureToolCount: {
      production: turns.filter((t) => t.disagreementCodes.includes('production_premature_tool')).length,
      shadow: turns.filter((t) => t.disagreementCodes.includes('shadow_premature_tool')).length,
    },
    prematureN8nCount: {
      production: turns.filter((t) => t.disagreementCodes.includes('production_premature_n8n')).length,
      shadow: turns.filter((t) => t.disagreementCodes.includes('shadow_premature_n8n')).length,
    },
    duplicateActionCount: turns.filter((t) => t.disagreementCodes.includes('duplicate_action_risk')).length,
    stateLossCount: turns.filter((t) => t.disagreementCodes.includes('state_loss_signal')).length,
    escalationAgreement: turns.length ? !prodEsc : null,
    productionOutcome: state.productionOutcome,
    shadowPredictedOutcome: state.shadowPredictedOutcome,
    modelTierDistribution: tierDist,
    avgReasoningLatencyMs: extras.avgReasoningLatencyMs ?? 0,
    estShadowCostUsd: extras.estShadowCostUsd ?? 0,
    n8nExecutionEstimate: state.simulatedN8nHistory.reduce((a, r) => a + r.budgetImpact, 0),
    reviewRequiredPct: Math.round((turns.filter((t) => t.reviewRequired).length / n) * 100),
    disagreementCodeCounts: codeCounts,
    limitation: LIMITATION_TEXT,
  };
}
