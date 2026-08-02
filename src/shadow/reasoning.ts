/**
 * Shadow conversation-interpretation layer (Checkpoint 7).
 *
 * ADVISORY ONLY: output goes to the deterministic workflow engine, which decides
 * legality. Runs a deterministic heuristic pass always; optionally refines with
 * a routed model call (Checkpoint 8) when SHADOW_MODEL_ROUTING_ENABLED — never
 * required for correctness, and unit tests use the deterministic pass only.
 */
import { URGENT_SYMPTOMS } from '../config/knowledgeBase';
import type { ShadowConfig } from './config';
import type { ShadowConversationState, ShadowReasoningResult } from './contracts';
import { sanitizeProposedResponse } from './redaction';
import { selectTier, type RoutingSignals } from './modelRouter';

interface IntentPattern {
  intent: string;
  patterns: RegExp[];
}

/** Domain lexicons per agent family. Order matters (first match = primary). */
const MEDICAL_INTENTS: IntentPattern[] = [
  { intent: 'urgent_symptom', patterns: [/vision loss|can'?t see|flashes|floaters|curtain|shadow in.*vision|chemical|injur|trauma|severe (eye )?pain|sudden/i] },
  { intent: 'cancel_appointment', patterns: [/cancel(?!.*resched)/i] },
  { intent: 'reschedule_appointment', patterns: [/reschedul|move (my|the) appointment|change (my|the) appointment|different (day|time)/i] },
  { intent: 'confirm_appointment', patterns: [/confirm(ing)? (my|the|an) appointment/i] },
  { intent: 'book_appointment', patterns: [/\b(book|schedule|make|set ?up)\b.*\b(appointment|visit|exam|eye ?exam)|appointment.*\b(book|schedule)\b|new appointment/i] },
  { intent: 'appointment_request', patterns: [/appointment/i] },
  { intent: 'prescription_refill', patterns: [/refill|prescription|eye ?drops?\b.*(renew|refill|more)/i] },
  { intent: 'ticket_status', patterns: [/status of|any update|heard back|follow(ing)? up on/i] },
  { intent: 'billing_question', patterns: [/bill|payment|charge|invoice|owe/i] },
  { intent: 'insurance_question', patterns: [/insurance|coverage|copay|vsp|medicare|medicaid/i] },
  { intent: 'hours_question', patterns: [/\b(hours?|open|close[sd]?|closing|opening)\b.*\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|office|you)\b|what time.*(open|close)|are you open/i] },
  { intent: 'location_question', patterns: [/where.*(located|office|address)|directions|address/i] },
  { intent: 'transfer_request', patterns: [/\b(representative|real person|human|operator|front desk|speak to (someone|a person))\b/i] },
  { intent: 'callback_request', patterns: [/call (me )?back|callback|return my call/i] },
  { intent: 'new_patient_intake', patterns: [/new patient|never been (there|in)|first (visit|time)/i] },
  { intent: 'practice_question', patterns: [/do you (take|accept|offer)|services|doctors?( there)?\b/i] },
];

const FANTASY_INTENTS: IntentPattern[] = [
  { intent: 'comparison_question', patterns: [/compare|versus|vs\.?|better|start.*or/i] },
  { intent: 'player_question', patterns: [/stats|points|player|week|projection/i] },
];

const FIELD_EXTRACTORS: Array<{ field: string; re: RegExp; group?: number }> = [
  { field: 'callerName', re: /(?:my name is|this is|i'?m)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i, group: 1 },
  { field: 'callerPhone', re: /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/ },
  { field: 'dob', re: /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/ },
  { field: 'patientAssent', re: /\b(yes,? (i )?confirm|that'?s (right|correct)|sounds good|yes please|correct)\b/i },
];

const CORRECTION_RE = /\b(no,? (actually|wait|sorry)|i meant|not that|correction|that'?s wrong|instead)\b/i;
const CANCEL_FLOW_RE = /\b(never ?mind|forget it|don'?t worry about it|cancel that)\b/i;
const RESTART_RE = /\b(start over|from the beginning|restart)\b/i;

function urgencyOf(text: string): ShadowReasoningResult['urgency'] {
  const t = text.toLowerCase();
  const symptoms: string[] = (URGENT_SYMPTOMS as { symptoms?: string[] })?.symptoms ?? [];
  if (/\b(911|can'?t breathe|chest pain|unconscious)\b/.test(t)) return 'emergency';
  if (symptoms.some((s) => t.includes(s.toLowerCase().slice(0, 12)))) return 'urgent';
  if (/\b(urgent|emergency|right away|immediately|severe|worst)\b/.test(t)) return 'urgent';
  if (/\b(pain|worried|scared|getting worse)\b/.test(t)) return 'elevated';
  return 'none';
}

export interface ReasoningDeps {
  /** Optional LLM refinement; injected in production, faked in tests. */
  llmRefine?: (
    tier: 'low' | 'mid' | 'high',
    state: ShadowConversationState,
    heuristic: ShadowReasoningResult,
  ) => Promise<Partial<ShadowReasoningResult> | null>;
}

const TOOL_FOR_INTENT: Record<string, Record<string, string>> = {
  'no-ivr': {
    ticket_request: 'create_ticket', prescription_refill: 'create_ticket',
    billing_question: 'create_ticket', appointment_request: 'create_ticket',
    callback_request: 'create_ticket', ticket_status: 'check_open_tickets',
    hours_question: 'lookup_schedule', urgent_symptom: 'escalate_to_human',
  },
  'answering-service': {
    ticket_request: 'create_ticket', prescription_refill: 'create_ticket',
    billing_question: 'create_ticket', appointment_request: 'create_ticket',
    callback_request: 'create_ticket', ticket_status: 'check_open_tickets',
    hours_question: 'lookup_schedule',
  },
  'after-hours': {
    ticket_request: 'create_after_hours_ticket', appointment_request: 'create_after_hours_ticket',
    urgent_symptom: 'transfer_to_human',
  },
  'azul-scheduling': {
    book_appointment: 'sage_book', reschedule_appointment: 'sage_reschedule',
    cancel_appointment: 'cancel_appointment', confirm_appointment: 'sage_confirm_appointment',
    new_patient_intake: 'sage_new_patient_intake', handoff_request: 'sage_handoff',
    insurance_question: 'sage_insurance_check', practice_question: 'sage_practice',
  },
  'appointment-confirmation': {
    confirm_appointment: 'confirm_appointment', reschedule_appointment: 'reschedule_request',
    cancel_appointment: 'cancel_appointment',
  },
  'drs-scheduler': { drs_booking: 'phreesia_schedule' },
  'fantasy-football': { player_question: 'getPlayerStats', comparison_question: 'comparePlayers' },
};
TOOL_FOR_INTENT['dev-no-ivr'] = TOOL_FOR_INTENT['no-ivr'];

/** Intents mapped to ticket_request family for ticket agents. */
function normalizeIntent(agentId: string, intent: string): string {
  if (
    (agentId === 'no-ivr' || agentId === 'dev-no-ivr' || agentId === 'answering-service' || agentId === 'after-hours') &&
    ['appointment_request', 'prescription_refill', 'billing_question', 'callback_request'].includes(intent)
  ) {
    return intent; // kept distinct; required fields identical to ticket_request
  }
  return intent;
}

export function questionTextFor(field: string): string {
  switch (field) {
    case 'callerName': return 'May I have your first and last name, please?';
    case 'callerPhone': return 'What is the best phone number to reach you?';
    case 'reason': return 'Can you tell me briefly what you are calling about?';
    case 'dob': return 'What is your date of birth?';
    case 'urgencyAssessment': return 'Is this something that needs attention tonight, or can the office follow up next business day?';
    case 'identityVerified': return 'To pull up your record, may I have your last name, date of birth, and the last four digits of your phone number?';
    case 'appointmentType': return 'What type of visit would you like to schedule?';
    case 'targetAppointment': return 'Which appointment are you calling about?';
    case 'offerAccepted': return 'Does one of those times work for you?';
    case 'patientAssent': return 'Can you confirm that works for you?';
    case 'appointmentSlot': return 'Which of the available times works best?';
    default: return `Could you share your ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}?`;
  }
}

export async function interpretTurn(
  state: ShadowConversationState,
  userText: string,
  requiredFieldsForIntent: (intent: string) => string[],
  cfg: ShadowConfig,
  deps: ReasoningDeps = {},
): Promise<ShadowReasoningResult> {
  const text = userText ?? '';
  const lexicon = state.agentId === 'fantasy-football' ? FANTASY_INTENTS : MEDICAL_INTENTS;

  const hits = lexicon.filter((p) => p.patterns.some((re) => re.test(text)));
  const primary = hits[0]?.intent ?? (state.intent ?? 'other');
  const intent = normalizeIntent(state.agentId, primary);
  const secondary = hits.slice(1).map((h) => h.intent).filter((i) => i !== primary);
  const multiIntent = secondary.length > 0;

  const extracted: Record<string, string> = {};
  for (const ex of FIELD_EXTRACTORS) {
    const m = text.match(ex.re);
    if (m) extracted[ex.field] = (ex.group ? m[ex.group] : m[0]).trim();
  }
  if (intent !== 'other' && !state.collectedFields['reason'] && text.length > 3 && hits.length > 0) {
    extracted['reason'] = text.slice(0, 200);
  }

  const correction = CORRECTION_RE.test(text);
  const cancelled = CANCEL_FLOW_RE.test(text);
  const restart = RESTART_RE.test(text);

  const required = requiredFieldsForIntent(intent);
  const have = new Set([...Object.keys(state.collectedFields), ...Object.keys(extracted)]);
  const missing = required.filter((f) => !have.has(f));

  const urgency = urgencyOf(text);
  const ambiguous = hits.length === 0 && text.trim().length > 0 && (state.intent === null || state.turnCount <= 1);

  // --- action selection (advisory) ---
  let recommendedAction: ShadowReasoningResult['recommendedAction'];
  let recommendedTool: string | undefined;
  let userFacingQuestion: string | undefined;
  let proposedResponse: string | undefined;
  let rationaleCode: string;

  const toolMap = TOOL_FOR_INTENT[state.agentId] ?? {};
  const intentTool = toolMap[intent];

  if (restart) {
    recommendedAction = 'respond';
    proposedResponse = 'Of course — let us start over. What can I help you with?';
    rationaleCode = 'caller_restart';
  } else if (cancelled) {
    recommendedAction = 'complete';
    proposedResponse = 'No problem, I will not proceed with that. Is there anything else I can help you with?';
    rationaleCode = 'caller_cancelled';
  } else if (urgency === 'emergency') {
    recommendedAction = 'escalate';
    proposedResponse = 'This sounds like a medical emergency. Please hang up and dial 911 right away.';
    rationaleCode = 'emergency_escalation';
  } else if (urgency === 'urgent' && state.agentId !== 'fantasy-football') {
    recommendedAction = 'escalate';
    recommendedTool = toolMap['urgent_symptom'];
    proposedResponse = 'Those symptoms need prompt attention. Let me connect you with our on-call team right away.';
    rationaleCode = 'urgent_symptom_escalation';
  } else if (ambiguous) {
    recommendedAction = 'ask_question';
    userFacingQuestion = 'I want to make sure I help with the right thing — could you tell me a bit more about what you need?';
    rationaleCode = 'ambiguous_intent';
  } else if (missing.length > 0) {
    recommendedAction = 'ask_question';
    userFacingQuestion = questionTextFor(missing[0]);
    rationaleCode = 'missing_required_field';
  } else if (intentTool && required.length > 0) {
    // All fields present: confirm before mutation; engine enforces the same.
    const confirmed = state.confirmedFields.includes(`confirm:${intentTool}`);
    if (!confirmed) {
      recommendedAction = 'confirm';
      userFacingQuestion = 'Let me read that back to make sure I have it right.';
      rationaleCode = 'readback_confirmation';
    } else {
      recommendedAction = 'simulate_tool_call';
      recommendedTool = intentTool;
      rationaleCode = 'fields_complete_tool_eligible';
    }
  } else if (intentTool) {
    recommendedAction = 'simulate_tool_call';
    recommendedTool = intentTool;
    rationaleCode = 'readonly_tool_eligible';
  } else if (intent === 'transfer_request') {
    recommendedAction = 'transfer';
    rationaleCode = 'caller_requested_human';
  } else {
    recommendedAction = 'respond';
    proposedResponse = 'Happy to help with that.';
    rationaleCode = hits.length === 0 ? 'no_intent_matched' : 'informational_response';
  }

  const signals: RoutingSignals = {
    ambiguityScore: ambiguous ? 0.8 : hits.length > 1 ? 0.4 : 0,
    unresolvedFieldCount: missing.length,
    candidateIntentCount: Math.max(1, hits.length),
    constraintCount: (text.match(/\b(only|but|except|before|after|unless)\b/gi) ?? []).length,
    retryCount: Object.values(state.retryCounts).reduce((a, b) => a + b, 0),
    conflictCount: correction ? 1 : 0,
    policyComplexity: state.agentId === 'azul-scheduling' ? 1 : 0,
    toolResultComplexity: 0,
    escalationRequested: recommendedAction === 'escalate',
  };
  const deterministicSufficient =
    !ambiguous && !multiIntent && !correction && signals.retryCount === 0 && signals.conflictCount === 0;
  const tier = selectTier(signals, deterministicSufficient, cfg);

  let result: ShadowReasoningResult = {
    contractVersion: 1,
    intent,
    confidence: hits.length > 0 ? (multiIntent ? 0.6 : 0.85) : state.intent ? 0.5 : 0.3,
    extractedFields: extracted,
    missingFields: missing,
    ambiguous,
    ambiguityReason: ambiguous ? 'no lexicon match on an early turn' : undefined,
    urgency,
    multiIntent,
    secondaryIntents: secondary,
    recommendedAction,
    recommendedTool,
    simulatedToolArgs: undefined,
    recommendedN8nWorkflow: undefined,
    simulatedN8nPayload: undefined,
    userFacingQuestion,
    proposedResponse: proposedResponse ? sanitizeProposedResponse(proposedResponse) : undefined,
    rationaleCode,
    selectedModelTier: tier.tier,
    modelSelectionReason: tier.reason,
  };

  if (tier.tier !== 'deterministic' && deps.llmRefine) {
    try {
      const refined = await deps.llmRefine(tier.tier, state, result);
      if (refined) result = { ...result, ...refined, selectedModelTier: tier.tier };
    } catch {
      // Model failure is invisible to production and non-fatal to shadow:
      // the deterministic result stands.
      result.modelSelectionReason += ' (llm_failed_fallback_deterministic)';
    }
  }
  return result;
}
