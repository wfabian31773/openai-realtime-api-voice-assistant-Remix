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
    | 'readback_loop'
    | 'record_name_disclosed'
    | 'record_detail_disclosed';
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
  /** Names known from the RECORD (caller-ID pre-context, carrier lookup) but
   *  not yet confirmed by the caller. Speaking one of these to an unverified
   *  caller is a disclosure, not a courtesy. */
  recordNames: string[];
  /** Topics the caller has confirmed once already. One read-back is good
   *  practice; a second is the loop. */
  confirmed: Set<string>;
  /** Every word the CALLER has spoken, lowercased. Repeating a name back to
   *  the person who just said it is courtesy, not disclosure — azul's 16:56
   *  call fired on "Thanks, Gary Raskin" one turn after the caller said
   *  "Gary Raskin, R-A-S-K-I-N". */
  callerWords: Set<string>;
  /** Suppresses a second disclosure action before the caller has had a
   *  chance to respond to the first (the 17:00 stutter). */
  disclosureFiredSinceCaller: boolean;
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

/**
 * "Am I speaking with Elena?" — ASKING whether the caller is the matched
 * person, rather than ASSERTING that they are.
 *
 * This is the sanctioned flow. Every prompt instructs it explicitly ("YOUR
 * OPENING GREETING ALREADY ASKED 'Am I speaking with {first}?'"), and it
 * exists so a known patient is not interrogated from scratch. Flagging it
 * was the single worst thing the director has done: on 2026-08-03 between
 * 15:00 and 17:00 it fired on 48 real patient calls at `author` enforcement,
 * cancelling the agent mid-sentence and substituting "Sorry — before we go
 * on, may I get your full name?" — sometimes twice in a row. The cure was
 * worse than the disease, and it hit every matched caller rather than the
 * few where the agent actually volunteered a name.
 *
 * Trade-off worth stating plainly: this pattern still tells whoever is
 * holding the handset that the number is associated with an "Elena". The
 * practice chose that deliberately. It is not the director's call to
 * override, so the rule now covers ASSERTIVE use only.
 */
const NAME_CONFIRM_QUESTION =
  /\b(?:am i speaking (?:with|to)|is this|may i ask if (?:this|you)|do i have)\b/i;

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
const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

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
    // "Surname, Firstname" — but NOT "Fabian, March 17, 1973", which on the
    // 12:01 call banked "Fabian" as a full name and made the agent's perfectly
    // reasonable spelling request look like a re-ask. The second token must be
    // a name, not a month, and must not be followed by a date.
    callerLine.match(/^\s*([A-Z][a-z]{2,})\s*,\s*([A-Z][a-z]{2,})(?!\w*\s+\d)/);
  if (name && !MONTHS.has(String(name[2] ?? '').toLowerCase())) {
    out['full name'] = (name[1] ?? '').trim();
  }
  return out;
}

/**
 * Names too ordinary to treat as an identifier. "Hi, Mark" from a record match
 * is a disclosure; "that's a good mark" is not, and a guard that cannot tell
 * them apart gets switched off within a week.
 */
const NAME_STOPLIST = new Set([
  'may', 'will', 'mark', 'bill', 'rose', 'grace', 'art', 'dawn', 'frank',
  'hope', 'joy', 'sunny', 'drew', 'sue', 'don', 'ray', 'jean', 'faith',
  'rich', 'chase', 'summer', 'autumn', 'guy', 'earl', 'miles', 'penny',
]);

/**
 * An agent line that states an appointment the caller ALREADY HAS.
 *
 * Names were only half of it. On the 14:24 no-ivr call the agent said "I see
 * you have an upcoming appointment today, on August 3rd, at 8:25 AM in
 * Glendale with Dr. Daniel Choi" to a caller who had given neither a name nor
 * a date of birth — date, time, location and provider, on caller-ID alone.
 * Seeding the provider's name could never have caught that; Dr. Choi is not
 * the caller and would never be in the seed list.
 *
 * So this matches SHAPE, not content: possessive framing together with a
 * concrete time or date. It deliberately does NOT match offering availability
 * ("I could do 9:00 AM Tuesday"), which reveals nothing about the caller.
 *
 * POSSESSIVE FRAMING IS NOT ENOUGH ON ITS OWN (Codex, PR #69). A bare "you
 * have" plus a weekday also matches "Do you have availability Tuesday at 9:00
 * AM?" — an ordinary scheduling question, and precisely the flow the previous
 * paragraph claims to exclude. At `author` enforcement that would cancel a
 * harmless turn, which is the mistake that cost 48 calls this afternoon. The
 * line must therefore ALSO be about an appointment, not merely address the
 * caller in the second person.
 */
