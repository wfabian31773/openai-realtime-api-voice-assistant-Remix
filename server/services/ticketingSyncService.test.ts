import { describe, it, expect } from "vitest";
import {
  isNoTicketError,
  classifyNoTicketOutcome,
  NO_TICKET_TERMINAL_PREFIX,
} from "./ticketingSyncPolicy";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('the sweeper selects on data delivery, not on ticket existence', () => {
  // The defect this replaces, measured 2026-08-12 over 30 consecutive calls:
  // we held a transcript for 30/30; the ticket had one for 19/30. On 37% of
  // calls the optician saw no recording, no transcript and no summary while we
  // held the entire conversation.
  //
  // Cause: `ticketing_synced` is set when the TICKET is created, which happens
  // during the call. The transcript only exists after the call ends. Selecting
  // on that flag therefore excluded every call that filed a ticket — precisely
  // the population that needs sweeping — and the single post-call push has no
  // retry, so one transient failure lost the data permanently.
  //
  // These read the source rather than the behaviour. The query is built with
  // Drizzle expressions that are awkward to execute in a unit test, and the
  // thing worth pinning is WHICH COLUMN it asks about — a distinction the
  // existing eight tests pass either way, which is how this shipped broken.
  const SRC = readFileSync(join(__dirname, 'ticketingSyncService.ts'), 'utf8');
  const SELECTION = SRC.slice(
    SRC.indexOf('.where('),
    SRC.indexOf('.limit(20)'),
  );

  it('filters on callDataSynced', () => {
    expect(
      SELECTION.includes('callLogs.callDataSynced'),
      'the sweeper must select on whether the DATA landed',
    ).toBe(true);
  });

  it('does not filter on ticketingSynced', () => {
    expect(
      SELECTION.includes('callLogs.ticketingSynced'),
      'ticketingSynced is true from the moment the ticket is created, mid-call — ' +
        'selecting on it excludes exactly the calls whose data has not arrived yet',
    ).toBe(false);
  });

  it('sets callDataSynced only after a successful push', () => {
    // It must be written inside the `response.success` branch, alongside
    // ticketingSyncedAt — not on failure, and not optimistically before.
    const successBranch = SRC.slice(
      SRC.indexOf('if (response.success)'),
      SRC.indexOf('console.log(`[TICKETING SYNC] ✓'),
    );
    expect(successBranch).toContain('callDataSynced: true');
  });

  it('leaves ticketingSynced doing its original job', () => {
    // Nothing else should change meaning. It still marks "a ticket exists",
    // and other code reads it for that.
    expect(SRC).toContain('ticketingSynced: true');
  });
});
