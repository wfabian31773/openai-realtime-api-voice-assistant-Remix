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
}));
vi.mock("../services/callEventLog", () => ({
  emitCallEvent: (...a: unknown[]) => void log.emitted.push(a),
  flushCallEvents: async (id: string) => void log.flushed.push(id),
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
    expect(ev.data).toEqual({ owed: 1, requested: 1, toolCallsAfterDone: 1, lastUnanswered: true, outcome: "dead_air" });
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

describe("the runtime writes it at teardown, after the row and the sweep", () => {
  const src = readFileSync(new URL("./voiceRuntime.ts", import.meta.url), "utf8");

  it("imports the writer and defaults the seam to it", () => {
    expect(src).toMatch(/import \{ logRuntimeFollowUps \} from "\.\/followUpTelemetry"/);
    expect(src).toMatch(/const logFollowUps = options\.logFollowUps \?\? logRuntimeFollowUps;/);
  });

  it("calls it after the grade, never awaited", () => {
    const grade = src.indexOf("void gradeCall(record, { callLogId })");
    const follow = src.indexOf("void logFollowUps(record, { callLogId })");
    expect(grade).toBeGreaterThan(0);
    expect(follow).toBeGreaterThan(grade);
    expect(src.slice(grade, follow)).not.toMatch(/\breturn\b/);
  });
});