const EXISTING_APPOINTMENT =
  /\b(?:you have|we have you|i see you have|you'?re scheduled|scheduled for|on record for you)\b/i;
/** The line is about an appointment, not about the caller's availability. */
const APPOINTMENT_CONTEXT = /\b(?:appointments?|visits?|scheduled)\b/i;
const CONCRETE_WHEN =
  /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/**
 * The ABSENCE of an appointment — a fact about the caller's record just as
 * much as its presence, and one that by definition carries no date. Requiring
 * CONCRETE_WHEN here made the absence branch dead code: "You have no upcoming
 * appointments on record" scored nothing. My own test only passed because I
 * had padded it with "Tuesday or otherwise", which should have been the tell.
 */
const APPOINTMENT_ABSENCE =
  /\b(?:no|not|don'?t|doesn'?t|nothing)\b[^.?!]{0,30}\b(?:upcoming\s+)?appointments?\b|\bappointments?\b[^.?!]{0,20}\b(?:not (?:showing|on record)|nothing on record)\b/i;

/**
 * Does this line ASSERT the given name, as opposed to asking about it?
 *
 * Scoped per clause (Codex, PR #69). Testing NAME_CONFIRM_QUESTION against the
 * whole line meant one confirm-shaped phrase disabled the check for every
 * later sentence: "Am I speaking with Elena? I see you have an appointment
 * Tuesday at 9:00 AM" passed clean. The exemption belongs to the clause that
 * asks, not to the turn that contains it.
 */
function assertsName(line: string, name: string): boolean {
  const re = new RegExp(`\\b${name}\\b`, 'i');
  return line
    .split(/(?<=[.?!])\s+/)
    .some((clause) => re.test(clause) && !NAME_CONFIRM_QUESTION.test(clause));
}

/** A record-sourced name worth guarding: long enough, and not a common word. */
function guardableName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.length >= 3 && /^[a-z][a-z'-]+$/.test(n) && !NAME_STOPLIST.has(n);
}

/**
 * Has the caller established who they are THIS call?
 *
 * Deliberately strict — name AND date of birth, the same bar the prompts set.
 * A caller-ID match is not identity: family members, spouses, care homes and
 * pharmacies all share phones, and every one of the 2026-08-03 disclosures
 * happened on a call where the phone matched and the person did not.
 */
function identityEstablished(s: CallState): boolean {
  return s.answered.has('full name') && s.answered.has('date of birth');
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
        recordNames: [],
        confirmed: new Set(),
        callerWords: new Set(),
        disclosureFiredSinceCaller: false,
        lastAgentLine: '',
        callerSpokeSinceAgent: false,
      };
      this.calls.set(callId, s);
    }
    return s;
  }

  /**
   * Tell the director which names came from the RECORD rather than from the
   * caller's mouth — caller-ID pre-context, a carrier lookup, caller memory.
   *
   * LIMITATION, stated plainly: the director sees an agent line from the
   * assistant transcript, which arrives AFTER the audio has been spoken. It
   * cannot un-say the first disclosure. What it can do is record it, stop the
   * agent building on it, and end the call if it keeps going. Preventing the
   * first one is the prompt's job; catching the prompt failing is this.
   */
  seedRecordNames(callId: string, agentSlug: string, names: Array<string | null | undefined>): void {
    try {
      const s = this.state(callId, agentSlug);
      for (const raw of names) {
        for (const part of String(raw ?? '').split(/[\s,]+/)) {
          if (guardableName(part) && !s.recordNames.includes(part.toLowerCase())) {
            s.recordNames.push(part.toLowerCase());
          }
        }
      }
    } catch {
      /* the director must never break a call */
    }
  }

  /** Test/telemetry view. */
  guardedNames(callId: string): string[] {
    return [...(this.calls.get(callId)?.recordNames ?? [])];
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
      s.disclosureFiredSinceCaller = false;
      for (const w of line.toLowerCase().match(/[a-z'-]{3,}/g) ?? []) s.callerWords.add(w);
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

      // PRIVACY FIRST. Speaking a name we only know from the record, to a
      // caller who has not established they are that person, is a disclosure.
      // 2026-08-03 produced three in one hour: "Hi Fulvia, I see you've called
      // us before" to a caller who had not yet spoken a word; "Am I speaking
      // with Mildred?" to a pharmacy rep (wrong person); and "we found records
      // ... for a different patient, Wayne Fabian" to a caller asking about
      // their mother. Every prompt involved already forbade it.
      // Two exclusions apply to the whole block:
      //   - the caller has established who they are (the original rule)
      //   - we already fired and the caller has not spoken since (the stutter)
      // The "asking is not asserting" exemption is NOT one of them: it is
      // scoped to the clause holding the name (see assertsName), so a confirm
      // question can no longer license an appointment disclosure later in the
      // same turn.
      if (!identityEstablished(s) && !s.disclosureFiredSinceCaller) {
        // Echoing back a name the caller has already said is courtesy.
        const spoken = s.recordNames.find((n) => !s.callerWords.has(n) && assertsName(line, n));
        // Appointment details are a disclosure too. Absence needs no date —
        // it never has one.
        const detail =
          APPOINTMENT_ABSENCE.test(line) ||
          (EXISTING_APPOINTMENT.test(line) && APPOINTMENT_CONTEXT.test(line) && CONCRETE_WHEN.test(line));
        if (!spoken && detail) {
          const level = this.bump(s, 'disclosure');
          s.disclosureFiredSinceCaller = true;
          return this.action(s, 'record_detail_disclosed', 'identity', level, {
            why:
              `You described an appointment from the record to a caller who has NOT stated ` +
              `their own name and date of birth this call.`,
            fix:
              `Say nothing further about their appointments, providers or locations until they ` +
              `state a name AND a date of birth and both match. Ask who you are speaking with.`,
            speak: `Before I look at anything, may I get your full name and date of birth?`,
          }, level + 1);
        }
        if (spoken) {
          const level = this.bump(s, 'disclosure');
          s.disclosureFiredSinceCaller = true;
          return this.action(s, 'record_name_disclosed', 'identity', level, {
            why:
              `You spoke a name from the record ("${spoken}") to a caller who has NOT stated ` +
              `their own name and date of birth this call. A phone number is not identity.`,
            fix:
              `Do not use any name, appointment, or history from the record until the caller ` +
              `states their name AND date of birth and they match. Ask them who you are speaking with.`,
            speak: `Sorry — before we go on, may I get your full name?`,
            // level + 1: a disclosure starts at 'author', because the words
            // have already reached the caller's ear by the time we see the
            // line — a suggestion cannot un-say them. A second one ends the
            // call rather than let it keep naming people.
          }, level + 1);
        }
      }

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
        // ONE read-back is good practice and several prompts require it
        // ("STILL COLLECT THE DATE OF BIRTH, and read it back before you use
        // it"). Firing on it produced two false positives on 2026-08-03 —
        // 12:01:29 and 12:58:28, both a single, correct confirmation. So a
        // confirmation-SHAPED line gets one free pass per topic; a fresh open
        // re-ask ("What is your date of birth?" after they gave it) never
        // does, because that one is always wrong.
        // A confirmation is a line the DIRECT ask-classifier did not see but
        // the read-back path did. Testing CONFIRM_INTENT here instead was
        // wrong: it contains "is your date of birth", which also matches the
        // fresh open ask "What is your date of birth?" — the one case that
        // must never get a free pass.
        const isConfirmation = !classifyAsk(line) && !!classifyAskOrReadback(line);
        if (isConfirmation && !s.confirmed.has(topic)) {
          s.confirmed.add(topic);
          return null;
        }
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
    /** Effective level, when a violation must start harder than a hint.
     *  Defaults to `level`. */
    effectiveLevel: number = level,
  ): DirectorAction {
    // 1 = suggest. 2 = the model already ignored us once, so take the turn.
    // 3 = it is still looping; end it rather than let the caller suffer.
    const enforcement: DirectorEnforcement =
      effectiveLevel >= 3 ? 'force_exit' : effectiveLevel >= 2 ? 'author' : 'inject';
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
