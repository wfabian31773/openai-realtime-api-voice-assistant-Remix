import { describe, it, expect } from 'vitest'
import { payloadVerdict, prettyJson, matchesFilter, emptyLabel } from './toolPayloads'

describe('payloadVerdict', () => {
  it('reads success, a refusal, an error and anything else', () => {
    expect(payloadVerdict({ success: true })).toBe('ok')
    expect(payloadVerdict({ success: false, refused: 'which_list' })).toBe('refused')
    expect(payloadVerdict({ success: false, missingFields: ['date_of_birth'] })).toBe('refused')
    expect(payloadVerdict({ success: false })).toBe('error')
    expect(payloadVerdict({ error: 'timeout' })).toBe('error')
    expect(payloadVerdict({ result: { success: true } })).toBe('ok')
    expect(payloadVerdict({ text: 'hanging up' })).toBe('unknown')
    expect(payloadVerdict(null)).toBe('unknown')
  })
})

describe('prettyJson', () => {
  it('shows a capped half as its kept text and says it was cut', () => {
    const out = prettyJson({ truncated: true, chars: 40000, text: '{"a":' })
    expect(out.startsWith('{"a":')).toBe(true)
    expect(out).toContain('40000 characters')
  })
  it('pretty-prints anything else', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('matchesFilter', () => {
  const p = { seq: 0, tool: 'book_sooner_exam', eventAt: '', ms: 1, args: { date: 'February 13' }, result: { success: false } }
  it('matches the tool name, the arguments or the result, case ignored', () => {
    expect(matchesFilter(p, '')).toBe(true)
    expect(matchesFilter(p, 'BOOK')).toBe(true)
    expect(matchesFilter(p, 'february')).toBe(true)
    expect(matchesFilter(p, 'success')).toBe(true)
    expect(matchesFilter(p, 'lookup')).toBe(false)
  })
})

describe('emptyLabel', () => {
  it('says why the tab is empty', () => {
    expect(emptyLabel('forbidden', 30)).toContain('admins only')
    expect(emptyLabel('none', 30)).toContain('30 days')
    expect(emptyLabel('error', 30)).toContain('could not be read')
  })
})
