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
 * THREE THINGS THIS FILE GOT WRONG BEFORE ARRIVING HERE, all found in review:
 *
 *   1. It listed the lanes by hand, hiding `appointment-confirmation` (a
 *      no-transfer lane with no human-request wording AND `filesTickets:
 *      false`) and every unregistered slug. The lane set is now DERIVED.
 *   2. Its load-bearing assertion banned quote CHARACTERS — overbroad (a
 *      directive naming `callback_number` fails) and trivially routed around
 *      (`Say verbatim: I cannot transfer calls.` passes).
 *   3. Its replacement was a finite phrase blocklist, which is the same
 *      weakness one step removed: `Respond with: …` is not on the list.
 *
 * WHAT ACTUALLY HOLDS NOW IS THE TYPE. `NoTransferDirectiveSpec` has three
 * fields — `situation`, `mustDo`, `mustNot` — and **no field in which a
 * sentence for the agent to speak can be placed**. Dictation is not detected
 * after the fact; there is nowhere to put it. The phrase check survives below
 * as a secondary net and is explicitly no longer the guarantee.
 */
import { describe, it, expect, vi } from 'vitest';

// The agent modules validate the environment at import time; a plain
// assignment runs too late. Nothing connects — the value only has to exist.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import {
  conversationLoopGuard,
  noTransferDirectiveSpec,
  renderDirective,
} from './conversationLoopGuard';
import { AGENT_CAPABILITIES, canTransfer, filesTickets } from '../config/agentCapabilities';
import { buildRecordsPrompt } from '../agents/recordsAgent';
import { buildOpticalPrompt } from '../agents/opticalAgent';
import { buildSurgeryPrompt } from '../agents/surgeryAgent';
import { buildTechPrompt } from '../agents/techAgent';

/**
 * What the guard appends after the rendered directive. Mirrored from
 * `exitFor`, which is module-private: a lane that files tickets gets the
 * default exit, one that does not gets nothing.
 */
function exitTextFor(slug: string): string {
  return filesTickets(slug)
    ? 'Create the ticket NOW with whatever you have — the caller\u2019s phone number is attached automatically from caller ID, and missing fields may stay blank. A partial ticket the team can call back on beats a complete interview the caller never finishes.'
    : '';
}

/** The real path: a caller on a no-transfer lane asking for a person. */
function directiveFor(slug: string): string {
  const callId = `test-${slug}-${Math.random()}`;
  const d = conversationLoopGuard.onCallerLine(callId, slug, 'I want to speak to a representative');
  expect(d, `no directive was produced for ${slug}`).not.toBeNull();
  expect(d!.kind).toBe('human_request');
  return d!.text;
}

/**
 * Derived, never listed. Plus one slug deliberately NOT in the registry:
 * `capabilitiesOf` answers "cannot transfer" for anything unknown, so a lane
 * configured only in the database still receives this directive, and it is
 * the case with the least behind it.
 */
const UNREGISTERED = 'lane-that-only-exists-in-the-database';
const NO_TRANSFER_LANES: readonly string[] = [
  ...Object.keys(AGENT_CAPABILITIES).filter((slug) => !AGENT_CAPABILITIES[slug].canTransfer),
  UNREGISTERED,
];

/** Secondary net only. See the header: the type is what holds. */
const DICTATION = [
  'say this',
  'say exactly',
  'say verbatim',
  'verbatim',
  'word-for-word',
  'word for word',
  'these exact words',
  'repeat the following',
  'respond with:',
  'without adding or rephrasing',
];

