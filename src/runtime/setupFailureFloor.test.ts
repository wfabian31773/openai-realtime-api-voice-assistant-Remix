/**
 * THE SETUP-FAILURE FLOOR — files a callback when the session never started.
 *
 * The runtime wiring (every retry exhausted → persist → floor → apology)
 * lives in voiceRuntime.test.ts CA91B. This file pins the gates and the
 * payload so a skip or a stand-in name can go red here.
 */
import { describe, expect, it, vi } from "vitest";
import { SWEPT_TICKET_DESCRIPTION } from "./requestSweep";
import type { VoiceCallRecord } from "./mediaStreamBridge";
import {
  runSetupFailureFloor,
  SETUP_FAILURE_STAFF_NOTE,
  setupFailureIdempotencyKey,
  shouldFileSetupFailure,
} from "./setupFailureFloor";

function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: "CA000000000000000000000000000091b0",
    streamSid: "MZ91",
    slug: "optical",
    callerPhone: "+15551234567",
    dialedNumber: "+15557654321",
    outcome: "provider_failure",
    transcript: "",
    toolEvents: [],
    agentTurns: 0,
    interruptions: 0,
    startedAtMs: 1,
    endedAtMs: 2,
    ...over,
  } as VoiceCallRecord;
}

describe("shouldFileSetupFailure", () => {
  it("admits a silent provider_failure on a known lane with a callback number", () => {
    expect(shouldFileSetupFailure(record())).toBeNull();
  });

  it("skips a hangup that never reached the provider", () => {
    expect(shouldFileSetupFailure(record({ outcome: "caller_hangup" }))).toBe(
      "not-provider-failure",
    );
  });

  it("skips a call the agent already spoke on", () => {
    expect(shouldFileSetupFailure(record({ agentTurns: 1 }))).toBe("agent-spoke");
  });

  /**
   * THE FIRST-EVENT WAIT. 3 of the floor's 4 tickets in its first 30 days
   * were after-hours callers on the line for 1–2 s (VA-68899, VA-68900,
   * VA-69923). Inside the wait even a healthy session has not been declared
   * late, so a caller who HUNG UP by then left; they were not failed.
   */
  it.each([1_000, 2_000, 2_499])(
    "skips a caller who hung up %i ms in, before the default first-event wait",
    (ms) => {
      expect(shouldFileSetupFailure(record(), { callerLeftAfterMs: ms })).toBe(
        "left-before-the-first-event-wait",
      );
    },
  );

  it("files for a caller who hung up exactly at the wait, or later", () => {
    expect(shouldFileSetupFailure(record(), { callerLeftAfterMs: 2_500 })).toBeNull();
    expect(shouldFileSetupFailure(record(), { callerLeftAfterMs: 14_000 })).toBeNull();
  });

  it("reads the wait the call was CONFIGURED with, not the default", () => {
    expect(
      shouldFileSetupFailure(record(), { callerLeftAfterMs: 3_000, firstEventWaitMs: 5_000 }),
    ).toBe("left-before-the-first-event-wait");
    expect(
      shouldFileSetupFailure(record(), { callerLeftAfterMs: 120, firstEventWaitMs: 80 }),
    ).toBeNull();
  });

  /**
   * A SHORT CALL IS NOT A CALLER WHO LEFT. A setup that fails fast on OUR
   * side (the agent tree throwing) is short too, and that caller is still on
   * the line hearing the apology. The fixture here lasts 1 ms and files.
   */
  it("files a fast failure on our side, where the caller never hung up", () => {
    expect(shouldFileSetupFailure(record(), {})).toBeNull();
    expect(shouldFileSetupFailure(record(), { firstEventWaitMs: 2_500 })).toBeNull();
  });

  it("checks the wait AFTER the agent-spoke gate, so its skip reason stays honest", () => {
    expect(shouldFileSetupFailure(record({ agentTurns: 2 }), { callerLeftAfterMs: 500 })).toBe(
      "agent-spoke",
    );
  });

  it("runSetupFailureFloor honours the context and posts nothing", async () => {
    const filer = vi.fn(async () => ({ success: true, ticketNumber: "VA-1" }));
    const out = await runSetupFailureFloor(record(), filer, { callerLeftAfterMs: 1_000 });
    expect(out).toEqual({ filed: false, reason: "left-before-the-first-event-wait" });
    expect(filer).not.toHaveBeenCalled();
  });

  it("skips an unknown lane", () => {
    expect(shouldFileSetupFailure(record({ slug: "answering-service" }))).toBe(
      "unknown-lane",
    );
  });

  it("skips a withheld or empty caller ID", () => {
    expect(shouldFileSetupFailure(record({ callerPhone: "" }))).toBe("no-callback");
  });
});

