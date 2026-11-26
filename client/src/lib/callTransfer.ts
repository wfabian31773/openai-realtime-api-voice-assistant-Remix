/**
 * Whether a call was transferred, and how, as the call log list shows it.
 *
 * `transferredToHuman` is set only when a person is known to have taken the
 * call (a warm transfer's key press). A blind transfer into a queue never sets
 * it, because nothing on that path proves a person answered (v20), so the
 * runtime records it as `runtimeOutcome = 'transferred'` instead. Measured on
 * the Hub over the 14 days to 2026-11-26: 3 calls carried the flag and 713
 * ended in a transfer, so the icon read "No transfer" on 710 transferred calls.
 */
export type TransferKind = 'person' | 'queue' | null

export function transferKindOf(
  log: { transferredToHuman?: unknown; runtimeOutcome?: unknown } | null | undefined,
): TransferKind {
  if (!log) return null
  if (log.transferredToHuman === true) return 'person'
  if (log.runtimeOutcome === 'transferred') return 'queue'
  return null
}

export function transferLabel(kind: TransferKind): string {
  if (kind === 'person') return 'Transferred to a person who accepted'
  if (kind === 'queue') return 'Transferred to the queue (no person confirmed)'
  return 'No transfer'
}
