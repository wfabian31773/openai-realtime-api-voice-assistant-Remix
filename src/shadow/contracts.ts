/**
 * Shadow architecture — typed contracts (Checkpoint 6).
 * Narrative spec: docs/voice-shadow-architecture/04-event-and-state-contracts.md
 *
 * Everything here is observation/simulation data. There is deliberately no type
 * in this file that can represent a real execution: `executionMode` is the
 * literal 'simulation-only' and `mutationBlocked` the literal `true`.
 */
import { z } from 'zod';
import { createHash } from 'crypto';

export const CONTRACT_VERSION = 1;

export const shadowEventTypeSchema = z.enum([
  'session_started',
  'user_transcript',
  'assistant_transcript',
  'tool_requested',
  'tool_completed',
  'tool_failed',
  'n8n_workflow_requested',
  'n8n_workflow_completed',
  'n8n_workflow_failed',
  'transfer_started',
  'transfer_completed',
  'session_completed',
  'session_failed',
  'other',
]);
export type ShadowEventType = z.infer<typeof shadowEventTypeSchema>;

export const shadowEventSchema = z.object({
  contractVersion: z.number().default(CONTRACT_VERSION),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  turnId: z.number().int().nonnegative().optional(),
  seq: z.number().int().nonnegative().optional(),
  ts: z.string().min(1),
  type: shadowEventTypeSchema,
  payload: z.record(z.unknown()).default({}),
  source: z.object({
    component: z.enum(['transcript', 'toolTimeline', 'ticketingApiClient', 'lifecycle', 'replay', 'other']),
    pid: z.number().optional(),
  }),
  sensitive: z.boolean().default(false),
});
export type ShadowEvent = z.infer<typeof shadowEventSchema>;

export const shadowStatusSchema = z.enum([
  'active',
  'waiting_for_user',
  'waiting_for_production_tool_result',
  'waiting_for_production_n8n_result',
  'completed',
  'escalated',
  'failed',
]);
export type ShadowStatus = z.infer<typeof shadowStatusSchema>;

export const recommendedActionSchema = z.enum([
  'ask_question',
  'confirm',
  'simulate_tool_call',
  'simulate_n8n_decision',
  'respond',
  'transfer',
  'escalate',
  'complete',
]);
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

export const fieldValueSchema = z.object({
  value: z.string(),
  providedAtTurn: z.number().int().nonnegative(),
  provenance: z.enum(['caller', 'caller_id', 'production_tool', 'inferred']),
  confirmed: z.boolean().default(false),
});
export type FieldValue = z.infer<typeof fieldValueSchema>;

export const toolRecordSchema = z.object({
  tool: z.string(),
  argsDigest: z.string(),
  argsRedacted: z.record(z.unknown()),
  outcome: z.enum(['completed', 'failed']),
  resultDigest: z.string().optional(),
  errored: z.boolean().default(false),
  atTurn: z.number().int().nonnegative(),
  ms: z.number().optional(),
});
export type ToolRecord = z.infer<typeof toolRecordSchema>;

export const n8nRecordSchema = z.object({
  endpoint: z.string(),
  viaGateway: z.boolean(),
  status: z.number().optional(),
  requestDigest: z.string(),
  responseDigest: z.string().optional(),
  outcome: z.enum(['completed', 'failed']),
  atTurn: z.number().int().nonnegative(),
});
export type N8nRecord = z.infer<typeof n8nRecordSchema>;

/** A proposed tool call. Cannot represent execution: mode is a literal. */
export const simulatedToolRecordSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  allowed: z.boolean(),
  validationCode: z.string(),
  missingFields: z.array(z.string()),
  confirmationRequired: z.boolean(),
  executionMode: z.literal('simulation-only'),
  mutating: z.boolean(),
  atTurn: z.number().int().nonnegative(),
  productionReplay: z
    .object({ matched: z.boolean(), productionResultDigest: z.string().optional() })
    .optional(),
});
export type SimulatedToolRecord = z.infer<typeof simulatedToolRecordSchema>;

export const simulatedN8nRecordSchema = z.object({
  workflow: z.string(),
  payloadDigest: z.string(),
  readOnly: z.boolean(),
  mutationBlocked: z.literal(true),
  executionMode: z.literal('simulation-only'),
  replayAvailable: z.boolean(),
  budgetImpact: z.number().int().nonnegative(),
  atTurn: z.number().int().nonnegative(),
});
export type SimulatedN8nRecord = z.infer<typeof simulatedN8nRecordSchema>;

