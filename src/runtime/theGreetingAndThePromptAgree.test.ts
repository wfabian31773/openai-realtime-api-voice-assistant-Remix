import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

const { recognisedCallerBlock, identityAskScript, identityCertainMeaning, greetingNamedThem, RECOGNITION_BLOCK_LANES } =
  await import('./recognisedCallerBlock');
const { personaliseGreeting, greetingStyleFor, recognisedFirstName } = await import(
  '../services/greetingPersonalisation'
);
const { buildOpticalPrompt } = await import('../agents/opticalAgent');
const { buildSurgeryPrompt } = await import('../agents/surgeryAgent');
const { buildTechPrompt } = await import('../agents/techAgent');
const { buildRecordsPrompt } = await import('../agents/recordsAgent');

/**
 * v157 — THE PROMPT DESCRIBES THE GREETING THE CALLER HEARD.
 *
 * #384 (VA-76205) made `recognisedFirstName` return no name for an
 * unvalidated caller-ID match, so from the 2026-10-30 deploy no queue-lane
 * greeting said "Am I speaking with <name>?". The recognised-caller block
 * went on telling the model the greeting had asked it, with the name in it.
 *
 * Corpus, 2026-10-30: recognised callers (pre-context stored an identity)
 * refused by a filing tool for a date of birth the record held —
 * optical CA69a3b6d8274ede8cee7cb1a818e7ef06, CAadf2e34d5723ae1e50fa3183a9a192c5;
 * surgery CA06f261bcdd3b95fda0710954c3989889, CA46bb10afc41dcc81ba05c1cfe4c50b14,
 * CA216c743df359cdf8d00a90bff0aa3e07, CAdead5c981d5a7038d3d951c6846675bf,
 * CAe5324707f3d06bcf60e6116335de5bac, CAaf72d99aa4ca3145cbab4a941872d20f;
 * tech CA492ab9e883d80fefb45749419c0f8728, CA0226907f3f824dc60d5420223759acc2,
 * CAf2d83f16cb84e1c2c6acafda10b89da1, CA0a9a4941ca32abe630e89abf44932699,
 * CA8917a5807762e95cfd02835caa6ef23e, CA3262a8fddc4641f837eba5685d7e6247,
 * CAbf3db22d5eb977172fda4f4c82a02ae4, CAcbb298032d596f39d38b855f7a274e94,
 * CAa9121ab28ac023f1cb8b7dfd48beda96, CAfbb68e46b4c89e179030f201127e51c3,
 * CA183e9e7fc9501090d57f28d35a8f3336, CA990dfa0a0fcee7086a2f492232203e22,
 * CA8f964c4be5ece3447387fa4b5e895972, CA538d6903d9ccee6f36361e58b7ec578c,
 * CA3f643b5193d5b0f4796103402d4c23e0, CAc48d9b2c80adde146312070ca1d5f680,
 * CA66738dfbeba847b3de62e18fcfe62aeb, CA7571eb971727523d747cedc556e9fae0,
 * CA48a8641a6ffcdf6590a0ffc1bbd88b27, CA1c78861f98e25c6403641da3208ed4f7,
 * CA1ecb4216b73ca6200159b130232094eb, CA04c23871f54f7024393b7126c298473a.
 * 30 refusals against 3 on 10-29, when every recognised caller was greeted by
 * name. Synthetic stand-ins below; the real names stay out of git.
 *
 * v170 (operator, 2026-11-03) restores the named greeting, so an unvalidated
 * caller-ID match is greeted by name again and the block says so. The
 * agreement property below is unchanged and still holds in every arm; the
 * candidate arm v157 added for a match the greeting did not name is gone,
 * because no matched caller with a first name can reach it.
 * `theNamedGreetingIsAHardRule.test.ts` runs the corpus above against v170.
 */

const GREETING = 'Thank you for calling Azul Vision. How can I help you today?';
const CANDIDATE = { matched: true, firstName: 'Alex' };
const VALIDATED = { matched: true, firstName: 'Alex', identityValidated: true };

