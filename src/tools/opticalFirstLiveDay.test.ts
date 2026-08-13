/**
 * EVERY STRING HERE IS REAL, taken from department 1 in the Support Center.
 *
 * Optical went live on 2026-08-13 and filed 14 tickets. ELEVEN landed on the
 * catch-all — 85%, the worst of the four new lines — while its descriptions
 * averaged 52 characters against 185 on the tech queue. "Other - See
 * Description" is only honest when the description carries the caller's words,
 * and "contact lenses" is not a description.
 *
 * Replaying 92 real tickets: 70.7% catch-all before, 27.2% after.
 *
 * The existing opticalTaxonomy.test.ts passed the whole time, because every
 * string in it was one I wrote. That is the trap this file exists to close:
 * a corpus written by the author of the cues proves the two agree with each
 * other, not that either matches how patients speak.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyOptical,
  OPTICAL_GLASSES_STATUS_CUES,
  OPTICAL_NEW_ORDER_CUES,
} from './opticalTaxonomy';
import { anyCue } from './cueMatch';

const reasonOf = (t: string) => classifyOptical(t)?.requestReasonId ?? null;

describe('"where are my glasses" is this queue, and it could not hear it', () => {
  const STATUS: string[] = [
    'checking on some glasses',
    'Check on the status of his glasses',
    'checking on status of glasses ordered',
    'Wants to know how long they will hold onto her glasses for.',
    'Caller wants to know when she will be getting her glasses',
    'Waiting on new glasses to arrive - follow-up on call',
    'Patient inquiry about eyeglasses arrival',
    'Glasses Pickup Status Inquiry',
    'Checking if glasses are ready for pickup',
    'Inquiry about glasses pickup readiness',
    'Inquiry about Maui Jim sunglasses status',
    'Checking on frame status for patient; order ticket number 7768451',
    'I want to pick up my prescription eyeglasses.',
    'I need to come pick up glasses.',
  ];

  for (const text of STATUS) {
    it(`"${text.slice(0, 48)}…" -> 20`, () => {
      expect(reasonOf(text)).toBe(20);
    });
  }

  it('keeps contacts on their own reason rather than letting glasses take them', () => {
    // The two lists share their status phrases and differ only in the object,
    // so a contacts chase cannot be swallowed by reason 20 — which is checked
    // first.
    expect(reasonOf("I need the status of my contacts that I've ordered")).toBe(21);
    expect(reasonOf('Check on contact lens order')).toBe(21);
    expect(reasonOf('Check status of contact lenses')).toBe(21);
    expect(reasonOf('Patient stated she has heard nothing regarding her CL order.')).toBe(21);
  });
});

describe('the three reasons those cues missed', () => {
  it('1 — the cues were about READINESS, the calls are about STATUS', () => {
    // 'glasses ready' answers "are they ready". Nobody says that.
    expect(anyCue('checking on status of glasses ordered', ['glasses ready'])).toBe(false);
    expect(anyCue('checking on status of glasses ordered', OPTICAL_GLASSES_STATUS_CUES)).toBe(true);
  });

  it('2 — "pickup" is one word and every cue said "pick up"', () => {
    // A space is a character.
    expect(anyCue('Glasses Pickup Status Inquiry', ['pick up glasses'])).toBe(false);
    expect(anyCue('Glasses Pickup Status Inquiry', OPTICAL_GLASSES_STATUS_CUES)).toBe(true);
  });

  it('3 — "CL" is the optical shorthand and is two characters', () => {
    expect(reasonOf('Needs Status of CL. Patient has heard nothing about her CL order')).toBe(21);
    // …and must not fire inside an ordinary word. The `er` lesson.
    expect(anyCue('the patient was unclear about the click', ['cl'])).toBe(false);
    expect(anyCue('please close the claim', ['cl'])).toBe(false);
  });
});

describe('ordering one, as opposed to chasing one already ordered', () => {
  it('matches the compound word that broke the old cue', () => {
    // 'new glasses' is not a substring of "new eyeglasses".
    expect(anyCue('New eyeglasses request', ['new glasses'])).toBe(false);
    expect(reasonOf('New eyeglasses request')).toBe(1);
    expect(reasonOf('Ordering new glasses')).toBe(1);
    expect(reasonOf('Order glasses')).toBe(1);
  });

  it('reads "order inquiry" as chasing an order, not placing one', () => {
    // "New eyeglasses order inquiry" is genuinely ambiguous — it could be
    // someone ordering or someone chasing. The word "inquiry" decides it, and
    // reason 20 is checked first. Recorded rather than left to look like a bug.
    expect(reasonOf('New eyeglasses order inquiry')).toBe(20);
  });

  it('does not swallow a status chase', () => {
    // "Checking status of new glasses order" is someone waiting, not ordering.
    expect(reasonOf('Checking status of new glasses order')).toBe(20);
  });

  it('is generated, not hand-listed', () => {
    expect(OPTICAL_NEW_ORDER_CUES.length).toBeGreaterThan(300);
  });
});

describe('Spanish, which could not match anything at all before', () => {
  it('folds diacritics in both directions', () => {
    expect(reasonOf('Consulta sobre estado de lentes')).toBe(20);
    expect(reasonOf('Consulta sobre recogida de lentes y costos')).toBe(20);
    expect(reasonOf('Consulta sobre recolección de lentes')).toBe(20);
    expect(reasonOf('Consulta sobre recoleccion de lentes')).toBe(20);
  });
});

describe('lens complaints', () => {
  it('reads a complaint about the lens as a wrong prescription', () => {
    expect(reasonOf("Pt states his glasses aren't helpful. He believes the lens is incorrect")).toBe(7);
    expect(reasonOf('pt called in requesting a recheck for her glasses prescription')).toBe(7);
  });

  it('still reads a scratch as a scratch', () => {
    expect(reasonOf('The lens on my glasses has a deep scratch')).toBe(6);
  });
});

describe('what still has no box, and is left that way on purpose', () => {
  /**
   * A COPY OF THE PRESCRIPTION is the largest remaining cluster — eleven of the
   * twenty-five unclassified in the replay. Department 1 has no reason for it:
   * reason 1 is "New Rx - Frame Selection", which is choosing frames, not
   * handing someone their prescription.
   *
   * Not invented here. Same situation as reason 551 on the after-hours queue
   * and authorization on Surgery: a taxonomy gap the ticketing app has to
   * close, and guessing a near-miss reason is the failure this whole exercise
   * exists to stop.
   */
  it('does not guess a reason for a prescription copy request', () => {
    for (const text of [
      'Request for copy of glasses prescription',
      'I need my latest eyeglass prescription.',
      'Eyeglass prescription update and fax request',
      'Prescription email request',
    ]) {
      expect(reasonOf(text), text).toBeNull();
    }
  });
});
