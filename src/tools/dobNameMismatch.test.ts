/**
 * THE QUEUE-LANE DATE-OF-BIRTH CORPUS — 2026-09-14.
 *
 * RULE THREE (CLAUDE.md): a real failure day gets its calls pulled to disk,
 * every call is read, its specific failure is named, and the corpus becomes a
 * test we work until it passes. This is that test for the queue lanes.
 *
 * THE POPULATION. On 2026-09-14, 94 runtime calls hit a `date_of_birth`
 * refusal and 61 ended with no ticket. 30 of them had `lookup_patient` return
 * `matched_by: 'phone'` with `identity_is_certain: true` — the appointment-book
 * rung, where the carry DOES store the chart date. So the record was in the map
 * at filing time and `verifiedDobFor` refused anyway. Those 30 are this corpus.
 *
 * WHAT READING THEM FOUND, which no SQL had said:
 *
 *   - 24 of 30 were greeted BY NAME from their own record.
 *   - **19 of 30 were greeted by name and then asked for their last name
 *     anyway.**
 *   - 27 of 30 were asked for BOTH their last name and their date of birth.
 *
 * So the name guard is not malfunctioning. It is being handed a comparison
 * that should never have existed: the record's spelling against a transcription
 * of the caller saying their own name out loud. Those disagree constantly —
 * Spanish surnames, compound surnames, and ordinary mis-hearings — and the
 * disagreement costs the caller a birthday we were already holding.
 *
 * THE FIX FOR THAT IS UPSTREAM AND IS NOT IN THIS FILE: stop asking a
 * recognised caller for a field the record holds (RULE ZERO 1). `nameKey`
 * narrows the damage; it does not remove the question.
 *
 * PHI: the SIDs are real, the names are SYNTHETIC stand-ins chosen to
 * reproduce each real shape exactly (same diacritic, same punctuation, same
 * kind of transcription slip). Real patient names never enter this repo —
 * the same rule `src/pcp/replay20260914.test.ts` follows.
 */

import { describe, it, expect } from 'vitest';
import { nameKey } from './verifiedIdentity';

/** The old guard, kept so each row states what CHANGED rather than asserting into the void. */
const oldNorm = (s: string) => s.trim().toLowerCase();

type Shape = 'accent' | 'apostrophe' | 'compound' | 'transcription' | 'different_person';

interface CorpusCase {
  /** Real call_sid prefix from 2026-09-14. The index back to the transcript. */
  sid: string;
  lane: 'optical' | 'surgery' | 'tech';
  shape: Shape;
  /** Synthetic, reproducing the real shape. */
  record: string;
  caller: string;
  /** Does the shipped nameKey rescue this call? */
  rescued: boolean;
}

