/**
 * src/services/noTransferDirective.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER MUST NOT PUT WORDS IN THE AGENT'S MOUTH.
 *
 * `queuePromptRulings.test.ts` pins what each lane's PROMPT must still say. It
 * cannot see the other half of what the model is told: the loop guard's
 * mid-call `SERVER STATE CHECK` directives. Those outrank the prompt by
 * construction — `answeringServiceAgent` says, in as many words, "If a SERVER
 * STATE CHECK system message appears mid-call... follow it exactly."
 *
 * So a directive that dictates a sentence silently overrides every ruling the
 * operator wrote into a prompt, and no prompt test can detect it. From
 * 2026-08-17 until this file was written, the no-transfer directive ordered,
 * word-for-word:
 *
 *   "All of our agents are currently busy at the moment — I can take a message
 *    and have the team contact you as soon as they become available."
 *
 * which contradicted two live prompts at once: RECORDS (and optical, surgery,
 * tech) forbid that exact sentence on the operator's 2026-09-03 ruling, and
 * ANSWERING SERVICE's approved script opens "I'm not able to transfer you to
 * someone — I'm not a person and I can't connect calls" while the same
 * directive said never to say you are "not a person".
 *
 * TWO THINGS THIS FILE GOT WRONG ON ITS FIRST DRAFT, both found in review:
 *
 *   1. It listed the lanes by hand. That hid `appointment-confirmation` — a
 *      no-transfer lane with NO human-request wording in its prompt and, worse,
 *      `filesTickets: false` — and hid every unregistered slug, which falls
 *      back to the conservative cannot-transfer default. The lane set is now
 *      DERIVED from the capability registry, so a lane cannot hide from it.
 *      (An unregistered slug still gets `filesTickets: true`; the conservative
 *      default differs per field, and a first draft of this file asserted it
 *      was false for both. The mutation run said otherwise.)
 *   2. Its load-bearing assertion banned quote CHARACTERS. That is not the
 *      invariant: it rejects a directive that legitimately names a field like
 *      callback_number, while `Say verbatim: I cannot transfer calls.` dictates
 *      speech and passes. Punctuation was never the property. What follows
 *      tests the two things that actually matter — no verbatim-dictation
 *      instruction, and no conflict with the lane's own prompt.
 */
import { describe, it, expect, vi } from 'vitest';

// The agent modules validate the environment at import time; a plain
// assignment runs too late. Nothing connects — the value only has to exist.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { conversationLoopGuard } from './conversationLoopGuard';
import { AGENT_CAPABILITIES, canTransfer, filesTickets } from '../config/agentCapabilities';
import { buildRecordsPrompt } from '../agents/recordsAgent';
import { buildOpticalPrompt } from '../agents/opticalAgent';
import { buildSurgeryPrompt } from '../agents/surgeryAgent';
import { buildTechPrompt } from '../agents/techAgent';

/** The real path: a caller on a no-transfer lane asking for a person. */
function directiveFor(slug: string): string {
  const callId = `test-${slug}-${Math.random()}`;
  const d = conversationLoopGuard.onCallerLine(callId, slug, 'I want to speak to a representative');
  expect(d, `no directive was produced for ${slug}`).not.toBeNull();
  expect(d!.kind).toBe('human_request');
  return d!.text;
}

/**
 * Derived, never listed. Plus one slug that is deliberately NOT in the
 * registry: `capabilitiesOf` answers "cannot transfer" for anything unknown,
 * so a lane configured in the database and never added here still receives
 * this directive, and it is the case with the least behind it.
 */
const UNREGISTERED = 'lane-that-only-exists-in-the-database';
const NO_TRANSFER_LANES: readonly string[] = [
  ...Object.keys(AGENT_CAPABILITIES).filter((slug) => !AGENT_CAPABILITIES[slug].canTransfer),
  UNREGISTERED,
];

/** Instructions that hand the model a script. The failure was one of these. */
const DICTATION = [
  'say this',
  'say exactly',
  'say verbatim',
  'verbatim',
  'word-for-word',
  'word for word',
  'these exact words',
  'the following sentence',
  'repeat the following',
  'without adding or rephrasing',
];

