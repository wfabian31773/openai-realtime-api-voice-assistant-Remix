# 04 — Event and State Contracts (Checkpoint 6)

Authoritative implementation: `src/shadow/contracts.ts` (zod schemas — the repo's
established validation library, cf. `src/config/environment.ts`). This document is
the narrative contract; the code is the source of truth and is contract-tested.

## 1. ShadowEvent (normalized event model)

```ts
ShadowEvent {
  eventId: string        // sha1(sessionId|type|seq|payloadDigest) — dedupe key
  sessionId: string      // OpenAI callId; aliases carried in payload.correlation
  agentId: string        // agent slug from the registry (doc 01)
  turnId?: number        // user-turn ordinal at emit time
  seq?: number           // per-process monotonic sequence
  ts: string             // ISO-8601
  type: ShadowEventType
  payload: Record<string, unknown>   // type-specific, validated per type
  source: { component: 'transcript'|'toolTimeline'|'ticketingApiClient'
            |'lifecycle'|'replay'|'other', pid?: number }
  sensitive: boolean     // true ⇒ redaction stage must run before spool/report
}
ShadowEventType =
  'session_started' | 'user_transcript' | 'assistant_transcript' |
  'tool_requested' | 'tool_completed' | 'tool_failed' |
  'n8n_workflow_requested' | 'n8n_workflow_completed' | 'n8n_workflow_failed' |
  'transfer_started' | 'transfer_completed' |
  'session_completed' | 'session_failed' | 'other'
```

## 2. ShadowConversationState

```ts
ShadowConversationState {
  sessionId, agentId
  intent: string | null            intentConfidence: number  // 0..1
  currentStep: string              status: ShadowStatus
  collectedFields: Record<string, FieldValue>   // value + provenance + turn
  missingFields: string[]          confirmedFields: string[]
  pendingQuestion: { topic: string, text: string, askedAtTurn: number } | null
  lastUserMessage: string | null
  lastProductionAssistantMessage: string | null
  lastShadowRecommendedAction: RecommendedAction | null
  productionToolHistory: ToolRecord[]      productionN8nHistory: N8nRecord[]
  simulatedToolHistory: SimulatedToolRecord[]
  simulatedN8nHistory: SimulatedN8nRecord[]
  completedActions: string[]       retryCounts: Record<string, number>
  loopSignals: LoopSignal[]        escalationReason: string | null
  productionOutcome: string | null shadowPredictedOutcome: string | null
  metadata: Record<string, unknown>  // turn count, timings, model-tier history
}
ShadowStatus = 'active' | 'waiting_for_user' | 'waiting_for_production_tool_result'
  | 'waiting_for_production_n8n_result' | 'completed' | 'escalated' | 'failed'
```

## 3. ShadowReasoningResult (advisory — engine decides legality)

```ts
ShadowReasoningResult {
  intent: string                  confidence: number
  extractedFields: Record<string, string>
  missingFields: string[]
  ambiguous: boolean              ambiguityReason?: string
  urgency: 'none'|'elevated'|'urgent'|'emergency'
  recommendedAction: RecommendedAction
  recommendedTool?: string        simulatedToolArgs?: Record<string, unknown>
  recommendedN8nWorkflow?: string simulatedN8nPayload?: Record<string, unknown>
  userFacingQuestion?: string     proposedResponse?: string
  rationaleCode: string           // machine-readable, e.g. 'missing_required_field'
  selectedModelTier: 'deterministic'|'low'|'mid'|'high'
  modelSelectionReason: string
}
RecommendedAction = 'ask_question' | 'confirm' | 'simulate_tool_call'
  | 'simulate_n8n_decision' | 'respond' | 'transfer' | 'escalate' | 'complete'
```

## 4. Simulation records

```ts
SimulatedToolRecord {
  tool, args, allowed: boolean, validationCode, missingFields: string[],
  confirmationRequired: boolean, executionMode: 'simulation-only',   // literal type
  productionReplay?: { matched: boolean, productionResultDigest?: string }
}
SimulatedN8nRecord {
  workflow, payload, mutationBlocked: true,   // literal type
  executionMode: 'simulation-only', readOnly: boolean,
  replayAvailable: boolean, budgetImpact: number   // 0 unless bundle enabled
}
```

`executionMode` and `mutationBlocked` are **literal types** — the compiler rejects
any record representing a real execution. There is deliberately no "execute" field,
callback, or client handle anywhere in these types.

## 5. Session-bundle contract (optional n8n bundle, doc 15 §3)

```ts
ShadowSessionBundle {
  shadowMode: true, executionMode: 'simulation-only',
  idempotencyKey: `shadow-${sessionId}`, sessionId, agentId,
  bundle: SessionComparisonSummary   // doc 07 §3, redacted
}
```

## 6. Comparison records — see doc 07 (TurnComparison, SessionComparisonSummary).

## 7. Conventions

- All schemas versioned (`contractVersion: 1`) for spool forward-compatibility.
- Validation failures never throw into callers: `safeParse` + quarantine + counter.
- Shared with production types only where read-only (`AgentConfig` slug union);
  no production type is modified.
