/**
 * NO PROVIDER ESCALATION UNLESS THE CALLER SAID THEY ARE A PROVIDER.
 *
 * Operator, 2026-10-19: "no escalation unless the caller themselves said they
 * are a provider." The corpus call is CA4079341a0d7e7cbbc9daf36da56bb7c0
 * (2026-10-18 16:31 UTC): the caller said one word, "Operator.", the agent
 * wrote it up as "caller identified as operator/clinician", the gate passed
 * it as a provider call and the on-call phone answered. Over 75 days the same
 * door let patients through who asked for their own doctor by name, because
 * the agent's reason then names a doctor and `dr.` is a provider term.
 *
 * Three pieces, each tested here:
 *
 *   1. callerSaysTheyAreAProvider — SELF-IDENTIFICATION, not the word
 *      "doctor". Checked against the 75-day corpus before it was written
 *      down (14 real providers pass, 10 ambiguous callers are asked, 20
 *      patients are not providers); the cases below are synthetic stand-ins
 *      in the same shapes. No real names.
 *   2. The gate refuses the provider case without it — and only the provider
 *      case: a patient who describes an emergency in their own words still
 *      rings, and no record of the caller speaking still fails open.
 *   3. The runtime FEEDS the ledger the gate reads. Only the old core did, so
 *      from 2026-10-01, when the after-hours line moved, the gate never saw a
 *      caller's words and its symptom check failed open on every call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callerSaysTheyAreAProvider,
  corroborate,
  noteCallerTranscript,
  recordCallerSpeech,
  releaseCallerSpeech,
  callerSaid,
  answersToTheFacilityQuestion,
  CALLER_SYMPTOM,
} from './symptomCorroboration';
import { judgeEscalation } from './afterHoursEscalationGate';

const CALL = 'CA00000000000000000000000000000099';
beforeEach(() => releaseCallerSpeech(CALL));

describe('a caller who says who they are is a provider', () => {
  const PROVIDERS = [
    'This is Dr. Lee. I need to speak to the ophthalmologist on call.',
    "Hi, I'm a PA calling from Mercy General's emergency room.",
    'Yes, this is an emergency room doctor calling from Valley Community Hospital about a patient.',
    'My name is Doctor Ramos, and I am calling for a peer-to-peer.',
    'Need the on-call doctor. My name is Sam, calling from Westside Memorial Hospital E R.',
    'The patient of Doctor Hart that is on our E R.',
    'This patient is on the E R and we need a callback.',
    'I have a post-operative patient with a pressure of fifty.',
    'Can I have the lab report for our mutual patient?',
    "I'm speaking on behalf of a clinic.",
    'On-call doctor, referring doctor on the phone.',
    'Our physician is waiting for a callback about the patient.',
    'Soy la doctora Morales, llamo del hospital.',
    'Le llamo desde la sala de emergencias por un paciente.',
    'This is the emergency room at Huntington calling.',
    "Hi, this is St. Vincent's hospital, we have a patient of yours here.",
    // Kept true by the review P2 tightening (#353).
    'This is Dr. Patel from Pomona Valley.',
    "I'm a nurse calling from Pomona Valley Hospital.",
    "I'm calling from Dr. Lee's office about a patient.",
    "I'm calling from Doctor Lee's office about a patient.",
    "I'm the resident on call at County.",
    "I'm an NP with the clinic on Main Street.",
    // Review r2 P2, #353: office staff who name their doctor.
    "I'm Dr. Kim's nurse.",
    "I'm Doctor Patel's MA, calling about a patient.",
    "This is Dr. Lee's surgical coordinator.",
    // A leading English "no" is an interjection, answering "are you the
    // patient?" — not a denial of what follows, comma or no comma.
    'No this is the ER at Huntington.',
    "No I'm Dr. Lee from the emergency room.",
    "No I'm calling from Kaiser hospital about a patient.",
    "No, I'm calling from Kaiser hospital about a patient.",
    // Review r2 P2, #353: the bare answer to refusal 3's own question.
    'Yes, Pomona Valley Hospital.',
    "Dr. Lee's office.",
    "St. Joe's ER.",
    'Sí, del hospital.',
    "Yeah, from the Westside Eye Clinic.",
    // Review r3 P2, #353: fillers, a subject before the answer, the facility
    // first, a name after it.
    'Yeah, uh, Pomona Valley Hospital.',
    'Hospital, Kaiser Fontana.',
    'The ER at Cedars.',
    'Hospital — Cedars-Sinai.',
    'Yes I am, Pomona Valley Hospital.',
    "Yeah, it's Kaiser hospital.",
    'Yes, I’m calling from Pomona Valley Hospital',
    'Sí, del Hospital General.',
    // Review r5 P2 (#353): kept true once the gap words exclude pronouns.
    "I'm calling from St. Joe's emergency room.",
    'Calling from Pomona Valley Hospital ER.',
    'This is the emergency room at Westside Memorial calling about a patient.',
    "I'm with Kaiser Fontana ER.",
  ];
  for (const t of PROVIDERS) it(t, () => expect(callerSaysTheyAreAProvider(t)).toBe(true));
});

describe('mutual patient self-identification', () => {
  it.each(['a mutual patient', 'our mutual patient', 'our patients',
    'one mutual patient', 'the mutual patient', 'one mutual patients', 'the mutual patients',
  ])('recognizes %s', (phrase) => {
    expect(callerSaysTheyAreAProvider(`Calling about ${phrase}.`)).toBe(true);
  });

  it.each(['one patient', 'the patient', 'not the mutual patient'])('does not infer a provider from %s', (phrase) => {
    expect(callerSaysTheyAreAProvider(`Calling about ${phrase}.`)).toBe(false);
  });

  it.each([
    "I'm the mutual patient.",
    'I am the mutual patient you called.',
    'I’m actually the mutual patient.',
    "I'm a mutual patient.",
    'I am also a mutual patient.',
    "I'm the one mutual patient.",
    'I am the one mutual patient you called.',
    'I’m actually the one mutual patient.',
    'I am one of the mutual patients.',
    "I'm also one of the mutual patients you called.",
    'This is Jane, the one mutual patient.',
    'This is Jane, one of the mutual patients.',
    'This is the mutual patient.',
    'This is actually a mutual patient.',
    'This is Jane, the mutual patient.',
    'I am Jane, the mutual patient you called.',
    "I'm Jane Smith, the mutual patient.",
    'This is Jane the mutual patient.',
    'My name is Jane Smith, the mutual patient.',
    'My name is Jane, a mutual patient.',
    'My name is actually Jane Smith the mutual patient.',
    'Jane Smith, the mutual patient',
    'The mutual patient, Jane Smith',
    'Jane, the mutual patient.',
    "Jane Anne Smith-Jones, the mutual patient.",
    'The mutual patient, Jane.',
    "The mutual patient, Jane Anne Smith-Jones.",
    'Hello. Jane Smith, the mutual patient.',
    'Hello. The mutual patient, Jane Smith.',
    'The mutual patient is me.',
    "The mutual patient's me.",
  ])('does not mistake a patient identifying themselves for a provider: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(false);
  });

  it('still recognizes independent provider identification in the same conversation', () => {
    expect(callerSaysTheyAreAProvider(["I'm the mutual patient.", 'This is Dr. Lee calling.'])).toBe(true);
    expect(callerSaysTheyAreAProvider("I'm the mutual patient. Calling about our mutual patient.")).toBe(true);
    expect(callerSaysTheyAreAProvider("I'm the mutual patient. Calling about the mutual patient.")).toBe(true);
    expect(callerSaysTheyAreAProvider('This is the mutual patient. Calling about the mutual patient.')).toBe(true);
    expect(callerSaysTheyAreAProvider(['This is the mutual patient.', 'This is Dr. Lee calling.'])).toBe(true);
    expect(callerSaysTheyAreAProvider('This is Jane, calling about the mutual patient.')).toBe(true);
    expect(callerSaysTheyAreAProvider('This is Jane, a nurse calling about the mutual patient.')).toBe(true);
    expect(callerSaysTheyAreAProvider('The mutual patient is my mother.')).toBe(true);
    expect(callerSaysTheyAreAProvider('This is Jane, the mutual patient. Calling about the mutual patient.')).toBe(true);
    expect(callerSaysTheyAreAProvider('The mutual patient is me. Calling about the mutual patient.')).toBe(true);
    expect(callerSaysTheyAreAProvider("I'm the one mutual patient. This is Dr. Lee calling.")).toBe(true);
    expect(callerSaysTheyAreAProvider('I am one of the mutual patients. Calling about the mutual patient.')).toBe(true);
  });

  it.each([
    'Calling about Jane Smith, the mutual patient.',
    'Calling about the mutual patient, Jane Smith.',
    'Calling about Dr. Smith, the mutual patient.',
    'Regarding Jane Smith, the mutual patient.',
    'Regarding the mutual patient, Jane Smith.',
    'The mutual patient, calling about a callback.',
    'The mutual patient, Jane Smith. Calling about the mutual patient.',
    'Jane Smith, the mutual patient. Calling about the mutual patient.',
    'Jane Smith, the mutual patient. This is Dr. Lee calling.',
    'My name is Jane, calling about the mutual patient.',
    'My name is Jane, a nurse calling about the mutual patient.',
    'My name is Jane Smith, the mutual patient. Calling about the mutual patient.',
    'My name is Jane Smith, the mutual patient. This is Dr. Lee calling.',
  ])('preserves independent provider evidence: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
  });
});

describe('mutual patient clauses after a provider introduction', () => {
  it.each(
    ['our mutual patient', 'our mutual patients', 'the mutual patient', 'a mutual patient']
      .flatMap((patient) => [
        'has a question about her medication',
        'is waiting for a response',
        'was seen yesterday',
        'needs a consultation',
        'requires a consultation',
        'wants to speak to someone',
        'called about a prescription',
        'came in yesterday',
        'had a question',
        'will call tomorrow',
        'can speak now',
        'does need a response',
        'did call yesterday',
        'still has a question',
        'has been waiting',
        'asked about a medication',
        'left a message',
        'cannot come in today',
        'never received a response',
        "hasn't received a response",
        "won't be coming in",
        'usually calls in the morning',
        'got a new prescription',
      ].map((predicate) => `This is Sarah, ${patient} ${predicate}.`)),
  )('preserves the separate patient clause in %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
    for (const feed of ['core', 'runtime'] as const) {
      releaseCallerSpeech(CALL);
      if (feed === 'core') recordCallerSpeech(CALL, spoken);
      else noteCallerTranscript(CALL, [`CALLER: ${spoken}`]);
      const corroboration = corroborate(CALL, '');
      expect(corroboration.providerStated, feed).toBe(true);
      expect(judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Provider requesting the on-call physician',
        corroboration,
      }), feed).toEqual({ allowed: true, basis: 'provider_or_facility' });
    }
  });

  it.each([
    'This is Sarah, our mutual patient has a question about her medication',
    "I'm Sarah, our mutual patient has a question.",
    'I am Sarah, the mutual patient was seen yesterday.',
    'My name is Sarah Smith, a mutual patient called yesterday.',
    'Hello, Sarah Smith, our mutual patients will call tomorrow.',
    'Sarah, the mutual patient came in yesterday.',
    'This is Sarah, our mutual patient has a question. This is Jane, the mutual patient.',
    'This is Jane, the mutual patient. This is Sarah, our mutual patient has a question.',
    'This is Sarah, our mutual patient is returning your call.',
    'This is Sarah, calling about our mutual patient returning your call.',
    'This is Sarah, the mutual patient returning your call. Calling about our mutual patient.',
    'This is Sarah, the mutual patient calling about my appointment. This is Dr. Lee calling.',
  ])('handles introduction and clause boundaries in %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
  });

  it.each(
    ['This is Sarah,', 'This is Sarah', 'I am Sarah,', 'My name is Sarah,', 'Sarah,']
      .flatMap((introduction) => [
        'returning your call',
        'calling about my appointment',
        'waiting for my results',
        'following up on my referral',
        'checking on my prescription',
      ].map((modifier) => `${introduction} the mutual patient ${modifier}.`)),
  )('preserves patient introductions with participial modifiers: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(false);
    for (const feed of ['core', 'runtime'] as const) {
      releaseCallerSpeech(CALL);
      if (feed === 'core') recordCallerSpeech(CALL, spoken);
      else noteCallerTranscript(CALL, [`CALLER: ${spoken}`]);
      const corroboration = corroborate(CALL, '');
      expect(corroboration.providerStated, feed).toBe(false);
      expect(judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Provider requesting the on-call physician',
        corroboration,
      }), feed).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    }
  });

  it.each([
    'This is Sarah, our mutual patient.',
    'This is Sarah, our mutual patients.',
    'This is Sarah, the mutual patient',
    'This is Sarah, a mutual patient.',
    'This is Sarah, the mutual patient you called.',
    'This is Sarah, the mutual patient who called yesterday.',
    'This is Sarah, the mutual patient from yesterday.',
    'This is Sarah, the mutual patient. She has a question about her medication.',
    'This is Sarah, the mutual patient, she has a question about her medication.',
    "It's me, the mutual patient.",
    "I'm calling as the mutual patient.",
    'This is Sarah, not the mutual patient has a question.',
  ])('keeps self-identification and denied evidence excluded in %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(false);
  });
});

describe('patient introductions after greetings and across caller turns', () => {
  it.each([
    { turns: ["It's me, the mutual patient."] },
    { turns: ['It is me, the mutual patient.'] },
    { turns: ['It’s me the mutual patient.'] },
    { turns: ["I'm calling as the mutual patient."] },
    { turns: ['I am calling as the mutual patient.'] },
    { turns: ["I'm actually calling as the mutual patient."] },
    { turns: ['This is me, the mutual patient.'] },
    { turns: ["Hello, it's me, the mutual patient."] },
    { turns: ['I need an appointment', "I'm calling as the mutual patient."] },
    { turns: ['I need an appointment', 'This is me, the mutual patient.'] },
    { turns: ['Hello, Jane Smith, the mutual patient.'] },
    { turns: ['Hello, the mutual patient, Jane Smith.'] },
    { turns: ['Hi Jane Anne Smith-Jones, the mutual patient.'] },
    { turns: ['Good morning the mutual patient, Jane Smith.'] },
    { turns: ['I need an appointment, Jane Smith, the mutual patient.'] },
    { turns: ['I need an appointment, the mutual patient, Jane Smith.'] },
    { turns: ['I need an appointment', 'Jane Smith, the mutual patient'] },
    { turns: ['I need an appointment', 'The mutual patient, Jane Smith'] },
    { turns: ['I need an appointment', 'Hello, Jane Smith, the mutual patient.'] },
    { turns: ['I need an appointment', 'Hello, the mutual patient, Jane Smith.'] },
    { turns: ['I need an appointment', 'Hi Jane Anne Smith-Jones, the mutual patient.'] },
  ])('refuses provider escalation for $turns', ({ turns }) => {
    expect(callerSaysTheyAreAProvider(turns)).toBe(false);
    if (turns.length === 1) expect(callerSaysTheyAreAProvider(turns[0])).toBe(false);

    // Both transcript feeds must preserve the boundaries seen by the gate.
    for (const feed of ['core', 'runtime'] as const) {
      releaseCallerSpeech(CALL);
      if (feed === 'core') turns.forEach((turn) => recordCallerSpeech(CALL, turn));
      else noteCallerTranscript(CALL, turns.map((turn) => `CALLER: ${turn}`));
      const corroboration = corroborate(CALL, '');
      expect(corroboration.providerStated, feed).toBe(false);
      expect(judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Provider requesting the on-call physician',
        corroboration,
      }), feed).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    }
  });

  it.each([
    { turns: ["It's me, the mutual patient. Calling about our mutual patient."] },
    { turns: ["I'm calling as the mutual patient.", 'This is Dr. Lee calling.'] },
    { turns: ['Hello, calling about Jane Smith, the mutual patient.'] },
    { turns: ['Hello, calling about the mutual patient, Jane Smith.'] },
    { turns: ['Hello, regarding Jane Smith, the mutual patient.'] },
    { turns: ['Hello, regarding the mutual patient, Jane Smith.'] },
    { turns: ['Hello, Jane Smith, the mutual patient. Calling about our mutual patient.'] },
    { turns: ['Hello, Jane Smith, the mutual patient.', 'This is Dr. Lee calling.'] },
    { turns: ['I need an appointment', 'Jane Smith, the mutual patient', 'Calling about our mutual patient.'] },
    { turns: ['Hello, Jane Smith, the mutual patient.', 'Yes, Example Hospital.'] },
  ])('preserves independent provider evidence in $turns', ({ turns }) => {
    expect(callerSaysTheyAreAProvider(turns)).toBe(true);
    noteCallerTranscript(CALL, turns.map((turn) => `CALLER: ${turn}`));
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider requesting the on-call physician',
      corroboration: corroborate(CALL, ''),
    })).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });
});

describe('asking for a doctor, an operator or a page is not saying you are one', () => {
  const NOT_YET = [
    'Operator.',
    'Hello? | Daniel please.',
    'Paging on-call physician.',
    'Page Doctor Hart. Page Doctor Hart.',
    'Speak to the on-call provider.',
    'Do you have anybody available for Doctor Hart?',
    'Operator? | Calling a doctor.',
    'Quiero hablar con alguien de la oficina de Azul Visión.',
  ];
  for (const t of NOT_YET) it(t, () => expect(callerSaysTheyAreAProvider(t)).toBe(false));

  const PATIENTS = [
    'Can you speak to Doctor Shah please?',
    'I was calling for Doctor Nair, she was supposed to fax my eye drop refill.',
    "Yeah, I'm a patient of Dr. Choi and I'd like to know about my prescription. Is there a doctor on call?",
    'I need to talk to a doctor, my eyes are swollen.',
    'The emergency doctor told her to see an eye doctor immediately.',
    "I came to the hospital and my pressure is high. I'm still over here at the hospital.",
    "I'm here in the clinic but the door is closed.",
    "My name is Kim and I'm calling from a pharmacy benefits company on behalf of a health plan about three separate patients.",
    'I have a patient portal question.',
    '¿Es la clínica azul? ¿Puedo hacer la cita?',
    "There's a clinic. This is clinical. It's a clinical.",
    // Review P2, #353: patient sentences the first version read as providers.
    "I'm Dr. Shah's patient.",
    'I’m Dr. Shah’s patient.',
    "I'm the doctor's patient.",
    'I am a resident of Covina.',
    'I have been a patient there for years.',
    // A denied self-identification is not one (the negation guard, #353).
    "I'm not calling from a hospital.",
    'No llamo de una clínica, soy paciente.',
    'This is not the hospital, right?',
    "No I'm not calling from a hospital.",
    'No soy la doctora, soy la paciente.',
    'No tengo un paciente, yo soy el paciente.',
    'We have a patient appointment tomorrow.',
    // Review r2 P2, #353: still patients once office staff count.
    "I'm Dr. Shah's wife.",
    "I'm Dr. Shah's patient, and my eye hurts.",
    // Review r2 P2, #353: a facility in a patient's sentence is not an answer.
    'My husband is in the hospital.',
    "He's in the hospital.",
    'I was at the hospital yesterday.',
    'Yes, I went to the ER.',
    "Is this Dr. Lee's office?",
    'Mi esposo está en el hospital.',
    // Review r3 P2, #353: still not answers once the bare form widened.
    'At the hospital.',
    'Cedars-Sinai.',
    'Uh, my husband is in the hospital.',
    'Yeah, hospital bill.',
    'The ER yesterday.',
    // Review r4 P2, #353: the strict forms refuse a denial or a want too.
    "No, I'm not calling from a hospital.",
    "No, it's not a doctor's office, I'm the patient.",
    "No, I'm a patient of the Covina clinic.",
    "I want Dr. Shah's office.",
    "Doctor Shah's office, please.",
    'Need Dr. Shah’s office.',
    'No, no llamo de un hospital.',
    "I'm not calling from a doctor's office, I need Dr. Shah",
    // Review r5 P2, #353: a relative AT a facility is not calling FROM it.
    "I'm with my mom at the ER, they told me to call the eye doctor.",
    "I'm calling from my husband's room at Kaiser hospital.",
    "I'm here with my son at the emergency room.",
    'Estoy con mi mamá en el hospital.',
    "I'm calling from my dad's room at Cedars hospital.",
  ];
  for (const t of PATIENTS) it(t, () => expect(callerSaysTheyAreAProvider(t)).toBe(false));
});

describe('the gate', () => {
  const corr = (spoken: string, claim = '') => {
    releaseCallerSpeech(CALL);
    if (spoken) recordCallerSpeech(CALL, spoken);
    return corroborate(CALL, claim);
  };

  it('the corpus call: "Operator." written up as a clinician is refused, not rung', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Caller identified as operator/clinician requesting human escalation',
      corroboration: corr('Operator.'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    if (!v.allowed) expect(v.directive).toMatch(/which one/);
  });

  it('a reason that merely names a doctor no longer makes the call a provider call', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Caller requested to speak directly to Doctor Shah (clinician call)',
      corroboration: corr('Can you speak to Doctor Shah please?'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
  });

  it('routine business still gets its own refusal, ahead of this one', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Clinician call, caller requesting Doctor Nair about an eye drop refill fax',
      corroboration: corr('I was calling for Doctor Nair, she was supposed to fax my eye drop refill.'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'administrative_request' });
  });

  it('a caller who says they are a provider still rings, whatever else the reason says', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'ER physician needs the on-call ophthalmologist about a patient appointment',
      corroboration: corr("I'm a PA calling from Mercy General's emergency room."),
    });
    expect(v).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it.each(['one mutual patient', 'the mutual patient', 'one mutual patients', 'the mutual patients'])(
    'lets a caller saying %s through the provider gate', (phrase) => {
      const v = judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Provider requesting the on-call physician',
        corroboration: corr(`Calling about ${phrase}.`),
      });
      expect(v).toEqual({ allowed: true, basis: 'provider_or_facility' });
    },
  );

  it.each([
    "This is Sarah, the mutual patient's nurse.",
    'This is Sarah, the mutual patient’s nurse.',
    "This is Sarah, the mutual patients' nurse.",
    'This is Sarah, the mutual patients’ nurse.',
    "I am Sarah, the mutual patient's physician.",
    "I'm Sarah, the mutual patient's nurse practitioner.",
    "My name is Sarah, the mutual patient's coordinator.",
    "Sarah, the mutual patient's nurse.",
    "This is the mutual patient's nurse.",
    "I'm the mutual patients' nurse.",
  ])('recognizes a provider role after the patient phrase: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
    const corroboration = corr(spoken);
    expect(corroboration.providerStated).toBe(true);
    expect(corroboration.acuteStated).toBe(false);
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider requesting the on-call physician',
      corroboration,
    })).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it.each([
    'This is a mutual patient referral. Can I speak to the on-call physician?',
    'This is actually a mutual patient referral.',
    'This is our mutual patient consultation.',
    'This is a mutual patient callback.',
    'This is a mutual patient follow-up.',
    'This is Sarah, a mutual patient referral.',
    'This is Sarah, a mutual patient consultation.',
    'Sarah, a mutual patient referral.',
  ])('recognizes a call description after the patient phrase: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
    const corroboration = corr(spoken);
    expect(corroboration.providerStated).toBe(true);
    expect(corroboration.acuteStated).toBe(false);
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider requesting the on-call physician',
      corroboration,
    })).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it.each([
    'Calling about the one mutual patient.',
    "I'm treating the one mutual patient.",
    'Calling about one of the mutual patients.',
    "I'm following up on one of the mutual patients.",
  ])('allows provider escalation for a reference to %s', (spoken) => {
    const corroboration = corr(spoken);
    expect(corroboration.providerStated).toBe(true);
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider requesting the on-call physician',
      corroboration,
    })).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it.each(
    [
      // Different clinical verbs exercise the -ing rule, rather than a list
      // of individually excluded verbs. No other provider statement is needed.
      'seeing', 'treating', 'evaluating', 'examining', 'assessing', 'managing',
      'monitoring', 'referring', 'following', 'consulting on',
      'calling about', 'calling regarding', 'calling concerning', 'calling for',
      'following up on', 'checking on', 'with', 'from', 'about', 'regarding',
      'concerning', 'in reference to', 'here about',
      "Dr. Smith's office calling about", "Dr Smith's office calling about",
      "Doctor Smith's office calling about",
    ].flatMap((description) =>
      ['a mutual patient', 'our mutual patient', 'Jane Smith, the mutual patient', 'the mutual patient, Jane Smith']
        .flatMap((patient) => ["I'm ", 'I am ', 'I’m actually ', 'This is ', 'This is just ', '']
          .map((introduction) => `${introduction}${description} ${patient}.`)),
    ).concat([
      'This is Jane, our mutual patient needs a consultation.',
      // Articles, roles and office descriptions are not personal names,
      // including roles that do not independently establish provider status.
      "I'm a scheduler, our mutual patient needs a consultation.",
      "I'm the coordinator, our mutual patient needs a consultation.",
      "I'm Jane's scheduler, our mutual patient needs a consultation.",
      "This is Smith's office, our mutual patient needs a consultation.",
      "I'm the provider, our mutual patient needs a consultation.",
      'This is the clinician, our mutual patient needs a consultation.',
      'This is a consultation about our mutual patient.',
      'This is regarding our mutual patient.',
      'This is a callback regarding our mutual patient.',
      'This is a referral concerning our mutual patient.',
      "I'm the nurse for our mutual patient.",
      "I'm an NP seeing our mutual patient.",
      'This is concerning a mutual patient.',
    ]),
  )('recognizes a call description and allows provider escalation: %s', (spoken) => {
    expect(callerSaysTheyAreAProvider(spoken)).toBe(true);
    const corroboration = corr(spoken);
    expect(corroboration.providerStated).toBe(true);
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider requesting the on-call physician',
      corroboration,
    })).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it.each(["I'm the mutual patient.", 'I am the mutual patient you called.', 'This is the mutual patient.',
    "I'm the one mutual patient.", 'I am the one mutual patient you called.',
    'I am one of the mutual patients.', "I'm also one of the mutual patients you called.",
    'This is Jane, the mutual patient.', 'I am Jane, the mutual patient you called.', 'The mutual patient is me.',
    'Jane Smith, the mutual patient', 'The mutual patient, Jane Smith',
    'This is a mutual patient. Can I speak to the on-call physician?',
    'This is a mutual patient referred to you.',
    'This is a mutual patient here for a referral.',
    'This is Sarah, the mutual patient you called.',
    "This is Sarah, the mutual patient's daughter.",
    "This is Sarah, the mutual patients' mother.",
    "This is Sarah, the mutual patient's nurse's mother.",
    ...['Jane', 'Jane Smith', 'Jane Anne Smith-Jones', "Mary-Jane O'Connor", 'jane smith', 'Jane King', 'Ming Lee']
      .flatMap((name) => [
        `${name}, the mutual patient.`,
        `The mutual patient, ${name}.`,
        `I'm ${name}, the mutual patient.`,
        `I am ${name} the mutual patient.`,
        `This is ${name}, the mutual patient.`,
        `My name is ${name}, the mutual patient.`,
        `My name is ${name} the mutual patient.`,
        `My name is actually ${name}, the mutual patient.`,
        `I'm actually ${name}, the mutual patient.`,
        `Hello. ${name}, the mutual patient.`,
        `Hello. The mutual patient, ${name}.`,
      ]),
  ])(
    'refuses an unstated provider escalation when the caller says %s', (spoken) => {
      const corroboration = corr(spoken);
      expect(corroboration.providerStated).toBe(false);
      expect(judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Provider requesting the on-call physician',
        corroboration,
      })).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
    },
  );

  it.each([
    "I'm the mutual patient, my eye is bleeding.",
    "I'm the one mutual patient, my eye is bleeding.",
    'I am one of the mutual patients, my eye is bleeding.',
    'Jane Smith, the mutual patient, my eye is bleeding.',
    'The mutual patient, Jane Smith, my eye is bleeding.',
    'My name is Jane Smith, the mutual patient, my eye is bleeding.',
  ])('still allows an acute emergency described by the mutual patient: %s', (spoken) => {
    expect(judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Patient reports eye bleeding',
      corroboration: corr(spoken, 'eye bleeding'),
    })).toEqual({ allowed: true, basis: 'acute_clinical' });
  });

  it('a patient who describes an emergency in their own words still rings, whatever the agent called them', () => {
    // "extreme pain" and "surgery today" are on neither acute list, so on main
    // this rang through the provider case, or default-open for a patient. It
    // must still ring: the refusal is for a reason with NO symptom in it.
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Family member calling: patient had surgery today and is in extreme pain',
      corroboration: corr('We need to talk to the doctor, he had surgery today and he is in extreme pain.', 'extreme pain'),
    });
    expect(v.allowed).toBe(true);
  });

  it('a symptom only the MODEL wrote does not lift the refusal (Codex P1, #353)', () => {
    // The caller said one word. The reason carries "redness" and "swelling",
    // which corroborate() does not check (it checks pain and vision) — so
    // reading the symptom off the reason rang this through default-open.
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Clinician caller reports patient eye redness and swelling, requests on-call doctor',
      corroboration: corr('Operator.'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
  });

  it('a symptom the CALLER described still lifts it, in either language', () => {
    for (const spoken of ['My eye is red and swollen, I need the doctor.', 'Me duele mucho el ojo, necesito al doctor.']) {
      const v = judgeEscalation({
        callerType: 'healthcare_provider',
        reason: 'Caller requests the on-call doctor',
        corroboration: corr(spoken),
      });
      expect(v.allowed, spoken).toBe(true);
    }
  });

  it('symptomStated reads the caller, never the claim, and is false with no speech', () => {
    expect(corr('Operator.', 'redness and swelling').symptomStated).toBe(false);
    expect(corr('my eye is red').symptomStated).toBe(true);
    expect(corr("I can’t see out of it").symptomStated, 'a curly apostrophe still reads').toBe(true);
    expect(corr('', 'redness').symptomStated).toBe(false);
    expect(corr('Quiero hablar con alguien de la oficina de Azul Visión.').symptomStated, 'the brand').toBe(false);
  });

  it('the brand name is not a symptom: "calling from Azul Vision" is still refused', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Provider office calling about a patient from Azul Vision office',
      corroboration: corr('Quiero hablar con alguien de la oficina de Azul Visión.'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
  });

  it('a bare answer to refusal 3, in its own turn, lets the second escalation through (review r2 P2)', () => {
    const reason = 'Clinician paging the on-call physician about a patient';
    releaseCallerSpeech(CALL);
    recordCallerSpeech(CALL, 'Paging on-call physician.');
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') })).toMatchObject({
      allowed: false,
      code: 'provider_not_stated_by_caller',
    });
    recordCallerSpeech(CALL, 'Yes, Pomona Valley Hospital.');
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') })).toEqual({
      allowed: true,
      basis: 'provider_or_facility',
    });
  });

  it('a facility inside a patient\'s own sentence does not', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Caller requesting the on-call physician',
      corroboration: corr('My husband is in the hospital.'),
    });
    expect(v).toMatchObject({ allowed: false, code: 'provider_not_stated_by_caller' });
  });

  it('no record of the caller speaking fails open, as every check here does', () => {
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'Clinician calling about a patient',
      corroboration: corr(''),
    });
    expect(v).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });

  it('a path with no corroboration at all is unchanged', () => {
    expect(
      judgeEscalation({ callerType: 'healthcare_provider', reason: 'Clinician calling about a patient' }),
    ).toEqual({ allowed: true, basis: 'provider_or_facility' });
  });
});

describe('a turn that answers refusal 3 names a facility anywhere in it (review r3 P2, #353)', () => {
  const ASK = "AGENT: Are you calling from a doctor's office, a hospital or a clinic, and which one?";
  const answered = (answer: string, ask = ASK) => {
    releaseCallerSpeech(CALL);
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: Paging on-call physician.', ask, `CALLER: ${answer}`]);
    return corroborate(CALL, '').providerStated;
  };

  const ANSWERS = [
    'Yeah, uh, Pomona Valley Hospital.',
    'Hospital, Kaiser Fontana.',
    'The ER at Cedars.',
    'Hospital — Cedars-Sinai.',
    'Yes I am, Pomona Valley Hospital.',
    "Yeah, it's Kaiser hospital.",
    "Yes, I'm calling from Pomona Valley Hospital",
    'Sí, del Hospital General.',
    'Uh, yeah, we are over at the Kaiser hospital in Fontana, the main one.',
    'Yes, it is the Pomona Valley hospital emergency department, I am the charge person.',
    // Review r5 P2, #353: a request after the answer, and a want read only
    // from the words governing the facility.
    'Yes, Pomona Valley Hospital ER, please have the on-call call me back.',
    'Sí, del Hospital General, por favor comuníqueme con el doctor de guardia.',
    'Yes, calling about a patient from Kaiser Fontana ER.',
    "I'm calling for Dr. Lee's office.",
    // A provider's "from", "need" or "by" still answers.
    'Hi, this is Sarah from Kaiser ER.',
    'I need a callback for a patient from Kaiser ER.',
    'Kaiser hospital, by the way.',
    "It's Pomona Valley Hospital, we need the on-call.",
    // The want-from reading ends AT the facility: an earlier want in the
    // sentence does not reach a facility named after it.
    'We need a call back from the on-call doc, Kaiser hospital ER.',
    // Review r6 P2, #353: the r6 guards must not cost these.
    'Yes, Pomona Valley Hospital.',
    'This is the emergency room at Westside Memorial calling about a patient',
    'No, this is the ER at Huntington',
    "We're calling from our clinic, the Covina Medical Group",
    // Round 7: "my patient" is a provider's word, not a relative's; and a
    // provider's "would like" or "have" is not a want of the facility.
    "I'm calling for my patient from Methodist Hospital ER.",
    'Yes, calling for my patient from Kaiser Fontana ER',
    "I'd like to report a patient from Kaiser hospital ER.",
    "Yes, Kaiser Fontana ER, I'd like to speak with the on-call",
    'We have a patient from Kaiser ER.',
    'We have the ER at Huntington on the line for the on-call.',
  ];
  for (const t of ANSWERS) it(`counts: ${t}`, () => expect(answered(t)).toBe(true));

  const NOT_ANSWERS = [
    'My husband is in the hospital.',
    "He's in the hospital.",
    'I was at the ER yesterday.',
    'Yes, I went to the ER.',
    "Is this Dr. Lee's office?",
    'Mi esposo está en el hospital.',
    'At the hospital.',
    'Cedars-Sinai.',
    'No, I just need my doctor.',
    // A patient's NO to the question still names the facility it denies; each
    // of these rang the on-call phone before the denial guard.
    "No, I'm not calling from a hospital.",
    "No, I'm a patient of the Pasadena clinic.",
    "No, not a clinic, I'm a patient.",
    "No, it's not a hospital.",
    'Nope, not a hospital.',
    "I'm not from a doctor's office.",
    'No soy de una clínica, soy paciente.',
    // Review r4 P2, #353: the same NO, or naming the office they WANT. "Doctor
    // Shah's office, please." is ambiguous as an answer to "which one?";
    // "please" asks for something, so it is read as a want and does not ring.
    "No, it's not a doctor's office, I'm the patient.",
    "No, I'm a patient of the Covina clinic.",
    "I want Dr. Shah's office.",
    "Doctor Shah's office, please.",
    'No, no llamo de un hospital.',
    "I'm not calling from a doctor's office, I need Dr. Shah",
    'I need to talk to the hospital about my bill.',
    "I need Dr. Shah's office.",
    'I want the Covina clinic.',
    'Please, Doctor Shah’s office.',
    "I'm with my mom at the ER, they told me to call the eye doctor.",
    "I'm calling from my dad's room at Cedars hospital.",
    // "from" after a want, after "me", and "by": the facility is what the
    // patient wants something from, or what acted on them.
    'Please, I need someone from the Covina clinic to call me.',
    'I need my results from the Pasadena clinic, please.',
    'I want a call back from the Covina office.',
    'They sent me home from Kaiser hospital.',
    'They discharged me from the ER at Kaiser.',
    'I was told to call by the Covina clinic.',
    'Necesito que alguien de la clínica me llame.',
    // Review r6 P2, #353: a want r5's narrowing let through — a possessive
    // before the facility, or a want of someone FROM it — and a relative.
    "I just want my doctor's office to call me back.",
    "I need a call back from my doctor's office.",
    "I'm looking for my doctor's office.",
    "I'd like to talk to somebody from the Covina clinic.",
    "Yes, I'm calling for my husband from Kaiser hospital.",
    'Quiero que me llame mi clínica.',
    // Round 7: "would like" and a causative "have/get" are wants.
    "I'd like the doctor's office to call me back.",
    "I would like Dr. Shah's office to call me.",
    "I'd like Dr. Lee's office, please.",
    'I would like the hospital to call me back.',
    'Please have the Covina clinic call me.',
    'Can you have the Pasadena clinic call me back?',
    'Can you have the Pasadena clinic call me back',
    'Could you please have the Covina clinic call me.',
    "Could you get the doctor's office to call me",
    'Have the Covina clinic call me.',
    'Sure, have the Pasadena clinic call me back.',
    'Me gustaría que la clínica me llame.',
    'Que me llame el consultorio, por favor.',
    // Round 7: "calling for my" a relative is still not a provider.
    "Yes, I'm calling for my husband from Kaiser hospital, he's a patient there.",
    'Calling for my mom from the ER.',
  ];
  for (const t of NOT_ANSWERS) it(`does not count: ${t}`, () => expect(answered(t)).toBe(false));

  it('a self-identified provider who would "like" the on-call still counts (review r7)', () => {
    expect(
      callerSaysTheyAreAProvider("This is Dr. Patel, I'd like the on-call to call me back about a post-op patient"),
    ).toBe(true);
  });

  it('the negation guard is scoped to its own sentence', () => {
    expect(answered("Sorry, I can't hear you well. Yes, Pomona Valley Hospital.")).toBe(true);
    expect(callerSaysTheyAreAProvider("I can't hear you. I'm calling from Mercy General Hospital.")).toBe(true);
    expect(callerSaysTheyAreAProvider("I'm calling from St. Joe's hospital, the patient can't see.")).toBe(true);
    expect(callerSaysTheyAreAProvider("I'm not calling from St. Joe's hospital.")).toBe(false);
    expect(callerSaysTheyAreAProvider('Yes, I work for Kaiser hospital, calling from the ER.')).toBe(true);
  });

  it('the window opens on close paraphrases and a cut-off ask, not on unrelated agent lines (review r4 P3)', () => {
    const opens = [
      "AGENT: Are you calling from a doctor's office, a hospital, or a clinic, and which one?",
      'AGENT: Are you calling from a hospital or a doctor’s office?',
      "AGENT: Are you calling from a doctor's",
      "AGENT: Is that a doctor's office, hospital, or clinic?",
      'AGENT: Which hospital are you calling from?',
    ];
    for (const ask of opens) expect(answered('Yes, Pomona Valley Hospital.', ask), ask).toBe(true);
    const closed = [
      'AGENT: What number are you calling from? I will pass it to the office.',
      'AGENT: Our Covina office opens at 8 in the morning.',
      'AGENT: I can take a message for the clinic.',
    ];
    for (const ask of closed) {
      expect(answersToTheFacilityQuestion([ask, 'CALLER: Kaiser hospital, the main one.']), ask).toEqual([]);
    }
  });

  it('outside the window the same loose answer is not read', () => {
    releaseCallerSpeech(CALL);
    noteCallerTranscript(CALL, [
      'AGENT: How can I help?',
      'CALLER: Uh, yeah, we are over at the Kaiser hospital in Fontana, the main one.',
    ]);
    expect(corroborate(CALL, '').providerStated).toBe(false);
  });

  it('the window closes at the next agent line', () => {
    expect(
      answersToTheFacilityQuestion([ASK, 'CALLER: Kaiser hospital, the main one.', 'AGENT: Thank you.', 'CALLER: Bye, see the hospital.']),
    ).toEqual(['kaiser hospital, the main one.']);
  });

  it('the gate: refused, then the answering turn, then allowed', () => {
    const reason = 'Clinician paging the on-call physician about a patient';
    releaseCallerSpeech(CALL);
    const before = ['AGENT: Thank you for calling.', 'CALLER: Paging on-call physician.'];
    noteCallerTranscript(CALL, before);
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') })).toMatchObject({
      allowed: false,
      code: 'provider_not_stated_by_caller',
    });
    noteCallerTranscript(CALL, [...before, ASK, 'CALLER: Uh, we are over at the Kaiser hospital in Fontana, the main one.']);
    expect(judgeEscalation({ callerType: 'healthcare_provider', reason, corroboration: corroborate(CALL, '') })).toEqual({
      allowed: true,
      basis: 'provider_or_facility',
    });
    releaseCallerSpeech(CALL);
    expect(corroborate(CALL, '').providerStated, 'release clears the answers too').toBe(false);
  });
});

describe('the symptom evidence lists (review r3 P3, #353)', () => {
  const heard = (spoken: string, claim: string) => {
    releaseCallerSpeech(CALL);
    recordCallerSpeech(CALL, spoken);
    return corroborate(CALL, claim);
  };
  const CASES: Array<[string, string]> = [
    ['Everything is hazy.', 'vision changes'],
    ["It's all foggy and fuzzy.", 'vision changes'],
    ['It looks milky.', 'vision changes'],
    ['The lines look wavy and distorted.', 'vision changes'],
    ['It went white.', 'vision changes'],
    ['I see halos around the lights.', 'vision changes'],
    ['My head is pounding.', 'severe pain'],
    ['I have a terrible headache.', 'severe pain'],
    ['My eye is on fire.', 'severe pain'],
  ];
  for (const [spoken, claim] of CASES) {
    it(`"${spoken}" corroborates the model's "${claim}"`, () => {
      const c = heard(spoken, claim);
      expect(c.unsupported).toEqual([]);
      const v = judgeEscalation({ callerType: 'patient_urgent_medical', reason: `Patient reports ${claim}`, corroboration: c });
      expect(v).not.toMatchObject({ code: 'symptoms_not_stated_by_caller' });
    });
  }

  it('d30ca58b is still refused: discharge and a callback do not corroborate pain and vision changes', () => {
    const c = heard('Reaction | And my right eye. With discharge. | Hello | Yes.', 'red eye with pain and vision changes');
    const v = judgeEscalation({ reason: 'red eye with pain and vision changes reported', corroboration: c });
    expect(v).toMatchObject({ allowed: false, code: 'symptoms_not_stated_by_caller' });
  });

  it('"flew in" and "scratch" are symptoms only about an eye', () => {
    for (const t of ['my son flew in from texas', 'i scratched my glasses', 'the scratch on my car']) {
      expect(CALLER_SYMPTOM.test(t), t).toBe(false);
    }
    for (const t of ['something flew in my eye', 'a bug flew into my eye', 'i scratched my eye', 'i think i scratched my cornea', 'my eye is scratchy']) {
      expect(CALLER_SYMPTOM.test(t), t).toBe(true);
    }
  });
});

describe('the runtime feeds the ledger the gate reads', () => {
  it('takes the CALLER lines of the whole record, lowercased, and replaces rather than appends', () => {
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: Opera']);
    noteCallerTranscript(CALL, ['AGENT: Thank you for calling.', 'CALLER: Operator.', 'AGENT: How can I help?']);
    expect(callerSaid(CALL)).toBe('operator.');
    const c = corroborate(CALL, '');
    expect(c.haveSpeech).toBe(true);
    expect(c.providerStated).toBe(false);
  });

  it('a record with no caller line leaves the ledger alone, and release clears it', () => {
    noteCallerTranscript(CALL, ['CALLER: This is Dr. Lee.']);
    noteCallerTranscript(CALL, ['AGENT: Hello?']);
    expect(corroborate(CALL, '').providerStated).toBe(true);
    releaseCallerSpeech(CALL);
    expect(corroborate(CALL, '').haveSpeech).toBe(false);
  });

  it('holds at most 500 calls, dropping the oldest, so a call nobody released cannot grow it for ever', () => {
    const sid = (i: number) => `CA${i.toString(16).padStart(32, '0')}`;
    for (let i = 1; i <= 501; i++) noteCallerTranscript(sid(i), ['CALLER: Operator.']);
    expect(callerSaid(sid(1))).toBe('');
    expect(callerSaid(sid(2))).toBe('operator.');
    expect(callerSaid(sid(501))).toBe('operator.');
    for (let i = 1; i <= 501; i++) releaseCallerSpeech(sid(i));
  });

  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('the bridge posts the record from the same seam as the date of birth and the patient status', () => {
    const src = read('runtime/mediaStreamBridge.ts');
    const seam = src.slice(src.indexOf('onCallerTranscript: (text, itemId) =>'), src.indexOf('onError: (err) =>'));
    expect(seam).toContain('noteSpokenDob(this.deps.context.callSid, this.transcriptLog.lines)');
    expect(seam).toContain('noteCallerTranscript(this.deps.context.callSid, this.transcriptLog.lines)');
  });

  it('the runtime releases it when the call ends', () => {
    const src = read('runtime/voiceRuntime.ts');
    const onOutcome = src.slice(src.indexOf('onOutcome: (outcome: CallOutcome) =>'), src.indexOf('transfer.abandonFor(entry.callSid)'));
    expect(onOutcome).toContain('releaseCallerSpeech(entry.callSid)');
  });

  it('the after-hours agent reads the ledger by the same key the runtime writes it under', () => {
    // On the runtime callId IS the CallSid (voiceRuntime's resolveLane), and
    // the agent corroborates on callId.
    expect(read('runtime/voiceRuntime.ts')).toMatch(/callSid: entry\.callSid,\s*\n\s*callId: entry\.callSid,/);
    expect(read('agents/noIvrAgent.ts')).toMatch(/const corroboration = corroborate\(\s*\n\s*callId,/);
  });
});