export const loopSignalSchema = z.object({
  loopType: z.enum([
    'repeated_question',
    'repeated_tool_call',
    'repeated_n8n_trigger',
    'unchanged_state',
    'state_regression',
    'alternating_states',
    'duplicate_completed_action',
    'repeated_tool_failure',
    'repeated_confirmation_request',
    'ignored_answer',
    'lost_correction',
    'derailed_side_question',
    'bundled_questions',
    'premature_action_claim',
    'identity_ungrounded',
  ]),
  source: z.enum(['production', 'shadow']),
  firstAtTurn: z.number().int().nonnegative(),
  repeatAtTurn: z.number().int().nonnegative(),
  affectedState: z.string(),
  likelyCause: z.string(),
  recommendedCorrection: z.string(),
});
export type LoopSignal = z.infer<typeof loopSignalSchema>;

export const shadowConversationStateSchema = z.object({
  contractVersion: z.number().default(CONTRACT_VERSION),
  sessionId: z.string(),
  agentId: z.string(),
  intent: z.string().nullable(),
  intentConfidence: z.number().min(0).max(1),
  currentStep: z.string(),
  status: shadowStatusSchema,
  collectedFields: z.record(fieldValueSchema),
  missingFields: z.array(z.string()),
  confirmedFields: z.array(z.string()),
  pendingQuestion: z
    .object({ topic: z.string(), text: z.string(), askedAtTurn: z.number() })
    .nullable(),
  lastUserMessage: z.string().nullable(),
  lastProductionAssistantMessage: z.string().nullable(),
  lastShadowRecommendedAction: recommendedActionSchema.nullable(),
  productionToolHistory: z.array(toolRecordSchema),
  productionN8nHistory: z.array(n8nRecordSchema),
  simulatedToolHistory: z.array(simulatedToolRecordSchema),
  simulatedN8nHistory: z.array(simulatedN8nRecordSchema),
  completedActions: z.array(z.string()),
  retryCounts: z.record(z.number()),
  loopSignals: z.array(loopSignalSchema),
  escalationReason: z.string().nullable(),
  productionOutcome: z.string().nullable(),
  shadowPredictedOutcome: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()),
});
export type ShadowConversationState = z.infer<typeof shadowConversationStateSchema>;

export const modelTierSchema = z.enum(['deterministic', 'low', 'mid', 'high']);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const shadowReasoningResultSchema = z.object({
  contractVersion: z.number().default(CONTRACT_VERSION),
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  extractedFields: z.record(z.string()),
  missingFields: z.array(z.string()),
  ambiguous: z.boolean(),
  ambiguityReason: z.string().optional(),
  urgency: z.enum(['none', 'elevated', 'urgent', 'emergency']),
  multiIntent: z.boolean().default(false),
  secondaryIntents: z.array(z.string()).default([]),
  recommendedAction: recommendedActionSchema,
  recommendedTool: z.string().optional(),
  simulatedToolArgs: z.record(z.unknown()).optional(),
  recommendedN8nWorkflow: z.string().optional(),
  simulatedN8nPayload: z.record(z.unknown()).optional(),
  userFacingQuestion: z.string().optional(),
  proposedResponse: z.string().optional(),
  rationaleCode: z.string(),
  selectedModelTier: modelTierSchema,
  modelSelectionReason: z.string(),
});
export type ShadowReasoningResult = z.infer<typeof shadowReasoningResultSchema>;

/** Session bundle sent to the OPTIONAL shadow n8n workflow (doc 15 §3). */
export const shadowSessionBundleSchema = z.object({
  shadowMode: z.literal(true),
  executionMode: z.literal('simulation-only'),
  idempotencyKey: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  bundle: z.record(z.unknown()),
});
export type ShadowSessionBundle = z.infer<typeof shadowSessionBundleSchema>;

export function digest(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export function makeEventId(sessionId: string, type: string, seq: number | undefined, payload: unknown): string {
  return digest(`${sessionId}|${type}|${seq ?? 'x'}|${digest(payload)}`);
}

export function initialState(sessionId: string, agentId: string): ShadowConversationState {
  return {
    contractVersion: CONTRACT_VERSION,
    sessionId,
    agentId,
    intent: null,
    intentConfidence: 0,
    currentStep: 'start',
    status: 'active',
    collectedFields: {},
    missingFields: [],
    confirmedFields: [],
    pendingQuestion: null,
    lastUserMessage: null,
    lastProductionAssistantMessage: null,
    lastShadowRecommendedAction: null,
    productionToolHistory: [],
    productionN8nHistory: [],
    simulatedToolHistory: [],
    simulatedN8nHistory: [],
    completedActions: [],
    retryCounts: {},
    loopSignals: [],
    escalationReason: null,
    productionOutcome: null,
    shadowPredictedOutcome: null,
    turnCount: 0,
    metadata: {},
  };
}
