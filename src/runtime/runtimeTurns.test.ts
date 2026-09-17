/**
 * A RUNTIME CALL'S LINES REACH call_turns WITH THEIR OWN TIMES.
 *
 * Every one of the 4,564 runtime calls since the cutover had no rows in
 * call_turns, so the Observatory fell back to the flat transcript and called
 * it an instrumentation gap. The gap was that nothing wrote them. This drives
 * the real turnLog writer with the database mocked and reads back what would
 * have been inserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>[]> }));
vi.mock("../../server/db", () => ({
  db: { insert: () => ({ values: async (rows: Record<string, unknown>[]) => { h.inserted.push(rows); } }) },
}));

const { persistRuntimeTurns, runtimeTurnState } = await import("./runtimeTurns");
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import("../tools/verifiedIdentity");

const SID = "CA00000000000000000000000000000abc";
const T0 = Date.parse("2026-09-16T14:54:00Z");

const record = (turns: Array<{ role: "caller" | "agent"; text: string; atMs: number }>) => ({
  callSid: SID, streamSid: "MZ1", slug: "optical", callerPhone: "+1", dialedNumber: "+2",
  outcome: "caller_hangup" as const, transcript: "", turns, toolEvents: [], agentTurns: 0, interruptions: 0,
  startedAtMs: T0, endedAtMs: T0 + 60_000,
}) as any;

beforeEach(() => { h.inserted.length = 0; resetVerifiedIdentities(); });

describe("persistRuntimeTurns", () => {
  it("writes one row per line, in order, with each line's OWN time and the gap to the previous", async () => {
    const n = await persistRuntimeTurns(record([
      { role: "agent", text: "Thank you for calling.", atMs: T0 },
      { role: "caller", text: "I need to reschedule.", atMs: T0 + 4_000 },
      { role: "agent", text: "What is your last name?", atMs: T0 + 7_000 },
    ]), { callLogId: "log-1" });
    expect(n).toBe(3);
    expect(h.inserted).toHaveLength(1);
    const rows = h.inserted[0]!;
    expect(rows.map((r) => [r.turnIndex, r.role, r.rawTranscript, (r.at as Date).toISOString(), r.sincePrevMs])).toEqual([
      [1, "agent", "Thank you for calling.", "2026-09-16T14:54:00.000Z", null],
      [2, "caller", "I need to reschedule.", "2026-09-16T14:54:04.000Z", 4_000],
      [3, "agent", "What is your last name?", "2026-09-16T14:54:07.000Z", 3_000],
    ]);
    expect(rows[0]).toMatchObject({ callSid: SID, callLogId: "log-1", agentSlug: "optical" });
  });

  it("does NOT stamp every line with the hang-up time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(T0 + 600_000));
    try {
      await persistRuntimeTurns(record([{ role: "caller", text: "hi", atMs: T0 + 1_000 }]));
      expect((h.inserted[0]![0]!.at as Date).getTime()).toBe(T0 + 1_000);
    } finally { vi.useRealTimers(); }
  });

  it("a call with nothing said writes nothing", async () => {
    expect(await persistRuntimeTurns(record([]))).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it("releases the buffer, so a second call with the same SID starts clean", async () => {
    await persistRuntimeTurns(record([{ role: "caller", text: "a", atMs: T0 }]));
    await persistRuntimeTurns(record([{ role: "caller", text: "b", atMs: T0 + 1 }]));
    expect(h.inserted).toHaveLength(2);
    expect(h.inserted[1]!.map((r) => r.turnIndex)).toEqual([1]);
  });
});

describe("the state column is honest or empty", () => {
  it("names the identity fields the record held, never their values, and does not count asks it never counted", () => {
    rememberVerifiedIdentity(SID, { firstName: "Test", lastName: "Caller", dateOfBirth: "1958-01-04", certain: true } as any);
    const st = runtimeTurnState(SID);
    expect(st.known).toEqual(["first_name", "last_name", "date_of_birth"]);
    expect(st.identityVerified).toBe(true);
    expect(st.identityAsks).toBeNull();
    expect(JSON.stringify(st)).not.toMatch(/Caller|1958/);
  });

  it("an unidentified call has an empty, unverified state", () => {
    expect(runtimeTurnState("CA0000000000000000000000000000dead")).toEqual({ known: [], identityVerified: false, identityAsks: null, intent: null });
  });
});
