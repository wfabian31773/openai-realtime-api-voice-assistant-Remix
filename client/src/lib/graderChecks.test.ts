import { describe, expect, it } from 'vitest'
import { checksOf } from './graderChecks'

const check = { grader: 'latency', pass: false, score: 0.5, reason: 'slow' }

describe('checksOf', () => {
  it('reads the shape the grader stores today', () => {
    expect(checksOf({ gradedAt: '2026-11-26T01:59:00Z', graders: [check], summary: { total: 1 } })).toEqual([check])
  })

  it('still reads the older shapes and a bare list', () => {
    expect(checksOf({ deterministic: [check] })).toEqual([check])
    expect(checksOf({ results: [check] })).toEqual([check])
    expect(checksOf([check])).toEqual([check])
  })

  it('is empty for an ungraded call', () => {
    expect(checksOf(null)).toEqual([])
    expect(checksOf({ summary: {} })).toEqual([])
    expect(checksOf('not json')).toEqual([])
  })
})
