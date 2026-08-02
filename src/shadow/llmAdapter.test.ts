/** LLM refinement adapter: bounded, budgeted, raise-only urgency, fail-safe. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadShadowConfig, resetShadowConfig } from './config';
import { initialState, type ShadowReasoningResult } from './contracts';
import { createLlmRefine, type ChatClient } from './llmAdapter';
import { ModelBudget } from './modelRouter';

function envReset(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SHADOW_')) delete process.env[k];
  }
  resetShadowConfig();
}

function heuristic(p: Partial<ShadowReasoningResult> = {}): ShadowReasoningResult {
  return {
    contractVersion: 1, intent: 'ticket_request', confidence: 0.6, extractedFields: {},
    missingFields: ['callerPhone'], ambiguous: false, urgency: 'elevated', multiIntent: false,
    secondaryIntents: [], recommendedAction: 'ask_question', rationaleCode: 'missing_required_field',
    selectedModelTier: 'mid', modelSelectionReason: 't', ...p,
  };
}

const okClient: ChatClient = async () => ({
  content: JSON.stringify({
    intent: 'prescription_refill',
    confidence: 0.9,
    urgency: 'urgent',
    proposedResponse: 'I can help with that refill right away.',
  }),
  tokensIn: 400,
  tokensOut: 60,
});

describe('createLlmRefine', () => {
  beforeEach(() => {
    envReset();
    process.env.SHADOW_MODEL_ROUTING_ENABLED = 'true';
    resetShadowConfig();
  });
  afterEach(envReset);

  it('applies a valid refinement and records the call against the budget', async () => {
    const budget = new ModelBudget(loadShadowConfig(process.env));
    const refine = createLlmRefine(budget, okClient);
    const st = initialState('s1', 'no-ivr');
    st.lastUserMessage = 'I need my drops refilled, call me at 555-201-0101';
    const out = await refine('mid', st, heuristic());
    expect(out?.intent).toBe('prescription_refill');
    expect(out?.urgency).toBe('urgent'); // raise allowed
    expect(budget.logs.length).toBe(1);
    expect(budget.logs[0].model).toBe('gpt-5.6-terra');
    expect(budget.logs[0].structuredOutputValid).toBe(true);
    expect(budget.logs[0].estCostUsd).toBeGreaterThan(0);
  });

  it('never lowers urgency below the heuristic value', async () => {
    const client: ChatClient = async () => ({ content: JSON.stringify({ urgency: 'none' }) });
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), client);
    const out = await refine('mid', initialState('s2', 'no-ivr'), heuristic({ urgency: 'urgent' }));
    expect(out?.urgency).toBeUndefined();
  });

  it('cannot refine tool choice — schema strips unknown keys', async () => {
    const client: ChatClient = async () => ({
      content: JSON.stringify({ recommendedTool: 'sage_book', simulatedToolArgs: { x: 1 }, intent: 'other' }),
    });
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), client);
    const out = await refine('low', initialState('s3', 'no-ivr'), heuristic());
    expect(out?.intent).toBe('other');
    expect((out as Record<string, unknown>).recommendedTool).toBeUndefined();
    expect((out as Record<string, unknown>).simulatedToolArgs).toBeUndefined();
  });

  it('invalid JSON → null (deterministic fallback), still budget-recorded', async () => {
    const client: ChatClient = async () => ({ content: 'not json at all' });
    const budget = new ModelBudget(loadShadowConfig(process.env));
    const refine = createLlmRefine(budget, client);
    const out = await refine('low', initialState('s4', 'no-ivr'), heuristic());
    expect(out).toBeNull();
    expect(budget.logs[0].fallbackUsed).toBe(true);
  });

  it('API error → null, assumed cost charged so the cap binds', async () => {
    const client: ChatClient = async () => { throw new Error('timeout'); };
    const budget = new ModelBudget(loadShadowConfig(process.env));
    const refine = createLlmRefine(budget, client);
    const out = await refine('high', initialState('s5', 'no-ivr'), heuristic());
    expect(out).toBeNull();
    expect(budget.logs[0].error).toBe('timeout');
    expect(budget.logs[0].estCostUsd).toBeGreaterThan(0);
  });

  it('budget exhaustion blocks the call before any network use', async () => {
    process.env.SHADOW_MODEL_MAX_CALLS_PER_SESSION = '0';
    resetShadowConfig();
    let networkCalls = 0;
    const client: ChatClient = async () => { networkCalls++; return { content: '{}' }; };
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), client);
    const out = await refine('low', initialState('s6', 'no-ivr'), heuristic());
    expect(out).toBeNull();
    expect(networkCalls).toBe(0);
  });

  it('no client (no API key) → null, never throws', async () => {
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), null);
    await expect(refine('low', initialState('s7', 'no-ivr'), heuristic())).resolves.toBeNull();
  });

  it('masks identifiers in the outbound payload', async () => {
    let sent = '';
    const client: ChatClient = async (_m, _s, user) => { sent = user; return { content: '{}' }; };
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), client);
    const st = initialState('s8', 'no-ivr');
    st.lastUserMessage = 'my number is 555-303-0303 and my DOB is 01/02/1980, email a@b.com';
    await refine('low', st, heuristic());
    expect(sent).not.toContain('555-303-0303');
    expect(sent).not.toContain('01/02/1980');
    expect(sent).not.toContain('a@b.com');
  });

  it('sanitizes model-proposed caller-facing text', async () => {
    const client: ChatClient = async () => ({
      content: JSON.stringify({ proposedResponse: 'Error: ENOTFOUND at api_key Bearer abc123456789xyz' }),
    });
    const refine = createLlmRefine(new ModelBudget(loadShadowConfig(process.env)), client);
    const out = await refine('low', initialState('s9', 'no-ivr'), heuristic());
    expect(out?.proposedResponse).toBeUndefined();
  });
});
