import { describe, it, expect } from "vitest";
import {
  assertOutputDirIsIgnored,
  buildManifest,
  callerWordCount,
  chunkFileName,
  chunkRows,
  criticalFailureCount,
  DEFAULT_MIN_CALLER_WORDS,
  selectCorpus,
  skipReasonFor,
  toCorpusRow,
  type RawCallLogRow,
} from "./corpusBuilder";

const raw = (over: Partial<RawCallLogRow> = {}): RawCallLogRow => ({
  id: "CA1",
  transcript: "AGENT: Azul Vision, how can I help?\nCALLER: I need to reorder my contact lenses please",
  ticket_number: "VA-1",
  transferred_to_human: false,
  total_turns: 4,
  duration: 61,
  grader_results: null,
  ...over,
});

describe("callerWordCount", () => {
  it("counts only the caller's words", () => {
    expect(
      callerWordCount("AGENT: one two three four five six seven\nCALLER: eight nine"),
    ).toBe(2);
  });

  // The bug this guards against is real: a parser that keeps only lines
  // beginning "CALLER:" drops every wrapped line of a long answer, which is
  // where the substance lives. It made a whole-day analysis under-report.
  it("counts continuation lines, which belong to the open turn", () => {
    const wrapped = "CALLER: my name is\nand I am calling about\nan appointment next week";
    expect(callerWordCount(wrapped)).toBe(12);
  });

  it("is zero for an agent-only transcript", () => {
    expect(callerWordCount("AGENT: hello? hello? is anyone there at all?")).toBe(0);
  });

  it("is zero for an empty transcript", () => {
    expect(callerWordCount("")).toBe(0);
    expect(callerWordCount(null)).toBe(0);
  });
});

describe("skipReasonFor", () => {
  it("keeps a real conversation", () => {
    expect(skipReasonFor(raw())).toBeNull();
  });

  it("rejects an empty or whitespace transcript", () => {
    expect(skipReasonFor(raw({ transcript: null }))).toBe("no-transcript");
    expect(skipReasonFor(raw({ transcript: "   \n  " }))).toBe("no-transcript");
  });

  it("rejects a transcript with no caller turn", () => {
    expect(skipReasonFor(raw({ transcript: "AGENT: hello? Is anyone there?" }))).toBe(
      "no-caller-turns",
    );
  });

  // AS-20 in the 2026-09-02 forensic: "caller never stated a request" is
  // caller_wc <= 6. The corpus uses the same predicate so the two agree.
  it("rejects a caller who said six words or fewer", () => {
    expect(skipReasonFor(raw({ transcript: "AGENT: Hello?\nCALLER: sorry wrong number" }))).toBe(
      "not-a-conversation",
    );
  });

  // The exact boundary, both sides. Without these a "<=" that drifted to "<"
  // changes which calls enter the corpus and no test notices — found by
  // mutating the operator and watching all 27 tests still pass.
  it("rejects a caller at exactly the threshold", () => {
    const six = "AGENT: Hi\nCALLER: " + Array.from({ length: 6 }, (_, i) => `w${i}`).join(" ");
    expect(callerWordCount(six)).toBe(DEFAULT_MIN_CALLER_WORDS);
    expect(skipReasonFor(raw({ transcript: six }))).toBe("not-a-conversation");
  });

  it("keeps a caller at exactly one word past the threshold", () => {
    const seven = "AGENT: Hi\nCALLER: " + Array.from({ length: 7 }, (_, i) => `w${i}`).join(" ");
    expect(callerWordCount(seven)).toBe(DEFAULT_MIN_CALLER_WORDS + 1);
    expect(skipReasonFor(raw({ transcript: seven }))).toBeNull();
  });

  it("honours a caller-supplied threshold", () => {
    expect(skipReasonFor(raw(), 500)).toBe("not-a-conversation");
  });
});

describe("toCorpusRow", () => {
  it("emits exactly the fields the runner reads, and no identity fields", () => {
    const row = toCorpusRow(raw());
    expect(Object.keys(row).sort()).toEqual(
      ["duration", "id", "ticket_number", "total_turns", "transcript", "transferred_to_human"].sort(),
    );
    // The narrow shape is the PHI control: no caller name, patient name or DOB
    // is carried even if a future column adds one.
    for (const banned of ["caller_name", "patient_name", "patient_dob", "from", "caller_phone"]) {
      expect(row).not.toHaveProperty(banned);
    }
  });
});

describe("criticalFailureCount", () => {
  it("reads the stored summary", () => {
    expect(criticalFailureCount({ summary: { criticalFailures: 3 } })).toBe(3);
  });

  it("falls back to counting failing critical graders", () => {
    expect(
      criticalFailureCount({
        graders: [
          { severity: "critical", pass: false },
          { severity: "critical", pass: true },
          { severity: "minor", pass: false },
        ],
      }),
    ).toBe(1);
  });

  it("does not count a passing critical grader", () => {
    expect(criticalFailureCount({ graders: [{ severity: "critical", pass: true }] })).toBe(0);
  });

  it("is zero for junk", () => {
    expect(criticalFailureCount(null)).toBe(0);
    expect(criticalFailureCount("nope")).toBe(0);
    expect(criticalFailureCount({ summary: { criticalFailures: -1 } })).toBe(0);
  });
});