describe('the no-transfer directive dictates behaviour, never wording', () => {
  it('covers every no-transfer lane in the registry, plus an unregistered one', () => {
    // Guards the guard: if someone adds a no-transfer lane, it joins this
    // suite automatically. A shrinking set means the derivation broke.
    expect(NO_TRANSFER_LANES.length).toBeGreaterThanOrEqual(6);
    expect(NO_TRANSFER_LANES).toContain('appointment-confirmation');
    expect(canTransfer(UNREGISTERED)).toBe(false);
  });

  for (const slug of NO_TRANSFER_LANES) {
    describe(slug, () => {
      /**
       * THE LOAD-BEARING ASSERTION. Not "contains no quote marks" — that is
       * punctuation, and a future author would delete the quotes rather than
       * give the wording back to the prompt. This is the instruction itself.
       */
      it('never tells the agent to say something verbatim', () => {
        const text = directiveFor(slug).toLowerCase();
        for (const phrase of DICTATION) {
          expect(text, `directive dictates speech: ${JSON.stringify(phrase)}`).not.toContain(phrase);
        }
      });

      it('never orders the sentence the 2026-09-03 ruling forbids', () => {
        const text = directiveFor(slug).toLowerCase();
        for (const banned of ['currently busy', 'become available', 'as soon as someone']) {
          expect(text, `directive contains ${JSON.stringify(banned)}`).not.toContain(banned);
        }
      });

      /**
       * The mirror-image failure, and the reason "ban the bad phrases" is not
       * the fix: the old directive ALSO forbade wording an approved prompt
       * uses. A directive that bans a phrase is dictating too.
       */
      it('does not forbid wording an approved prompt uses', () => {
        expect(directiveFor(slug).toLowerCase()).not.toContain('not a person');
      });

      it('still does the guard\'s actual job', () => {
        const text = directiveFor(slug).toLowerCase();
        expect(text).toContain('cannot transfer');
        expect(text).toContain('never promise');
      });

      /**
       * `appointment-confirmation` files no tickets. Telling it to take a
       * message or create one promises a callback that nothing will produce —
       * the same class of defect as the dictated sentence, just pointed at
       * the caller instead of the prompt. Driven off `filesTickets` rather
       * than a slug, so it follows the registry wherever it goes.
       */
      it('promises a message only where the lane can actually file one', () => {
        const text = directiveFor(slug).toLowerCase();
        if (filesTickets(slug)) {
          expect(text).toContain('take the message');
        } else {
          expect(text).not.toContain('take the message');
          expect(text).not.toContain('create the ticket');
        }
      });
    });
  }
});

/**
 * The cross-check that ties the two halves together, and the one that actually
 * caught the original bug. If a future edit reopens the contradiction from
 * either side — the directive starts dictating, or a prompt starts forbidding
 * something the directive says — this fails.
 */
describe('directive and prompt do not contradict each other', () => {
  const PROMPTS: ReadonlyArray<readonly [string, string]> = [
    ['records', buildRecordsPrompt({ callerPhone: '+17605551234' })],
    ['optical', buildOpticalPrompt({ callerPhone: '+17605551234' })],
    ['surgery', buildSurgeryPrompt({ callerPhone: '+17605551234' })],
    ['tech', buildTechPrompt({ callerPhone: '+17605551234' })],
  ];

  for (const [slug, prompt] of PROMPTS) {
    it(`${slug}: the directive says nothing its prompt forbids`, () => {
      const hay = prompt.toLowerCase();
      const text = directiveFor(slug).toLowerCase();
      // These phrases appear in the prompt AS PROHIBITIONS, so their presence
      // there is the ruling; it is only the directive that must not carry them.
      for (const banned of ['currently busy', 'as soon as someone']) {
        if (hay.includes(banned)) {
          expect(
            text,
            `${slug}'s prompt forbids ${JSON.stringify(banned)} and the directive orders it`,
          ).not.toContain(banned);
        }
      }
    });
  }
});
