/**
 * The runtime grades a call at teardown with the old core's own threshold,
 * and never on a row it does not have. Task #139.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ gradeCall: vi.fn(async () => ({ qualityScore: 4 })) }));
vi.mock("../services/callGradingService", () => ({ callGradingService: { gradeCall: (...a: unknown[]) => (h.gradeCall as any)(...a) } }));

const { shouldGradeAtTeardown, gradeRuntimeCall, GRADE_TRANSCRIPT_MIN_CHARS } = await import("./runtimeGrading");

const record = (transcript: string) => ({
  callSid: "CA1", streamSid: "MZ1", slug: "optical", callerPhone: "+1", dialedNumber: "+2",
  outcome: "caller_hangup" as const, transcript, toolEvents: [], agentTurns: 1, interruptions: 0,
  startedAtMs: 0, endedAtMs: 90_000,
});

beforeEach(() => h.gradeCall.mockClear());

describe("shouldGradeAtTeardown", () => {
  it("is the old core's threshold — over 200 characters, not 200", () => {
    expect(GRADE_TRANSCRIPT_MIN_CHARS).toBe(200);
    expect(shouldGradeAtTeardown({ transcript: "x".repeat(200) })).toBe(false);
    expect(shouldGradeAtTeardown({ transcript: "x".repeat(201) })).toBe(true);
    expect(shouldGradeAtTeardown({ transcript: "" })).toBe(false);
  });
});

describe("gradeRuntimeCall", () => {
  it("grades a substantive call on its row, with its transcript", async () => {
    const t = "AGENT: " + "words ".repeat(50);
    expect(await gradeRuntimeCall(record(t), { callLogId: "row-1" })).toBe("graded");
    expect(h.gradeCall).toHaveBeenCalledWith("row-1", t);
  });

  it("skips a greeting-only call, and a call with no row — an LLM call has nowhere to land", async () => {
    expect(await gradeRuntimeCall(record("AGENT: Thanks for calling."), { callLogId: "row-1" })).toBe("skipped");
    expect(await gradeRuntimeCall(record("x".repeat(500)), {})).toBe("skipped");
    expect(h.gradeCall).not.toHaveBeenCalled();
  });

  it("reports a grader that answered nothing as failed — the backfill still has it", async () => {
    h.gradeCall.mockResolvedValueOnce(null as any);
    expect(await gradeRuntimeCall(record("x".repeat(500)), { callLogId: "row-1" })).toBe("failed");
  });
});
