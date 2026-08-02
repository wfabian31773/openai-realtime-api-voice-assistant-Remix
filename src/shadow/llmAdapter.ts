/**
 * LLM refinement adapter for the shadow reasoning layer (Checkpoint 8).
 *
 * When SHADOW_MODEL_ROUTING_ENABLED is on, turns whose routing signals exceed
 * the deterministic tier are refined by the tier's model (GPT-5.6 family —
 * Luna/Terra/Sol). Strictly advisory and strictly bounded:
 *  - the deterministic workflow engine still decides legality;
 *  - the model may refine interpretation (intent, fields, ambiguity, urgency,
 *    proposed wording) but NEVER tool choice or arguments — tool decisions
 *    stay deterministic per the routing policy;
 *  - urgency can only be RAISED by the model, never lowered (safety);
 *  - budget-gated (per-session call cap + daily cost cap; unpriced models are
 *    charged an assumed per-call cost so the cap always binds);
 *  - the caller utterance is identifier-masked before leaving the process,
 *    and only minimized structured state is sent — never transcript history
 *    (follows the callGradingService precedent for OpenAI-bound text);
 *  - any failure (timeout, invalid JSON, API error) returns null and the
 *    deterministic result stands. Nothing here can throw into the pipeline.
 */
import { z } from 'zod';
import { getShadowConfig } from './config';
import type { ShadowConversationState, ShadowReasoningResult } from './contracts';
import { estimateCostUsd, ModelBudget } from './modelRouter';
import { metrics, shadowLog } from './observability';
import { maskText, sanitizeProposedResponse } from './redaction';

const URGENCY_RANK = { none: 0, elevated: 1, urgent: 2, emergency: 3 } as const;
type Urgency = keyof typeof URGENCY_RANK;

/** The ONLY fields the model may refine. Tool selection is deliberately absent. */
const refinementSchema = z
  .object({
    intent: z.string().min(1).max(60).optional(),
    confidence: z.number().min(0).max(1).optional(),
    extractedFields: z.record(z.string().max(200)).optional(),
    missingFields: z.array(z.string().max(60)).max(10).optional(),
    ambiguous: z.boolean().optional(),
    ambiguityReason: z.string().max(300).optional(),
    urgency: z.enum(['none', 'elevated', 'urgent', 'emergency']).optional(),
    userFacingQuestion: z.string().max(400).optional(),
    proposedResponse: z.string().max(600).optional(),
  })
  .strip();

const SYSTEM_PROMPT = [
  'You refine a heuristic interpretation of one caller turn for an eyecare voice-agent QA system.',
  'You are OBSERVATION-ONLY: nothing you output is spoken to a caller or executed.',
  'Return ONLY a JSON object with any of these keys you want to refine:',
  'intent, confidence (0-1), extractedFields (string map), missingFields (string array),',
  'ambiguous (bool), ambiguityReason, urgency (none|elevated|urgent|emergency),',
  'userFacingQuestion (ONE question max), proposedResponse.',
  'Rules: never lower urgency below the heuristic value; never invent caller data;',
  'ask one question at a time; no identifiers the caller did not provide themselves;',
  'omit any key you would not change.',
].join(' ');

export interface ChatCompletion {
  content: string;
  tokensIn?: number;
  tokensOut?: number;
}

export type ChatClient = (
  model: string,
  system: string,
  user: string,
  timeoutMs: number,
) => Promise<ChatCompletion>;

/** Real OpenAI-backed client; null when no API key is configured. */
export function createOpenAiChatClient(): ChatClient | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return async (model, system, user, timeoutMs) => {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 500,
      },
      { timeout: timeoutMs },
    );
    return {
      content: resp.choices[0]?.message?.content ?? '',
      tokensIn: resp.usage?.prompt_tokens,
      tokensOut: resp.usage?.completion_tokens,
    };
  };
}

export type LlmRefine = (
  tier: 'low' | 'mid' | 'high',
  state: ShadowConversationState,
  heuristic: ShadowReasoningResult,
) => Promise<Partial<ShadowReasoningResult> | null>;

