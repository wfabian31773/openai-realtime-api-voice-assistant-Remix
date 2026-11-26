import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { failingSinceText, headline, orderResults, refreshFailureText, valueText, type AccuracyResult } from './accuracyView'

const r = (id: string, status: AccuracyResult['status'], screen = 'Observatory'): AccuracyResult => ({
  id,
  screen,
  widget: 'w',
  claim: 'c',
  truthSource: 't',
  unit: 'count',
  status,
  screenValue: 1,
  truthValue: 1,
  difference: 0,
  allowed: 0,
  note: '',
  ms: 1,
  failingSince: null,
})

describe('the Accuracy tab', () => {
  it('says how many numbers are wrong, and never calls an unchecked number right', () => {
    const five = [r('a', 'pass'), r('b', 'pass'), r('c', 'pass'), r('d', 'fail'), r('e', 'fail')]
    expect(headline({ counts: { pass: 3, fail: 2, unknown: 0 }, results: five }).text).toBe('2 of 5 numbers on screen are wrong.')
    const oneUnknown = [r('a', 'pass'), r('b', 'pass'), r('c', 'pass'), r('d', 'pass'), r('e', 'unknown')]
    expect(headline({ counts: { pass: 4, fail: 0, unknown: 1 }, results: oneUnknown }).tone).toBe('unsure')
    expect(headline({ counts: { pass: 2, fail: 0, unknown: 0 }, results: [r('a', 'pass'), r('b', 'pass')] }).tone).toBe('good')
    expect(headline({ counts: { pass: 0, fail: 0, unknown: 0 }, results: [] }).tone).toBe('unsure')
  })

  it('lists wrong numbers first', () => {
    expect(orderResults([r('a', 'pass'), r('b', 'unknown'), r('c', 'fail')]).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })

  it('shows values the way the server describes them', () => {
    expect(valueText(0.0794, 'percent')).toBe('7.9%')
    expect(valueText(212.96, 'dollars')).toBe('$212.96')
    expect(valueText(4009, 'count')).toBe('4,009')
    expect(valueText(null, 'count')).toBe('—')
  })

  it('says since when a check has been failing, in Pacific time', () => {
    expect(failingSinceText('2026-11-26T03:00:00Z')).toBe('since Nov 25, 7:00 PM PT')
    expect(failingSinceText(null)).toBeNull()
  })
})

describe('"Check now" failing', () => {
  it('says so, gives the server\'s reason, and says the results shown are older', () => {
    expect(refreshFailureText({ response: { data: { error: 'The accuracy checks could not be run.' } } })).toBe(
      'Check now did not finish (The accuracy checks could not be run.). The results below are from the last run.',
    )
    expect(refreshFailureText(new Error('Network Error'))).toBe(
      'Check now did not finish (the request failed). The results below are from the last run.',
    )
  })

  it('the tab shows that message instead of swallowing the failure', () => {
    const src = readFileSync(join(__dirname, '../components/observatory/AccuracyTab.tsx'), 'utf8')
    expect(src).toMatch(/catch \(err\) \{\s*setRefreshError\(refreshFailureText\(err\)\)/)
    expect(src).toContain('{refreshError && <p className="text-sm text-red-600">{refreshError}</p>}')
  })
})
