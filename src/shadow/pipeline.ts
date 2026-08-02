/**
 * Shadow processing pipeline: normalize → session store (idempotent) →
 * per-turn analysis → comparison → evaluation → spool. (CP 7, 12, 13, 17)
 *
 * Everything here runs off the live call path (tap drain). Any error is
 * caught, counted, and isolated per session.
 */
import { getShadowConfig } from './config';
import {
  digest,
  initialState,
  type ShadowConversationState,
  type ShadowEvent,
  type ShadowReasoningResult,
} from './contracts';
import { compareTurn, summarizeSession, type ProductionTurnFacts, type SessionComparisonSummary, type TurnComparison } from './comparison';
import { evaluateSession, ReviewQueue, type SessionEvaluation } from './evaluation';
import { LoopDetector } from './loopDetector';
import { interpretTurn, type ReasoningDeps } from './reasoning';
import { redactPayload } from './redaction';
import { metrics, shadowLog } from './observability';
import { ShadowBundleSender } from './n8nSimulator';
import { simulateN8nDecision } from './n8nSimulator';
import { getToolPolicy, simulateToolCall } from './toolSimulator';
import { buildWorkflowDefinitions } from './workflows';
import { ShadowWorkflowEngine } from './workflowEngine';
import { SpoolWriter } from './spool';

export interface SessionRecord {
  state: ShadowConversationState;
  events: ShadowEvent[];
  seenEventIds: Set<string>;
  turnComparisons: TurnComparison[];
  loopDetector: LoopDetector;
  pendingUserText: string | null;
  lastActivity: number;
  finalized: boolean;
  reasoningLatencies: number[];
  summary?: SessionComparisonSummary;
  evaluation?: SessionEvaluation;
}

export class ShadowPipeline {
  readonly sessions = new Map<string, SessionRecord>();
  /** alias (twilioCallSid, callLogId) -> primary sessionId (OpenAI callId). */
  readonly aliases = new Map<string, string>();
  readonly reviewQueue = new ReviewQueue();
  private engine = new ShadowWorkflowEngine(buildWorkflowDefinitions());
  private spool: SpoolWriter;

  constructor(
    private deps: ReasoningDeps = {},
    public bundleSender: ShadowBundleSender = new ShadowBundleSender(),
    spool?: SpoolWriter,
  ) {
    this.spool = spool ?? new SpoolWriter();
  }

