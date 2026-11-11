/**
 * v205: the one-sentence request the teardown sweep reads from the recording
 * (v201) still let through three things it is there to hold back, and since
 * v203 that sentence is also the description on a Medical Records case.
 *
 * Operator, 2026-11-11: "the one-sentence summary can still leak details it's
 * supposed to hold back. That includes a patient name with an apostrophe,
 * dates spoken as words, and longer street addresses."
 *
 *   1. A held name with an apostrophe, or a held name the sentence makes
 *      possessive: the sentence kept the apostrophe inside the word and the
 *      held name did not, so "Lake's", "O'Marsh's" and a curly "O’Marsh" were
 *      never the same word. Over 14 Pacific days of agent ticket text on the
 *      four queue lanes (3,364 tickets), the patient's own last name appears
 *      as a possessive on 25 and the first name on 13.
 *   2. A date spoken as words ("March third", "the twenty-first of June",
 *      "tres de marzo") or a year read out ("two thousand five").
 *   3. An address longer than a house number and two words, a house number
 *      read out, a suite or apartment, a PO box, and a named street given as
 *      somebody's home or mailing address.
 *
 * Every name, date and address here is invented. The rule is unchanged:
 * a sentence that fails a check is dropped, never trimmed.
 */
import { describe, expect, it } from 'vitest';
import { requestFromTheRecording, usableRequest, type RequestAsker } from './requestFromTheRecording';

const answers = (request: string | null): RequestAsker => async () => ({ request });

describe('a held name is caught however the apostrophe is written', () => {
  it.each([
    ['a possessive of a plain surname', "Wants Lake's appointment moved to Friday.", ['Testa', 'Lake']],
    ['a possessive of a first name', "Asking whether Testa's glasses are ready.", ['Testa', 'Lake']],
    ['an apostrophe surname, as held', "Wants the records for O'Marsh faxed over.", ['Quillon', "O'Marsh"]],
    ['an apostrophe surname, possessive', "Wants O'Marsh's records faxed to the office.", ['Quillon', "O'Marsh"]],
    ['a curly apostrophe in the sentence', 'Wants O’Marsh’s records faxed to the office.', ['Quillon', "O'Marsh"]],
    ['a curly apostrophe in the held name', "Wants the records for O'Marsh faxed over.", ['Quillon', 'O’Marsh']],
    ['the model ran the name together', 'Wants OMarsh records faxed to the office.', ['Quillon', "O'Marsh"]],
    ['the model split the name', 'Wants O Marsh records faxed to the office.', ['Quillon', 'OMarsh']],
    ['a held name the model wrote with an apostrophe', "Asking about D'Arlo's surgery next week.", ['Testa', 'DArlo']],
  ])('%s', async (_what, sentence, held) => {
    expect(usableRequest(sentence, held)).toBeUndefined();
    expect(await requestFromTheRecording('CALLER: synthetic.', answers(sentence), held)).toBeNull();
  });

  it('a sentence naming nobody we hold is still kept, apostrophes and all', () => {
    expect(usableRequest("Wants the order's status checked.", ['Testa', "O'Marsh"])).toBe("Wants the order's status checked.");
    expect(usableRequest("Asking whether the doctor's notes were sent.", ['Testa', 'Lake'])).toBe("Asking whether the doctor's notes were sent.");
  });
});

