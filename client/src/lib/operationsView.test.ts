import { describe, expect, it } from 'vitest'
import { agoText, durationText, outcomeLabel, pacificTime, pctText, shareText } from './operationsView'

describe('the Operations Monitor never shows a missing number as zero', () => {
  it('shows an unjudged share as a dash, not 0%', () => {
    expect(pctText(null)).toBe('—')
    expect(pctText(undefined)).toBe('—')
    expect(pctText(Number.NaN)).toBe('—')
    expect(pctText(1.5)).toBe('1.5%')
  })

  it('shows a share of no calls as a dash', () => {
    expect(shareText(0, 0)).toBe('—')
    expect(shareText(430, 662)).toBe('65%')
  })

  it('shows an unknown length or time as a dash', () => {
    expect(durationText(null)).toBe('—')
    expect(durationText(125)).toBe('2:05')
    expect(agoText(null)).toBe('—')
    expect(pacificTime('not a date')).toBe('—')
  })
})

describe('times are Pacific', () => {
  it('shows 03:00 UTC on Nov 26 as the evening of Nov 25 in Pacific time', () => {
    expect(pacificTime('2026-11-26T03:00:00Z')).toBe('Nov 25, 7:00 PM PT')
  })

  it('says how long ago something was', () => {
    const now = new Date('2026-11-26T03:00:00Z')
    expect(agoText('2026-11-26T02:57:00Z', now)).toBe('3 min ago')
    expect(agoText('2026-11-26T01:00:00Z', now)).toBe('2 h ago')
  })
})

describe('outcomes read as plain words', () => {
  it('names the runtime outcomes and passes others through', () => {
    expect(outcomeLabel('provider_failure')).toBe('Dropped by the voice provider')
    expect(outcomeLabel('something_new')).toBe('something_new')
  })
})
