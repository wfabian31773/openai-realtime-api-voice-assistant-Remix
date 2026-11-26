/**
 * The Openings panel shows greetings, never a caller's name. Synthetic names
 * only; the shapes are the agents' real first lines (2026-11-26: 111 of 113
 * NPX outreach first lines in 7 days named a patient).
 */
import { describe, expect, it } from 'vitest';
import { aggregateOpenings, maskOpening } from './openingMask';

describe('maskOpening', () => {
  it('masks the name the named greeting asks for, on every lane', () => {
    expect(maskOpening('Thank you for calling Azul Vision. This call is recorded. Am I speaking with Testa?')).toBe(
      'Thank you for calling Azul Vision. This call is recorded. Am I speaking with [name]?',
    );
    expect(maskOpening('Hello, this is an automated assistant calling for Azul Vision. May I speak with Testa Lake?')).toBe(
      'Hello, this is an automated assistant calling for Azul Vision. May I speak with [name]?',
    );
    expect(maskOpening('May I please speak with Mary-Ann O’Lake? [interrupted]')).toBe('May I please speak with [name]? [interrupted]');
    expect(maskOpening('¿Hablo con Testa Lake?')).toBe('¿Hablo con [name]?');
  });

  it('masks a name the truncation would otherwise have cut in half', () => {
    expect(maskOpening('Am I speaking with Testalakeverylongname')).toBe('Am I speaking with [name]');
  });

  it('masks a greeting that addresses the caller by name', () => {
    expect(maskOpening('Hello, Testa. Thank you for calling Azul Vision.')).toBe('Hello, [name]. Thank you for calling Azul Vision.');
    expect(maskOpening('Hi Testa Lake, this is Azul Vision.')).toBe('Hi [name], this is Azul Vision.');
  });

  it('leaves a greeting with no name in it alone', () => {
    for (const line of [
      'Hello, this is an automated assistant calling for Azul Vision. This call is recorded.',
      'Hello, thank you for calling Azul Vision. This is an automated assistant.',
      'Thank you for calling Azul Vision PCP Support. How can I help you today?',
      'Good afternoon. Thank you for calling Azul Vision.',
      'Thank you for calling Azul Vision. May I have your first and last name?',
    ]) {
      expect(maskOpening(line)).toBe(line);
    }
  });
});

describe('aggregateOpenings', () => {
  it('counts many patients greeted by name as one greeting', () => {
    const lead = 'Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with';
    const map = aggregateOpenings([
      { agent_slug: 'npx-outreach', opening: `${lead} Testa?`, n: 3 },
      { agent_slug: 'npx-outreach', opening: `${lead} Lakey?`, n: 2 },
      { agent_slug: 'npx-outreach', opening: `${lead} Rivera Dos?`, n: 1 },
      { agent_slug: 'pcp', opening: 'Thank you for calling Azul Vision PCP Support. How can I help you today?', n: 9 },
    ], 300);
    expect(map.get('npx-outreach')).toEqual([{ opening: `${lead} [name]?`, n: 6 }]);
    expect(map.get('pcp')?.[0].n).toBe(9);
    expect(JSON.stringify([...map.values()])).not.toMatch(/Testa|Lakey|Rivera/);
  });

  it('truncates after masking, so no part of a name survives the cut', () => {
    const map = aggregateOpenings([{ agent_slug: 'optical', opening: `${'x'.repeat(100)} Am I speaking with Testalake?`, n: 1 }], 125);
    expect(map.get('optical')?.[0].opening).not.toMatch(/Testa/);
  });

  it('keeps at most six openings per agent, most common first', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ agent_slug: 'tech', opening: `Opening line number ${i} for the lane`, n: i + 1 }));
    const out = aggregateOpenings(rows).get('tech')!;
    expect(out).toHaveLength(6);
    expect(out[0].n).toBe(8);
  });
});
