/**
 * AT TEARDOWN THE CALLER IS GONE, SO THE OFFICE / SURGEON ASK IS EXHAUSTED.
 *
 * Optical (1) routes by office and Surgery (2) by surgeon, and create-ticket
 * refuses a ticket in either that carries neither. That refusal is a question
 * for a caller on the line. The sweep and the setup-failure floor both file
 * after the caller has gone, so without the app's own unassigned exit
 * (`routingAskExhausted`) the refusal is final.
 *
 * MEASURED in `voice_agent_api_logs`, 2026-09-28..10-08: 36 optical and 51
 * surgery swept requests refused HTTP 400 for "Missing required information:
 * office" / "…: surgeon", against 2 and 3 accepted. Tech and records filed
 * every swept request in the same window. The floor's one optical filing,
 * on 2026-10-08, was refused for "office".
 *
 * These tests read the PAYLOAD THAT LEAVES — through the real runner and the
 * real floor, `createTicketDurable` mocked at its boundary — because both
 * ends of this chain already had tests and the mapping between them is where
 * a dropped field hides (failure mode 10: `sweepPayload.test.ts` exists for
 * exactly that reason).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";

const createTicketDurable = vi.fn(async (_payload: Record<string, unknown>) => ({
  success: true as const,
  ticketNumber: "VA-90601",
}));
vi.mock("../services/durableTicketFiling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/durableTicketFiling")>();
  return { ...actual, createTicketDurable };
});

const { runRequestSweep } = await import("./sweepRunner");
const { runSetupFailureFloor } = await import("./setupFailureFloor");
const { TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS } = await import("./requestSweep");
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import(
  "../tools/verifiedIdentity"
);
import type { VoiceCallRecord } from "./mediaStreamBridge";

const SID = "CA00000000000000000000000000000077";
const PHONE = "+15555550100";

const FILE_TOOL: Record<string, string> = {
  optical: "file_optical_ticket",
  surgery: "file_surgery_ticket",
  tech: "file_tech_ticket",
  records: "file_records_ticket",
};

const sweptCall = (slug: string): VoiceCallRecord =>
  ({
    callSid: SID,
    streamSid: "MZ0000000000000000000000000000000",
    slug,
    callerPhone: PHONE,
    dialedNumber: "+15555550199",
    outcome: "caller_hangup",
    transcript:
      "AGENT: How can I help?\nCALLER: I need someone to call me back about my order please.",
    toolEvents: [{ name: FILE_TOOL[slug], ok: true, succeeded: false, atMs: 10 }],
    agentTurns: 2,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 61_000,
  }) as VoiceCallRecord;

const silentSetup = (slug: string): VoiceCallRecord =>
  ({
    callSid: SID,
    streamSid: "MZ0000000000000000000000000000000",
    slug,
    callerPhone: PHONE,
    dialedNumber: "+15555550199",
    outcome: "provider_failure",
    transcript: "",
    toolEvents: [],
    agentTurns: 0,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 15_000,
  }) as VoiceCallRecord;

const lastPayload = () => {
  const calls = createTicketDurable.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  createTicketDurable.mockClear();
  resetVerifiedIdentities();
  rememberVerifiedIdentity(SID, {
    firstName: "Testpatient",
    lastName: "Example",
    dateOfBirth: "1950-01-02",
    certain: true,
  });
});

describe("the one set both teardown filers read", () => {
  it("is optical and surgery, and nothing else", () => {
    expect([...TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS].sort()).toEqual([1, 2]);
  });
});

describe("the teardown sweep", () => {
  it.each([
    ["optical", 1],
    ["surgery", 2],
  ] as const)("sends the unassigned exit on %s (department %i)", async (slug, departmentId) => {
    const out = await runRequestSweep(sweptCall(slug));
    expect(out.filed).toBe(true);
    const p = lastPayload();
    expect(p?.departmentId).toBe(departmentId);
    expect(p?.routingAskExhausted).toBe(true);
  });

  it.each(["tech", "records"])(
    "does not claim an exhausted ask on %s, which routes by nothing the call supplies",
    async (slug) => {
      await runRequestSweep(sweptCall(slug));
      const p = lastPayload();
      expect(p).toBeDefined();
      expect(p).not.toHaveProperty("routingAskExhausted");
    },
  );
});

describe("the setup-failure floor", () => {
  it.each([
    ["optical", 1],
    ["surgery", 2],
  ] as const)("sends the unassigned exit on %s (department %i)", async (slug, departmentId) => {
    const out = await runSetupFailureFloor(silentSetup(slug));
    expect(out.filed).toBe(true);
    const p = lastPayload();
    expect(p?.departmentId).toBe(departmentId);
    expect(p?.routingAskExhausted).toBe(true);
  });

  it.each(["tech", "records", "pcp", "no-ivr"])(
    "does not claim an exhausted ask on %s",
    async (slug) => {
      await runSetupFailureFloor(silentSetup(slug));
      const p = lastPayload();
      expect(p).toBeDefined();
      expect(p).not.toHaveProperty("routingAskExhausted");
    },
  );

  it("files nothing for a caller who hung up inside the first-event wait", async () => {
    const out = await runSetupFailureFloor(silentSetup("no-ivr"), {
      callerLeftAfterMs: 1_000,
    });
    expect(out).toEqual({ filed: false, reason: "left-before-the-first-event-wait" });
    expect(createTicketDurable).not.toHaveBeenCalled();
  });
});

/**
 * THE RUNTIME'S OWN DEFAULT, which the runtime suite cannot see: its harness
 * injects a `fileSetupFailure` of its own, so a default that dropped the
 * context survived every behavioural test (mutation run, v92). The floor's
 * signature IS `(record, ctx)`, so the default is the floor itself, unwrapped
 * — and this pin goes red the moment a wrapper is put back.
 */
describe("the runtime hands the floor its context", () => {
  it("uses runSetupFailureFloor itself as the default, with no wrapper to lose ctx", () => {
    const src = readFileSync(join(__dirname, "voiceRuntime.ts"), "utf8");
    expect(src).toMatch(/options\.fileSetupFailure \?\? runSetupFailureFloor;/);
  });
});