describe('the directive has no channel for speech', () => {
  it('covers every no-transfer lane in the registry, plus an unregistered one', () => {
    expect(NO_TRANSFER_LANES.length).toBeGreaterThanOrEqual(6);
    expect(NO_TRANSFER_LANES).toContain('appointment-confirmation');
    expect(canTransfer(UNREGISTERED)).toBe(false);
  });

  for (const slug of NO_TRANSFER_LANES) {
    describe(slug, () => {
      /**
       * THE LOAD-BEARING ASSERTION, and it is now about SHAPE rather than
       * content. `situation` is a server-side fact, `mustDo` and `mustNot` are
       * behaviours. There is no `say`, no `script`, no `wording`. A future
       * author who wants to dictate a sentence has to add a field — which
       * fails here — or smuggle it inside a field named for behaviour, which
       * is a visible abuse rather than an invisible edit to a string.
       */
      it('exposes only behaviour fields — nowhere to put a sentence', () => {
        const spec = noTransferDirectiveSpec(slug);
        expect(Object.keys(spec).sort()).toEqual(['mustDo', 'mustNot', 'situation']);
      });

      /**
       * And nothing may be appended outside the structure. The guard adds the
       * lane's exit after the rendered spec; everything before that must be
       * exactly what the renderer produced, so a hand-written sentence cannot
       * be concatenated on at the call site.
       */
      it('is EXACTLY the rendered spec plus the lane exit — nothing appended', () => {
        // startsWith() was the first version of this and it does not enforce
        // "nothing else": a sentence concatenated AFTER the rendered text
        // still starts with it. Compare the whole string (Codex, PR #270).
        const rendered = renderDirective(noTransferDirectiveSpec(slug));
        const exit = exitTextFor(slug);
        expect(directiveFor(slug)).toBe(exit ? `${rendered} ${exit}` : rendered);
      });

      /**
       * The type is the guarantee, and this is what makes it one: every token
       * the spec can carry is a member of a closed union, so prose cannot be
       * put in a field at all. `mustDo: ['Reply: I cannot connect calls']`
       * does not compile.
       */
      it('carries only tokens from the closed vocabulary', () => {
        const spec = noTransferDirectiveSpec(slug);
        const ACTIONS = [
          'STATE_THE_LIMITATION_FIRST',
          'USE_YOUR_OWN_WORDING',
          'TAKE_THE_MESSAGE',
          'REPEAT_THE_SAME_ANSWER_IF_ASKED_AGAIN',
        ];
        expect(ACTIONS).toEqual(expect.arrayContaining([...spec.mustDo]));
        expect(spec.mustNot).toEqual(['NEVER_PROMISE_A_PICKUP']);
        expect(spec.situation).toBe('CALLER_ASKED_FOR_A_PERSON_ON_A_NO_TRANSFER_LINE');
      });

      it('never orders the sentence the 2026-09-03 ruling forbids', () => {
        const text = directiveFor(slug).toLowerCase();
        for (const banned of ['currently busy', 'become available', 'as soon as someone']) {
          expect(text, `directive contains ${JSON.stringify(banned)}`).not.toContain(banned);
        }
      });

      /**
       * The mirror-image failure, and the reason "ban the bad phrases" was
       * never the fix: the old directive ALSO forbade wording an approved
       * prompt uses. A directive that bans a phrase is dictating too.
       */
      it('does not forbid wording an approved prompt uses', () => {
        expect(directiveFor(slug).toLowerCase()).not.toContain('not a person');
      });

      /** Secondary net. Cheap, and it would have caught the 2026-08-17 text. */
      it('carries no verbatim-dictation instruction', () => {
        const text = directiveFor(slug).toLowerCase();
        for (const phrase of DICTATION) {
          expect(text, `directive dictates speech: ${JSON.stringify(phrase)}`).not.toContain(phrase);
        }
      });

      it('still does the guard\'s actual job', () => {
        const text = directiveFor(slug).toLowerCase();
        expect(text).toContain('cannot transfer');
        expect(text).toContain('never promise');
      });

      /**
       * `appointment-confirmation` files no tickets. Telling it to take a
       * message promises a callback nothing will produce — the same class of
       * defect as the dictated sentence, pointed at the caller instead of the
       * prompt. Driven off `filesTickets`, so it follows the registry.
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
      // there is the ruling; only the directive must not carry them.
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
