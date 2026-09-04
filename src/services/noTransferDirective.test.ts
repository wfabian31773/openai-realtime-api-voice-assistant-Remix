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
 * operator wrote into a prompt, and no prompt test can detect it. That is not
 * hypothetical. From 2026-08-17 until this file was written, the no-transfer
 * directive ordered, word-for-word:
 *
 *   "All of our agents are currently busy at the moment — I can take a message
 *    and have the team contact you as soon as they become available."
 *
 * which contradicted two live prompts at once:
 *
 *   - RECORDS forbids that exact sentence on the operator's 2026-09-03 ruling
 *     (never imply a human is about to come free). The server was ordering the
 *     violation the prompt existed to prevent. Records said it live at 20:43
 *     on 2026-09-03; the prompt ruling landed at 21:04; the server directive
 *     was still ordering it at midnight and is on `main` today.
 *   - ANSWERING SERVICE's approved script opens "I'm not able to transfer you
 *     to someone — I'm not a person and I can't connect calls", while the same
 *     directive said never to say you are "not a person".
 *
 * The invariant below is the general form: the guard says WHAT TO DO and the
 * prompt says WHAT TO SAY. Anything else is two authors writing one sentence.
 */
import { describe, it, expect, vi } from 'vitest';

// The agent modules validate the environment at import time; a plain
// assignment runs too late. Nothing connects — the value only has to exist.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { conversationLoopGuard } from './conversationLoopGuard';
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

const NO_TRANSFER_LANES = ['records', 'optical', 'surgery', 'tech', 'answering-service'] as const;

describe('the no-transfer directive dictates behaviour, never wording', () => {
  for (const slug of NO_TRANSFER_LANES) {
    describe(slug, () => {
      /**
       * THE LOAD-BEARING ASSERTION. A quoted span is the server supplying a
       * sentence, and a supplied sentence cannot be overruled by the prompt
       * that is supposed to own it. Keep directives free of quoted speech and
       * this whole class of contradiction cannot recur — including forms
       * nobody has thought of yet, which is why this is a shape check and not
       * a list of banned phrases.
       */
      it('quotes no sentence for the agent to read out', () => {
        const text = directiveFor(slug);
        expect(text, 'the directive contains a quoted sentence').not.toMatch(/["“”]/);
      });

      it('never orders the sentence the 2026-09-03 ruling forbids', () => {
        const text = directiveFor(slug).toLowerCase();
        for (const banned of ['currently busy', 'become available', 'as soon as someone']) {
          expect(text, `directive contains ${JSON.stringify(banned)}`).not.toContain(banned);
        }
      });

      /**
       * The mirror-image failure, and the reason "just ban the bad phrases"
       * is not the fix: the old directive ALSO forbade wording an approved
       * prompt uses. A directive that bans a phrase is dictating too.
       */
      it('does not forbid wording an approved prompt uses', () => {
        const text = directiveFor(slug).toLowerCase();
        expect(text).not.toContain('not a person');
      });

      it('still does the guard\'s actual job', () => {
        const text = directiveFor(slug).toLowerCase();
        expect(text).toContain('cannot transfer');
        expect(text).toMatch(/take the message|take a message/);
        expect(text).toContain('never promise');
      });
    });
  }
});

/**
 * The cross-check that ties the two halves together. If a future edit reopens
 * the contradiction from either side — the directive starts dictating, or a
 * prompt starts forbidding something the directive says — this fails.
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
      // Every phrase these prompts name as forbidden. Their PRESENCE in the
      // prompt is the ruling (it is written as a prohibition), so it is only
      // the DIRECTIVE that must not contain them.
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
