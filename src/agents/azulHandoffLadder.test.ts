/**
 * GATHER THE INTENT, OFFER ONCE, THEN GET OUT OF THE WAY.
 *
 * Operator's ruling, 2026-08-17: *"Before we can pass any call onto the front
 * desk, we gather the information patient, verify the intent, what's the call
 * about... At that point, if it's a scheduling situation, that's where the
 * agent needs to say, hey, I can get this done for you and probably a lot
 * quicker than the front desk... But if it's something else regarding a
 * situation that we're not prepared to do outside of scheduling, then you go
 * ahead and pass it through. But on first iteration, we should at least push
 * back to try to minimize those calls that are moving forward that shouldn't
 * be."*
 *
 * The measured problem: `patient_requested_human` is 237 of 455 handoffs on
 * this line, at a median 24 seconds in and the FIRST tool call on 33 of them —
 * corroborated against the transcripts at 91%, so the asks are real. Meanwhile
 * only 12% of calls reach a booking attempt at all, and booking confirms 71% of
 * the time once reached.
 *
 * The two failure modes this has to sit between:
 *   - transferring on the bare first ask, which sends people to the front desk
 *     for things we could have finished;
 *   - stonewalling, which traps the callers who genuinely will not deal with a
 *     machine. Those exist and their preference is theirs to hold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ladderVerdict, LADDER_LINES, NEVER_DEFLECTED } from './azulHandoffLadder';

const ask = (over: Partial<Parameters<typeof ladderVerdict>[0]> = {}) =>
  ladderVerdict({
    handoffReason: 'patient_requested_human',
    reasonForCall: 'Wants to move their Tuesday appointment',
    schedulableHere: 'yes',
    offerAlreadyMade: false,
    ...over,
  });

describe('the intent gate — nothing reaches the front desk unexplained', () => {
  it('refuses a handoff with no stated reason', () => {
    const v = ask({ reasonForCall: undefined });
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.code).toBe('intent_required');
    expect(v.say).toBe(LADDER_LINES.askIntent);
  });

  it('treats blank and near-blank reasons as unstated', () => {
    for (const r of ['', '   ', 'x']) {
      expect(ask({ reasonForCall: r }).allow, `"${r}" should not count as a reason`).toBe(false);
    }
  });

  it('applies to every reason, not only a request for a person', () => {
    // A packet with no reason briefs the staffer on nothing, whatever sent it.
    const v = ask({ handoffReason: 'provider_specific_request', reasonForCall: undefined });
    expect(v.allow).toBe(false);
  });

  it('the question promises the transfer rather than gating it', () => {
    /**
     * Wording matters here more than usual. "Before I can transfer you..."
     * turns the question into a hoop, and the people least willing to jump
     * through one are exactly the people who just asked for a human.
     */
    expect(LADDER_LINES.askIntent).toMatch(/of course/i);
    expect(LADDER_LINES.askIntent).not.toMatch(/before I can|I need to|first I|policy|unable/i);
    expect(LADDER_LINES.askIntent).toMatch(/\?$/);
  });

  it('never tells the caller a transfer is unavailable', () => {
    const v = ask({ reasonForCall: undefined });
    if (v.allow) throw new Error('expected a refusal');
    expect(v.guidance).toMatch(/Never tell the caller you cannot transfer them/i);
  });
});

