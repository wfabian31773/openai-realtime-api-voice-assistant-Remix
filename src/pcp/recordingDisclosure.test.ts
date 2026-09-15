/**
 * 219 CALLS ON THE PCP LINE, NOT ONE OF THEM TOLD THE CALLER IT WAS RECORDED.
 *
 * The greeting on every call of 2026-09-14 was, verbatim:
 *
 *     "Thank you for calling Azul Vision PCP Support. How can I help you
 *      today?"
 *
 * No disclosure, and no statement that the caller is speaking to an automated
 * system. California is a two-party-consent state and this is a healthcare
 * practice, so that is a compliance gap rather than a stylistic one — task #79
 * carries the same gap for the four queue lines, and it is not fixed here.
 *
 * THE WORDING IS NOT INVENTED. `noIvrAgent` has carried an operator-approved
 * disclosure since before the cutover, and this reuses that clause verbatim
 * rather than writing a new one:
 *
 *     "All calls are being recorded for quality assurance purposes"
 *
 * WHAT IS DELIBERATELY NOT COPIED FROM IT: the "dial 911" sentence and the
 * "our offices are currently closed" sentence. no-ivr carries those because it
 * is the after-hours line with no humans behind it; PCP is a business-hours
 * professional line and adding a clinical-safety instruction to it would be
 * inventing a rule rather than applying one (standing instruction 1).
 *
 * WHY THE GREETING AND NOT THE PROMPT: on the runtime the bridge plays the
 * greeting as audio BEFORE the model's first turn, and `withGreetingAlreadyPlayed`
 * then tells the model it has already been spoken. A disclosure written into
 * the prompt would be a disclosure the model may or may not say; written here
 * it is on every call by construction. That is the same reasoning #299 applied
 * to the no-ivr greeting block a day earlier.
 */
import { describe, it, expect, vi } from 'vitest';

/** pcpAgent pulls in the db through toolTimeline at import time. */
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const { pcpAgentConfig } = await import('../agents/pcpAgent');

const greeting = pcpAgentConfig.greeting;

describe('the PCP greeting discloses recording', () => {
  it('says the call is recorded', () => {
    expect(greeting).toMatch(/recorded/i);
  });

  it('reuses the operator-approved clause rather than a new one', () => {
    expect(greeting).toContain('recorded for quality assurance purposes');
  });

  it('still identifies the line and still invites the caller to speak', () => {
    expect(greeting).toMatch(/Azul Vision PCP Support/);
    expect(greeting).toMatch(/help you today\?$/);
  });

  /**
   * The disclosure has to be heard before the caller starts talking, so it
   * belongs ahead of the open question rather than tacked on the end.
   */
  it('discloses BEFORE it asks how it can help', () => {
    expect(greeting.toLowerCase().indexOf('recorded')).toBeLessThan(
      greeting.toLowerCase().indexOf('help you today'),
    );
  });

  /**
   * The bridge plays this as audio ahead of the model's first turn, so every
   * word is dead air the caller waits through. no-ivr's full greeting — which
   * also carries the closure notice and the 911 instruction — is the ceiling,
   * and PCP has no reason to approach it.
   */
  it('stays short enough to be a greeting', () => {
    expect(greeting.length).toBeLessThan(180);
  });

  /** Not copied from no-ivr, and deliberately: PCP is a business-hours
   *  professional line, not the after-hours service. */
  it('does not borrow the after-hours sentences', () => {
    expect(greeting).not.toMatch(/911/);
    expect(greeting).not.toMatch(/offices are currently closed/i);
  });
});