describe("chunkRows", () => {
  it("preserves order and covers every row", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("refuses a chunk size below one", () => {
    expect(() => chunkRows([1], 0)).toThrow(/chunkSize must be >= 1/);
  });
  it("names chunks zero-padded so they sort lexically", () => {
    expect([chunkFileName(0), chunkFileName(9), chunkFileName(10)]).toEqual([
      "chunk-000.jsonl",
      "chunk-009.jsonl",
      "chunk-010.jsonl",
    ]);
  });
});

describe("selectCorpus", () => {
  const conversation = (id: string, criticals: number): RawCallLogRow =>
    raw({ id, grader_results: { summary: { criticalFailures: criticals } } });

  it("accounts for every input row: kept + skipped === input", () => {
    const input = [
      conversation("a", 0),
      raw({ id: "b", transcript: null }),
      raw({ id: "c", transcript: "AGENT: hello?" }),
      raw({ id: "d", transcript: "AGENT: Hi\nCALLER: wrong number" }),
    ];
    const { rows, skipped } = selectCorpus(input, { ordering: "chronological" });
    const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);
    expect(rows).toHaveLength(1);
    expect(totalSkipped).toBe(3);
    expect(rows.length + totalSkipped).toBe(input.length);
    expect(skipped).toEqual({
      "no-transcript": 1,
      "no-caller-turns": 1,
      "not-a-conversation": 1,
    });
  });

  it("orders worst-first by critical failures", () => {
    const { rows } = selectCorpus(
      [conversation("low", 0), conversation("high", 5), conversation("mid", 2)],
      { ordering: "worst-first" },
    );
    expect(rows.map((r) => r.id)).toEqual(["high", "mid", "low"]);
  });

  it("keeps SQL order among equals, so two runs replay identically", () => {
    const { rows } = selectCorpus(
      [conversation("first", 1), conversation("second", 1), conversation("third", 1)],
      { ordering: "worst-first" },
    );
    expect(rows.map((r) => r.id)).toEqual(["first", "second", "third"]);
  });

  it("leaves chronological order alone", () => {
    const { rows } = selectCorpus(
      [conversation("low", 0), conversation("high", 5)],
      { ordering: "chronological" },
    );
    expect(rows.map((r) => r.id)).toEqual(["low", "high"]);
  });

  it("applies the limit after ordering, so --worst-first --limit takes the worst", () => {
    const { rows } = selectCorpus(
      [conversation("low", 0), conversation("high", 5), conversation("mid", 2)],
      { ordering: "worst-first", limit: 2 },
    );
    expect(rows.map((r) => r.id)).toEqual(["high", "mid"]);
  });
});

describe("buildManifest", () => {
  it("reports counts that match the rows it was built from", () => {
    const rows = [toCorpusRow(raw({ id: "a" })), toCorpusRow(raw({ id: "b" }))];
    const m = buildManifest({
      agents: ["surgery", "optical"],
      from: "2026-09-02",
      to: "2026-09-02",
      rows,
      chunkSize: 1,
      ordering: "worst-first",
      minCallerWords: 6,
      inputRows: 5,
      skipped: { "no-transcript": 2, "no-caller-turns": 1, "not-a-conversation": 0 },
      now: new Date("2026-09-03T12:00:00Z"),
    });
    expect(m.calls).toBe(2);
    expect(m.chunks).toBe(2);
    expect(m.agents).toEqual(["optical", "surgery"]);
    expect(m.calls + Object.values(m.skipped).reduce((a, b) => a + b, 0)).toBe(m.inputRows);
    expect(m.builtAt).toBe("2026-09-03T12:00:00.000Z");
  });
});

describe("assertOutputDirIsIgnored", () => {
  it("writes only where git actually ignores", () => {
    expect(() => assertOutputDirIsIgnored("replay-corpus/x", () => true)).not.toThrow();
  });

  it("refuses a path git would track, and says why", () => {
    expect(() => assertOutputDirIsIgnored("docs/corpus", () => false)).toThrow(
      /refusing to write a replay corpus to 'docs\/corpus'/,
    );
    expect(() => assertOutputDirIsIgnored("docs/corpus", () => false)).toThrow(/transcripts/);
  });

  it("asks about the path it was given, not a guess", () => {
    const asked: string[] = [];
    assertOutputDirIsIgnored("some/where", (d) => {
      asked.push(d);
      return true;
    });
    expect(asked).toEqual(["some/where"]);
  });
});
