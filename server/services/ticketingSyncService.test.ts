import { describe, it, expect } from "vitest";
import {
  isNoTicketError,
  classifyNoTicketOutcome,
  NO_TICKET_TERMINAL_PREFIX,
} from "./ticketingSyncPolicy";

describe("isNoTicketError", () => {
  it("matches the ticketing app's 404 body for callSid lookups", () => {
    expect(
      isNoTicketError("No ticket found with callSid: CAf9a3208e2675b06dc72644b494ca0bfb")
    ).toBe(true);
  });

  it("matches ticketNumber lookups", () => {
    expect(isNoTicketError("No ticket found with ticketNumber: VA-46410")).toBe(true);
  });

  it("matches when wrapped by earlier retry prefixes", () => {
    expect(
      isNoTicketError("GAVE UP after 3 attempts: No ticket found with callSid: CA123")
    ).toBe(true);
  });

  it("does not match transient failures that deserve retries", () => {
    expect(isNoTicketError("Rate limit exceeded. Please try again later.")).toBe(false);
    expect(isNoTicketError("Database error occurred while updating ticket")).toBe(false);
    expect(isNoTicketError("fetch failed")).toBe(false);
    expect(isNoTicketError("Unauthorized: Invalid API key")).toBe(false);
  });
});

describe("classifyNoTicketOutcome", () => {
  const now = new Date("2026-07-30T04:00:00Z").getTime();

  it("is terminal once the outbox grace window has passed", () => {
    const endedAt = new Date(now - 16 * 60 * 1000);
    expect(classifyNoTicketOutcome(endedAt, now)).toBe("terminal");
  });

  it("stays in grace right after the call ends (outbox may still create the ticket)", () => {
    const endedAt = new Date(now - 2 * 60 * 1000);
    expect(classifyNoTicketOutcome(endedAt, now)).toBe("grace");
  });

  it("treats calls with no recorded end time as terminal (old re-swept rows)", () => {
    expect(classifyNoTicketOutcome(null, now)).toBe("terminal");
  });
});

describe("terminal marker", () => {
  it("is distinguishable from real sync failures", () => {
    expect(NO_TICKET_TERMINAL_PREFIX).toContain("NO_TICKET");
    expect(NO_TICKET_TERMINAL_PREFIX).not.toContain("GAVE UP");
  });
});
