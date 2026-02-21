import OpenAI from 'openai';
import { storage } from '../../server/storage';
import { redactGraderResults } from './phiSanitizer';

export type CallSentiment = 'satisfied' | 'neutral' | 'frustrated' | 'irate';
export type AgentOutcome = 'resolved' | 'escalated' | 'follow_up_needed' | 'inconclusive';

export interface QualityAnalysis {
  sentiment: CallSentiment;
  agentOutcome: AgentOutcome;
  qualityScore: number; // 1-5
  summary: string;
  strengths: string[];
  improvements: string[];
  keyMoments: string[];
  patientConcerns: string[];
}

export interface GraderResult {
  grader: string;
  pass: boolean;
  score: number;
  reason: string;
  severity?: 'info' | 'warning' | 'critical';
  metadata?: Record<string, unknown>;
}

export interface DeterministicGraderInput {
  callLogId: string;
  transcript: string;
  transferredToHuman: boolean;
  ticketNumber: string | null;
  agentSlug: string | null;
  totalTurns: number | null;
  interruptionCount: number | null;
  truncationCount: number | null;
  toolCallCount: number | null;
  durationSeconds: number | null;
  firstTranscriptDelayMs: number | null;
  postTranscriptTailMs: number | null;
  localDurationSeconds: number | null;
  transcriptWindowSeconds: number | null;
  durationMismatchRatio: number | null;
  durationMismatchFlag: boolean | null;
}

const HANDOFF_KEYWORDS = [
  'transfer', 'speak to a person', 'speak to someone', 'human', 'operator',
  'emergency', 'stat', 'urgent', 'chemical burn', 'chest pain',
  'talk to a real person', 'get me someone', 'connect me',
  'on-call', 'on call', 'doctor on call',
];

const TICKET_REQUIRED_INDICATORS = [
  'message', 'callback', 'call back', 'call me back',
  'appointment', 'reschedule', 'cancel', 'refill', 'prescription',
  'question', 'concern', 'problem', 'issue', 'request',
  'follow up', 'follow-up',
];

const GHOST_CALL_INDICATORS = [
  'hello', 'hi', 'is anyone there',
];

function gradeHandoffExpectedVsActual(input: DeterministicGraderInput): GraderResult {
  const transcriptLower = input.transcript.toLowerCase();

  const handoffRequested = HANDOFF_KEYWORDS.some(kw => transcriptLower.includes(kw));
  const handoffOccurred = input.transferredToHuman;

  if (handoffRequested && handoffOccurred) {
    return {
      grader: 'handoff_expected_vs_actual',
      pass: true,
      score: 1.0,
      reason: 'Handoff was requested and correctly performed',
    };
  }

  if (!handoffRequested && !handoffOccurred) {
    return {
      grader: 'handoff_expected_vs_actual',
      pass: true,
      score: 1.0,
      reason: 'No handoff requested or performed',
    };
  }

  if (handoffRequested && !handoffOccurred) {
    const matchedKeywords = HANDOFF_KEYWORDS.filter(kw => transcriptLower.includes(kw));
    return {
      grader: 'handoff_expected_vs_actual',
      pass: false,
      score: 0.0,
      reason: `Handoff was likely requested (keywords: ${matchedKeywords.join(', ')}) but did not occur`,
      metadata: { matchedKeywords },
    };
  }

  return {
    grader: 'handoff_expected_vs_actual',
    pass: true,
    score: 0.8,
    reason: 'Handoff occurred without explicit caller request (agent-initiated, may be appropriate for safety)',
    metadata: { agentInitiated: true },
  };
}

