/**
 * EVERY STRING IN THIS FILE IS REAL, and that is the point.
 *
 * Surgery Coordination went live on 2026-08-13 and filed 32 tickets. Twenty-one
 * landed on "Other - See Description" — a 67% catch-all rate against 9.6% on
 * the tech queue, which was the one built by measuring real ticket text and
 * generating its cues rather than hand-writing them.
 *
 * The existing surgeryTaxonomy.test.ts passed throughout, because every string
 * in it was one I had written. A test corpus authored by the same person who
 * authored the cues tests that they agree with each other, not that either
 * matches how patients speak.
 *
 * So these are verbatim from the Support Center: the queue's first live day and
 * the 90 days behind it. Where the wording is trimmed it is only for length.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySurgeryRequest,
  isSurgeryPostOpSymptom,
  SURGERY_SCHEDULING_CUES,
  anySurgeryCue,
} from './surgeryTaxonomy';

const reasonOf = (t: string) => classifySurgeryRequest(t).classification.requestReasonId;
const isCatchAll = (t: string) => classifySurgeryRequest(t).isCatchAll;

describe('the sentences that produced a catch-all on the first live day', () => {
  /** [text, the reason it should now carry] */
  const CASES: Array<[string, number]> = [
    // --- Surgery scheduling (43). Six of these, every one missed.
    ["I'd like to schedule a cataract surgery for the first time.", 43],
    ['I need to schedule my eye surgery after September.', 43],
    ['We need to schedule cataract surgery and find a doctor.', 43],
    ['I don\'t know the date and time of my cataract surgery appointment.', 43],
    ["I'm calling about finding out when they have scheduled my cataract surgery.", 43],
    ['waiting for appointment date', 43],

    // --- Second eye (47), which must win over plain scheduling.
    ['schedule the right eye surgery after the left surgery', 47],
    ['Patient would like to schedule her 2nd eye sx. Thank You', 47],
    ['The patient called to schedule her second eye surgery with Dr Ong', 47],

    // --- Reschedule / cancel (531).
    ['pt states received a message saying her cat surgery for september was moved to october', 531],
    // 45, NOT 531, and that is the documented design rather than a miss: a
    // procedure box outranks a logistics one, so cancelling an A-scan files as
    // Pre-Op Measurements with the cancellation in the description. Same rule
    // that makes "reschedule my post-op appointment" reason 46.
    ['Pt wants to cancel Sx — patient is calling to cancel his AScan appointment and Surgery', 45],
    ['Me van a hacer la cirugía al ojo izquierdo el 8 de octubre, y quisiera saber si me han cambiado la cita', 531],

    // --- Status follow-up (534), the largest bucket in the queue.
    ['patient already called 3 times to set appt for surgery but no one is calling her back', 534],
    ['Dr. Patel was supposed to make arrangements for me to have service at Loma Linda, and I haven\'t heard anything from the office.', 534],
    ['patient requesting a call back for an update on surgery details for the 2nd eye, she thinks the surgery team forgot about her', 47],

    // --- Financial (533). Spanish, which could not match anything before.
    ['Necesito pagar la cirugía y no sé cómo hacerlo.', 533],

    // --- Clearance / pre-op forms (530).
    ['I have a surgery scheduled for the 28th and I want to make sure that all my pre-surgery things are taken care of.', 530],
    ['He states that he did not get any pre-surgery kit before his supposed surgery', 530],

    // The full ticket reads "...but has no surgery scheduled, please contact
    // patient to schedule surgery" — the measurements are the context and the
    // REQUEST is scheduling. 43 is right.
    ['pt is in office getting measurements for cataract surgery but has no surgery scheduled', 43],
  ];

  for (const [text, reason] of CASES) {
    it(`"${text.slice(0, 52)}…" -> ${reason}`, () => {
      expect(reasonOf(text)).toBe(reason);
    });
  }

  it('cuts the catch-all rate on the real corpus', () => {
    const stillCatchAll = CASES.filter(([t]) => isCatchAll(t));
    expect(stillCatchAll.map(([t]) => t)).toEqual([]);
  });
});

