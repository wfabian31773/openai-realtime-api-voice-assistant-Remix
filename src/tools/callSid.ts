/**
 * IS THIS A REAL TWILIO CALLSID, OR SOMETHING THE MODEL MADE UP?
 *
 * The distinction is not cosmetic. `call_sid` is a declared property on the
 * filing tools, so the model emits a value whether or not it was given one,
 * and between 2026-08-24 and 09-01 it emitted the literal strings "unknown",
 * "none", "undefined", "N/A", "latest" and "automated_xxx_placeholder" on 137
 * live create-ticket POSTs. Every one of those calls had a real CA-prefixed
 * SID on its `call_logs` row.
 *
 * A sentinel is worse than an absent value wherever the SID is used as a KEY,
 * because every call that emits it collides on the same key. Found by Codex
 * on PR #244 in two places at once — `gateAttempts` and `verifiedIdentity`
 * both took any non-empty string, so one call's answer could be read back on
 * another's, and in the identity case that means one patient's date of birth
 * on another patient's ticket.
 *
 * This lives in its own module so the two per-call stores can validate their
 * keys without importing `sharedPatientTools`, which pulls in the registry and
 * every queue tool with it. `sharedPatientTools` re-exports it, so the four
 * filing tools keep their single import line and there is still exactly one
 * definition.
 */
export function isTwilioCallSid(v: string | undefined | null): v is string {
  return typeof v === 'string' && /^CA[0-9a-f]{32}$/i.test(v);
}
