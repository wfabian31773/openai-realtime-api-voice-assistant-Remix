/** Checkpoint 18 — contracts, tool simulator, loop detector, comparison, evaluation. */
import { describe, expect, it } from 'vitest';
import {
  initialState,
  shadowEventSchema,
  shadowConversationStateSchema,
  shadowReasoningResultSchema,
  simulatedToolRecordSchema,
  digest,
  type ShadowReasoningResult,
} from './contracts';
import { simulateToolCall } from './toolSimulator';
import { LoopDetector } from './loopDetector';
import { compareTurn, summarizeSession, LIMITATION_TEXT } from './comparison';
import { evaluateSession, ReviewQueue } from './evaluation';
import { stepForAction } from './workflowEngine';

function mkReasoning(p: Partial<ShadowReasoningResult> = {}): ShadowReasoningResult {
  return {
    contractVersion: 1, intent: 'ticket_request', confidence: 0.9, extractedFields: {},
    missingFields: [], ambiguous: false, urgency: 'none', multiIntent: false, secondaryIntents: [],
    recommendedAction: 'respond', rationaleCode: 't', selectedModelTier: 'deterministic',
    modelSelectionReason: 't', ...p,
  };
}

describe('contract schemas (contract tests)', () => {
  it('accepts valid events and rejects malformed ones', () => {
    const good = shadowEventSchema.safeParse({
      contractVersion: 1, eventId: 'e1', sessionId: 's', agentId: 'no-ivr',
      ts: new Date().toISOString(), type: 'user_transcript', payload: { text: 'x' },
      source: { component: 'transcript' }, sensitive: true,
    });
    expect(good.success).toBe(true);
    expect(shadowEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(shadowEventSchema.safeParse({
      contractVersion: 1, eventId: 'e1', sessionId: 's', agentId: 'a',
      ts: 'x', type: 'not_a_type', payload: {}, source: { component: 'transcript' }, sensitive: false,
    }).success).toBe(false);
  });

  it('state and reasoning schemas validate their initial/typical shapes', () => {
    expect(shadowConversationStateSchema.safeParse(initialState('s', 'no-ivr')).success).toBe(true);
    expect(shadowReasoningResultSchema.safeParse(mkReasoning()).success).toBe(true);
  });

  it('simulated tool records cannot represent execution (literal type enforced)', () => {
    const bad = simulatedToolRecordSchema.safeParse({
      tool: 't', args: {}, allowed: true, validationCode: 'ok', missingFields: [],
      confirmationRequired: false, executionMode: 'execute', mutating: true, atTurn: 1,
    });
    expect(bad.success).toBe(false);
  });

  it('stepForAction maps every action to a workflow step', () => {
    for (const a of ['ask_question', 'confirm', 'simulate_tool_call', 'simulate_n8n_decision', 'respond', 'transfer', 'escalate', 'complete'] as const) {
      expect(stepForAction(a)).toBeTruthy();
    }
  });
});

describe('tool simulator validation', () => {
  it('validates args, reports missing fields, honors confirmation and duplicates', () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 2;
    const r1 = simulateToolCall(st, mkReasoning(), 'create_ticket', {});
    expect(r1.allowed).toBe(false);
    expect(r1.validationCode).toBe('missing_required_fields');
    expect(r1.missingFields).toEqual(['callerName', 'callerPhone', 'reason']);
    expect(r1.confirmationRequired).toBe(true);

    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: true };
    }
    const r2 = simulateToolCall(st, mkReasoning(), 'create_ticket', { patientFullName: 'X', patientPhone: '5550000000', reasonForCalling: 'y' });
    expect(r2.allowed).toBe(true);

    st.completedActions.push('create_ticket');
    const r3 = simulateToolCall(st, mkReasoning(), 'create_ticket', { patientFullName: 'X', patientPhone: '5550000000', reasonForCalling: 'y' });
    expect(r3.allowed).toBe(false);
    expect(r3.validationCode).toBe('duplicate_completed_mutation');
  });

  it('rejects tools not available to the agent and unknown tools', () => {
    const st = initialState('s', 'fantasy-football');
    expect(simulateToolCall(st, mkReasoning(), 'sage_book', {}).validationCode).toBe('tool_not_available_to_agent');
    expect(simulateToolCall(st, mkReasoning(), 'not_a_tool', {}).validationCode).toBe('unknown_tool');
  });

  it('production-result replay metadata is attached when history exists', () => {
    const st = initialState('s', 'no-ivr');
    st.productionToolHistory.push({
      tool: 'lookup_schedule', argsDigest: 'd', argsRedacted: {}, outcome: 'completed',
      resultDigest: 'res123', errored: false, atTurn: 1,
    });
    const r = simulateToolCall(st, mkReasoning(), 'lookup_schedule', {});
    expect(r.productionReplay?.matched).toBe(true);
    expect(r.productionReplay?.productionResultDigest).toBe('res123');
  });
});

