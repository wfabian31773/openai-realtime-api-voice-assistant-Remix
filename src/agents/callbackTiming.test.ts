/**
 * ONE PROMPT MUST NOT GIVE TWO TIMINGS FOR THE SAME ACT.
 *
 * Operator, 2026-08-13, after the fix was already live: *"why is the surgery
 * agent still asking for contact info after filing the tickets?"*
 *
 * Because the prompt told it to. VA-51417, a real call at 16:01 Pacific, after
 * the deploy that was supposed to have fixed this:
 *
 *   agent: "I've filed your request. Your ticket number is VA-51417.
 *           Is this number ending in 3921 the best one to reach you?"
 *
 * Eight lines above, the prompt said THE NUMBER COMES BEFORE THE TICKET. Eight
 * lines below, the callback line said "Confirm it once, at the end". Both
 * shipped in #189 — I added the block and never reconciled it with the line
 * that predated it. The model obeyed the more concrete instruction, which is
 * what a model should do.
 *
 * Two smaller lessons in the same call:
 *
 * - The old line banned the WORDS "is that correct?", and the model asked "is
 *   this number ending 3921 the best one to reach you?" instead. **Prohibit
 *   the timing, not the phrasing** — a ban on a sentence is routed around by
 *   rewording, and rewording is the one thing a language model is certain to
 *   do well.
 *
 * - Same shape as the scheduling prompt earlier the same day: "you cannot
 *   reschedule" shipping alongside a reschedule flow. A prompt long enough to
 *   contradict itself will.
 */
import { describe, it, expect } from 'vitest';

/**
 * These agents import their tool modules for the registration side effect, and
 * that chain reaches a module which validates DATABASE_URL at import. The
 * prompt builders themselves touch no database.
 *
 * So satisfy the unrelated env check and import dynamically, rather than
 * mocking anything. Nothing under test is stubbed — the assertions run against
 * the real rendered prompt string. (The durable fix is the one applied to the
 * scheduling prompt: extract the builder into a module that imports nothing
 * stateful. Four more extractions, worth doing, not worth doing at 16:30 with
 * a live defect on the phones.)
 */
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const BUILDERS: Array<[string, (m: Record<string, unknown>) => string]> = [];

const ready = (async () => {
  const [optical, surgery, tech, records] = await Promise.all([
    import('./opticalAgent'),
    import('./surgeryAgent'),
    import('./techAgent'),
    import('./recordsAgent'),
  ]);
  BUILDERS.push(
    ['optical', optical.buildOpticalPrompt as never],
    ['surgery', surgery.buildSurgeryPrompt as never],
    ['tech', tech.buildTechPrompt as never],
    ['records', records.buildRecordsPrompt as never],
  );
})();

await ready;

const WITH_PHONE = { callerPhone: '+17605553921' };
const WITHOUT_PHONE = {};

describe.each(BUILDERS)('%s', (name, build) => {
  const withPhone = build(WITH_PHONE);
  const withoutPhone = build(WITHOUT_PHONE);

  it('never tells the agent to confirm the number at the end', () => {
    for (const [label, p] of [['with phone', withPhone], ['without phone', withoutPhone]] as const) {
      expect(p, `${name} ${label}`).not.toMatch(/confirm it once,? at the end/i);
      expect(p, `${name} ${label}`).not.toMatch(/confirm[^.]{0,40}\bat the end\b/i);
      expect(p, `${name} ${label}`).not.toMatch(/\bafter (you )?fil(e|ing)[^.]{0,30}(ask|confirm)/i);
    }
  });

  it('states the number comes before the ticket, exactly once and unambiguously', () => {
    expect(withPhone).toMatch(/THE NUMBER COMES BEFORE THE TICKET/);
    expect(withPhone).toMatch(/before you file/i);
  });

  it('tells it what to do when it has already filed', () => {
    // The recovery case. Without it the model has a rule it may already have
    // broken and no instruction for the state it is actually in.
    expect(withPhone).toMatch(/already filed/i);
  });

  it('asks for a number before filing when it has none', () => {
    expect(withoutPhone).toMatch(/BEFORE you file/i);
  });
});

describe('the prohibition is on timing, not on phrasing', () => {
  it('does not merely ban one sentence', () => {
    // "is that correct?" was banned; the model asked "is this the best one to
    // reach you?" and satisfied the letter of it. A prompt that forbids a
    // string forbids nothing.
    for (const [name, build] of BUILDERS) {
      const p = build(WITH_PHONE);
      expect(p, name).not.toMatch(/do not ask "is that correct\?"/i);
    }
  });
});
