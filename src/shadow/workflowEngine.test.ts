/** Checkpoint 18 — exact state-transition and legality tests (CP 7 & 9). */
import { describe, expect, it } from 'vitest';
import { initialState, type ShadowReasoningResult } from './contracts';
import { buildWorkflowDefinitions } from './workflows';
import { ShadowWorkflowEngine } from './workflowEngine';

const engine = new ShadowWorkflowEngine(buildWorkflowDefinitions());

function reasoning(partial: Partial<ShadowReasoningResult>): ShadowReasoningResult {
  return {
    contractVersion: 1,
    intent: 'ticket_request',
    confidence: 0.9,
    extractedFields: {},
    missingFields: [],
    ambiguous: false,
    urgency: 'none',
    multiIntent: false,
    secondaryIntents: [],
    recommendedAction: 'respond',
    rationaleCode: 'test',
    selectedModelTier: 'deterministic',
    modelSelectionReason: 'test',
    ...partial,
  };
}

describe('ShadowWorkflowEngine legality', () => {
  it('has a definition for every active agent (doc 01)', () => {
    for (const slug of ['no-ivr', 'dev-no-ivr', 'answering-service', 'after-hours', 'azul-scheduling', 'appointment-confirmation', 'drs-scheduler', 'fantasy-football']) {
      expect(engine.getDefinition(slug), slug).toBeDefined();
    }
  });

  it('blocks a mutating tool while required fields are missing', () => {
    const st = initialState('s1', 'no-ivr');
    st.turnCount = 2;
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.violationCodes).toContain('tool_recommended_with_missing_fields');
    expect(d.finalAction).toBe('ask_question');
  });

  it('requires confirmation before a mutating tool even with all fields', () => {
    const st = initialState('s2', 'no-ivr');
    st.turnCount = 3;
    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: false };
    }
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.violationCodes).toContain('mutation_without_confirmation');
    expect(d.finalAction).toBe('confirm');
  });

  it('allows the mutating tool once fields are present and confirmed', () => {
    const st = initialState('s3', 'no-ivr');
    st.turnCount = 4;
    st.currentStep = 'confirm';
    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: true };
    }
    st.confirmedFields.push('confirm:create_ticket');
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.violationCodes).toEqual([]);
    expect(d.finalAction).toBe('simulate_tool_call');
    expect(d.finalTool).toBe('create_ticket');
  });

  it('never recommends the same completed mutation twice', () => {
    const st = initialState('s4', 'no-ivr');
    st.turnCount = 5;
    st.currentStep = 'interpret_result';
    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: true };
    }
    st.confirmedFields.push('confirm:create_ticket');
    st.completedActions.push('create_ticket');
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.violationCodes).toContain('duplicate_completed_mutation');
    expect(d.finalAction).not.toBe('simulate_tool_call');
  });

  it('enforces retry limits and escalates', () => {
    const st = initialState('s5', 'no-ivr');
    st.turnCount = 6;
    st.currentStep = 'interpret_result';
    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: true };
    }
    st.confirmedFields.push('confirm:create_ticket');
    st.retryCounts['create_ticket'] = 2;
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.violationCodes).toContain('retry_limit_exceeded');
    expect(d.finalAction).toBe('escalate');
  });

  it('never re-asks a question whose answer is stored', () => {
    const st = initialState('s6', 'no-ivr');
    st.turnCount = 3;
    st.currentStep = 'collect_fields';
    st.collectedFields['callerName'] = { value: 'Jane Doe', providedAtTurn: 2, provenance: 'caller', confirmed: false };
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'ask_question', missingFields: ['callerName'] }));
    expect(d.violationCodes).toContain('question_already_answered');
  });

  it('urgency at threshold makes escalation legal from any state', () => {
    const st = initialState('s7', 'after-hours');
    st.turnCount = 1;
    st.currentStep = 'start';
    const d = engine.evaluate(st, reasoning({ intent: 'urgent_symptom', urgency: 'urgent', recommendedAction: 'escalate' }));
    expect(d.legal).toBe(true);
    expect(d.finalAction).toBe('escalate');
  });

  it('a completed workflow never continues (action after completion)', () => {
    const st = initialState('s8', 'no-ivr');
    st.status = 'completed';
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'simulate_tool_call', recommendedTool: 'create_ticket' }));
    expect(d.finalAction).toBe('complete');
    expect(d.violationCodes).toContain('workflow_already_completed');
  });

  it('rejects illegal transitions (transfer -> collect_fields)', () => {
    const st = initialState('s9', 'no-ivr');
    st.turnCount = 4;
    st.currentStep = 'transfer';
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'ask_question', missingFields: ['callerPhone'] }));
    expect(d.violationCodes.some((v) => v.startsWith('illegal_transition:'))).toBe(true);
    expect(d.nextStep).toBe('transfer');
  });

  it('flags premature completion when the primary intent was never served', () => {
    const st = initialState('s10', 'no-ivr');
    st.turnCount = 3;
    st.currentStep = 'collect_fields';
    st.intent = 'ticket_request';
    const d = engine.evaluate(st, reasoning({ recommendedAction: 'complete', missingFields: ['callerPhone'] }));
    expect(d.violationCodes).toContain('premature_completion');
    expect(d.finalAction).toBe('ask_question');
  });

  it('unknown agent yields escalation with no_workflow_definition', () => {
    const st = initialState('s11', 'not-an-agent');
    const d = engine.evaluate(st, reasoning({}));
    expect(d.legal).toBe(false);
    expect(d.violationCodes).toContain('no_workflow_definition');
  });
});
