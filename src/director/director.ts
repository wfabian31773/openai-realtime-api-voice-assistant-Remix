/**
 * DIRECTOR — the reasoning layer takes the decisions; the realtime model keeps
 * the microphone.
 *
 * Why this exists (call afb1e688, 2026-08-03): the agent asked for the same
 * date of birth seven times, flip-flopping between May 10 and October 5,
 * re-proposing dates the caller had already rejected, then repeated "spell
 * your last name, letter by letter" verbatim three times. The caller swore at
 * it and hung up on a booking.
 *
 * The existing conversationLoopGuard DID fire its directive on the third ask.
 * The model ignored it and asked four more times. That is the whole thesis of
 * this module: a system message is a suggestion, and this model treats it as
 * one. Two things follow.
 *
 *   1. COUNTING ASKS IS NOT ENOUGH. The loop guard knows how many times a
 *      topic was asked; it does not know the caller ALREADY ANSWERED. A field
 *      the caller has given is closed — re-asking it is a defect on ask #2,
 *      not on ask #3. The director keeps the answer ledger the model doesn't.
 *
 *   2. ENFORCEMENT MUST ESCALATE PAST SUGGESTION. First violation injects a
 *      directive (cheap, usually enough). If the model violates the SAME topic
 *      again — proving it ignored us — the director authors the turn: cancel
 *      the response and dictate the exact words. Third time, it forces the
 *      exit.
 *
 * Deterministic and synchronous: no model call, no I/O, sub-millisecond, so it
 * runs inline at the turn boundary with no added caller latency. Everything is
 * wrapped so a director bug can never break a call — on any internal error it
 * returns null and the call proceeds exactly as it does today.
 */
import { ASK_TOPICS, classifyAsk } from '../services/conversationLoopGuard';
import { spokenDates } from '../services/identityArgGuard';

export type DirectorEnforcement = 'inject' | 'author' | 'force_exit';

export interface DirectorAction {
  /** How hard to push. 'author' and 'force_exit' take over the turn. */
  enforcement: DirectorEnforcement;
  /** Machine-readable reason, for telemetry and the shadow comparison. */
  code:
    | 'reask_answered_field'
    | 'repeat_after_directive'
    | 'bundled_questions'
    | 'readback_loop';
  topic: string;
  /** System-message text (all enforcement levels). */
  text: string;
  /** For 'author'/'force_exit': the exact sentence the agent must say. */
  speak?: string;
}

interface FieldAnswer {
  value: string;
  turn: number;
}

interface CallState {
  agentSlug: string;
  turn: number;
  /** Fields the caller has ANSWERED. The ledger the model lacks. */
  answered: Map<string, FieldAnswer>;
  /** Topic → number of times the agent has asked it. */
  asks: Map<string, number>;
  /** Topics we have already pushed back on, and how hard. */
  escalation: Map<string, number>;
  /** Distinct dates the caller has spoken, in order. */
  spokenDobs: string[];
  lastAgentLine: string;
  callerSpokeSinceAgent: boolean;
}

/**
 * Read-back and confirmation phrasings the production ask-classifier misses.
 *
 * The reason the loop guard under-counted afb1e688: "that's the fifth month,
 * the fifth day, 1983. Is that correct?" contains no phrase resembling "date
 * of birth", so classifyAsk returned null and two of the seven asks were never
 * counted at all. A confirmation IS an ask — it spends the caller's patience
 * exactly the same way.
 */
const READBACK_TOPICS: Array<[string, RegExp]> = [
  [
    'date of birth',
    // "the tenth month, the fifth day, 1983" / "October 5th, 1983, is that right"
    /\b(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+month|\d{1,2}(?:st|nd|rd|th)?\s+month)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{2,4}\b/i,
  ],
  ['last name', /\bspell(?:ing)?\b[^.?!]{0,40}\b(?:last name|surname|name)\b|\b(?:last name|surname)\b[^.?!]{0,30}\bspell/i],
];

