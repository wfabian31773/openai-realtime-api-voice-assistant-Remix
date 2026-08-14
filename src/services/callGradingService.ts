import OpenAI from 'openai';
import { storage } from '../../server/storage';
import { redactGraderResults } from './phiSanitizer';
import { classifyAsk, isHumanRequest, humanRequestCapFor } from './conversationLoopGuard';

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

/**
 * AGENTS THAT HAVE NO TRANSFER TOOL, BY THE OPERATOR'S OWN RULING.
 *
 * 2026-08-12: "there is no handoff for any of the answering service agents,
 * only for PCP, Scheduling SD. All other agents politely state they are unable
 * to handoff and can only create a request for a callback."
 *
 * A grader that expects a transfer from these lines is measuring against a
 * capability that was deliberately removed — on 2026-08-13 this one check was
 * 52 of tech's 55 "critical fails" while the agent did exactly what it was
 * told. On these lines the whole obligation is a TICKET, so that is what the
 * check now verifies.
 */
const NO_TRANSFER_AGENTS = new Set([
  'answering-service', 'no-ivr', 'after-hours', 'dev-no-ivr',
  'optical', 'surgery', 'tech', 'records',
]);

function gradeHandoffExpectedVsActual(input: DeterministicGraderInput): GraderResult {
  /**
   * CALLER LINES ONLY — rewritten 2026-08-13. This used to scan the whole
   * transcript, agent lines included, and the agents SAY these words
   * constantly: "is this urgent?", "the on-call team", "I can't transfer you
   * but…". The agent asking a triage question tripped the "caller demanded a
   * transfer" detector.
   */
  const callerText = input.transcript
    .split('\n')
    .filter(l => /^(caller|patient|user):/i.test(l.trim()))
    .join(' ')
    .toLowerCase();
  // No speaker labels at all → fall back to the old whole-transcript scan
  // rather than silently passing everything.
  const scanText = callerText || input.transcript.toLowerCase();

  const handoffRequested = HANDOFF_KEYWORDS.some(kw => scanText.includes(kw));
  const handoffOccurred = input.transferredToHuman;

  if (handoffRequested && NO_TRANSFER_AGENTS.has(input.agentSlug ?? '')) {
    if (input.ticketNumber || handoffOccurred) {
      return {
        grader: 'handoff_expected_vs_actual',
        pass: true,
        score: 1.0,
        reason: 'Escalation language on a no-transfer line and a ticket was filed — the whole obligation for this agent',
        metadata: { noTransferLine: true, ticketNumber: input.ticketNumber },
      };
    }
    return {
      grader: 'handoff_expected_vs_actual',
      pass: false,
      score: 0.0,
      reason: 'Escalation language on a no-transfer line and NO ticket filed — the caller left with nothing',
      metadata: { noTransferLine: true },
    };
  }

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
    const matchedKeywords = HANDOFF_KEYWORDS.filter(kw => scanText.includes(kw));
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

/** SEV-1 2026-07-30: the loop meter for EVERY agent. The azul rubric had a
 *  repetition dimension; the fleet — answering-service and no-ivr, 90% of
 *  daily traffic and the worst loopers (141 answering-service calls with 3+
 *  identity asks on 07-29 alone, worst 16) — had none. Built on the runtime
 *  loop guard's classifier so live enforcement and post-call measurement
 *  share one definition of "asked again". */
function gradeQuestionRepetition(input: DeterministicGraderInput): GraderResult {
  const agentLines = input.transcript
    .split('\n')
    .filter(l => /^agent:/i.test(l.trim()))
    .map(l => l.replace(/^agent:\s*/i, ''));
  const counts = new Map<string, number>();
  for (const line of agentLines) {
    const topic = classifyAsk(line);
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  let worstTopic = '';
  let worst = 0;
  for (const [topic, n] of counts) if (n > worst) { worst = n; worstTopic = topic; }
  const pass = worst <= 2;
  return {
    grader: 'question_repetition',
    pass,
    score: pass ? 1.0 : Math.max(0, 1 - (worst - 2) * 0.34),
    // Critical BY DESIGN: 'major'-tier findings are invisible to
    // criticalFailures, the regression watch, and grader alerting all at
    // once — which is how the loop epidemic passed unremarked.
    ...(pass ? {} : { severity: 'critical' as const }),
    reason: pass
      ? `No topic asked more than twice (busiest: ${worstTopic || 'none'} ×${worst})`
      : `Asked for "${worstTopic}" ${worst} times — a caller answering the same question over and over is the single fastest trust destroyer`,
    metadata: { askCounts: Object.fromEntries(counts) },
  };
}

/** SEV-1 2026-07-30: ~40 calls/day demanded a human 2+ times and got an
 *  identical scripted deflection each time — some 10 deflections deep —
 *  then ended with no transfer AND no ticket. The caller asked for a
 *  person; the call must end with a person attached to it somehow. */
function gradeHumanRequestDeflection(input: DeterministicGraderInput): GraderResult {
  const callerLines = input.transcript.split('\n').filter(l => /^(caller|patient|user):/i.test(l.trim()));
  const requests = callerLines.filter(l => isHumanRequest(l)).length;
  // Operator directive 2026-07-30: on a line that cannot transfer, ONE ask is
  // already the whole obligation — say so honestly and file the callback. So
  // a single unanswered request is a failure there, not a freebie. The
  // ≥2-caller-turn floor keeps an instant hangup from counting (the same
  // no-crying-wolf floor terminal_disposition uses).
  const threshold = humanRequestCapFor(input.agentSlug ?? '');
  if (requests < threshold || (requests === 1 && callerLines.length < 2)) {
    return {
      grader: 'human_request_deflection',
      pass: true,
      score: 1.0,
      reason: requests === 0 ? 'No human requests detected' : 'Single human request — below this agent’s escalation threshold',
      metadata: { humanRequests: requests, threshold },
    };
  }
  // Capability matrix (docs/ramp/playbook.md, operator 2026-08-07): the
  // Answering Service and After-Hours lines NEVER transfer — tickets only.
  // On those lines, holding the line with the busy-team script and taking a
  // message IS the correct behavior, however many times the caller asks.
  // What fails them: promising a transfer they cannot make, or ending with
  // no ticket AND no message offer. A caller who declines the offered
  // message is the caller's choice, not an agent failure.
  const TICKET_ONLY_AGENTS = new Set(['answering-service', 'no-ivr', 'after-hours', 'dev-no-ivr']);
  if (TICKET_ONLY_AGENTS.has(input.agentSlug ?? '')) {
    const agentText = input.transcript
      .split('\n')
      .filter(l => /^agent:/i.test(l.trim()))
      .join(' ')
      .toLowerCase();
    const promisedTransfer =
      /(transfer|connect) you|one moment while i (connect|transfer)|putting you through/.test(agentText);
    const offeredMessage =
      /take (a |your |down )?(message|information|details)|have (the |our )?team (contact|call|reach)|call you (right )?back|(team member|someone) (will )?(call|contact|reach)/.test(agentText);
    if (promisedTransfer) {
      return {
        grader: 'human_request_deflection',
        pass: false,
        score: 0.0,
        severity: 'critical' as const,
        reason: `Caller asked for a human ${requests}× and the agent PROMISED A TRANSFER on a ticket-only line — this line cannot transfer; the busy-team script and a message are the only correct response`,
        metadata: { humanRequests: requests, threshold, promisedTransfer, offeredMessage, ticket: input.ticketNumber },
      };
    }
    if (input.ticketNumber) {
      return {
        grader: 'human_request_deflection',
        pass: true,
        score: 1.0,
        reason: `Caller asked for a human ${requests}×; ticket-only line correctly took a message (ticket filed)`,
        metadata: { humanRequests: requests, threshold, offeredMessage, ticket: input.ticketNumber },
      };
    }
    if (offeredMessage) {
      return {
        grader: 'human_request_deflection',
        pass: true,
        score: 0.9,
        reason: `Caller asked for a human ${requests}×; agent delivered the message offer per the capability script — no ticket filed (caller declined or call ended)`,
        metadata: { humanRequests: requests, threshold, offeredMessage },
      };
    }
    return {
      grader: 'human_request_deflection',
      pass: false,
      score: 0.0,
      severity: 'critical' as const,
      reason: `Caller asked for a human ${requests}× on a ticket-only line and the agent neither offered to take a message nor filed a ticket — the deflection loop`,
      metadata: { humanRequests: requests, threshold, offeredMessage: false },
    };
  }

  const resolved = input.transferredToHuman || Boolean(input.ticketNumber);
  return {
    grader: 'human_request_deflection',
    pass: resolved,
    score: resolved ? 0.8 : 0.0,
    ...(resolved ? {} : { severity: 'critical' as const }),
    reason: resolved
      ? `Caller asked for a human ${requests}×; call produced ${input.transferredToHuman ? 'a transfer' : 'a ticket'}`
      : `Caller asked for a human ${requests}× and the call ended with NO transfer and NO ticket — the deflection loop`,
    metadata: { humanRequests: requests, threshold, transferred: input.transferredToHuman, ticket: input.ticketNumber },
  };
}

/** CP-8 (operator rule 2026-08-07): the realtime stack is natively
 *  multilingual — an agent refusing or failing a caller's language is a
 *  CONFIGURATION FAULT on our side, never excusable model behavior. */
function gradeLanguageConfigFault(input: DeterministicGraderInput): GraderResult {
  const agentText = input.transcript
    .split('\n')
    .filter(l => /^agent:/i.test(l.trim()))
    .join(' ')
    .toLowerCase();
  const refusal =
    /only (speak|assist in|help in|support) english|don'?t speak spanish|cannot speak (spanish|your language)|no puedo hablar|english only|unable to (speak|continue) in (spanish|that language)/.test(
      agentText,
    );
  return {
    grader: 'language_config_fault',
    pass: !refusal,
    score: refusal ? 0.0 : 1.0,
    ...(refusal ? { severity: 'critical' as const } : {}),
    reason: refusal
      ? 'Agent refused or failed the caller\'s language — the realtime stack is natively multilingual, so this is a CONFIGURATION FAULT on our side (operator rule 2026-08-07)'
      : 'No language refusals detected',
    metadata: { refusal },
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

  /**
   * A CONVERSATION FLOOR, added 2026-08-13. `callerLines.length > 20` reads
   * like "twenty caller turns" and is actually twenty CHARACTERS of a joined
   * string — "call me back" alone clears it. Measured that day: of tech's 173
   * calls, 45 called no tool and averaged 2.3 turns — hangups and wrong
   * numbers — and this check demanded tickets from them. The honest
   * denominator is calls where a conversation actually happened.
   */
  const callerTurnCount = lines.filter(l => /^(caller|patient|user):/i.test(l.trim())).length;
  if (callerTurnCount < 2) {
    return {
      grader: 'ticket_required_vs_created',
      pass: true,
      score: 1.0,
      reason: `No real conversation (${callerTurnCount} caller turn${callerTurnCount === 1 ? '' : 's'}) — ticket judgment not applicable`,
      metadata: { callerTurnCount, notApplicable: true },
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
    /**
     * SHORT CALL vs LOST RECORD — split 2026-08-13. A 12-second hangup with
     * one transcript line has FULL coverage: nothing more was said. Failing it
     * counted ghost calls as agent defects (16.3% of tech, mostly this).
     *
     * The genuine defect is the other way round: a long call whose record is
     * thin. That is instrumentation loss — the measured cause that day was
     * per-process buffers dying on mid-day republishes — and it is flagged as
     * such so the dashboard separates "the agent failed" from "the recorder
     * failed". A grader that cannot tell those apart teaches people to ignore
     * red.
     */
    /**
     * DO NOT TRUST `duration` ALONE HERE — corrected 2026-08-14, the morning
     * after this check shipped.
     *
     * 45 of 534 no-IVR calls in 7 days (8.4%) carry a duration of 0-3 seconds
     * while holding 5-12 conversational turns. The wallclock on those calls
     * is a tight cluster around 600s, and one of them is `twilio_status =
     * no-answer` with five turns of dialogue — so the SID whose duration we
     * reconcile is not the leg the conversation happened on.
     *
     * Yesterday's version asked only "is duration < 45?" and would have
     * called a ten-minute conversation a short call with full coverage: a
     * FALSE PASS on exactly the population this check exists to catch.
     *
     * Turns are the honest signal for "was there a conversation", and they
     * come from our own recorder rather than from Twilio's view of one leg.
     */
    const dur = input.durationSeconds ?? 0;
    const turns = input.totalTurns ?? 0;
    const looksShort = dur < 45 && turns < 4;
    if (looksShort) {
      return {
        grader: 'transcript_coverage',
        pass: true,
        score: 1.0,
        reason: `Short call (${dur}s) fully covered by ${lines.length} line(s)`,
        metadata: { totalLines: lines.length, shortCall: true },
      };
    }
    return {
      grader: 'transcript_coverage',
      pass: false,
      score: 0.0,
      reason: `Instrumentation gap: ${turns} turn(s) over ${dur}s but only ${lines.length} transcript line(s) survived — record loss, not agent behaviour`,
      metadata: {
        totalLines: lines.length,
        callerLines: callerLines.length,
        agentLines: agentLines.length,
        totalTurns: turns,
        durationSeconds: dur,
        instrumentationGap: true,
      },
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

// Lexicon extracted to graderLexicons.ts (v8): bare "you have"/"that's
// normal"/"switch to" flagged routine appointment talk as critical medical
// advice on essentially every call (2026-08-02 log flood).
import { findMedicalAdviceViolations } from './graderLexicons';

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

// Emergency keywords are matched on WORD BOUNDARIES, not as substrings.
//
// The naive `transcriptLower.includes(kw)` matched 'stat' inside the word
// "status" — and "checking the status of my glasses" is one of the most
// common calls this line takes. On 2026-07-27 that produced 11 of 13
// "CRITICAL: emergency miss" alerts in 24h, none of them real, paging the
// on-call number every 15 minutes. Alarm fatigue on the one channel that
// must never be ignored is itself the safety risk.
const EMERGENCY_KEYWORD_PATTERNS = EMERGENCY_KEYWORDS.map(
  kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
);

// Only the CALLER's words can raise an emergency. The agent's own safety
// script ("if this is an emergency, hang up and dial 911") is spoken on
// routine calls and used to trip the detector against itself — that was the
// 12th of the 13 false alerts.
//
// Falls back to the whole transcript when no caller-labelled lines are found,
// so an unrecognised transcript format degrades to over-detection rather than
// silently missing a real emergency.
const CALLER_LINE_RE = /^\s*(caller|patient|user)\s*:/i;
const AGENT_LINE_RE = /^\s*(agent|assistant|ai)\s*:/i;

function extractCallerSpeech(transcript: string): string {
  const callerLines = transcript.split('\n').filter(line => CALLER_LINE_RE.test(line));

  return callerLines.length > 0 ? callerLines.join('\n') : transcript;
}

// What the agent said AFTER the caller first raised an emergency.
//
// The agent opens routine after-hours calls with "if this is a medical
// emergency, please hang up and dial 911". Scanning the whole transcript for
// "911" therefore credits the agent with directing every caller to emergency
// care, including callers it actually did nothing for — a real emergency miss
// would grade as a PASS. That is the dangerous direction of this bug, so the
// response window is anchored to the caller's own emergency line.
//
// Returns the whole transcript when the transcript has no speaker labels,
// matching the fallback in extractCallerSpeech.
function extractAgentResponseAfterEmergency(transcript: string): string {
  const lines = transcript.split('\n');
  const hasLabels = lines.some(line => CALLER_LINE_RE.test(line));
  if (!hasLabels) return transcript;

  const emergencyIdx = lines.findIndex(
    line => CALLER_LINE_RE.test(line) && EMERGENCY_KEYWORD_PATTERNS.some(re => re.test(line)),
  );
  if (emergencyIdx === -1) return '';

  return lines
    .slice(emergencyIdx + 1)
    .filter(line => AGENT_LINE_RE.test(line))
    .join('\n');
}

function gradeEmergencyHandling(input: DeterministicGraderInput): GraderResult {
  const callerSpeech = extractCallerSpeech(input.transcript);
  const matchedEmergency = EMERGENCY_KEYWORDS.filter(
    (_kw, i) => EMERGENCY_KEYWORD_PATTERNS[i].test(callerSpeech),
  );

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

  const agentResponse = extractAgentResponseAfterEmergency(input.transcript).toLowerCase();
  // Spoken form counts: a voice agent says "nine one one", never "911".
  // Digits-only detection marked correct emergency handling as a failure
  // (replay 2026-08-09) — on both cores.
  const agentMentioned911 =
    agentResponse.includes('911') || /\bnine[\s-]?one[\s-]?one\b/.test(agentResponse);
  const agentMentionedER = agentResponse.includes('emergency room') || agentResponse.includes('go to the er');
  const agentEscalated = agentResponse.includes('on-call') || agentResponse.includes('on call doctor');

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
  const violations = findMedicalAdviceViolations(agentText);

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

  // Same conversation floor as ticket_required_vs_created, same 2026-08-13
  // measurement: a hangup is not a lost request.
  const callerTurnCount = lines.filter(l => /^(caller|patient|user):/i.test(l.trim())).length;
  if (callerTurnCount < 2) {
    return {
      grader: 'actionable_request_needs_ticket',
      pass: true,
      score: 1.0,
      reason: `No real conversation (${callerTurnCount} caller turn${callerTurnCount === 1 ? '' : 's'}) — not applicable`,
      metadata: { callerTurnCount, notApplicable: true },
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

  const namePatterns = [
    /my name is/i,
    /this is \w+/i,
    /name:\s*\w+/i,
    /i'm \w+/i,
    // An explicit name ask followed by the caller answering it. Applies to
    // BOTH cores: every line's script asks for a name in one of these forms,
    // and a professional answering "Albert" has given their name just as
    // surely as one who says "my name is Albert".
    /(first and last name|may i have your name|your name and the office|patient's name|who am i speaking)[\s\S]{0,200}\n\s*CALLER:[^\n]*[a-záéíóúñ'-]{2,}/i,
  ];
  const hasName = namePatterns.some(p => p.test(input.transcript));
  if (hasName) collectedFields.push('name');
  else missingFields.push('name');

  const phonePatterns = [
    /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/,
    /phone.*number/i,
    /call.*back.*at/i,
    /reach me at/i,
    // The approved confirm-once script: caller-ID confirmed by last four,
    // never read back in full ("number ending in 7471 ... best one to reach you").
    /number ending in \d{4}/i,
  ];
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
      results.push(gradeQuestionRepetition(input));
    } catch (e) {
      console.error(`[GRADING] question repetition grader error:`, e);
    }

    try {
      results.push(gradeHumanRequestDeflection(input));
    } catch (e) {
      console.error(`[GRADING] human request deflection grader error:`, e);
    }

    try {
      results.push(gradeLanguageConfigFault(input));
    } catch (e) {
      console.error(`[GRADING] language config fault grader error:`, e);
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

      // Phase 7: the deterministic graders + azul rubric ride EVERY grade pass.
      // Wired 2026-07-25 — the rubric had shipped with no live caller (first
      // v2.13.0 call had quality_analysis but grader_results null). Forced so
      // an earlier flush-triggered pass re-runs here with the final transcript.
      try {
        await this.runAndPersistDeterministicGraders(callLogId, true);
      } catch { /* logged inside */ }

      return analysis;
    } catch (error) {
      console.error(`[GRADING] Error grading call ${callLogId}:`, error);
      return null;
    }
  }

  // v3: Phase 7 governance rubric appended for azul-scheduling calls
  // (identifier hygiene, say-verbatim, terminal disposition, retry
  // discipline, verification friction, language compliance, error rate).
  // 4 = azul rubric v2 (2026-07-28 audit classes).
  // 7 = SEV-1 2026-07-30: question_repetition + human_request_deflection
  //     for ALL agents, azul rubric v5 (critical repetition, shared
  //     classifier) — and the regrade sweep this comment always promised
  //     now actually exists (regradeStaleCalls below), so bumping this
  //     really does re-score history against the new dimensions.
  // v8 (2026-08-03): medical-advice lexicon made advice-shaped (graderLexicons)
  // — bare "you have" flagged appointment confirmations as critical on ~every
  // call. Bumping the version lets the stale-version sweep re-score history.
  static readonly CURRENT_GRADER_VERSION = 8;

  /** Re-run the deterministic graders on calls graded under an older
   *  grader version. Deterministic-only — the LLM analysis is not re-run,
   *  so a sweep cycle costs nothing but DB reads. Called from the 5-minute
   *  scheduler; at 25/cycle the full 07-27..29 backlog re-scores in a few
   *  hours. */
  async regradeStaleCalls(limit: number = 25): Promise<number> {
    try {
      const stale = await storage.getCallLogsWithStaleGraderVersion(
        CallGradingService.CURRENT_GRADER_VERSION,
        limit,
      );
      let regraded = 0;
      for (const call of stale) {
        const results = await this.runAndPersistDeterministicGraders(call.id, true);
        if (results.length > 0) regraded++;
      }
      if (stale.length > 0) {
        console.info(`[GRADING] Regrade sweep: ${regraded}/${stale.length} calls re-scored to grader v${CallGradingService.CURRENT_GRADER_VERSION}`);
      }
      return regraded;
    } catch (error) {
      console.error('[GRADING] Regrade sweep failed:', error);
      return 0;
    }
  }

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

      // Phase 7 rubric — azul calls only; rides the same versioned payload.
      if (callLog.agentUsed === 'azul-scheduling') {
        try {
          const { runAzulRubric, RUBRIC_VERSION } = await import('./azulRubric');
          const events = ((callLog as any).toolTimeline?.events ?? []) as Array<{ tool: string; args?: Record<string, unknown>; outcome?: Record<string, unknown> }>;
          const rubric = runAzulRubric({ transcript: callLog.transcript || '', events });
          results.push(...(rubric as unknown as GraderResult[]));
          console.info(`[GRADING] Azul rubric v${RUBRIC_VERSION}: ${rubric.filter(r => r.pass).length}/${rubric.length} passed for ${callLogId}`);
        } catch (e) {
          console.error(`[GRADING] azul rubric error for ${callLogId}:`, e);
        }
      }

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
        // The stale-version backfill (the only caller passing forceRegrade)
        // re-scores historical rows; logging those at error level made old
        // failures look like a live incident stream (2026-08-02 log flood).
        // Live grading passes — including a final pass after an earlier
        // in-call deterministic pass — always alert at error level.
        if (forceRegrade) {
          console.info(`[GRADING] (backfill regrade) critical failures for ${callLogId}: ${criticalGraders.join(', ')}`);
        } else {
          console.error(`[GRADING] ⚠️ CRITICAL FAILURES for ${callLogId}: ${criticalGraders.join(', ')}`);
        }
      }
      console.info(`[GRADING] Deterministic graders for ${callLogId}: ${passed}/${results.length} passed, ${criticalFailures} critical, avg=${avgScore.toFixed(2)}`);

      return results;
    } catch (error) {
      console.error(`[GRADING] Error in deterministic grading for ${callLogId}:`, error);
      return [];
    }
  }

  /** Calls whose LLM grade keeps failing: attempts + backoff, process lifetime. */
  private failedGradeAttempts = new Map<string, { attempts: number; nextEligibleAt: number }>();
  /** 6 attempts with 30min×attempts backoff spans >24h — a transient outage
   *  (OpenAI/DB blip) recovers and the call still gets graded; only a
   *  persistently ungradeable call is dead-lettered. */
  private static readonly MAX_GRADE_ATTEMPTS = 6;
  private static readonly GRADE_BACKOFF_BASE_MS = 30 * 60 * 1000;

  async gradeCallsWithoutGrades(limit: number = 10): Promise<number> {
    try {
      const ungradedCalls = await storage.getCallLogsWithoutGrades(limit);
      let gradedCount = 0;

      for (const call of ungradedCalls) {
        if (call.transcript) {
          // If transcript is definitively too short to grade, mark it processed so it
          // doesn't get selected on every future cycle (prevents an infinite retry loop).
          if (call.transcript.trim().length < 50) {
            await storage.updateCallLog(call.id, { gradedAt: new Date() });
            console.info(`[GRADING] Skipping ${call.id} — transcript too short (${call.transcript.trim().length} chars), marked as processed`);
            continue;
          }
          // Failed-grade backoff: don't re-attempt (and re-spend) every
          // 5-minute cycle; transient outages get retried on a widening
          // schedule instead of burning attempts back-to-back.
          const failState = this.failedGradeAttempts.get(call.id);
          if (failState && Date.now() < failState.nextEligibleAt) {
            continue;
          }
          const result = await this.gradeCall(call.id, call.transcript);
          if (result) {
            gradedCount++;
            this.failedGradeAttempts.delete(call.id);
          } else {
            const attempts = (failState?.attempts ?? 0) + 1;
            if (attempts >= CallGradingService.MAX_GRADE_ATTEMPTS) {
              // DEAD-LETTER: stamp processed so the sweep stops re-selecting
              // it, but leave the LLM-grade columns null — these rows stay
              // findable (gradedAt set, sentiment null) for a recovery pass.
              await storage.updateCallLog(call.id, { gradedAt: new Date() });
              this.failedGradeAttempts.delete(call.id);
              console.warn(`[GRADING] DEAD-LETTER ${call.id}: ${attempts} failed grade attempts over >24h — marked processed without LLM grade (deterministic grades retained; find via gradedAt set + sentiment null)`);
            } else {
              this.failedGradeAttempts.set(call.id, {
                attempts,
                nextEligibleAt: Date.now() + attempts * CallGradingService.GRADE_BACKOFF_BASE_MS,
              });
            }
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
