/**
 * src/runtime/markerTableIsIntact.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CLAUDE.md's marker table must not carry a version row twice.
 *
 * WHY THIS EXISTS, and it is a merge artifact rather than a typo. The six PCP
 * branches of 2026-09-15 are SIBLINGS, and every one of them adds a row to
 * this table, so merging them pairwise conflicts on the same file every time.
 * The integration branch resolves that with git's `union` driver, which keeps
 * BOTH sides of a conflicting hunk — correct for appending six new rows, and
 * wrong the moment a branch EDITS a row the integration branch already has.
 *
 * It has now happened twice in one night:
 *
 *   1. Five copies of the "AND THE SEQUENCE HAS A HOLE IN IT" sentence,
 *      each naming a different version as the newest, only the last complete.
 *   2. The v20 row twice — the pre-Codex copy in its correct position, and
 *      the copy carrying the P1 fix stranded after v23.
 *
 * Cursor called the first one "the exact class of CLAUDE.md corruption this
 * repo has been burned by", and it was right: a duplicated row is worse than
 * a missing one, because a reader who finds the stale copy first gets a
 * confident, well-formatted answer that is out of date. This table is the
 * ONLY thing that says what a deployment contains.
 *
 * A promise to re-read the file after every union merge is not a control.
 * This is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CLAUDE_MD = readFileSync('CLAUDE.md', 'utf8');
const ROW = /^\| \*\*(v\d+)\*\* or earlier/gm;

describe("CLAUDE.md's marker table survived the merge", () => {
  it('names each version exactly once', () => {
    const seen = [...CLAUDE_MD.matchAll(ROW)].map((m) => m[1]);
    const duplicated = seen.filter((v, i) => seen.indexOf(v) !== i);
    expect(seen.length, 'the marker table is missing entirely').toBeGreaterThan(5);
    expect([...new Set(duplicated)], 'a union merge kept two copies of a row').toEqual([]);
  });

  /**
   * Rows are in ascending order, so a row appended at the end by a merge
   * rather than placed in sequence is caught even if it is the only copy.
   * v13 is deliberately absent (see the paragraph under the table), so this
   * checks ORDER, not contiguity.
   */
  it('keeps them in ascending order', () => {
    const seen = [...CLAUDE_MD.matchAll(ROW)].map((m) => Number(m[1].slice(1)));
    expect(seen, 'a row is out of sequence — likely appended by a merge').toEqual(
      [...seen].sort((a, b) => a - b),
    );
  });

  /**
   * The sentence that says which version is newest. Five copies of it is how
   * this whole class of defect announced itself the first time.
   *
   * THE COUNT OF HOLES IS NOT PINNED, deliberately. It read "A HOLE" while v13
   * was the only skipped number; v57's withdrawal made it two, and retiring a
   * third would make it three. Pinning the numeral turned a legitimate edit
   * into a red test and told the reader nothing — the property this guard is
   * for is that there is exactly ONE such sentence, not how many holes it
   * reports. The stem is still required, so deleting the sentence is caught.
   */
  it('says which version is newest exactly once', () => {
    const openings =
      CLAUDE_MD.match(/AND THE SEQUENCE HAS [A-Z]+ HOLES? IN IT ON PURPOSE/g) ?? [];
    expect(openings).toHaveLength(1);
  });

  /**
   * And that sentence must name the marker the build actually serves — the
   * trap the table's own warning describes, where bumping the constant and
   * not the prose leaves a reader believing an older description.
   */
  it('names the same newest version the deploy marker carries', async () => {
    const { VOICE_RUNTIME_DEPLOY_MARKER } = await import('./readiness');
    const version = /^voice-runtime-(v\d+)-/.exec(VOICE_RUNTIME_DEPLOY_MARKER)?.[1];
    expect(version, 'the marker does not start with a version').toBeTruthy();
    // The prose writes the version lowercase ("v24 IS THE NEWEST"), so match
    // it as written rather than upper-casing and failing on the file's own
    // house style.
    expect(
      CLAUDE_MD,
      `the marker is ${version} but the table does not call it the newest`,
    ).toMatch(new RegExp(`\\b${version} IS THE\\s+NEWEST`));
  });
});
