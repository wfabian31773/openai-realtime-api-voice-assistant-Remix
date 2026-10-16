/**
 * v97 — THE FILING LINE IS NOT A STAGE DIRECTION.
 *
 * All four queue prompts told the model to say "Let me get this logged for you
 * — one moment." and then "file quietly". grok-voice-2.0 read that as an
 * instruction. grok-voice-3.0, run offline against these exact bound prompts
 * and tools on 2026-10-16, SPOKE it: "Quietly filing." / "Filing quietly." on
 * 15 of 62 simulated calls (and 19 of 92 across every batch), against 0 on
 * 2.0. With the line reworded to "call the filing tool straight away. Say
 * nothing else until it answers.", the same harness produced it on 0 of 29.
 *
 * 2.0 behaves the same either way, so the rewording is safe today and is
 * what makes the 3.0 canary safe to switch on. Asserted on the BUILT prompts,
 * because that is what the model reads.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildTechPrompt } from './techAgent';
import { buildSurgeryPrompt } from './surgeryAgent';
import { buildOpticalPrompt } from './opticalAgent';
import { buildRecordsPrompt } from './recordsAgent';

const meta = { callerPhone: '+17605551234' };
const PROMPTS: Record<string, string> = {
  tech: buildTechPrompt(meta),
  surgery: buildSurgeryPrompt(meta),
  optical: buildOpticalPrompt(meta),
  records: buildRecordsPrompt(meta),
};

describe.each(Object.keys(PROMPTS))('%s — the filing line', (lane) => {
  const p = PROMPTS[lane]!;

  it('never hands the model an adverb it can speak as a line', () => {
    expect(p).not.toMatch(/file\s+quietly/i);
    expect(p).not.toMatch(/\bquietly\b/i);
  });

  it('still says the line first and then files, saying nothing else until the tool answers', () => {
    const line = p.indexOf('Let me get this logged for you');
    const tool = p.search(/call the\s+filing tool straight away/);
    expect(line, 'the filler line is missing').toBeGreaterThan(-1);
    expect(tool, 'the filing instruction is missing').toBeGreaterThan(-1);
    expect(tool, 'the filing instruction comes before the line it follows').toBeGreaterThan(line);
    expect(p.slice(tool, tool + 160)).toMatch(/saying\s+nothing else until it answers|Say nothing else until\s+it answers/);
  });
});
