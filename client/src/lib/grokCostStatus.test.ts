import { describe, it, expect } from 'vitest'
import { dayCostStatus, dayIsEstimate, headlineEstimateNote, summarizeGrokCosts, type GrokCallDay, type GrokDayRow } from './grokCostStatus'

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

// The call rows per day, as the Hub held them on 2026-11-26: every call on a
// reconciled day reconciled, every call on 11-21/22 and today not.
const call = (day: string, calls: number, unreconciledCalls: number): GrokCallDay => ({ day, calls, unreconciledCalls })
const CALLS: GrokCallDay[] = [
  call('2026-11-20', 717, 0),
  call('2026-11-21', 216, 216),
  call('2026-11-22', 68, 68),
  call('2026-11-23', 842, 0),
  call('2026-11-24', 802, 0),
  call('2026-11-25', 705, 0),
  call('2026-11-26', 57, 57),
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
    const s = summarizeGrokCosts(DAYS, CALLS.filter((c) => c.day <= '2026-11-25'))
    expect(s.reconciledDays).toBe(4)
    expect(s.estimatedDays).toEqual(['2026-11-21', '2026-11-22'])
    expect(s.gapDollars).toBe(76.81)
    expect(s.estimatedDaysWithoutXai).toBe(0)
    expect(s.notYetDays).toEqual([])
  })

  it('a day with unreconciled calls and no row is not settled (today, and a day the reconciler missed)', () => {
    const withHole = DAYS.filter((d) => d.day !== '2026-11-23')
    const calls = CALLS.map((c) => (c.day === '2026-11-23' ? call('2026-11-23', 842, 842) : c))
    expect(summarizeGrokCosts(withHole, calls).notYetDays).toEqual(['2026-11-23', '2026-11-26'])
  })

  it('a range with calls and no day rows at all still shows its unsettled days (the review of #534)', () => {
    const s = summarizeGrokCosts([], [call('2026-11-25', 705, 705), call('2026-11-26', 57, 57)])
    expect(s.notYetDays).toEqual(['2026-11-25', '2026-11-26'])
    expect(headlineEstimateNote(s)).toContain('2 days with calls not yet settled')
  })

  it('a day before the table existed whose calls were reconciled one by one is not an estimate (2026-09-03: 0 of 239)', () => {
    const s = summarizeGrokCosts(DAYS, [call('2026-09-03', 239, 0), ...CALLS])
    expect(s.notYetDays).toEqual(['2026-11-26'])
    expect(dayIsEstimate('2026-09-03', DAYS, s)).toBe(false)
  })

  it('nothing at all with no rows and no calls', () => {
    expect(summarizeGrokCosts([], [])).toEqual({
      reconciledDays: 0,
      estimatedDays: [],
      gapDollars: 0,
      estimatedDaysWithoutXai: 0,
      notYetDays: [],
    })
  })

  it('an estimated day with no xAI figure is counted apart, not as a zero gap', () => {
    const s = summarizeGrokCosts([...DAYS, row('2026-11-26', false, null, 12)], CALLS)
    expect(s.estimatedDays).toHaveLength(3)
    expect(s.gapDollars).toBe(76.81)
    expect(s.estimatedDaysWithoutXai).toBe(1)
  })
})

describe('headlineEstimateNote', () => {
  it('says what in the total is still an estimate, and by how much', () => {
    const note = headlineEstimateNote(summarizeGrokCosts(DAYS, CALLS))
    expect(note).toBe(
      "Voice AI includes 2 days not reconciled (still at the 8¢/min estimate); xAI reported $76.81 more on those days, and 1 day with calls not yet settled against xAI's bill (each UTC day is settled the night after).",
    )
  })

  it('is silent when every day is reconciled', () => {
    expect(headlineEstimateNote(summarizeGrokCosts([DAYS[3], DAYS[4]], [CALLS[3], CALLS[4]]))).toBeNull()
  })

  it('says less, not more, when the estimate is over xAI’s figure', () => {
    const note = headlineEstimateNote(summarizeGrokCosts([row('2026-11-21', false, 10, 12.5)], []))
    expect(note).toContain('xAI reported $2.50 less on it')
  })
})

describe('dayIsEstimate', () => {
  it('marks a refused day and a day not settled yet, never a reconciled one', () => {
    const s = summarizeGrokCosts(DAYS, CALLS)
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
    expect(page).toContain('summarizeGrokCosts(grokUsage.days, grokUsage.callDays ?? [])')
    expect(page).toContain('{estimateNote}')
    expect(page).toContain('dayIsEstimate(day.date, grokUsage.days, grokSummary)')
    expect(page).toContain('const st = dayCostStatus(d)')
    expect(page).toContain('{d.refusedReason}</p>')
  })

  it('each day-table value sits under its own heading (the review of #534: Gap and ¢/min were swapped)', async () => {
    const { readFileSync } = await import('node:fs')
    const page = readFileSync(new URL('../pages/CostDashboardPage.tsx', import.meta.url), 'utf8')
    const card = page.slice(page.indexOf('Grok runtime — xAI reported vs booked'))
    const head = card.slice(card.indexOf('<thead>'), card.indexOf('</thead>'))
    const body = card.slice(card.indexOf('<tbody>'), card.indexOf('</tbody>'))
    const headings = [...head.matchAll(/>([^<>{}]+)<\/th>/g)].map((m) => m[1].trim())
    expect(headings).toEqual(['Day', 'Calls', 'Minutes', 'xAI voice', 'Booked', '¢/min', 'Gap', 'Status'])
    // In the row: the ¢/min cell (derivedCentsPerMinute) comes before the gap cell, and the gap before the status.
    const rate = body.indexOf('d.derivedCentsPerMinute')
    const gap = body.indexOf('st.gapDollars')
    const status = body.indexOf("'refused — estimated'")
    expect(rate).toBeGreaterThan(0)
    expect(gap).toBeGreaterThan(rate)
    expect(status).toBeGreaterThan(gap)
  })

  it('the route reads the unreconciled calls per day from the call rows', async () => {
    const { readFileSync } = await import('node:fs')
    const routes = readFileSync(new URL('../../../server/routes.ts', import.meta.url), 'utf8')
    const route = routes.slice(routes.indexOf("app.get('/api/analytics/grok-usage'"))
    expect(route.slice(0, 4000)).toContain("count(*) FILTER (WHERE cost_reconciled_at IS NULL)::int AS unreconciled")
    expect(route.slice(0, 4000)).toContain("WHERE voice_provider = 'grok'")
    expect(route.slice(0, 4000)).toContain('callDays,')
  })
})
