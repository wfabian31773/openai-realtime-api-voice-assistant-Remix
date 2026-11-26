/**
 * The Openings panel shows greetings, never a caller's name. Synthetic names
 * only; the shapes are the agents' real first lines (2026-11-26: 111 of 113
 * NPX outreach first lines in 7 days named a patient).
 */
import { describe, expect, it } from 'vitest';
import { MIN_OPENING_REPEATS, aggregateOpenings, maskOpening } from './openingMask';

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

  it('masks a name in lower case, and a name behind a title (Codex review of #525)', () => {
    expect(maskOpening('Hello, testa lake.')).toBe('Hello, [name].');
    expect(maskOpening('hi testa, this is Azul Vision.')).toBe('hi [name], this is Azul Vision.');
    expect(maskOpening('hola maría.')).toBe('hola [name].');
    expect(maskOpening('May I speak with Mrs. Lake?')).toBe('May I speak with [name]?');
    expect(maskOpening('Am I speaking with Dr. Testa Lake?')).toBe('Am I speaking with [name]?');
    expect(maskOpening('Hello, Mrs. Lake.')).toBe('Hello, [name].');
    expect(maskOpening('¿Hablo con la Sra. Lake?')).toBe('¿Hablo con [name]?');
    for (const out of ['Hello, testa lake.', 'May I speak with Mrs. Lake?', '¿Hablo con la Sra. Lake?'].map(maskOpening)) {
      expect(out).not.toMatch(/testa|lake/i);
    }
  });

  it('masks a name followed by no punctuation (Codex review of #525)', () => {
    expect(maskOpening('Hello, Testa how can I help you today?')).toBe('Hello, [name]?');
    expect(maskOpening('Hi testa lake this is Azul Vision.')).toBe('Hi [name].');
  });

  it('leaves a greeting with no name in it alone', () => {
    for (const line of [
      'Hello, this is an automated assistant calling for Azul Vision. This call is recorded.',
      'Hello, thank you for calling Azul Vision. This is an automated assistant.',
      'Thank you for calling Azul Vision PCP Support. How can I help you today?',
      'Good afternoon. Thank you for calling Azul Vision.',
      'Hi there!',
      'Good morning, everyone.',
      'Hola, buenos días.',
      'Hey, how are you?',
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
    const map = aggregateOpenings([{ agent_slug: 'optical', opening: `${'x'.repeat(100)} Am I speaking with Testalake?`, n: 3 }], 125);
    expect(map.get('optical')?.[0].opening).not.toMatch(/Testa/);
  });

  it('never sends an opening only one or two calls share, whatever it says', () => {
    // A line the patterns miss still belongs to one caller; the repeat floor holds it back.
    const map = aggregateOpenings([
      { agent_slug: 'npx-outreach', opening: 'Thank you for calling, Testa, we have news about your visit.', n: 1 },
      { agent_slug: 'npx-outreach', opening: 'Thank you for calling, Lakey, we have news about your visit.', n: 2 },
      { agent_slug: 'npx-outreach', opening: 'Hello, this is an automated assistant calling for Azul Vision.', n: MIN_OPENING_REPEATS },
    ]);
    expect(map.get('npx-outreach')).toEqual([{ opening: 'Hello, this is an automated assistant calling for Azul Vision.', n: MIN_OPENING_REPEATS }]);
    expect(JSON.stringify([...map.values()])).not.toMatch(/Testa|Lakey/);
  });

  it('counts a greeting once it has been said to enough callers', () => {
    const map = aggregateOpenings([{ agent_slug: 'tech', opening: 'Thank you for calling Azul Vision. How can I help you?', n: 2 },
      { agent_slug: 'tech', opening: 'Thank you for calling Azul Vision. How can I help you?', n: 1 }]);
    expect(map.get('tech')).toEqual([{ opening: 'Thank you for calling Azul Vision. How can I help you?', n: 3 }]);
  });

  it('keeps at most six openings per agent, most common first', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ agent_slug: 'tech', opening: `Opening line number ${i} for the lane`, n: i + 1 }));
    const out = aggregateOpenings(rows).get('tech')!;
    expect(out).toHaveLength(6);
    expect(out[0].n).toBe(8);
  });
});
