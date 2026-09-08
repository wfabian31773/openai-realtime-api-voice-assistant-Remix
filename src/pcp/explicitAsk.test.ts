/**
 * THE PHRASE THAT MOTIVATED THE FIX DID NOT MATCH THE FIX.
 *
 * Codex P1 on PR #273. CAa2a3a1c1, 2026-09-08 12:28 — the operator's opening
 * words on the call this whole thread is about:
 *
 *     "Hi, can I speak to the, can I speak to the team please?"
 *
 * `askedForAPerson` was two regexes. The `speak|talk` one listed person, human,
 * someone, somebody, rep, representative, agent, front desk, receptionist. The
 * `connect|transfer|get me` one listed those PLUS office and team. So "speak to
 * the team" matched neither, and neither did "speak with the office": two lines
 * written to do the same job had drifted apart on the nouns.
 *
 * Reproduced before fixing, over the real narratives:
 *
 *     MISS   "Caller asked: can I speak to the team please?"
 *     MATCH  "Caller asked: Can I speak to a representative please?"
 *     MISS   "Caller asked to speak with the office about a referral."
 *
 * WHAT A MISS COSTS: the director's `eligibleByAsk` never fires, so the
 * transfer is not granted; `handoff_to_pcp` demands a recorded `callPurpose`
 * first; and the ticket files without `dispositionGrantedByExplicitAsk`, the
 * field whose absence killed 19 of 19 transfers up to 2026-09-08. The commit
 * that shipped "transfer on the first ask, not the third" did not fire for the
 * utterance that motivated it.
 *
 * HOW I MISSED IT. An hour before Codex found this, a test of mine used the
 * narrative "Caller asked for a representative", it failed to match, and I
 * fixed THE TEST — without asking whether the phrase from the actual call
 * matched. Two near-identical lists are an invitation to check one and assume
 * the other, which is exactly what I did.
 *
 * So the nouns now live in one constant, and these cases are pinned against
 * the wording from the calls rather than wording I invented.
 */
import { describe, it, expect } from 'vitest';
import { asksForAPerson } from './explicitAsk';

describe('the wordings from real calls', () => {
  /** Narratives in the shape the model actually writes them. */
  const ASKS = [
    // CAa2a3a1c1 12:28 — his opening line, and the one that used to miss.
    'Caller asked: can I speak to the team please?',
    // …and his third attempt, which is all that used to work.
    'Caller asked: Can I speak to a representative please?',
    'Caller asked to speak with the office about a referral status.',
    'Caller wants to talk to the team about a mutual patient.',
    'Caller asked to be connected to the office.',
    'Caller asked to speak to someone in the department.',
    'Caller asked us to put them through to a representative.',
    'Caller says they want a real person.',
    'Get me the front desk, please.',
    'Caller asked to talk with a human.',
  ];

  for (const narrative of ASKS) {
    it(`hears the ask in: ${narrative}`, () => {
      expect(asksForAPerson(narrative), 'a missed ask is a transfer that never happens').toBe(true);
    });
  }
});

describe('and it stays narrow — a mention is not an ask', () => {
  /**
   * Review, 2026-08-09: "a caller from the front desk asking about a referral
   * is not a request to be transferred, and dialing the queue on it would be
   * worse than the bug being fixed." Widening the verb side, or dropping it,
   * would dial the PCP queue on ordinary intake sentences.
   */
  const NOT_ASKS = [
    'Caller from the front desk asking about a referral for a mutual patient.',
    'The referral coordinator at the medical group needs an authorisation number.',
    'Caller is a representative of Optum calling about a claim.',
    'The office manager left a message about a fax that did not arrive.',
    'Patient asked whether the team had received her records.',
    'Caller asked what time the office closes.',
  ];

  for (const narrative of NOT_ASKS) {
    it(`does not hear an ask in: ${narrative}`, () => {
      expect(asksForAPerson(narrative), 'this would dial a queue nobody asked for').toBe(false);
    });
  }
});

describe('the narrative is a summary, not speech', () => {
  /**
   * The second bug in the same line, found by this file rather than in review.
   * `narrative` is what the MODEL writes ABOUT the caller, so it arrives in the
   * third person and the past tense. The verb list was first-person present —
   * "put me through", "get me" — which are the words a CALLER says and the
   * model never does. `\bconnect\b` does not match "connected" either.
   */
  const THIRD_PERSON = [
    'Caller asked us to put them through to a representative.',
    'Caller asked to be connected to the office.',
    'Asked if we could get them a rep.',
    'Caller asked to be connected with someone on the team.',
  ];

  for (const narrative of THIRD_PERSON) {
    it(`hears the ask in: ${narrative}`, () => {
      expect(asksForAPerson(narrative)).toBe(true);
    });
  }

  it('but "transferred" is deliberately NOT inflected', () => {
    /**
     * A DECISION, pinned so it is not silently reversed as an oversight.
     *
     * "Transferred to" routinely narrates something that already happened to a
     * record or a patient rather than something the caller is asking for. This
     * field sits upstream of a real dial into a queue staffed by three or four
     * people, so a false positive costs a spurious ring; the phrasing it would
     * buy is rare. Bare `transfer` was already in the list and stays.
     *
     * If a real call is ever lost to this, the fix is to widen it WITH the
     * measurement — not because the asymmetry looks untidy.
     */
    expect(asksForAPerson('Her records were transferred to the office last week.')).toBe(false);
    expect(asksForAPerson('The patient was transferred to another practice.')).toBe(false);
  });
});

describe('the two branches cannot drift apart again', () => {
  it('every human noun works with a speak verb AND a connect verb', () => {
    /**
     * THE ACTUAL DEFECT, pinned as a property rather than as ten more cases.
     * `team` and `office` worked with "connect" and not with "speak". Any
     * future noun added to one branch and not the other fails here.
     */
    const NOUNS = [
      'person', 'human', 'someone', 'somebody', 'rep', 'representative',
      'agent', 'front desk', 'receptionist', 'office', 'team',
    ];
    const missing: string[] = [];
    for (const noun of NOUNS) {
      if (!asksForAPerson(`Caller asked to speak to the ${noun}.`)) missing.push(`speak/${noun}`);
      if (!asksForAPerson(`Caller asked to connect them to the ${noun}.`)) missing.push(`connect/${noun}`);
    }
    expect(missing, 'the noun lists have drifted between the two verb branches again').toEqual([]);
  });
});
