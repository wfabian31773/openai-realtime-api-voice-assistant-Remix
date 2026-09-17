/**
 * WE NEVER SPEAK A CALLBACK NUMBER WE DO NOT HAVE.
 *
 * Two sentences reached real callers on 2026-09-16, both from the same shape:
 *
 *   "The number ending in ."                               (pcp, three times in one call)
 *   "Is this number ending in \"mous\" the best one to reach you?"   (no-ivr, CA…8d536d6646)
 *
 * The second is the one that explains both. **A withheld or blocked caller ID
 * does not arrive as an empty string — it arrives as a WORD.** So a call site
 * guarding on `callerPhone ? … : …` passes the guard, and `"anonymous".slice(-4)`
 * is `"mous"`. Strip the non-digits first and you get `""` instead, which is the
 * first sentence: the template renders and the agent says "ending in .".
 *
 * `formatPhoneLast4` already stripped non-digits and returned `''`, and that is
 * precisely the trap — an empty string reads as a VALUE at a template call site.
 * `speakableLast4` returns `null`, which cannot be interpolated silently and
 * forces the call site to carry the other branch.
 *
 * THE OTHER BRANCH IS ALWAYS "ASK THEM". Standing instruction 12: confirm the
 * callback number BEFORE filing. A caller who says "yes" to a number nobody
 * holds produces a request that cannot be called back, which is the single
 * outcome that confirmation exists to prevent.
 *
 * TEN DIGITS, NOT FOUR. Four was enough to stop `formatPhoneLast4` rendering an
 * empty string and is not enough to stop it rendering a short code, an
 * extension or a partial ANI — none of which can be rung back.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { speakableLast4, formatPhoneLast4 } from './timeAware';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.OPENAI_API_KEY ??= 'sk-test';

describe('speakableLast4', () => {
  it('gives the last four of a real number', () => {
    expect(speakableLast4('+15623367527')).toBe('7527');
    expect(speakableLast4('562-336-3618')).toBe('3618');
    expect(speakableLast4('9093318731')).toBe('8731');
  });

  /** The two live failures, by the exact values that produced them. */
  it('refuses the caller IDs that actually broke, rather than slicing them', () => {
    expect(speakableLast4('anonymous'), 'this is where "mous" came from').toBeNull();
    expect(speakableLast4('unavailable')).toBeNull();
    expect(speakableLast4('restricted')).toBeNull();
    expect(speakableLast4('')).toBeNull();
    expect(speakableLast4(undefined)).toBeNull();
    expect(speakableLast4(null)).toBeNull();
  });

  it('refuses anything too short to ring back', () => {
    expect(speakableLast4('911')).toBeNull();
    expect(speakableLast4('40404')).toBeNull(); // a short code
    expect(speakableLast4('336-3618')).toBeNull(); // no area code
    expect(speakableLast4('123456789')).toBeNull(); // nine digits
    expect(speakableLast4('1234567890')).toBe('7890'); // ten is the floor
  });

  /**
   * The contrast that names the bug. `formatPhoneLast4` is NOT changed — other
   * call sites use it and it is honest about what it does — but it answers a
   * string for input no human could be called back on, and a template will
   * happily print that.
   */
  it('differs from formatPhoneLast4 exactly where the bug lived', () => {
    expect(formatPhoneLast4('anonymous')).toBe('');
    expect(speakableLast4('anonymous')).toBeNull();
    expect(`ending in ${formatPhoneLast4('anonymous')}.`).toBe('ending in .');
  });
});

describe('no call site can speak a number it does not have', () => {
  /**
   * Read from source. These are prompt STRINGS built inside functions with
   * large dependency graphs, and what matters is that no site slices a phone
   * without the guard — which is a property of the text, not of one return
   * value. The device `ticketRequirements.test.ts` already uses.
   */
  const FILES = [
    'src/config/knowledgeBase.ts',
    'src/services/rampEngine.ts',
    'src/agents/azulSchedulingPrompt.ts',
  ];

  let sources: Record<string, string>;
  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    sources = Object.fromEntries(
      FILES.map((f) => [f, readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')]),
    );
  });

  it('no file reaches for the last four digits without the guard', () => {
    for (const [file, src] of Object.entries(sources)) {
      // `.slice(-4)` on anything phone-shaped is the banned move. The guard
      // returns the slice itself, so a legitimate use never needs to write it.
      const raw = src.match(/\w*[Pp]hone\w*(?:\.replace\([^)]*\))?\.slice\(-4\)/g) ?? [];
      expect(raw, `${file} slices a phone number directly: ${raw.join(', ')}`).toEqual([]);
      const cb = src.match(/\bcb\.slice\(-4\)/g) ?? [];
      expect(cb, `${file} slices a raw callback number`).toEqual([]);
    }
  });

  it('every file that offers a number to confirm imports the guard', () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, `${file} does not import speakableLast4`).toMatch(
        /import \{[^}]*speakableLast4[^}]*\} from/,
      );
    }
  });

  /**
   * The branch is what makes the guard worth having. Swapping the helper in
   * WITHOUT it would have turned "ending in ." into "ending in null", which is
   * worse — so each site must fall through to asking.
   */
  it('each site falls through to ASKING for the number', () => {
    expect(sources['src/config/knowledgeBase.ts']).toMatch(
      /You will need to ask for their callback number/,
    );
    expect(sources['src/config/knowledgeBase.ts']).toMatch(
      /Ask: "What is the best number to reach you\?"/,
    );
    expect(sources['src/services/rampEngine.ts']).toMatch(/: RAMP_LINES\.collectCallback/);
    expect(sources['src/agents/azulSchedulingPrompt.ts']).toMatch(
      /Ask the caller for the best number to reach them/,
    );
  });
});
