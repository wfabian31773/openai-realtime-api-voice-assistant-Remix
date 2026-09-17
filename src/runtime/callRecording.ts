/**
 * src/runtime/callRecording.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * START A TWILIO RECORDING ON A RUNTIME CALL.
 *
 * MEASURED 2026-09-17: `recording_url` is NULL on every one of the 4,564
 * runtime calls since the 2026-09-03 cutover. The old core records by
 * `<Conference record="record-from-start">`; `<Connect><Stream>` has no
 * such attribute, and nothing on this side ever asked Twilio to record. So
 * the four queue lanes and pcp — which as of v39 open every call with "All
 * calls are being recorded for quality assurance purposes" — were not.
 * That is the disclosure being false in the other direction, and it is also
 * why the Observatory's call page has no audio for any runtime call, and why
 * every v41 status note that says "the call recording has what they said"
 * pointed at nothing on these lanes.
 *
 * THE MECHANISM is Twilio's REST recording on an in-progress call:
 * `calls(sid).recordings.create(...)`. It works from the moment the media
 * stream's `start` frame arrives (the call is answered by then), records
 * BOTH parties in dual channels — which is what the page's stereo waveform
 * renders as agent and caller — and posts `RecordingUrl` + `CallSid` to the
 * same `/api/voice/recording-status` handler the old core's conference
 * recordings use. That handler now accepts a CallSid-keyed callback
 * (`recordingStatusTarget.ts`).
 *
 * NEVER ON THE CALL'S CRITICAL PATH. Fire-and-forget from `startCall`; a
 * failure is one console line and the call proceeds unrecorded, exactly as
 * every runtime call has to date. It never throws.
 *
 * COST, stated: Twilio recording is $0.0025/min plus storage, roughly $4 a
 * day at 1,500 runtime minutes — the same line item the old core has paid on
 * every call since it went live. This restores parity; it is not a new
 * policy.
 */

export const RECORDING_STATUS_PATH = "/api/voice/recording-status";

/** The slice of a Twilio client this needs, so tests can hand in a fake. */
export interface RecordingClient {
  calls(sid: string): {
    recordings: {
      create(opts: {
        recordingStatusCallback: string;
        recordingStatusCallbackEvent: string[];
        recordingStatusCallbackMethod: string;
        recordingChannels: "dual" | "mono";
      }): Promise<{ sid?: string }>;
    };
  };
}

export type RecordingStart = "started" | "failed" | "skipped";

export function recordingCallbackUrl(host: string): string {
  return `https://${host}${RECORDING_STATUS_PATH}`;
}

export async function startCallRecording(
  client: RecordingClient | null,
  callSid: string,
  host: string | undefined,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<RecordingStart> {
  if (!client) {
    log(`[RECORDING] not started for ${callSid} — no Twilio credentials in this process`);
    return "skipped";
  }
  if (!host) {
    log(`[RECORDING] not started for ${callSid} — no public host to name the status callback`);
    return "skipped";
  }
  try {
    const rec = await client.calls(callSid).recordings.create({
      recordingStatusCallback: recordingCallbackUrl(host),
      recordingStatusCallbackEvent: ["completed"],
      recordingStatusCallbackMethod: "POST",
      recordingChannels: "dual",
    });
    log(`[RECORDING] started ${rec.sid ?? "(no sid)"} on ${callSid}`);
    return "started";
  } catch (error) {
    log(`[RECORDING] failed to start on ${callSid}: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/**
 * The production client, built once and only if credentials exist. Lazy for
 * the same reason `runtimeTransfer` is: an unconfigured process must still
 * boot and answer its health check.
 */
export function makeRecordingStarter(env: Record<string, string | undefined>) {
  let client: RecordingClient | null | undefined;
  return async (callSid: string, host: string | undefined): Promise<RecordingStart> => {
    if (client === undefined) {
      if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
        const twilio = (await import("twilio")).default;
        client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) as unknown as RecordingClient;
      } else {
        client = null;
      }
    }
    return startCallRecording(client, callSid, host ?? env.DOMAIN);
  };
}
