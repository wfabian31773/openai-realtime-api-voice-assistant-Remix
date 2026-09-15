/**
 * THE DRIFT GUARD. Operator, 2026-09-15:
 *
 *   "If the drifting continues then it undoes the runtime, which was the whole
 *    purpose ... maybe put in some type of guard against that type of drifting
 *    to remind you."
 *
 * This file is that guard. It fails when the recognised-caller block is pasted
 * back into an agent, when an agent stops composing from the shared one, when
 * the corrected wording is reverted, or when the greeting stops asking the
 * question the block asserts it already asked.
 *
 * WHY IT EXISTS AS A TEST RATHER THAN A NOTE. The block WAS one rule written
 * four times, and the four copies drifted into a contradiction of each other:
 * tech and records said the greeting had already asked "Am I speaking with
 * <name>?" and optical and surgery told the model to go and ask it. Measured
 * over 2026-09-14/15, on substantive runtime calls whose transcript contains
 * the phrase — the lane's wording is the only variable:
 *
 *   optical (wrong wording)   76 calls,  7 asked TWICE  (9.2%)
 *   surgery (wrong wording)   85 calls,  3 asked TWICE  (3.5%)
 *   tech    (right wording)  142 calls,  0
 *
 * Nothing in review caught that for however long it stood. A test does.
 *
 * READ THE ASSERTIONS AS TWO HALVES. Half of them run the function, and half
 * READ THE AGENT SOURCES — because a suite that only exercises the shared
 * module proves the module works, not that anything calls it, which is
 * recurring failure mode 10 (testing the sink instead of the source). An agent
 * that drops the import and pastes the block back is exactly the regression
 * this guards, and only the file reads can see it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const { recognisedCallerBlock, RECOGNITION_BLOCK_LANES } = await import('./recognisedCallerBlock');
const { personaliseGreeting, greetingStyleFor } = await import(
  '../services/greetingPersonalisation'
);

const agentSource = (module: string) =>
  readFileSync(join(__dirname, '..', 'agents', `${module}.ts`), 'utf8');

/**
 * The agent's source with its full-line comments removed.
 *
 * The paste-back check below asks whether a SECOND COPY OF THE PROMPT TEXT
 * exists in an agent. A comment that quotes the rule is not a second copy —
 * it is documentation, and three of these four agents legitimately carry a
 * line explaining why `pc` must resolve to one person. Scanning the raw file
 * failed two of them for their own comments, and the cheapest way out of that
 * would have been to weaken the sentence list, which is the assertion doing
 * the work.
 *
 * Only whole comment LINES go, never a trailing `//` on a line of code: an
 * over-eager strip could hide a real inline copy, and a guard that fails to
 * fail is worth less than no guard. A prompt line never begins with `//` or
 * `*` — the blocks are markdown with `###` headings and `-` bullets — so
 * nothing the check needs to see is removed.
 */
const agentPromptText = (module: string) =>
  agentSource(module)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

const BLOCK = recognisedCallerBlock({ matched: true, firstName: 'Wayne' });

describe('the block is composed from ONE copy, and every lane imports it', () => {
  /**
   * THE TABLE IS THE GUARD, SO THE TABLE IS PINNED.
   *
   * Every check below walks `RECOGNITION_BLOCK_LANES`, which means deleting a
   * lane from it silently stops guarding that lane — the failure shape this
   * whole file exists to prevent, one level up. A directory-wide sweep is not
   * the answer: `answeringServiceAgent` and `azulSchedulingPrompt` legitimately
   * carry their own "Am I speaking with" wording and are not on this runtime.
   *
   * So the membership is stated here. It does not stop anyone changing it; it
   * stops the change being invisible, and sends whoever makes it to this file.
   */
  it('guards every lane that composes from the shared block', () => {
    expect(RECOGNITION_BLOCK_LANES.map((l) => `${l.slug}:${l.module}`)).toEqual([
      'optical:opticalAgent',
      'surgery:surgeryAgent',
      'tech:techAgent',
      'records:recordsAgent',
    ]);
  });

  for (const { module } of RECOGNITION_BLOCK_LANES) {
    it(`${module} imports recognisedCallerBlock`, () => {
      expect(agentSource(module)).toMatch(
        /import\s*\{[^}]*\brecognisedCallerBlock\b[^}]*\}\s*from\s*'\.\.\/runtime\/recognisedCallerBlock'/,
      );
    });

    it(`${module} calls it rather than building its own`, () => {
      expect(agentSource(module)).toMatch(/recognisedCallerBlock\s*\(/);
    });

    // The one that catches a paste-back. These sentences belong to the shared
    // module; finding any of them in an agent means a second copy exists, and
    // a second copy is what drifted last time.
    for (const sentence of [
      'matches one person on file',
      'Am I speaking with',
      'ignore this block',
      'Disclose nothing',
    ]) {
      it(`${module} does not carry an inline copy: "${sentence}"`, () => {
        expect(agentPromptText(module)).not.toContain(sentence);
      });
    }
  }
});

