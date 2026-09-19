/**
 * RULE ZERO 2b/2c ON THE PCP LINE: THE FORMAT BELONGS IN THE QUESTION.
 *
 *   "Everything else that we need, we create a funnel towards — in the
 *    questioning — towards that answer in the way that we need it."
 *
 * Three of PCP's intake questions do not, and each one has its own evidence
 * from the line's first full day, 2026-09-14.
 *
 * ── 1. callerFacilityType, an EIGHT-VALUE ENUM asked as an open question ──
 *
 *     agent   "Which organization are you calling from?"
 *     caller  "Children's Surgery Centers."
 *     agent   "What type of healthcare organization is that?"
 *     caller  "Ambulatory surgery center."
 *
 * That caller got it right. At least six did not, and answered with the
 * ORGANISATION NAME AGAIN — Regal Medical Group four times, Children's Surgery
 * Centers, Optum. The field takes one of `PCP_FACILITY_TYPES` and the question
 * names none of them, so the caller cannot tell it is a multiple choice. This
 * is the defect RULE ZERO 2c describes exactly: not a parser problem, a
 * QUESTION problem.
 *
 * ── 2. patientDob, and PCP is the ONLY lane that asks it bare ──
 *
 * CLAUDE.md's own compliance table lists Rule 2b as satisfied "all four lanes
 * — opticalAgent.ts:193, surgeryAgent.ts:203, techAgent.ts:189,
 * recordsAgent.ts:192, plus no-ivr and answering-service." PCP is absent from
 * that list, and its prompt is "What is the patient's date of birth?" with no
 * format at all. The rule is written in month/day/year parts because that is
 * what makes the answer arrive parseable — and `src/tools/dobParts.ts` records
 * what the alternative costs: shapes real callers used, refused.
 *
 * ── 3. statedRelationship, asked immediately after the same question ──
 *
 *     agent   "What is your role?"
 *     caller  "Vice President, Partnerships."
 *     ...
 *     agent   "What is your professional relationship to this patient?"
 *
 * CLAUDE.md already records this pair getting the same answer twice. The
 * second question wants the caller's relationship to THE PATIENT; worded as it
 * is, directly after a question about their role, it reads as a rephrase.
 *
 * ── WHAT THIS DOES NOT DO ──
 *
 * It does not remove a question or change which fields are required. That is
 * the interrogation (D4) and it is a POLICY change — the operator's, under
 * standing instruction 1 — not something to decide at 2am from a transcript.
 * Every question asked before this change is still asked after it. Only the
 * wording moves, which is the half RULE ZERO actually calls binding.
 */
import { describe, it, expect } from 'vitest';
import { PROMPTS, DESTINATION_PROMPTS, PCP_FACILITY_TYPES } from './director';
import { REQUIRED_PROMPTS } from './ticketRequirements';

describe('callerFacilityType names the choices it accepts', () => {
  const q = PROMPTS.callerFacilityType ?? '';

  it('is not the bare open question six callers answered with the org name', () => {
    expect(q).not.toBe('What type of healthcare organization is that?');
  });

  /** It does not have to list all eight — it has to make the SHAPE obvious.
   *  These four cover the overwhelming majority of this line's callers. */
  it('offers recognisable options rather than asking for a category', () => {
    for (const option of [/doctor'?s office|provider/i, /health plan|insurance/i, /medical group/i, /hospital/i]) {
      expect(q, `no option matching ${option}`).toMatch(option);
    }
  });

  it('is still one question, not a bundle', () => {
    expect(q.split('?').filter((s) => s.trim()).length).toBe(1);
  });

  /** The enum is what the answer has to land in; if a value is added the
   *  question is the thing that has to change with it. */
  it('the enum it funnels into is unchanged by this', () => {
    expect(PCP_FACILITY_TYPES).toContain('pcp_office');
    expect(PCP_FACILITY_TYPES).toContain('health_plan');
    expect(PCP_FACILITY_TYPES).toContain('ipa_medical_group');
    expect(PCP_FACILITY_TYPES).toContain('hospital_medical_facility');
  });
});

describe('patientDob is asked in parts, as the other four lanes ask it', () => {
  const q = PROMPTS.patientDob ?? '';

  it('is not the bare question', () => {
    expect(q).not.toBe("What is the patient's date of birth?");
  });

  it('names month, then day, then year, in that order', () => {
    const month = q.toLowerCase().indexOf('month');
    const day = q.toLowerCase().indexOf('day');
    const year = q.toLowerCase().indexOf('year');
    expect(month, 'no month').toBeGreaterThan(-1);
    expect(day, 'no day').toBeGreaterThan(month);
    expect(year, 'no year').toBeGreaterThan(day);
  });
});

describe('statedRelationship does not read as a rephrase of the role question', () => {
  const role = PROMPTS.callerRole ?? '';
  const rel = PROMPTS.statedRelationship ?? '';

  it('asks about the PATIENT, not about the caller in the abstract', () => {
    expect(rel).toMatch(/patient/i);
  });

  it('is not the wording that drew the same answer twice', () => {
    expect(rel).not.toBe('What is your professional relationship to this patient?');
  });

  it('does not repeat the role question nearly verbatim', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
    expect(norm(rel)).not.toBe(norm(role));
    expect(norm(rel).includes('what is your role')).toBe(false);
  });
});

