/**
 * THE NAME CHECK READS A NAME THE WAY THE CALLER SAID IT — v195.
 * Findings 2 and 3 are below; finding 4 is measured and not fixed.
 *
 * Review of #431 (v180), findings 2-4, on `spots()` in
 * `nameFromTheRecording.ts`. MEASURED before fixing, on the callers whose name
 * we KNOW: runtime calls 2026-10-10..11-09 with a verified two-word
 * `patient_name`, each caller line normalised exactly as `spots()` does and
 * classified in SQL. Only counts and call SIDs left the database.
 *
 * 2. A full stop between two whole words was dropped, so "about Testa. Lake
 *    Pharmacy here" read as one name. The two filings v180 has made under a
 *    heard name (CA1c1ba125db9a5804dc36a9d5ace3897c,
 *    CA7249930c84816151d68b09520b2bd3ce, of 475 filings since 2026-11-05
 *    23:16 UTC) both said the name with no full stop between, so this has
 *    misfiled nothing yet. THE REVIEW'S FIX WOULD COST REAL CALLERS: 728
 *    verified callers said their own first and last name together in one
 *    turn, 28 of them across a full stop, nearly all as "Testa. My last name
 *    is Lake" or "Testa. L A K E", and for 25 that was the only way they said
 *    it. A full stop that is followed by "my last name is" or by a spelling is
 *    still how one person gives one name. So only a BARE full stop, with
 *    nothing else between two whole-word halves, now ends a name. That costs
 *    1 of the 728 (CA03ddc908591815343eb6b578e78b7298); the review's version
 *    would have cost 25.
 * 3. A spelled half run into the pronoun "I" or the article "a" ("L A K E, I
 *    need") joins into "lakei". 1 verified call has that shape, and its name
 *    was accepted another way: 0 rejected. NOT FIXED. The first version read
 *    every run ending in i or a without that letter too, and Codex (P2 on
 *    #442) showed what that costs: "V O R L I" would also validate a model
 *    answer of "Vorl", a surname the caller never spelled — the model error
 *    this check exists to catch. Nothing measured was rescued, so the shape
 *    stays refused, and the tests below say so.
 * 4. Both halves spelled as one run ("T E S T A L A K E") made one word that
 *    matched neither half. 12 verified calls spelled it that way, and for 10
 *    of them that was the only way the name came out whole, which is 10 correct
 *    names refused of about 750. None was an email address. Those 10:
 *      CA02bc536fab5332e71bcd75b165a9cedc CA24319287477492f38ee171c11a5d9842
 *      CA29a895104c7aa021277297e69f448eef CA2c3cd2d3b186ee1a1381ba4f8c5a9f2f
 *      CA8e0d2eb8400273305ec78c41d9e69727 CA9305962397ccab325b8d5f1f81c1db5c
 *      CAb221dffd3152cab0861da2eef0b81ebb CAc5c89d8c6e0163dcbe406cd91408b885
 *      CAc8194124bb63618b3ad462974849e7e9 CAe40f6f6b4c38894fa127854dc82fd8bd
 *    NOT FIXED. Six review rounds on #442 each found a reading of a run
 *    that accepted a name the caller did not spell: an i/a strip ("R O S S I"
 *    as Ross), letters joined across a full stop ("Test Alake"), a piece
 *    dropped ("… L A K E. S M I T H." as Testa Lake, twice), and a real last
 *    letter read as a word starting the next sentence ("R O S S. I." as Ross).
 *    Each is a misfiled ticket; the fix rescued 10 names in about 750. So a
 *    run is not read as both halves, as on main, and the 10 file under no
 *    heard name, as they do today. The counterexamples are pinned below.
 *
 * Every name below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});
vi.mock('../../server/db', () => ({ db: {} }));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { runRequestSweep, type SweepFiler } from './sweepRunner';
import { nameWasSaidByTheCaller, type NameAsker } from './nameFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';

const said = (t: string, firstName: string, lastName: string) => nameWasSaidByTheCaller(t, { firstName, lastName });
const answers = (firstName: string, lastName: string): NameAsker => async () => ({ firstName, lastName });

function surgery(callSid: string, callerSays: string): VoiceCallRecord {
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug: 'surgery',
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript:
      'AGENT: Thank you for calling Azul Vision surgery coordination. I can take a message and they will follow up with you. How can I help you today?\n' +
      `CALLER: ${callerSays}`,
    toolEvents: [],
    agentTurns: 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 56_000,
  };
}

function filer(): SweepFiler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = (async (ticket: unknown) => {
    calls.push(ticket as Record<string, unknown>);
    return { success: true, ticketNumber: 'VA-SWEEP-192' };
  }) as SweepFiler & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  resetVerifiedIdentities();
  resetStatedNames();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a bare full stop between two whole words ends a name (finding 2)', () => {
  it('"about Testa. Lake Pharmacy here" is not the name Testa Lake', () => {
    expect(said('CALLER: Hi, this is about Testa. Lake Pharmacy here, calling for a refill.', 'Testa', 'Lake')).toBe(false);
  });
  it('nor surname first across a bare full stop (CA03ddc908591815343eb6b578e78b7298 is the one correct name this refuses)', () => {
    expect(said('CALLER: The patient is Lake. Testa needs a refill.', 'Testa', 'Lake')).toBe(false);
  });
  it('the sweep files nothing under a name crossed that way', async () => {
    const f = filer();
    const out = await runRequestSweep(
      surgery('CA00000000000000000000000000000195', 'Hi, this is about Testa. Lake Pharmacy here, calling about a surgery clearance fax.'),
      f,
      answers('Testa', 'Lake'),
    );
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });
  it('a full stop followed by "my last name is" or a spelling is still one name — 27 of the 28 measured', () => {
    expect(said('CALLER: My first name is Testa. My last name is Lake.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: Testa. Last name is Lake.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: Testa. The last name is L A K E.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: Lake. The first name is Testa.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: Testa, T E S T A. Last name is Lake.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: Testa. L A K E. Lake.', 'Testa', 'Lake')).toBe(true);
  });
  it('a spelled half on either side of a full stop is unchanged', () => {
    expect(said('CALLER: My name is Testa. L A K E.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: T E S T A. Lake is my last name.', 'Testa', 'Lake')).toBe(true);
  });
  it('a middle initial with its full stop and a comma are unchanged', () => {
    expect(said('CALLER: My name is Testa M. Lake, call me.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: The patient is Lake, Testa.', 'Testa', 'Lake')).toBe(true);
  });
});

describe('a spelled surname is never read shorter than it was spelled (finding 3, not fixed; Codex P2 on #442)', () => {
  it('"V O R L I" validates Vorli and never Vorl', () => {
    const t = 'CALLER: My name is Testa, V O R L I, calling about a refill.';
    expect(said(t, 'Testa', 'Vorli')).toBe(true);
    expect(said(t, 'Testa', 'Vorl')).toBe(false);
  });
  it('the same for a surname ending in A, and for a spelled first name', () => {
    expect(said('CALLER: My name is Testa, L A K E A, calling about a refill.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: Lake, first name T E S T A, calling about my drops.', 'Test', 'Lake')).toBe(false);
  });
  it('the accepted residue: a spelling run straight into "I" or "a" is refused (0 measured, 2026-10-10..11-09)', () => {
    expect(said('CALLER: My name is Testa, L A K E, I need a refill.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: This is Testa, L A K E, a refill please.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: My name is Testa, L. A. K. E. I need a refill.', 'Testa', 'Lake')).toBe(false);
  });
  it('a full stop the transcriber wrote after the spelling still ends it, as on main (Codex P2 on #431)', () => {
    expect(said('CALLER: My name is Testa, L A K E. I need a refill.', 'Testa', 'Lake')).toBe(true);
  });
  it('the sweep files nothing under a name read that way', async () => {
    const f = filer();
    const out = await runRequestSweep(
      surgery('CA00000000000000000000000000000196', 'My name is Testa, V O R L I, I need my surgery moved to next week.'),
      f,
      answers('Testa', 'Vorl'),
    );
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });
});

/**
 * Finding 4, not fixed. Every counterexample a review round on #442 found is
 * here, and each is refused; so is the right name spelled as one run, which
 * is the accepted residue (10 of about 750 verified callers, the SIDs above).
 */
