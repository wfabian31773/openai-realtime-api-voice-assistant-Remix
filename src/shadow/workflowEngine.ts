/**
 * Deterministic shadow workflow engine (Checkpoints 7 & 9).
 *
 * The reasoning layer is ADVISORY. This engine is the authority on legality:
 * it takes the current ShadowConversationState plus a ShadowReasoningResult and
 * returns the final (legal) recommended action with violation codes for
 * anything it had to overrule. It never executes anything.
 */
import type {
  RecommendedAction,
  ShadowConversationState,
  ShadowReasoningResult,
} from './contracts';

export interface WorkflowDefinition {
  agentId: string;
  /** Ordered nominal flow; transitions may skip forward but not backward except via correction/restart. */
  steps: string[];
  /** step -> legal next steps (in addition to 'escalate' which is always legal). */
  transitions: Record<string, string[]>;
  /** intent -> required fields before any mutating tool may be recommended. */
  requiredFields: Record<string, string[]>;
  /** tools that mutate — require confirmation + completeness, never repeatable after success. */
  mutatingTools: string[];
  /** tools requiring explicit caller confirmation before recommendation. */
  confirmationRequired: string[];
  /** per-tool retry limit for failed production results. */
  retryLimit: number;
  /** intents that legitimately complete without any tool call. */
  informationalIntents: string[];
  /** urgency at or above this always makes 'escalate'/'transfer' legal. */
  escalationUrgency: 'elevated' | 'urgent' | 'emergency';
}

export interface EngineDecision {
  finalAction: RecommendedAction;
  finalTool?: string;
  legal: boolean;
  /** codes for every rule the advisory recommendation violated */
  violationCodes: string[];
  nextStep: string;
  rationale: string;
}

const URGENCY_RANK = { none: 0, elevated: 1, urgent: 2, emergency: 3 } as const;

export class ShadowWorkflowEngine {
  constructor(private defs: Map<string, WorkflowDefinition>) {}

  getDefinition(agentId: string): WorkflowDefinition | undefined {
    return this.defs.get(agentId);
  }

  evaluate(state: ShadowConversationState, reasoning: ShadowReasoningResult): EngineDecision {
    const def = this.defs.get(state.agentId);
    if (!def) {
      return {
        finalAction: 'escalate',
        legal: false,
        violationCodes: ['no_workflow_definition'],
        nextStep: state.currentStep,
        rationale: `No workflow definition for agent ${state.agentId}`,
      };
    }

    const violations: string[] = [];
    let action: RecommendedAction = reasoning.recommendedAction;
    let tool = reasoning.recommendedTool;

    // 0. A completed workflow never continues (attempted action after completion).
    if (state.status === 'completed' || state.status === 'escalated') {
      if (action !== 'complete') violations.push('workflow_already_completed');
      return {
        finalAction: 'complete',
        legal: violations.length === 0,
        violationCodes: violations,
        nextStep: 'complete',
        rationale: 'Session already finalized; no further actions are legal.',
      };
    }

    // 1. Urgency overrides: escalation is always legal at/above the threshold.
    if (URGENCY_RANK[reasoning.urgency] >= URGENCY_RANK[def.escalationUrgency]) {
      return {
        finalAction: reasoning.urgency === 'emergency' ? 'escalate' : action === 'transfer' ? 'transfer' : 'escalate',
        legal: true,
        violationCodes: [],
        nextStep: 'escalate',
        rationale: `Urgency ${reasoning.urgency} meets escalation threshold; safety path always legal.`,
      };
    }

    const required = def.requiredFields[reasoning.intent] ?? [];
    const missing = required.filter((f) => !state.collectedFields[f]);

    // 2. Mutating tool discipline.
    if (action === 'simulate_tool_call' && tool) {
      const mutating = def.mutatingTools.includes(tool);
      if (mutating && missing.length > 0) {
        violations.push('tool_recommended_with_missing_fields');
        action = 'ask_question';
        tool = undefined;
      } else if (mutating && state.completedActions.includes(tool)) {
        violations.push('duplicate_completed_mutation');
        action = 'respond';
        tool = undefined;
      } else if (
        mutating &&
        def.confirmationRequired.includes(reasoning.recommendedTool ?? '') &&
        !state.confirmedFields.includes(`confirm:${reasoning.recommendedTool}`)
      ) {
        violations.push('mutation_without_confirmation');
        action = 'confirm';
      } else if ((state.retryCounts[tool ?? ''] ?? 0) >= def.retryLimit) {
        violations.push('retry_limit_exceeded');
        action = 'escalate';
        tool = undefined;
      }
    }

    // 3. One-question-at-a-time + no repeat questions.
    if (action === 'ask_question') {
      const topic = topicForQuestion(reasoning);
      const alreadyAnswered = topic && state.collectedFields[topic];
      if (alreadyAnswered) {
        violations.push('question_already_answered');
        // Re-target the first genuinely missing field, else move on.
        const nextMissing = missing.find((f) => f !== topic);
        if (nextMissing) {
          action = 'ask_question';
        } else if (required.length > 0 && missing.length === 0) {
          action = def.confirmationRequired.length > 0 ? 'confirm' : 'respond';
        } else {
          action = 'respond';
        }
      }
      if (
        state.pendingQuestion &&
        topic &&
        state.pendingQuestion.topic === topic &&
        state.turnCount - state.pendingQuestion.askedAtTurn <= 1 &&
        !newInformationSince(state)
      ) {
        violations.push('repeated_question_without_new_info');
      }
    }

    // 4. Completion criteria: don't complete with an unserved primary intent.
    if (action === 'complete') {
      const informational = def.informationalIntents.includes(reasoning.intent);
      const served =
        informational ||
        state.completedActions.length > 0 ||
        state.simulatedToolHistory.some((t) => t.allowed);
      if (!served && state.turnCount > 1) {
        violations.push('premature_completion');
        action = missing.length > 0 ? 'ask_question' : 'respond';
      }
    }

    // 5. Step-transition legality.
    const targetStep = stepForAction(action);
    const legalNext = new Set([...(def.transitions[state.currentStep] ?? []), 'escalate', state.currentStep]);
    let nextStep = targetStep;
    if (!legalNext.has(targetStep)) {
      violations.push(`illegal_transition:${state.currentStep}->${targetStep}`);
      nextStep = state.currentStep;
    }

    return {
      finalAction: action,
      finalTool: action === 'simulate_tool_call' ? tool : undefined,
      legal: violations.length === 0,
      violationCodes: violations,
      nextStep,
      rationale:
        violations.length === 0
          ? `Advisory action '${reasoning.recommendedAction}' is legal in step '${state.currentStep}'.`
          : `Overruled advisory '${reasoning.recommendedAction}': ${violations.join(', ')}.`,
    };
  }
}

export function stepForAction(action: RecommendedAction): string {
  switch (action) {
    case 'ask_question':
      return 'collect_fields';
    case 'confirm':
      return 'confirm';
    case 'simulate_tool_call':
      return 'simulate_tool';
    case 'simulate_n8n_decision':
      return 'simulate_n8n';
    case 'respond':
      return 'respond';
    case 'transfer':
      return 'transfer';
    case 'escalate':
      return 'escalate';
    case 'complete':
      return 'complete';
  }
}

function topicForQuestion(reasoning: ShadowReasoningResult): string | null {
  if (reasoning.missingFields.length > 0) return reasoning.missingFields[0];
  return null;
}

/** Did the caller's latest turn add any field we didn't have? */
function newInformationSince(state: ShadowConversationState): boolean {
  return Object.values(state.collectedFields).some((f) => f.providedAtTurn >= state.turnCount);
}
