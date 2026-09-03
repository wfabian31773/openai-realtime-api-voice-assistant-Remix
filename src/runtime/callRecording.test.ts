/**
 * THE GREETING'S PROMISE, MADE TRUE — task #54.
 *
 * The no-IVR greeting says "All calls are being recorded for quality assurance
 * purposes" and `missingMandatoryCopy` refuses a greeting that drops it. The
 * runtime recorded nothing, so on the after-hours line that sentence was going
 * to be false. The operator chose to add the recording rather than change the
 * words (2026-09-02).
 *
 * These run the rules rather than read them. The three that matter are all
 * consequences of the caller being on the line: it never blocks, it never
 * throws, and it never fails silently.
 */
import { describe, it, expect, vi } from "vitest";
import {
  NO_RECORDING,
  RECORDING_STATUS_PATH,
  createRecordingStarter,
  recordingCallbackUrl,
  recordingConfigMissing,
  handleRecordingStatus,
  type MinimalRecordingClient,
} from "./callRecording";

const CALL = "CA" + "b".repeat(32);
const HOST = "voice.example.com";

const CONFIGURED = {
  TWILIO_ACCOUNT_SID: "ACxxxxxxxx",
  TWILIO_AUTH_TOKEN: "tok",
};

/** Captures what was asked of Twilio without needing the SDK. */
function fakeClient() {
  const create = vi.fn().mockResolvedValue({});
  const client: MinimalRecordingClient = {
    calls: (sid: string) => {
      calledWith.push(sid);
      return { recordings: { create } };
    },
  };
  const calledWith: string[] = [];
  return { client, create, calledWith };
}

/** The starter is fire-and-forget, so its work lands a microtask later. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("what recording needs before it can run", () => {
  it("names the missing variables rather than guessing", () => {
    expect(recordingConfigMissing({})).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
    ]);
    expect(recordingConfigMissing(CONFIGURED)).toEqual([]);
  });

  it("posts the callback to the host Twilio reached us on", () => {
    // Not a DOMAIN variable: that can drift from reality, and on the day it
    // does the recording vanishes silently.
    expect(recordingCallbackUrl(HOST)).toBe(`https://${HOST}${RECORDING_STATUS_PATH}`);
  });
});

describe("starting the recording", () => {
  it("records the call, with a completed-event callback", async () => {
    const { client, create, calledWith } = fakeClient();
    const start = createRecordingStarter({ env: CONFIGURED, client, log: () => {} });

    start(CALL, HOST);
    await settle();

    expect(calledWith).toEqual([CALL]);
    expect(create).toHaveBeenCalledWith({
      recordingStatusCallback: `https://${HOST}${RECORDING_STATUS_PATH}`,
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["completed"],
    });
  });

  it("returns without waiting for the REST call — the caller is waiting on TwiML", () => {
    // A Twilio request that never answers. The starter must still return, or a
    // slow API becomes dead air in front of the caller's first audio.
    //
    // Note what this does NOT assert: with a client already in hand the
    // request is *issued* synchronously, because evaluating the argument to
    // `await` happens before the suspension. Issuing is fine. WAITING is not,
    // and waiting is what this measures.
    const create = vi.fn().mockReturnValue(new Promise(() => {}));
    const client: MinimalRecordingClient = {
      calls: () => ({ recordings: { create } }),
    };
    const start = createRecordingStarter({ env: CONFIGURED, client, log: () => {} });

    let returned = false;
    start(CALL, HOST);
    returned = true;

    expect(returned).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("never throws when Twilio refuses — a caller does not lose a call over this", async () => {
    const create = vi.fn().mockRejectedValue(new Error("21220 call is not in-progress"));
    const client: MinimalRecordingClient = {
      calls: () => ({ recordings: { create } }),
    };
    const lines: string[] = [];
    const start = createRecordingStarter({ env: CONFIGURED, client, log: (l) => lines.push(l) });

    expect(() => start(CALL, HOST)).not.toThrow();
    await settle();

    // And it is loud: a silent failure is exactly the bug #54 is about — the
    // agent promising a recording that does not exist with nothing saying so.
    expect(lines.join("\n")).toMatch(/FAILED to start recording/);
    expect(lines.join("\n")).toContain(CALL);
    expect(lines.join("\n")).toMatch(/told this caller the call is being recorded/i);
  });

  it("says so loudly when it is not configured, instead of quietly doing nothing", async () => {
    const lines: string[] = [];
    const start = createRecordingStarter({ env: {}, log: (l) => lines.push(l) });

    start(CALL, HOST);
    await settle();

    expect(lines.join("\n")).toMatch(/NOT recording/);
    expect(lines.join("\n")).toContain("TWILIO_ACCOUNT_SID");
    expect(lines.join("\n")).toMatch(/it is not/i);
  });

  it("logs the success too, so a live call can be checked without Twilio", async () => {
    const { client } = fakeClient();
    const lines: string[] = [];
    const start = createRecordingStarter({ env: CONFIGURED, client, log: (l) => lines.push(l) });

    start(CALL, HOST);
    await settle();

    expect(lines.join("\n")).toMatch(/✓ recording started/);
    expect(lines.join("\n")).toContain(CALL);
  });

  it("NO_RECORDING does nothing and does not throw", () => {
    expect(() => NO_RECORDING(CALL, HOST)).not.toThrow();
  });
});

/**
 * THE CALLBACK THE OLD CORE COULD NOT SERVE.
 *
 * `/api/voice/recording-status` on the old core is conference-keyed: its guard
 * is `recordingUrl && status === 'completed' && conferenceSid`. A call-level
 * recording posts CallSid and NO ConferenceSid, so that handler would have
 * accepted the callback and silently attached nothing — the recording would
 * live in Twilio and never reach the ticket. That is why the runtime has its
 * own, keyed on CallSid.
 */
