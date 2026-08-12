/**
 * The real message, and the real characters that broke it.
 */
import { describe, it, expect } from 'vitest';
import { toGsm7, isGsm7, nonGsm7Characters, sanitizeForSms } from './gsm7';

/**
 * The acknowledgement Twilio sent for VA-50803, verbatim. Twilio's own log:
 *   Encoding UCS2 · Message Segments 3 · Cost $0.0249
 * for a ~140-character body that is one GSM-7 segment. The single cause is the
 * typographic apostrophe in "we've".
 */
const VA_50803 =
  'Hi Wayne, we’ve received your request for frame selection ' +
  '(Ticket #VA-50803). Our Optical Support team will assist you shortly. - Azul Vision';

describe('the message that started this', () => {
  it('is not GSM-7 before, and is after', () => {
    expect(isGsm7(VA_50803)).toBe(false);
    expect(nonGsm7Characters(VA_50803)).toEqual(['’']);
    expect(isGsm7(toGsm7(VA_50803))).toBe(true);
  });

  it('changes exactly one character and nothing else', () => {
    const out = toGsm7(VA_50803);
    expect(out).toBe(VA_50803.replace('’', "'"));
    expect(out.length).toBe(VA_50803.length);
  });

  it('fits in one segment afterwards', () => {
    // 160 for GSM-7, 70 for UCS-2. The body is ~140 characters: one segment or
    // three, decided entirely by that apostrophe.
    const out = toGsm7(VA_50803);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(isGsm7(out)).toBe(true);
  });
});

describe('what a model emits by habit', () => {
  const cases: Array<[string, string]> = [
    ['we’ve', "we've"],
    ['“glasses ready”', '"glasses ready"'],
    ['Mon–Fri', 'Mon-Fri'],
    ['one moment…', 'one moment...'],
    ['9am - 5pm', '9am - 5pm'],
    ['• frame repair', '- frame repair'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(toGsm7(input)).toBe(expected);
    });
  }
});

describe('what it must NOT touch', () => {
  it('keeps accented names exactly as written', () => {
    // These are all in GSM-7. Mangling a patient's name to save a segment is a
    // worse bug than the one being fixed.
    for (const name of ['José', 'está', 'Müller', 'Öberg', 'Añez', 'Sørensen']) {
      expect(toGsm7(name)).toBe(name);
    }
  });

  it('leaves an already-clean message byte-identical', () => {
    const clean = 'Hi Wayne, your glasses are ready for pickup at Eastvale.';
    const r = sanitizeForSms(clean);
    expect(r.changed).toBe(false);
    expect(r.value).toBe(clean);
    expect(r.remaining).toEqual([]);
  });

  it('reports rather than deletes what it cannot map faithfully', () => {
    // An emoji has no GSM-7 equivalent. Dropping it would change the message
    // silently; the caller is told instead and can decide.
    const r = sanitizeForSms('glasses ready 👓');
    expect(r.remaining.length).toBeGreaterThan(0);
    expect(r.value).toContain('👓');
  });

  it('handles empty and undefined without throwing', () => {
    expect(toGsm7('')).toBe('');
    expect(toGsm7(undefined as unknown as string)).toBe(undefined as unknown as string);
    expect(nonGsm7Characters('')).toEqual([]);
  });
});

describe('the GSM-7 set itself', () => {
  it('accepts the characters a ticket description actually uses', () => {
    expect(
      isGsm7("Patient's glasses broke at the hinge; needs repair. Call back: 845-531-7471."),
    ).toBe(true);
  });

  it('knows the extension characters are legal', () => {
    expect(isGsm7('[]{}\\~^|€')).toBe(true);
  });
});
