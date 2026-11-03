/**
 * THE NAMED GREETING IS A HARD RULE — v170.
 *
 * Operator, 2026-11-03: *"that was a hard rule and should have never been
 * replaced, I want the familiar greeting back please."*
 *
 * A caller whose number matches ONE person on file is greeted with
 * "Am I speaking with <first name>?". That question is RULE ZERO step 2: the
 * phone match is a candidate, and the caller's own yes or no confirms it or
 * throws it away (v27, v140). #384 (VA-76205, merged 2026-10-29) made the
 * greeting's name require `identityValidated`, which nothing sets at greeting
 * time, so from the 2026-10-30 deploy no queue-lane greeting said a name:
 * optical, surgery and tech, first agent line, 245 of 355 on 10-29 against
 * 0 of 433 on 11-02.
 *
 * What it cost, by real CallSid (synthetic names below; real ones stay out of
 * git). Every call here had a pre-context candidate stored
 * (`identity_summary.precontextWrite = 'stored'`) and heard the generic
 * greeting instead of its name:
 *
 *   - 2026-10-30, recognised callers refused by a filing tool for a date of
 *     birth the record held (the v157 corpus; 30 such refusals against 3 on
 *     10-29, when every recognised caller was greeted by name).
 *   - 2026-11-02, callers who heard the voicemail-sounding greeting, left
 *     their whole message in one breath and hung up, and left no ticket
 *     (#421's corpus; 9 of that day's 10 lost requests were this shape).
 *
 * This file fails if the greeting ever again demands more than a matched
 * caller with a first name.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

type Builder = (m: { precontext?: unknown; callerPhone?: string }) => string;

let personaliseGreeting: typeof import('../services/greetingPersonalisation')['personaliseGreeting'];
let greetingStyleFor: typeof import('../services/greetingPersonalisation')['greetingStyleFor'];
let recognisedFirstName: typeof import('../services/greetingPersonalisation')['recognisedFirstName'];
let chooseGreeting: typeof import('./voiceRuntime')['chooseGreeting'];
let RECOGNITION_BLOCK_LANES: typeof import('./recognisedCallerBlock')['RECOGNITION_BLOCK_LANES'];
const LANES: Record<string, { greeting: string; build: Builder }> = {};

beforeAll(async () => {
  const gp = await import('../services/greetingPersonalisation');
  personaliseGreeting = gp.personaliseGreeting;
  greetingStyleFor = gp.greetingStyleFor;
  recognisedFirstName = gp.recognisedFirstName;
  chooseGreeting = (await import('./voiceRuntime')).chooseGreeting;
  RECOGNITION_BLOCK_LANES = (await import('./recognisedCallerBlock')).RECOGNITION_BLOCK_LANES;
  const [optical, surgery, tech, records] = await Promise.all([
    import('../agents/opticalAgent'),
    import('../agents/surgeryAgent'),
    import('../agents/techAgent'),
    import('../agents/recordsAgent'),
  ]);
  LANES.optical = { greeting: optical.opticalAgentConfig.greeting, build: optical.buildOpticalPrompt as never };
  LANES.surgery = { greeting: surgery.surgeryAgentConfig.greeting, build: surgery.buildSurgeryPrompt as never };
  LANES.tech = { greeting: tech.techAgentConfig.greeting, build: tech.buildTechPrompt as never };
  LANES.records = { greeting: records.recordsAgentConfig.greeting, build: records.buildRecordsPrompt as never };
});

/** What pre-context returns for a number that matches one person: no validation flag. */
const CANDIDATE = { matched: true, firstName: 'Alex' };

/** The greeting the runtime speaks, built the way `voiceRuntime` builds it. */
function spoken(lane: string, precontext: unknown, configured: string | null = null): string {
  return personaliseGreeting(
    chooseGreeting(lane, configured, LANES[lane].greeting),
    recognisedFirstName(precontext),
    greetingStyleFor(lane),
  );
}

