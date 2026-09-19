/**
 * THE GRADING BACKFILL CANNOT BE STARVED BY ITS OWN HEAD — task #139.
 *
 * Measured 2026-09-17: the two newest ungraded runtime rows had an EMPTY
 * transcript (duration 1s). `IS NOT NULL` selected them, `if (call.transcript)`
 * skipped them, nothing stamped them — so they sat at the head of a newest-
 * first, LIMIT 5 selection forever. Three rows behind them were in failure
 * backoff and `continue`d, still holding their slots. Five rows, zero
 * attempts per cycle, and 87 calls from 2026-09-15 with deterministic grades
 * and no outcome behind them that the backfill never reached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.OPENAI_API_KEY ||= "test-unused";

type Row = { id: string; transcript: string | null; gradedAt: Date | null };
const q = vi.hoisted(() => ({
  rows: [] as Row[],
  windows: [] as number[],
  stamped: [] as string[],
}));
vi.mock("../../server/storage", () => ({
  storage: {
    getCallLogsWithoutGrades: async (limit: number) => {
      q.windows.push(limit);
      return q.rows.filter((r) => r.gradedAt === null).slice(0, limit);
    },
    updateCallLog: async (id: string, patch: { gradedAt?: Date }) => {
      if (patch.gradedAt) {
        q.stamped.push(id);
        const r = q.rows.find((x) => x.id === id);
        if (r) r.gradedAt = patch.gradedAt;
      }
    },
  },
}));
vi.mock("../../server/db", () => ({ db: {} }));

const { CallGradingService } = await import("./callGradingService");
CallGradingService.interAttemptMs = 0;

/** Newest first, the way the SELECT orders. Two empties, three that fail, ten good. */
function seed() {
  q.rows = [
    { id: "empty-1", transcript: "", gradedAt: null },
    { id: "empty-2", transcript: "", gradedAt: null },
    ...[1, 2, 3].map((i) => ({ id: `bad-${i}`, transcript: "CALLER: " + "words ".repeat(40), gradedAt: null })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `good-${i}`, transcript: "CALLER: " + "words ".repeat(40), gradedAt: null })),
  ];
  q.windows.length = 0;
  q.stamped.length = 0;
}

function service() {
  const svc = new CallGradingService();
  const graded: string[] = [];
  // A grade that succeeds marks the row graded, as the real one does through storage.
  svc.gradeCall = vi.fn(async (id: string) => {
    if (id.startsWith("bad")) return null;
    graded.push(id);
    const r = q.rows.find((x) => x.id === id);
    if (r) r.gradedAt = new Date();
    return { qualityScore: 4 } as any;
  }) as any;
  return { svc, graded };
}

beforeEach(() => {
  seed();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("gradeCallsWithoutGrades", () => {
  it("looks past the budget for candidates, so a stuck head cannot be the whole selection", async () => {
    const { svc } = service();
    await svc.gradeCallsWithoutGrades(5);
    expect(Math.max(...q.windows)).toBeGreaterThanOrEqual(30);
  });

  it("stamps an empty transcript as processed instead of skipping it forever", async () => {
    const { svc } = service();
    await svc.gradeCallsWithoutGrades(5);
    expect(q.stamped.filter((id) => id.startsWith("empty")).sort()).toEqual(["empty-1", "empty-2"]);
    // And it does not spend the budget: the five attempts went to real rows.
    expect((svc.gradeCall as any).mock.calls).toHaveLength(5);
  });

  it("a row in backoff costs no slot — the rows behind it are graded on the next cycle", async () => {
    const { svc, graded } = service();
    const first = await svc.gradeCallsWithoutGrades(5);
    // Cycle 1: three bad rows fail (and enter backoff), two good rows grade.
    expect(first).toBe(2);
    const second = await svc.gradeCallsWithoutGrades(5);
    // Cycle 2: the bad rows are skipped without consuming the budget; five more good rows grade.
    expect(second).toBe(5);
    expect(graded).toHaveLength(7);
    expect(graded.every((id) => id.startsWith("good"))).toBe(true);
  });
});
