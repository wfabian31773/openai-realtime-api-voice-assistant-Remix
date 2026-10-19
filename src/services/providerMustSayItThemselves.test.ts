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
