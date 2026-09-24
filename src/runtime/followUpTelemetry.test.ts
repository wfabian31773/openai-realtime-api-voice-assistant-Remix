/**
 * THE FOLLOW-UP SUMMARY REACHES call_events — v55, task #146.
 *
 * Half the assertions run the helper; the other half READ voiceRuntime.ts,
 * because a helper test proves the helper and not that anything calls it
 * (recurring failure mode 10).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { VoiceCallRecord } from "./mediaStreamBridge";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";

const log = vi.hoisted(() => ({
  emitted: [] as unknown[][],
  flushed: [] as string[],
  released: [] as Array<string | undefined>,
  /** What each flush answers, in order; empty means "it landed". */
  flushOk: [] as boolean[],
}));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...a: unknown[]) => void log.emitted.push(a),
  flushCallEvents: async (id: string) => {
    log.flushed.push(id);
    return log.flushOk.length ? (log.flushOk.shift() as boolean) : true;
  },
  releaseCallEvents: (id?: string) => void log.released.push(id),
}));

const { followUpEvent, logRuntimeFollowUps, FOLLOW_UP_EVENT } = await import("./followUpTelemetry");

const SID = "CA00000000000000000000000000000f55";
function record(followUps?: VoiceCallRecord["followUps"]): VoiceCallRecord {
  return {
    callSid: SID,
    streamSid: "MZ-1",
    slug: "surgery",
    callerPhone: "+15551234567",
    dialedNumber: "+15559876543",
    outcome: "dead_air",
    transcript: "",
    toolEvents: [],
    agentTurns: 0,
    interruptions: 0,
    startedAtMs: 0,
    endedAtMs: 1,
    ...(followUps ? { followUps } : {}),
  };
}

beforeEach(() => {
  log.emitted.length = 0;
  log.flushed.length = 0;
  log.released.length = 0;
  log.flushOk.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the follow-up summary", () => {
  it("is a WARN when the last follow-up went unanswered or a tool call arrived after its done", () => {
    expect(followUpEvent(record({ owed: 1, requested: 1, toolCallsAfterDone: 0, lastUnanswered: true }))!.level).toBe("warn");
    expect(followUpEvent(record({ owed: 1, requested: 1, toolCallsAfterDone: 1, lastUnanswered: false }))!.level).toBe("warn");
    expect(followUpEvent(record({ owed: 2, requested: 2, toolCallsAfterDone: 0, lastUnanswered: false }))!.level).toBe("info");
  });

  it("says nothing for a call that never owed a follow-up", () => {
    expect(followUpEvent(record({ owed: 0, requested: 0, toolCallsAfterDone: 0, lastUnanswered: false }))).toBeNull();
    expect(followUpEvent(record())).toBeNull();
  });

  it("carries only counts and the outcome — nothing a caller said", () => {
    const ev = followUpEvent(record({ owed: 1, requested: 1, toolCallsAfterDone: 1, lastUnanswered: true }))!;
    // An EXACT key set, so a field carrying anything a caller said cannot be
    // added without this going red. v65's two are counts, like the rest.
    expect(ev.data).toEqual({
      owed: 1,
      requested: 1,
      toolCallsAfterDone: 1,
      lastUnanswered: true,
      hangupsHeld: 0,
      silencePrompts: 0,
      silenceCut: false,
      outcome: "dead_air",
    });
  });

  it("emits one call_events row keyed on the call and flushes it, then releases the buffer", async () => {
    const wrote = await logRuntimeFollowUps(record({ owed: 1, requested: 1, toolCallsAfterDone: 1, lastUnanswered: true }), { callLogId: "row-1" });
    expect(wrote).toBe(true);
    expect(log.emitted).toHaveLength(1);
    const [callId, level, category, message, data, ids] = log.emitted[0];
    expect(callId).toBe(SID);
    expect(level).toBe("warn");
    expect(category).toBe("model");
    expect(message).toBe(FOLLOW_UP_EVENT);
    expect(data).toMatchObject({ toolCallsAfterDone: 1, lastUnanswered: true });
    expect(ids).toEqual({ callSid: SID, callLogId: "row-1", agentSlug: "surgery" });
    expect(log.flushed).toEqual([SID]);
    expect(log.released).toEqual([SID]);
  });

  it("writes nothing for a call with no follow-up to report", async () => {
    expect(await logRuntimeFollowUps(record(), {})).toBe(false);
    expect(log.emitted).toHaveLength(0);
  });
});

describe("the buffer outlives a failed flush — Codex P2 on #321, round 9", () => {
  const summary = () => record({ owed: 1, requested: 1, toolCallsAfterDone: 1, lastUnanswered: true });

  it("a flush that fails is retried on the backoff, and the buffer is released only once it lands", async () => {
    log.flushOk.push(false, true);
    const slept: number[] = [];
    const wrote = await logRuntimeFollowUps(summary(), {}, { backoffMs: [7, 11], sleep: async (ms) => void slept.push(ms) });
    expect(wrote).toBe(true);
    expect(log.flushed).toEqual([SID, SID]);
    expect(slept).toEqual([7]);
    expect(log.released).toEqual([SID]);
  });

  it("a summary that never lands is LEFT for the reaper — the buffer is not released", async () => {
    log.flushOk.push(false, false);
    const wrote = await logRuntimeFollowUps(summary(), {}, { backoffMs: [1], sleep: async () => undefined });
    expect(wrote).toBe(false);
    expect(log.flushed).toEqual([SID, SID]);
    expect(log.released).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("left for the reaper"));
  });

  it("the production backoff is the teardown write's own", () => {
    const src = readFileSync(new URL("./followUpTelemetry.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ PERSIST_RETRY_BACKOFF_MS \} from "\.\/callRecord"/);
    expect(src).toMatch(/opts\.backoffMs \?\? PERSIST_RETRY_BACKOFF_MS/);
  });
});

describe("the runtime writes it at teardown, after the row and the sweep", () => {
  const src = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");

  it("imports the writer and defaults the seam to it", () => {
    expect(src).toMatch(/import \{ logRuntimeFollowUps \} from "\.\/followUpTelemetry"/);
    expect(src).toMatch(/const logFollowUps = options\.logFollowUps \?\? logRuntimeFollowUps;/);
  });

  /**
   * REWRITTEN, NOT LOOSENED, for task #148. The call is no longer `void`-ed
   * directly: its promise is captured and handed to the identity writer as
   * `after`, so the two `call_events` writers cannot release the same per-SID
   * buffer at once (Codex P2, #322 round 2). The PROPERTY is unchanged and is
   * what is asserted — called after the grade, and never awaited.
   */
  it("calls it after the grade, never awaited", () => {
    const grade = src.indexOf("void gradeCall(record, { callLogId })");
    const follow = src.indexOf("logFollowUps(record, { callLogId })");
    expect(grade).toBeGreaterThan(0);
    expect(follow).toBeGreaterThan(grade);
    expect(src.slice(grade, follow)).not.toMatch(/\breturn\b/);
    // Never awaited: teardown must not wait on telemetry.
    expect(src.slice(Math.max(0, follow - 60), follow)).not.toMatch(/\bawait\s*$/);
    expect(src).not.toMatch(/await logFollowUps\(/);
  });
});
