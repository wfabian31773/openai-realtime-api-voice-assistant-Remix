/**
 * src/runtime/markerCarriesClaim.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Every sentence in CLAUDE.md that says which version `main` CARRIES must name
 * the version this build's marker actually carries.
 *
 * WHY THIS EXISTS, and it is the same merge artifact `markerTableIsIntact`
 * guards one claim to the left. That file pins the "IS THE NEWEST" sentence
 * against the constant, and nothing pinned the sentence beside it. So on
 * 2026-09-24, with the constant reading v70, `main` simultaneously said:
 *
 *   "v70 IS THE NEWEST, v69 IS WHAT `main` CARRIES SINCE #325 MERGED"
 *   "v67 (#326) IS WHAT `main` CARRIES (merged 2026-09-24, `a5815ca`)"
 *
 * — one generation stale and two generations stale, in the same file, both
 * confidently formatted, and the suite was green. CLAUDE.md's own count says
 * this claim has now arrived on `main` wrong FIVE times out of seven
 * corrections, every time for the same structural reason: the branch that
 * writes the sentence cannot know it will be the last to land, so its own
 * prose is correct when written and stale the moment it merges.
 *
 * WHY IT IS A CLAIM-AGREEMENT TEST AND NOT A COUNT. Requiring exactly one such
 * sentence was the first instinct and it is the wrong control: the file
 * legitimately restates the fact inside a marker row's own context, where a
 * reader who lands there has no reason to scroll to the table. What must hold
 * is not that the fact is stated once, but that every statement of it agrees —
 * and agreement is checkable against the constant, which is the one thing in
 * the repo that cannot be stale about itself.
 *
 * WHY THE PATTERN NEEDS THE VERB. A first version matched the bare phrase and
 * looked BACK for the nearest version token, and a mutation caught it grading
 * a sentence that is not a claim at all ("THE NEWEST MARKER AND WHAT `main`
 * CARRIES ARE ONE NUMBER") on whichever version happened to precede it. The
 * pattern now requires the assertive form, `v<N> … IS WHAT \`main\` CARRIES`,
 * so the version it grades is the version the sentence itself names.
 *
 * AND WHY A QUOTED EXAMPLE IS NOT MISTAKEN FOR A CLAIM: the correction list
 * quotes the stale sentences verbatim inside a code span (`v58 IS WHAT main
 * CARRIES`), and markdown backticks do not nest, so a quoted claim cannot
 * carry the backticked `main` this pattern requires.
 *
 * ONE MUTATION GOES RED THERE AND IS KEPT RATHER THAN DESIGNED AROUND: taking
 * that quote OUT of its code span and giving `main` backticks fails this test
 * on v58. That is not a false positive worth engineering away — an unquoted
 * historical example reads to a skimming human exactly the way it reads to
 * this pattern, as a present-tense claim, which is the confusion the whole
 * guard exists to prevent. The red says keep the quote quoted.
 *
 * WHAT IT CANNOT DO, stated rather than implied: it proves the prose agrees
 * with THIS BUILD's marker, not that the marker matches the deployed `main`.
 * A branch legitimately carries a HIGHER number than `main` while it is open —
 * that is the whole re-bump rule — so on such a branch this test is satisfied
 * by prose that says the branch's own number is what `main` carries, which is
 * false until it merges. The residue is the open-sibling window, and the
 * table's own instruction covers it: re-read the sentence against `main`
 * rather than trusting it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CLAUDE_MD = readFileSync('CLAUDE.md', 'utf8');

/**
 * The prose wraps, so the version token and the claim routinely sit on
 * different lines ("v70 IS THE\nNEWEST AND IS ALSO WHAT `main` CARRIES").
 * Collapse whitespace first rather than writing one pattern that has to
 * survive every wrap position. The gap excludes a full stop so the match
 * cannot reach back across a sentence boundary for its version.
 *
 * AND IT EXCLUDES ANOTHER VERSION TOKEN, which a mutation is what caught. A
 * regex matches leftmost-first, so with a plain gap the exact stale sentence
 * this guard exists for — "v70 IS THE NEWEST, v69 IS WHAT `main` CARRIES" —
 * matched from v70, spanned "v69" inside the gap, and graded the claim as
 * naming the version it AGREES with. The guard was green on the defect it was
 * written from. Forbidding a version token inside the gap forces the match to
 * start at the NEAREST one, which is the version the claim is about.
 */
const flat = CLAUDE_MD.replace(/\s+/g, ' ');
const CLAIM =
  /\bv(\d+)\b(?:(?!\bv\d+\b)[^.]){0,80}?\bIS (?:ALSO )?WHAT `main` CARRIES/gi;

const versionsClaimingToBeOnMain = () =>
  [...flat.matchAll(CLAIM)].map((m) => `v${m[1]}`);

describe("CLAUDE.md's claim about what `main` carries", () => {
  it('is stated at least once, in the form this guard can read', () => {
    expect(
      versionsClaimingToBeOnMain(),
      'nothing in CLAUDE.md asserts `v<N> IS WHAT `main` CARRIES` — either the ' +
        'claim was deleted or it was reworded out of the form this guard reads',
    ).not.toEqual([]);
  });

  it('names the version this build\'s marker carries, everywhere it is stated', async () => {
    const { VOICE_RUNTIME_DEPLOY_MARKER } = await import('./readiness');
    const version = /^voice-runtime-(v\d+)-/.exec(VOICE_RUNTIME_DEPLOY_MARKER)?.[1];
    expect(version, 'the marker does not start with a version').toBeTruthy();

    const claimed = versionsClaimingToBeOnMain();
    const disagreeing = claimed.filter((v) => v !== version);
    expect(
      disagreeing,
      `the marker is ${version} but CLAUDE.md says \`main\` carries ${claimed.join(', ')} — ` +
        'a branch merged and its own prose did not follow it',
    ).toEqual([]);
  });
});
