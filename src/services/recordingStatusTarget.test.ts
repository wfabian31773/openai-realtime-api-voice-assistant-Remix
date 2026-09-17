import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { recordingStatusTarget } from "./recordingStatusTarget";

const REC_URL = "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1";

describe("recordingStatusTarget", () => {
  it("a conference recording is keyed on the conference, as it always was", () => {
    expect(recordingStatusTarget({ RecordingStatus: "completed", RecordingUrl: REC_URL, ConferenceSid: "CF1", CallSid: "CA00000000000000000000000000000001" }))
      .toEqual({ by: "conference", conferenceSid: "CF1" });
  });

  it("a runtime call recording has no conference and is keyed on the CallSid", () => {
    expect(recordingStatusTarget({ RecordingStatus: "completed", RecordingUrl: REC_URL, CallSid: "CA00000000000000000000000000000001" }))
      .toEqual({ by: "call", callSid: "CA00000000000000000000000000000001" });
  });

  it("only a completed recording with a URL is a target", () => {
    expect(recordingStatusTarget({ RecordingStatus: "in-progress", RecordingUrl: REC_URL, CallSid: "CA00000000000000000000000000000001" })).toBeNull();
    expect(recordingStatusTarget({ RecordingStatus: "completed", CallSid: "CA00000000000000000000000000000001" })).toBeNull();
  });

  it("a sentinel CallSid is not a key — the canonical validator applies here too", () => {
    expect(recordingStatusTarget({ RecordingStatus: "completed", RecordingUrl: REC_URL, CallSid: "unknown" })).toBeNull();
    expect(recordingStatusTarget({ RecordingStatus: "completed", RecordingUrl: REC_URL, CallSid: "CAunknown" })).toBeNull();
  });
});

/**
 * THE WIRING, read from source — the device `ticketRequirements.test.ts`
 * uses. The helper above is pure and proves nothing about whether the
 * handler calls it (failure mode 10); the runtime's recording is worth
 * nothing if its callback lands on a handler that only reads ConferenceSid.
 */
describe("the old core's recording-status handler takes the CallSid-keyed callback", () => {
  const routes = readFileSync(new URL("../voiceAgentRoutes.ts", import.meta.url), "utf8");

  it("the runtime posts to the handler the old core already had, and the two agree on the path", async () => {
    const { RECORDING_STATUS_PATH } = await import("../runtime/callRecording");
    expect(routes).toContain(`app.post("${RECORDING_STATUS_PATH}"`);
  });

  it("the handler resolves the target through recordingStatusTarget and saves a CallSid recording onto the call row", () => {
    expect(routes).toMatch(/import \{ recordingStatusTarget \} from '\.\/services\/recordingStatusTarget'/);
    const handler = routes.slice(routes.indexOf(`app.post("/api/voice/recording-status"`));
    const branch = handler.indexOf("target?.by === 'call'");
    expect(branch, "no CallSid branch in the recording-status handler").toBeGreaterThan(0);
    const body = handler.slice(branch, handler.indexOf("res.status(200).send('OK')", branch));
    expect(body).toMatch(/getCallLogBySid\(target\.callSid\)/);
    expect(body).toMatch(/updateCallLog\(callLog\.id, \{ recordingUrl \}\)/);
    // The ticket gets the recording the same way a conference recording's does.
    expect(body).toMatch(/pushRecordingToTicketing\(callLog\.id, recordingUrl\)/);
  });
});
