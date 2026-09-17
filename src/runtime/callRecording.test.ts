/**
 * THE RUNTIME ASKS TWILIO TO RECORD THE CALL, AND NEVER LETS THAT ASK HURT THE CALL.
 *
 * recording_url was NULL on 4,564 of 4,564 runtime calls (2026-09-17) while
 * the lanes said "all calls are being recorded". See callRecording.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { startCallRecording, recordingCallbackUrl, RECORDING_STATUS_PATH, type RecordingClient } from "./callRecording";

function fakeClient(impl: (sid: string, opts: unknown) => Promise<{ sid?: string }>) {
  const calls: Array<{ sid: string; opts: unknown }> = [];
  const client: RecordingClient = {
    calls: (sid) => ({ recordings: { create: async (opts) => { calls.push({ sid, opts }); return impl(sid, opts); } } }),
  };
  return { client, calls };
}

describe("startCallRecording", () => {
  it("records both channels on the answered call and names the shared status callback", async () => {
    const { client, calls } = fakeClient(async () => ({ sid: "RE1" }));
    const lines: string[] = [];
    const r = await startCallRecording(client, "CA00000000000000000000000000000001", "runtime.example.com", (l) => lines.push(l));
    expect(r).toBe("started");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sid).toBe("CA00000000000000000000000000000001");
    expect(calls[0]!.opts).toEqual({
      recordingStatusCallback: "https://runtime.example.com/api/voice/recording-status",
      recordingStatusCallbackEvent: ["completed"],
      recordingStatusCallbackMethod: "POST",
      recordingChannels: "dual",
    });
    expect(lines.join("\n")).toMatch(/started RE1/);
  });

  it("the callback path is the old core's handler — one handler for both kinds of recording", () => {
    expect(RECORDING_STATUS_PATH).toBe("/api/voice/recording-status");
    expect(recordingCallbackUrl("h")).toBe("https://h/api/voice/recording-status");
  });

  it("a Twilio failure is one log line, never a throw", async () => {
    const { client } = fakeClient(async () => { throw new Error("21220: call not in progress"); });
    const lines: string[] = [];
    await expect(startCallRecording(client, "CA2", "h", (l) => lines.push(l))).resolves.toBe("failed");
    expect(lines.join("\n")).toMatch(/failed to start on CA2: 21220/);
  });

  it("no credentials or no host is a skip, said out loud, not an error", async () => {
    const lines: string[] = [];
    await expect(startCallRecording(null, "CA3", "h", (l) => lines.push(l))).resolves.toBe("skipped");
    const { client, calls } = fakeClient(async () => ({}));
    await expect(startCallRecording(client, "CA4", undefined, (l) => lines.push(l))).resolves.toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(2);
  });
});