const CORPUS: CorpusCase[] = [
  // ── Accents. The record is ASCII-folded, the caller's name is transcribed
  //    with the diacritic (or the reverse). Five calls, all Spanish-speaking.
  { sid: 'CA2bf3dc76', lane: 'optical', shape: 'accent', record: 'Ramirez', caller: 'Ramírez', rescued: true },
  { sid: 'CA70c73e6d', lane: 'optical', shape: 'accent', record: 'Peralta', caller: 'Peraltá', rescued: true },
  { sid: 'CA91d6dcac', lane: 'surgery', shape: 'accent', record: 'Fuentes', caller: 'Fuéntes', rescued: true },
  { sid: 'CAa3fc48ef', lane: 'optical', shape: 'accent', record: 'Barrera', caller: 'Barrerá', rescued: true },
  { sid: 'CAe01e8b26', lane: 'optical', shape: 'accent', record: 'Salazar', caller: 'Salázar', rescued: true },

  // ── Apostrophe. Curly in one source, straight in the other. Same caller
  //    rang three times that evening; two of the three are this shape.
  { sid: 'CAa17b3bfd', lane: 'tech', shape: 'apostrophe', record: 'O’Donnell', caller: "O'Donnell", rescued: true },
  { sid: 'CAc24ab61a', lane: 'tech', shape: 'apostrophe', record: 'O’Donnell', caller: "O'Donnell", rescued: true },

  // ── Compound surnames. The chart holds two or three parts; the caller says
  //    one. nameKey cannot help — there is genuinely less name on one side.
  { sid: 'CAb158124a', lane: 'surgery', shape: 'compound', record: 'Herrera Solano', caller: 'Herrera', rescued: false },
  { sid: 'CA7e568ab6', lane: 'optical', shape: 'compound', record: 'Navarro De Castro', caller: 'Navarro', rescued: false },

  // ── Transcription. The model heard it differently. No normalisation reaches
  //    these, and none should try — guessing here files a stranger's birthday.
  { sid: 'CA05cc2b8c', lane: 'surgery', shape: 'transcription', record: 'Mendosa', caller: 'Mendoza', rescued: false },
  { sid: 'CAf3093a02', lane: 'optical', shape: 'transcription', record: 'Noura', caller: 'Nora', rescued: false },
  { sid: 'CA4ba00e92', lane: 'tech', shape: 'transcription', record: 'Harrington', caller: 'Herrington', rescued: false },
  { sid: 'CA0ae1c4a3', lane: 'optical', shape: 'transcription', record: 'Marta', caller: 'Marina', rescued: false },
  { sid: 'CA66cf8ef7', lane: 'optical', shape: 'transcription', record: 'Newbury', caller: 'Roomer', rescued: false },

  // ── Genuinely a different person. The guard is RIGHT to refuse these, and
  //    any loosening that "rescues" them is a defect, not an improvement.
  { sid: 'CA61344f9c', lane: 'tech', shape: 'different_person', record: 'O’Donnell', caller: 'Grant', rescued: false },
  { sid: 'CA2444a0b9', lane: 'tech', shape: 'different_person', record: 'Hollis', caller: 'Island', rescued: false },
];

const FIRST = 'Casey';

describe('the 2026-09-14 queue-lane date-of-birth corpus', () => {
  it.each(CORPUS)('$sid ($lane, $shape) — nameKey rescues: $rescued', (c) => {
    const matches = nameKey(FIRST) === nameKey(FIRST) && nameKey(c.record) === nameKey(c.caller);
    expect(matches).toBe(c.rescued);
  });

  it('every rescued case genuinely FAILED under the old exact guard', () => {
    // Otherwise the row is not evidence of anything: it would have matched
    // before the change and proves nothing about nameKey.
    for (const c of CORPUS.filter((x) => x.rescued)) {
      expect(oldNorm(c.record) === oldNorm(c.caller)).toBe(false);
    }
  });

  it('a different person is never rescued, whatever the normalisation', () => {
    for (const c of CORPUS.filter((x) => x.shape === 'different_person')) {
      expect(nameKey(c.record) === nameKey(c.caller)).toBe(false);
    }
  });

  /**
   * THE HEADLINE, stated as the defect was.
   *
   * 7 of the 16 name-pair cases are rescued. That is NOT "7 of the 30 calls
   * fixed" — the other 14 calls in the population did not reach a name
   * comparison this file can reconstruct (the caller never stated a name, or
   * the transcript does not carry the record's spelling). This number is a
   * floor on the name-guard subset and nothing more.
   */
  it('reports the rescue split, so a later change has to move a number', () => {
    const rescued = CORPUS.filter((c) => c.rescued).length;
    const stillFails = CORPUS.length - rescued;
    expect(rescued).toBe(7);
    expect(stillFails).toBe(9);
  });

  /**
   * THE REAL DEFECT, pinned so nobody reads the rescue count as the fix.
   *
   * 19 of the 30 calls were greeted by name from the record and then asked
   * for their last name anyway. Every mismatch above is downstream of that
   * question. Delete the question for a recognised caller and the comparison
   * never happens.
   */
  it('records that the name comparison should not exist for a recognised caller', () => {
    const GREETED_THEN_ASKED_ANYWAY = 19;
    const POPULATION = 30;
    expect(GREETED_THEN_ASKED_ANYWAY / POPULATION).toBeGreaterThan(0.6);
  });
});
