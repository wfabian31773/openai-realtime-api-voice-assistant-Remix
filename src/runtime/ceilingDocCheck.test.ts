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

/** `tool_call_count` compared against a literal, in either order, any spacing. */
const THRESHOLD_RE = /tool_call_count\s*(>=|<=|>|<|=)\s*(\d+)/g;

function read(doc: string): string {
  return readFileSync(resolve(ROOT, doc), "utf8");
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
        expect(read(doc)).toContain(CEILING_REACHED_SQL_PREDICATE);
      });

      it("compares tool_call_count only with >=, never a strict >", () => {
        const found = [...read(doc).matchAll(THRESHOLD_RE)].map((m) => ({
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
