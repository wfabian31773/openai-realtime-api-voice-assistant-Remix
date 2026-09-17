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

  it('marks a terminal no-ticket call under the flag the sweeper reads', () => {
    // Codex review, PR #172: setting only ticketingSynced here left these rows
    // eligible under the new predicate, so a call that will NEVER have a ticket
    // was retried until retries hit 3 — burning the 20-row batch on
    // deterministic 404s and contradicting the branch's own "will not retry".
    const terminal = SRC.slice(
      SRC.indexOf('=== "terminal"'),
      SRC.indexOf('marked terminal, will not retry'),
    );
    expect(terminal).toContain('callDataSynced: true');
  });

  it('reports the backlog the sweeper actually has', () => {
    // getSyncStatus counted ticketingSynced, so a call whose ticket exists but
    // whose transcript never arrived was reported SYNCED — hiding the exact
    // backlog the endpoint is for.
    const status = SRC.slice(SRC.indexOf('async getSyncStatus'));
    expect(status).toContain('callLogs.callDataSynced');
    expect(status).not.toContain('callLogs.ticketingSynced');
  });

  it('leaves ticketingSynced doing its original job', () => {
    // Nothing else should change meaning. It still marks "a ticket exists",
    // and other code reads it for that.
    expect(SRC).toContain('ticketingSynced: true');
  });
});

describe('a successful primary push must record itself as delivered', () => {
  // Codex review, PR #172, and the most consequential of the four: only the
  // sweeper's success branch wrote callDataSynced. The three primary post-call
  // pushes in voiceAgentRoutes logged success and wrote nothing, so every
  // healthy call stayed eligible and the sweeper re-pushed it five minutes
  // later. With a hard .limit(20) per cycle and ~600 calls a day, normal
  // traffic would have saturated the sweeper re-sending calls that already
  // landed — crowding out the failures it exists to recover, which is the exact
  // opposite of this change's purpose.
  const ROUTES = readFileSync(
    join(__dirname, '..', '..', 'src', 'voiceAgentRoutes.ts'),
    'utf8',
  );

  it('every FULL updateTicketCallData success branch marks the call delivered — and the recording push, a partial one, must not', () => {
    const sites = [...ROUTES.matchAll(/updateTicketCallData\(/g)].map((m) => m.index!);
    expect(sites.length, 'expected the three known push sites').toBeGreaterThanOrEqual(3);

    /**
     * THE ONE EXEMPTION, and it is the rule's own reasoning pointed the other
     * way. `pushRecordingToTicketing` sends ONLY a recording URL. If it
     * recorded delivery, the sweeper would never send the transcript,
     * duration and outcome for any call whose recording landed first — every
     * runtime call (Codex P1, #321 round 1). Letting the sweeper carry the
     * URL instead opened a race: a call already snapshotted into the
     * sweeper's batch when the URL landed was sent by neither side (Codex P2,
     * round 3). So that site pushes every time and never touches the flag;
     * the sweeper re-sends the URL once, with the rest, and marks the call.
     */
    const recStart = ROUTES.indexOf('const pushRecordingToTicketing = async');
    const recEnd = ROUTES.indexOf('console.info(`[RECORDING] Conference ${conferenceSid} recording', recStart);
    expect(recStart, 'the recording push helper is missing').toBeGreaterThan(0);
    expect(recEnd).toBeGreaterThan(recStart);
    expect(
      ROUTES.slice(recStart, recEnd).includes('callDataSynced: true'),
      'the recording push must never mark the call delivered — it carries the URL alone',
    ).toBe(false);

    for (const idx of sites) {
      if (idx > recStart && idx < recEnd) continue; // the partial push, asserted above
      // Look at the window following the call — the success branch and its body.
      const window = ROUTES.slice(idx, idx + 2600);
      expect(
        window.includes('callDataSynced: true'),
        `an updateTicketCallData site near offset ${idx} does not record delivery — ` +
          `the sweeper will re-push every call it succeeds on`,
      ).toBe(true);
    }
  });
});

describe('the mark-done is conditional on the recording the payload carried — Codex P2, #321 round 11', () => {
  // A recording can land on the row between this batch being selected and
  // the success write: the callback saves the URL, pushes it directly, and a
  // failed push reads a pre-push snapshot that still says the sync is coming
  // — with a payload built before the URL existed. Marking the row done here
  // would send the URL from neither side. So the success UPDATE matches only
  // while the row still holds what was sent, and a zero-row result leaves
  // the call pending, retries untouched, for the next pass to carry.
  //
  // Read from the source, as the selection pins above are: the query is a
  // Drizzle chain against a live `db` import. The statement itself was
  // PREPAREd against the Hub with the `::text` cast before it shipped —
  // the v52 lesson, a bare parameter beside NULL has no type to infer.
  const SRC = readFileSync(join(__dirname, 'ticketingSyncService.ts'), 'utf8');
  const start = SRC.indexOf('if (response.success) {');
  const end = SRC.indexOf('console.log(`[TICKETING SYNC] ✓ Successfully synced call', start);
  const SUCCESS = SRC.slice(start, end);

  it('the success write exists where expected', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('marks the row done only while it still holds the recording the payload carried', () => {
    expect(SUCCESS).toMatch(/callDataSynced: true/);
    expect(SUCCESS).toMatch(/\.where\(\s*and\(\s*eq\(callLogs\.id, call\.id\),\s*sql`\$\{callLogs\.recordingUrl\} IS NOT DISTINCT FROM \$\{call\.recordingUrl \?\? null\}::text`/);
  });

  it('a write that matched no row leaves the call pending rather than reporting it synced', () => {
    expect(SUCCESS).toMatch(/\.returning\(\{ id: callLogs\.id \}\)/);
    const zeroRows = SUCCESS.indexOf('if (marked.length === 0) {');
    expect(zeroRows).toBeGreaterThan(0);
    const branch = SUCCESS.slice(zeroRows, SUCCESS.indexOf('}', SUCCESS.indexOf('return {', zeroRows)) + 1);
    expect(branch).toMatch(/left pending/);
    expect(branch).not.toMatch(/callDataSynced/); // no second write in the branch
    expect(branch).toMatch(/return \{/);
  });

  it('the recording push re-opens the sync WITH its retry count reset, or a row that synced on its third attempt is never selected again', () => {
    const ROUTES = readFileSync(join(__dirname, '..', '..', 'src', 'voiceAgentRoutes.ts'), 'utf8');
    const recStart = ROUTES.indexOf('const pushRecordingToTicketing = async');
    const recEnd = ROUTES.indexOf('console.info(`[RECORDING] Conference ${conferenceSid} recording', recStart);
    const helper = ROUTES.slice(recStart, recEnd);
    expect(helper).toMatch(/updateCallLog\(callLogId, \{ callDataSynced: false, ticketingSyncRetries: 0 \}\)/);
    // The selector this reset exists for.
    expect(SRC).toMatch(/lt\(callLogs\.ticketingSyncRetries, MAX_RETRIES\)/);
    expect(SRC).toMatch(/const MAX_RETRIES = 3;/);
  });
});
