/**
 * THE TICKET API'S FIELD REFUSAL IS READ IN BOTH OF ITS SPELLINGS.
 *
 * The app's `/submit-ticket` 400 arrives at the agents as TEXT in the app's
 * own wording ("Missing required fields: …, missing: …"); every agent on that
 * path matched the sink's wording ("Missing required information: …"). This
 * module is the one place either becomes a field list — see the docblock in
 * missingFieldsRefusal.ts for the call that found it.
 *
 * The first fixture is the app's body on CA42f5b35d3924b8a1e5e66c00ee927742,
 * verbatim from `voice_agent_api_logs.response_body` (it carries no PHI — a
 * column name is not a patient).
 */
import { describe, it, expect } from 'vitest';
import { missingFieldsFromRefusal, spokenFieldName, spokenMissingFields } from './missingFieldsRefusal';

/** The app's refusal, as logged. */
const APP_EMAIL_REFUSAL =
  'Missing required fields: patientEmail. Please collect these from the patient before submitting., missing: patientEmail';

describe("the app's own wording", () => {
  it('reads the field out of the logged refusal', () => {
    expect(missingFieldsFromRefusal(APP_EMAIL_REFUSAL)).toEqual(['patientEmail']);
  });

  it('reads several fields', () => {
    const two =
      'Missing required fields: patientFullName, patientDOB. Please collect these from the patient before submitting., missing: patientFullName, patientDOB';
    expect(missingFieldsFromRefusal(two)).toEqual(['patientFullName', 'patientDOB']);
  });

  it('reads the head with or without the app\'s repeating tail', () => {
    expect(missingFieldsFromRefusal('Missing required fields: patientPhone.')).toEqual(['patientPhone']);
    expect(missingFieldsFromRefusal('Missing required fields: patientPhone, patientEmail')).toEqual([
      'patientPhone',
      'patientEmail',
    ]);
  });
});

describe("the sink's own wording, which the queue lanes have matched since 2026-09-01", () => {
  it('reads a single field and stops at the sentence', () => {
    expect(
      missingFieldsFromRefusal('Missing required information: surgeon. Surgery tickets are assigned by surgeon.'),
    ).toEqual(['surgeon']);
    expect(missingFieldsFromRefusal('Missing required information: office')).toEqual(['office']);
  });

  it('reads a list', () => {
    expect(missingFieldsFromRefusal('Missing required information: patientEmail, patientPhone')).toEqual([
      'patientEmail',
      'patientPhone',
    ]);
  });
});

/**
 * Anything that is not a field refusal is NOT a question for the caller. A
 * timeout, an outage and the contention refusal each have their own branch in
 * the handler, and reading one of them as "ask the caller" would be a new
 * false line in place of the old one.
 */
describe('what is not a refusal', () => {
  it.each([
    'Ticketing API timeout after 15000ms - please try again',
    'Concurrent ticket creation in progress',
    'Ticketing service is temporarily unavailable. Please try again.',
    'HTTP 500 error',
    'Invalid JSON response from ticketing API: 502',
    'Unknown error creating ticket',
    '',
  ])('%j answers null', (text) => {
    expect(missingFieldsFromRefusal(text)).toBeNull();
  });

  it('null and undefined answer null', () => {
    expect(missingFieldsFromRefusal(null)).toBeNull();
    expect(missingFieldsFromRefusal(undefined)).toBeNull();
  });

  it('a refusal with an empty field list answers null rather than an empty question', () => {
    expect(missingFieldsFromRefusal('Missing required fields: ')).toBeNull();
    expect(missingFieldsFromRefusal('Missing required information: , ')).toBeNull();
  });
});

/**
 * RULE ZERO 2b: the format rides in the question. The spoken name of a field
 * is what the model is told to ask for, so the email says "spell it out", the
 * date says its order, and the phone says its length.
 */
describe('the words the model is told to ask in', () => {
  it('the email address is asked for letter by letter', () => {
    expect(spokenFieldName('patientEmail')).toMatch(/email address/);
    expect(spokenFieldName('patientEmail')).toMatch(/letter by letter/);
  });

  it('the date of birth names its order', () => {
    expect(spokenFieldName('patientDOB')).toMatch(/month first, then the day, then the year/);
  });

  it('the phone number names its length', () => {
    expect(spokenFieldName('patientPhone')).toMatch(/ten digits/);
  });

  it('an unknown field passes through as itself rather than vanishing', () => {
    expect(spokenFieldName('surgeon')).toBe('surgeon');
    expect(spokenMissingFields(['patientEmail', 'surgeon'])).toMatch(/email address.*; surgeon$/);
  });
});
