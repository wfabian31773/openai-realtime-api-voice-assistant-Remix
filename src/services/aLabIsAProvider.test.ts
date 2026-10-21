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
const ASK =
  "AGENT: Are you calling from a doctor's office, a hospital, a clinic or a laboratory, and which one?";
const OLD_ASK = "AGENT: Are you calling from a doctor's office, a hospital or a clinic, and which one?";
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

describe('review r1 (#359): the exclusions hold through fillers and in Spanish', () => {
  const inTheWindow = (answer: string) => {
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: I need some help.', ASK, `CALLER: ${answer}`]);
    return corroborate(CALL, '').providerStated;
  };

  it('an optical lab with a filler or a sentence break before "lab" is still not a provider', () => {
    for (const answer of ['The optical, uh, lab.', 'Optical. Lab.', 'Optical, um, lab, about a frame.']) {
      expect(inTheWindow(answer), answer).toBe(false);
      expect(callerSaysTheyAreAProvider([answer]), answer).toBe(false);
    }
  });

  it('a self-introduction with a filler between "optical" and "lab" is not a provider either', () => {
    // The self-identification path reads the caller's raw words, fillers and all.
    expect(callerSaysTheyAreAProvider("I'm with the optical uh lab, about a frame.")).toBe(false);
    expect(callerSaysTheyAreAProvider('This is the optical um lab calling about an order.')).toBe(false);
  });

  it('a Spanish-speaking patient asking about their own lab results is not a provider', () => {
    for (const answer of [
      'Resultados del laboratorio.',
      'Los resultados de laboratorio.',
      'Mis resultados del laboratorio.',
      'Examen de laboratorio.',
      'Las pruebas del laboratorio.',
    ]) {
      expect(inTheWindow(answer), answer).toBe(false);
      expect(callerSaysTheyAreAProvider([answer]), answer).toBe(false);
    }
  });

  it('a Spanish optical lab is not a provider either', () => {
    expect(inTheWindow('Del laboratorio óptico.')).toBe(false);
    expect(callerSaysTheyAreAProvider('Llamo del laboratorio óptico por unos lentes.')).toBe(false);
  });

  it('a lab that answers the question still counts, in both languages', () => {
    expect(inTheWindow('From Example Diagnostics, uh, lab.')).toBe(true);
    expect(inTheWindow('Del laboratorio Ejemplo.')).toBe(true);
    expect(inTheWindow('Del laboratorio.')).toBe(true);
  });
});

