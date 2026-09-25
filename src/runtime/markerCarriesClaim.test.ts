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
 * THE EQUALITY RULE THIS TEST SHIPPED WITH WAS WRONG, and the ship that bumped
 * the marker to v71 is what proved it. It required every claim to name the
 * version THIS BUILD's marker carries — sound only while the branch and `main`
 * agree, which was true for one day and is a condition the marker table itself
 * records as temporary. The moment a branch ships above `main`, that rule
 * demands prose saying the branch's own number is what `main` carries, which is
 * false. A guard that forces the file into a false statement to stay green is
 * worse than no guard: it manufactures exactly the stale claim it was built to
 * catch. My own docblock called this a "residue" and left it standing; it was a
 * defect, not a residue.
 *
 * WHAT REPLACES IT, and why it is weaker on purpose. A test running on a branch
 * cannot know what `main` carries — there is no honest way to check the fact
 * itself. So it checks the two things it can: no claim may name a version ABOVE
 * this build's marker (a branch cannot be behind its own prose), and every
 * claim must cite a commit, which is what lets a reader settle it in one
 * command instead of trusting the sentence.
 *
 * AND THAT PAIR WAS STILL NOT ENOUGH — Codex P2 on #329, on the review the
 * ready-mark triggered, and it is the ORIGINAL defect reachable through my own
 * weakening. The ceiling admits every stale-LOW claim, which is what all five
 * historical arrivals were; the citation check asks only whether a sha is
 * PRESENT, and a stale claim carries a stale sha, which still looks like one.
 * So two claims could disagree with each other while both passed. Reproduced
 * before fixing, by putting 2026-09-24's actual prose back: three claims, `main`
 * carrying v67 (`a5815ca`) and v70 (`c247479`) in the same file, suite green.
 *
 * SO THE FOURTH ASSERTION IS AGREEMENT, and it is the strongest check that is
 * honest on a branch. "What `main` carries" is a present-tense fact with one
 * value; restating it is legitimate — the docblock above says why — but two
 * restatements differing never is. Internal consistency needs no knowledge of
 * `main`, so it holds wherever this suite runs, and it compares the SHA as well
 * as the version, because the sha is the half that moves on every merge.
 *
 * ALL THREE EARN THEIR PLACE, which is why none of them is folded into another:
 * the ceiling catches a SINGLE claim that is too high (the marker was not
 * bumped), and agreement cannot see that — one claim always agrees with itself;
 * the citation check catches a claim with no sha at all, which agreement reads
 * as merely another value; and agreement catches the multi-claim drift that is
 * invisible to both. That is not asserted on faith: with claim 1 mutated out of
 * the readable form so exactly ONE remains, dropping its sha fails the citation
 * check alone and raising its version fails the ceiling alone, while agreement
 * stays green in both — and a single correct claim passes all three.
 *
 * TWO MUTATIONS ARE GREEN BY DESIGN and are recorded rather than counted as
 * caught, because when the deliverable IS a test there is no meta-test above it.
 * Narrowing the comparison to the version alone, with two claims differing only
 * in their sha, is green — and the same prose against the full comparison is
 * red, so the PAIR is what proves the sha is load-bearing rather than
 * decoration. And removing the agreement assertion with 2026-09-24's prose in
 * place is green, which is the reachability proof: it is how the defect was
 * confirmed before any of this was written.
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

const claims = () =>
  [...flat.matchAll(CLAIM)].map((m) => {
    /**
     * The 80 characters after the claim, where the provenance sits: the file's
     * own convention is "(merged 2026-09-24, `c247479`)", and the sequence
     * sentence puts a PR number and a date in front of the sha, so a shorter
     * window truncates the closing backtick and fails a correctly cited claim.
     * Read from the whitespace-collapsed text for the same reason the claim is.
     */
    const tail = flat.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
    return { version: Number(m[1]), tail, sha: /`([0-9a-f]{7,40})`/.exec(tail)?.[1] };
  });

const versionsClaimingToBeOnMain = () => claims().map((c) => `v${c.version}`);

/** How a claim is named when one of these assertions has to print it. */
const cited = (c: { version: number; sha?: string }) =>
  `v${c.version} (${c.sha ?? 'no commit cited'})`;

describe("CLAUDE.md's claim about what `main` carries", () => {
  it('is stated at least once, in the form this guard can read', () => {
    expect(
      versionsClaimingToBeOnMain(),
      'nothing in CLAUDE.md asserts `v<N> IS WHAT `main` CARRIES` — either the ' +
        'claim was deleted or it was reworded out of the form this guard reads',
    ).not.toEqual([]);
  });

  it('never claims `main` is AHEAD of this build', async () => {
    const { VOICE_RUNTIME_DEPLOY_MARKER } = await import('./readiness');
    const marker = /^voice-runtime-v(\d+)-/.exec(VOICE_RUNTIME_DEPLOY_MARKER)?.[1];
    expect(marker, 'the marker does not start with a version').toBeTruthy();

    // Equal is the ordinary state (nothing shipped on this branch yet); below is
    // the state while this branch ships above `main`. Above is impossible: a
    // branch always contains what it says `main` carries.
    const ahead = claims().filter((c) => c.version > Number(marker));
    expect(
      ahead.map((c) => `v${c.version}`),
      `this build's marker is v${marker} and CLAUDE.md says \`main\` carries something ` +
        'newer, which cannot be true — the marker was not bumped, or the claim names the ' +
        'wrong version',
    ).toEqual([]);
  });

  it('cites a commit, so a reader can settle it without trusting the sentence', () => {
    const uncited = claims().filter((c) => !c.sha);
    expect(
      uncited.map((c) => `v${c.version}`),
      'a claim about what `main` carries names no commit — the numeric check cannot ' +
        'catch a stale-low claim, so the sha is what makes it verifiable',
    ).toEqual([]);
  });

  it('states ONE version and ONE commit, however many times it is stated', () => {
    // Zero claims is assertion 1's business, not this one's: one assertion, one
    // property, or a failure stops naming what is actually wrong.
    const distinct = [...new Set(claims().map(cited))];
    const disagreeing = distinct.length > 1 ? distinct : [];

    expect(
      disagreeing,
      'CLAUDE.md states what `main` carries more than once and the statements DISAGREE — ' +
        'one was updated after a merge and the other was left behind, which is the exact ' +
        'defect this guard exists for. Neither the ceiling nor the citation check can see ' +
        'it: both versions sit below the branch marker, and a stale claim carries a stale ' +
        'sha, which still looks like a sha',
    ).toEqual([]);
  });
});
