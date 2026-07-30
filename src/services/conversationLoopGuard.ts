/**
 * Conversation Loop Guard — server-side re-ask cap and escalation trigger.
 *
 * SEV-1 2026-07-30. On 07-28 and 07-29 alike, ~180 calls/day asked the
 * caller for identity 3+ times (34/day hit 5+, worst 16), and ~40 calls/day
 * met an explicit "representative" demand with the same scripted deflection
 * up to 10 times. Every anti-loop rule in the system was prompt prose, and
 * the rubric header already named the lesson: a prompt rule with no
 * enforcement is a hope.
 *
 * This is the enforcement. The server watches the live transcript stream
 * (the same events that build call_logs.transcript), keeps the per-call
 * asked-topic ledger the model doesn't have, and when a threshold trips it
 * injects a SYSTEM message into the Realtime conversation telling the agent
 * to stop re-asking and take a real exit. The voice layer stays the ears
 * and the mouth; this is the brain remembering what was already asked.
 *
 * Pure classification lives here too so the post-call graders count loops
 * with exactly the same eyes the runtime guard uses — one definition of
 * "asked again", live and post-mortem.
 */

/** Topics an agent asks callers about. A line is bucketed by the FIRST
 *  topic it matches; unmatched lines are not counted, so the guard
 *  under-reports rather than inventing loops. Superset of the azul
 *  rubric's original QUESTION_TOPICS. */
