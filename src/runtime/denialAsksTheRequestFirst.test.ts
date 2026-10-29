/**
 * A CALLER WHO SAYS "NO" TO "AM I SPEAKING WITH <NAME>?" IS ASKED WHAT THEY
 * NEED BEFORE ANY NAME OR DATE OF BIRTH — v140.
 *
 * THE CORPUS (RULE THREE). Queue lanes (optical, surgery, tech, records),
 * 2026-10-20..10-28, substantive calls (duration >= 30) whose greeting asked
 * "Am I speaking with <name>?": when the caller denied it and the agent's next
 * line asked for a LAST NAME, 116 calls, 84 filed (72.4%). Read one by one, the
 * caller is often not the patient at all — a daughter, a caregiver, a pharmacy,
 * a provider's office — and the agent asks for THEIR surname and THEIR date of
 * birth before it knows why they rang. Over the same seven business days, 41
 * heard callers (tech 18, surgery 14, optical 9) hung up on an identity
 * question with nothing filed.
 *
 * The block said, on a denial, only "this number matched the WRONG person. Use
 * what THEY said and ignore this block", and the ask script beside it says to
 * use the last-name and date-of-birth questions exactly when the block no
 * longer applies. So the model went straight from "No." to "May I please have
 * your last name?" — the next line in the prompt — every time.
 *
 * The real calls, by SID (synthetic shapes only; the words stay in call_logs):
 *
 *   CAdba5d17b4aacc14cc33da33429e00abb  surgery 10-28  "No — his daughter": asked HER last name and date of birth; hung up
 *   CA130c8bb5b1fb3294d80dbec943717bf2  surgery 10-28  bare "No": asked a surname, then a date of birth; hung up
 *   CAe7d3ec955dd6b1f827e135e2a1d795a7  surgery 10-28  "No": asked a surname; caller wanted customer service; hung up
 *   CA700dc8e7ef74390c2a9c2953984d9919  surgery 10-28  denial, then "May I please have your last name?"; hung up
 *   CA3cc08627b4a9b9b7e7f7be1ab39ac1bd  tech    10-28  a PHARMACY asked for its last name, twice; hung up
 *   CA643068264f31ff60a0ce1f7ca2256fbc  tech    10-28  "No": asked a surname; asked for a person; hung up
 *   CA9844b9f1e3d00b302978ab70f1acc1d1  surgery 10-21  "No, the provider": a PROVIDER asked for their own surname and DOB
 *   CA419f06ecd50694b1b56c8e38887fbf8e  surgery 10-21  "No, the caregiver": the caregiver spelled their OWN surname for 150s
 *   CA54bb2a223cb794118c335ddafff52248  surgery 10-21  "No": surname, then the DOB ask; dead air
 *   CA463dffff479551083f8fecfd71fa1646  surgery 10-23  "No": surname; asked for a provider; hung up
 *   CA77dcc1cb218d129b0abe3c83c4646482  surgery 10-23  "No": surname; hung up on that question
 *   CAb98bdc9677ba9b2418a2682478a52456  optical 10-23  "No": surname, then the DOB ask; hung up
 *   CA7662c60fc374f715d9eb67262e3bfbf5  tech    10-22  "No": surname; asked for an attendant; hung up
 *   CAc9455b635cb729ca7d877375ecf5044c  surgery 10-22  "No": surname; asked for a representative four times
 *   CA61e4a31ce0a5bf7b18d5a38540517ce8  tech    10-27  "No": surname, then the DOB ask; hung up
 *
 * WHAT IT CANNOT PROVE OFFLINE, said plainly: a prompt change is tested here as
 * the instruction the model is given, on the real built prompt of every lane.
 * Whether the model now asks the request first is the after-number — denials
 * whose next agent line is a last-name question, 116 in seven business days,
 * target ~0 — and the filing rate of those calls, 72.4%, target the ~90% of
 * recognised calls that are not denied.
 */
import { describe, expect, it, vi } from 'vitest';

// The agents reach server/db, which validates the environment at import. CI
// sets no credentials (ci.yml), so the placeholder goes in before the imports.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { buildOpticalPrompt } from '../agents/opticalAgent';
import { buildRecordsPrompt } from '../agents/recordsAgent';
import { buildSurgeryPrompt } from '../agents/surgeryAgent';
import { buildTechPrompt } from '../agents/techAgent';
import { recognisedCallerBlock } from './recognisedCallerBlock';

const BLOCK = recognisedCallerBlock({ matched: true, firstName: 'Casey' });

/** The denial bullet alone, from "- If they said NO" to the next bullet. */
function denialBullet(text: string): string {
  const start = text.indexOf('- If they said NO');
  expect(start, 'the denial bullet is missing').toBeGreaterThan(-1);
  const next = text.indexOf('\n- ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('a denied greeting asks the request before identity', () => {
  const bullet = denialBullet(BLOCK);

  it('still discards the match: a phone number is a candidate, not an identity', () => {
    expect(bullet).toMatch(/WRONG\s+person/);
    expect(bullet).toMatch(/ignore the rest of this block/);
  });

  it('gives the request-first instruction BEFORE it discards the block (Codex P1, #397)', () => {
    // A model reading in order that meets "ignore this block" first can drop
    // everything after it, the instruction included — the v29 shape, an
    // exception stated after the prohibition it excepts.
    const ask = bullet.search(/Ask how you\s+can help BEFORE/);
    const discard = bullet.search(/ignore the rest of this block/);
    expect(ask).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(ask);
  });

  it('asks how it can help BEFORE any name or date of birth', () => {
    expect(bullet).toMatch(/Ask how you\s+can help BEFORE any name or date of birth/);
  });

  it('says why: the caller is often calling for the patient', () => {
    expect(bullet).toMatch(/calling for the\s+patient/);
  });

  it("takes the PATIENT's details, and the caller's own only when the call is about them (Codex P2, #397)", () => {
    // A shared or reassigned number: "No, this is Rosa" may be Rosa calling
    // about herself, and then her details ARE the patient's.
    expect(bullet).toMatch(/the PATIENT's details: theirs only\s+if the call is about them/);
    expect(bullet).not.toMatch(/details, not theirs/);
  });

  it('a yes is untouched: still no surname and no date of birth after an affirmed greeting', () => {
    expect(BLOCK).toContain('Do not ask for their last name');
    expect(BLOCK).toContain('do not ask for their date of birth');
  });
});

describe('every lane that composes the block carries the rule on its real built prompt', () => {
  const meta = { callerPhone: '+17605551234', precontext: { matched: true, firstName: 'Casey' } } as never;
  const cold = { callerPhone: '+17605551234' } as never;

  for (const [lane, build] of [
    ['optical', buildOpticalPrompt],
    ['surgery', buildSurgeryPrompt],
    ['tech', buildTechPrompt],
    ['records', buildRecordsPrompt],
  ] as const) {
    it(`${lane}: the recognised prompt asks the request first on a denial`, () => {
      expect(denialBullet(build(meta))).toMatch(/Ask how you\s+can help BEFORE any name or date of birth/);
    });

    it(`${lane}: an unrecognised caller's prompt carries no block and no denial rule`, () => {
      expect(build(cold)).not.toContain('- If they said NO');
    });
  }
});
