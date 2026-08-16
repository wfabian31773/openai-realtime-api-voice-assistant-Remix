/**
 * The triage table — one question, then a decision.
 *
 * Operator, 2026-08-13: *"the agent should triage and should be able to
 * determine what's truly urgent. Right now it seems like we're just going off
 * of keywords."*
 *
 * The property that matters most here is a NEGATIVE one: no answer, in any
 * language, may take an urgent presentation off the urgent path. The question
 * chooses the category. It never clears the flag.
 */
import { describe, it, expect } from 'vitest';
import {
  AFTER_HOURS_TRIAGE,
  triageNeededFor,
  resolveTriage,
  renderTriagePrompt,
  affirms,
} from './afterHoursTriage';
import { classifyAfterHoursRequest } from './afterHoursTaxonomy';

const bleeding = AFTER_HOURS_TRIAGE.find((p) => p.key === 'bleeding')!;
const floaters = AFTER_HOURS_TRIAGE.find((p) => p.key === 'floaters')!;
const redness = AFTER_HOURS_TRIAGE.find((p) => p.key === 'redness')!;

describe('the gap that started this', () => {
  it('bleeding used to file as General/Other, not urgent', () => {
    // Verbatim behaviour before triage existed, and the reason this file is
    // here. The ticketing agent found the same hole in their table the same
    // day, from a test they ran red first.
    const before = classifyAfterHoursRequest('my eye is bleeding');
    expect(before.isCatchAll).toBe(true);
    expect(before.classification.urgent).toBeUndefined();
  });

  it('is now recognised as needing a question, in both languages', () => {
    for (const text of [
      'my eye is bleeding',
      'there is blood in my eye',
      'tengo sangre en el ojo',
      'está sangrando mi ojo',
      'bleeding from the eye since last night',
    ]) {
      expect(triageNeededFor(text)?.key, text).toBe('bleeding');
    }
  });
});

describe('the answer picks the category', () => {
  const CASES: Array<[string, number, string]> = [
    ['yes, I got hit with a branch', 162, 'injury'],
    ['no injury but my vision is blurry now', 161, 'vision'],
    ['it really hurts', 163, 'pain'],
    ['I had cataract surgery last week', 160, 'post-op'],
    ['me operaron hace una semana', 160, 'post-op, Spanish'],
    ['me pegué con la puerta', 162, 'injury, Spanish'],
    ['no puedo ver bien', 161, 'vision, Spanish'],
  ];

  for (const [answer, reason, label] of CASES) {
    it(`"${answer}" -> ${reason} (${label})`, () => {
      expect(resolveTriage(bleeding, answer).requestReasonId).toBe(reason);
    });
  }

  it('falls to 551 when the answer names nothing, and says so honestly', () => {
    const r = resolveTriage(bleeding, 'no, nothing like that');
    expect(r.requestReasonId).toBe(551);
    expect(r.urgent).toBe(true);
  });
});

describe('ONLY AN EXPLICIT DENIAL, ON ONLY ONE PRESENTATION, MAY CLEAR THE FLAG', () => {
  /**
   * The safety property, as amended by the operator on 2026-08-15:
   * *"redness should be answer driven, leave bleeding and injury alone."*
   *
   * An agent that can be talked out of an emergency is a worse product than
   * one that occasionally over-flags — after hours a false positive is a
   * ticket marked urgent that was not, and a false negative is a retinal
   * detachment that waited until morning. So the exception is deliberately
   * narrow in three separate ways, each pinned below.
   */
  const CLEAR_DENIALS = [
    'no', 'no, nothing', 'not really', "it doesn't hurt and I can see fine",
    'nothing at all', 'no, no pasa nada', 'no, estoy bien',
  ];
  /** Not answers at all. Silence and noise must never downgrade anything. */
  const NON_ANSWERS = ['', '   ', 'asdfgh'];
  /** A negator that is not a denial — the caller does not KNOW. */
  const HEDGES = ["I don't think so", 'no idea', 'not sure', 'maybe', 'no se'];

  const alwaysUrgent = AFTER_HOURS_TRIAGE.filter((p) => !p.answerDecidesUrgency);
  const answerDriven = AFTER_HOURS_TRIAGE.filter((p) => p.answerDecidesUrgency);

  it('leaves bleeding and injury alone — exactly as the operator ruled', () => {
    expect(alwaysUrgent.map((p) => p.key)).toContain('bleeding');
    expect(alwaysUrgent.map((p) => p.key)).toContain('floaters');
    expect(answerDriven.map((p) => p.key)).toEqual(['redness']);
  });

  for (const p of alwaysUrgent) {
    for (const answer of [...CLEAR_DENIALS, ...NON_ANSWERS, ...HEDGES]) {
      it(`${p.key} + ${JSON.stringify(answer)} is STILL urgent`, () => {
        const r = resolveTriage(p, answer);
        expect(r.urgent).toBe(true);
        expect(r.requestTypeId).toBe(34);
      });
    }
  }

  for (const p of answerDriven) {
    for (const answer of CLEAR_DENIALS) {
      it(`${p.key} + ${JSON.stringify(answer)} becomes a callback`, () => {
        // The 10:20 caller: a red eye, no pain, and a request for a call back.
        const r = resolveTriage(p, answer);
        expect(r.urgent).toBe(false);
        expect(r.requestTypeId).toBe(34);
      });
    }

    for (const answer of NON_ANSWERS) {
      it(`${p.key} + ${JSON.stringify(answer)} stays urgent — silence is not a no`, () => {
        expect(resolveTriage(p, answer).urgent).toBe(true);
      });
    }

    for (const answer of HEDGES) {
      it(`${p.key} + ${JSON.stringify(answer)} stays urgent — uncertainty is not a no`, () => {
        expect(resolveTriage(p, answer).urgent).toBe(true);
      });
    }

    it(`${p.key} still escalates when the caller affirms a discriminator`, () => {
      // The exception lowers the flag ONLY when every discriminator is denied.
      for (const [answer, reasonId] of [
        ['yes it hurts a lot', 163],
        ['my vision is blurry', 161],
        ['I had surgery last week', 160],
      ] as const) {
        const r = resolveTriage(p, answer);
        expect(r.urgent, `"${answer}" must stay urgent`).toBe(true);
        expect(r.requestReasonId).toBe(reasonId);
      }
    });
  }
});