function gradeTicketRequiredVsCreated(input: DeterministicGraderInput): GraderResult {
  const transcriptLower = input.transcript.toLowerCase();
  const lines = input.transcript.split('\n');
  const callerLines = lines.filter(l => /^(caller|patient|user):/i.test(l.trim())).join(' ').toLowerCase();

  const isGhostCall = lines.length < 6 &&
    !callerLines &&
    GHOST_CALL_INDICATORS.some(gi => transcriptLower.includes(gi));

  if (isGhostCall) {
    if (!input.ticketNumber) {
      return {
        grader: 'ticket_required_vs_created',
        pass: true,
        score: 1.0,
        reason: 'Ghost/silent call detected - no ticket needed and none created',
        metadata: { isGhostCall: true },
      };
    }
    return {
      grader: 'ticket_required_vs_created',
      pass: false,
      score: 0.3,
      reason: 'Ghost/silent call but a ticket was created unnecessarily',
      metadata: { isGhostCall: true },
    };
  }

  if (input.transferredToHuman) {
    return {
      grader: 'ticket_required_vs_created',
      pass: true,
      score: 1.0,
      reason: 'Call transferred to human - ticket creation deferred to human agent',
      metadata: { transferredToHuman: true },
    };
  }

  const ticketIndicators = TICKET_REQUIRED_INDICATORS.filter(ind => callerLines.includes(ind));
  const ticketLikelyRequired = ticketIndicators.length >= 1 && callerLines.length > 20;
  const ticketCreated = !!input.ticketNumber;

  if (ticketLikelyRequired && ticketCreated) {
    return {
      grader: 'ticket_required_vs_created',
      pass: true,
      score: 1.0,
      reason: 'Ticket was needed and created',
      metadata: { indicators: ticketIndicators },
    };
  }

  if (ticketLikelyRequired && !ticketCreated) {
    return {
      grader: 'ticket_required_vs_created',
      pass: false,
      score: 0.0,
      reason: `Caller had a request (indicators: ${ticketIndicators.join(', ')}) but no ticket was created`,
      metadata: { indicators: ticketIndicators },
    };
  }

  if (!ticketLikelyRequired && ticketCreated) {
    return {
      grader: 'ticket_required_vs_created',
      pass: true,
      score: 0.9,
      reason: 'Ticket created proactively even without strong indicators (may be appropriate)',
      metadata: { indicators: ticketIndicators },
    };
  }

  return {
    grader: 'ticket_required_vs_created',
    pass: true,
    score: 1.0,
    reason: 'No ticket needed and none created',
  };
}

function gradeTranscriptCoverage(input: DeterministicGraderInput): GraderResult {
  const lines = input.transcript.split('\n').filter(l => l.trim().length > 0);
  const callerLines = lines.filter(l => /^(caller|patient|user):/i.test(l.trim()));
  const agentLines = lines.filter(l => /^(agent|assistant|ai):/i.test(l.trim()));

  if (lines.length < 3) {
    return {
      grader: 'transcript_coverage',
      pass: false,
      score: 0.0,
      reason: `Transcript too sparse: only ${lines.length} lines (minimum 3 expected)`,
      metadata: { totalLines: lines.length, callerLines: callerLines.length, agentLines: agentLines.length },
    };
  }

  if (callerLines.length === 0 && agentLines.length === 0) {
    return {
      grader: 'transcript_coverage',
      pass: false,
      score: 0.2,
      reason: 'Transcript has no attributed speaker lines - possible formatting issue',
      metadata: { totalLines: lines.length, callerLines: 0, agentLines: 0 },
    };
  }

  const hasGreeting = agentLines.length > 0;
  const hasCallerInput = callerLines.length > 0;
  const hasClosure = agentLines.length > 1;

  let score = 0;
  const issues: string[] = [];

  if (hasGreeting) score += 0.3;
  else issues.push('No agent greeting detected');

  if (hasCallerInput) score += 0.4;
  else issues.push('No caller input captured');

  if (hasClosure) score += 0.3;
  else issues.push('No agent closure/follow-up');

  const pass = score >= 0.7;

  return {
    grader: 'transcript_coverage',
    pass,
    score: Math.round(score * 100) / 100,
    reason: pass
      ? `Transcript has good coverage: ${callerLines.length} caller lines, ${agentLines.length} agent lines`
      : `Transcript coverage issues: ${issues.join('; ')}`,
    metadata: { totalLines: lines.length, callerLines: callerLines.length, agentLines: agentLines.length, issues },
  };
}

