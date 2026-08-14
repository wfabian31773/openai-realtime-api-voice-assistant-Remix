/**
 * The second measurement, four hours after the first.
 *
 * Operator, 2026-08-13: *"let's take a look and see how the agents are doing…
 * I'm sure we will find others."* He was right.
 *
 * Catch-all rates moved in the right direction after the morning's rebuild —
 * surgery 51% → 37%, optical 74% → 57% — but tech went the OTHER way, 18% →
 * 29%, and the reason was structural: tech was the last taxonomy still matching
 * with `toLowerCase().includes` and no diacritic folding. It is the largest
 * queue in the practice and it was the last one I converted, which is the wrong
 * order to have found them in — I fixed the ones whose failures I happened to
 * read.
 *
 * Every string below is verbatim from a ticket filed this afternoon.
 */
import { describe, it, expect } from 'vitest';
import { classifySurgeryRequest, isSurgeryPostOpSymptom } from './surgeryTaxonomy';
import { classifyTech } from './techTaxonomy';

const surgeryReason = (t: string) => classifySurgeryRequest(t).classification.requestReasonId;

describe('the post-op symptom that filed as routine', () => {
  /**
   * Filed at priority MEDIUM, reason 535 "Other - See Description":
   *
   *   "My right eye that Dr. Brookman did the surgery on is very blurry and
   *    it's really upsetting. I need to know what's happening."
   *
   * A post-cataract patient describing a blurry eye. The post-op check existed
   * and did not fire, because the caller named the context by SURGEON rather
   * than by event — "the eye Dr X did" — and every cue expected "after my
   * surgery" or "since my surgery". Patients say who operated on them at least
   * as often as they say when.
   */
  it('fires when the surgeon is how the surgery is named', () => {
    expect(
      isSurgeryPostOpSymptom(
        "My right eye that Dr. Brookman did the surgery on is very blurry and it's really upsetting.",
      ),
    ).toBe(true);
  });

  it('handles the other ways a caller names the operation', () => {
    for (const text of [
      'the eye he did is red and painful',
      'Dr Ong performed my surgery and now I have a lot of pain',
      'they operated on my left eye and it is bleeding',
      'me hizo la cirugia el doctor y tengo mucho dolor',
    ]) {
      expect(isSurgeryPostOpSymptom(text), text).toBe(true);
    }
  });

  it('still needs a symptom, not just a surgeon', () => {
    expect(isSurgeryPostOpSymptom('Dr. Brookman did the surgery on my right eye')).toBe(false);
    expect(isSurgeryPostOpSymptom('who did my surgery?')).toBe(false);
  });
});

describe('surgery — this afternoon\'s catch-alls', () => {
  const CASES: Array<[string, number, string]> = [
    [
      "They're charging me $2,450 for a surgery that was done on December 3, 2025, but it's already been paid for.",
      533,
      'pay is not a substring of paid',
    ],
    [
      'I need to confirm the appointment time for my surgery on August 14, 2026.',
      532,
      'appointment time',
    ],
    [
      'Quiero saber a qué hora tengo la cirugía mañana.',
      532,
      'Spanish arrival time',
    ],
    [
      'I need the date for my surgery.',
      43,
      'the caller inverted "surgery date"',
    ],
  ];

  for (const [text, reason, why] of CASES) {
    it(`"${text.slice(0, 48)}…" -> ${reason} (${why})`, () => {
      expect(surgeryReason(text)).toBe(reason);
    });
  }
});

describe('tech could not read Spanish until this afternoon', () => {
  /**
   * `classifyTech` matched with `toLowerCase().includes` and no folding, so an
   * accented word could not match a cue even when the cue existed. Surgery,
   * Optical and After Hours had all been converted; the largest queue had not.
   */
  it('matches an accented request', () => {
    // Both spellings must reach the same place — transcription and staff
    // typing disagree constantly on accents.
    const accented = classifyTech('necesito una autorización para mi medicamento');
    const plain = classifyTech('necesito una autorizacion para mi medicamento');
    expect(accented?.requestReasonId).toBe(plain?.requestReasonId);
    expect(accented).not.toBeNull();
  });

  it('does not fire a short cue inside another word', () => {
    // `anyCue` word-boundaries short cues. Without it `rx` matches anywhere.
    expect(classifyTech('the patient has dyslexia')?.requestReasonId).not.toBe(211);
  });

  it('still classifies the English it always did', () => {
    expect(classifyTech('I need a refill of my latanoprost')?.requestReasonId).toBe(155);
    expect(classifyTech('my insurance denied the medication')?.requestReasonId).toBe(210);
  });
});
