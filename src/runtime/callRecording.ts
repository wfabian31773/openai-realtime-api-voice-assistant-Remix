/**
 * THE GREETING SAYS THE CALL IS BEING RECORDED. THIS IS WHAT MAKES THAT TRUE.
 *
 * Task #54, and it was the first blocker on the runtime for a reason. The
 * no-IVR greeting says "All calls are being recorded for quality assurance
 * purposes", and `missingMandatoryCopy` in greetingPersonalisation.ts REFUSES
 * a database greeting that has dropped that sentence — the disclosure is
 * enforced. But the runtime's TwiML is `<Connect><Stream>` plus a `<Redirect>`
 * and nothing else: it records nothing at all. The old core records the
 * conference from the first second (`record="record-from-start"`) and puts the
 * URL on the ticket.
 *
 * So on the runtime that sentence was going to be false, on the line the
 * operator uses as the after-hours agent, in a California medical practice
 * where the disclosure is how consent is obtained. He chose to add the
 * recording rather than change the words (2026-09-02), which also keeps both
 * pipelines telling patients the same thing while they run side by side.
 *
 * WHY A REST CALL AND NOT TWIML. `<Connect><Stream>` replaces the call, so
 * there is no `<Dial>` or `<Conference>` to hang a `record` attribute on.
 * Twilio's call-level recording is started against the live call instead, and
 * it captures both legs the same way the conference recording did.
 *
 * THREE RULES, and they all come from the caller being on the line while this
 * runs:
 *
 *   1. IT NEVER BLOCKS. The webhook's job is to return TwiML fast; a REST
 *      round trip in front of that is dead air. The starter is fire-and-forget
 *      and the webhook is synchronous.
 *   2. IT NEVER THROWS. A recording failure must not cost the caller their
 *      call. Everything is caught.
 *   3. IT FAILS LOUDLY. A silent no-op is exactly the bug this module exists
 *      to close — the agent would promise a recording that does not exist and
 *      nothing would say so. Every failure path logs with a marker.
 */

/** Where Twilio posts the finished recording. Served by the runtime itself. */
export const RECORDING_STATUS_PATH = "/voice/recording-status";

/**
 * Started against the live call, fire-and-forget.
 *
 * `host` is the host Twilio just called us on, taken from the same request
 * that produced the stream URL. Deliberately not a new env var: the callback
 * has to be reachable from Twilio, and the host that just reached us
 * demonstrably is — a DOMAIN variable can drift from reality, and on the day
 * it does the recording would vanish silently.
 */
export type RecordingStarter = (callSid: string, host: string) => void;

/** Does nothing, and says so. For lanes or deployments with no recording. */
export const NO_RECORDING: RecordingStarter = () => {};

/**
 * Env var NAMES (never values) needed to start a recording.
 *
 * `TWILIO_ACCOUNT_SID` is the one the runtime did not already demand:
 * `computeRuntimeReadiness` requires the auth token but not the account sid,
 * because until now nothing in the runtime made a REST call on the inbound
 * path. Recording does, so it joins the readiness gate — a line whose greeting
 * promises a recording is not ready to answer without the means to make one.
 */
export function recordingConfigMissing(
  env: Record<string, string | undefined>,
): string[] {
  const missing: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  return missing;
}

export function recordingCallbackUrl(host: string): string {
  return `https://${host}${RECORDING_STATUS_PATH}`;
}

/** The Twilio surface this needs, narrowed so tests do not need the SDK. */
export interface MinimalRecordingClient {
  calls(sid: string): {
    recordings: {
      create(opts: {
        recordingStatusCallback: string;
        recordingStatusCallbackMethod: string;
        recordingStatusCallbackEvent: string[];
      }): Promise<unknown>;
    };
  };
}

export interface RecordingStarterOptions {
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Injected for tests; the real one is built lazily from the env. */
  client?: MinimalRecordingClient;
}

