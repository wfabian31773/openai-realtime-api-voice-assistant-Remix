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
    // The lookup, the write and the ticket push all go through landRecording
    // (Codex P2, round 7 — the park has to precede the lookup, and only the
    // lander holds that order), with storage handed in as its dependencies.
    expect(body).toMatch(/landRecording\(target\.callSid, recordingUrl, \{/);
    expect(body).toMatch(/findRow: \(sid\) => storage\.getCallLogBySid\(sid\)/);
    expect(body).toMatch(/writeUrl: \(id, url\) => storage\.updateCallLog\(id, \{ recordingUrl: url \}\)/);
    // The ticket gets the recording the same way a conference recording's does.
    expect(body).toMatch(/push: \(id, url\) => void pushRecordingToTicketing\(id, url\)/);
  });

  /**
   * SIGNED, OR NOTHING IS WRITTEN (Codex P1, #321). A CallSid is not a secret,
   * so the branch must check Twilio's signature BEFORE it reads or writes a
   * row, and refuse on anything but "valid" — the runtime's own fail-closed
   * check, not a second implementation.
   */
  it("the CallSid branch refuses an unsigned callback before it touches a row", () => {
    const handler = routes.slice(routes.indexOf(`app.post("/api/voice/recording-status"`));
    const branch = handler.indexOf("target?.by === 'call'");
    const body = handler.slice(branch, handler.indexOf("res.status(200).send('OK')", branch));
    const check = body.indexOf("checkTwilioSignature(");
    const read = body.indexOf("landRecording(target.callSid, recordingUrl");
    expect(check, "no signature check in the CallSid branch").toBeGreaterThan(0);
    expect(read, "no landing in the CallSid branch").toBeGreaterThan(0);
    expect(check).toBeLessThan(read);
    expect(body).toMatch(/if \(signature !== 'valid'\)/);
    expect(body.slice(check, read)).toMatch(/return res\.status\(403\)/);
    expect(body).toMatch(/import\('\.\/runtime\/voiceWebhook'\)/);
  });
});
