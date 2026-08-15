/**
 * THE AGENT INVENTED THE SYMPTOMS THAT PAGED THE ON-CALL PROVIDER.
 *
 * Operator, 2026-08-15, forwarding a transfer SMS reading "red eye with pain
 * and vision changes reported": *"This is not a reason for the agent to pass
 * the call through as urgent."*
 *
 * He is right, and the cause is worse than a permissive rule. Call d30ca58b,
 * 10:20:35 Pacific, verbatim from the transcript:
 *
 *     CALLER: Yes, I would like somebody to give me a call.
 *     ...
 *     CALLER: Reaction
 *     CALLER: And my right eye. With discharge.
 *     AGENT:  ...Is there any pain with it, and has your vision changed at all?
 *     CALLER: Hello
 *     AGENT:  ...Is there any pain with the redness, and has your vision
 *             changed at all?
 *     CALLER: Yes.
 *
 * One "Yes" to a two-part question became two reported symptoms. The caller
 * said DISCHARGE and asked for a callback — the thing this line exists to take.
 *
 * And the compound question was MINE: `afterHoursTriage` shipped
 * "Is there any pain with it, and has your vision changed at all?" as the
 * redness entry's single "one question", inside the very taxonomy whose prompt
 * says "ask ONE question, do not stack them".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCallerSpeech,
  releaseCallerSpeech,
  corroborate,
} from './symptomCorroboration';
import { judgeEscalation } from './afterHoursEscalationGate';

const CALL = 'CAd30ca58b';

/** The caller's actual lines from d30ca58b, in order. */
const REAL_CALL_LINES = [
  'Mm-hm',
  'Yes, I would like somebody to give me a call. My phone number is six two six',
  'Nine one seven',
  'Yes.',
  'Twelve twelve nineteen thirty-five.',
  'Cruz.',
  'Reaction',
  'And my right eye. With discharge.',
  'Hello',
  'Yes.',
];

beforeEach(() => releaseCallerSpeech(CALL));

describe('the call that started this', () => {
  it('finds no support for the pain or vision the agent reported', () => {
    for (const line of REAL_CALL_LINES) recordCallerSpeech(CALL, line);

    const result = corroborate(CALL, 'red eye with pain and vision changes reported');
    expect(result.haveSpeech).toBe(true);
    expect(result.unsupported.sort()).toEqual(['pain', 'vision change']);
    expect(result.supported).toEqual([]);
  });

  it('refuses the escalation that woke the on-call provider', () => {
    for (const line of REAL_CALL_LINES) recordCallerSpeech(CALL, line);

    const verdict = judgeEscalation({
      callerType: 'patient_urgent_medical',
      reason: 'red eye with pain and vision changes reported',
      symptomsSummary: 'red eye with pain and vision changes',
      corroboration: corroborate(CALL, 'red eye with pain and vision changes reported'),
    });

    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.code).toBe('symptoms_not_stated_by_caller');
    // The directive must teach the fix, not just refuse.
    expect(!verdict.allowed && verdict.directive).toMatch(/one question at a time/i);
    expect(!verdict.allowed && verdict.directive).toMatch(/create_ticket/);
  });
});

describe('a caller who really did say it goes straight through', () => {
  it('lets pain through when the caller mentioned pain', () => {
    recordCallerSpeech(CALL, 'my eye is red and it hurts really badly');
    const c = corroborate(CALL, 'red eye with severe pain');
    expect(c.supported).toContain('pain');
    expect(judgeEscalation({ reason: 'red eye with severe pain', corroboration: c }).allowed).toBe(true);
  });

  it('accepts the words people actually use, not just the clinical ones', () => {
    // The bar is "did they raise this", not "did they use this word".
    for (const [said, label] of [
      ['it stings so much', 'pain'],
      ['there is a burning feeling', 'pain'],
      ['everything looks cloudy', 'vision change'],
      ['me duele mucho el ojo', 'pain'],
      ['veo borroso', 'vision change'],
    ] as const) {
      releaseCallerSpeech(CALL);
      recordCallerSpeech(CALL, said);
      const claim = label === 'pain' ? 'severe pain in the eye' : 'vision changes reported';
      expect(corroborate(CALL, claim).supported, `"${said}" should corroborate ${label}`).toContain(label);
    }
  });

  it('allows when ONE of two claims is supported', () => {
    /**
     * Deliberate: the refusal needs EVERY acute claim unsupported and none
     * supported. A caller who said their eye hurts but never mentioned vision
     * is describing something real — quibbling with half the write-up must not
     * block the transfer.
     */
    recordCallerSpeech(CALL, 'my eye really hurts');
    const c = corroborate(CALL, 'red eye with pain and vision changes');
    expect(c.supported).toContain('pain');
    expect(c.unsupported).toContain('vision change');
    expect(judgeEscalation({ reason: 'red eye with pain and vision changes', corroboration: c }).allowed).toBe(true);
  });
});

describe('it fails open, every way it can', () => {
  it('allows when we have no record of the caller speaking', () => {
    // A transcription gap must never read as fabrication.
    const c = corroborate('CAunknown', 'severe pain and vision loss');
    expect(c.haveSpeech).toBe(false);
    expect(judgeEscalation({ reason: 'severe pain and vision loss', corroboration: c }).allowed).toBe(true);
  });

  it('allows when the gate is called with no corroboration at all', () => {
    expect(judgeEscalation({ reason: 'severe eye pain' }).allowed).toBe(true);
  });

  it('never blocks a provider or a hospital, whatever the symptom text says', () => {
    /**
     * Identity is checked BEFORE corroboration. An ER nurse describing a
     * patient's pain is reporting someone else's symptoms — she is not the one
     * on the line with the eye, and this check must never touch her.
     */
    recordCallerSpeech(CALL, 'this is the emergency room at Huntington calling');
    const c = corroborate(CALL, 'patient with severe pain and vision loss');
    expect(c.unsupported.length).toBeGreaterThan(0);
    const v = judgeEscalation({
      callerType: 'healthcare_provider',
      reason: 'patient with severe pain and vision loss',
      corroboration: c,
    });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.basis).toBe('provider_or_facility');
  });

  it('forgets a call when it ends', () => {
    recordCallerSpeech(CALL, 'my eye hurts');
    expect(corroborate(CALL, 'pain').haveSpeech).toBe(true);
    releaseCallerSpeech(CALL);
    expect(corroborate(CALL, 'pain').haveSpeech).toBe(false);
  });
});

describe('the taxonomy no longer ships a compound question', () => {
  it('asks about pain without also asking about vision in the same breath', async () => {
    const { AFTER_HOURS_TRIAGE } = await import('../tools/afterHoursTriage');
    for (const entry of AFTER_HOURS_TRIAGE as Array<{ key: string; ask: string; askEs: string }>) {
      for (const [lang, q] of [['en', entry.ask], ['es', entry.askEs]] as const) {
        /**
         * "flashes of light, or a shadow or curtain" is ONE question — both
         * halves are the same discriminator and a yes to either means the same
         * thing. "pain, AND has your vision changed" is two, and a yes means
         * nothing.
         */
        expect(
          /\b(and|y)\s+(has|have|is|are|ha|han)\b/i.test(q),
          `${entry.key} (${lang}) still stacks two questions: "${q}"`,
        ).toBe(false);
      }
    }
  });
});