/**
 * Build the starter. Lazy about the SDK for the same reason the transfer path
 * is: an unconfigured process still boots and still answers its health check.
 */
export function createRecordingStarter(
  opts: RecordingStarterOptions,
): RecordingStarter {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const missing = recordingConfigMissing(opts.env);

  if (missing.length > 0 && !opts.client) {
    return (callSid: string) => {
      log(
        `[RUNTIME RECORDING] ✗ NOT recording ${callSid} — missing ${missing.join(", ")}. ` +
          "The greeting tells this caller the call is being recorded and it is not.",
      );
    };
  }

  let client: MinimalRecordingClient | null = opts.client ?? null;

  return (callSid: string, host: string) => {
    // Fire-and-forget: the caller is waiting on the TwiML this webhook is
    // about to return, and a REST round trip in front of it is dead air.
    void (async () => {
      try {
        if (!client) {
          const twilio = (await import("twilio")).default;
          client = twilio(
            opts.env.TWILIO_ACCOUNT_SID,
            opts.env.TWILIO_AUTH_TOKEN,
          ) as unknown as MinimalRecordingClient;
        }
        await client.calls(callSid).recordings.create({
          recordingStatusCallback: recordingCallbackUrl(host),
          recordingStatusCallbackMethod: "POST",
          recordingStatusCallbackEvent: ["completed"],
        });
        log(`[RUNTIME RECORDING] ✓ recording started for ${callSid}`);
      } catch (error) {
        // Loud, because the alternative is an agent promising a recording that
        // does not exist and nothing anywhere saying so.
        log(
          `[RUNTIME RECORDING] ✗ FAILED to start recording for ${callSid}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "The greeting told this caller the call is being recorded.",
        );
      }
    })();
  };
}

/**
 * POST /voice/recording-status — where Twilio posts the finished recording.
 *
 * THE RUNTIME NEEDS ITS OWN, and this was the surprise in task #54. The old
 * core's `/api/voice/recording-status` is CONFERENCE-keyed: it reads
 * `ConferenceSid`, looks the call up in `conferenceNameToCallID`, and its
 * guard is `if (recordingUrl && status === 'completed' && conferenceSid)`. A
 * call-level recording posts `CallSid` and no `ConferenceSid` at all, so that
 * handler would have taken the callback and silently done nothing — the
 * recording would exist in Twilio and never reach the ticket.
 *
 * Pure, so the rule is tested by running it. The caller does the writing.
 */
export interface RecordingStatusBody {
  CallSid?: string;
  RecordingUrl?: string;
  RecordingStatus?: string;
  RecordingSid?: string;
}

export interface RecordingStatusResult {
  /** Always 2xx — a retry storm from Twilio helps nobody. */
  status: number;
  body: string;
  /** Present only when there is a finished recording to attach. */
  persist?: { callSid: string; recordingUrl: string };
  log: string;
}

export function handleRecordingStatus(
  body: RecordingStatusBody,
): RecordingStatusResult {
  const callSid = body.CallSid?.trim() ?? "";
  const recordingUrl = body.RecordingUrl?.trim() ?? "";
  const status = body.RecordingStatus?.trim() ?? "";

  if (status !== "completed") {
    return {
      status: 200,
      body: "ok",
      log: `[RUNTIME RECORDING] ${callSid || "unknown call"}: status '${status || "none"}' — nothing to attach yet`,
    };
  }
  if (!callSid || !recordingUrl) {
    // Loud: a completed recording we cannot attach is one staff will look for
    // on a disputed call and not find.
    return {
      status: 200,
      body: "ok",
      log:
        `[RUNTIME RECORDING] ✗ completed callback with no ${!callSid ? "CallSid" : "RecordingUrl"} — ` +
        "the recording exists in Twilio and cannot be attached to a call",
    };
  }
  return {
    status: 200,
    body: "ok",
    persist: { callSid, recordingUrl },
    log: `[RUNTIME RECORDING] ✓ recording attached to ${callSid}`,
  };
}