describe('the offer — once, and only for what this line can finish', () => {
  it('offers when the request is schedulable', () => {
    const v = ask({ schedulableHere: 'yes' });
    expect(v.allow).toBe(false);
    if (v.allow) return;
    expect(v.code).toBe('offer_first');
    expect(v.say).toBe(LADDER_LINES.offer);
  });

  it('passes straight through when it is NOT schedulable', () => {
    // Billing, records, prescriptions, clinical questions. Holding those up to
    // explain what we can schedule is pure friction.
    expect(ask({ schedulableHere: 'no' }).allow).toBe(true);
  });

  it('passes through once the offer has been made', () => {
    expect(ask({ offerAlreadyMade: true }).allow).toBe(true);
  });

  it('NEVER pushes back twice, whatever else is true', () => {
    // The single most important property. A caller asking again has answered.
    for (const schedulable of ['yes', 'no', 'not_established'] as const) {
      expect(
        ask({ schedulableHere: schedulable, offerAlreadyMade: true }).allow,
        `second ask refused with schedulableHere=${schedulable}`,
      ).toBe(true);
    }
  });

  it('does not offer when the model could not classify the request', () => {
    // 'not_established' with a reason present means we know what they said but
    // not that we can do it. Erring towards the transfer is the safe direction.
    expect(ask({ schedulableHere: 'not_established' }).allow).toBe(true);
    expect(ask({ schedulableHere: undefined }).allow).toBe(true);
  });

  it('the offer gives a reason and asks permission', () => {
    expect(LADDER_LINES.offer).toMatch(/quicker|faster/i);
    expect(LADDER_LINES.offer).toMatch(/\?$/);
    // It must not read as a refusal or a negotiation.
    expect(LADDER_LINES.offer).not.toMatch(/cannot|can't|unable|not able|instead of/i);
  });

  it('the guidance tells the agent to honour a no', () => {
    const v = ask();
    if (v.allow) throw new Error('expected an offer');
    expect(v.guidance).toMatch(/Ask ONCE/);
    expect(v.guidance).toMatch(/Never push back a second time/i);
    expect(v.guidance).toMatch(/they will go through/i);
  });
});

describe('urgency and breakage are never negotiated with', () => {
  it('every exempt reason passes on the first ask', () => {
    for (const reason of NEVER_DEFLECTED) {
      expect(
        ladderVerdict({ handoffReason: reason, offerAlreadyMade: false }).allow,
        `${reason} must never be deflected`,
      ).toBe(true);
    }
  });

  it('an urgent symptom passes even with nothing else known', () => {
    // Not even the intent gate applies — someone describing an emergency is not
    // being asked to summarise it first.
    expect(
      ladderVerdict({ handoffReason: 'urgent_symptom', reasonForCall: undefined, offerAlreadyMade: false }).allow,
    ).toBe(true);
  });

  it('a frustrated caller is not offered anything', () => {
    expect(
      ladderVerdict({
        handoffReason: 'patient_frustrated',
        reasonForCall: 'Angry about a billing error',
        schedulableHere: 'yes',
        offerAlreadyMade: false,
      }).allow,
    ).toBe(true);
  });
});

describe('the whole ladder, walked', () => {
  it('bare ask → asks intent → offers → goes through', () => {
    // 1. "Can I speak to a representative." Nothing else known.
    const first = ladderVerdict({
      handoffReason: 'patient_requested_human',
      offerAlreadyMade: false,
    });
    expect(first.allow).toBe(false);
    if (!first.allow) expect(first.code).toBe('intent_required');

    // 2. "It's about moving my appointment." Now we know, and we can do it.
    const second = ladderVerdict({
      handoffReason: 'patient_requested_human',
      reasonForCall: 'Wants to move their Tuesday appointment',
      schedulableHere: 'yes',
      offerAlreadyMade: false,
    });
    expect(second.allow).toBe(false);
    if (!second.allow) expect(second.code).toBe('offer_first');

    // 3. "No, I'd rather talk to someone." Through, no argument.
    const third = ladderVerdict({
      handoffReason: 'patient_requested_human',
      reasonForCall: 'Wants to move their Tuesday appointment',
      schedulableHere: 'yes',
      offerAlreadyMade: true,
    });
    expect(third.allow).toBe(true);
  });

  it('a non-schedulable request takes only ONE step', () => {
    // "I'm calling about a bill." Intent gathered, then straight through —
    // exactly two tool calls, no offer.
    const first = ladderVerdict({ handoffReason: 'patient_requested_human', offerAlreadyMade: false });
    expect(first.allow).toBe(false);

    const second = ladderVerdict({
      handoffReason: 'patient_requested_human',
      reasonForCall: 'Question about a bill they received',
      schedulableHere: 'no',
      offerAlreadyMade: false,
    });
    expect(second.allow).toBe(true);
  });
});

describe('the classification is the model\'s job, not a regex\'s', () => {
  it('nothing in the ladder inspects the words of the request', () => {
    /**
     * Standing instruction, settled in July: "Why are you trying to determine
     * what a first name is? You'll never ever get it to work like that."
     * Extraction and classification belong to the model. The server owns the
     * ladder — how many pushbacks, and what is said — never the judgement.
     *
     * So `reasonForCall` is only ever checked for PRESENCE, and the schedulable
     * decision arrives as a closed enum the model filled in.
     */
    const src = readFileSync(new URL('./azulHandoffLadder.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'no keyword matching on the caller\'s words').not.toMatch(/reasonForCall\s*\.\s*(match|includes|test|search)/);
    expect(code, 'no regex over the request text').not.toMatch(/\/.*(appointment|billing|refill|records).*\/[a-z]*\.test/i);
    // Presence only.
    expect(code).toMatch(/reasonForCall && reasonForCall\.trim\(\)\.length >= 3/);
  });
});
