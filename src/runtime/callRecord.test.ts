import { describe, it, expect, vi } from "vitest";
import { toCallLogRow, toConflictUpdate, persistRuntimeCall } from "./callRecord";
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
  });

  it("records the runtime's own failures as failed calls, and hangups as completed", () => {
    expect(toCallLogRow(record({ outcome: "dead_air" })).status).toBe("failed");
    expect(toCallLogRow(record({ outcome: "provider_failure" })).status).toBe("failed");
    expect(toCallLogRow(record({ outcome: "caller_hangup" })).status).toBe("completed");
    expect(toCallLogRow(record({ outcome: "agent_ended" })).status).toBe("completed");
    expect(toCallLogRow(record({ outcome: "max_duration" })).status).toBe("completed");
  });

  it("still classifies a punt through the status column, without a timeline of its own", () => {
    // The outcome used to ride on a toolTimeline the runtime wrote. That
    // column belongs to the agents' telemetry, so the status column carries
    // the distinction instead.
    expect(toCallLogRow(record({ outcome: "max_duration" })).status).toBe("completed");
    expect(toCallLogRow(record({ outcome: "dead_air" })).status).toBe("failed");
  });

  it("writes NO identity when the runtime was not told it — never inferred from a tool result", () => {
    const row = toCallLogRow(
      record({ toolEvents: [{ name: "lookup_schedule", ok: true, atMs: 900 }] }),
    ) as unknown as Record<string, unknown>;
    expect(row.patientName).toBeUndefined();
    expect(row.patientDob).toBeUndefined();
    expect(row.patientFound).toBeUndefined();
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

  it("does NOT write the tool timeline — the agents' own telemetry owns it", () => {
    // recordedTool writes {tool, args, outcome, ms} plus purpose/result via
    // classifyForAgent, and dashboards read purpose/result for fulfillment
    // metrics. A second, differently-shaped writer here would overwrite the
    // richer record the agent persisted during the call and make filing
    // outcomes unclassifiable (Codex review, PR #227).
    const row = toCallLogRow(record()) as unknown as Record<string, unknown>;
    expect('toolTimeline' in row).toBe(false);
    expect('toolCallCount' in row).toBe(false);
  });

  it("omits identity columns entirely when it was not told them", () => {
    // Writing nulls would erase what stampVerifiedIdentity had already set.
    const row = toCallLogRow(record()) as unknown as Record<string, unknown>;
    expect('patientName' in row).toBe(false);
    expect('patientFound' in row).toBe(false);
  });

  it("never overwrites another writer's columns on a conflict", () => {
    const row = toCallLogRow(record(), { patientName: 'Test Patient', patientFound: true });
    const update = toConflictUpdate(row) as unknown as Record<string, unknown>;
    // Runtime-owned facts about how the call ended are safe to refresh.
    expect(update.endTime).toBeInstanceOf(Date);
    expect(update.transcript).toBe("CALLER: Hi\nAGENT: Hello");
    expect(update.duration).toBe(93);
    // Anything another writer owns is not in the update at all.
    expect('toolTimeline' in update).toBe(false);
    expect('patientName' in update).toBe(false);
    expect('ticketNumber' in update).toBe(false);
  });

  it("carries the transcript through unchanged", () => {
    expect(toCallLogRow(record()).transcript).toBe("CALLER: Hi\nAGENT: Hello");
  });

  it("never returns a negative duration when the clocks disagree", () => {
    const row = toCallLogRow(record({ startedAtMs: 2_000, endedAtMs: 1_000 }));
    expect(row.duration).toBe(0);
  });
});


describe("persistRuntimeCall", () => {
  it("sends the NARROW update to the database, not the whole row", async () => {
    // Asserting toConflictUpdate on its own never proved the writer used
    // it: a mutation restoring `set: row` passed all 205 tests.
    const upsert = vi.fn(async () => {});
    const ok = await persistRuntimeCall(record(), { patientName: "Test Patient" }, upsert);
    expect(ok).toBe(true);
    const [row, update] = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // The insert carries identity; the conflict update must not.
    expect(row.patientName).toBe("Test Patient");
    expect("patientName" in update).toBe(false);
    expect("toolTimeline" in update).toBe(false);
    expect(update.transcript).toBe("CALLER: Hi\nAGENT: Hello");
  });

  it("reports failure instead of throwing, and never logs the transcript", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    try {
      const ok = await persistRuntimeCall(record(), {}, async () => {
        throw new Error("db down");
      });
      expect(ok).toBe(false);
      // A transcript in an error log is patient data somewhere nobody watches.
      expect(JSON.stringify(errors)).not.toContain("CALLER: Hi");
    } finally {
      spy.mockRestore();
    }
  });
});