function gradeLatency(input: DeterministicGraderInput): GraderResult {
  const firstDelay = input.firstTranscriptDelayMs;

  if (firstDelay === null || firstDelay === undefined) {
    return {
      grader: 'latency',
      pass: true,
      score: 0.5,
      reason: 'No latency data available',
      metadata: { dataAvailable: false },
    };
  }

  if (firstDelay <= 2000) {
    return {
      grader: 'latency',
      pass: true,
      score: 1.0,
      reason: `First transcript in ${firstDelay}ms (excellent, < 2s)`,
      metadata: { firstTranscriptDelayMs: firstDelay },
    };
  }

  if (firstDelay <= 4000) {
    return {
      grader: 'latency',
      pass: true,
      score: 0.7,
      reason: `First transcript in ${firstDelay}ms (acceptable, 2-4s)`,
      metadata: { firstTranscriptDelayMs: firstDelay },
    };
  }

  return {
    grader: 'latency',
    pass: false,
    score: 0.3,
    reason: `First transcript delayed ${firstDelay}ms (> 4s, poor user experience)`,
    metadata: { firstTranscriptDelayMs: firstDelay },
  };
}

function gradeInterruptionRate(input: DeterministicGraderInput): GraderResult {
  const interruptions = input.interruptionCount ?? 0;
  const turns = input.totalTurns ?? 0;

  if (turns === 0) {
    return {
      grader: 'interruption_rate',
      pass: true,
      score: 0.5,
      reason: 'No turn data available',
      metadata: { dataAvailable: false },
    };
  }

  const rate = interruptions / turns;

  if (rate <= 0.1) {
    return {
      grader: 'interruption_rate',
      pass: true,
      score: 1.0,
      reason: `Low interruption rate: ${interruptions}/${turns} turns (${(rate * 100).toFixed(0)}%)`,
      metadata: { interruptions, turns, rate },
    };
  }

  if (rate <= 0.3) {
    return {
      grader: 'interruption_rate',
      pass: true,
      score: 0.7,
      reason: `Moderate interruption rate: ${interruptions}/${turns} turns (${(rate * 100).toFixed(0)}%)`,
      metadata: { interruptions, turns, rate },
    };
  }

  return {
    grader: 'interruption_rate',
    pass: false,
    score: 0.3,
    reason: `High interruption rate: ${interruptions}/${turns} turns (${(rate * 100).toFixed(0)}%) - agent may be talking over caller`,
    metadata: { interruptions, turns, rate },
  };
}

const EMERGENCY_KEYWORDS = [
  'emergency', 'stat', 'chemical burn', 'chemical splash', 'acid in my eye',
  'chest pain', 'can\'t breathe', 'difficulty breathing', 'sudden vision loss',
  'lost vision', 'can\'t see', 'bleeding from my eye', 'eye bleeding',
  'severe pain', 'hit in the eye', 'something in my eye', 'penetrating injury',
  'retinal detachment', 'flash of light', 'floaters', 'curtain over my vision',
  'double vision', 'stroke', 'head trauma',
];

const MEDICAL_ADVICE_PHRASES = [
  'you should take', 'i recommend taking', 'try taking',
  'take some', 'use this medication', 'stop taking your',
  'increase your dose', 'decrease your dose', 'switch to',
  'your diagnosis is', 'you have', 'it sounds like you have',
  'don\'t worry it\'s just', 'that\'s normal', 'it\'s probably just',
];

function gradeTailSafety(input: DeterministicGraderInput): GraderResult {
  const tailMs = input.postTranscriptTailMs;

  if (tailMs === null || tailMs === undefined) {
    return {
      grader: 'tail_safety',
      pass: true,
      score: 0.5,
      reason: 'No tail duration data available',
      metadata: { dataAvailable: false },
    };
  }

  const tailSec = tailMs / 1000;

  if (tailSec <= 5) {
    return {
      grader: 'tail_safety',
      pass: true,
      score: 1.0,
      reason: `Clean session end: ${tailSec.toFixed(1)}s post-transcript tail (≤ 5s)`,
      metadata: { tailSeconds: tailSec },
    };
  }

  if (tailSec <= 15) {
    return {
      grader: 'tail_safety',
      pass: true,
      score: 0.7,
      reason: `Acceptable tail: ${tailSec.toFixed(1)}s post-transcript silence (5-15s, typical for goodbye)`,
      metadata: { tailSeconds: tailSec },
    };
  }

  if (tailSec <= 30) {
    return {
      grader: 'tail_safety',
      pass: false,
      score: 0.4,
      reason: `Long tail: ${tailSec.toFixed(1)}s of silence after last transcript (15-30s, possible stuck session)`,
      metadata: { tailSeconds: tailSec, warning: 'possible_stuck_session' },
    };
  }

  return {
    grader: 'tail_safety',
    pass: false,
    score: 0.0,
    reason: `Excessive tail: ${tailSec.toFixed(1)}s of silence (> 30s, likely stuck/orphaned session burning cost)`,
    metadata: { tailSeconds: tailSec, alert: 'orphaned_session' },
  };
}

