import { describe, it, expect, vi } from "vitest";
import {
  toCallLogRow,
  toConflictUpdate,
  persistRuntimeCall,
  openRuntimeCall,
} from "./callRecord";
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

  it("marks the row as Grok-served, so OpenAI cost estimation skips it", () => {
    // Cost reconciliation prices any row with null token columns at the
    // OpenAI per-second rate, and every runtime row has null token columns.
    // Unmarked, a Grok call reports OpenAI spend that never happened —
    // against the very comparison the migration exists to make.
    expect(toCallLogRow(record()).voiceProvider).toBe("grok");
  });

  it("stores the exact outcome, which status cannot carry", () => {
    // status maps six endings onto completed/failed, and the runtime's
    // in-memory registry is consumed by the post-stream redirect. Without
    // this column "was that dead air or a provider failure?" is
    // unanswerable an hour later.
    expect(toCallLogRow(record({ outcome: "dead_air" })).runtimeOutcome).toBe("dead_air");
    expect(toCallLogRow(record({ outcome: "max_duration" })).runtimeOutcome).toBe("max_duration");
    expect(toCallLogRow(record({ outcome: "agent_ended" })).runtimeOutcome).toBe("agent_ended");
    // A ten-minute ceiling and a clean goodbye are both `completed` by
    // status; only this column tells them apart.
    expect(toCallLogRow(record({ outcome: "max_duration" })).status).toBe(
      toCallLogRow(record({ outcome: "agent_ended" })).status,
    );
  });

  it("writes the transcript timing the cutover gate is measured on", () => {
    const row = toCallLogRow(
      record({
        startedAtMs: 1_000_000,
        firstTranscriptAtMs: 1_003_500,
        lastTranscriptAtMs: 1_090_000,
        endedAtMs: 1_093_000,
      }),
    );
    expect(row.firstTranscriptDelayMs).toBe(3_500);
    expect(row.postTranscriptTailMs).toBe(3_000);
    expect(row.transcriptWindowSeconds).toBe(87);
  });

  it("omits the timing columns when nothing was ever transcribed", () => {
    const row = toCallLogRow(record()) as unknown as Record<string, unknown>;
    expect("firstTranscriptDelayMs" in row).toBe(false);
    expect("postTranscriptTailMs" in row).toBe(false);
  });

  it("refreshes provider, outcome and timing on a conflict — they are the runtime's own", () => {
    const update = toConflictUpdate(
      toCallLogRow(
        record({
          outcome: "dead_air",
          startedAtMs: 1_000_000,
          firstTranscriptAtMs: 1_002_000,
          lastTranscriptAtMs: 1_005_000,
          endedAtMs: 1_010_000,
        }),
      ),
    ) as unknown as Record<string, unknown>;
    expect(update.voiceProvider).toBe("grok");
    expect(update.runtimeOutcome).toBe("dead_air");
    expect(update.firstTranscriptDelayMs).toBe(2_000);
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


describe("openRuntimeCall — the row has to exist while the call runs", () => {
  it("creates the row before any tool can fire", async () => {
    // flushAzulTimeline issues UPDATE ... WHERE call_sid = ?, then marks its
    // events flushed regardless of rows affected (toolTimeline.ts:559-569).
    // With no row yet, the per-tool flush hits nothing, the events are
    // marked done, the reaper will not repair them, and the timeline is
    // gone for good (Codex review, PR #227). The SIP path creates the row
    // at call start for exactly this reason.
    const insert = vi.fn(async () => "row-1");
    const claimedAtMs = Date.now() - 4_000; // stream claimed 4s before this insert runs
    const id = await openRuntimeCall(
      {
        callSid: "CA-1",
        slug: "optical",
        callerPhone: "+15551234567",
        dialedNumber: "+15559876543",
        agentVersion: "v1.4.0",
        startedAtMs: claimedAtMs,
      },
      insert,
    );
    // The id is returned, because the agents poll for it.
    expect(id).toBe("row-1");
    const [row] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.callSid).toBe("CA-1");
    expect(row.status).toBe("in_progress");
    expect(row.direction).toBe("inbound");
    expect(row.agentUsed).toBe("optical");
    expect(row.agentVersion).toBe("v1.4.0");
    expect(row.from).toBe("+15551234567");
    // The CLAIM time, not the insert time: this insert runs after the
    // precontext lookup and lane factory, and teardown derives `duration`
    // from the claim while never updating startTime on conflict — an
    // insertion-time startTime leaves endTime - startTime short by the
    // whole setup delay (Codex, PR #227 round 13).
    expect((row.startTime as Date).getTime()).toBe(claimedAtMs);
    // It must NOT pre-empt anything a later writer owns.
    expect("transcript" in row).toBe(false);
    expect("toolTimeline" in row).toBe(false);
    expect("patientName" in row).toBe(false);
  });

  it("never throws and never blocks the call when the insert fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const id = await openRuntimeCall(
        { callSid: "CA-2", slug: "optical", callerPhone: "", dialedNumber: "", startedAtMs: Date.now() },
        async () => {
          throw new Error("db down");
        },
      );
      expect(id).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a greeting-only call keeps its tail", () => {
  /**
   * The bridge fix that made firstTranscriptAtMs caller-only left this row
   * builder still dropping the tail one layer downstream: with no caller
   * transcript, postTranscriptTailMs vanished and gradeTailSafety fell back
   * to its no-data score (Codex, PR #227 round 12). The tail measures
   * silence after the final words, whoever spoke them.
   */
  it("derives postTranscriptTailMs from the last transcript alone", () => {
    const row = toCallLogRow({
      callSid: "CA1",
      slug: "optical",
      outcome: "caller_hangup",
      transcript: "AGENT: Hello? Is anyone there?",
      toolEvents: [],
      agentTurns: 1,
      interruptions: 0,
      startedAtMs: 1_000,
      endedAtMs: 61_000,
      lastTranscriptAtMs: 21_000,
      // No caller transcript ever arrived.
      firstTranscriptAtMs: undefined,
    } as never);

    expect(row.postTranscriptTailMs).toBe(40_000);
    // And no caller-latency number is fabricated for a caller who never spoke.
    expect(row.firstTranscriptDelayMs).toBeUndefined();
    expect(row.transcriptWindowSeconds).toBeUndefined();
  });

  it("keeps all three when the caller did speak", () => {
    const row = toCallLogRow({
      callSid: "CA1",
      slug: "optical",
      outcome: "completed",
      transcript: "CALLER: hi",
      toolEvents: [],
      agentTurns: 1,
      interruptions: 0,
      startedAtMs: 1_000,
      endedAtMs: 61_000,
      firstTranscriptAtMs: 5_000,
      lastTranscriptAtMs: 21_000,
    } as never);

    expect(row.firstTranscriptDelayMs).toBe(4_000);
    expect(row.postTranscriptTailMs).toBe(40_000);
    expect(row.transcriptWindowSeconds).toBe(16);
  });
});