export function createLlmRefine(budget: ModelBudget, clientOverride?: ChatClient | null): LlmRefine {
  const chat = clientOverride !== undefined ? clientOverride : createOpenAiChatClient();
  return async (tier, state, heuristic) => {
    try {
      if (!chat) return null;
      const cfg = getShadowConfig();
      const gate = budget.allow(state.sessionId);
      if (!gate.allowed) {
        metrics.inc('model_calls_budget_blocked');
        return null;
      }
      const model = tier === 'low' ? cfg.modelLow : tier === 'mid' ? cfg.modelMid : cfg.modelHigh;
      // Minimized structured state + identifier-masked current utterance only.
      const payload = JSON.stringify({
        agentId: state.agentId,
        turn: state.turnCount,
        currentStep: state.currentStep,
        callerSaidMasked: maskText(state.lastUserMessage ?? '').slice(0, 600),
        collectedFieldNames: Object.keys(state.collectedFields),
        heuristic: {
          intent: heuristic.intent,
          confidence: heuristic.confidence,
          missingFields: heuristic.missingFields,
          ambiguous: heuristic.ambiguous,
          urgency: heuristic.urgency,
          recommendedAction: heuristic.recommendedAction,
          rationaleCode: heuristic.rationaleCode,
        },
      });

      const started = Date.now();
      let completion: ChatCompletion;
      let structuredOutputValid = false;
      try {
        completion = await chat(model, SYSTEM_PROMPT, payload, 10_000);
      } catch (err) {
        budget.record(state.sessionId, {
          tier, model, reason: 'api_error', latencyMs: Date.now() - started,
          structuredOutputValid: false, fallbackUsed: true,
          error: err instanceof Error ? err.message : 'error',
          estCostUsd: cfg.modelAssumedCostPerCallUsd,
        });
        metrics.inc('model_calls_failed');
        return null;
      }

      let refined: Partial<ShadowReasoningResult> | null = null;
      try {
        const parsed = refinementSchema.safeParse(JSON.parse(completion.content));
        if (parsed.success) {
          structuredOutputValid = true;
          const r = parsed.data;
          refined = {};
          if (r.intent) refined.intent = r.intent;
          if (r.confidence !== undefined) refined.confidence = r.confidence;
          if (r.extractedFields) {
            refined.extractedFields = { ...heuristic.extractedFields };
            for (const [k, v] of Object.entries(r.extractedFields)) {
              refined.extractedFields[k] = maskTextSafeField(k, v);
            }
          }
          if (r.missingFields) refined.missingFields = r.missingFields;
          if (r.ambiguous !== undefined) refined.ambiguous = r.ambiguous;
          if (r.ambiguityReason) refined.ambiguityReason = r.ambiguityReason;
          if (r.urgency && URGENCY_RANK[r.urgency as Urgency] > URGENCY_RANK[heuristic.urgency]) {
            refined.urgency = r.urgency; // raise-only; downgrades ignored
          }
          if (r.userFacingQuestion) {
            const q = sanitizeProposedResponse(r.userFacingQuestion);
            if (q) refined.userFacingQuestion = q;
          }
          if (r.proposedResponse) {
            const p = sanitizeProposedResponse(r.proposedResponse);
            if (p) refined.proposedResponse = p;
          }
        }
      } catch {
        // invalid JSON → structuredOutputValid stays false, refined stays null
      }

      const cost =
        estimateCostUsd(model, completion.tokensIn ?? 0, completion.tokensOut ?? 0) ??
        cfg.modelAssumedCostPerCallUsd;
      budget.record(state.sessionId, {
        tier, model,
        reason: structuredOutputValid ? 'refined' : 'invalid_output_fallback',
        latencyMs: Date.now() - started,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        structuredOutputValid,
        fallbackUsed: !structuredOutputValid,
        estCostUsd: cost,
      });
      metrics.inc(structuredOutputValid ? 'model_calls_ok' : 'model_calls_invalid_json');
      metrics.setLabeled('model_used', model, 1, true);
      return refined;
    } catch (err) {
      metrics.inc('model_calls_failed');
      shadowLog('warn', 'llm_refine_unexpected_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}

/** Field values from the model get the same identifier masking as ours. */
function maskTextSafeField(_key: string, value: string): string {
  return maskText(value).slice(0, 200);
}
