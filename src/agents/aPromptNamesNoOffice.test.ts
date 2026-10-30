/**
 * NO QUEUE PROMPT QUOTES A SAMPLE OFFICE (v151).
 *
 * Found on the operator's pack-01 A1 test call, 2026-10-29
 * (`CAe121c3c176d626e8a679536788e58d63`, optical): no patient record was
 * found, and the agent still offered "our Redlands office". Redlands came from
 * the prompt, not from any tool. Optical's step 2 quoted it as a worked example
 * (*"I have you at our Redlands office, is that where you'd like to pick them
 * up?"*), and tech and records quoted Encinitas the same way. A model given
 * an example sentence with a real office in it will say that office.
 *
 * The rule now lives in the words instead of in an example: offer the office
 * a tool returned, as a yes/no, and never name an office no tool gave you. The
 * practice's office list still reaches the model through the knowledge pack,
 * which the runtime appends as Business Facts; what is pinned here is the
 * lane's OWN text, the part a lane author writes.
 *
 * Both arms are built, cold and recognised, because the recognised arm carries
 * its own blocks and a sample office could hide in either.
 */
import { describe, it, expect, vi } from 'vitest';

// Hoisted: the agent modules validate the environment at import time.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { AZUL_VISION_LOCATIONS } from '../config/azulVisionKnowledge';
import { buildOpticalPrompt } from './opticalAgent';
import { buildTechPrompt } from './techAgent';
import { buildRecordsPrompt } from './recordsAgent';
import { buildSurgeryPrompt } from './surgeryAgent';

const OFFICES = AZUL_VISION_LOCATIONS.map((l) => l.name);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const officesNamedIn = (text: string) =>
  OFFICES.filter((name) => new RegExp(`\\b${escape(name)}\\b`).test(text));

const COLD = { callerPhone: '+17605551234' } as never;
const WARM = {
  callerPhone: '+17605551234',
  precontext: { matched: true, firstName: 'Casey' },
} as never;

const LANES = [
  ['optical', buildOpticalPrompt],
  ['surgery', buildSurgeryPrompt],
  ['tech', buildTechPrompt],
  ['records', buildRecordsPrompt],
] as const;

describe('no queue prompt names an office of its own accord', () => {
  it('the office list it checks against is the practice list, not empty', () => {
    // Without this an empty list would make every assertion below pass.
    expect(OFFICES.length).toBeGreaterThan(20);
    expect(OFFICES).toEqual(expect.arrayContaining(['Covina', 'Encinitas', 'Redlands']));
  });

  for (const [lane, build] of LANES) {
    it(`${lane}: neither arm quotes an office by name`, () => {
      expect(officesNamedIn(build(COLD))).toEqual([]);
      expect(officesNamedIn(build(WARM))).toEqual([]);
    });
  }

  for (const [lane, build] of [
    ['optical', buildOpticalPrompt],
    ['tech', buildTechPrompt],
    ['records', buildRecordsPrompt],
  ] as const) {
    it(`${lane}: says in words never to name an office no tool gave it`, () => {
      expect(build(COLD)).toMatch(/Never\s+name\s+an\s+office\s+no\s+tool\s+gave\s+you/);
    });
  }

  it('optical still confirms the office on the record rather than assuming it', () => {
    expect(buildOpticalPrompt(COLD)).toMatch(/confirm it rather than assuming/);
  });
});
