/**
 * Department 8's failure is that ROUTINE calls are recorded as urgent
 * transfers, which makes the genuinely urgent ones impossible to find.
 *
 * 479 of 986 tickets carry reason 159, "Transferred to On-Call Provider".
 * The cases in the first block below are verbatim from that population.
 *
 * So the tests come in two halves, and the second half is the point:
 *   - a real emergency is never missed
 *   - an office-hours question is never called an emergency
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAfterHours,
  classifyAfterHoursRequest,
  afterHoursReasonById,
  AFTER_HOURS_CATCHALL,
  AFTER_HOURS_CLASSIFICATIONS,
  AFTER_HOURS_REASON_IDS,
  AFTER_HOURS_TRANSFERRED,
} from './afterHoursTaxonomy';

const reason = (t: string) => classifyAfterHours(t)?.requestReasonId;

describe('what is actually filed as an urgent transfer today', () => {
  // Every one of these is real text from a ticket carrying reason 159.
  const realButRoutine: Array<[string, number]> = [
    ['Caller is asking for the exact office hours of the Eastvale location', 166],
    ['Caller wants to confirm the exact opening time for the Monrovia office today', 166],
    ['Caller asked for confirmation of Torrance office address and phone number', 166],
    ['Caller wants confirmation of the Indio office hours, specifically weekend availability', 166],
    ['Patient requested the address and directions for their appointment at the Montebello location', 166],
  ];

  for (const [text, expected] of realButRoutine) {
    it(`"${text.slice(0, 46)}…" is not an emergency`, () => {
      const r = classifyAfterHours(text);
      expect(r?.requestReasonId, text).toBe(expected);
      expect(r?.urgent, 'filed as urgent').toBeUndefined();
      expect(r?.requestTypeId, 'filed under Urgent/Emergency Transfer').not.toBe(34);
    });
  }

  it('an insurance or authorization question is not an emergency either', () => {
    const r = classifyAfterHours('wants to confirm if the referral and authorization for Dr. Casey have been received');
    expect(r?.requestReasonId).toBe(167);
    expect(r?.urgent).toBeUndefined();
  });
});

describe('a real emergency is never missed', () => {
  const emergencies: Array<[string, number]> = [
    ['there is a curtain coming across my vision', 165],
    ['I keep seeing flashes and a lot of new floaters', 165],
    ['I lost my vision in my right eye this morning', 161],
    ["I can't see out of my left eye", 161],
    ['I got bleach splashed in my eye', 164],
    ['something hit me in the eye at work', 162],
    ['I have severe pain since my surgery', 160],
    ['Worsening pain in right eye over the past day', 163],
    ['no puedo ver del ojo derecho', 161],
    ['tengo mucho dolor en el ojo', 163],
  ];

  for (const [text, expected] of emergencies) {
    it(`"${text.slice(0, 44)}…" -> ${expected}`, () => {
      const r = classifyAfterHours(text);
      expect(r?.requestReasonId, text).toBe(expected);
      expect(r?.urgent, text).toBe(true);
    });
  }

  it('puts every clinical reason under the urgent type and marks it', () => {
    for (const c of AFTER_HOURS_CLASSIFICATIONS) {
      if (c.requestTypeId === 34) expect(c.urgent, `${c.requestReason} is not marked urgent`).toBe(true);
      if (c.urgent) expect(c.requestTypeId, `${c.requestReason} is not an urgent type`).toBe(34);
    }
  });

  it('checks the emergencies before anything else', () => {
    // "I have severe pain and I wanted to ask about my bill" must not become a
    // billing question. Ordering is the only thing enforcing that.
    const firstNonUrgent = AFTER_HOURS_CLASSIFICATIONS.findIndex((c) => !c.urgent);
    const lastUrgent = AFTER_HOURS_CLASSIFICATIONS.map((c) => Boolean(c.urgent)).lastIndexOf(true);
    expect(lastUrgent).toBeLessThan(firstNonUrgent);
    expect(reason('I have severe pain and I also wanted to ask about my bill')).toBe(163);
  });
});

describe('159 is a disposition, not a reason', () => {
  it('is not in the classification table at all', () => {
    // 479 tickets exist because a keyword fallback claimed a transfer had
    // happened. Only the code that completes one knows that.
    for (const c of AFTER_HOURS_CLASSIFICATIONS) {
      expect(c.requestReasonId).not.toBe(159);
    }
    expect(afterHoursReasonById(159)).toBeNull();
  });

  it('is still available to the code that really does transfer', () => {
    expect(AFTER_HOURS_TRANSFERRED.requestReasonId).toBe(159);
    expect(AFTER_HOURS_REASON_IDS.has(159)).toBe(true);
  });

  it('never falls back to it', () => {
    const r = classifyAfterHoursRequest('something nobody has a category for');
    expect(r.isCatchAll).toBe(true);
    expect(r.classification.requestReasonId).toBe(538);
    expect(r.classification.requestTypeId).toBe(68);
  });
});

describe('reasons that belong to other departments cannot appear', () => {
  it('never reaches for 153', () => {
    // 13 department 8 tickets carry it today. It is department 3's.
    expect(AFTER_HOURS_REASON_IDS.has(153)).toBe(false);
  });

  it('has no appointment reasons — scheduling leaves this department', () => {
    // The operator's ruling sends schedule-related calls to the HVA Hub, and
    // the 274 unclassified tickets here are overwhelmingly Spanish appointment
    // requests. That is queueRouting's job, not this table's.
    for (const c of AFTER_HOURS_CLASSIFICATIONS) {
      expect([146, 147, 148, 149, 150, 151, 152]).not.toContain(c.requestReasonId);
    }
  });
});

describe('the table itself', () => {
  it('has no duplicate reason ids', () => {
    const ids = AFTER_HOURS_CLASSIFICATIONS.map((c) => c.requestReasonId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('treats empty and whitespace as unclassifiable rather than throwing', () => {
    expect(classifyAfterHours('')).toBeNull();
    expect(classifyAfterHours('   ')).toBeNull();
    expect(classifyAfterHoursRequest('').isCatchAll).toBe(true);
  });

  it('looks a pair up by id, and refuses one it does not own', () => {
    expect(afterHoursReasonById(166)?.requestReason).toBe('Office Hours/Location Question');
    expect(afterHoursReasonById(538)).toBe(AFTER_HOURS_CATCHALL);
    expect(afterHoursReasonById(500)).toBeNull(); // a department 16 reason
  });
});
