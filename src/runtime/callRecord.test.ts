import { describe, it, expect } from "vitest";
import { toCallLogRow } from "./callRecord";
import type { VoiceCallRecord } from "./mediaStreamBridge";

function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: "CA-1",
    streamSid: "MZ-1",
    slug: "optical",
    callerPhone: "+15551234567",
    dialedNumber: "+15559876543",
    outcome: "caller_hangup",
    transcript: "CALLER: Hi\nAGENT: Hello",
    toolEvents: [{ name: "create_ticket", ok: true, atMs: 4200 }],
    agentTurns: 3,
    interruptions: 1,
    startedAtMs: 1_000_000,
    endedAtMs: 1_093_000,
    ...over,
  };
}

describe("toCallLogRow", () => {
  it("writes the lane slug into agent_used, so a Grok call is attributable", () => {
    expect(toCallLogRow(record()).agentUsed).toBe("optical");
  });

  it("measures duration from the call's own clock, both columns from one number", () => {
    const row = toCallLogRow(record());
    expect(row.duration).toBe(93);
    expect(row.localDurationSeconds).toBe(93);
  });

  it("marks telemetry as event-counted, never estimated from wall time", () => {
    const row = toCallLogRow(record());
    expect(row.telemetrySource).toBe("realtime_events");
    expect(row.totalTurns).toBe(3);
    expect(row.interruptionCount).toBe(1);
    expect(row.toolCallCount).toBe(1);
  });

  it("records the runtime's own failures as failed calls, and hangups as completed", () => {
    expect(toCallLogRow(record({ outcome: "dead_air" })).status).toBe("failed");
    expect(toCallLogRow(record({ outcome: "provider_failure" })).status).toBe("failed");
    expect(toCallLogRow(record({ outcome: "caller_hangup" })).status).toBe("completed");
    expect(toCallLogRow(record({ outcome: "agent_ended" })).status).toBe("completed");
    expect(toCallLogRow(record({ outcome: "max_duration" })).status).toBe("completed");
  });

  it("keeps the outcome on the timeline, so a punt is visible without parsing notes", () => {
    const row = toCallLogRow(record({ outcome: "max_duration" }));
    expect(row.toolTimeline.outcome).toBe("max_duration");
    expect(row.toolTimeline.source).toBe("voice_runtime");
  });

  it("leaves identity NULL when the runtime was not told it — never inferred from a tool result", () => {
    const row = toCallLogRow(
      record({ toolEvents: [{ name: "lookup_schedule", ok: true, atMs: 900 }] }),
    );
    expect(row.patientName).toBeNull();
    expect(row.patientDob).toBeNull();
    expect(row.patientFound).toBe(false);
  });

  it("writes identity when it IS supplied — the column the queue agents never wrote", () => {
    const row = toCallLogRow(record(), {
      patientName: "Test Patient",
      patientDob: "01/01/1970",
      patientFound: true,
    });
    expect(row.patientName).toBe("Test Patient");
    expect(row.patientDob).toBe("01/01/1970");
    expect(row.patientFound).toBe(true);
  });

  it("stamps the environment from NODE_ENV so dev traffic never counts as production", () => {
    expect(toCallLogRow(record(), {}, { NODE_ENV: "production" }).environment).toBe("production");
    expect(toCallLogRow(record(), {}, {}).environment).toBe("development");
  });

  it("carries the transcript through unchanged", () => {
    expect(toCallLogRow(record()).transcript).toBe("CALLER: Hi\nAGENT: Hello");
  });

  it("never returns a negative duration when the clocks disagree", () => {
    const row = toCallLogRow(record({ startedAtMs: 2_000, endedAtMs: 1_000 }));
    expect(row.duration).toBe(0);
  });
});
