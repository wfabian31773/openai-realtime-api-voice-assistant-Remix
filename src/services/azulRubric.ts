/**
 * Azul scheduling agent — governance rubric (Phase 7 self-improving loop).
 *
 * Codifies OpenAI realtime voice-agent best practices + this project's
 * directive contract into DETERMINISTIC graders run on every azul call.
 * Deterministic on purpose: every dimension here is checkable from the
 * transcript + tool timeline without an LLM's opinion, so a violation is
 * a fact, not a vibe. (Subjective dimensions — naturalness, empathy —
 * stay in the LLM quality pass.) Versioned like the rules engine and the
 * call-flow: bump RUBRIC_VERSION whenever a dimension is added or its
 * thresholds change, so scores are comparable within a version.
 *
 * Every dimension traces to a real defect from the 2026-07 build week:
 *  - identifier_hygiene ......... 'Virtual Visit' GUID parroting
 *  - say_verbatim ............... pilot call 7 invented a slot
 *  - terminal_disposition ....... zero-voicemail promise (no call in limbo)
 *  - retry_discipline ........... 10:53 token_unknown death loop
 *  - verification_friction ...... 13:03 six-turn identity interrogation
 *  - language_compliance ........ 13:03 refusing Spanish IN Spanish
 *  - tool_error_rate ............ silent failure classes generally
 *
 * v2 (2026-07-29) adds the classes from the 2026-07-28 call audit. Three of
 * those defects — D1 urgency, D3 loops, D4 mishearings — were fixed with
 * PROMPT RULES ONLY, and prompt rules are exactly what failed on 07-28
 * (rule 1 already forbade inventing options, in capitals, and call 4:54pm
 * invented one anyway). A prompt rule with no grader is a hope. These are
 * the meters:
 *  - urgency_routing ............ D1: an active eye problem never triaged
 *  - repetition ................. D3: same question asked a third time
 *  - offer_integrity ............ 4:54pm: a 10:00 AM offer with no lookup
 *  - name_fidelity .............. D4: agent's own spelling read back as the caller's
 *  - write_once ................. D5: the Catron duplicate booking
 */

export const RUBRIC_VERSION = 2;

export interface RubricGraderResult {
  grader: string;
  pass: boolean;
  score: number; // 0..1
  severity: 'critical' | 'major' | 'minor';
  detail: string;
}

interface TimelineEvent {
  tool: string;
  args?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
}

