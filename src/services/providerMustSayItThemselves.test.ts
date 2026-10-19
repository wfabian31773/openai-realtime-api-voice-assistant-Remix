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
  ];
  for (const t of PROVIDERS) it(t, () => expect(callerSaysTheyAreAProvider(t)).toBe(true));
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
  ];
  for (const t of NOT_ANSWERS) it(`does not count: ${t}`, () => expect(answered(t)).toBe(false));

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