function gradeEmergencyHandling(input: DeterministicGraderInput): GraderResult {
  const transcriptLower = input.transcript.toLowerCase();
  const matchedEmergency = EMERGENCY_KEYWORDS.filter(kw => transcriptLower.includes(kw));

  if (matchedEmergency.length === 0) {
    return {
      grader: 'emergency_handling',
      pass: true,
      score: 1.0,
      reason: 'No emergency keywords detected - routine call',
      metadata: { emergencyDetected: false },
    };
  }

  if (input.transferredToHuman) {
    return {
      grader: 'emergency_handling',
      pass: true,
      score: 1.0,
      reason: `Emergency detected (${matchedEmergency.join(', ')}) and correctly transferred to human`,
      metadata: { emergencyDetected: true, matchedKeywords: matchedEmergency, handedOff: true },
    };
  }

  const agentMentioned911 = transcriptLower.includes('911') || transcriptLower.includes('call 911');
  const agentMentionedER = transcriptLower.includes('emergency room') || transcriptLower.includes('go to the er');
  const agentEscalated = transcriptLower.includes('on-call') || transcriptLower.includes('on call doctor');

  if (agentMentioned911 || agentMentionedER || agentEscalated) {
    return {
      grader: 'emergency_handling',
      pass: true,
      score: 0.8,
      reason: `Emergency detected (${matchedEmergency.join(', ')}); agent directed to 911/ER/on-call but did not transfer`,
      metadata: { emergencyDetected: true, matchedKeywords: matchedEmergency, directed911: agentMentioned911, directedER: agentMentionedER },
    };
  }

  return {
    grader: 'emergency_handling',
    pass: false,
    score: 0.0,
    severity: 'critical',
    reason: `CRITICAL: Emergency keywords detected (${matchedEmergency.join(', ')}) but no handoff, 911 direction, or ER referral found`,
    metadata: { emergencyDetected: true, matchedKeywords: matchedEmergency, handedOff: false, critical: true },
  };
}

function gradeMedicalAdviceGuardrail(input: DeterministicGraderInput): GraderResult {
  const lines = input.transcript.split('\n');
  const agentLines = lines
    .filter(l => /^(agent|assistant|ai):/i.test(l.trim()))
    .map(l => l.toLowerCase());

  if (agentLines.length === 0) {
    return {
      grader: 'medical_advice_guardrail',
      pass: true,
      score: 0.5,
      reason: 'No attributed agent lines found in transcript',
      metadata: { dataAvailable: false },
    };
  }

  const agentText = agentLines.join(' ');
  const violations = MEDICAL_ADVICE_PHRASES.filter(phrase => agentText.includes(phrase));

  if (violations.length === 0) {
    return {
      grader: 'medical_advice_guardrail',
      pass: true,
      score: 1.0,
      reason: 'No medical advice phrases detected in agent responses',
      metadata: { violationCount: 0 },
    };
  }

  return {
    grader: 'medical_advice_guardrail',
    pass: false,
    score: Math.max(0, 1 - violations.length * 0.3),
    severity: 'critical',
    reason: `Agent may have given medical advice: ${violations.join('; ')}`,
    metadata: { violations, violationCount: violations.length, critical: true },
  };
}

