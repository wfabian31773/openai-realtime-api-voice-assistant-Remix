/**
 * The sweep is the floor under every gate. These pin the two things that make
 * it safe to run on every call: it files the right payload, and it cannot take
 * a call down when it fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runRequestSweep, type SweepFiler } from "./sweepRunner";
import type { VoiceCallRecord, ToolEvent } from "./mediaStreamBridge";
import { rememberVerifiedIdentity, resetVerifiedIdentities } from "../tools/verifiedIdentity";

const SID = "CA00000000000000000000000000000042";

function record(over: Partial<VoiceCallRecord> = {}): VoiceCallRecord {
  return {
    callSid: SID,
    streamSid: "MZ0000000000000000000000000000000",
    slug: "tech",
    callerPhone: "+15555550100",
    dialedNumber: "+15555550199",
    outcome: "completed",
    transcript: "AGENT: How can I help?\nCALLER: I need a refill on my drops.",
    toolEvents: [],
    agentTurns: 2,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 61_000,
    ...over,
  };
}

function tool(name: string, succeeded: boolean, foundOpenTicket?: boolean): ToolEvent {
  return {
    name,
    ok: true,
    succeeded,
    atMs: 100,
    ...(foundOpenTicket === undefined ? {} : { foundOpenTicket }),
  };
}

function filer(): SweepFiler & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (ticket: unknown) => {
    calls.push(ticket);
    return { success: true, ticketNumber: "VA-99001" };
  }) as SweepFiler & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  resetVerifiedIdentities();
  rememberVerifiedIdentity(SID, {
    firstName: "Testpatient",
    lastName: "Example",
    dateOfBirth: "1950-01-02",
  });
});

afterEach(() => {
  resetVerifiedIdentities();
  vi.restoreAllMocks();
});

describe("recovering a request the agent did not file", () => {
  it("files it, on the queue the call arrived on", async () => {
    const file = filer();
    const out = await runRequestSweep(record(), file);
    expect(out).toEqual({ filed: true, ticketNumber: "VA-99001" });
    expect(file.calls).toHaveLength(1);
    const t = file.calls[0] as Record<string, unknown>;
    expect(t.departmentId).toBe(3); // tech
    expect(t.slug).toBe("tech");
    expect(t.patientFirstName).toBe("Testpatient");
    expect(t.patientPhone).toBe("+15555550100");
    expect(t.priority).toBe("high");
    expect(String(t.description)).toContain("I need a refill on my drops.");
  });

  /**
   * The bug this wiring found. A refused `file_*_ticket` comes back
   * `ok: true` from dispatch, so a sweep reading `ok` would have called it
   * filed and skipped the recovery on exactly the calls it exists for. The
   * bridge now records `succeeded` and this is what proves the runner passes
   * it through.
   */
  it("recovers after a filing tool was REFUSED, not just after none ran", async () => {
    const file = filer();
    const out = await runRequestSweep(
      record({ toolEvents: [tool("lookup_patient", true), tool("file_tech_ticket", false)] }),
      file,
    );
    expect(out.filed).toBe(true);
  });

  /**
   * THE RUNNER HAS TO PASS THE FINDING THROUGH, not just the verdict.
   *
   * decideSweep's own tests prove the rule; these prove the mapping, because
   * a runner that dropped `foundOpenTicket` would silently restore the round-1
   * regression — the sweep would go back to firing on callers whose request
   * the agent already handled, and nothing would look wrong (Codex, PR #268
   * rounds 1 and 2).
   */
  it("leaves a caller who was READ their existing ticket alone", async () => {
    const file = filer();
    const out = await runRequestSweep(
      record({
        toolEvents: [tool("lookup_patient", true), tool("check_open_tickets", true, true)],
      }),
      file,
    );
    expect(out).toEqual({ filed: false, reason: "status-check" });
    expect(file.calls).toHaveLength(0);
  });

  it("STILL recovers the ordinary call where the check found nothing", async () => {
    const file = filer();
    const out = await runRequestSweep(
      record({
        toolEvents: [
          tool("lookup_patient", true),
          tool("check_open_tickets", true, false),
          tool("file_tech_ticket", false),
        ],
      }),
      file,
    );
    expect(out.filed).toBe(true);
  });

  it("does nothing when a filing tool actually succeeded", async () => {
    const file = filer();
    const out = await runRequestSweep(
      record({ toolEvents: [tool("file_tech_ticket", true)] }),
      file,
    );
    expect(out).toEqual({ filed: false, reason: "already-filed" });
    expect(file.calls).toHaveLength(0);
  });

  it("uses the same idempotency key the agent's own tools use", async () => {
    // So a filing POST still sitting in the outbox and this sweep collapse to
    // one ticket instead of two.
    const file = filer();
    await runRequestSweep(record(), file);
    expect((file.calls[0] as Record<string, unknown>).idempotencyKey).toBe(`call-${SID}`);
  });
});

describe("no name, no ticket", () => {
  it("does not file when nobody was identified, and says so loudly", async () => {
    resetVerifiedIdentities();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = filer();
    const out = await runRequestSweep(record(), file);
    expect(out).toEqual({ filed: false, reason: "no-name" });
    expect(file.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("needs a callback");
  });

  it("skips a greeting-only hangup quietly", async () => {
    const file = filer();
    const out = await runRequestSweep(
      record({ transcript: "AGENT: Thank you for calling." }),
      file,
    );
    expect(out).toEqual({ filed: false, reason: "caller-said-nothing" });
  });

  it("skips a lane that is not a queue", async () => {
    const file = filer();
    const out = await runRequestSweep(record({ slug: "no-ivr" }), file);
    expect(out).toEqual({ filed: false, reason: "not-a-queue-lane" });
    expect(file.calls).toHaveLength(0);
  });
});

describe("it cannot take a call down", () => {
  it("swallows a filer that throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: SweepFiler = async () => {
      throw new Error("ticketing unreachable");
    };
    await expect(runRequestSweep(record(), boom)).resolves.toEqual({
      filed: false,
      reason: "threw",
    });
  });

  it("reports a refused create without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse: SweepFiler = async () => ({ success: false, error: "HTTP 400" });
    await expect(runRequestSweep(record(), refuse)).resolves.toEqual({
      filed: false,
      reason: "create-failed",
    });
  });
});

describe("PHI never reaches a log line", () => {
  it("logs a lane, a call reference and nothing about the patient", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await runRequestSweep(
      record({ transcript: "AGENT: Name?\nCALLER: Testpatient Example, 555-0100, I need drops." }),
      filer(),
    );
    const logged = info.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[REQUEST SWEEP]");
    expect(logged).toContain(SID);
    for (const secret of ["Testpatient", "Example", "555-0100", "+15555550100", "drops"]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});