describe("runSetupFailureFloor", () => {
  it("files optical as Other in department 1 with the stand-in name", async () => {
    const filer = vi.fn(async (ticket) => {
      return { success: true, ticketNumber: "VA-SETUP-1" };
    });
    const out = await runSetupFailureFloor(record(), filer);
    expect(out).toEqual({ filed: true, ticketNumber: "VA-SETUP-1" });
    expect(filer).toHaveBeenCalledTimes(1);
    expect(filer.mock.calls[0][0]).toMatchObject({
      departmentId: 1,
      requestTypeId: 66,
      requestReasonId: 536,
      patientFirstName: "Unnamed",
      patientLastName: "Caller",
      patientPhone: "+15551234567",
      description: SWEPT_TICKET_DESCRIPTION,
      priority: "high",
      slug: "optical",
      callSid: "CA000000000000000000000000000091b0",
      staffNote: SETUP_FAILURE_STAFF_NOTE,
      idempotencyKey: "call-CA000000000000000000000000000091b0-setup-failure",
    });
  });

  it.each([
    ["surgery", 2, 65, 535],
    ["tech", 3, 72, 542],
    ["records", 16, 77, 547],
    ["pcp", 18, 80, 550],
    ["no-ivr", 8, 68, 538],
  ] as const)(
    "routes %s to its own Other reason",
    async (slug, departmentId, requestTypeId, requestReasonId) => {
      const filer = vi.fn(async (_ticket: unknown) => ({
        success: true,
        ticketNumber: "VA-1",
      }));
      await runSetupFailureFloor(record({ slug }), filer);
      expect(filer.mock.calls[0][0]).toMatchObject({
        departmentId,
        requestTypeId,
        requestReasonId,
      });
    },
  );

  it("keys the ticket so a later real filing cannot collide", () => {
    expect(setupFailureIdempotencyKey("CA91B")).toBe("call-CA91B-setup-failure");
  });

  it("does not throw when the filer throws", async () => {
    const out = await runSetupFailureFloor(record(), async () => {
      throw new Error("ticketing app down");
    });
    expect(out).toEqual({ filed: false, reason: "threw" });
  });

  it("reports create-failed when the filer declines", async () => {
    const out = await runSetupFailureFloor(record(), async () => ({
      success: false,
      error: "timeout",
    }));
    expect(out).toEqual({ filed: false, reason: "create-failed" });
  });

  it("does not POST when a skip fires", async () => {
    const filer = vi.fn(async () => ({ success: true, ticketNumber: "VA-1" }));
    const out = await runSetupFailureFloor(
      record({ outcome: "caller_hangup" }),
      filer,
    );
    expect(out).toEqual({ filed: false, reason: "not-provider-failure" });
    expect(filer).not.toHaveBeenCalled();
  });

  it("says the name is a stand-in and sends the staffer to caller ID", () => {
    expect(SETUP_FAILURE_STAFF_NOTE).toMatch(/stand-in/i);
    expect(SETUP_FAILURE_STAFF_NOTE).toMatch(/caller ID/i);
    expect(SETUP_FAILURE_STAFF_NOTE).not.toMatch(/technical issue on my end/i);
  });
});