const builders: Array<[string, (m: { precontext?: unknown; callerPhone?: string }) => string]> = [
  ['optical', buildOpticalPrompt as never],
  ['surgery', buildSurgeryPrompt as never],
  ['tech', buildTechPrompt as never],
  ['records', buildRecordsPrompt as never],
];

/** What the runtime speaks: the same two functions voiceRuntime calls. */
const spokenGreeting = (slug: string, pc: unknown) =>
  personaliseGreeting(GREETING, recognisedFirstName(pc), greetingStyleFor(slug));

describe('the prompt says the greeting asked for a name only when it did (v157)', () => {
  // The guard #384 walked past: the old one passed a literal name to
  // personaliseGreeting and never went through recognisedFirstName.
  for (const [lane, build] of builders) {
    for (const [label, pc] of [
      ['an unvalidated caller-ID match', CANDIDATE],
      ['a validated match', VALIDATED],
    ] as const) {
      it(`${lane}, ${label}: the block's claim matches the greeting the runtime builds`, () => {
        const greetingAsks = spokenGreeting(lane, pc).includes('Am I speaking with');
        const promptClaims = build({ precontext: pc, callerPhone: '+15550001111' }).includes(
          'Your greeting has already ASKED',
        );
        expect(promptClaims).toBe(greetingAsks);
      });
    }
  }

  it('the four lanes this covers are the four that compose the block', () => {
    expect(builders.map(([l]) => l).sort()).toEqual(RECOGNITION_BLOCK_LANES.map((l) => l.slug).sort());
  });
});

describe('a caller-ID match is greeted by name again, and the block says so (v170)', () => {
  for (const [lane, build] of builders) {
    const prompt = build({ precontext: CANDIDATE, callerPhone: '+15550001111' });

    it(`${lane}: the greeting asks the candidate by first name`, () => {
      expect(spokenGreeting(lane, CANDIDATE)).toContain('Am I speaking with Alex?');
    });

    it(`${lane}: the prompt says the greeting asked, and a yes ends the identity step`, () => {
      expect(prompt).toContain('Your greeting has already ASKED "Am I speaking with Alex?"');
      expect(prompt).toMatch(/If they said YES, the identity step is DONE/);
      expect(prompt).not.toContain('This number matches someone on file');
    });
  }

  it('greetingNamedThem is true, and the ask script and the meaning take the recognised arm', () => {
    expect(greetingNamedThem(CANDIDATE)).toBe(true);
    expect(identityAskScript(CANDIDATE)).toContain('the block above says\nnot to ask');
    expect(identityCertainMeaning(CANDIDATE)).toContain('Then confirm the');
  });

  it('a validated match keeps the named block, word for word as before', () => {
    expect(greetingNamedThem(VALIDATED)).toBe(true);
    expect(recognisedCallerBlock(VALIDATED)).toContain('Your greeting has already ASKED "Am I speaking with Alex?"');
  });

  it('a blank first name names nobody, in the greeting or the prompt', () => {
    const blank = { matched: true, firstName: '   ' };
    expect(spokenGreeting('optical', blank)).not.toContain('Am I speaking with');
    expect(greetingNamedThem(blank)).toBe(false);
    expect(recognisedCallerBlock(blank)).toBe('');
  });

  it('no match is unchanged: no block at all', () => {
    expect(recognisedCallerBlock(undefined)).toBe('');
    expect(recognisedCallerBlock({ matched: false, firstName: 'Alex' } as never)).toBe('');
    expect(recognisedCallerBlock({ matched: true } as never)).toBe('');
  });
});

describe('the SIP greeting decides by the same recognisedFirstName (v157, Codex on #411)', () => {
  it('voiceAgentRoutes takes the name from recognisedFirstName, not raw precontext.firstName', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'voiceAgentRoutes.ts'), 'utf8');
    expect(src).toContain('sharedRecognisedFirstName(azulMetadataRef?.precontext)');
    expect(src).not.toMatch(/precontext\?\.matched\s*\?\s*String\(azulMetadataRef\.precontext\.firstName/);
  });
});
