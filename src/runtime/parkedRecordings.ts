/**
 * src/runtime/parkedRecordings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A RECORDING CALLBACK THAT BEATS ITS CALL ROW IS PARKED, NOT DROPPED.
 *
 * Codex P2 on #321. The runtime starts its Twilio recording the moment the
 * stream's `start` frame arrives — BEFORE the pre-context lookup, the lane
 * build and `openRuntimeCall`, deliberately, so the recording holds the
 * greeting and the disclosure it carries. That ordering means a caller who
 * hangs up during setup, or a call whose row open missed its 2s deadline,
 * can produce a completed-recording callback before any `call_logs` row
 * exists. The CallSid branch of the recording-status handler answered that
 * with a warning and HTTP 200, and Twilio does not retry a 200, so the URL
 * was gone for good.
 *
 * Every one of those calls still gets a row: the teardown persist runs on
 * every exit (`persistRuntimeCall`, four call sites in voiceRuntime.ts,
 * including the setup-failure and early-hangup returns). So the handler
 * parks the URL here by CallSid, and the persist takes it onto the row it
 * is about to write — once before the write and once after, so a callback
 * landing between the two cannot fall in the gap. The runtime and the old
 * core's routes share one process (`server/index.ts` mounts both), which
 * is what makes a module-level map reachable from both sides.
 *
 * Bounded twice: a TTL, because a callback for a call that never persists
 * (a restart between the two) must not sit here forever, and a cap, so a
 * flood of callbacks cannot grow it. No PHI — a CallSid and a Twilio URL.
 */
export const PARKED_RECORDING_TTL_MS = 30 * 60 * 1000;
export const PARKED_RECORDING_CAP = 500;

const parked = new Map<string, { url: string; at: number }>();

function sweep(now: number): void {
  for (const [sid, entry] of parked) {
    if (now - entry.at > PARKED_RECORDING_TTL_MS) parked.delete(sid);
  }
}

export function parkRecording(callSid: string, url: string, now: number = Date.now()): void {
  sweep(now);
  if (parked.size >= PARKED_RECORDING_CAP && !parked.has(callSid)) {
    // Map iteration is insertion order, so the first key is the oldest.
    const oldest = parked.keys().next().value;
    if (oldest !== undefined) parked.delete(oldest);
  }
  parked.set(callSid, { url, at: now });
}

/** Removes the entry it returns: a URL is taken onto exactly one write. */
export function takeParkedRecording(callSid: string, now: number = Date.now()): string | undefined {
  sweep(now);
  const entry = parked.get(callSid);
  if (!entry) return undefined;
  parked.delete(callSid);
  return entry.url;
}

/** Test seams. */
export function clearParkedRecordings(): void {
  parked.clear();
}
export function parkedRecordingCount(): number {
  return parked.size;
}
