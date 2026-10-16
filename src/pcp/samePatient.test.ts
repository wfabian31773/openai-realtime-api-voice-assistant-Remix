import { describe, expect, it } from 'vitest';
import { filingForPatient, hasIdentity, nameKey, samePatient, type PatientIdentity } from './samePatient';

/**
 * THE SHARED CASE TABLE — byte for byte the rows in ticketing-app
 * `lib/pcp/same-patient.test.ts`, so this agent's per-patient latch opens for
 * a new patient exactly when the app opens a new ticket. Change a row there
 * and change it here. Synthetic patients only.
 */
const SAME_PATIENT_CASES: Array<[string, PatientIdentity, PatientIdentity, boolean]> = [
  ['identical', { firstName: 'Ana', lastName: 'Rivera', dob: '1950-03-04' }, { firstName: 'Ana', lastName: 'Rivera', dob: '1950-03-04' }, true],
  ['case, accent and punctuation are spelling', { firstName: 'JOSÉ', lastName: "O'Neil" }, { firstName: 'jose', lastName: 'ONeil' }, true],
  ['surname arrives a turn later', { firstName: 'Ana' }, { firstName: 'Ana', lastName: 'Rivera' }, true],
  ['date of birth arrives a turn later', { firstName: 'Ana', lastName: 'Rivera' }, { firstName: 'Ana', lastName: 'Rivera', dob: '1950-03-04' }, true],
  ['zero-padding is not a different birthday', { firstName: 'Ana', dob: '1950-3-4' }, { firstName: 'Ana', dob: '1950-03-04' }, true],
  ['same name, different birthday: father and son', { firstName: 'Luis', lastName: 'Ortega', dob: '1940-01-01' }, { firstName: 'Luis', lastName: 'Ortega', dob: '1975-06-30' }, false],
  ['twins: same surname and birthday, different first name', { firstName: 'Mia', lastName: 'Chen', dob: '2010-05-05' }, { firstName: 'Max', lastName: 'Chen', dob: '2010-05-05' }, false],
  ['surname corrected, first name and birthday agree', { firstName: 'Ana', lastName: 'Riviera', dob: '1950-03-04' }, { firstName: 'Ana', lastName: 'Rivera', dob: '1950-03-04' }, true],
  ['surname differs with no birthday to vouch for it', { firstName: 'Ana', lastName: 'Riviera' }, { firstName: 'Ana', lastName: 'Rivera' }, false],
  ['different people entirely', { firstName: 'Ana', lastName: 'Rivera' }, { firstName: 'Bo', lastName: 'Kim' }, false],
  ['a first name on one side and a surname on the other prove nothing', { firstName: 'Ana' }, { lastName: 'Rivera' }, false],
  ['surname only, matching, birthday absent', { lastName: 'Rivera' }, { firstName: 'Ana', lastName: 'Rivera' }, true],
];

describe('samePatient — the shared case table', () => {
  for (const [label, a, b, expected] of SAME_PATIENT_CASES) {
    it(`${label}: ${expected ? 'same' : 'different'}`, () => {
      expect(samePatient(a, b)).toBe(expected);
      expect(samePatient(b, a)).toBe(expected);
    });
  }
});

describe('nameKey and hasIdentity', () => {
  it('folds spelling and keeps nothing for an empty name', () => {
    expect(nameKey('  Mary  Ann ')).toBe('maryann');
    expect(nameKey('JOSÉ')).toBe('jose');
    expect(nameKey('—')).toBeUndefined();
    expect(hasIdentity({})).toBe(false);
    expect(hasIdentity({ dob: '1950-03-04' })).toBe(true);
  });
});

type F = { n: string; patient: PatientIdentity };
const ANA: F = { n: 'first', patient: { firstName: 'Ana', lastName: 'Rivera', dob: '1950-03-04' } };
const NOBODY: F = { n: 'nobody', patient: {} };

describe('filingForPatient — the same order of tests as the app', () => {
  it('nothing filed yet: a first filing', () => {
    expect(filingForPatient([], { firstName: 'Ana' })).toBeUndefined();
  });
  it('the current patient is nobody: the first filing', () => {
    expect(filingForPatient([ANA, NOBODY], {})).toBe(ANA);
  });
  it('a date of birth alone does not split a call', () => {
    expect(filingForPatient([NOBODY, ANA], { dob: '1950-03-04' })).toBe(ANA);
    expect(filingForPatient([ANA], { dob: '1999-09-09' })).toBe(ANA);
  });
  it('the same patient: their filing', () => {
    expect(filingForPatient([ANA], { firstName: 'ana', lastName: 'RIVERA' })).toBe(ANA);
  });
  it('a filing made before anyone was named is claimed', () => {
    expect(filingForPatient([NOBODY], { firstName: 'Bo', lastName: 'Kim' })).toBe(NOBODY);
  });
  it('the patient’s own filing wins over an unclaimed one', () => {
    expect(filingForPatient([NOBODY, ANA], { firstName: 'Ana', lastName: 'Rivera' })).toBe(ANA);
  });
  it('a different patient: a new filing — the PCP-72764 defect', () => {
    expect(filingForPatient([ANA], { firstName: 'Bo', lastName: 'Kim', dob: '1962-11-02' })).toBeUndefined();
  });
});
