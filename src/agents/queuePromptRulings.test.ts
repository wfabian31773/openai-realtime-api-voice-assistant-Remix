/**
 * src/agents/queuePromptRulings.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY OPERATOR RULING STILL IN THE PROMPT, AFTER THE TRIM.
 *
 * Task #25 shortens the queue prompts for Grok, whose vendor guidance is
 * explicit: "Simplify the system prompt... Remove workaround prompting —
 * strip instructions that exist only to paper over the previous model's bugs."
 *
 * The danger in doing that is not subtle. These prompts carry rulings the
 * operator paid for with real calls — nobody is told to call back, there is no
 * transfer on this line, the callback number comes before the ticket — and a
 * trim that quietly drops one costs exactly what the ruling was bought with.
 *
 * So the rulings are asserted here as BEHAVIOUR THE PROMPT MUST STILL EXPRESS,
 * matched loosely on meaning rather than on a sentence. A regex on one phrasing
 * would be routed around by rewording, and rewording is the one thing a
 * language model — or an agent trimming a prompt — does reliably.
 */
import { describe, it, expect, vi } from 'vitest';

// Hoisted: ES imports are evaluated before plain statements, and the agent
// modules validate the environment at import time. A bare assignment here runs
// too late and every case fails with "DATABASE_URL: Required". Nothing
// connects — the value only has to exist.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildSurgeryPrompt } from './surgeryAgent';
import { buildTechPrompt } from './techAgent';

/** One ruling, and the several ways a prompt might legitimately word it. */
interface Ruling {
  /** Where it came from, so a failure is traceable to the call that bought it. */
  readonly source: string;
  /** Every alternative must appear (AND); each alternative is a set of
   *  case-insensitive substrings of which ANY may match (OR). */
  readonly requires: readonly (readonly string[])[];
}

const SHARED: readonly Ruling[] = [
  {
    source: 'Standing instruction 10 (2026-08-13) — nobody is told to call back',
    requires: [
      ['wrong number', 'wrong extension', 'wrong department'],
      ['never say', 'do not say', "don't say"],
    ],
  },
  {
    source: 'Standing instruction 9 (2026-08-12) — no transfer on this line',
    requires: [['transfer'], ['not able to transfer', 'cannot transfer', 'no way to do it', 'never say you will put them through']],
  },
  {
    source: 'Standing instruction 7 — capability boundary, file a ticket instead',
    requires: [['call you back', 'callback', 'call back']],
  },
  {
    source: 'Standing instruction 12 — confirm the callback number BEFORE filing',
    requires: [['before you file', 'before the ticket', 'BEFORE you file']],
  },
  {
    source: 'Operator, 2026-08-13 — never ask a patient where our offices are',
    requires: [['never ask', 'do not ask'], ['office', 'city']],
  },
  {
    source: 'Medical safety — no diagnosis, no medication advice (#53: the prompt IS the guardrail on queue lanes)',
    requires: [['medical advice', 'do not give medical', 'not tell anyone whether']],
  },
  {
    source: 'Voice channel — nothing spoken may contain markup',
    requires: [['markdown', 'asterisk', 'bullet']],
  },
  {
    source: 'Never invent a detail on a ticket',
    requires: [['do not guess', "don't guess", 'never file a ticket with a detail you invented', 'do not invent']],
  },
  {
    source: 'A tool asking for a field is not a fault to narrate at the caller',
    requires: [['technical problem', 'system issue', 'not a fault']],
  },
];

const SURGERY_ONLY: readonly Ruling[] = [
  {
    source: 'Emergency handling — curtain/shadow/flashes/severe pain go to 911',
    requires: [['911', 'emergency care'], ['urgent']],
  },
  {
    source: 'This queue is ASSIGNED BY SURGEON (2026-08-17: 66 of 74 filed unrouted)',
    requires: [['surgeon']],
  },
  {
    source: 'Do NOT pass last_provider — it is often the optometrist, and it overrides the record',
    requires: [['last_provider']],
  },
];

const TECH_ONLY: readonly Ruling[] = [
  {
    source: 'Running out of glaucoma drops is not routine',
    requires: [['glaucoma']],
  },
];

function check(prompt: string, rulings: readonly Ruling[], label: string) {
  describe(label, () => {
    for (const ruling of rulings) {
      it(`still expresses: ${ruling.source}`, () => {
        const hay = prompt.toLowerCase();
        for (const alternatives of ruling.requires) {
          const hit = alternatives.some((a) => hay.includes(a.toLowerCase()));
          expect(hit, `none of ${JSON.stringify(alternatives)} appear in the prompt`).toBe(true);
        }
      });
    }
  });
}

const surgery = buildSurgeryPrompt({ callerPhone: '+17605551234' });
const tech = buildTechPrompt({ callerPhone: '+17605551234' });

check(surgery, [...SHARED, ...SURGERY_ONLY], 'surgery prompt keeps every ruling');
check(tech, [...SHARED, ...TECH_ONLY], 'tech prompt keeps every ruling');

describe('the trim actually happened', () => {
  /**
   * A ceiling, not a target. Surgery was ~2,636 prompt tokens on 2026-09-03
   * with `# HOW A CALL RUNS` alone running 87 of its 158 lines — six times
   * tech's version of the same section. If it creeps back, this fails and
   * somebody has to justify it rather than discovering it a fortnight later.
   */
  it('surgery stays under 1,800 prompt tokens', () => {
    expect(Math.round(surgery.length / 4)).toBeLessThan(1800);
  });

  it('tech stays under 1,600 prompt tokens', () => {
    expect(Math.round(tech.length / 4)).toBeLessThan(1600);
  });

  it('neither prompt carries a war story — those belong in code comments', () => {
    // "a war story is not an instruction" — surgeryAgent.ts's own comment,
    // written while the prompt beside it carried three.
    for (const [name, p] of [['surgery', surgery], ['tech', tech]] as const) {
      expect(p, `${name} still cites a dated incident`).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
      expect(p, `${name} still quotes a call count`).not.toMatch(/\b\d+ of \d+ filed\b/);
    }
  });
});
