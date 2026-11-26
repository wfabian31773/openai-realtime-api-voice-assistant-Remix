import { describe, expect, it } from 'vitest'
import { isLive, liveCalls, LIVE_WINDOW_MINUTES } from './liveCalls'

const now = new Date('2026-11-26T18:00:00Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

describe('Live now', () => {
  it('counts an open runtime call with no Twilio conference', () => {
    expect(isLive({ status: 'in_progress', createdAt: minutesAgo(2) }, now)).toBe(true)
  })

  it('does not count a row whose end was never written', () => {
    expect(isLive({ status: 'in_progress', createdAt: minutesAgo(LIVE_WINDOW_MINUTES + 1) }, now)).toBe(false)
  })

  it('does not count a call that has ended', () => {
    expect(isLive({ status: 'completed', createdAt: minutesAgo(1) }, now)).toBe(false)
    expect(isLive({ status: 'failed', createdAt: minutesAgo(1) }, now)).toBe(false)
  })

  it('reads the start time before the row time, and refuses a time it cannot read', () => {
    expect(isLive({ status: 'ringing', startTime: minutesAgo(1), createdAt: minutesAgo(60) }, now)).toBe(true)
    expect(isLive({ status: 'ringing', createdAt: 'not a date' }, now)).toBe(false)
  })

  it('filters a list', () => {
    const rows = [
      { id: 'a', status: 'in_progress', createdAt: minutesAgo(1) },
      { id: 'b', status: 'in_progress', createdAt: minutesAgo(40) },
      { id: 'c', status: 'completed', createdAt: minutesAgo(1) },
    ]
    expect(liveCalls(rows, now).map((r) => r.id)).toEqual(['a'])
  })
})
