/** Checkpoint 18 — interpretation layer + model routing unit tests. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadShadowConfig, resetShadowConfig, type ShadowConfig } from './config';
import { initialState } from './contracts';
import { interpretTurn } from './reasoning';
import { ModelBudget, selectTier, type RoutingSignals } from './modelRouter';
import { buildWorkflowDefinitions } from './workflows';

const defs = buildWorkflowDefinitions();
const req = (agent: string) => (intent: string) => defs.get(agent)?.requiredFields[intent] ?? [];
let cfg: ShadowConfig;

beforeEach(() => {
  resetShadowConfig();
  cfg = loadShadowConfig({} as NodeJS.ProcessEnv);
});
afterEach(() => resetShadowConfig());

describe('interpretTurn (deterministic)', () => {
  it('classifies a clear single-intent request and extracts fields', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, "Hi, my name is Jane Doe and I need a refill on my eye drops, I'm at 555-201-0101", req('no-ivr'), cfg);
    expect(r.intent).toBe('prescription_refill');
    expect(r.extractedFields.callerName).toBe('Jane Doe');
    expect(r.extractedFields.callerPhone).toContain('555');
    expect(r.urgency).toBe('none');
  });

  it('asks one question at a time for the first missing field', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'I need someone to call me back about billing', req('no-ivr'), cfg);
    expect(r.recommendedAction).toBe('ask_question');
    expect((r.userFacingQuestion!.match(/\?/g) ?? []).length).toBe(1);
  });

  it('flags ambiguity on an early unclassifiable turn', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'um, hello? it is about the thing from before', req('no-ivr'), cfg);
    expect(r.ambiguous).toBe(true);
    expect(r.recommendedAction).toBe('ask_question');
  });

  it('detects multiple intents in one utterance', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'What are your hours tomorrow, and I also need to cancel my appointment', req('no-ivr'), cfg);
    expect(r.multiIntent).toBe(true);
    expect(r.secondaryIntents.length).toBeGreaterThan(0);
  });

  it('detects urgent and emergency language', async () => {
    const st = initialState('s', 'after-hours');
    st.turnCount = 1;
    const urgent = await interpretTurn(st, 'I have sudden flashes of light and a curtain in my vision', req('after-hours'), cfg);
    expect(urgent.urgency).toBe('urgent');
    expect(urgent.recommendedAction).toBe('escalate');
    const emergency = await interpretTurn(st, 'my father has chest pain and cannot breathe', req('after-hours'), cfg);
    expect(emergency.urgency).toBe('emergency');
  });

  it('handles caller cancellation and restart', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 2;
    const cancel = await interpretTurn(st, 'never mind, forget it', req('no-ivr'), cfg);
    expect(cancel.recommendedAction).toBe('complete');
    const restart = await interpretTurn(st, 'can we start over please', req('no-ivr'), cfg);
    expect(restart.recommendedAction).toBe('respond');
    expect(restart.rationaleCode).toBe('caller_restart');
  });

  it('recommends confirm (not tool) when fields are complete but unconfirmed', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 3;
    st.intent = 'ticket_request';
    for (const f of ['callerName', 'callerPhone', 'reason']) {
      st.collectedFields[f] = { value: 'x', providedAtTurn: 1, provenance: 'caller', confirmed: false };
    }
    const r = await interpretTurn(st, 'so yes I would like to leave that message about my bill', req('no-ivr'), cfg);
    expect(r.recommendedAction).toBe('confirm');
  });

  it('caller-facing text never contains internals (sanitizer)', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'what are your hours today?', req('no-ivr'), cfg);
    for (const text of [r.proposedResponse, r.userFacingQuestion]) {
      if (!text) continue;
      expect(text).not.toMatch(/Error:|api[_-]?key|https?:\/\//i);
    }
  });

  it('transfer requests route to transfer', async () => {
    const st = initialState('s', 'answering-service');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'I want to speak to a real person please', req('answering-service'), cfg);
    expect(r.recommendedAction).toBe('transfer');
  });

  it('model tier defaults to deterministic when routing is disabled', async () => {
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'ummm about the thing?', req('no-ivr'), cfg);
    expect(r.selectedModelTier).toBe('deterministic');
  });

  it('llm refinement failure falls back to the deterministic result (model timeout)', async () => {
    const enabled = loadShadowConfig({ SHADOW_MODEL_ROUTING_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv);
    const st = initialState('s', 'no-ivr');
    st.turnCount = 1;
    const r = await interpretTurn(st, 'hmm, something about that other issue maybe?', req('no-ivr'), enabled, {
      llmRefine: async () => { throw new Error('timeout'); },
    });
    expect(r.intent).toBeDefined();
    expect(r.modelSelectionReason).toContain('llm_failed_fallback_deterministic');
  });
});

describe('selectTier', () => {
  const base: RoutingSignals = {
    ambiguityScore: 0, unresolvedFieldCount: 0, candidateIntentCount: 1, constraintCount: 0,
    retryCount: 0, conflictCount: 0, policyComplexity: 0, toolResultComplexity: 0, escalationRequested: false,
  };
  const on = loadShadowConfig({ SHADOW_MODEL_ROUTING_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv);

  it('deterministic when the engine fully determines the action', () => {
    expect(selectTier(base, true, on).tier).toBe('deterministic');
  });
  it('low for routine signals', () => {
    expect(selectTier(base, false, on).tier).toBe('low');
  });
  it('mid for elevated ambiguity', () => {
    expect(selectTier({ ...base, ambiguityScore: 0.5, candidateIntentCount: 2 }, false, on).tier).toBe('mid');
  });
  it('high for escalation or heavy signals — never by message length', () => {
    expect(selectTier({ ...base, escalationRequested: true }, false, on).tier).toBe('high');
    expect(selectTier({ ...base, ambiguityScore: 1, conflictCount: 2, retryCount: 3 }, false, on).tier).toBe('high');
  });
  it('uses only repo-verified model names', () => {
    expect(selectTier(base, false, on).model).toBe('gpt-4o-mini');
    expect(selectTier({ ...base, ambiguityScore: 0.6 }, false, on).model).toBe('gpt-4o');
    expect(selectTier({ ...base, escalationRequested: true }, false, on).model).toBe('gpt-4o');
  });
});

describe('ModelBudget', () => {
  it('caps model calls per session and per day (fallback tier thereafter)', () => {
    const c = loadShadowConfig({ SHADOW_MODEL_MAX_CALLS_PER_SESSION: '2', SHADOW_MODEL_DAILY_COST_CAP_USD: '0.001' } as unknown as NodeJS.ProcessEnv);
    const b = new ModelBudget(c);
    expect(b.allow('s1').allowed).toBe(true);
    b.record('s1', { tier: 'low', model: 'gpt-4o-mini', reason: 't', latencyMs: 5, structuredOutputValid: true, fallbackUsed: false, estCostUsd: 0.0005 });
    b.record('s1', { tier: 'low', model: 'gpt-4o-mini', reason: 't', latencyMs: 5, structuredOutputValid: true, fallbackUsed: false, estCostUsd: 0.0006 });
    expect(b.allow('s1').allowed).toBe(false); // session cap
    expect(b.allow('s2').allowed).toBe(false); // daily cost cap
  });
});