const CONFIRM_INTENT =
  /\b(is that (?:correct|right)|did you mean|could you confirm|confirm once more|just to (?:make sure|confirm)|let'?s confirm|double-?check|one more time|is your date of birth)\b/i;

/** A confirmation read-back counts as an ask on its topic. */
export function classifyAskOrReadback(line: string): string | null {
  const direct = classifyAsk(line);
  if (direct) return direct;
  if (!CONFIRM_INTENT.test(line) && !line.includes('?')) return null;
  const hit = READBACK_TOPICS.find(([, re]) => re.test(line));
  return hit ? hit[0] : null;
}

/** Topic of a FRAGMENT, ignoring ask-intent — "and your date of birth" is a
 *  request even though the intent verb sits at the head of the sentence. */
function topicOfFragment(fragment: string): string | null {
  const all = [...READBACK_TOPICS, ...ASK_TOPICS];
  return all.find(([, re]) => re.test(fragment))?.[0] ?? null;
}

/** How many distinct things is the agent asking for in one breath? */
export function askCount(line: string): number {
  // Only count fragments when the line is an ask at all, so a statement that
  // merely mentions two topics ("I have your name and date of birth") is not
  // treated as a bundled question.
  const direct = classifyAskOrReadback(line);
  if (!direct) return 0;
  const topics = new Set<string>([direct]);
  for (const part of line.split(/\band\b|,|\?/i)) {
    if (part.trim().length < 4) continue;
    const t = topicOfFragment(part);
    // "your first and last name" is ONE request, not two: splitting on "and"
    // turns the idiom into a false bundle. When the line already reads as a
    // full-name ask, its name fragments are that same ask.
    if (t && direct === 'full name' && (t === 'first name' || t === 'last name')) continue;
    if (t) topics.add(t);
  }
  return topics.size;
}

/** Field answers the caller has given. Deliberately conservative: a field is
 *  only "answered" on strong evidence, so we never suppress a genuine ask. */
export function extractAnswers(callerLine: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dates = spokenDates(callerLine);
  if (dates.length > 0) out['date of birth'] = dates[dates.length - 1];
  const phone = callerLine.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  if (phone) out['phone number'] = phone[0];
  // Lead-in is case-tolerant; the NAME capture is not (a lowercase /i capture
  // swallows following words like "and" into the name).
  const name =
    callerLine.match(/(?:[Mm]y name is|[Tt]his is|[Ii]'?m|[Nn]ame'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/) ??
    callerLine.match(/^\s*([A-Z][a-z]{2,})\s*,\s*([A-Z][a-z]{2,})/);
  if (name) out['full name'] = (name[1] ?? '').trim();
  return out;
}

const EXIT_LINE: Record<string, string> = {
  'azul-scheduling':
    "I'm sorry — I'm clearly going in circles and I don't want to keep you any longer. Let me get you to someone on our team who can take it from here.",
  'answering-service':
    "I'm sorry, I'm going in circles here. Let me take down what I have and make sure someone from the office calls you back.",
  default:
    "I'm sorry about that — let me get you to someone who can help directly.",
};

export class Director {
  private calls = new Map<string, CallState>();

  private state(callId: string, agentSlug: string): CallState {
    let s = this.calls.get(callId);
    if (!s) {
      s = {
        agentSlug,
        turn: 0,
        answered: new Map(),
        asks: new Map(),
        escalation: new Map(),
        spokenDobs: [],
        lastAgentLine: '',
        callerSpokeSinceAgent: false,
      };
      this.calls.set(callId, s);
    }
    return s;
  }

  release(callId: string | undefined): void {
    if (callId) this.calls.delete(callId);
  }

  /** Test/telemetry view. */
  answeredFields(callId: string): string[] {
    return [...(this.calls.get(callId)?.answered.keys() ?? [])];
  }

  /** The caller spoke: bank whatever they just told us. Never returns an action. */
  observeCaller(callId: string, agentSlug: string, line: string): void {
    try {
      const s = this.state(callId, agentSlug);
      s.turn += 1;
      s.callerSpokeSinceAgent = true;
      for (const [field, value] of Object.entries(extractAnswers(line))) {
        // A later answer supersedes an earlier one — corrections must win.
        s.answered.set(field, { value, turn: s.turn });
        if (field === 'date of birth' && !s.spokenDobs.includes(value)) {
          s.spokenDobs.push(value);
        }
      }
    } catch {
      /* the director must never break a call */
    }
  }

  /**
   * The agent spoke. Decide whether this turn violates the workflow rules and,
   * if so, how hard to push back.
   */
  observeAgent(callId: string, agentSlug: string, line: string): DirectorAction | null {
    try {
      const s = this.state(callId, agentSlug);
      if (line === s.lastAgentLine && !s.callerSpokeSinceAgent) return null;
      s.lastAgentLine = line;
      s.callerSpokeSinceAgent = false;

      // One question at a time.
      if (askCount(line) >= 2) {
        const level = this.bump(s, 'bundled');
        return this.action(s, 'bundled_questions', 'bundled', level, {
          why: 'You asked for more than one thing in a single turn.',
          fix: 'Ask ONE question, then wait for the answer.',
          speak: 'Sorry — let me take that one step at a time.',
        });
      }

      const topic = classifyAskOrReadback(line);
      if (!topic) return null;
      const n = (s.asks.get(topic) ?? 0) + 1;
      s.asks.set(topic, n);

      const answer = s.answered.get(topic);
      if (answer) {
        // The caller already told us. Asking again is the defect that made
        // tonight's call unbearable — flag on the FIRST repeat, not the third.
        const level = this.bump(s, topic);
        const readable =
          topic === 'date of birth' ? formatDob(answer.value) : answer.value;
        return this.action(s, 'reask_answered_field', topic, level, {
          why: `The caller already gave their ${topic}: "${readable}" (turn ${answer.turn}).`,
          fix: `Do NOT ask for it again. Use "${readable}" and move to the next unanswered thing.`,
          speak:
            topic === 'date of birth'
              ? `Thanks — I have your date of birth as ${readable}. Let me take it from here.`
              : `Thanks — I have that as ${readable}. Let me take it from here.`,
        });
      }

      // Never answered, but we keep asking: two asks is a stall, three is a loop.
      if (n >= 2) {
        const level = this.bump(s, topic);
        // A date the caller has spoken more than one version of is an
        // ambiguity problem, not a hearing problem — resolve it in one move.
        const ambiguous = topic === 'date of birth' && s.spokenDobs.length >= 2;
        return this.action(s, ambiguous ? 'readback_loop' : 'repeat_after_directive', topic, level, {
          why: ambiguous
            ? `The caller has given ${s.spokenDobs.length} different readings of their date of birth and you are still confirming.`
            : `You have asked for the ${topic} ${n} times and do not have it.`,
          fix: ambiguous
            ? `Offer the two candidates ONCE using month names ("Is that ${formatDob(s.spokenDobs[0])} or ${formatDob(s.spokenDobs[1])}?"), accept the answer as final, and proceed.`
            : `Ask it once more in different words, or proceed without it. Do not repeat a sentence you have already said.`,
          speak: ambiguous
            ? `Let me get this right in one go — is that ${formatDob(s.spokenDobs[0])}, or ${formatDob(s.spokenDobs[1])}?`
            : undefined,
        });
      }
      return null;
    } catch {
      return null;
    }
  }

  private bump(s: CallState, key: string): number {
    const level = (s.escalation.get(key) ?? 0) + 1;
    s.escalation.set(key, level);
    return level;
  }

  private action(
    s: CallState,
    code: DirectorAction['code'],
    topic: string,
    level: number,
    parts: { why: string; fix: string; speak?: string },
  ): DirectorAction {
    // 1 = suggest. 2 = the model already ignored us once, so take the turn.
    // 3 = it is still looping; end it rather than let the caller suffer.
    const enforcement: DirectorEnforcement =
      level >= 3 ? 'force_exit' : level >= 2 ? 'author' : 'inject';
    if (enforcement === 'force_exit') {
      const speak = EXIT_LINE[s.agentSlug] ?? EXIT_LINE.default;
      return {
        enforcement,
        code,
        topic,
        speak,
        text:
          `DIRECTOR — HARD STOP on "${topic}". ${parts.why} You have ignored two corrections. ` +
          `Say exactly: "${speak}" then hand off immediately (sage_handoff for scheduling, ` +
          `otherwise create the ticket with what you have and close the call). Ask nothing further.`,
      };
    }
    if (enforcement === 'author') {
      const speak = parts.speak ?? `Thanks — let me move on so I'm not repeating myself.`;
      return {
        enforcement,
        code,
        topic,
        speak,
        text:
          `DIRECTOR — TAKING THIS TURN. ${parts.why} A previous correction was ignored. ` +
          `Say exactly this and nothing else: "${speak}" Then continue WITHOUT asking about ${topic} again.`,
      };
    }
    return {
      enforcement,
      code,
      topic,
      text: `DIRECTOR — SERVER STATE. ${parts.why} ${parts.fix}`,
    };
  }
}

/** "1983-10-05" → "October 5th, 1983" — spoken form, for read-backs. */
export function formatDob(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = Number(m[3]);
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${months[Number(m[2]) - 1]} ${day}${suffix}, ${m[1]}`;
}

export const director = new Director();

/** Agents the director is allowed to act on. Empty = disabled everywhere. */
export function directorAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DIRECTOR_AGENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function directorEnabledFor(agentSlug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return directorAgents(env).includes(agentSlug);
}
