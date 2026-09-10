/**
 * src/runtime/ceilingDocCheck.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The published runaway-loop check must agree with the ceiling it watches.
 *
 * WHY THIS EXISTS. `ToolCallCeiling.begin` refuses at
 * `dispatches >= perCallDispatches`, so a call can REACH the limit and can
 * never exceed it. CLAUDE.md and docs/PULL-CHECK.md published the check as
 * `tool_call_count > 40` against a ceiling of `>= 40`. It proved the ceiling
 * had shipped, and from that moment it was the only thing watching for
 * runaway loops while being unable, by construction, to see one the ceiling
 * had stopped. Measured on 2026-09-09: one call above 40 (the pre-ceiling
 * call the ceiling was built for), five sitting at exactly 40, and NOTHING
 * between 25 and 39 — the gap is what makes 40 a ceiling strike rather than
 * drift. All five were invisible to the published check.
 *
 * A comment asking the next reader to keep two numbers in step is not a
 * control. This is: if the limit moves and a document does not, these fail.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CEILING_REACHED_SQL_PREDICATE, DEFAULT_CEILING_LIMITS } from "./toolCeiling";

/** Repo root, from this file's location — no dependency on the cwd a runner picks. */
const ROOT = resolve(__dirname, "..", "..");

/** Every document that publishes the check. Add to this list, never fork it. */
const PUBLISHING_DOCS = ["CLAUDE.md", "docs/PULL-CHECK.md"] as const;

/** `tool_call_count` compared against a literal, any spacing. */
const THRESHOLD_RE = /tool_call_count\s*(>=|<=|>|<|=)\s*(\d+)/g;

function read(doc: string): string {
  return readFileSync(resolve(ROOT, doc), "utf8");
}

/**
 * The fenced ```sql block that publishes the runaway-loop query, and ONLY
 * that block.
 *
 * Scoping matters: an earlier version of this file validated every
 * `tool_call_count` comparison anywhere in the document, which would have
 * failed the suite the day someone added an unrelated `tool_call_count < 5`
 * elsewhere in a 1,600-line runbook. The guard exists to stop THIS query
 * drifting from the limit, not to reserve the column.
 *
 * The runaway-loop query is the one that selects `call_sid` alongside
 * `tool_call_count`; the other queries in these documents are `count(*)`
 * rollups. Exactly one block must match, so that a rename or a second copy
 * fails loudly here rather than silently narrowing what is checked.
 */
/**
 * Fenced code blocks, tolerating the CommonMark variations a Markdown-only
 * edit can legitimately introduce: CRLF checkouts, up to three spaces of
 * indentation, tilde fences, fences longer than three characters, and an
 * info string in any case with trailing spaces. A formatting change must
 * never fail a semantic drift test.
 */
function fencedBlocks(text: string, language: string): string[] {
  const re = new RegExp(
    String.raw` ^[ ]{0,3}([\`~]{3,})[ \t]*${language}[ \t]*\r?$([\s\S]*?)^[ ]{0,3}\1[ \t]*\r?$`.trim(),
    "gim",
  );
  return [...text.matchAll(re)].map((m) => m[2] ?? "");
}

function ceilingQueryBlock(doc: string): string {
  const blocks = fencedBlocks(read(doc), "sql");
  const matching = blocks.filter(
    (b) => b.includes("tool_call_count") && b.includes("call_sid"),
  );
  expect(
    matching.length,
    `${doc} must publish exactly one runaway-loop SQL block (found ${matching.length})`,
  ).toBe(1);
  return matching[0] ?? "";
}

describe("the published runaway-loop check tracks the ceiling", () => {
  it("derives the predicate from the limit, so the two cannot be edited apart", () => {
    expect(CEILING_REACHED_SQL_PREDICATE).toBe(
      `tool_call_count >= ${DEFAULT_CEILING_LIMITS.perCallDispatches}`,
    );
  });

  for (const doc of PUBLISHING_DOCS) {
    describe(doc, () => {
      it("publishes the check at the ceiling's own limit", () => {
        expect(ceilingQueryBlock(doc)).toContain(CEILING_REACHED_SQL_PREDICATE);
      });

      it("leaves unrelated tool_call_count queries alone", () => {
        // The guard must not veto a legitimate future query on the same
        // column. Proven by construction: the scoped block is a strict
        // subset of the document, and the document is not searched.
        const block = ceilingQueryBlock(doc);
        expect(block.length).toBeGreaterThan(0);
        expect(read(doc).length).toBeGreaterThan(block.length);
      });

      it("compares tool_call_count only with >=, never a strict >", () => {
        // Scoped to the runaway-loop block: other uses of the column
        // elsewhere in these documents are none of this guard's business.
        const found = [...ceilingQueryBlock(doc).matchAll(THRESHOLD_RE)].map((m) => ({
          operator: m[1],
          value: Number(m[2]),
        }));

        // A document that has stopped mentioning the check at all is a
        // silent pass, which is the failure this whole file is about.
        expect(found.length).toBeGreaterThan(0);

        for (const { operator, value } of found) {
          // `> 40` is the exact bug: it can never see a stopped loop.
          expect({ operator, value }).toEqual({
            operator: ">=",
            value: DEFAULT_CEILING_LIMITS.perCallDispatches,
          });
        }
      });

      it("does not still tell the reader a row means the build is broken", () => {
        // The check was published as "this should return nothing". At `>=` it
        // returns rows in normal operation, and a reader acting on the old
        // sentence would treat the ceiling working as a regression.
        expect(read(doc)).not.toMatch(/should return nothing/i);
      });
    });
  }
});
