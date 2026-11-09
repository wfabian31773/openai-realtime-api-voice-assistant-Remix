/**
 * A REQUEST GIVEN IN ANSWER TO A NAME QUESTION IS STILL A REQUEST — v193.
 *
 * Review of #431 (v180): `IDENTITY_WORDS` took in `NAME_SCAFFOLDING` ("his",
 * "her", "their", "last", "patient", "spelled", "su", "es", "se", ...), so
 * those words were subtracted from EVERY caller turn before the name-sized
 * (three words or fewer) rule ran. A short real request said in answer to a
 * name question then shrank to "a name" and was skipped as identity-only: the
 * agent asks for the patient's name, the caller says "His last visit was
 * cancelled", and only "visit cancelled" is left. The same function is the
 * admission on the PCP teardown floor and the after-hours teardown floor, so
 * the widening reached both.
 *
 * MEASURED before fixing (call_logs, Operations Hub), the function ported to
 * SQL and checked against the TypeScript on 12 synthetic transcripts (12 of 12
 * agree, v179 and v188 lists both):
 *   - since v180 went live (2026-11-05 23:16:33 UTC to 2026-11-09): 811
 *     runtime calls with caller speech, 1 changes decision, on npx-outreach,
 *     which no sweep or floor runs on;
 *   - 2026-10-10..11-09: 12,044 calls with caller speech, 2 change decision:
 *     CA39a3327c7527b15183905230261514dd (npx-outreach, not swept) and
 *     CA7346c12ae00404d762d082da5afcd0cc (records, already ticketed, so the
 *     sweep stops at already-filed before this check).
 * So the mechanism is real and has cost no request yet.
 *
 * THE RULE NOW: scaffolding is identity only when it is ALL that is left of a
 * turn. It can finish a bare introduction ("my last name is L A K E") on any
 * path, which is what v180 needed it for (Codex P2 on #431), but it never
 * shortens a request into a name-sized answer. On the same 12,044 calls this
 * decides exactly as v179 did on every call a sweep or floor reaches.
 *
 * Every name below is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideSweep, saidMoreThanTheirOwnIdentity } from './requestSweep';

const NAME_ASK = "AGENT: Can I have the patient's first and last name?";
const SPANISH_NAME_ASK = '¿Me puede dar su nombre y apellido?';

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

describe('a short request in answer to a name question files (review of #431, finding 1)', () => {
  it('"His last visit was cancelled" — the sweep files it', () => {
    const d = records('CA00000000000000000000000000000192', `${NAME_ASK}\nCALLER: His last visit was cancelled.`);
    expect(d.file).toBe(true);
  });
  it('"Their patient portal is down" — the sweep files it', () => {
    const d = records('CA00000000000000000000000000000193', `${NAME_ASK}\nCALLER: Their patient portal is down.`);
    expect(d.file).toBe(true);
  });
  it('the same in Spanish ("Es su receta, se le acabó")', () => {
    const d = records('CA00000000000000000000000000000194', `AGENT: ${SPANISH_NAME_ASK}\nCALLER: Es su receta, se le acabó.`);
    expect(d.file).toBe(true);
  });
  it('the PCP and after-hours floors read it as more than identity, with a name held', () => {
    // Both floors call saidMoreThanTheirOwnIdentity(transcript, identity), exactly this.
    const held = { firstName: 'Testa', lastName: 'Lake' };
    for (const says of ['His last visit was cancelled.', 'Their patient portal is down.', 'Her surname changed, please update it.']) {
      expect(saidMoreThanTheirOwnIdentity(`${NAME_ASK}\nCALLER: ${says}`, held)).toBe(true);
    }
    expect(saidMoreThanTheirOwnIdentity(`AGENT: ${SPANISH_NAME_ASK}\nCALLER: Es su receta, se le acabó.`, held)).toBe(true);
  });
  it('the floors still call it with the transcript and the held identity only', () => {
    const pcp = readFileSync(new URL('../agents/pcpAgent.ts', import.meta.url), 'utf8');
    const afterHours = readFileSync(new URL('../services/afterHoursTeardownFloor.ts', import.meta.url), 'utf8');
    expect(pcp).toMatch(/saidMoreThanTheirOwnIdentity\(transcript, \{/);
    expect(afterHours).toMatch(/saidMoreThanTheirOwnIdentity\(transcript, identity\)/);
  });
});

describe('what v180 needed the scaffolding for still holds', () => {
  const held = { firstName: 'Testa', lastName: 'Lake' };
  it('a bare introduction is identity, asked or volunteered', () => {
    for (const says of [
      'My name is Testa, my last name is L A K E.',
      'Testa, last name Lake, spelled L A K E.',
      'Mi nombre es Testa, mi apellido es Lake, se escribe L A K E.',
      'That is the patient, Testa Lake.',
    ]) {
      expect(saidMoreThanTheirOwnIdentity(`AGENT: How can I help you today?\nCALLER: ${says}`, held)).toBe(false);
      expect(saidMoreThanTheirOwnIdentity(`${NAME_ASK}\nCALLER: ${says}`, held)).toBe(false);
    }
  });
  it('a name-sized answer to a name question is still identity with no name held', () => {
    expect(saidMoreThanTheirOwnIdentity(`${NAME_ASK}\nCALLER: Testa Lake.`, undefined)).toBe(false);
  });
  it('an introduction with a request in it still files', () => {
    expect(saidMoreThanTheirOwnIdentity(`${NAME_ASK}\nCALLER: Testa Lake, her glasses are ready.`, held)).toBe(true);
  });
});

/**
 * Codex round 4 on #442. With no name held (the records lane files nameless,
 * and the floors run before any name is known), an introduction that names
 * the name ("her first name is ..., her last name is ...") left more than
 * three words once the scaffolding was kept, so the records sweep filed a
 * ticket with no request in it. `main` skipped these. A turn that says
 * "name" / "nombre" / "apellido" is answering in the shape of an
 * introduction, so its name-sized count is taken without the scaffolding, as
 * `main` took it; a turn that does not ("His last visit was cancelled") keeps
 * the scaffolding and files.
 */
