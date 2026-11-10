/**
 * A SHORT ANSWER TO A NAME QUESTION IS IDENTITY — v195 (finding 1 of the
 * review of #431, measured and NOT fixed).
 *
 * The review found that v180 put `NAME_SCAFFOLDING` ("his", "her", "their",
 * "last", "patient", "su", "es", ...) into `IDENTITY_WORDS`, so those words are
 * subtracted from every caller turn before the name-sized (three words or
 * fewer) rule runs. A short request said in answer to a name question shrinks
 * to "a name" and is skipped as identity-only: the agent asks for the
 * patient's name, the caller says "His last visit was cancelled", and only
 * "visit cancelled" is left. The same function is the admission on the PCP and
 * after-hours teardown floors.
 *
 * MEASURED (call_logs, Operations Hub), the function ported to SQL and checked
 * against the TypeScript on 12 synthetic transcripts (12 of 12 agree):
 *   - since v180 went live (2026-11-05 23:16:33 UTC to 2026-11-09): 811
 *     runtime calls with caller speech, 1 changes decision, on npx-outreach,
 *     which no sweep or floor runs on;
 *   - 2026-10-10..11-09: 12,044 calls with caller speech, 2 change decision:
 *     CA39a3327c7527b15183905230261514dd (npx-outreach, not swept) and
 *     CA7346c12ae00404d762d082da5afcd0cc (records, already ticketed).
 * So the mechanism is real and has cost no request.
 *
 * WHY IT IS NOT FIXED. Two fixes were tried on #442, and each one let a bare
 * introduction file a nameless request that `main` skips: "Her first name is
 * Testa and her last name is Lake" (Codex round 4), then "The patient is Testa
 * Ann Lake." (Codex review of b26f983). On the records lane such a ticket
 * opens a case on the statutory clock (Codex P1 on #333 is why `main` skips
 * them). "His last visit was cancelled" and "The patient is Testa Ann Lake"
 * leave the same number of words; telling them apart needs a name detector,
 * which standing instruction 3 rules out. With no measured cost on one side
 * and a reproduced cost on the other, `main`'s rule stands, and the short
 * request is the accepted residue pinned below.
 *
 * Every name below is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { decideSweep, saidMoreThanTheirOwnIdentity } from './requestSweep';

const NAME_ASK = "AGENT: Can I have the patient's first and last name?";
const SPANISH_NAME_ASK = '¿Me puede dar su nombre y apellido?';
const asked = (says: string) => `${NAME_ASK}\nCALLER: ${says}`;

function records(callSid: string, transcript: string) {
  return decideSweep({
    callSid,
    slug: 'records',
    callerPhone: '+15555550100',
    transcript,
    toolEvents: [],
    ticketAlreadyFiled: false,
  });
}

describe('a bare introduction in answer to a name question is identity, with no name held', () => {
  it('the shapes the review rounds on #442 found are skipped', () => {
    for (const says of [
      'The patient is Testa Ann Lake.',
      'My first name is Testa and my last name is Lake.',
      'Her first name is Testa and her last name is Lake.',
      'His first name is Testa, his last name is Lake.',
      "The patient's first name is Testa, last name Lake.",
      'Testa, last name Lake, spelled L A K E.',
      'Her name is Testa Ann Lake.',
      'Testa Lake.',
    ]) {
      expect(saidMoreThanTheirOwnIdentity(asked(says), undefined)).toBe(false);
    }
    for (const says of ['Mi nombre es Testa, mi apellido es Lake.', 'Su nombre es Testa y su apellido es Lake.']) {
      expect(saidMoreThanTheirOwnIdentity(`AGENT: ${SPANISH_NAME_ASK}\nCALLER: ${says}`, undefined)).toBe(false);
    }
  });
  it('the records sweep skips "The patient is Testa Ann Lake." rather than filing a nameless request', () => {
    const d = records('CA00000000000000000000000000000195', asked('The patient is Testa Ann Lake.'));
    expect(d).toMatchObject({ file: false, reason: 'identity-only' });
  });
  it('the records sweep skips "Her first name is Testa and her last name is Lake."', () => {
    const d = records('CA00000000000000000000000000000196', asked('Her first name is Testa and her last name is Lake.'));
    expect(d).toMatchObject({ file: false, reason: 'identity-only' });
  });
});

describe('the same with a name held, as the PCP and after-hours floors call it', () => {
  const held = { firstName: 'Testa', lastName: 'Lake' };
  it('a bare introduction is identity, asked or volunteered', () => {
    for (const says of [
      'My name is Testa, my last name is L A K E.',
      'Testa, last name Lake, spelled L A K E.',
      'Mi nombre es Testa, mi apellido es Lake, se escribe L A K E.',
      'That is the patient, Testa Lake.',
    ]) {
      expect(saidMoreThanTheirOwnIdentity(`AGENT: How can I help you today?\nCALLER: ${says}`, held)).toBe(false);
      expect(saidMoreThanTheirOwnIdentity(asked(says), held)).toBe(false);
    }
  });
});

describe('a request longer than a name still files', () => {
  it('an introduction with a request in it', () => {
    expect(saidMoreThanTheirOwnIdentity(asked('Testa Lake, her new glasses are ready for pickup.'), { firstName: 'Testa', lastName: 'Lake' })).toBe(true);
    expect(saidMoreThanTheirOwnIdentity(asked('Her first name is Testa and her last name is Lake, her glasses are ready.'), undefined)).toBe(true);
  });
  it('a request outside an identity ask files whatever its length', () => {
    expect(saidMoreThanTheirOwnIdentity('AGENT: How can I help you today?\nCALLER: His last visit was cancelled.', undefined)).toBe(true);
  });
});

describe('the accepted residue: a request of three words or fewer, once the scaffolding is gone, given in answer to a name question', () => {
  it('is skipped as identity-only, as on main (0 requests lost in 12,044 measured calls)', () => {
    for (const says of ['His last visit was cancelled.', 'Their patient portal is down.', 'Her name changed, please update it.']) {
      expect(saidMoreThanTheirOwnIdentity(asked(says), undefined)).toBe(false);
    }
    expect(saidMoreThanTheirOwnIdentity(`AGENT: ${SPANISH_NAME_ASK}\nCALLER: Es su receta, se le acabó.`, undefined)).toBe(false);
    // With the name held, the name comes off too: three words are left.
    expect(saidMoreThanTheirOwnIdentity(asked('Testa Lake, her glasses are ready.'), { firstName: 'Testa', lastName: 'Lake' })).toBe(false);
  });
  it('the records sweep skips it', () => {
    const d = records('CA00000000000000000000000000000192', asked('His last visit was cancelled.'));
    expect(d).toMatchObject({ file: false, reason: 'identity-only' });
  });
});