/**
 * ONE WORDING, NOT TWO. `REQUIRED_PROMPTS` kept its own copies of
 * `callerName` and `callbackNumber`, so the same question existed twice in two
 * files — which is precisely the shape that let the noun lists in
 * `explicitAsk.ts` drift apart and cost the operator his own transfer on
 * CAa2a3a1c1. Same question, one source.
 */
describe('a question is worded in exactly one place', () => {
  it('callerName matches the director', () => {
    expect(REQUIRED_PROMPTS.callerName).toBe(PROMPTS.callerName);
  });
  it('callbackNumber matches the director', () => {
    expect(REQUIRED_PROMPTS.callbackNumber).toBe(PROMPTS.callbackNumber);
  });
});

/**
 * EVERY ASK IS A QUESTION, BECAUSE THE PROMPT DEFINES THE TURN BOUNDARY AS
 * THE QUESTION MARK.
 *
 * `pcpAgent.ts:190` — "Your turn ends the moment the question mark lands." —
 * sits directly under the rule this line's callers complain about most: one
 * question, then silence. A prompt written as a statement gives the model no
 * boundary to stop at, and the sentence after it is the one nobody wants.
 *
 * `patientDob` was the only entry ending in a period (Codex P2, #303). It was
 * also the only one that had drifted from the four queue lanes CLAUDE.md
 * names as Rule 2b-compliant — `opticalAgent.ts:193`, `surgeryAgent.ts:203`,
 * `techAgent.ts:189`, `recordsAgent.ts:192` all say "And may I please have
 * your date of birth, starting with the month, then the day, then the year?"
 * and all four end in a question mark. PCP now says the same thing about the
 * patient, so the format is still inside the question and the turn still has
 * an end.
 *
 * `ticketRequirements.test.ts` and `pcpIntakeDegradation.test.ts` already
 * assert this over `REQUIRED_PROMPTS` and `nextRequiredAsk`. `PROMPTS` — the
 * director's own list, which is where the model actually gets its next
 * question — had no such assertion, which is how a statement got in.
 */
describe('every director ask ends where the turn ends', () => {
  for (const [field, prompt] of Object.entries(PROMPTS)) {
    it(`${field} is a question`, () => expect(prompt).toMatch(/\?$/));
  }

  /**
   * The destination questions too — except `unspecified`, which is empty on
   * purpose: it is the caller declining, and nothing is asked after it.
   */
  for (const [method, prompt] of Object.entries(DESTINATION_PROMPTS)) {
    if (!prompt) continue;
    it(`the ${method} destination is a question`, () => expect(prompt).toMatch(/\?$/));
  }

  it('the patient date of birth still carries its format', () => {
    const dob = PROMPTS.patientDob!;
    expect(dob.toLowerCase().indexOf('month')).toBeLessThan(dob.toLowerCase().indexOf('day'));
    expect(dob.toLowerCase().indexOf('day')).toBeLessThan(dob.toLowerCase().indexOf('year'));
  });
});