describe('review r2 (#359): every exclusion holds through fillers, punctuation and sentence breaks', () => {
  const both = (answer: string) => {
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: I need some help.', ASK, `CALLER: ${answer}`]);
    return { window: corroborate(CALL, '').providerStated, raw: callerSaysTheyAreAProvider([answer]) };
  };

  it('a patient\'s own lab results with a filler or a break before "results" are not a provider', () => {
    for (const answer of ['Lab, uh, results.', 'Lab. Results.', 'Laboratory, um, results.', 'My lab, uh, work.']) {
      expect(both(answer), answer).toEqual({ window: false, raw: false });
    }
  });

  it('a Spanish patient\'s results with a filler anywhere before "laboratorio" are not a provider', () => {
    for (const answer of ['Resultados, uh, del laboratorio.', 'Resultados del, eh, laboratorio.', 'Examen, mm, de laboratorio.']) {
      expect(both(answer), answer).toEqual({ window: false, raw: false });
    }
  });

  it('a Spanish optical lab with a filler before "óptico" is not a provider, introduced or answering', () => {
    expect(both('Llamo del laboratorio, uh, óptico por unos lentes.')).toEqual({ window: false, raw: false });
    expect(both('Del laboratorio, eh, óptico.')).toEqual({ window: false, raw: false });
  });

  it('a real lab with a filler in its answer still counts', () => {
    expect(both('From Example Diagnostics, uh, lab.').window).toBe(true);
    expect(both('Yes, Example lab, uh, calling about a patient.').window).toBe(true);
    expect(both('Del laboratorio, eh, Ejemplo.').window).toBe(true);
  });

  it('a run of punctuation does not stall the matcher', () => {
    // Round 1's gap nested a repeat inside a repeat, which doubles its time
    // with every extra dot: about a second at 27 dots, and a hang at a few
    // dozen. The gap now takes one character per repetition. 27 keeps the
    // broken form failing in about a second instead of hanging the suite.
    both('Example lab.');
    const nasty = 'optical' + '.'.repeat(27) + 'x lab' + '.'.repeat(27) + 'x';
    const t0 = Date.now();
    both(nasty);
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe('review r3 (#359): results before the lab, and a filler held for a long time', () => {
  const window = (answer: string) => {
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: I need some help.', ASK, `CALLER: ${answer}`]);
    return corroborate(CALL, '').providerStated;
  };

  it('a patient whose results come before the word "lab" is not a provider, in either language', () => {
    for (const answer of ['My results are from the lab.', 'Results from the lab.', 'The test was at the lab.', 'Mis resultados son del laboratorio.', 'El examen fue en el laboratorio Ejemplo.']) {
      expect(window(answer), answer).toBe(false);
      expect(callerSaysTheyAreAProvider([answer]), answer).toBe(false);
    }
  });

  it('a lab that mentions results later in its answer still counts', () => {
    expect(window('Yes, Example lab, uh, calling about a patient\'s results.')).toBe(true);
    expect(callerSaysTheyAreAProvider('This is Example Laboratory calling with critical results for Dr. Lin.')).toBe(true);
  });

  it('a filler held for a long time does not stall the matcher', () => {
    callerSaysTheyAreAProvider('Example lab.');
    const t0 = Date.now();
    callerSaysTheyAreAProvider('This is Example lab ' + 'm'.repeat(62) + 'x');
    window('Example lab ' + 'm'.repeat(62) + 'x');
    expect(Date.now() - t0).toBeLessThan(150);
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

describe('review r4 (#359): the question itself offers a laboratory', () => {
  // A lab asked "an office, a hospital or a clinic?" can truthfully answer
  // "No, I'm calling from a lab", and a "no" is read as a denial. So the
  // question names a laboratory, and the window still opens on the old words
  // for a call that straddles the deploy.
  const before = ['AGENT: Thank you for calling.', 'CALLER: I have stat results for the on-call doctor.'];
  const opened = (ask: string, answer: string) => {
    noteCallerTranscript(CALL, [...before, ask, `CALLER: ${answer}`]);
    return corroborate(CALL, '').providerStated;
  };

  it('the gate and the agent both ask the question with a laboratory in it', async () => {
    noteCallerTranscript(CALL, before);
    const refused = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Lab calling with stat results',
      corroboration: corroborate(CALL, ''),
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.directive).toContain('a hospital, a clinic or a laboratory, and which one?');
    const agentSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../agents/noIvrAgent.ts', import.meta.url), 'utf8'),
    );
    expect(agentSource).toContain("hospital, a clinic or a laboratory, and which one?");
  });

  // These answers count only inside the window (a control below proves it),
  // so each test turns on the window opening rather than on the bare answer.
  const WINDOW_ONLY = 'Uh yes, Example Diagnostics, the lab.';
  const WINDOW_ONLY_ES = 'Sí, el laboratorio Ejemplo en la calle Main.';

  it('control: those answers do not count without the question', () => {
    expect(opened('AGENT: How can I help?', WINDOW_ONLY)).toBe(false);
    expect(opened('AGENT: How can I help?', WINDOW_ONLY_ES)).toBe(false);
  });

  it('a lab answering the new question counts, however it phrases it', () => {
    for (const answer of [WINDOW_ONLY, 'Example Diagnostics Lab.', 'A laboratory, Example Diagnostics.']) {
      expect(opened(ASK, answer)).toBe(true);
    }
  });

  it('the old question still opens the window, for a call that straddles the deploy', () => {
    expect(opened(OLD_ASK, WINDOW_ONLY)).toBe(true);
  });

  it('a paraphrase that names only a laboratory opens the window, in English and Spanish', () => {
    expect(opened('AGENT: Are you calling from a laboratory?', WINDOW_ONLY)).toBe(true);
    expect(opened('AGENT: ¿Llama desde un laboratorio?', WINDOW_ONLY_ES)).toBe(true);
  });

  // review r5 (#359): the paraphrase says "lab", not "laboratory".
  it('a paraphrase that says "lab" opens the window too, and "label" does not', () => {
    expect(opened('AGENT: Are you calling from a lab, and which one?', WINDOW_ONLY)).toBe(true);
    expect(opened('AGENT: Are you calling from the lab?', WINDOW_ONLY)).toBe(true);
    expect(opened("AGENT: Is the number you're calling from on the label?", WINDOW_ONLY)).toBe(false);
  });

  it('a patient answering the new question with their own results still does not count', () => {
    expect(opened(ASK, 'No, my lab results.')).toBe(false);
    expect(opened(ASK, 'The optical lab.')).toBe(false);
  });
});