  /** Tap consumer entry point. Never throws. */
  async ingest(events: ShadowEvent[]): Promise<void> {
    // Sort within the batch: out-of-order tolerant (CP 18: out-of-order events
    // must not create multiple sessions — keyed purely on sessionId).
    const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const event of sorted) {
      try {
        await this.ingestOne(event);
      } catch (err) {
        metrics.inc('pipeline_errors');
        shadowLog('error', 'pipeline_event_failed', {
          sessionId: event.sessionId,
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private getSession(event: ShadowEvent): SessionRecord {
    // Alias resolution: events tapped outside the voice process arrive keyed by
    // twilioCallSid; session_started registers the mapping to the primary id.
    const primary = this.aliases.get(event.sessionId);
    if (primary && primary !== event.sessionId) {
      event = { ...event, sessionId: primary };
    }
    let s = this.sessions.get(event.sessionId);
    if (!s) {
      s = {
        state: initialState(event.sessionId, event.agentId),
        events: [],
        seenEventIds: new Set(),
        turnComparisons: [],
        loopDetector: new LoopDetector(),
        pendingUserText: null,
        lastActivity: Date.now(),
        finalized: false,
        reasoningLatencies: [],
      };
      this.sessions.set(event.sessionId, s);
      metrics.inc('sessions_started');
    }
    return s;
  }

  private async ingestOne(event: ShadowEvent): Promise<void> {
    const s = this.getSession(event);
    // Idempotency: duplicate events are safe (CP17).
    if (s.seenEventIds.has(event.eventId)) {
      metrics.inc('duplicate_events_ignored');
      return;
    }
    s.seenEventIds.add(event.eventId);
    s.events.push(event);
    s.lastActivity = Date.now();
    metrics.inc('events_ingested');
    metrics.gauge('event_lag_ms', Date.now() - Date.parse(event.ts));

    if (s.finalized && event.type !== 'session_completed' && event.type !== 'session_failed') {
      // Late event after finalization: record, don't reprocess.
      metrics.inc('late_events_after_finalize');
      return;
    }

    const st = s.state;
    switch (event.type) {
      case 'session_started': {
        st.metadata.startedAt = event.ts;
        const corr = (event.payload.correlation as Record<string, unknown>) ?? {};
        for (const key of ['twilioCallSid', 'callLogId']) {
          const alias = corr[key];
          if (typeof alias === 'string' && alias && alias !== st.sessionId) {
            this.aliases.set(alias, st.sessionId);
          }
        }
        st.metadata.correlation = { twilioCallSid: corr.twilioCallSid, callLogId: corr.callLogId };
        break;
      }
      case 'user_transcript': {
        const text = String(event.payload.text ?? '');
        st.turnCount = Math.max(st.turnCount + 1, event.turnId ?? 0);
        st.lastUserMessage = text;
        st.status = 'active';
        await this.analyzeTurn(s, text);
        break;
      }
      case 'assistant_transcript': {
        const text = String(event.payload.text ?? '');
        st.lastProductionAssistantMessage = text;
        s.loopDetector.observeProductionTurn(st, { turn: st.turnCount, agentText: text });
        if (st.status === 'active') st.status = 'waiting_for_user';
        break;
      }
      case 'tool_requested':
      case 'tool_completed':
      case 'tool_failed': {
        const tool = String(event.payload.tool ?? 'unknown');
        const argsRedacted = (event.payload.args as Record<string, unknown>) ?? {};
        const failed = event.type === 'tool_failed' || Boolean((event.payload.outcome as Record<string, unknown> | undefined)?.error);
        st.productionToolHistory.push({
          tool,
          argsDigest: digest(argsRedacted),
          argsRedacted,
          outcome: failed ? 'failed' : 'completed',
          resultDigest: event.payload.resultDigest ? String(event.payload.resultDigest) : digest(event.payload.outcome ?? {}),
          errored: failed,
          atTurn: st.turnCount,
          ms: typeof event.payload.ms === 'number' ? event.payload.ms : undefined,
        });
        if (failed) st.retryCounts[tool] = (st.retryCounts[tool] ?? 0) + 1;
        const policy = getToolPolicy(tool);
        if (policy?.mutating && !failed) {
          if (st.completedActions.includes(tool)) {
            s.loopDetector.observeDuplicateCompletedAction(st.turnCount, tool, 'production');
          }
          st.completedActions.push(tool);
        }
        s.loopDetector.observeProductionTurn(st, {
          turn: st.turnCount,
          toolCalls: [{ tool, argsDigest: digest(argsRedacted), failed }],
        });
        // transfer synthesis
        if (['transfer_to_office', 'escalate_to_human', 'transfer_to_human'].includes(tool) && !failed) {
          st.escalationReason = st.escalationReason ?? `production tool ${tool}`;
        }
        break;
      }
      case 'n8n_workflow_requested':
      case 'n8n_workflow_completed':
      case 'n8n_workflow_failed': {
        const endpoint = String(event.payload.endpoint ?? 'unknown');
        if (event.type !== 'n8n_workflow_requested') {
          st.productionN8nHistory.push({
            endpoint,
            viaGateway: Boolean(event.payload.viaGateway ?? true),
            status: typeof event.payload.status === 'number' ? event.payload.status : undefined,
            requestDigest: String(event.payload.requestDigest ?? digest(event.payload.body ?? {})),
            responseDigest: event.payload.responseDigest ? String(event.payload.responseDigest) : undefined,
            outcome: event.type === 'n8n_workflow_failed' ? 'failed' : 'completed',
            atTurn: st.turnCount,
          });
        }
        s.loopDetector.observeN8nTrigger(st.turnCount, endpoint, 'production');
        break;
      }
      case 'transfer_started':
      case 'transfer_completed': {
        st.escalationReason = st.escalationReason ?? String(event.payload.reason ?? 'transfer');
        break;
      }
      case 'session_completed':
      case 'session_failed': {
        await this.finalize(s, event);
        break;
      }
      default:
        break;
    }
  }

  private async analyzeTurn(s: SessionRecord, userText: string): Promise<void> {
    const cfg = getShadowConfig();
    const st = s.state;
    const def = this.engine.getDefinition(st.agentId);
    const started = Date.now();

    const reasoning = await interpretTurn(
      st,
      userText,
      (intent) => def?.requiredFields[intent] ?? [],
      cfg,
      this.deps,
    );
    s.reasoningLatencies.push(Date.now() - started);

    // Fold extracted fields into state BEFORE legality so no-repeat rules see them.
    for (const [field, value] of Object.entries(reasoning.extractedFields)) {
      if (!st.collectedFields[field]) {
        st.collectedFields[field] = {
          value,
          providedAtTurn: st.turnCount,
          provenance: 'caller',
          confirmed: false,
        };
      }
    }
    st.intent = reasoning.intent;
    st.intentConfidence = reasoning.confidence;
    st.missingFields = reasoning.missingFields.filter((f) => !st.collectedFields[f]);

    const decision = this.engine.evaluate(st, reasoning);

    // Simulated tool + n8n records
    if (decision.finalAction === 'simulate_tool_call' && decision.finalTool) {
      const args = reasoning.simulatedToolArgs ?? buildArgsFromState(st, decision.finalTool);
      reasoning.simulatedToolArgs = args;
      const sim = simulateToolCall(st, reasoning, decision.finalTool, args);
      st.simulatedToolHistory.push(sim);
      const n8nSim = simulateN8nDecision(st, decision.finalTool, args);
      if (n8nSim) {
        st.simulatedN8nHistory.push(n8nSim);
        s.loopDetector.observeN8nTrigger(st.turnCount, n8nSim.workflow, 'shadow');
      }
      metrics.inc('simulated_tool_decisions');
    }

    if (decision.finalAction === 'escalate') {
      st.escalationReason = st.escalationReason ?? reasoning.rationaleCode;
    }
    if (reasoning.userFacingQuestion && decision.finalAction === 'ask_question') {
      st.pendingQuestion = {
        topic: reasoning.missingFields[0] ?? 'other_question',
        text: reasoning.userFacingQuestion,
        askedAtTurn: st.turnCount,
      };
    }
    st.lastShadowRecommendedAction = decision.finalAction;
    st.currentStep = decision.nextStep;

    s.loopDetector.observeShadowRecommendation(
      st,
      st.turnCount,
      reasoning.userFacingQuestion,
      decision.finalTool,
      reasoning.simulatedToolArgs ? digest(reasoning.simulatedToolArgs) : undefined,
    );
    s.loopDetector.observeStateSnapshot(st, digest({
      step: st.currentStep, intent: st.intent, fields: Object.keys(st.collectedFields).sort(), actions: st.completedActions,
    }));
    st.loopSignals = s.loopDetector.signals;

    if (cfg.comparisonEnabled) {
      const prodFacts = this.productionFactsForTurn(s);
      const cmp = compareTurn(st, prodFacts, reasoning, decision, s.loopDetector.signals);
      s.turnComparisons.push(cmp);
      metrics.inc('turns_compared');
      if (cmp.reviewRequired) metrics.inc('turns_review_required');
    }
    metrics.inc('state_transitions');
    metrics.setLabeled('model_tier_selected', reasoning.selectedModelTier, 1, true);
  }

  private productionFactsForTurn(s: SessionRecord): ProductionTurnFacts {
    const st = s.state;
    const toolThisTurn = st.productionToolHistory.filter((t) => t.atTurn === st.turnCount).slice(-1)[0];
    const n8nThisTurn = st.productionN8nHistory.filter((r) => r.atTurn === st.turnCount).slice(-1)[0];
    const policy = toolThisTurn ? getToolPolicy(toolThisTurn.tool) : undefined;
    const prematureFields = policy?.mutating
      ? policy.requiredFields.filter((f) => !st.collectedFields[f])
      : [];
    return {
      turn: st.turnCount,
      assistantMessage: st.lastProductionAssistantMessage,
      toolRequest: toolThisTurn
        ? { tool: toolThisTurn.tool, argsDigest: toolThisTurn.argsDigest, prematureFields }
        : null,
      n8nEndpoint: n8nThisTurn?.endpoint ?? null,
      inferredIntent: null, // production intent is unobservable (doc 02 §4.1)
      inferredState: null,
      escalated: st.productionToolHistory.some((t) =>
        ['transfer_to_office', 'escalate_to_human', 'transfer_to_human'].includes(t.tool) && !t.errored,
      ),
    };
  }

  private async finalize(s: SessionRecord, event: ShadowEvent): Promise<void> {
    if (s.finalized) {
      metrics.inc('duplicate_finalize_ignored');
      return;
    }
    s.finalized = true;
    const st = s.state;
    st.status = event.type === 'session_failed' ? 'failed' : st.escalationReason ? 'escalated' : 'completed';
    st.productionOutcome = String(event.payload.status ?? st.status);
    st.shadowPredictedOutcome =
      st.escalationReason ? 'escalated'
      : st.simulatedToolHistory.some((t) => t.allowed && t.mutating) ? 'completed_with_action'
      : 'completed_informational';

    const avgLatency = s.reasoningLatencies.length
      ? s.reasoningLatencies.reduce((a, b) => a + b, 0) / s.reasoningLatencies.length
      : 0;
    const summary = summarizeSession(st, s.turnComparisons, { avgReasoningLatencyMs: Math.round(avgLatency) });
    s.summary = summary;
    const evaln = evaluateSession(summary, s.turnComparisons);
    s.evaluation = evaln;
    this.reviewQueue.add(summary, evaln);
    metrics.inc('sessions_completed');
    metrics.setLabeled('session_verdict', evaln.verdict, 1, true);

    // Spool the full session record (redacted) for replay & reporting.
    try {
      const cfg = getShadowConfig();
      if (cfg.spoolEnabled) {
        await this.spool.writeSession(st.sessionId, {
          state: { ...st, lastUserMessage: null, lastProductionAssistantMessage: null },
          events: s.events.map((e) => ({
            ...e,
            payload: e.sensitive ? redactPayload(e.payload, { keepText: cfg.storeTranscripts }) : e.payload,
          })),
          summary,
          evaluation: evaln,
        });
      }
    } catch (err) {
      metrics.inc('spool_errors');
      shadowLog('warn', 'spool_write_failed', { sessionId: st.sessionId, error: String(err) });
    }

    // Optional (default-off) n8n session bundle — budget-gated, batched.
    try {
      this.bundleSender.enqueue(st.sessionId, st.agentId, {
        summary: summary as unknown as Record<string, unknown>,
        verdict: evaln.verdict,
      });
      await this.bundleSender.flush();
    } catch (err) {
      metrics.inc('bundle_errors');
    }
  }

  /** Timeout sweep for sessions with no completion event (CP 3 §6). */
  async sweepStaleSessions(now: Date = new Date()): Promise<number> {
    const cfg = getShadowConfig();
    const cutoff = now.getTime() - cfg.sessionTimeoutMin * 60_000;
    let swept = 0;
    for (const [sessionId, s] of this.sessions) {
      if (!s.finalized && s.lastActivity < cutoff) {
        await this.finalize(s, {
          contractVersion: 1,
          eventId: `timeout-${sessionId}`,
          sessionId,
          agentId: s.state.agentId,
          ts: now.toISOString(),
          type: 'session_failed',
          payload: { status: 'timeout' },
          source: { component: 'other' },
          sensitive: false,
        });
        swept++;
      }
      if (s.finalized && s.lastActivity < cutoff - 3_600_000) {
        this.sessions.delete(sessionId); // memory hygiene; spool retains the record
      }
    }
    return swept;
  }
}

function buildArgsFromState(st: ShadowConversationState, tool: string): Record<string, unknown> {
  const f = (name: string) => st.collectedFields[name]?.value;
  if (tool === 'create_ticket' || tool === 'create_after_hours_ticket') {
    return {
      patientFullName: f('callerName'),
      patientPhone: f('callerPhone'),
      reasonForCalling: f('reason'),
      idempotencyKey: `call-${st.sessionId}`,
      callData: { agentUsed: st.agentId },
    };
  }
  if (tool === 'check_open_tickets') return { phone: f('callerPhone') };
  if (tool === 'lookup_schedule') return {};
  return Object.fromEntries(
    Object.entries(st.collectedFields).map(([k, v]) => [k, v.value]),
  );
}