const CORPUS: ReadonlyArray<readonly [sid: string, lane: string, day: string]> = [
  ['CA69a3b6d8274ede8cee7cb1a818e7ef06', 'optical', '2026-10-30'],
  ['CAadf2e34d5723ae1e50fa3183a9a192c5', 'optical', '2026-10-30'],
  ['CA06f261bcdd3b95fda0710954c3989889', 'surgery', '2026-10-30'],
  ['CA46bb10afc41dcc81ba05c1cfe4c50b14', 'surgery', '2026-10-30'],
  ['CA216c743df359cdf8d00a90bff0aa3e07', 'surgery', '2026-10-30'],
  ['CAdead5c981d5a7038d3d951c6846675bf', 'surgery', '2026-10-30'],
  ['CAe5324707f3d06bcf60e6116335de5bac', 'surgery', '2026-10-30'],
  ['CAaf72d99aa4ca3145cbab4a941872d20f', 'surgery', '2026-10-30'],
  ['CA492ab9e883d80fefb45749419c0f8728', 'tech', '2026-10-30'],
  ['CA0226907f3f824dc60d5420223759acc2', 'tech', '2026-10-30'],
  ['CAf2d83f16cb84e1c2c6acafda10b89da1', 'tech', '2026-10-30'],
  ['CA0a9a4941ca32abe630e89abf44932699', 'tech', '2026-10-30'],
  ['CA8917a5807762e95cfd02835caa6ef23e', 'tech', '2026-10-30'],
  ['CA3262a8fddc4641f837eba5685d7e6247', 'tech', '2026-10-30'],
  ['CAbf3db22d5eb977172fda4f4c82a02ae4', 'tech', '2026-10-30'],
  ['CAcbb298032d596f39d38b855f7a274e94', 'tech', '2026-10-30'],
  ['CAa9121ab28ac023f1cb8b7dfd48beda96', 'tech', '2026-10-30'],
  ['CAfbb68e46b4c89e179030f201127e51c3', 'tech', '2026-10-30'],
  ['CA183e9e7fc9501090d57f28d35a8f3336', 'tech', '2026-10-30'],
  ['CA990dfa0a0fcee7086a2f492232203e22', 'tech', '2026-10-30'],
  ['CA8f964c4be5ece3447387fa4b5e895972', 'tech', '2026-10-30'],
  ['CA538d6903d9ccee6f36361e58b7ec578c', 'tech', '2026-10-30'],
  ['CA3f643b5193d5b0f4796103402d4c23e0', 'tech', '2026-10-30'],
  ['CAc48d9b2c80adde146312070ca1d5f680', 'tech', '2026-10-30'],
  ['CA66738dfbeba847b3de62e18fcfe62aeb', 'tech', '2026-10-30'],
  ['CA7571eb971727523d747cedc556e9fae0', 'tech', '2026-10-30'],
  ['CA48a8641a6ffcdf6590a0ffc1bbd88b27', 'tech', '2026-10-30'],
  ['CA1c78861f98e25c6403641da3208ed4f7', 'tech', '2026-10-30'],
  ['CA1ecb4216b73ca6200159b130232094eb', 'tech', '2026-10-30'],
  ['CA04c23871f54f7024393b7126c298473a', 'tech', '2026-10-30'],
  ['CA05286af5667d706e5e892ae1fc0892f7', 'surgery', '2026-11-02'],
  ['CAc053cc03bcdb94e2a42793e713cc1ff5', 'surgery', '2026-11-02'],
  ['CA940cad77a53b398258bfaa174c056e9c', 'surgery', '2026-11-02'],
  ['CA7c323ecc102568a418638b8ed307da8b', 'surgery', '2026-11-02'],
  ['CA82885cc3e29c834e1d5d874b4c16f78e', 'surgery', '2026-11-02'],
  ['CA6d8692e2a1dfc3172142de9cd9f6311c', 'surgery', '2026-11-02'],
  ['CA8019e3f55b7a3c7ea50ac953c44067c0', 'tech', '2026-11-02'],
];

describe('the corpus: every recognised caller is greeted by name again', () => {
  for (const [sid, lane, day] of CORPUS) {
    it(`${sid} (${lane}, ${day}) hears "Am I speaking with <first name>?" and the prompt knows it`, () => {
      const greeting = spoken(lane, CANDIDATE);
      expect(greeting).toMatch(/Am I speaking with Alex\?$/);
      // The recording disclosure survives personalisation (v39).
      expect(greeting).toMatch(/calls are being recorded for quality assurance purposes/i);
      const prompt = LANES[lane].build({ precontext: CANDIDATE, callerPhone: '+15550001111' });
      expect(prompt).toContain('Your greeting has already ASKED "Am I speaking with Alex?"');
      expect(prompt).toMatch(/If they said YES, the identity step is DONE/);
    });
  }
});

describe('the rule itself', () => {
  it('a matched caller with a first name is named, with no validation flag', () => {
    expect(recognisedFirstName({ matched: true, firstName: 'Alex' })).toBe('Alex');
    expect(recognisedFirstName({ matched: true, firstName: ' Alex ' })).toBe('Alex');
  });

  it('an explicit identityValidated: false does not take the name away', () => {
    expect(recognisedFirstName({ matched: true, firstName: 'Alex', identityValidated: false })).toBe('Alex');
  });

  it('no match, no name, or no pre-context: the greeting stays generic', () => {
    expect(recognisedFirstName(null)).toBe('');
    expect(recognisedFirstName(undefined)).toBe('');
    expect(recognisedFirstName({ matched: false, firstName: 'Alex' })).toBe('');
    expect(recognisedFirstName({ matched: true })).toBe('');
    expect(recognisedFirstName({ matched: true, firstName: '   ' })).toBe('');
  });

  it('covers every lane that composes the recognised-caller block', () => {
    expect(Object.keys(LANES).sort()).toEqual(RECOGNITION_BLOCK_LANES.map((l) => l.slug).sort());
    for (const { slug } of RECOGNITION_BLOCK_LANES) {
      expect(spoken(slug, CANDIDATE), slug).toMatch(/Am I speaking with Alex\?$/);
    }
  });

  it('an operator-edited greeting from the database is named too', () => {
    const configured =
      'Hello from Azul Vision. All calls are being recorded for quality assurance purposes. How can I help you?';
    expect(spoken('optical', CANDIDATE, configured)).toBe(
      'Hello from Azul Vision. All calls are being recorded for quality assurance purposes. Am I speaking with Alex?',
    );
  });

  it('the runtime builds the greeting from recognisedFirstName, ungated', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'voiceRuntime.ts'), 'utf8');
    expect(src).toMatch(
      /personaliseLaneGreeting\(\s*entry\.slug,\s*chooseGreeting\(entry\.slug, configuredGreeting, lane\.greeting\),\s*lane\.greeting,\s*recognisedFirstName\(precontext\),/,
    );
  });

  it('the greeting function no longer reads identityValidated at all', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'services', 'greetingPersonalisation.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function recognisedFirstName'));
    expect(body.slice(0, body.indexOf('\n}'))).not.toContain('identityValidated');
  });
});
