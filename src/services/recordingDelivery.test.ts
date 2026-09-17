/**
 * A recording callback never marks a call as synced — Codex P1 on #321.
 *
 * `ticketingSyncService` selects rows with `callDataSynced = false`; the old
 * helper pushed the recording URL alone and then set the flag, so any call
 * whose recording landed before the five-minute sweep never had its
 * transcript, duration or outcome sent. On the runtime the recording
 * completes at hangup, so that would have been every call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { recordingDeliveryPlan } from "./recordingDelivery";

describe("recordingDeliveryPlan", () => {
  it("before the sync has run, the row is enough — the sync carries the URL", () => {
    expect(recordingDeliveryPlan({ callDataSynced: false })).toBe("leave_for_sync");
    expect(recordingDeliveryPlan({ callDataSynced: null })).toBe("leave_for_sync");
    expect(recordingDeliveryPlan({})).toBe("leave_for_sync");
  });

  it("after the sync has run, nothing else will carry it, so the callback pushes", () => {
    expect(recordingDeliveryPlan({ callDataSynced: true })).toBe("push_now");
  });
});

describe("the recording-status handler follows the plan and never touches the flag — read from source", () => {
  const routes = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");
  const helper = routes.slice(
    routes.indexOf("const pushRecordingToTicketing = async"),
    routes.indexOf("console.info(`[RECORDING] Conference ${conferenceSid} recording"),
  );

  it("reads the plan before pushing", () => {
    expect(helper).toMatch(/recordingDeliveryPlan\(callLog\) === 'leave_for_sync'/);
    expect(routes).toMatch(/import \{ recordingDeliveryPlan \} from '\.\/services\/recordingDelivery'/);
  });

  it("never writes callDataSynced from the recording path", () => {
    expect(helper).not.toMatch(/updateCallLog\([^)]*callDataSynced: true/);
    expect(helper).not.toMatch(/callDataSynced: true/);
  });
});
