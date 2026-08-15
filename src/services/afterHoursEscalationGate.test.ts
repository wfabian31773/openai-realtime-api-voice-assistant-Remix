/**
 * THE THREE CASES, AND THE EIGHTEEN THAT WERE NOT.
 *
 * Operator, 2026-08-15: "The only times it's supposed to fire is if it's
 * calling from a provider's office, if it's calling from a hospital, or if
 * it's a truly urgent situation with a patient. Not 'I need an urgent
 * appointment tomorrow because I need an eye checkup.' No. You know what
 * urgent is."
 *
 * Every REFUSED case below is a verbatim reason string from a real escalation
 * on the after-hours line in the 14 days to 08-15. Eleven of them connected a
 * live human. Every ALLOWED case is a real one that should have.
 */
import { describe, it, expect } from 'vitest';
import { judgeEscalation } from './afterHoursEscalationGate';

const verdict = (reason: string, over: Record<string, unknown> = {}) =>
  judgeEscalation({ reason, ...over });

describe('case 1 and 2 — a provider’s office or a hospital', () => {
  it('lets an emergency room through', () => {
    // 08-15 05:44, 63s, 2 turns. Exactly what this line is for.
    const v = verdict('call from emergency room');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('provider_or_facility');
  });

  it('lets a nurse through', () => {
    const v = verdict('caller identified as a healthcare provider (nurse calling for Dr. Casey)');
    expect(v.allowed).toBe(true);
  });

  it('trusts the caller_type even when the reason text is thin', () => {
    const v = verdict('calling about a mutual patient', { callerType: 'healthcare_provider' });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('provider_or_facility');
  });

  it('lets a provider through even when their sentence also mentions an appointment', () => {
    /**
     * PRECEDENCE, and the reason identity is checked FIRST. A hospital
     * discharge nurse ringing about a post-op patient will often say the word
     * "appointment" in the same breath. She is still a hospital.
     */
    const v = verdict('hospital calling to arrange an urgent appointment for a discharged patient');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('provider_or_facility');
  });
});

describe('case 3 — a truly urgent patient', () => {
  const acute = [
    'eye bleeding emergency',
    'eye injury and pain after hitting eye',
    'blurry vision, floaters, orange tint in left eye, possible urgent eye condition',
    'recent eye surgery with concerning symptoms',
    'post-surgery eye pain reported for patient, possible urgent medical concern',
    'severe eye pain and possible emergency',
    'sudden onset of large floater, possible urgent eye condition',
    'chemical splash in the eye',
    'Paciente con problemas en los ojos y visión doble, necesita atención urgente',
  ];
  for (const reason of acute) {
    it(`allows: ${reason.slice(0, 52)}`, () => {
      expect(judgeEscalation({ reason }).allowed, reason).toBe(true);
    });
  }

  it('allows a plain "I cannot see" with nothing administrative attached', () => {
    const v = verdict('patient reports they suddenly cannot see out of the right eye');
    expect(v.allowed).toBe(true);
  });

  describe('acute phrases with a word in the middle — found by the 14-day backtest', () => {
    /**
     * A plain substring list missed the way people actually speak. All three
     * of these still PASSED the gate, but only via the default-open fallback
     * — so the moment such a sentence also said "appointment" it would have
     * been refused. An acute case has to be recognised as acute, not merely
     * survive by accident.
     */
    const interposed: Array<[string, string]> = [
      ['severe EYE pain', 'severe eye pain and possible emergency'],
      ['recent EYE surgery', 'recent eye surgery with concerning symptoms'],
      ['large floaTER, singular', 'sudden onset of large floater, possible urgent eye condition'],
    ];
    for (const [label, reason] of interposed) {
      it(`reads "${label}" as clinical, not as unclassified`, () => {
        const v = judgeEscalation({ reason });
        expect(v.allowed).toBe(true);
        expect(v.allowed && v.basis, reason).toBe('acute_clinical');
      });
    }

    it('holds even when the caller also mentions an appointment', () => {
      // The exact failure mode the patterns exist to prevent.
      const v = verdict('severe eye pain since their appointment yesterday');
      expect(v.allowed).toBe(true);
      expect(v.allowed && v.basis).toBe('acute_clinical');
    });
  });
});

describe('the refusals — "I couldn’t hear the patient" and all the weird stuff', () => {
  const commsFailures = [
    "unable to understand caller's language or request",
    'Repeated difficulty capturing medication details for prescription refill request',
    'Unable to confirm date of birth after multiple attempts — caller needs direct assistance.',
    'caller is not communicating clearly and language is unclear',
    'caller is speaking incoherently, with unrelated phrases',
    'unable to gather complete information from caller after multiple attempts',
    'caller declined to provide date of birth, unable to create ticket for appointment confirmation',
    'could not hear the patient at all',
  ];
  for (const reason of commsFailures) {
    it(`refuses: ${reason.slice(0, 52)}`, () => {
      const v = judgeEscalation({ reason });
      expect(v.allowed, reason).toBe(false);
      expect(!v.allowed && v.directive).toMatch(/create_ticket/);
    });
  }

  it('refuses the removed caller type even if something still sends it', () => {
    const v = judgeEscalation({ reason: 'caller hard to follow', callerType: 'patient_unresponsive' });
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe('communication_failure');
  });
});

describe('the refusals — routine business dressed as urgent', () => {
  it('refuses the fax-and-authorization call that reached a human on 08-14', () => {
    const v = verdict(
      'Patient mentioned needing to provide an authorization and fax number for an upcoming appointment. Immediate assistance required to verify and assist.',
    );
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe('administrative_request');
  });

  it('refuses "cannot see" when what they cannot see WITH is their new glasses', () => {
    /**
     * 08-11 07:47. The agent read "cannot see" as vision loss and dialled the
     * on-call provider at a quarter to eight in the morning. The rest of the
     * sentence says plainly what the call is: an order status question.
     *
     * This is the one genuinely hard case in the file, and the rule is narrow
     * on purpose — "cannot see" stays acute unless an administrative subject
     * is named alongside it.
     */
    const v = verdict('patient reports they cannot see and urgently needs to know when their glasses will be ready');
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.code).toBe('administrative_request');
  });

  it('refuses the operator’s own example', () => {
    const v = verdict('patient urgently needs an appointment tomorrow for an eye checkup');
    expect(v.allowed).toBe(false);
  });

  it('refuses a refill however urgent it sounds', () => {
    expect(verdict('urgent prescription refill needed tonight').allowed).toBe(false);
  });

  it('refuses billing and records', () => {
    expect(verdict('caller has an urgent billing and insurance question').allowed).toBe(false);
    expect(verdict('urgent records request, needs paperwork faxed').allowed).toBe(false);
  });
});

describe('allow by default — the property that must never regress', () => {
  /**
   * A needless transfer costs somebody a phone call. A wrongly refused one
   * could cost somebody their sight. Anything this module cannot classify
   * goes through, and a refusal must be POSITIVELY matched.
   */
  it('allows something it has never seen before', () => {
    const v = verdict('caller describes a situation the taxonomy does not cover');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('unclassified_default_open');
  });

  it('allows an empty reason rather than blocking a transfer on missing text', () => {
    expect(judgeEscalation({}).allowed).toBe(true);
    expect(judgeEscalation({ reason: '' }).allowed).toBe(true);
  });

  it('lets an acute term beat an administrative word in the same sentence', () => {
    // "bleeding" is unambiguous. It wins over "appointment" every time.
    const v = verdict('eye is bleeding, caller also asked about their appointment next week');
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('acute_clinical');
  });
});
