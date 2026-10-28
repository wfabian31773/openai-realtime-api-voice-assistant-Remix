/** Once heard, a caller is protected for the whole call, even after silence.
 * Treat any non-empty caller transcript as sufficient; deciding whether a
 * request sounds coherent must not decide whether it survives. */
export function hasCallerTranscript(transcript: string): boolean {
  return /^CALLER:[^\S\r\n]*\S/m.test(transcript);
}

export const GHOST_CALL_RESTRICTION =
  'NEVER use the ghost-call line or terminate_call with reason "ghost_call" after any non-empty caller transcript, including any request or question. ' +
  'Continue helping after silence.';

/** Model-facing refusal, with no instruction to speak a new scripted line. */
export function ghostCallRefusal(reason: unknown, callerHeard: boolean) {
  if (reason !== 'ghost_call' || !callerHeard) return null;
  return {
    success: false,
    error: 'caller_already_heard',
    fix: GHOST_CALL_RESTRICTION,
  };
}
