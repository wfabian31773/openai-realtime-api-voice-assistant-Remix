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

import { canTransfer, filesTickets } from '../config/agentCapabilities';

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
/**
 * 2026-08-05: "Just put somebody on the phone that I can speak to." matched
 * NOTHING. The old alternatives all required the person-word to FOLLOW the verb
 * ("speak to someone"), so every phrasing that puts it first — which is how
 * frustrated callers actually say it — was invisible. That caller (4511a0a3) had
 * already endured six variations of "which office do you visit", asked for a
 * human in as many words, and the escalation path never saw it. Quality graded
 * 2/5, sentiment frustrated, outcome follow_up_needed.
 *
 * So: match the person-on-the-phone shape in both orders, and add the bare
 * "a person" / "put me through" forms.
 */
const HUMAN_REQUEST =
  /\b(representative|customer service|real person|live person|a human|a person|an operator|the operator|receptionist|front desk|speak (?:to|with) (?:a|an|someone|somebody)|talk (?:to|with) (?:a|an|someone|somebody)|(?:someone|somebody|anyone|anybody)\b[^.?!]{0,24}\b(?:i can (?:speak|talk)|on the (?:phone|line))|(?:put|get)\b[^.?!]{0,16}\b(?:someone|somebody|a human|a person)|put me through|transfer me|connect me|on.?call doctor|representante|una persona|con alguien|servicio al cliente|pasar con)\b/i;

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

/**
 * On a line that can never transfer, the honest answer — "I can't connect
 * calls, I can have someone call you back" — is owed on the FIRST ask, not the
 * second. A vague "I'll get this to the right team" is what made callers ask up
 * to ten times on 07-29.
 *
 * Asked of the capability registry rather than a local list. This module used
 * to keep its own `NO_TRANSFER_AGENTS = {answering-service}`, which is why
 * Tech, Surgery, Optical and Records callers had to ask twice before being told
 * the line cannot connect them.
 */
export function humanRequestCapFor(agentSlug: string): number {
  return canTransfer(agentSlug) ? HUMAN_REQUEST_CAP : HUMAN_REQUEST_CAP_NO_TRANSFER;
}

const AGENT_EXIT: Record<string, string> = {
  pcp:
    'This line CAN transfer. Call handoff_to_pcp NOW — do NOT ask another question first. If a reason field is required and the caller gave none, use "caller requests a representative" as the reason. Say only: "Of course — one moment while I connect you." Never promise a connection and then keep interviewing (live failure 2026-08-07: a caller asked three times and was still being asked the purpose of their call).',
  'azul-scheduling':
    'If identity was already verified this call, act on the request NOW (for a human: sage_handoff immediately — the server remembers who was verified; do NOT re-ask name or date of birth). If the caller refuses to identify, call sage_handoff with the refusal noted in patientResponse — it routes without identity.',
  default:
    'Create the ticket NOW with whatever you have — the caller’s phone number is attached automatically from caller ID, and missing fields may stay blank. A partial ticket the team can call back on beats a complete interview the caller never finishes.',
};

/**
 * What to do — NOT what to say — when a caller asks for a human on a line that
 * cannot transfer: name the limitation, offer the real alternative, then act.
 *
 * THIS DIRECTIVE MUST NEVER DICTATE A SENTENCE, and that is the whole point of
 * its current shape. Between 2026-08-17 and today it did, word-for-word:
 *
 *   "All of our agents are currently busy at the moment — I can take a message
 *    and have the team contact you as soon as they become available."
 *
 * Every no-transfer prompt rules its own wording for this moment, and this
 * directive outranked all of them — `answeringServiceAgent` says explicitly
 * "If a SERVER STATE CHECK system message appears mid-call... follow it
 * exactly". So it contradicted two live prompts at once:
 *
 *   - RECORDS (and optical, surgery, tech) forbid that exact sentence, on the
 *     operator's 2026-09-03 ruling: never imply a human is about to come free,
 *     no "currently busy", no "as soon as someone's available". The server was
 *     ordering the violation the prompt was written to prevent.
 *   - ANSWERING SERVICE's approved script opens "I'm not able to transfer you
 *     to someone — I'm not a person and I can't connect calls", while this
 *     directive said never to say you are "not a person".
 *
 * A ruling lives in the lane's prompt, where the operator can read and change
 * it. The guard's job is to force the honest answer to be given NOW and to
 * stop the loop — not to supply the words.
 */
