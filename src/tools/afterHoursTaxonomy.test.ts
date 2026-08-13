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

  it('checks the NAMED symptoms before anything else', () => {
    // "I have severe pain and I wanted to ask about my bill" must not become a
    // billing question. Ordering is the only thing enforcing that.
    //
    // 551 is the exception and is deliberately LAST — it names no symptom, so
    // every specific category outranks it. Guarding the invariant as "all
    // urgent entries come first" would have been satisfied by putting the
    // floor at the top, which is the bug this ordering exists to avoid.
    const symptomEntries = AFTER_HOURS_CLASSIFICATIONS.filter(
      (c) => c.urgent && c.requestReasonId !== 551,
    );
    const firstNonUrgent = AFTER_HOURS_CLASSIFICATIONS.findIndex((c) => !c.urgent);
    const lastSymptom = AFTER_HOURS_CLASSIFICATIONS.map(
      (c) => Boolean(c.urgent) && c.requestReasonId !== 551,
    ).lastIndexOf(true);

    expect(symptomEntries).toHaveLength(6);
    expect(lastSymptom).toBeLessThan(firstNonUrgent);
    expect(AFTER_HOURS_CLASSIFICATIONS[AFTER_HOURS_CLASSIFICATIONS.length - 1].requestReasonId).toBe(551);
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

describe('551 — the floor for declared urgency, and the word that points the other way', () => {
  // Every string below is real department 8 ticket text from the 90 days to
  // 2026-08-13. 40 tickets declare urgency; only 6 name a symptom.

  it('catches a caller who declares urgency and names nothing', () => {
    expect(reason('Patient with cornea transplant wishes to urgently leave message for on-call doctor')).toBe(551);
    expect(classifyAfterHours('this is an emergency')?.urgent).toBe(true);
    expect(reason('es una emergencia')).toBe(551);
  });

  it('NEVER takes a cancellation, which is the largest group carrying the word', () => {
    // 23 of the 34. Here "emergency" explains why the patient CANNOT come —
    // it points away from needing care, and filing it as an urgent eye
    // complaint inverts the caller's meaning.
    const cancellations = [
      'Caller needs to cancel the appointment on June 16, 2026 with Dr. Julia Chu in Riverside due to family emergency—husband in intensive care',
      'Cancel appointment due to patient being in the emergency hospital',
      'Caller needs to cancel the appointment on Monday at 2:20 PM with Dr. Amini due to an emergency gallbladder operation',
      'Desea cancelar la cita del 4 de junio con la Dra. Samira Khan debido a una emergencia familiar',
      'Cancelación de la cita programada el 11 de junio de 2026 debido a una emergencia',
    ];
    for (const text of cancellations) {
      expect(reason(text), text.slice(0, 50)).not.toBe(551);
      expect(classifyAfterHoursRequest(text).classification.requestTypeId, text.slice(0, 50)).not.toBe(34);
    }
  });

  it('does not pin an urgent APPOINTMENT request into this department', () => {
    // Scheduling leaves department 8 by the operator's ruling. A type 34 hint
    // would hold it here, so the entry declines and the ticketing app decides.
    expect(reason('New patient requesting an urgent appointment with Dr. Eugene Kang')).not.toBe(551);
    expect(reason('Requesting to schedule a new patient emergency eye exam appointment')).not.toBe(551);
  });

  it('does not treat "I want a real person" as a clinical urgency', () => {
    expect(reason('Caller is requesting to speak with a real human urgently and is expressing frustration about speaking with an AI')).not.toBe(551);
  });

  it('still loses to a named symptom, every time', () => {
    // Their words: "A named symptom still wins. 551 is the floor for type 34,
    // not a replacement for triage."
    expect(reason('this is urgent, I have sudden vision loss')).toBe(161);
    expect(reason('emergency — chemical splashed in my eye')).toBe(164);
    expect(reason('urgent, worsening pain in right eye')).toBe(163);
  });

  it('loses to a specific non-clinical category too', () => {
    expect(reason('I urgently need to know your office hours')).toBe(166);
    expect(reason('urgent — please have someone call me back')).toBe(174);
  });

  it('uses stems long enough to be safe as substrings', () => {
    // The `er` lesson. Every cue on this entry must be long enough that it
    // cannot fire inside an ordinary word.
    const entry = AFTER_HOURS_CLASSIFICATIONS.find((c) => c.requestReasonId === 551)!;
    for (const cue of entry.cues) expect(cue.length, cue).toBeGreaterThanOrEqual(6);
    expect(reason('caller asked her provider to transfer the number')).not.toBe(551);
  });

  it('is the only entry allowed an excludes list', () => {
    const guarded = AFTER_HOURS_CLASSIFICATIONS.filter((c) => c.excludes?.length);
    expect(guarded.map((c) => c.requestReasonId)).toEqual([551]);
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
