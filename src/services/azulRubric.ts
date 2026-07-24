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
 */

export const RUBRIC_VERSION = 1;

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

export function runAzulRubric(input: RubricInput): RubricGraderResult[] {
  const graders = [
    gradeIdentifierHygiene,
    gradeSayVerbatim,
    gradeTerminalDisposition,
    gradeRetryDiscipline,
    gradeVerificationFriction,
    gradeLanguageCompliance,
    gradeToolErrorRate,
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
