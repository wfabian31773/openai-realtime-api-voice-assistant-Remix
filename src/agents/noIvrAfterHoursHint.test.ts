/**
 * The after-hours classification travels with the request, and changes nothing.
 *
 * WHY A HINT AND NOT A FIX.
 *
 * 413 of no-ivr's 687 department-8 tickets carry reason 159, "Transferred to
 * On-Call Provider", and almost none were transferred — they are office-hours
 * questions, broken glasses, a pharmacy asking for a phone number.
 *
 * WHY, corrected 2026-08-13: I said "type 34's first reason is 159" and the
 * ticketing agent confirmed it. Neither of us read the code and there is no
 * such fallback. The cause is a TWO-CHARACTER keyword — `er`, matched with
 * String.includes at the highest priority in their table, firing inside
 * call-ER, h-ER, numb-ER and Qui-ER-o. Two agents agreeing is not
 * verification.
 *
 * But no-ivr files through `submitSimplifiedTicket`, which sends NO department,
 * NO request type and NO reason: the mapping is the ticketing app's. So this
 * repo cannot correct the label by choosing a better one — there is no field to
 * choose it in. Switching to create-ticket would mean this file picking the
 * DEPARTMENT for every overnight call, which is the whole answering-service
 * classification problem on the line that carries the night.
 *
 * ATTRIBUTION, corrected 2026-08-13. I first wrote that reason 159 came from
 * our own `detectRequestReason()`. It does not — that function is imported by
 * `answeringServiceAgent` and nothing else, and the split proves it:
 *
 *   dept 8, no-ivr             687 tickets, 413 on 159
 *   dept 8, answering-service  170 tickets,   9 on 159
 *
 * Our fallback does own department 3 (6,119 of 6,905). It does not own this.
 *
 * So these tests pin two things: the hint is present and correct, and NOTHING
 * ELSE MOVED. The second half is the point — this is the overnight path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyAfterHoursRequest } from '../tools/afterHoursTaxonomy';

const AGENT = readFileSync(join(__dirname, './noIvrAgent.ts'), 'utf8');

/** The submitSimplifiedTicket call in the create_ticket path. */
function submitCall(): string {
  const start = AGENT.indexOf('const result = await SyncAgentService.submitSimplifiedTicket({');
  expect(start, 'the no-ivr submit call has moved').toBeGreaterThan(-1);
  const end = AGENT.indexOf('});', start);
  return AGENT.slice(start, end);
}

describe('the hint is sent', () => {
  it('classifies with the after-hours taxonomy before filing', () => {
    expect(AGENT).toMatch(/classifyAfterHoursRequest/);
  });

  it('passes the four suggested fields', () => {
    const call = submitCall();
    for (const f of ['suggestedRequestTypeId', 'suggestedRequestReasonId', 'suggestedRequestReason', 'suggestedUrgent']) {
      expect(call, `${f} is not sent`).toMatch(new RegExp(f));
    }
  });

  it('sends nothing when the taxonomy could not classify', () => {
    // A hint of "Other - See Description" tells the ticketing app nothing it
    // does not already know, and would be indistinguishable from a real
    // classification on their side.
    const call = submitCall();
    expect(call).toMatch(/isCatchAll[\s\S]*\?\s*\{\}/);
  });
});

describe('nothing else about the overnight path moved', () => {
  it('still uses submitSimplifiedTicket, not create-ticket', () => {
    // Switching endpoints here would put department classification for every
    // night call in this file. That is the change this hint exists to avoid.
    const call = submitCall();
    expect(AGENT).toMatch(/SyncAgentService\.submitSimplifiedTicket/);
    expect(call).not.toMatch(/departmentId/);
    expect(call).not.toMatch(/requestTypeId:/);
    expect(call).not.toMatch(/requestReasonId:/);
  });

  it('still sends no transcript at filing', () => {
    // Removed on 2026-08-11 after the ticketing agent measured it costing
    // ~3.5s on one call in ten. Guarding it so a later edit does not restore it.
    const call = submitCall();
    expect(call).not.toMatch(/transcript: metadata\.getTranscript/);
  });
});

describe('what the ticketing app will actually receive', () => {
  const cases: Array<[string, number, boolean]> = [
    ['Caller is asking for the exact office hours of the Eastvale location', 166, false],
    ['Caller wants to confirm Torrance office address and phone number', 166, false],
    ['Worsening pain in right eye over the past day, requesting urgent follow-up', 163, true],
    ['there is a curtain coming across my vision', 165, true],
    ['I lost my vision in my right eye this morning', 161, true],
    ['wants to confirm if the referral and authorization have been received', 167, false],
  ];

  for (const [text, reasonId, urgent] of cases) {
    it(`"${text.slice(0, 44)}…" -> ${reasonId}${urgent ? ' (urgent)' : ''}`, () => {
      const { classification, isCatchAll } = classifyAfterHoursRequest(text);
      expect(isCatchAll, text).toBe(false);
      expect(classification.requestReasonId, text).toBe(reasonId);
      expect(Boolean(classification.urgent), text).toBe(urgent);
    });
  }

  it('never suggests 159 — it is a disposition, not a reason', () => {
    // The whole point. 159 says a clinician was pulled out of bed; only the
    // code that completes a transfer knows that happened.
    for (const text of [
      'what time do you open on Saturday',
      'my glasses broke at the hinge',
      'pharmacy requesting an updated phone number',
      'I need to talk to someone about my bill',
    ]) {
      expect(classifyAfterHoursRequest(text).classification.requestReasonId, text).not.toBe(159);
    }
  });
});