describe('loop detector', () => {
  it('flags a repeated question without new info and an ignored answer', () => {
    const st = initialState('s', 'no-ivr');
    const ld = new LoopDetector();
    st.turnCount = 1;
    ld.observeProductionTurn(st, { turn: 1, agentText: 'May I have your first and last name?' });
    st.turnCount = 2;
    ld.observeProductionTurn(st, { turn: 2, agentText: 'May I have your first and last name?' });
    expect(ld.signals.some((s) => s.loopType === 'repeated_question' && s.source === 'production')).toBe(true);

    st.collectedFields['callerName'] = { value: 'John Roe', providedAtTurn: 2, provenance: 'caller', confirmed: false };
    st.turnCount = 3;
    ld.observeProductionTurn(st, { turn: 3, agentText: 'And your name please?' });
    expect(ld.signals.some((s) => s.loopType === 'ignored_answer')).toBe(true);
  });

  it('flags bundled questions, repeated identical tool calls, and duplicate mutations', () => {
    const st = initialState('s', 'no-ivr');
    const ld = new LoopDetector();
    st.turnCount = 1;
    ld.observeProductionTurn(st, { turn: 1, agentText: 'What is your name? And your phone number? And your date of birth?' });
    expect(ld.signals.some((s) => s.loopType === 'bundled_questions')).toBe(true);
    ld.observeProductionTurn(st, { turn: 1, toolCalls: [{ tool: 'create_ticket', argsDigest: 'same' }] });
    ld.observeProductionTurn(st, { turn: 2, toolCalls: [{ tool: 'create_ticket', argsDigest: 'same' }] });
    expect(ld.signals.some((s) => s.loopType === 'repeated_tool_call')).toBe(true);
    ld.observeDuplicateCompletedAction(3, 'create_ticket', 'production');
    expect(ld.signals.some((s) => s.loopType === 'duplicate_completed_action')).toBe(true);
  });

  it('flags unchanged state, alternating states, and n8n re-triggers', () => {
    const st = initialState('s', 'no-ivr');
    const ld = new LoopDetector();
    for (let t = 1; t <= 3; t++) {
      st.turnCount = t;
      ld.observeStateSnapshot(st, 'SAME');
    }
    expect(ld.signals.some((s) => s.loopType === 'unchanged_state')).toBe(true);

    const ld2 = new LoopDetector();
    const steps = ['collect_fields', 'confirm', 'collect_fields', 'confirm'];
    steps.forEach((step, i) => {
      st.turnCount = i + 1;
      st.currentStep = step;
      ld2.observeStateSnapshot(st, `d${i}`);
    });
    expect(ld2.signals.some((s) => s.loopType === 'alternating_states')).toBe(true);

    ld2.observeN8nTrigger(1, '/api/voice-agent/submit-ticket', 'production');
    ld2.observeN8nTrigger(2, '/api/voice-agent/submit-ticket', 'production');
    expect(ld2.signals.some((s) => s.loopType === 'repeated_n8n_trigger')).toBe(true);
  });
});

describe('comparison + evaluation', () => {
  it('produces disagreement codes and the mandatory limitation text', () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const reasoning = mkReasoning({ recommendedAction: 'ask_question', userFacingQuestion: 'May I have your name?', missingFields: ['callerName'] });
    const cmp = compareTurn(
      st,
      { turn: 1, assistantMessage: 'Done! I filed your ticket. What is your name? And your number?', toolRequest: { tool: 'create_ticket', argsDigest: 'x', prematureFields: ['callerName'] }, n8nEndpoint: '/api/voice-agent/submit-ticket', inferredIntent: null, inferredState: null, escalated: false },
      reasoning,
      { finalAction: 'ask_question', legal: true, violationCodes: [], nextStep: 'collect_fields', rationale: '' },
      [],
    );
    expect(cmp.disagreementCodes).toContain('action_mismatch');
    expect(cmp.disagreementCodes).toContain('production_premature_tool');
    expect(cmp.disagreementCodes).toContain('production_bundled_questions');
    expect(cmp.disagreementCodes).toContain('n8n_workflow_mismatch');

    const summary = summarizeSession(st, [cmp]);
    expect(summary.limitation).toBe(LIMITATION_TEXT);
    expect(summary.limitation).toContain('no claim');

    const evaln = evaluateSession(summary, [cmp]);
    expect(evaln.verdict).toBe('human_review');
    expect(evaln.reviewPriority).toBeGreaterThanOrEqual(70);

    const q = new ReviewQueue();
    q.add(summary, evaln);
    expect(q.list()[0].sessionId).toBe('s');
  });

  it('equivalent verdict for agreeing turns with clean hygiene', () => {
    const st = initialState('s2', 'no-ivr');
    st.turnCount = 1;
    const reasoning = mkReasoning({ recommendedAction: 'respond', proposedResponse: 'We are open until five.' });
    const cmp = compareTurn(
      st,
      { turn: 1, assistantMessage: 'We close at five today.', toolRequest: null, n8nEndpoint: null, inferredIntent: null, inferredState: null, escalated: false },
      reasoning,
      { finalAction: 'respond', legal: true, violationCodes: [], nextStep: 'respond', rationale: '' },
      [],
    );
    expect(cmp.actionMatch).toBe(true);
    const summary = summarizeSession(st, [cmp]);
    const evaln = evaluateSession(summary, [cmp]);
    expect(evaln.verdict).toBe('equivalent');
  });

  it('digest is stable for identical values and differs otherwise', () => {
    expect(digest({ a: 1 })).toBe(digest({ a: 1 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });
});
