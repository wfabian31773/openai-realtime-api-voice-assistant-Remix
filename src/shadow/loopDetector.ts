/**
 * Loop and state-loss detection (Checkpoint 12).
 * Applied to BOTH sides: production behavior (observed transcripts/tools) and
 * shadow behavior (its own recommendations). Shadow flags at 2 repeats — one
 * stricter than production's conversationLoopGuard cap of 3 (doc 02 DF-14).
 */
import type { LoopSignal, ShadowConversationState } from './contracts';

/** Question-topic buckets — aligned with the production loop guard's ASK_TOPICS concept. */
const TOPIC_PATTERNS: Array<{ topic: string; re: RegExp }> = [
  { topic: 'callerName', re: /\b(your|first and last|full)\s+name\b/i },
  { topic: 'callerPhone', re: /\b(phone|number to reach|call\s?back number)\b/i },
  { topic: 'dob', re: /\b(date of birth|birth ?date|born)\b/i },
  { topic: 'reason', re: /\b(calling about|reason for|what.*help.*with|how can i help)\b/i },
  { topic: 'identityVerified', re: /\b(last name.*date of birth|verify|pull up your (record|chart))\b/i },
  { topic: 'appointmentType', re: /\b(type of (visit|appointment)|what kind of (visit|appointment))\b/i },
  { topic: 'offerAccepted', re: /\b(work for you|times? (work|available)|prefer)\b/i },
  { topic: 'patientAssent', re: /\b(confirm|is that (right|correct)|read that back)\b/i },
];

export function topicOfQuestion(text: string): string | null {
  for (const t of TOPIC_PATTERNS) if (t.re.test(text)) return t.topic;
  return text.includes('?') ? 'other_question' : null;
}

export function countQuestions(text: string): number {
  const marks = (text.match(/\?/g) ?? []).length;
  const topicHits = TOPIC_PATTERNS.filter((t) => t.re.test(text)).length;
  return Math.max(marks, topicHits);
}

export interface ProductionTurnObservation {
  turn: number;
  agentText?: string;
  toolCalls?: Array<{ tool: string; argsDigest: string; failed?: boolean }>;
  claimedActionWithoutTool?: boolean;
}

export class LoopDetector {
  private prodQuestionTopics = new Map<string, number[]>(); // topic -> turns asked
  private prodToolCalls = new Map<string, number[]>(); // tool|argsDigest -> turns
  private prodToolFailures = new Map<string, number>();
  private shadowQuestions = new Map<string, number[]>();
  private shadowTools = new Map<string, number[]>();
  private n8nTriggers = new Map<string, number[]>();
  private stateDigests: string[] = [];
  private stepHistory: string[] = [];
  readonly signals: LoopSignal[] = [];

  private push(signal: LoopSignal): void {
    // one signal per (type, source, affectedState) pair per repeat turn
    const dup = this.signals.some(
      (s) =>
        s.loopType === signal.loopType &&
        s.source === signal.source &&
        s.affectedState === signal.affectedState &&
        s.repeatAtTurn === signal.repeatAtTurn,
    );
    if (!dup) this.signals.push(signal);
  }

  observeProductionTurn(state: ShadowConversationState, obs: ProductionTurnObservation): void {
    if (obs.agentText) {
      // Bundled questions
      if (countQuestions(obs.agentText) >= 2) {
        this.push({
          loopType: 'bundled_questions', source: 'production',
          firstAtTurn: obs.turn, repeatAtTurn: obs.turn,
          affectedState: state.currentStep,
          likelyCause: 'agent combined multiple asks in one turn',
          recommendedCorrection: 'one primary question per turn',
        });
      }
      const topic = topicOfQuestion(obs.agentText);
      if (topic) {
        const turns = this.prodQuestionTopics.get(topic) ?? [];
        // Ignored answer / repeated question: asked again although the field is
        // stored (including "provided this same turn, then re-asked").
        if (state.collectedFields[topic] && state.collectedFields[topic].providedAtTurn <= obs.turn) {
          this.push({
            loopType: 'ignored_answer', source: 'production',
            firstAtTurn: state.collectedFields[topic].providedAtTurn, repeatAtTurn: obs.turn,
            affectedState: topic,
            likelyCause: 'caller already provided this field',
            recommendedCorrection: 'read stored value back instead of re-asking',
          });
        } else if (turns.length >= 1) {
          const newInfo = Object.values(state.collectedFields).some(
            (f) => f.providedAtTurn > turns[turns.length - 1],
          );
          if (!newInfo) {
            this.push({
              loopType: 'repeated_question', source: 'production',
              firstAtTurn: turns[0], repeatAtTurn: obs.turn,
              affectedState: topic,
              likelyCause: 'same topic re-asked without new information',
              recommendedCorrection: 'acknowledge prior answer or rephrase once, then move on',
            });
          }
        }
        turns.push(obs.turn);
        this.prodQuestionTopics.set(topic, turns);
      }
    }
    for (const call of obs.toolCalls ?? []) {
      const key = `${call.tool}|${call.argsDigest}`;
      const turns = this.prodToolCalls.get(key) ?? [];
      if (turns.length >= 1) {
        this.push({
          loopType: 'repeated_tool_call', source: 'production',
          firstAtTurn: turns[0], repeatAtTurn: obs.turn,
          affectedState: call.tool,
          likelyCause: 'identical tool call repeated with identical arguments',
          recommendedCorrection: 'reuse the earlier result or vary the query',
        });
      }
      turns.push(obs.turn);
      this.prodToolCalls.set(key, turns);
      if (call.failed) {
        const fails = (this.prodToolFailures.get(call.tool) ?? 0) + 1;
        this.prodToolFailures.set(call.tool, fails);
        if (fails >= 2) {
          this.push({
            loopType: 'repeated_tool_failure', source: 'production',
            firstAtTurn: turns[0], repeatAtTurn: obs.turn,
            affectedState: call.tool,
            likelyCause: 'tool failing repeatedly',
            recommendedCorrection: 'switch to fallback/escalation after bounded retries',
          });
        }
      }
    }
    if (obs.claimedActionWithoutTool) {
      this.push({
        loopType: 'premature_action_claim', source: 'production',
        firstAtTurn: obs.turn, repeatAtTurn: obs.turn,
        affectedState: state.currentStep,
        likelyCause: 'agent claimed an action before any tool confirmation',
        recommendedCorrection: 'only claim actions after a confirmed tool result',
      });
    }
  }

