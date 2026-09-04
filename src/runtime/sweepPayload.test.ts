/**
 * WHAT THE SWEEP ACTUALLY SENDS TO create-ticket.
 *
 * `sweepRunner.test.ts` stops at the SweptTicket; this goes one layer further
 * and captures the real payload, because the mapping in between is where the
 * patient-facing leak lived and where a silent regression would hide.
 *
 * The description becomes the body of a text message to the caller
 * (`docs/BACKEND_HANDOFF.md` section 6, and `opticalTools` sanitizes it to
 * GSM-7 for that reason). The recovery annotation, the call reference and the
 * caller's own transcript were all going into it (Codex, PR #268 round 5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";

const createTicketDurable = vi.fn(async (_payload: Record<string, unknown>) => ({
  success: true as const,
  ticketNumber: "VA-90501",
}));
vi.mock("../services/durableTicketFiling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/durableTicketFiling")>();
  return { ...actual, createTicketDurable };
});

const { runRequestSweep } = await import("./sweepRunner");
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import(
  "../tools/verifiedIdentity"
);
import type { VoiceCallRecord } from "./mediaStreamBridge";
import { SWEPT_TICKET_DESCRIPTION } from "./requestSweep";

const SID = "CA00000000000000000000000000000042";
const PHONE = "+15555550100";

const record = (): VoiceCallRecord =>
  ({
    callSid: SID,
    streamSid: "MZ0000000000000000000000000000000",
    slug: "tech",
    callerPhone: PHONE,
    dialedNumber: "+15555550199",
    outcome: "completed",
    transcript: "AGENT: How can I help?\nCALLER: I need a refill on my drops.",
    toolEvents: [{ name: "file_tech_ticket", ok: true, succeeded: false, atMs: 10 }],
    agentTurns: 2,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 61_000,
  }) as VoiceCallRecord;

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

describe("the payload a swept request produces", () => {
  const filed = async () => {
    await runRequestSweep(record());
    const calls = createTicketDurable.mock.calls;
    return calls[calls.length - 1]?.[0] as any;
  };

  /**
   * THIS TEST USED TO ASSERT THE BUG, and it is the one that mattered most
   * because it reads the payload that actually leaves.
   *
   * Round 5 pinned "the caller's own words" in the description on the
   * reasoning that the four ordinary filing tools do the same. They do not:
   * their description is written by the MODEL, which has isolated the
   * request from the rest of the call. The sweep runs at teardown with no
   * model, and its `callerSaid` is every CALLER line joined — so this pin
   * was guarding the identity interview's passage into a patient-facing SMS,
   * the caller's name and full date of birth among it (Codex, PR #268
   * round 14).
   */
  it("puts NOTHING from the call in the patient-facing description", async () => {
    const p = await filed();
    expect(p.description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(String(p.description)).not.toContain("I need a refill on my drops");
    // The fixture's own PHI, named rather than checked by shape — a shape
    // check is exactly what let the leak stand for two rounds.
    expect(String(p.description)).not.toContain("Testpatient");
    expect(String(p.description)).not.toContain("Example");
    expect(String(p.description)).not.toContain("1950");
  });

  it("still gets the caller's own words to STAFF, so the ticket stays actionable", async () => {
    const p = await filed();
    expect(String(p.callData?.transcript ?? "")).toContain("I need a refill on my drops");
  });

  it("keeps the recovery annotation and the call reference OUT of it", async () => {
    const p = await filed();
    expect(String(p.description)).not.toContain(SID);
    expect(String(p.description)).not.toContain("Recovered");
    expect(String(p.description)).not.toContain("did not file");
    expect(String(p.description)).not.toContain(PHONE);
  });

  /** The mapping H2 mutated: dropping this sends the annotation nowhere. */
  it("DOES send the annotation staff-side, so the recovery is not invisible", async () => {
    const p = await filed();
    const staff = String(p.callData?.transcript ?? "");
    expect(staff).toContain("Recovered at teardown");
    expect(staff).toContain(SID);
    expect(staff).toContain(PHONE);
  });

  it("still carries the number as a structured field, where it belongs", async () => {
    expect((await filed()).patientPhone).toBe(PHONE);
  });
});

/**
 * THE CONVERSION, which is where the outbox outcome was being lost.
 *
 * `createTicketDurable` answers `success: false, queued: true` when the
 * ticketing API is unreachable and the outbox took the payload. The runner's
 * own tests use a filer double and therefore skip this mapping entirely —
 * the same blind spot that hid the staff-note drop and `foundOpenTicket`
 * (Codex, PR #268 round 6).
 */
describe("when the ticketing app is down and the outbox takes it", () => {
  it("counts as recovered, with no ticket number invented", async () => {
    createTicketDurable.mockResolvedValueOnce({
      success: false,
      queued: true,
    } as never);
    const out = await runRequestSweep(record());
    expect(out.filed).toBe(true);
    expect(out.ticketNumber).toBeUndefined();
  });

  it("a genuine refusal is still a failure", async () => {
    createTicketDurable.mockResolvedValueOnce({
      success: false,
      error: "Validation failed",
    } as never);
    const out = await runRequestSweep(record());
    expect(out).toEqual({ filed: false, reason: "create-failed" });
  });
});