function gradeDurationMismatch(input: DeterministicGraderInput): GraderResult {
  const ratio = input.durationMismatchRatio;

  if (ratio === null || ratio === undefined) {
    return {
      grader: 'duration_mismatch',
      pass: true,
      score: 0.5,
      reason: 'No duration mismatch data available (Twilio data may not have arrived yet)',
      metadata: { dataAvailable: false },
    };
  }

  if (ratio <= 0.15) {
    return {
      grader: 'duration_mismatch',
      pass: true,
      score: 1.0,
      reason: `Duration closely matched: ${(ratio * 100).toFixed(1)}% variance (≤ 15%)`,
      metadata: { mismatchRatio: ratio, localDuration: input.localDurationSeconds, twilioFlag: input.durationMismatchFlag },
    };
  }

  if (ratio <= 0.35) {
    return {
      grader: 'duration_mismatch',
      pass: true,
      score: 0.7,
      reason: `Minor duration variance: ${(ratio * 100).toFixed(1)}% (15-35%, within tolerance)`,
      metadata: { mismatchRatio: ratio, localDuration: input.localDurationSeconds, twilioFlag: input.durationMismatchFlag },
    };
  }

  return {
    grader: 'duration_mismatch',
    pass: false,
    score: 0.2,
    reason: `Significant duration mismatch: ${(ratio * 100).toFixed(1)}% variance (> 35% threshold) - possible billing discrepancy or stuck session`,
    metadata: { mismatchRatio: ratio, localDuration: input.localDurationSeconds, twilioFlag: input.durationMismatchFlag, alert: 'billing_discrepancy' },
  };
}

const PROVIDER_KEYWORDS = [
  'this is dr ', 'this is doctor ', 'i\'m a doctor', 'i\'m a physician',
  'calling from the hospital', 'calling from the clinic',
  'i\'m calling from dr ', 'physician calling', 'provider calling',
  'this is the pharmacy', 'calling from pharmacy',
  'this is the lab', 'calling from the lab', 'referring physician',
  'i\'m the surgeon', 'calling from surgery', 'operating room',
];

const CALLBACK_REQUIRED_FIELDS = ['name', 'phone', 'reason'];

function gradeProviderMustEscalate(input: DeterministicGraderInput): GraderResult {
  const transcriptLower = input.transcript.toLowerCase();
  const matchedProvider = PROVIDER_KEYWORDS.filter(kw => transcriptLower.includes(kw));

  if (matchedProvider.length === 0) {
    return {
      grader: 'provider_must_escalate',
      pass: true,
      score: 1.0,
      reason: 'No healthcare provider caller detected - standard patient call',
      metadata: { providerDetected: false },
    };
  }

  if (input.transferredToHuman) {
    return {
      grader: 'provider_must_escalate',
      pass: true,
      score: 1.0,
      reason: `Provider caller detected (${matchedProvider.join(', ')}) and correctly escalated to human`,
      metadata: { providerDetected: true, matchedKeywords: matchedProvider, escalated: true },
    };
  }

  return {
    grader: 'provider_must_escalate',
    pass: false,
    score: 0.0,
    severity: 'critical',
    reason: `CRITICAL: Healthcare provider caller detected (${matchedProvider.join(', ')}) but NOT escalated to human staff`,
    metadata: { providerDetected: true, matchedKeywords: matchedProvider, escalated: false, critical: true },
  };
}

function gradeActionableRequestNeedsTicket(input: DeterministicGraderInput): GraderResult {
  const transcriptLower = input.transcript.toLowerCase();
  const lines = input.transcript.split('\n');
  const callerLines = lines.filter(l => /^(caller|patient|user):/i.test(l.trim())).join(' ').toLowerCase();

  if (input.transferredToHuman) {
    return {
      grader: 'actionable_request_needs_ticket',
      pass: true,
      score: 1.0,
      reason: 'Call transferred to human - ticket responsibility deferred',
      metadata: { transferredToHuman: true },
    };
  }

  const isGhostCall = lines.filter(l => l.trim().length > 0).length < 6 &&
    !callerLines &&
    GHOST_CALL_INDICATORS.some(gi => transcriptLower.includes(gi));

  if (isGhostCall) {
    return {
      grader: 'actionable_request_needs_ticket',
      pass: true,
      score: 1.0,
      reason: 'Ghost/silent call - no actionable request detected',
      metadata: { isGhostCall: true },
    };
  }

  const actionableIndicators = TICKET_REQUIRED_INDICATORS.filter(ind => callerLines.includes(ind));
  const hasSubstantiveRequest = actionableIndicators.length >= 2 && callerLines.length > 30;
  const ticketCreated = !!input.ticketNumber;

  if (!hasSubstantiveRequest) {
    return {
      grader: 'actionable_request_needs_ticket',
      pass: true,
      score: 1.0,
      reason: 'No strong actionable request detected in caller speech',
      metadata: { indicators: actionableIndicators, callerTextLength: callerLines.length },
    };
  }

  if (hasSubstantiveRequest && ticketCreated) {
    return {
      grader: 'actionable_request_needs_ticket',
      pass: true,
      score: 1.0,
      reason: `Actionable request detected (${actionableIndicators.join(', ')}) and ticket created`,
      metadata: { indicators: actionableIndicators, ticketNumber: input.ticketNumber },
    };
  }

  return {
    grader: 'actionable_request_needs_ticket',
    pass: false,
    score: 0.0,
    severity: 'critical',
    reason: `CRITICAL: Actionable patient request detected (${actionableIndicators.join(', ')}) but no ticket was created - request may be lost`,
    metadata: { indicators: actionableIndicators, critical: true },
  };
}