describe('sx — the practice\'s own word, and a two-character trap', () => {
  it('matches sx as a word', () => {
    expect(reasonOf('schedule sx')).toBe(43);
    expect(reasonOf('pt is calling in to schedule sx again')).toBe(43);
    expect(reasonOf('requesting sx appt')).toBe(43);
  });

  /**
   * THE `er` LESSON, applied before it could cost anything. A two-character
   * cue matched with String.includes put 479 tickets on reason 159. Short cues
   * here are matched on a word boundary instead.
   */
  it('does not fire inside an ordinary word', () => {
    expect(anySurgeryCue('the patient has dyslexia', ['sx'])).toBe(false);
    expect(anySurgeryCue('please check the fax number', ['sx'])).toBe(false);
    expect(anySurgeryCue('sxxx', ['sx'])).toBe(false);
  });

  it('still matches at the edges of a sentence', () => {
    expect(anySurgeryCue('sx', ['sx'])).toBe(true);
    expect(anySurgeryCue('cancel sx', ['sx'])).toBe(true);
    expect(anySurgeryCue('sx, please call', ['sx'])).toBe(true);
  });
});

describe('the generated scheduling cues', () => {
  it('covers the determiner and object variations that were missed', () => {
    for (const phrase of [
      'schedule a cataract surgery',
      'schedule my eye surgery',
      'schedule the right eye surgery',
      'schedule cataract surgery',
      'schedule sx',
      'agendar la cirugia',
    ]) {
      expect(anySurgeryCue(phrase, SURGERY_SCHEDULING_CUES), phrase).toBe(true);
    }
  });

  it('is generated, not hand-listed — the list is far larger than anyone would type', () => {
    expect(SURGERY_SCHEDULING_CUES.length).toBeGreaterThan(500);
  });
});

describe('Spanish was structurally unreachable before this', () => {
  /**
   * Matching was `text.toLowerCase().includes(cue)` with no diacritic folding,
   * so an accented word could not match a cue even if the cue existed. This is
   * the same defect the department 8 taxonomy had, found the same way — by
   * reading real tickets rather than by reading the code.
   */
  it('matches across accents in both directions', () => {
    expect(reasonOf('Necesito pagar la cirugía')).toBe(533);
    expect(reasonOf('Necesito pagar la cirugia')).toBe(533);
    expect(reasonOf('Cancelación de la cirugía')).toBe(531);
    expect(reasonOf('cancelacion de la cirugia')).toBe(531);
  });
});

describe('post-op symptoms are no longer routine', () => {
  it('flags the ticket that started this', () => {
    expect(
      isSurgeryPostOpSymptom(
        "I had cataract surgery on my right eye, but it feels like there's something stuck in my eye and I need to see the doctor.",
      ),
    ).toBe(true);
  });

  it('requires BOTH a post-op context and a symptom', () => {
    // A date question about a post-op visit is not a symptom.
    expect(isSurgeryPostOpSymptom('when is my post-op appointment')).toBe(false);
    // A symptom with no surgery behind it is not this queue's call.
    expect(isSurgeryPostOpSymptom('my eye hurts')).toBe(false);
    // Both halves present.
    expect(isSurgeryPostOpSymptom('since my surgery my eye has been very red and painful')).toBe(true);
    expect(isSurgeryPostOpSymptom('me operaron y tengo mucho dolor')).toBe(true);
  });

  it('is kept separate from the 911 language, deliberately', () => {
    // Reason 53 tells the caller to seek emergency care. A gritty eye after a
    // cataract operation needs a coordinator today, not an ambulance.
    const cls = classifySurgeryRequest('since my surgery it feels like something is stuck in my eye');
    expect(cls.classification.urgent).not.toBe(true);
  });
});