describe('a date spoken as words is caught', () => {
  it.each([
    ['month then ordinal', 'Wants to reschedule the visit on March third.'],
    ['month then two-word ordinal', 'Wants to move the June twenty first visit.'],
    ['hyphenated ordinal of month', 'Wants to move her visit to the twenty-first of June.'],
    ['ordinal of month', 'Wants the third of March appointment moved.'],
    ['cardinal of month', 'Wants the visit on the ten of October moved.'],
    ['month then cardinal', 'Wants the October twelve visit moved to next week.'],
    ['month, the, ordinal', 'Wants to keep the visit on November the fifth.'],
    ['May as the month', 'Wants the May fifth surgery moved later.'],
    ['a year from 2000 on', 'Says the surgery was in two thousand five and wants records.'],
    ['Spanish day and month', 'Quiere cambiar la cita del tres de marzo.'],
    ['Spanish digit and month', 'Quiere cambiar la cita del 3 de marzo.'],
    ['Spanish month and digit', 'Quiere cambiar la cita de marzo 3 para otro día.'],
    ['Spanish compound day', 'Quiere mover la cita del veintiuno de junio.'],
    ['Spanish accented day', 'Quiere mover la cita del dieciséis de julio.'],
    ['Spanish year', 'Dice que la cirugía fue en dos mil cinco.'],
  ])('%s', (_what, sentence) => {
    expect(usableRequest(sentence, [])).toBeUndefined();
  });

  it.each([
    ['the modal may', 'Asking whether she may first need a referral.'],
    ['May with no day', 'Wants a second opinion on the cataract in May.'],
    ['an ordinal with no month', 'Wants a second pair of glasses ordered.'],
    ['one of', 'Asking if one of the doctors can call back.'],
    ['a time', 'Wants to move an 8:30 appointment to the afternoon.'],
  ])('kept: %s', (_what, sentence) => {
    expect(usableRequest(sentence, [])).toBe(sentence);
  });
});

describe('a longer address is caught', () => {
  it.each([
    ['three words before the street word', 'Wants records sent to 12 Old Mill Creek Road.'],
    ['a directional and an abbreviation', 'Wants glasses mailed to 405 N Elm Grove St today.'],
    ['four capitalised words', 'Wants records sent to 88 West Old Mill Creek Road.'],
    ['a house number read out', 'Wants records sent to twelve thirty four Main Street.'],
    ['a suite number', 'Wants records mailed to Suite 200 at the new clinic.'],
    ['a suite letter', 'Wants records mailed to Suite B at the new clinic.'],
    ['an apartment', 'Wants records mailed to Apt 4 at her home.'],
    ['a unit', 'Wants the glasses sent to unit 9 please.'],
    ['a hash number', 'Wants the glasses sent to #9 on the second floor.'],
    ['a PO box', 'Wants records mailed to PO Box 55 please.'],
    ['a PO box with dots', 'Wants records mailed to P.O. Box 55 please.'],
    ['a named street as a mailing address', 'Wants glasses mailed to West Foothill Boulevard.'],
    ['a named street as a home', 'Says she lives on Quarry Hill Road and wants a closer office.'],
  ])('%s', (_what, sentence) => {
    expect(usableRequest(sentence, [])).toBeUndefined();
  });

  it.each([
    ['a pharmacy on a named street', 'Wants the refill sent to the CVS on Foothill Boulevard.'],
    ['an office by its street', 'Wants records from the Main Street office sent over.'],
    ['a count and a lowercase way', 'Wants 3 pairs shipped the fastest way.'],
    ['a count and the lowercase dr', 'Wants 2 copies sent to the dr today.'],
    ['a capitalised word first in the sentence', 'Wants Court papers faxed to the lawyer.'],
    ['a hospital unit', 'Wants to know if the surgery unit is open.'],
    ['an apartment complex', 'Asking about the apartment complex shuttle to the office.'],
  ])('kept: %s', (_what, sentence) => {
    expect(usableRequest(sentence, [])).toBe(sentence);
  });

  it('nothing here backtracks without end, at the longest a sentence may be', () => {
    // usableRequest drops anything over 160 characters before a pattern
    // runs, so the worst a pattern ever sees is 160 characters built to make
    // it try every split: a house number, then capitalised words that never
    // reach a street word; number words that never reach a street; and
    // capitalised words before a home word with no street word.
    const fill = (head: string, unit: string) => (head + unit.repeat(80)).slice(0, 159);
    const worst = [
      fill('Wants it sent to 12 ', 'Aa '),
      fill('Wants it sent to twelve ', 'thirty '),
      fill('Wants it mailed home to ', 'Aa '),
      fill('Wants the ', 'twenty first '),
      fill('Wants records for ', "O'Aa "),
    ];
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) for (const s of worst) usableRequest(s, ['Testa', "O'Marsh"]);
    expect(Date.now() - t0).toBeLessThan(150);
  });
});