describe('negation — the reason a keyword list cannot do this job', () => {
  /**
   * We ask "was there any injury, and has your vision changed?", so the
   * answers are full of the exact words we search for, in the negative. Both
   * of these failed on this file's first run: the cue was right and its
   * position was wrong, which is not visible by reading the cue list.
   */
  it('does not read a denial as a symptom', () => {
    expect(resolveTriage(bleeding, 'no injury but my vision is blurry now').requestReasonId).toBe(161);
    expect(resolveTriage(floaters, 'no flashes').requestReasonId).toBe(551);
    expect(resolveTriage(bleeding, "it doesn't hurt").requestReasonId).toBe(551);
    expect(resolveTriage(bleeding, 'there was no surgery').requestReasonId).toBe(551);
    expect(resolveTriage(bleeding, 'sin lesion').requestReasonId).toBe(551);
  });

  it('a clause break resets the negation', () => {
    // "no pain, but there is blood" affirms blood. The window is a clause,
    // not a sentence, precisely so this still works.
    expect(affirms('I have no pain but my vision is blurry', 'blurry')).toBe(true);
    expect(affirms('no injury, and there is bleeding', 'bleeding')).toBe(true);
  });

  it('still affirms the plain case', () => {
    expect(affirms('yes, I got hit with a branch', 'hit')).toBe(true);
    expect(affirms('my vision is blurry', 'blurry')).toBe(true);
    expect(affirms('me pegue con la puerta', 'me pegue')).toBe(true);
  });

  it('a negated presentation does not trigger a question', () => {
    expect(triageNeededFor('no bleeding at all, just a question about my drops')).toBeNull();
  });
});

describe('the two conditionals the practice list could not express', () => {
  /**
   * `URGENT_SYMPTOMS` carries 'new floaters (especially with flashes)' and
   * 'eye redness with severe pain'. Those are conditionals written as prose,
   * and a model matching phrases cannot act on a parenthesis.
   */
  it('floaters ask about flashes and a curtain', () => {
    expect(triageNeededFor('I keep seeing floaters')?.key).toBe('floaters');
    expect(resolveTriage(floaters, 'yes, flashes of light too').requestReasonId).toBe(165);
    expect(resolveTriage(floaters, 'there is a shadow across the top').requestReasonId).toBe(165);
    expect(resolveTriage(floaters, 'no flashes').requestReasonId).toBe(551);
  });

  it('redness asks about pain and vision', () => {
    expect(triageNeededFor('my eye is red')?.key).toBe('redness');
    expect(resolveTriage(redness, 'yes it is very painful').requestReasonId).toBe(163);
    expect(resolveTriage(redness, 'my vision went blurry').requestReasonId).toBe(161);
  });
});

describe('every destination is one of the practice\'s own reasons', () => {
  it('invents no reason id', () => {
    // Nothing clinical may be invented here. Type 34's real reasons only.
    const allowed = new Set([160, 161, 162, 163, 164, 165, 551]);
    for (const p of AFTER_HOURS_TRIAGE) {
      expect(allowed.has(p.fallbackReasonId), `${p.key} fallback`).toBe(true);
      for (const b of p.branches) {
        expect(allowed.has(b.requestReasonId), `${p.key} -> ${b.requestReasonId}`).toBe(true);
      }
    }
  });

  it('asks a question of FACT, never for a diagnosis', () => {
    for (const p of AFTER_HOURS_TRIAGE) {
      expect(p.ask).toMatch(/\?$/);
      expect(p.askEs).toMatch(/\?$/);
      // One question mark: never stack two asks into one breath.
      expect(p.ask.split('?').length - 1, `${p.key} asks more than once`).toBe(1);
      expect(p.why.length).toBeGreaterThan(60);
    }
  });
});

describe('the prompt block', () => {
  const block = renderTriagePrompt();

  it('names which presentations stay urgent however they are answered', () => {
    expect(block).toMatch(/STAY URGENT HOWEVER THEY ARE ANSWERED/i);
    expect(block).toMatch(/bleeding/);
    expect(block).toMatch(/floaters/);
  });

  it('tells the agent that redness is the one the answer decides', () => {
    expect(block).toMatch(/THE ANSWER DECIDES/i);
    expect(block).toMatch(/If they say NO, it is NOT urgent/i);
    expect(block).toMatch(/create_ticket/);
  });

  it('forbids joining two questions with "and" — the 08-15 defect', () => {
    expect(block).toMatch(/Never join two questions with "and"/i);
    expect(block).toMatch(/has answered neither/i);
  });

  it('forbids diagnosing and reassuring', () => {
    expect(block).toMatch(/NOT DIAGNOSING/i);
    expect(block).toMatch(/never reassure/i);
  });

  it('lets a real emergency skip the question', () => {
    expect(block).toMatch(/hand off first/i);
  });

  it('carries every presentation and its Spanish', () => {
    for (const p of AFTER_HOURS_TRIAGE) {
      expect(block).toContain(p.ask);
      expect(block).toContain(p.askEs);
    }
  });
});
