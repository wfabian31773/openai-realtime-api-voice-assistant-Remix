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