describe('the block states what the greeting actually did', () => {
  // The first bullet asserts, as fact, that the greeting has ALREADY asked the
  // question. optical and surgery said the opposite for as long as they had
  // their own copies, and the cost is measured in this file's header.
  it('says the greeting already ASKED it', () => {
    expect(BLOCK).toContain('Your greeting has already ASKED "Am I speaking with Wayne?"');
  });

  it('forbids asking it a second time', () => {
    expect(BLOCK).toContain('do NOT ask it twice');
  });

  it('does not tell the model to go and confirm — that was the drifted wording', () => {
    expect(BLOCK).not.toMatch(/go straight to confirming/i);
  });

  // The claim above is only true because the greeting is personalised. If a
  // lane's greeting stops asking, the block starts lying to the model — so the
  // guard checks the greeting rather than trusting the sentence.
  for (const { slug } of RECOGNITION_BLOCK_LANES) {
    it(`${slug}'s own greeting really does ask it`, () => {
      const style = greetingStyleFor(slug);
      expect(style, `${slug} has no greeting style, so nothing asks the question`).not.toBeNull();
      const spoken = personaliseGreeting(
        'Thank you for calling Azul Vision. How can I help you today?',
        'Wayne',
        style,
      );
      expect(spoken).toContain('Am I speaking with Wayne?');
    });
  }
});

describe('an affirmed greeting ends the identity step', () => {
  // RULE ZERO step 2 is validation, and the affirmation IS the validation: 228
  // callers answered yes and 13 answered no over 2026-09-14/15, so the question
  // discriminates. The old wording treated the answer as worthless and asked
  // for the surname anyway — which handed `verifiedDobFor`'s name guard a
  // comparison that should never have existed. 19 of the 30 certain-phone
  // date-of-birth refusals of 2026-09-14 were greeted by name and then asked
  // for their last name (`src/tools/dobNameMismatch.test.ts`, the corpus).
  it('does not ask for a last name after a yes', () => {
    expect(BLOCK).toContain('Do not ask for their last name');
  });

  it('does not ask for a date of birth after a yes', () => {
    expect(BLOCK).toContain('do not ask for their date of birth');
  });

  it('still self-destructs on a denial — a phone match is a candidate, not an identity', () => {
    expect(BLOCK).toMatch(/If they said NO[\s\S]*ignore this block/);
  });

  it('discloses nothing on the strength of the match alone', () => {
    expect(BLOCK).toContain('Disclose nothing');
  });

  // KEPT FROM THE OLD INLINE BLOCK, and it was nearly lost in the move: the
  // first draft of the shared module carried this bullet's REASONING and
  // dropped its imperative. `opticalAgent.test.ts` caught it, which is the
  // only lane that had a test — three of the four inline copies were pinned
  // by nothing at all, and that is how they drifted. It is a separate rule
  // from the two above: those govern what happens AFTER the caller answers,
  // this governs the opening, which comes first.
  it('never opens by asking a recognised caller to identify themselves', () => {
    expect(BLOCK).toMatch(/NEVER open with "can I get your name and date of birth"/i);
  });
});

describe('an unrecognised caller gets no block at all', () => {
  // Deliberately empty rather than a "we do not know you" block: a prompt that
  // names what it does NOT have invites the model to say so out loud.
  it.each([
    ['undefined pre-context', undefined],
    ['matched with no name', { matched: true }],
    ['a name with no match', { firstName: 'Wayne' }],
    ['matched false', { matched: false, firstName: 'Wayne' }],
  ])('%s yields nothing', (_label, pc) => {
    expect(recognisedCallerBlock(pc as never)).toBe('');
  });

  it('uses the caller’s own first name when there is one', () => {
    expect(recognisedCallerBlock({ matched: true, firstName: 'Rosa' })).toContain(
      'Am I speaking with Rosa?',
    );
  });
});
