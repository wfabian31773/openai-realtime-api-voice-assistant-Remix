/**
 * The Openings panel shows greetings, never a caller's name. Synthetic names
 * only; the shapes are the agents' real first lines (2026-11-26: 111 of 113
 * NPX outreach first lines in 7 days named a patient).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(maskOpening('Hello. Am I reaching Testa Lake?')).toBe('Hello. Am I reaching [name]?');
    expect(maskOpening('Could I speak with Testa?')).toBe('Could I speak with [name]?');
    expect(maskOpening("Hi, I'm calling for Testa Lake.")).toBe("Hi, I'm calling for [name].");
    expect(maskOpening("Hello, I'm trying to reach Testa.")).toBe("Hello, I'm trying to reach [name].");
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

/** n distinct people, each heard it once. */
const ppl = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}`);

describe('aggregateOpenings', () => {
  it('counts many patients greeted by name as one greeting', () => {
    const lead = 'Hello, this is an automated assistant calling for Azul Vision. This call is recorded. May I speak with';
    const map = aggregateOpenings([
      { agent_slug: 'npx-outreach', opening: `${lead} Testa?`, n: 3, people: ['a'] },
      { agent_slug: 'npx-outreach', opening: `${lead} Lakey?`, n: 2, people: ['b'] },
      { agent_slug: 'npx-outreach', opening: `${lead} Rivera Dos?`, n: 1, people: ['c'] },
      { agent_slug: 'pcp', opening: 'Thank you for calling Azul Vision PCP Support. How can I help you today?', n: 9, people: ppl('p', 9) },
    ], 300);
    expect(map.get('npx-outreach')).toEqual([{ opening: `${lead} [name]?`, n: 6 }]);
    expect(map.get('pcp')?.[0].n).toBe(9);
    expect(JSON.stringify([...map.values()])).not.toMatch(/Testa|Lakey|Rivera/);
  });

  it('truncates after masking, so no part of a name survives the cut', () => {
    const map = aggregateOpenings([{ agent_slug: 'optical', opening: `${'x'.repeat(100)} Am I speaking with Testalake?`, n: 3, people: ppl('o', 3) }], 125);
    expect(map.get('optical')?.[0].opening).not.toMatch(/Testa/);
  });

  it('never sends an opening fewer than three people heard, whatever it says', () => {
    // A line the patterns miss still belongs to one caller; the floor holds it back.
    const map = aggregateOpenings([
      { agent_slug: 'npx-outreach', opening: 'Thank you for calling, Testa, we have news about your visit.', n: 1, people: ['a'] },
      { agent_slug: 'npx-outreach', opening: 'Thank you for calling, Lakey, we have news about your visit.', n: 2, people: ['b', 'c'] },
      { agent_slug: 'npx-outreach', opening: 'Hello, this is an automated assistant calling for Azul Vision.', n: MIN_OPENING_REPEATS, people: ppl('d', MIN_OPENING_REPEATS) },
    ]);
    expect(map.get('npx-outreach')).toEqual([{ opening: 'Hello, this is an automated assistant calling for Azul Vision.', n: MIN_OPENING_REPEATS }]);
    expect(JSON.stringify([...map.values()])).not.toMatch(/Testa|Lakey/);
  });

  it('counts people, not calls: one patient called three times is still one person (Codex review of #525)', () => {
    // A wording no pattern catches, said to one patient on three outreach attempts.
    const line = 'Good day. Testa Lake, this is Azul Vision about your visit.';
    const map = aggregateOpenings([{ agent_slug: 'npx-outreach', opening: line, n: 3, people: ['one-patient'] }]);
    expect(map.get('npx-outreach')).toEqual([]);
    expect(JSON.stringify([...map.values()])).not.toMatch(/Testa|Lake/);
  });

  it('a row that lists nobody counts nobody, and a call with no number is nobody', () => {
    const map = aggregateOpenings([{ agent_slug: 'tech', opening: 'Thank you for calling Azul Vision. How can I help you?', n: 50 }]);
    expect(map.get('tech')).toEqual([]);
    const noNumbers = aggregateOpenings([
      { agent_slug: 'tech', opening: 'Thank you for calling Azul Vision. How can I help you?', n: 3, people: ['a', 'b', null] as unknown as string[] },
    ]);
    expect(noNumbers.get('tech')).toEqual([]);
  });

  it('counts a greeting once enough different people have heard it', () => {
    const line = 'Thank you for calling Azul Vision. How can I help you?';
    const map = aggregateOpenings([
      { agent_slug: 'tech', opening: line, n: 2, people: ['a', 'b'] },
      { agent_slug: 'tech', opening: line, n: 1, people: ['b'] },
    ]);
    // Two people only (b twice): held back.
    expect(map.get('tech')).toEqual([]);
    const map3 = aggregateOpenings([
      { agent_slug: 'tech', opening: line, n: 2, people: ['a', 'b'] },
      { agent_slug: 'tech', opening: line, n: 1, people: ['c'] },
    ]);
    expect(map3.get('tech')).toEqual([{ opening: line, n: 3 }]);
  });

  it('keeps at most six openings per agent, most common first', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ agent_slug: 'tech', opening: `Opening line number ${i} for the lane`, n: i + 3, people: ppl(`t${i}-`, i + 3) }));
    const out = aggregateOpenings(rows).get('tech')!;
    expect(out).toHaveLength(6);
    expect(out[0].n).toBe(10);
  });

  it('the panel query lists who heard each opening by a hash of the far end, never the number', () => {
    const src = readFileSync(join(__dirname, 'queries.ts'), 'utf8');
    expect(src).toContain(`md5(CASE WHEN cl.direction = 'outbound' THEN cl."to" ELSE cl."from" END)`);
    expect(src).toContain('AS people');
  });
});