describe('both halves spelled as one run are not read as the name (finding 4, not fixed)', () => {
  it('the accepted residue: "T E S T A L A K E" is refused, as on main', () => {
    expect(said('CALLER: The patient is T E S T A L A K E, please call back.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: The patient is L A K E T E S T A, please call back.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: The patient is T. E. S. T. A. L. A. K. E.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: This is T E S T A L A K E. I need a refill.', 'Testa', 'Lake')).toBe(false);
  });
  it('round 2 (review of e238680): letters joined across a full stop', () => {
    expect(said('CALLER: T E S T A. L A K E.', 'Test', 'Alake')).toBe(false);
    expect(said('CALLER: T E S T A. L A K E.', 'Testal', 'Ake')).toBe(false);
  });
  it('rounds 3 and 5 (reviews of 25cd221 and bd11e41): a piece dropped', () => {
    expect(said('CALLER: T E S T A. L A K E. S M I T H.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: T E S T A L A K E. S M I T H.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: The patient is T E S T A L A K E. S. M. I. T. H. Please call back.', 'Testa', 'Lake')).toBe(false);
    expect(said('CALLER: The patient is T E S T A L A K E. S. M. I. T. H., please call back.', 'Testa', 'Lake')).toBe(false);
  });
  it('round 6 (review of b26f983): a real last letter read as the start of the next sentence', () => {
    expect(said('CALLER: The patient is J A N E R O S S. I., please call back.', 'Jane', 'Ross')).toBe(false);
    expect(said('CALLER: The patient is J A N E R O S S. I need a refill.', 'Jane', 'Ross')).toBe(false);
    expect(said('CALLER: The patient is J A N E R. O. S. S. I.', 'Jane', 'Ross')).toBe(false);
  });
  it('the sweep files nothing under a name spelled as one run', async () => {
    const f = filer();
    const out = await runRequestSweep(
      surgery('CA00000000000000000000000000000197', 'This is T E S T A L A K E. I need my surgery moved to next week.'),
      f,
      answers('Testa', 'Lake'),
    );
    expect(out).toEqual({ filed: false, reason: 'no-name' });
    expect(f.calls).toHaveLength(0);
  });
  it('a half spelled on its own still reads, as on main', () => {
    expect(said('CALLER: My name is Testa, L A K E. I need a refill.', 'Testa', 'Lake')).toBe(true);
    expect(said('CALLER: T E S T A. Lake is my last name.', 'Testa', 'Lake')).toBe(true);
  });
});
