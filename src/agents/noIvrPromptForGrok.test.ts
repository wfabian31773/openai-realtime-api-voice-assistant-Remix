/**
 * The no-IVR prompt, trimmed for the Grok runtime — and the invariants that
 * trim must never break.
 *
 * WHY THIS FILE EXISTS.
 *
 * Measured 2026-09-14 through `realLanes.test.ts`, own share = the bound
 * instructions minus the shared knowledge pack:
 *
 *   surgery 1,299 tok · optical 1,425 · tech 1,583 · records 1,686 · pcp 2,348
 *   no-ivr  9,118 tok   <- before this trim
 *
 * Only optical, surgery, tech and pcp have ever taken a live call on that
 * runtime, so pcp's 2,348 was the largest prompt it had ever served. The
 * operator's standing note is *"grok requires minimal prompting, we should not
 * be near our ceilings"* (2026-09-03), against a stated ceiling of 1,600.
 *
 * WHAT THE TRIM WAS AND WAS NOT. It removed PACKAGING (box-drawing art around
 * the playbook) and RESTATEMENT (one rule written three and four times over).
 * It removed no capability and changed no rule. Where it found the prompt
 * contradicting ITSELF it resolved the contradiction toward the statement the
 * rest of the prompt already agreed with, and those resolutions are pinned
 * below so they cannot quietly come back.
 *
 * THE GREETING ONE IS THE LOAD-BEARING FIX, and it is pipeline-shaped:
 *
 *   old core  `armGreetingGuarantee` (voiceAgentRoutes.ts) injects a
 *             `response.create` whose instructions are "Say this greeting to
 *             the caller word-for-word" — the MODEL speaks it, on the
 *             transport's command, with a delivery check and a re-send.
 *   runtime   the bridge plays the greeting as audio BEFORE the model's first
 *             turn, and `withGreetingAlreadyPlayed` appends "Your opening
 *             greeting has ALREADY been spoken … Never say it again."
 *
 * The pre-context block used to say "YOUR GREETING IS NOT OPTIONAL AND MUST NOT
 * BE SHORTENED. Deliver it IN FULL" — redundant on the old core (the injected
 * turn already commands it word-for-word) and a flat contradiction on the
 * runtime. It now states only the invariants that hold on BOTH: do not open
 * with a name confirmation, do not speak over it, never shorten, paraphrase or
 * repeat it.
 *
 * That greeting carries the 911 instruction and the recording disclosure, so
 * every assertion about it here is a compliance assertion, not a style one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GREETING_ALREADY_PLAYED } from '../runtime/greetingAlreadyPlayed';

const AGENT = readFileSync(join(__dirname, './noIvrAgent.ts'), 'utf8');

/** The prompt builder's body — everything the caller ever hears about. */
function promptSource(): string {
  const start = AGENT.indexOf('function buildNoIvrSystemPrompt(');
  expect(start, 'buildNoIvrSystemPrompt must exist').toBeGreaterThan(-1);
  const end = AGENT.indexOf('\nexport async function createNoIvrAgent(', start);
  expect(end, 'createNoIvrAgent must follow the builder').toBeGreaterThan(start);
  return AGENT.slice(start, end);
}

describe('the greeting block contradicts neither pipeline', () => {
  it('never tells the model to deliver, say or repeat the greeting', () => {
    const p = promptSource();
    // The exact wording that was contradictory, and the shapes it could
    // plausibly come back as.
    expect(p).not.toContain('YOUR GREETING IS NOT OPTIONAL');
    expect(p).not.toMatch(/Deliver it IN FULL/i);
    expect(p).not.toMatch(/deliver (your|the) greeting/i);
    expect(p).not.toMatch(/say (your|the) greeting/i);
  });

  it('still forbids the two things that truncated it on 2026-08-01', () => {
    const p = promptSource();
    expect(p).toContain('DO NOT OPEN WITH A NAME CONFIRMATION');
    expect(p).toMatch(/DO NOT SPEAK OVER THE GREETING/i);
    expect(p).toMatch(/never say it\s*\n?\s*a second time/i);
  });

  it('keeps the compliance content the greeting exists to carry', () => {
    const p = promptSource();
    // NOT a bare /911/. The block mentions 911 twice — once saying what the
    // greeting carries, once recounting the 2026-08-01 call where it was cut
    // off — so a loose match stays green while either sentence is deleted.
    // Assert the statement of WHAT THE GREETING CARRIES, which is the one a
    // future edit would drop as redundant.
    expect(p).toMatch(/medical emergency\s*\n?\s*means calling 911/);
    expect(p).toMatch(/plus the recording\s*\n?\s*disclosure/i);
    // And the account of what happened when it was truncated, which is the
    // only reason anyone leaves the rule alone.
    expect(p).toMatch(/never told to\s*\n?\s*dial 911 in an emergency/);
  });

  /**
   * The runtime appends its own line, and it is appended ONLY when the prompt
   * does not already contain that phrase (greetingAlreadyPlayed.ts's
   * idempotence guard). If a future edit pastes the runtime's sentence into
   * this prompt, the append silently stops and the lane loses the one
   * statement that is true on the runtime and nowhere else.
   */
  it('leaves the runtime free to append its own already-played line', () => {
    expect(promptSource()).not.toContain('ALREADY been spoken');
    expect(GREETING_ALREADY_PLAYED).toContain('ALREADY been spoken');
  });
});