export const ASK_TOPICS: Array<[string, RegExp]> = [
  ['date of birth', /\b(date of birth|birth ?date|d\.?o\.?b\.?|when were you born|month.{0,20}day.{0,20}year)\b/i],
  // 'full name' before the single-name topics: "first and last name" must
  // bucket consistently as one topic, not whichever fragment matches first.
  ['full name', /\b(your name|first and last name|may i (?:have|get) your name|full name|who am i speaking)\b/i],
  ['last name', /\b(last name|surname|family name|spell.*last)\b/i],
  ['first name', /\b(first name|given name)\b/i],
  ['phone number', /\b(phone number|cell(?: number| phone)?|best number|callback number|number to reach)\b/i],
  ['insurance', /\b(insurance|health plan|carrier|coverage|member id|policy)\b/i],
  ['location', /\b(which (?:office|location)|encinitas or|closer to you|which one works)\b/i],
  ['provider', /\b(which doctor|see a specific|preferred (?:doctor|provider)|particular doctor|doctor'?s name|name of (?:your|the) (?:doctor|surgeon|provider))\b/i],
  ['time preference', /\b(morning or afternoon|what time|time of day|preferred time|day works)\b/i],
  ['reason for visit', /\b(reason for (?:your )?(?:visit|call)|what brings you|what.*appointment for|type of appointment|tell me a bit more about what you need|what you need (?:help|assistance) with)\b/i],
  ['existing patient', /\b(been (?:here|seen) before|existing patient|new patient|seen (?:you|us) before|first time)\b/i],
];

/** Ask-intent: the line is REQUESTING the topic, not merely mentioning it
 *  ("I have your name and date of birth" must not count). Statement-form
 *  asks count too — "I'll need your name and date of birth." was the exact
 *  shape the old '?'-only rubric counter could never see. */
const ASK_INTENT =
  /\b(could you|can you|may i|would you|what is|what'?s|please (?:share|provide|tell|give|confirm|spell)|i(?:'ll| will) need|i need (?:your|the)|i do need|let'?s start (?:by|with)|go ahead and (?:share|give|tell)|starting with the month|spell (?:out|your|that))\b/i;

export function classifyAsk(agentLine: string): string | null {
  if (!ASK_INTENT.test(agentLine) && !agentLine.includes('?')) return null;
  const topic = ASK_TOPICS.find(([, re]) => re.test(agentLine));
  return topic ? topic[0] : null;
}

/** Caller demands for a human. Scanned on CALLER lines only, so the
 *  agent's own "our agents are busy" greeting never counts. */
const HUMAN_REQUEST =
  /\b(representative|customer service|real person|live person|a human|an operator|the operator|receptionist|front desk|speak (?:to|with) (?:a|an|someone|somebody)|talk (?:to|with) (?:a|an|someone|somebody)|transfer me|connect me|on.?call doctor|representante|una persona|con alguien|servicio al cliente)\b/i;

export function isHumanRequest(callerLine: string): boolean {
  return HUMAN_REQUEST.test(callerLine);
}

export interface LoopGuardDirective {
  kind: 'reask_cap' | 'reask_hard_stop' | 'human_request';
  topic?: string;
  text: string;
}

export interface LoopGuardStats {
  asksByTopic: Record<string, number>;
  agentLines: number;
  callerLines: number;
  humanRequests: number;
  /** caller barge-ins (conversation.item.truncated) */
  truncations: number;
  interventions: string[];
}

interface CallLoopState {
  asks: Map<string, number>;
  agentLines: number;
  callerLines: number;
  humanRequests: number;
  truncations: number;
  /** intervention keys already sent, so each fires at most once per call */
  sent: Set<string>;
  interventions: string[];
  /** double-capture guard: the transport emits agent speech on two event
   *  types, so the same response can arrive twice verbatim with no caller
   *  line between. A REAL re-ask always has caller audio in between. */
  lastAgentLine: string | null;
  callerSpokeSinceAgent: boolean;
  /** set by the first teardown to flush telemetry; later paths no-op */
  flushed: boolean;
}

/** Same-topic ask count that triggers the first intervention. Calibrated
 *  against 07-29 production: the legitimate ceiling is 2 (ask + one
 *  corrected-spelling retry); 3 is the loop callers hang up inside. */
export const REASK_SOFT_CAP = 3;
/** Ask count for the unconditional stop. On 07-29 the worst call hit 16. */
export const REASK_HARD_CAP = 5;
/** Human requests before the escalation directive. On an agent that CAN
 *  transfer, the first request may be an aside and the second is a decision.
 *  On an agent that cannot transfer at all, waiting for a second ask is the
 *  bug: the caller is asking for the one thing the agent can never provide,
 *  so the honest answer — "I can't connect calls, I can have someone call
 *  you back" — is owed on the FIRST ask. A vague "I'll get this to the right
 *  team" is what made callers ask up to ten times on 07-29. */
export const HUMAN_REQUEST_CAP = 2;
export const HUMAN_REQUEST_CAP_NO_TRANSFER = 1;

/** Agents with no handoff/transfer capability of any kind. */
const NO_TRANSFER_AGENTS = new Set(['answering-service']);

export function humanRequestCapFor(agentSlug: string): number {
  return NO_TRANSFER_AGENTS.has(agentSlug) ? HUMAN_REQUEST_CAP_NO_TRANSFER : HUMAN_REQUEST_CAP;
}

const AGENT_EXIT: Record<string, string> = {
  'azul-scheduling':
    'If identity was already verified this call, act on the request NOW (for a human: sage_handoff immediately — the server remembers who was verified; do NOT re-ask name or date of birth). If the caller refuses to identify, call sage_handoff with the refusal noted in patientResponse — it routes without identity.',
  default:
    'Create the ticket NOW with whatever you have — the caller’s phone number is attached automatically from caller ID, and missing fields may stay blank. A partial ticket the team can call back on beats a complete interview the caller never finishes.',
};

/** What to say to a caller asking for a human on an agent that cannot
 *  transfer: name the limitation, offer the real alternative, then act. */
const NO_TRANSFER_HUMAN_DIRECTIVE =
  'SERVER STATE CHECK: The caller has asked to reach a person, and you CANNOT transfer calls — there is no handoff on this line. Tell them so NOW, plainly, in your own words: you are not able to connect them to someone, what you CAN do is put in a request and have a team member call them back. Do not say anyone will "be right with them" — nobody is coming to this call. Do not repeat a vague reassurance, and do not make them ask twice. Then take only what you still need and file the ticket with "CALLER REQUESTED A HUMAN" at the start of the description.';

function exitFor(agentSlug: string): string {
  return AGENT_EXIT[agentSlug] ?? AGENT_EXIT.default;
}

class ConversationLoopGuard {
  private calls = new Map<string, CallLoopState>();
  /** alias (dbCallLogId, twilioCallSid) → the OpenAI callId that keys `calls`.
   *  A call can be finalized by either observeCall's teardown (which holds the
   *  OpenAI callId) or the lifecycle coordinator's 'call-ended' handler (which
   *  holds only callLogId/twilioCallSid). On 2026-07-30 the coordinator won on
   *  4 of 5 test calls, so the turn telemetry never landed — same reason
   *  flushAzulTimeline is called with both keys. */
  private aliases = new Map<string, string>();

  /** Point an alternate id at this call's state, so whichever teardown path
   *  wins can still flush the stats. Safe to call repeatedly. */
  registerAlias(callId: string, alias?: string | null): void {
    if (alias && alias !== callId) this.aliases.set(alias, callId);
  }

  private resolve(key: string): string | undefined {
    if (this.calls.has(key)) return key;
    const target = this.aliases.get(key);
    return target && this.calls.has(target) ? target : undefined;
  }

  private state(callId: string): CallLoopState {
    let s = this.calls.get(callId);
    if (!s) {
      s = {
        asks: new Map(), agentLines: 0, callerLines: 0, humanRequests: 0, truncations: 0,
        sent: new Set(), interventions: [], lastAgentLine: null, callerSpokeSinceAgent: true,
        flushed: false,
      };
      this.calls.set(callId, s);
    }
    return s;
  }

  onAgentLine(callId: string, agentSlug: string, line: string): LoopGuardDirective | null {
    const s = this.state(callId);
    if (line === s.lastAgentLine && !s.callerSpokeSinceAgent) return null; // duplicate capture of the same response
    s.lastAgentLine = line;
    s.callerSpokeSinceAgent = false;
    s.agentLines += 1;
    const topic = classifyAsk(line);
    if (!topic) return null;
    const n = (s.asks.get(topic) ?? 0) + 1;
    s.asks.set(topic, n);

    if (n >= REASK_HARD_CAP && !s.sent.has(`hard:${topic}`)) {
      s.sent.add(`hard:${topic}`);
      s.interventions.push(`hard:${topic}`);
      return {
        kind: 'reask_hard_stop',
        topic,
        text:
          `SERVER STATE CHECK: You have now asked for the caller's ${topic} ${n} times this call. STOP. ` +
          `Never ask for it again on this call, in any wording. Whatever you have is what you have. ` +
          exitFor(agentSlug) +
          ' Acknowledge the caller in fresh words — do not repeat any sentence you have already said.',
      };
    }
    if (n >= REASK_SOFT_CAP && !s.sent.has(`soft:${topic}`)) {
      s.sent.add(`soft:${topic}`);
      s.interventions.push(`soft:${topic}`);
      return {
        kind: 'reask_cap',
        topic,
        text:
          `SERVER STATE CHECK: You have now asked for the caller's ${topic} ${n} times this call. Do not ask again. ` +
          `Re-read the conversation: if the caller already gave it — even imperfectly — USE their answer and confirm it once instead of re-asking. ` +
          `If they refused or cannot give it, the refusal IS their answer: move forward without it. ` +
          exitFor(agentSlug),
      };
    }
    return null;
  }

  /** Caller barge-in: the SDK truncated the in-flight agent response. Lives
   *  here rather than in a parallel map so it resolves through the same
   *  alias table the teardown paths use. */
  onTruncation(callId: string): void {
    this.state(callId).truncations += 1;
  }

  onCallerLine(callId: string, agentSlug: string, line: string): LoopGuardDirective | null {
    const s = this.state(callId);
    s.callerLines += 1;
    s.callerSpokeSinceAgent = true;
    if (!isHumanRequest(line)) return null;
    s.humanRequests += 1;
    const cap = humanRequestCapFor(agentSlug);
    if (s.humanRequests >= cap && !s.sent.has('human')) {
      s.sent.add('human');
      s.interventions.push('human');
      // No-transfer agents get the honest-limitation directive on the FIRST
      // ask; agents that can actually transfer get the escalation directive
      // on the second.
      if (cap === HUMAN_REQUEST_CAP_NO_TRANSFER) {
        return { kind: 'human_request', text: `${NO_TRANSFER_HUMAN_DIRECTIVE} ${exitFor(agentSlug)}` };
      }
      return {
        kind: 'human_request',
        text:
          `SERVER STATE CHECK: The caller has now asked for a human ${s.humanRequests} times. Honor it — stop collecting anything nonessential and stop repeating the same deflection script. ` +
          exitFor(agentSlug) +
          ' Tell the caller plainly, in fresh words, what will happen next.',
      };
    }
    return null;
  }

  /** Accepts the OpenAI callId or any registered alias. */
  getStats(key: string): LoopGuardStats | undefined {
    const callId = this.resolve(key);
    const s = callId ? this.calls.get(callId) : undefined;
    if (!s) return undefined;
    return {
      asksByTopic: Object.fromEntries(s.asks),
      agentLines: s.agentLines,
      callerLines: s.callerLines,
      humanRequests: s.humanRequests,
      truncations: s.truncations,
      interventions: [...s.interventions],
    };
  }

  /** Returns final stats ONCE and marks the call flushed, so whichever
   *  teardown path arrives first writes the telemetry and the loser is a
   *  no-op instead of overwriting or double-counting. State is retained
   *  until releaseCall() so a late reader still resolves. */
  endCall(key: string): LoopGuardStats | undefined {
    const callId = this.resolve(key);
    if (!callId) return undefined;
    const s = this.calls.get(callId)!;
    if (s.flushed) return undefined;
    s.flushed = true;
    return this.getStats(callId);
  }

  /** Frees per-call state and its aliases. Called from final cleanup, after
   *  every teardown path has had its chance to flush. */
  releaseCall(key: string): void {
    const callId = this.resolve(key) ?? key;
    this.calls.delete(callId);
    for (const [alias, target] of this.aliases) {
      if (target === callId || alias === callId) this.aliases.delete(alias);
    }
  }
}

export const conversationLoopGuard = new ConversationLoopGuard();
