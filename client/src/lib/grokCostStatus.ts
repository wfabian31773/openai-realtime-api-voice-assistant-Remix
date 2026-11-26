/**
 * Which Grok cost days are xAI's own figure and which are still our estimate,
 * as the Cost Dashboard shows them.
 *
 * Each runtime call is first booked at the published rate (8¢/min), and the
 * nightly reconciler then replaces a day's booking with xAI's reported voice
 * spend, split across that day's calls. A day the reconciler refused keeps the
 * estimate on purpose (a split it cannot attribute to these calls would put
 * wrong numbers on every call), and a day it has not reached yet is an
 * estimate too. Before this, the headline total and the daily trend showed
 * those days as if they were the bill. Measured on the Hub on 2026-11-26 over
 * the 31 days to 2026-11-25: 29 reconciled, 2 refused (2026-11-21 and 11-22),
 * which carry $30.41 booked against $107.22 xAI reported, $76.81 short.
 */
export interface GrokDayRow {
  day: string
  reconciled: boolean
  refusedReason: string | null
  xaiVoiceDollars: number | null
  bookedDollars: number | null
}

export type DayCostStatus =
  | { kind: 'reconciled' }
  /** Refused: the call rows carry the estimate. `gapDollars` is xAI minus booked. */
  | { kind: 'estimated'; gapDollars: number | null; reason: string | null }
  /** The reconciler could not read the day at all. */
  | { kind: 'unread'; reason: string | null }

const cents = (d: number) => Math.round(d * 100)

export function dayCostStatus(d: GrokDayRow): DayCostStatus {
  if (d.reconciled) return { kind: 'reconciled' }
  if (d.bookedDollars == null) return { kind: 'unread', reason: d.refusedReason }
  const gapDollars =
    d.xaiVoiceDollars == null ? null : (cents(d.xaiVoiceDollars) - cents(d.bookedDollars)) / 100
  return { kind: 'estimated', gapDollars, reason: d.refusedReason }
}

export interface GrokCostSummary {
  reconciledDays: number
  /** Refused or unread days in the range. */
  estimatedDays: string[]
  /** Sum of xAI minus booked over the estimated days whose xAI figure is known. */
  gapDollars: number
  /** Estimated days whose xAI figure is not known, so the gap leaves them out. */
  estimatedDaysWithoutXai: number
  /**
   * Days in the range with no row yet: from the first row on, up to the end of
   * the range. The reconciler settles the previous UTC day, so today and
   * usually yesterday are here; an older day here means it never ran.
   */
  notYetDays: string[]
}

const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function summarizeGrokCosts(days: GrokDayRow[], endDate: string): GrokCostSummary {
  let reconciledDays = 0
  let gapCents = 0
  let withoutXai = 0
  const estimatedDays: string[] = []
  for (const d of days) {
    const s = dayCostStatus(d)
    if (s.kind === 'reconciled') {
      reconciledDays += 1
      continue
    }
    estimatedDays.push(d.day)
    if (s.kind === 'estimated' && s.gapDollars != null) gapCents += cents(s.gapDollars)
    else withoutXai += 1
  }
  const notYetDays: string[] = []
  if (days.length > 0) {
    const have = new Set(days.map((d) => d.day))
    const first = [...have].sort()[0]
    for (let day = first; day <= endDate; day = nextDay(day)) {
      if (!have.has(day)) notYetDays.push(day)
    }
  }
  return { reconciledDays, estimatedDays, gapDollars: gapCents / 100, estimatedDaysWithoutXai: withoutXai, notYetDays }
}

/** One line for the headline: what in the total is still an estimate. Null when nothing is. */
export function headlineEstimateNote(s: GrokCostSummary): string | null {
  const parts: string[] = []
  if (s.estimatedDays.length > 0) {
    const n = s.estimatedDays.length
    let line = `${n} day${n === 1 ? '' : 's'} not reconciled (still at the 8¢/min estimate)`
    if (s.gapDollars !== 0) {
      const more = s.gapDollars > 0
      line += `; xAI reported $${Math.abs(s.gapDollars).toFixed(2)} ${more ? 'more' : 'less'} on ${n === 1 ? 'it' : 'those days'}`
    }
    if (s.estimatedDaysWithoutXai > 0) line += ` (${s.estimatedDaysWithoutXai} without an xAI figure)`
    parts.push(line)
  }
  if (s.notYetDays.length > 0) {
    const n = s.notYetDays.length
    parts.push(`${n} day${n === 1 ? '' : 's'} not settled yet (each UTC day is settled the night after)`)
  }
  return parts.length > 0 ? `Voice AI includes ${parts.join(', and ')}.` : null
}

/** Whether a date on the daily trend is still an estimate. */
export function dayIsEstimate(day: string, days: GrokDayRow[], s: GrokCostSummary): boolean {
  const row = days.find((d) => d.day === day)
  if (row) return !row.reconciled
  return s.notYetDays.includes(day)
}