/**
 * Derived per lane, because two facts differ between lanes and getting either
 * wrong is a promise the line cannot keep:
 *
 *   - WORDING. Most no-transfer lanes rule their own sentence for this moment.
 *     Some have none: `appointment-confirmation` has no human-request script,
 *     and an unregistered slug falls back to the conservative cannot-transfer
 *     default with no prompt behind it at all. Pointing those at "your own
 *     instructions" and stopping would leave the model improvising at exactly
 *     the guarded moment, so the directive names the SHAPE of the answer as a
 *     fallback — still not a sentence, so it cannot contradict a lane that
 *     does have a ruling.
 *   - WHETHER A MESSAGE CAN BE TAKEN AT ALL. `filesTickets` is false for
 *     `appointment-confirmation` — outbound confirmation calls, 60-90s, no
 *     ticket path. Telling it to take a message promises a callback nothing
 *     will create. An UNREGISTERED slug is a different case and deliberately
 *     not this one: `UNKNOWN_AGENT` sets `filesTickets: true`, because
 *     wrongly assuming a lane cannot take a message is the more harmful
 *     error of the two.
 */
/**
 * A CLOSED SET. Not strings — strings are prose, and prose is where a sentence
 * hides. `mustDo: ['Reply: I cannot connect calls']` typechecks against
 * `string[]` and passes every shape and phrase check ever written; against
 * this union it does not compile (Codex, PR #270).
 */
export type DirectiveAction =
  | "STATE_THE_LIMITATION_FIRST"
  | "USE_YOUR_OWN_WORDING"
  | "TAKE_THE_MESSAGE"
  | "REPEAT_THE_SAME_ANSWER_IF_ASKED_AGAIN";

export type DirectiveProhibition = "NEVER_PROMISE_A_PICKUP";

export type DirectiveSituation = "CALLER_ASKED_FOR_A_PERSON_ON_A_NO_TRANSFER_LINE";

export interface NoTransferDirectiveSpec {
  /** The server-side fact the agent must act on. A token, never a line. */
  readonly situation: DirectiveSituation;
  /** Behaviours, in order. Each is something to DO. */
  readonly mustDo: readonly DirectiveAction[];
  /** Prohibited ACTIONS. Never prohibited wording — that is the prompt's. */
  readonly mustNot: readonly DirectiveProhibition[];
}

/**
 * The ONLY place any of this becomes English. A new action means adding a
 * token above and its sentence here, which is a visible, reviewable edit in
 * one file — not a string typed at a call site.
 */
const SITUATION_TEXT: Record<DirectiveSituation, string> = {
  CALLER_ASKED_FOR_A_PERSON_ON_A_NO_TRANSFER_LINE:
    "The caller asked to reach a person, and this line CANNOT transfer calls.",
};

const ACTION_TEXT: Record<DirectiveAction, string> = {
  STATE_THE_LIMITATION_FIRST: "Tell them so NOW, before collecting anything else.",
  USE_YOUR_OWN_WORDING:
    "If your own instructions give you wording for this moment, use it; otherwise state plainly, in your own words, that you cannot connect calls.",
  TAKE_THE_MESSAGE: "Then take the message.",
  REPEAT_THE_SAME_ANSWER_IF_ASKED_AGAIN:
    "If they ask again, give that SAME answer rather than improvising a new one.",
};

const PROHIBITION_TEXT: Record<DirectiveProhibition, string> = {
  NEVER_PROMISE_A_PICKUP: "Never promise that anyone will pick up.",
};

/**
 * THE STRUCTURE IS THE GUARANTEE. There is no field here in which a sentence
 * for the agent to speak can be placed, so the server cannot dictate wording
 * without visibly abusing a field named for something else. A phrase blocklist
 * detects dictation after the fact and can always be worded around; this
 * removes the channel (Codex, PR #270).
 */
export function noTransferDirectiveSpec(agentSlug: string): NoTransferDirectiveSpec {
  return {
    situation: "CALLER_ASKED_FOR_A_PERSON_ON_A_NO_TRANSFER_LINE",
    mustDo: [
      "STATE_THE_LIMITATION_FIRST",
      "USE_YOUR_OWN_WORDING",
      ...(filesTickets(agentSlug) ? (["TAKE_THE_MESSAGE"] as const) : []),
      "REPEAT_THE_SAME_ANSWER_IF_ASKED_AGAIN",
    ],
    mustNot: ["NEVER_PROMISE_A_PICKUP"],
  };
}

/** Tokens in, English out. No caller supplies a word of it. */
export function renderDirective(spec: NoTransferDirectiveSpec): string {
  return [
    `SERVER STATE CHECK: ${SITUATION_TEXT[spec.situation]}`,
    ...spec.mustDo.map((a) => ACTION_TEXT[a]),
    ...spec.mustNot.map((p) => PROHIBITION_TEXT[p]),
  ].join(" ");
}

function exitFor(agentSlug: string): string {
  const explicit = AGENT_EXIT[agentSlug];
  if (explicit) return explicit;
  // The default exit ends in "Create the ticket NOW". On a lane that files no
  // tickets that is an instruction it cannot carry out, and it contradicts the
  // directive above, which for the same reason does not offer to take a
  // message. Say nothing rather than something false.
  return filesTickets(agentSlug) ? AGENT_EXIT.default : '';
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
        return {
          kind: 'human_request',
          text: `${renderDirective(noTransferDirectiveSpec(agentSlug))} ${exitFor(agentSlug)}`.trim(),
        };
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
