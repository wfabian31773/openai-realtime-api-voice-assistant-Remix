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

  /**
   * The flag write survives ONLY inside the already-synced branch, where it is
   * a no-op — it stays so `ticketingSyncService.test.ts`'s rule (every
   * successful push records itself as delivered) holds without an exception.
   * What the Codex finding needed is that it be UNREACHABLE on a call the sync
   * has not handled: nothing before the `leave_for_sync` return may write it.
   */
  it("cannot mark a call synced before the sync has run — the only write sits behind the plan's early return", () => {
    const gate = helper.indexOf("=== 'leave_for_sync'");
    const ret = helper.indexOf("return;", gate);
    const write = helper.indexOf("callDataSynced: true");
    expect(gate).toBeGreaterThan(0);
    expect(write, "no delivery record in the already-synced branch").toBeGreaterThan(0);
    expect(write, "the flag is written before the plan is read").toBeGreaterThan(ret);
    expect(helper.slice(0, ret)).not.toContain("callDataSynced: true");
  });
});
