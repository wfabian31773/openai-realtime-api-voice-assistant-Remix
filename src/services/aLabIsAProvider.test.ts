/**
 * A LABORATORY IS A PROVIDER FACILITY (v108).
 *
 * Operator, 2026-10-21: "add lab and laboratory to the provider list." The
 * corpus call is CA02cebe2231c3f8208c099c8736ea5c7a (2026-10-21 00:20 UTC):
 * a reference lab calling stat results for one of our doctors named itself,
 * answered refusal 3's question with the lab's name and "lab", and was taken
 * as a message because "lab" was not a facility word.
 *
 * Measured before the change, after-hours calls since 2026-07-01 whose caller
 * said "lab": 55 calls, 6 escalations, 4 of them labs calling in results
 * (CA02cebe2231c3f8208c099c8736ea5c7a, CAedf2bced4c1ca856b2fea141539dd819,
 * CA4191b448d2f90e5506b399dc26e78d01, CA0afa4eae6b434d90f9d1068af68ea723).
 * Most of the rest are an OPTICAL lab chasing frames, and none of those has
 * escalated. Synthetic stand-ins in the same shapes; no real names.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  callerSaysTheyAreAProvider,
  corroborate,
  noteCallerTranscript,
  releaseCallerSpeech,
} from './symptomCorroboration';
import { judgeEscalation } from './afterHoursEscalationGate';

const CALL = 'CA00000000000000000000000000000108';
const ASK = "AGENT: Are you calling from a doctor's office, a hospital or a clinic, and which one?";
beforeEach(() => releaseCallerSpeech(CALL));

describe('a lab that names itself is a provider', () => {
  const LABS = [
    // CAedf2bced's shape: the lab's own name, then "laboratory calling".
    'Hello, this is Pat at Example Diagnostic Laboratory calling from a recorded line. We have a critical lab result for Dr. Lin.',
    "I'm calling from the Example lab about a patient of Dr. Lin.",
    'This is Example Laboratory with a stat result for Dr. Lin.',
    "We're with the reference laboratory, calling about a patient.",
    'Llamo del laboratorio Ejemplo por un resultado del doctor Lin.',
  ];
  for (const text of LABS) {
    it(`counts: ${text.slice(0, 60)}`, () => expect(callerSaysTheyAreAProvider(text)).toBe(true));
  }

  it('a bare answer naming the lab, in its own turn, counts', () => {
    expect(callerSaysTheyAreAProvider(['Hi, I have results for the on-call doctor.', 'Yes, Example lab.'])).toBe(true);
    expect(callerSaysTheyAreAProvider(['Example Laboratory.'])).toBe(true);
    expect(callerSaysTheyAreAProvider(['Sí, del laboratorio Ejemplo.'])).toBe(true);
  });
});

describe('a patient talking about their own labs is not', () => {
  const PATIENTS = [
    "I'm calling about my lab results.",
    "I had lab work I'm calling about.",
    'I need my lab results calling me back tomorrow.',
    'The doctor ordered a lab test and I wanted to ask about it.',
    'Lab results.',
    'Is my lab for infusion going to conflict with the surgery?',
  ];
  for (const text of PATIENTS) {
    it(`does not count: ${text}`, () => expect(callerSaysTheyAreAProvider(text)).toBe(false));
  }
});

describe('an optical lab is a supplier, not a provider', () => {
  it('"optical lab" never counts, as a bare answer or in a sentence', () => {
    expect(callerSaysTheyAreAProvider(['Optical lab.'])).toBe(false);
    expect(callerSaysTheyAreAProvider("I'm calling from the optical lab about a frame.")).toBe(false);
    expect(callerSaysTheyAreAProvider('This is the optical lab, we are waiting on a frame.')).toBe(false);
  });

  it('ACCEPTED RESIDUE: an optical lab that names itself without "optical" still reads as a facility', () => {
    // None of these callers has escalated since July, and routine business
    // (frames, orders, status of) has its own refusal ahead of the default.
    // Asserted so the residue is visible rather than pretended away.
    expect(callerSaysTheyAreAProvider("I'm calling from the Example lab. We're waiting on a frame for a patient.")).toBe(true);
  });

  it('ACCEPTED RESIDUE: a lab call centre that never says where it is calling from is still asked', () => {
    // CA4191b448's shape: "Client service." then "the patient has critical lab results".
    expect(callerSaysTheyAreAProvider(['Client service.', 'Patient has critical lab results.'])).toBe(false);
  });
});

describe('the gate, on the corpus call', () => {
  const reason = 'Diagnostics laboratory calling with stat lab results for the on-call physician';

  it('refused on the introduction alone ("stat labs" is not a place), then allowed once the caller names the lab', () => {
    const before = [
      'AGENT: Thank you for calling. Our offices are currently closed.',
      'CALLER: Hi, this is Dana with Example Diagnostics calling on a recorded line. I have stat labs for Dr. Lin.',
    ];
    noteCallerTranscript(CALL, before);
    const first = judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') });
    expect(first).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    if (!first.allowed) expect(first.directive).toMatch(/laboratory reporting results counts/);

    noteCallerTranscript(CALL, [...before, ASK, 'CALLER: From Example Diagnostics, uh, lab.']);
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') })).toEqual({
      allowed: true,
      basis: 'provider_or_facility',
    });
  });

  it('an optical lab answering the same question is still refused', () => {
    const before = ['AGENT: Thank you for calling.', 'CALLER: Optical. We are waiting on a frame for a patient.'];
    noteCallerTranscript(CALL, [...before, ASK, 'CALLER: The optical lab.']);
    expect(
      judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Lab calling about a patient frame',
        corroboration: corroborate(CALL, ''),
      }),
    ).toMatchObject({ allowed: false });
  });
});