  observeShadowRecommendation(
    state: ShadowConversationState,
    turn: number,
    question: string | undefined,
    tool: string | undefined,
    argsDigest: string | undefined,
  ): void {
    if (question) {
      const topic = topicOfQuestion(question) ?? 'other_question';
      const turns = this.shadowQuestions.get(topic) ?? [];
      if (turns.length >= 1 && state.collectedFields[topic]) {
        this.push({
          loopType: 'repeated_question', source: 'shadow',
          firstAtTurn: turns[0], repeatAtTurn: turn,
          affectedState: topic,
          likelyCause: 'shadow re-asked a stored field',
          recommendedCorrection: 'engine no-repeat rule should have caught this',
        });
      }
      turns.push(turn);
      this.shadowQuestions.set(topic, turns);
    }
    if (tool && argsDigest) {
      const key = `${tool}|${argsDigest}`;
      const turns = this.shadowTools.get(key) ?? [];
      if (turns.length >= 1) {
        this.push({
          loopType: 'repeated_tool_call', source: 'shadow',
          firstAtTurn: turns[0], repeatAtTurn: turn,
          affectedState: tool,
          likelyCause: 'shadow repeated an identical tool recommendation',
          recommendedCorrection: 'suppress identical recommendation without new inputs',
        });
      }
      turns.push(turn);
      this.shadowTools.set(key, turns);
    }
  }

  observeN8nTrigger(turn: number, endpoint: string, source: 'production' | 'shadow'): void {
    const turns = this.n8nTriggers.get(`${source}|${endpoint}`) ?? [];
    if (turns.length >= 1) {
      this.push({
        loopType: 'repeated_n8n_trigger', source,
        firstAtTurn: turns[0], repeatAtTurn: turn,
        affectedState: endpoint,
        likelyCause: 'same n8n workflow triggered repeatedly for one session',
        recommendedCorrection: 'idempotency key + once-per-session gate',
      });
    }
    turns.push(turn);
    this.n8nTriggers.set(`${source}|${endpoint}`, turns);
  }

  observeStateSnapshot(state: ShadowConversationState, stateDigest: string): void {
    this.stateDigests.push(stateDigest);
    this.stepHistory.push(state.currentStep);
    const n = this.stateDigests.length;
    if (n >= 3 && this.stateDigests[n - 1] === this.stateDigests[n - 2] && this.stateDigests[n - 2] === this.stateDigests[n - 3]) {
      this.push({
        loopType: 'unchanged_state', source: 'shadow',
        firstAtTurn: Math.max(0, state.turnCount - 2), repeatAtTurn: state.turnCount,
        affectedState: state.currentStep,
        likelyCause: 'no material state change across 3 turns',
        recommendedCorrection: 'escalate or change strategy',
      });
    }
    if (n >= 4) {
      const [a, b, c, d] = this.stepHistory.slice(-4);
      if (a === c && b === d && a !== b) {
        this.push({
          loopType: 'alternating_states', source: 'shadow',
          firstAtTurn: Math.max(0, state.turnCount - 3), repeatAtTurn: state.turnCount,
          affectedState: `${a}<->${b}`,
          likelyCause: 'workflow oscillating between two states',
          recommendedCorrection: 'break the cycle via escalation rule',
        });
      }
    }
    // State regression: step index moves backward without correction/restart context
    if (n >= 2) {
      const order = ['start', 'identify_intent', 'verify_identity', 'collect_fields', 'confirm', 'validate', 'simulate_tool', 'simulate_n8n', 'await_production_result', 'interpret_result', 'respond', 'transfer', 'escalate', 'complete'];
      const prev = order.indexOf(this.stepHistory[n - 2]);
      const cur = order.indexOf(this.stepHistory[n - 1]);
      if (prev > -1 && cur > -1 && cur < prev - 2) {
        this.push({
          loopType: 'state_regression', source: 'shadow',
          firstAtTurn: Math.max(0, state.turnCount - 1), repeatAtTurn: state.turnCount,
          affectedState: `${this.stepHistory[n - 2]}->${this.stepHistory[n - 1]}`,
          likelyCause: 'possible state loss (large backward jump)',
          recommendedCorrection: 'verify collected fields survived the transition',
        });
      }
    }
  }

  observeDuplicateCompletedAction(turn: number, action: string, source: 'production' | 'shadow'): void {
    this.push({
      loopType: 'duplicate_completed_action', source,
      firstAtTurn: turn, repeatAtTurn: turn,
      affectedState: action,
      likelyCause: 'a successfully completed mutation was attempted again',
      recommendedCorrection: 'completed-actions ledger must gate mutations',
    });
  }
}