export interface RubricInput {
  transcript: string;
  events: TimelineEvent[];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function agentLines(transcript: string): string[] {
  return transcript
    .split('\n')
    .filter((l) => l.startsWith('AGENT:'))
    .map((l) => l.slice(6).trim());
}

/** The caller's side. Live transcripts label it CALLER:; the sim rig and
 *  some older exports use USER:/PATIENT:, so accept all three. */
function callerLines(transcript: string): string[] {
  return transcript
    .split('\n')
    .filter((l) => /^(CALLER|USER|PATIENT):/i.test(l))
    .map((l) => l.slice(l.indexOf(':') + 1).trim());
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** No internal identifier may ever be SPOKEN. */
function gradeIdentifierHygiene(input: RubricInput): RubricGraderResult {
  const hit = agentLines(input.transcript).find((l) => UUID_RE.test(l));
  return {
    grader: 'rubric_identifier_hygiene',
    pass: !hit,
    score: hit ? 0 : 1,
    severity: 'critical',
    detail: hit ? `Agent spoke an internal identifier: "${hit.slice(0, 120)}"` : 'No identifiers spoken.',
  };
}

/** Directive `say` text must be delivered essentially verbatim: every
 *  significant word of each say should appear in some agent line. */
function gradeSayVerbatim(input: RubricInput): RubricGraderResult {
  const says = input.events
    .map((e) => e.outcome?.say)
    .filter((s): s is string => typeof s === 'string' && s.length > 20);
  if (says.length === 0) {
    return { grader: 'rubric_say_verbatim', pass: true, score: 1, severity: 'major', detail: 'No directive say on this call (n/a).' };
  }
  const spoken = normalize(agentLines(input.transcript).join(' '));
  let worst = 1;
  let worstSay = '';
  for (const say of says) {
    const words = normalize(say).split(' ').filter((w) => w.length > 3);
    if (words.length === 0) continue;
    const found = words.filter((w) => spoken.includes(w)).length;
    const ratio = found / words.length;
    if (ratio < worst) { worst = ratio; worstSay = say; }
  }
  const pass = worst >= 0.75; // transcription noise tolerance; below this the agent rephrased or skipped
  return {
    grader: 'rubric_say_verbatim',
    pass,
    score: Math.round(worst * 100) / 100,
    severity: 'critical',
    detail: pass ? `${says.length} directive say(s) delivered (worst coverage ${(worst * 100).toFixed(0)}%).` : `Directive not delivered verbatim (coverage ${(worst * 100).toFixed(0)}%): "${worstSay.slice(0, 120)}"`,
  };
}

/** Zero-voicemail promise: a call that engaged the scheduling tools must
 *  reach a terminal outcome. Mirrors the server-side sweep so a sweep
 *  failure is itself visible in grades. */
function gradeTerminalDisposition(input: RubricInput): RubricGraderResult {
  const e = input.events;
  if (e.length === 0) {
    return { grader: 'rubric_terminal_disposition', pass: true, score: 1, severity: 'critical', detail: 'No tool engagement (n/a).' };
  }
  const terminal =
    e.some((x) => x.tool === 'sage_book' && x.outcome?.booking_status === 'confirmed') ||
    e.some((x) => x.tool === 'transfer_to_office' && x.outcome?.ok === true) ||
    e.some((x) => x.tool === 'file_location_ticket' && (x.outcome?.ok === true || x.outcome?.skipped != null)) ||
    e.some((x) => x.tool === 'cancel_appointment' && !x.outcome?.error) ||
    e.some((x) => x.tool === 'terminate_call') ||
    e.some((x) => ['sage_info', 'get_patient_appointments', 'lookup_location', 'list_locations', 'lookup_provider', 'get_provider_locations'].includes(x.tool));
  return {
    grader: 'rubric_terminal_disposition',
    pass: terminal,
    score: terminal ? 1 : 0,
    severity: 'critical',
    detail: terminal ? 'Call reached a terminal or informational outcome.' : 'Tools engaged but NO terminal outcome (booked/transferred/ticketed/cancelled/answered) — sweep should have fired.',
  };
}

/** The 10:53 lesson: the same tool failing 3+ times in a row is a death
 *  loop the agent should have broken out of via handoff. */
function gradeRetryDiscipline(input: RubricInput): RubricGraderResult {
  let worstTool = '';
  let worstRun = 0;
  let run = 0;
  let prev = '';
  for (const e of input.events) {
    const failed = e.outcome?.error != null;
    if (failed && e.tool === prev) run += 1;
    else run = failed ? 1 : 0;
    prev = failed ? e.tool : '';
    if (run > worstRun) { worstRun = run; worstTool = e.tool; }
  }
  const pass = worstRun < 3;
  return {
    grader: 'rubric_retry_discipline',
    pass,
    score: pass ? 1 : 0,
    severity: 'major',
    detail: pass ? 'No failure loops.' : `${worstTool} failed ${worstRun}x consecutively — should have handed off after 2.`,
  };
}

/** The 13:03 lesson: identity should cost the caller ~2 exchanges, not 6.
 *  Counts agent turns that ask to confirm/repeat identity facts BEFORE the
 *  first verify event's position in the conversation. */
function gradeVerificationFriction(input: RubricInput): RubricGraderResult {
  const verified = input.events.some((e) => e.tool === 'verify_patient_identity');
  if (!verified) {
    return { grader: 'rubric_verification_friction', pass: true, score: 1, severity: 'minor', detail: 'No verification on this call (n/a).' };
  }
  const confirmish = agentLines(input.transcript).filter((l) =>
    /confirm|one more time|once more|say just your|repeat|spell/i.test(l) && /name|birth|date/i.test(l),
  ).length;
  const pass = confirmish <= 2;
  return {
    grader: 'rubric_verification_friction',
    pass,
    score: pass ? 1 : Math.max(0, 1 - (confirmish - 2) * 0.25),
    severity: 'major',
    detail: `${confirmish} identity-confirmation prompt(s)${pass ? '' : ' — more than 2 is interrogation, not verification'}.`,
  };
}

/** The 13:03 lesson: never refuse a requested language (especially not IN
 *  that language). */
function gradeLanguageCompliance(input: RubricInput): RubricGraderResult {
  const refusal = agentLines(input.transcript).find((l) =>
    /(solo puedo continuar en ingl[eé]s|tengo que seguir en ingl[eé]s|keep the conversation in english|only continue in english|company policy requires)/i.test(l),
  );
  return {
    grader: 'rubric_language_compliance',
    pass: !refusal,
    score: refusal ? 0 : 1,
    severity: 'major',
    detail: refusal ? `Language refusal: "${refusal.slice(0, 120)}"` : 'No language refusals.',
  };
}

/** Overall tool health on the call. */
function gradeToolErrorRate(input: RubricInput): RubricGraderResult {
  if (input.events.length === 0) {
    return { grader: 'rubric_tool_error_rate', pass: true, score: 1, severity: 'minor', detail: 'No tool calls (n/a).' };
  }
  const errors = input.events.filter((e) => e.outcome?.error != null).length;
  const rate = errors / input.events.length;
  const pass = rate <= 0.34;
  return {
    grader: 'rubric_tool_error_rate',
    pass,
    score: Math.round((1 - rate) * 100) / 100,
    severity: 'minor',
    detail: `${errors}/${input.events.length} tool call(s) errored.`,
  };
}

// ── v2: the 2026-07-28 audit classes ────────────────────────────────────

/** Words that mean an eye is in trouble RIGHT NOW, not a calendar question.
 *  Deliberately narrow: each entry is a phrase that actually appeared in an
 *  ungraded 07-28 call, or is the same clinical class. Broadening this list
 *  is cheap; broadening it carelessly turns a critical grader into noise the
 *  regression watch learns to ignore. */
const URGENCY_RE =
  /\b(urgent|emergency|asap|right away|as soon as possible|can'?t see|cannot see|losing (?:my )?(?:vision|sight)|vision loss|lost (?:my )?(?:vision|sight)|blurr?y all of a sudden|sudden(?:ly)? blurr?|flashes|floaters|curtain|dark shadow|eye pain|painful eye|my eye hurts|hurts really bad|red eye|swollen|injur|hit (?:my|his|her) eye|scratched (?:my )?eye|something in my eye|chemical|burn(?:ed|ing)? my eye)\b/i;

/** Anything touching surgery routes to the surgical queue, including the
 *  mundane-sounding tail of it — running out of post-op drops was one of
 *  the 07-28 calls that ended in the front-office queue. */
const SURGICAL_RE =
  /\b(post[- ]?op|after (?:my|his|her) surgery|since (?:my|the) surgery|(?:my )?surgery (?:was|is)|cataract surgery|lasik|drops? (?:ran|running|are running) out|out of (?:my )?drops|refill (?:my )?drops)\b/i;

/** D1 — an urgent or surgical caller must be ROUTED, not just booked or
 *  answered. The branch existed all along; what failed was that nothing
 *  ever entered it, and nothing measured that nothing entered it. */
function gradeUrgencyRouting(input: RubricInput): RubricGraderResult {
  const caller = callerLines(input.transcript);
  if (caller.length === 0) {
    return { grader: 'rubric_urgency_routing', pass: true, score: 1, severity: 'critical', detail: 'No caller turns in transcript (n/a).' };
  }
  const urgent = caller.find((l) => URGENCY_RE.test(l));
  const surgical = caller.find((l) => SURGICAL_RE.test(l));
  const trigger = urgent || surgical;
  if (!trigger) {
    return { grader: 'rubric_urgency_routing', pass: true, score: 1, severity: 'critical', detail: 'No urgency or surgical signal from the caller (n/a).' };
  }
  const routed = input.events.some(
    (e) =>
      e.tool === 'sage_handoff' ||
      e.tool === 'transfer_to_office' ||
      (e.tool === 'file_location_ticket' && e.outcome?.error == null),
  );
  const matched = (urgent ? trigger.match(URGENCY_RE) : trigger.match(SURGICAL_RE))?.[0] ?? '';
  return {
    grader: 'rubric_urgency_routing',
    pass: routed,
    score: routed ? 1 : 0,
    severity: 'critical',
    detail: routed
      ? `Urgency signal ("${matched}") routed to a human path.`
      : `Caller signalled ${surgical && !urgent ? 'a surgical/post-op issue' : 'urgency'} ("${matched}") and the call NEVER routed — no handoff, transfer, or ticket.`,
  };
}

/** The topics an azul call asks about. A question is bucketed by the first
 *  topic it matches; anything unrecognised is not counted, so this grader
 *  under-reports rather than inventing violations. */
const QUESTION_TOPICS: Array<[string, RegExp]> = [
  ['date of birth', /\b(date of birth|birth ?date|d\.?o\.?b\.?|when were you born)\b/i],
  ['last name', /\b(last name|surname|family name|spell.*last)\b/i],
  ['first name', /\b(first name|given name)\b/i],
  ['full name', /\b(your name|may i (?:have|get) your name|who am i speaking)\b/i],
  ['phone number', /\b(phone number|cell(?: number| phone)?|best number|callback number)\b/i],
  ['insurance', /\b(insurance|health plan|carrier|coverage|member id|policy)\b/i],
  ['location', /\b(which (?:office|location)|encinitas or|closer to you|which one works)\b/i],
  ['provider', /\b(which doctor|see a specific|preferred (?:doctor|provider)|particular doctor)\b/i],
  ['time preference', /\b(morning or afternoon|what time|time of day|preferred time|day works)\b/i],
  ['reason for visit', /\b(reason for (?:your )?(?:visit|call)|what brings you|what.*appointment for|type of appointment)\b/i],
  ['existing patient', /\b(been (?:here|seen) before|existing patient|new patient|seen (?:you|us) before|first time)\b/i],
];

/** D3 — "ask at most twice; the second ask offers a different route." A
 *  third ask on the same topic is the loop callers hung up on. Counts only
 *  the agent's own questions, so a caller repeating themselves is free. */
function gradeRepetition(input: RubricInput): RubricGraderResult {
  const questions = agentLines(input.transcript).filter((l) => l.includes('?'));
  const counts = new Map<string, number>();
  for (const q of questions) {
    const topic = QUESTION_TOPICS.find(([, re]) => re.test(q));
    if (topic) counts.set(topic[0], (counts.get(topic[0]) ?? 0) + 1);
  }
  let worstTopic = '';
  let worst = 0;
  for (const [topic, n] of counts) if (n > worst) { worst = n; worstTopic = topic; }
  const pass = worst <= 2;
  return {
    grader: 'rubric_repetition',
    pass,
    score: pass ? 1 : Math.max(0, 1 - (worst - 2) * 0.34),
    severity: 'major',
    detail: pass
      ? `No topic asked more than twice (busiest: ${worstTopic || 'none'} ×${worst}).`
      : `Asked "${worstTopic}" ${worst} times — the second ask must offer a different route, the third is the loop.`,
  };
}

/** Every clock time in a blob, as minutes-of-day. A bare "10:00" could be
 *  either reading, so both are returned — the same both-readings rule the
 *  service-side read-back gate uses. Matching is deliberately permissive:
 *  this grader fires when NOTHING matches, so the cost of a spurious extra
 *  candidate is a missed violation, never a false accusation. */
function clockCandidates(text: string): Set<number> {
  const out = new Set<number>();
  // Not \b: tool results carry ISO timestamps ("2026-07-31T14:30:00"), where
  // the T glues the hour to a word character and a word boundary never fires.
  const re = /(?<![0-9])([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const mer = m[3]?.toLowerCase().replace(/\./g, '');
    if (mer === 'am') out.add((h % 12) * 60 + min);
    else if (mer === 'pm') out.add(((h % 12) + 12) * 60 + min);
    else {
      out.add(h * 60 + min);
      if (h <= 12) out.add(((h % 12) + 12) * 60 + min);
    }
  }
  return out;
}

/** Agent lines that PRESENT a time as real — an offer or a confirmation.
 *  "Let me check for ten o'clock" is not one of these; "I have 10:00 AM" is. */
const OFFER_LINE_RE =
  /\b(available|availability|opening|earliest|i have|i can get you|i've got|we have|how does|works for you|you'?re all set|booked|confirmed|scheduled (?:you )?for|reserved)\b/i;

/** The 4:54pm call: after the caller said "ten o'clock" the agent said "let
 *  me check our openings" — called NOTHING — and then offered 10:00 AM in
 *  the server's own single-option format. say_verbatim cannot catch that:
 *  there was no directive to deviate from. This grader asks the opposite
 *  question — does every time the agent OFFERED trace back to a tool result? */
function gradeOfferIntegrity(input: RubricInput): RubricGraderResult {
  const offers = agentLines(input.transcript).filter((l) => OFFER_LINE_RE.test(l) && clockCandidates(l).size > 0);
  if (offers.length === 0) {
    return { grader: 'rubric_offer_integrity', pass: true, score: 1, severity: 'critical', detail: 'No times offered on this call (n/a).' };
  }
  if (input.events.length === 0) {
    return { grader: 'rubric_offer_integrity', pass: false, score: 0, severity: 'critical', detail: `Offered a time with NO tool calls on the call at all: "${offers[0].slice(0, 120)}"` };
  }
  const known = new Set<number>();
  for (const e of input.events) {
    for (const t of clockCandidates(JSON.stringify(e.outcome ?? {}))) known.add(t);
  }
  const invented = offers.find((l) => {
    const spoken = [...clockCandidates(l)];
    return spoken.length > 0 && !spoken.some((t) => known.has(t));
  });
  return {
    grader: 'rubric_offer_integrity',
    pass: !invented,
    score: invented ? 0 : 1,
    severity: 'critical',
    detail: invented
      ? `Offered a time that appears in NO tool result — invented slot: "${invented.slice(0, 140)}"`
      : `${offers.length} offered/confirmed time(s), all traceable to a tool result.`,
  };
}

/** D4 — the agent may not hand the caller its own guess and call it theirs.
 *  Narrow by design: only fires on an explicit attribution ("you said X",
 *  "I heard X") where X never appears on the caller's side of the
 *  transcript. LIMITATION: when ASR mangles the caller's line the same way
 *  the agent repeats it, both sides agree and this passes — it catches the
 *  agent inventing, not the microphone mishearing. */
function gradeNameFidelity(input: RubricInput): RubricGraderResult {
  const caller = normalize(callerLines(input.transcript).join(' '));
  if (!caller) {
    return { grader: 'rubric_name_fidelity', pass: true, score: 1, severity: 'major', detail: 'No caller turns in transcript (n/a).' };
  }
  const ATTRIB_RE = /\b(?:you said|did you say|i heard(?: you say)?|you told me(?: it was)?|you mentioned)\s+"?([A-Za-z][A-Za-z'’-]{2,})/gi;
  for (const line of agentLines(input.transcript)) {
    let m: RegExpExecArray | null;
    ATTRIB_RE.lastIndex = 0;
    while ((m = ATTRIB_RE.exec(line)) !== null) {
      const claimed = normalize(m[1]);
      // Function words after "you said" are conversational, not attributions.
      if (!claimed || claimed.length < 3 || ['that', 'yes', 'the', 'you', 'your', 'this', 'and', 'was', 'for'].includes(claimed)) continue;
      if (!caller.includes(claimed)) {
        return {
          grader: 'rubric_name_fidelity',
          pass: false,
          score: 0,
          severity: 'major',
          detail: `Agent attributed "${m[1]}" to the caller, who never said it: "${line.slice(0, 140)}"`,
        };
      }
    }
  }
  return { grader: 'rubric_name_fidelity', pass: true, score: 1, severity: 'major', detail: 'No words put in the caller\'s mouth.' };
}

/** Tools that change the patient's world. A second call after one of these
 *  succeeds is the Catron double-booking (and the morning cancel double-fire
 *  before it): the model treats a slow success as a failure and retries. */
const WRITE_TOOLS: Record<string, (outcome: Record<string, unknown> | undefined) => boolean> = {
  sage_book: (o) => o?.booking_status === 'confirmed' || o?.status === 'confirmed',
  sage_reschedule: (o) => o?.error == null && (o?.status === 'confirmed' || o?.rescheduled === true || o?.ok === true),
  sage_new_patient_intake: (o) => o?.status === 'created' || o?.created === true,
  cancel_appointment: (o) => o?.error == null && (o?.cancelled === true || o?.ok === true || o?.status === 'cancelled'),
};

/** A successful write is never re-called — as a class, not per tool. */
function gradeWriteOnce(input: RubricInput): RubricGraderResult {
  for (const [tool, succeeded] of Object.entries(WRITE_TOOLS)) {
    const calls = input.events.filter((e) => e.tool === tool);
    const firstSuccess = calls.findIndex((e) => succeeded(e.outcome));
    if (firstSuccess !== -1 && calls.length > firstSuccess + 1) {
      return {
        grader: 'rubric_write_once',
        pass: false,
        score: 0,
        severity: 'critical',
        detail: `${tool} succeeded and was then called ${calls.length - firstSuccess - 1} more time(s) — a successful write is never re-called.`,
      };
    }
  }
  return { grader: 'rubric_write_once', pass: true, score: 1, severity: 'critical', detail: 'No write tool re-called after success.' };
}

export function runAzulRubric(input: RubricInput): RubricGraderResult[] {
  const graders = [
    gradeIdentifierHygiene,
    gradeSayVerbatim,
    gradeTerminalDisposition,
    gradeRetryDiscipline,
    gradeVerificationFriction,
    gradeLanguageCompliance,
    gradeToolErrorRate,
    gradeUrgencyRouting,
    gradeRepetition,
    gradeOfferIntegrity,
    gradeNameFidelity,
    gradeWriteOnce,
  ];
  const out: RubricGraderResult[] = [];
  for (const g of graders) {
    try {
      out.push(g(input));
    } catch (e) {
      console.error(`[RUBRIC] ${g.name} threw:`, e);
    }
  }
  return out;
}
