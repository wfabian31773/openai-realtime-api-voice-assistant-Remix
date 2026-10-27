import { describe, expect, it } from 'vitest';
import { currentClinicName } from './azulVisionKnowledge';
import { PHREESIA_CONFIG } from './phreesiaConfig';

describe('retired clinic display names', () => {
  it.each([
    ['North Valley Eye', 'Mission Hills'],
    ['Our North Valley Eye office', 'Mission Hills'],
    ['Azul Vision Magan', 'Covina'],
  ])('displays %s as %s', (label, current) => {
    expect(currentClinicName(label)).toBe(current);
  });

  it.each(['constructor', 'hasOwnProperty', 'toString', 'Unknown Office'])(
    'passes unknown label %s through as a string', (label) => {
      expect(currentClinicName(label)).toBe(label);
    },
  );

  it('advertises both current names in scheduling', () => {
    expect(PHREESIA_CONFIG.locations).toContain('Mission Hills');
    expect(PHREESIA_CONFIG.locations).toContain('Covina');
    expect(PHREESIA_CONFIG.locations).not.toContain('North Valley Eye');
    expect(PHREESIA_CONFIG.locations).not.toContain('Magan');
  });
});