describe('the contradictions the trim resolved stay resolved', () => {
  it('a failed create_ticket is never an escalation', () => {
    const p = promptSource();
    // Phase 6's own "EXACTLY THREE CASES, NOTHING ELSE" never included a tool
    // failure, and TICKET CONFIRMATION RULES says so outright. Two other
    // places used to say "escalate_to_human" on a failed tool.
    expect(p).not.toMatch(/success=false or error:[\s\S]{0,200}?escalate_to_human/);
    expect(p).not.toMatch(/IF error THEN call escalate_to_human/);
    expect(p).toMatch(/A failed tool is NOT an escalation case/);
  });

  it('nothing promises the caller a recording or a named person', () => {
    const p = promptSource();
    // COMMUNICATION STYLE forbids exactly this, and the Phase 6 closing used
    // to say it anyway.
    expect(p).not.toMatch(/doctor will receive a full recording/i);
    expect(p).toMatch(/Never promise a recording/i);
  });

  it('a missing field never costs the request', () => {
    const p = promptSource();
    expect(p).not.toMatch(/DON'T force create_ticket if you're missing required fields/);
    expect(p).toMatch(/Filing a partial ticket IS the job/);
    expect(p).toMatch(/file the partial ticket/i);
  });
});

describe('the rules the trim had to carry through untouched', () => {
  const MUST_SURVIVE: Array<[string, RegExp]> = [
    ['provider calls escalate immediately', /ESCALATE — type: healthcare_provider — NO EXCEPTIONS/],
    ['exactly three escalation cases', /ESCALATION — EXACTLY THREE CASES, NOTHING ELSE/],
    ['a patient asking for a human is not an emergency', /IS NOT AN\s*\n?EMERGENCY/],
    ['ghost and robot calls never escalate', /NEVER escalate to a human/],
    ['robot calls terminate', /terminate_call with reason "robot_call"/],
    ['ghost calls terminate', /terminate_call with reason "ghost_call"/],
    ['date of birth is asked in parts', /starting with the month, then\s*\n?the day, then the year/],
    ['the create_ticket wait line is still mandatory', /Give me one moment while I get this submitted for you/],
    ['B2B callers are not blocked on a date of birth', /DOB IS OPTIONAL FOR BUSINESS CALLERS/],
    ['new-or-existing is still asked on a lookup miss', /are you a new patient with us, or have you been seen/],
    // These two sections are INTERPOLATED, not written inline, so the thing
    // the trim could have dropped is the call — not the words it renders.
    // Asserting the rendered text would be checking afterHoursTriage.ts, which
    // this change never touched, and would still pass if the interpolation
    // were deleted here.
    ['the triage block is still interpolated', /\$\{renderTriagePrompt\(\)\}/],
    ['the urgent-symptom list is still interpolated', /\$\{URGENT_SYMPTOMS\.symptoms\.map/],
  ];
  it.each(MUST_SURVIVE)('%s', (_label, pattern) => {
    expect(promptSource()).toMatch(pattern);
  });
});

describe('the packaging does not come back', () => {
  it('carries no box-drawing art', () => {
    // 22 rule lines and 242 bordered body lines were 6,989 characters of
    // border and padding carrying no instruction at all.
    expect(AGENT).not.toMatch(/[╔╠╚╗╣╝║╦╩╬]/);
  });

  /**
   * A CEILING, not a measurement. The built prompt was 36,475 characters
   * before this trim and 27,802 after; this bounds the SOURCE of the builder,
   * which is the thing an editor grows. Generous enough for ordinary edits,
   * tight enough that another playbook cannot land unnoticed.
   */
  it('stays inside its source budget', () => {
    expect(promptSource().length).toBeLessThan(34_000);
  });
});
