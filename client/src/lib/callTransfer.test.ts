import { describe, it, expect } from 'vitest'
import { transferKindOf, transferLabel } from './callTransfer'

describe('transferKindOf', () => {
  it('a person who accepted is a person transfer', () => {
    expect(transferKindOf({ transferredToHuman: true, runtimeOutcome: 'transferred' })).toBe('person')
  })

  it('a queue transfer, which never sets the flag, still shows as a transfer', () => {
    expect(transferKindOf({ transferredToHuman: false, runtimeOutcome: 'transferred' })).toBe('queue')
  })

  it('anything else is no transfer', () => {
    expect(transferKindOf({ transferredToHuman: false, runtimeOutcome: 'caller_hangup' })).toBeNull()
    expect(transferKindOf({ transferredToHuman: false })).toBeNull()
    expect(transferKindOf(null)).toBeNull()
  })

  it('the queue label never claims a person answered', () => {
    expect(transferLabel('queue')).toContain('queue')
    expect(transferLabel('queue')).toContain('no person confirmed')
    expect(transferLabel(null)).toBe('No transfer')
  })
})