describe('an introduction with no name held is still identity (Codex round 4 on #442)', () => {
  const asked = (says: string) => `${NAME_ASK}\nCALLER: ${says}`;
  it('the introduction shapes are skipped as identity-only', () => {
    for (const says of [
      'My first name is Testa and my last name is Lake.',
      'Her first name is Testa and her last name is Lake.',
      'His first name is Testa, his last name is Lake.',
      "The patient's first name is Testa, last name Lake.",
      'Testa, last name Lake, spelled L A K E.',
      'Her name is Testa Ann Lake.',
    ]) {
      expect(saidMoreThanTheirOwnIdentity(asked(says), undefined)).toBe(false);
    }
    for (const says of ['Mi nombre es Testa, mi apellido es Lake.', 'Su nombre es Testa y su apellido es Lake.']) {
      expect(saidMoreThanTheirOwnIdentity(`AGENT: ${SPANISH_NAME_ASK}\nCALLER: ${says}`, undefined)).toBe(false);
    }
  });
  it('the records sweep skips it rather than filing a nameless request', () => {
    const d = records('CA00000000000000000000000000000195', asked('Her first name is Testa and her last name is Lake.'));
    expect(d.file).toBe(false);
  });
  it('a short request that does not say "name" still files with no name held', () => {
    for (const says of ['His last visit was cancelled.', 'Their patient portal is down.', 'Her surname changed, please update it.']) {
      expect(saidMoreThanTheirOwnIdentity(asked(says), undefined)).toBe(true);
    }
    expect(saidMoreThanTheirOwnIdentity(`AGENT: ${SPANISH_NAME_ASK}\nCALLER: Es su receta, se le acabó.`, undefined)).toBe(true);
  });
  it('an introduction with a request in it still files', () => {
    expect(saidMoreThanTheirOwnIdentity(asked('Her first name is Testa and her last name is Lake, her glasses are ready.'), undefined)).toBe(true);
  });
  it('the accepted residue: a request of three words or fewer that says "name" is skipped, as on main', () => {
    expect(saidMoreThanTheirOwnIdentity(asked('Her name changed, please update it.'), undefined)).toBe(false);
  });
});
