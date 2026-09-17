import { describe, it, expect } from "vitest";
import { afterRecordingPush } from "./recordingPushOutcome";

describe("afterRecordingPush — Codex P2 on #321, round 10", () => {
  it("a delivered push needs nothing, synced or not", () => {
    expect(afterRecordingPush(true, true)).toBe("delivered");
    expect(afterRecordingPush(true, false)).toBe("delivered");
  });
  it("a failed push on a row the sync has NOT finished is carried by the sync", () => {
    expect(afterRecordingPush(false, false)).toBe("sync_will_carry");
  });
  it("a failed push on a row the sync already finished re-opens the sync — the URL has no other path", () => {
    expect(afterRecordingPush(false, true)).toBe("reopen_sync");
  });
});