describe("attaching the finished recording", () => {
  const URL_ = "https://api.twilio.com/rec/RE123";

  it("attaches a completed recording by CallSid", () => {
    const r = handleRecordingStatus({
      CallSid: CALL,
      RecordingUrl: URL_,
      RecordingStatus: "completed",
    });
    expect(r.status).toBe(200);
    expect(r.persist).toEqual({ callSid: CALL, recordingUrl: URL_ });
  });

  it("attaches nothing for a status that is not completed", () => {
    const r = handleRecordingStatus({
      CallSid: CALL,
      RecordingUrl: URL_,
      RecordingStatus: "in-progress",
    });
    expect(r.persist).toBeUndefined();
    expect(r.status).toBe(200);
  });

  it("does NOT require a ConferenceSid — the whole point of having our own", () => {
    // The old core's guard would have dropped exactly this payload.
    const r = handleRecordingStatus({
      CallSid: CALL,
      RecordingUrl: URL_,
      RecordingStatus: "completed",
    });
    expect(r.persist?.callSid).toBe(CALL);
  });

  it("says so loudly when a completed recording cannot be attached", () => {
    const noSid = handleRecordingStatus({ RecordingUrl: URL_, RecordingStatus: "completed" });
    expect(noSid.persist).toBeUndefined();
    expect(noSid.log).toMatch(/no CallSid/);

    const noUrl = handleRecordingStatus({ CallSid: CALL, RecordingStatus: "completed" });
    expect(noUrl.persist).toBeUndefined();
    expect(noUrl.log).toMatch(/no RecordingUrl/);
  });

  it("always answers 2xx — a retry storm from Twilio helps nobody", () => {
    for (const body of [
      {},
      { RecordingStatus: "failed" },
      { CallSid: CALL, RecordingStatus: "completed" },
      { CallSid: CALL, RecordingUrl: URL_, RecordingStatus: "completed" },
    ]) {
      expect(handleRecordingStatus(body).status).toBe(200);
    }
  });
});
