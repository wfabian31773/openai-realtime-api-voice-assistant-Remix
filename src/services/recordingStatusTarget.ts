/**
 * WHICH CALL A TWILIO RECORDING-STATUS CALLBACK BELONGS TO.
 *
 * Two kinds of recording post to the same `/api/voice/recording-status`:
 *
 *   conference — the old core's `<Conference record="record-from-start">`.
 *                The body carries `ConferenceSid`, and the handler has always
 *                mapped that to a call log through the conference tables.
 *   call       — the runtime's REST recording (`callRecording.ts`), started on
 *                a `<Connect><Stream>` call that has no conference. The body
 *                carries `CallSid` and nothing else to go on.
 *
 * Until 2026-09-17 the handler read ConferenceSid only, so a call recording
 * would have been received, logged, and dropped. This decides which key to
 * use; the handler does the lookups.
 */
export type RecordingTarget =
  | { by: "conference"; conferenceSid: string }
  | { by: "call"; callSid: string };

export function recordingStatusTarget(body: Record<string, string | undefined>): RecordingTarget | null {
  if (body.RecordingStatus !== "completed" || !body.RecordingUrl) return null;
  if (body.ConferenceSid) return { by: "conference", conferenceSid: body.ConferenceSid };
  if (body.CallSid && /^CA[0-9a-f]{32}$/i.test(body.CallSid)) return { by: "call", callSid: body.CallSid };
  return null;
}
