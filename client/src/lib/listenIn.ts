/**
 * Whether the Observatory's Listen-in button can join a call.
 *
 * Listen-in joins the call's Twilio conference, and only the old core has
 * one; a runtime call streams straight to the voice AI. 8,501 of 8,502 calls
 * in the 14 days to 2026-11-26 were runtime calls, so the button failed on
 * nearly every call. The server refuses the same calls with the same words
 * (server/observatory/listenIn.ts); a test keeps the two copies identical.
 */
export const RUNTIME_LISTEN_IN_REASON =
  'Listen-in is not available on this call: runtime calls stream straight to the voice AI and have no conference to join. The recording and transcript are on the call page once it ends.'

export function listenInUnavailableReason(call: { voiceProvider?: string | null } | null | undefined): string | null {
  if (call && call.voiceProvider != null && call.voiceProvider !== '') return RUNTIME_LISTEN_IN_REASON
  return null
}
