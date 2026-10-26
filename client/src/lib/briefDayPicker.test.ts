import { describe, it, expect } from 'vitest'
import { briefNeighbours, briefCorrectionNotice } from './briefDayPicker'

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']

describe('briefNeighbours', () => {
  it('steps to the adjacent STORED days, across gaps', () => {
    expect(briefNeighbours(DAYS, '2026-10-02')).toEqual({ prev: '2026-10-01', next: '2026-10-05' })
  })
  it('has no prev on the first day and no next on the latest', () => {
    expect(briefNeighbours(DAYS, '2026-10-01').prev).toBeNull()
    expect(briefNeighbours(DAYS, '2026-10-06').next).toBeNull()
  })
  it('a single stored day has neither', () => {
    expect(briefNeighbours(['2026-10-01'], '2026-10-01')).toEqual({ prev: null, next: null })
  })
  it('a day not in the list steps to the nearest stored days', () => {
    expect(briefNeighbours(DAYS, '2026-10-03')).toEqual({ prev: '2026-10-02', next: '2026-10-05' })
  })
})

describe('briefCorrectionNotice', () => {
  it('is null when there is no correction', () => {
    expect(briefCorrectionNotice(undefined)).toBeNull()
    expect(briefCorrectionNotice(null)).toBeNull()
  })
  it('prefers the label, then the reason, then generic text', () => {
    expect(briefCorrectionNotice({ label: 'Backfilled 2026-10-21', reason: 'r' })?.label).toBe('Backfilled 2026-10-21')
    expect(briefCorrectionNotice({ reason: 'SAGE section re-read' })?.label).toBe('SAGE section re-read')
    expect(briefCorrectionNotice({})?.label).toMatch(/backfilled or corrected/)
    expect(briefCorrectionNotice(true)?.label).toMatch(/backfilled or corrected/)
  })
  it('carries correctedAt when present, and never the originals', () => {
    const n = briefCorrectionNotice({
      label: 'Backfilled',
      correctedAt: '2026-10-21T10:00:00Z',
      originalSage: { calls: 99 },
      originalCategories: [{ key: 'x' }],
    })
    expect(n).toEqual({ label: 'Backfilled', correctedAt: '2026-10-21T10:00:00Z' })
  })
})
