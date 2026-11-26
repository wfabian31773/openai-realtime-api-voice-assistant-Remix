import { describe, it, expect } from 'vitest'
import { dayCostStatus, dayIsEstimate, headlineEstimateNote, summarizeGrokCosts, type GrokDayRow } from './grokCostStatus'

// The day table as the Hub held it on 2026-11-26 for the days that matter:
// 2026-11-21 and 11-22 were refused by the rate guard, the rest reconciled.
const row = (day: string, reconciled: boolean, xai: number | null, booked: number | null, reason: string | null = null): GrokDayRow => ({
  day,
  reconciled,
  refusedReason: reason,
  xaiVoiceDollars: xai,
  bookedDollars: booked,
})
const REASON = 'xAI billed $84.87 for 2026-11-21 against only 17976s across 216 runtime call(s)'
const DAYS: GrokDayRow[] = [
  row('2026-11-20', true, 189.91, 189.91),
  row('2026-11-21', false, 84.87, 23.84, REASON),
  row('2026-11-22', false, 22.35, 6.57, 'xAI billed $22.35 for 2026-11-22'),
  row('2026-11-23', true, 240.15, 240.15),
  row('2026-11-24', true, 243.05, 243.05),
  row('2026-11-25', true, 229.4, 229.4),
]

describe('dayCostStatus', () => {
  it('a reconciled day is xAI’s own figure', () => {
    expect(dayCostStatus(DAYS[0])).toEqual({ kind: 'reconciled' })
  })

  it('a refused day is an estimate, with how far it sits from xAI and why', () => {
    expect(dayCostStatus(DAYS[1])).toEqual({ kind: 'estimated', gapDollars: 61.03, reason: REASON })
    expect(dayCostStatus(DAYS[2])).toMatchObject({ kind: 'estimated', gapDollars: 15.78 })
  })

  it('an estimate with no xAI figure has no gap, and a day never read is its own kind', () => {
    expect(dayCostStatus(row('2026-11-01', false, null, 5))).toEqual({ kind: 'estimated', gapDollars: null, reason: null })
    expect(dayCostStatus(row('2026-11-01', false, null, null, 'could not read the day'))).toEqual({
      kind: 'unread',
      reason: 'could not read the day',
    })
  })
})

describe('summarizeGrokCosts', () => {
  it('counts the reconciled days and sums the gap on the estimated ones ($76.81 on 11-21/22)', () => {
    const s = summarizeGrokCosts(DAYS, '2026-11-25')
    expect(s.reconciledDays).toBe(4)
    expect(s.estimatedDays).toEqual(['2026-11-21', '2026-11-22'])
    expect(s.gapDollars).toBe(76.81)
    expect(s.estimatedDaysWithoutXai).toBe(0)
    expect(s.notYetDays).toEqual([])
  })

  it('a day in the range with no row yet is not settled (today, and a day the reconciler missed)', () => {
    const withHole = DAYS.filter((d) => d.day !== '2026-11-23')
    const s = summarizeGrokCosts(withHole, '2026-11-26')
    expect(s.notYetDays).toEqual(['2026-11-23', '2026-11-26'])
  })

  it('does not count days before the first row, and nothing at all when there are no rows', () => {
    expect(summarizeGrokCosts(DAYS, '2026-11-25').notYetDays).not.toContain('2026-11-19')
    expect(summarizeGrokCosts([], '2026-11-26')).toEqual({
      reconciledDays: 0,
      estimatedDays: [],
      gapDollars: 0,
      estimatedDaysWithoutXai: 0,
      notYetDays: [],
    })
  })

  it('an estimated day with no xAI figure is counted apart, not as a zero gap', () => {
    const s = summarizeGrokCosts([...DAYS, row('2026-11-26', false, null, 12)], '2026-11-26')
    expect(s.estimatedDays).toHaveLength(3)
    expect(s.gapDollars).toBe(76.81)
    expect(s.estimatedDaysWithoutXai).toBe(1)
  })
})

describe('headlineEstimateNote', () => {
  it('says what in the total is still an estimate, and by how much', () => {
    const note = headlineEstimateNote(summarizeGrokCosts(DAYS, '2026-11-26'))
    expect(note).toBe(
      'Voice AI includes 2 days not reconciled (still at the 8¢/min estimate); xAI reported $76.81 more on those days, and 1 day not settled yet (each UTC day is settled the night after).',
    )
  })

  it('is silent when every day is reconciled', () => {
    expect(headlineEstimateNote(summarizeGrokCosts([DAYS[3], DAYS[4]], '2026-11-24'))).toBeNull()
  })

  it('says less, not more, when the estimate is over xAI’s figure', () => {
    const note = headlineEstimateNote(summarizeGrokCosts([row('2026-11-21', false, 10, 12.5)], '2026-11-21'))
    expect(note).toContain('xAI reported $2.50 less on it')
  })
})

describe('dayIsEstimate', () => {
  it('marks a refused day and a day not settled yet, never a reconciled one', () => {
    const s = summarizeGrokCosts(DAYS, '2026-11-26')
    expect(dayIsEstimate('2026-11-21', DAYS, s)).toBe(true)
    expect(dayIsEstimate('2026-11-26', DAYS, s)).toBe(true)
    expect(dayIsEstimate('2026-11-23', DAYS, s)).toBe(false)
  })
})

// The page is what Wayne reads, so pin that it uses these, not just that they work.
describe('the Cost Dashboard reads the status', () => {
  it('shows the headline note, marks estimated days on the trend, and the gap and reason in the day table', async () => {
    const { readFileSync } = await import('node:fs')
    const page = readFileSync(new URL('../pages/CostDashboardPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('summarizeGrokCosts(grokUsage.days, getOpenAIDateParams().endDate)')
    expect(page).toContain('{estimateNote}')
    expect(page).toContain('dayIsEstimate(day.date, grokUsage.days, grokSummary)')
    expect(page).toContain('const st = dayCostStatus(d)')
    expect(page).toContain('{d.refusedReason}</p>')
  })
})
