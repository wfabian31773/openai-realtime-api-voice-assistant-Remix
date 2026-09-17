/**
 * THE RECORDING PUSH IS PARTIAL AND NEVER MARKS THE CALL DELIVERED —
 * Codex P1 (#321 round 1) and P2 (round 3), the same fact twice.
 *
 * `ticketingSyncService` selects rows with `callDataSynced = false` and sends
 * the FULL payload, recordingUrl included, off the row. Round 1: the recording
 * push used to set that flag, so a runtime ticket got a recording and nothing
 * else. Round 3: the round-1 fix let the sync carry the URL and pushed from
 * here only on an already-synced call, which lost the URL whenever the sync
 * had already snapshotted the call — neither side sent it. Now: push every
 * time, never touch the flag. Read from source, because the helper is a
 * closure inside the route file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const routes = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");
const start = routes.indexOf("const pushRecordingToTicketing = async");
const end = routes.indexOf("console.info(`[RECORDING] Conference ${conferenceSid} recording", start);
const helper = routes.slice(start, end);

describe("pushRecordingToTicketing", () => {
  it("exists where the sync test expects it", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("pushes the URL on every call, with no plan gate in front of it", () => {
    expect(helper).toMatch(/updateTicketCallData\(\{/);
    expect(helper).toMatch(/recordingUrl: recordingUrl/);
    expect(helper).not.toMatch(/leave_for_sync|recordingDeliveryPlan/);
    expect(routes).not.toMatch(/from '\.\/services\/recordingDelivery'/);
  });

  it("has no early return between finding the ticket and pushing — a re-worded gate cannot hide", () => {
    const identityCheck = helper.indexOf("skipping ticketing push");
    const push = helper.indexOf("updateTicketCallData(");
    expect(identityCheck).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(identityCheck);
    const between = helper.slice(helper.indexOf("return;", identityCheck) + "return;".length, push);
    expect(between).not.toMatch(/\breturn\b/);
  });

  it("never marks the call delivered — that flag belongs to the full-payload sync", () => {
    expect(helper).not.toContain("callDataSynced: true");
  });

  it("re-opens the sync ONLY when a push fails on a row the sync already finished — Codex P2, round 10", () => {
    // The one flag write on this path, and it only ever clears.
    const writes = [...helper.matchAll(/updateCallLog\([^)]*callDataSynced: (true|false)/g)];
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toBe("false");
    const push = helper.indexOf("updateTicketCallData(");
    const decision = helper.indexOf("afterRecordingPush(delivered, callLog.callDataSynced === true) === 'reopen_sync'");
    const reopen = helper.indexOf("updateCallLog(callLogId, { callDataSynced: false, ticketingSyncRetries: 0 })");
    expect(decision).toBeGreaterThan(push);
    expect(reopen).toBeGreaterThan(decision);
    // And the retry count goes with it (Codex P2, round 11): the sync's
    // selector reads `< MAX_RETRIES` and its success write stores the attempt
    // number, so a row that synced on its third attempt would otherwise be
    // re-opened and never selected.
    expect(helper).not.toMatch(/updateCallLog\(callLogId, \{ callDataSynced: false \}\)/);
    // A push that throws is a failed push: `delivered` stays false past the catch.
    expect(helper).toMatch(/let delivered = false;[\s\S]*?delivered = result\.success;/);
  });
});