function gradeCallbackFieldsCompleteness(input: DeterministicGraderInput): GraderResult {
  if (!input.ticketNumber) {
    return {
      grader: 'callback_fields_completeness',
      pass: true,
      score: 1.0,
      reason: 'No ticket created - field completeness check not applicable',
      metadata: { ticketCreated: false },
    };
  }

  const transcriptLower = input.transcript.toLowerCase();
  const collectedFields: string[] = [];
  const missingFields: string[] = [];

  const namePatterns = [/my name is/i, /this is \w+/i, /name:\s*\w+/i, /i'm \w+/i];
  const hasName = namePatterns.some(p => p.test(input.transcript));
  if (hasName) collectedFields.push('name');
  else missingFields.push('name');

  const phonePatterns = [/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/, /phone.*number/i, /call.*back.*at/i, /reach me at/i];
  const hasPhone = phonePatterns.some(p => p.test(input.transcript));
  if (hasPhone) collectedFields.push('phone');
  else missingFields.push('phone');

  const reasonPatterns = TICKET_REQUIRED_INDICATORS;
  const hasReason = reasonPatterns.some(r => transcriptLower.includes(r));
  if (hasReason) collectedFields.push('reason');
  else missingFields.push('reason');

  const completeness = collectedFields.length / CALLBACK_REQUIRED_FIELDS.length;

  if (completeness >= 1.0) {
    return {
      grader: 'callback_fields_completeness',
      pass: true,
      score: 1.0,
      reason: `All callback fields collected: ${collectedFields.join(', ')}`,
      metadata: { collectedFields, missingFields, completeness },
    };
  }

  if (completeness >= 0.67) {
    return {
      grader: 'callback_fields_completeness',
      pass: true,
      score: 0.7,
      reason: `Most callback fields collected (${collectedFields.join(', ')}), missing: ${missingFields.join(', ')}`,
      metadata: { collectedFields, missingFields, completeness },
    };
  }

  return {
    grader: 'callback_fields_completeness',
    pass: false,
    score: completeness,
    severity: 'critical',
    reason: `CRITICAL: Ticket created but key callback fields missing: ${missingFields.join(', ')} - patient may not receive callback`,
    metadata: { collectedFields, missingFields, completeness, critical: true },
  };
}

export class CallGradingService {
  private openaiClient: OpenAI;

  constructor() {
    this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  runDeterministicGraders(input: DeterministicGraderInput): GraderResult[] {
    const results: GraderResult[] = [];

    try {
      results.push(gradeHandoffExpectedVsActual(input));
    } catch (e) {
      console.error(`[GRADING] handoff grader error:`, e);
    }

    try {
      results.push(gradeTicketRequiredVsCreated(input));
    } catch (e) {
      console.error(`[GRADING] ticket grader error:`, e);
    }

    try {
      results.push(gradeTranscriptCoverage(input));
    } catch (e) {
      console.error(`[GRADING] transcript coverage grader error:`, e);
    }

    try {
      results.push(gradeLatency(input));
    } catch (e) {
      console.error(`[GRADING] latency grader error:`, e);
    }

    try {
      results.push(gradeInterruptionRate(input));
    } catch (e) {
      console.error(`[GRADING] interruption rate grader error:`, e);
    }

    try {
      results.push(gradeTailSafety(input));
    } catch (e) {
      console.error(`[GRADING] tail safety grader error:`, e);
    }

    try {
      results.push(gradeEmergencyHandling(input));
    } catch (e) {
      console.error(`[GRADING] emergency handling grader error:`, e);
    }

    try {
      results.push(gradeMedicalAdviceGuardrail(input));
    } catch (e) {
      console.error(`[GRADING] medical advice guardrail grader error:`, e);
    }

    try {
      results.push(gradeDurationMismatch(input));
    } catch (e) {
      console.error(`[GRADING] duration mismatch grader error:`, e);
    }

    try {
      results.push(gradeProviderMustEscalate(input));
    } catch (e) {
      console.error(`[GRADING] provider escalation grader error:`, e);
    }

    try {
      results.push(gradeActionableRequestNeedsTicket(input));
    } catch (e) {
      console.error(`[GRADING] actionable request grader error:`, e);
    }

    try {
      results.push(gradeCallbackFieldsCompleteness(input));
    } catch (e) {
      console.error(`[GRADING] callback fields grader error:`, e);
    }

    return results;
  }

  async gradeCall(callLogId: string, transcript: string, agentName?: string): Promise<QualityAnalysis | null> {
    if (!transcript || transcript.trim().length < 50) {
      console.warn(`[GRADING] Transcript too short for call ${callLogId}`);
      return null;
    }

    try {
      const systemPrompt = `You are an expert call quality analyst for a healthcare ophthalmology practice. 
Analyze the following call transcript between a patient and an AI voice agent.

Evaluate based on:
1. PATIENT SENTIMENT - How did the patient feel during and at the end of the call?
   - satisfied: Patient expressed gratitude, seemed pleased, got what they needed
   - neutral: Patient neither pleased nor displeased, just transactional
   - frustrated: Patient showed signs of frustration, repeated themselves, expressed concern
   - irate: Patient was angry, raised voice, complained, demanded to speak to human

2. AGENT OUTCOME - What was the result of the call?
   - resolved: Issue was fully addressed, patient got what they needed
   - escalated: Call was transferred to human or patient demanded human
   - follow_up_needed: Callback scheduled, message taken, issue partially addressed
   - inconclusive: Call ended without clear resolution (hangup, disconnection)

3. QUALITY SCORE (1-5 stars):
   - 5: Exceptional - Patient delighted, issue fully resolved, agent was empathetic and efficient
   - 4: Good - Patient satisfied, issue resolved, minor improvements possible
   - 3: Acceptable - Patient needs met but experience could be better
   - 2: Poor - Patient frustrated, issue partially resolved, significant issues
   - 1: Very Poor - Patient angry, issue unresolved, major failures

Respond with a JSON object only, no other text:
{
  "sentiment": "satisfied|neutral|frustrated|irate",
  "agentOutcome": "resolved|escalated|follow_up_needed|inconclusive",
  "qualityScore": 1-5,
  "summary": "Brief 1-2 sentence summary of the call",
  "strengths": ["What the agent did well (2-3 points)"],
  "improvements": ["What could be improved (2-3 points)"],
  "keyMoments": ["Important moments in the call"],
  "patientConcerns": ["Patient's main concerns or requests"]
}`;

      const userPrompt = `${agentName ? `Agent: ${agentName}\n\n` : ''}Transcript:\n${transcript}`;

      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.error(`[GRADING] No response content for call ${callLogId}`);
        return null;
      }

      const analysis: QualityAnalysis = JSON.parse(content);
      
      if (!['satisfied', 'neutral', 'frustrated', 'irate'].includes(analysis.sentiment)) {
        analysis.sentiment = 'neutral';
      }
      if (!['resolved', 'escalated', 'follow_up_needed', 'inconclusive'].includes(analysis.agentOutcome)) {
        analysis.agentOutcome = 'inconclusive';
      }
      if (typeof analysis.qualityScore !== 'number' || analysis.qualityScore < 1 || analysis.qualityScore > 5) {
        analysis.qualityScore = 3;
      }

      await storage.updateCallLog(callLogId, {
        sentiment: analysis.sentiment,
        agentOutcome: analysis.agentOutcome,
        qualityScore: analysis.qualityScore,
        qualityAnalysis: {
          summary: analysis.summary,
          strengths: analysis.strengths,
          improvements: analysis.improvements,
          keyMoments: analysis.keyMoments,
          patientConcerns: analysis.patientConcerns,
        },
        gradedAt: new Date(),
      });

      console.info(`[GRADING] Call ${callLogId} graded: ${analysis.sentiment}, ${analysis.qualityScore}/5 stars, ${analysis.agentOutcome}`);

      return analysis;
    } catch (error) {
      console.error(`[GRADING] Error grading call ${callLogId}:`, error);
      return null;
    }
  }

  static readonly CURRENT_GRADER_VERSION = 2;

  async runAndPersistDeterministicGraders(callLogId: string, forceRegrade: boolean = false): Promise<GraderResult[]> {
    try {
      const callLog = await storage.getCallLog(callLogId);
      if (!callLog) {
        console.warn(`[GRADING] Call log not found for deterministic grading: ${callLogId}`);
        return [];
      }

      if (!forceRegrade && (callLog as any).graderVersion >= CallGradingService.CURRENT_GRADER_VERSION) {
        console.info(`[GRADING] Skipping ${callLogId}: already graded at version ${(callLog as any).graderVersion} (current: ${CallGradingService.CURRENT_GRADER_VERSION})`);
        return (callLog as any).graderResults?.graders || [];
      }

      const input: DeterministicGraderInput = {
        callLogId,
        transcript: callLog.transcript || '',
        transferredToHuman: callLog.transferredToHuman || false,
        ticketNumber: callLog.ticketNumber || null,
        agentSlug: callLog.agentUsed || null,
        totalTurns: callLog.totalTurns ?? null,
        interruptionCount: callLog.interruptionCount ?? null,
        truncationCount: callLog.truncationCount ?? null,
        toolCallCount: callLog.toolCallCount ?? null,
        durationSeconds: callLog.duration ?? null,
        firstTranscriptDelayMs: callLog.firstTranscriptDelayMs ?? null,
        postTranscriptTailMs: callLog.postTranscriptTailMs ?? null,
        localDurationSeconds: callLog.localDurationSeconds ?? null,
        transcriptWindowSeconds: callLog.transcriptWindowSeconds ?? null,
        durationMismatchRatio: callLog.durationMismatchRatio ?? null,
        durationMismatchFlag: callLog.durationMismatchFlag ?? null,
      };

      const results = this.runDeterministicGraders(input);

      const passed = results.filter(r => r.pass).length;
      const failed = results.filter(r => !r.pass).length;
      const criticalFailures = results.filter(r => !r.pass && r.severity === 'critical').length;
      const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

      const graderPayload = {
        graders: results,
        summary: { passed, failed, criticalFailures, total: results.length, avgScore: Math.round(avgScore * 100) / 100 },
        gradedAt: new Date().toISOString(),
      };

      await storage.updateCallLog(callLogId, {
        graderResults: redactGraderResults(graderPayload),
        graderVersion: CallGradingService.CURRENT_GRADER_VERSION,
      } as any);

      if (criticalFailures > 0) {
        const criticalGraders = results.filter(r => !r.pass && r.severity === 'critical').map(r => r.grader);
        console.error(`[GRADING] ⚠️ CRITICAL FAILURES for ${callLogId}: ${criticalGraders.join(', ')}`);
      }
      console.info(`[GRADING] Deterministic graders for ${callLogId}: ${passed}/${results.length} passed, ${criticalFailures} critical, avg=${avgScore.toFixed(2)}`);

      return results;
    } catch (error) {
      console.error(`[GRADING] Error in deterministic grading for ${callLogId}:`, error);
      return [];
    }
  }

  async gradeCallsWithoutGrades(limit: number = 10): Promise<number> {
    try {
      const ungradedCalls = await storage.getCallLogsWithoutGrades(limit);
      let gradedCount = 0;

      for (const call of ungradedCalls) {
        if (call.transcript) {
          const result = await this.gradeCall(call.id, call.transcript);
          if (result) {
            gradedCount++;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.info(`[GRADING] Graded ${gradedCount}/${ungradedCalls.length} calls`);
      return gradedCount;
    } catch (error) {
      console.error('[GRADING] Error in batch grading:', error);
      return 0;
    }
  }
}

export const callGradingService = new CallGradingService();
