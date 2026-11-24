import { describe, expect, it } from 'vitest'
import { acceptExtendPreview, apiError, chainStatusVariant, countdown, editCover, extendPlan, extendPreviewReady, isExtendPlanChanged, finalFallbackText, fmtPacific, fmtSeconds, fmtWeek, pacificMidnightIso, pacificNextMidnightIso, ROLE_LABELS, sectionBadge, toPacificInput } from './onCallView'

describe('on-call page helpers', () => {
  it('shows times in Pacific and says so', () => {
    expect(fmtPacific('2026-12-02T01:00:00Z')).toBe('Tue, Dec 1, 2026, 5:00 PM PT')
    expect(fmtPacific(null)).toBe('—')
    expect(fmtWeek('2026-12-01')).toBe('Tue, Dec 1, 2026')
  })
  it('fills a datetime-local input in Pacific', () => {
    expect(toPacificInput(new Date('2026-12-05T06:00:00Z'))).toBe('2026-12-04T22:00')
    expect(toPacificInput(new Date('2026-07-01T16:30:00Z'))).toBe('2026-07-01T09:30')
  })
  it('counts down and stops', () => {
    expect(countdown(((4 * 24 + 3) * 60 + 12) * 60_000)).toBe('4d 3h 12m')
    expect(countdown(5 * 60_000)).toBe('5m')
    expect(countdown(0)).toBe('go-live date passed')
  })
  it('formats durations', () => {
    expect(fmtSeconds(125)).toBe('2m 05s')
    expect(fmtSeconds(9)).toBe('9s')
    expect(fmtSeconds(null)).toBe('—')
  })
  it("prefers the server's own words", () => {
    expect(apiError({ response: { data: { error: 'A reason is required.' } } })).toBe('A reason is required.')
    expect(apiError(new Error('Network'))).toBe('Network')
  })
  it('labels wired and placeholder sections honestly', () => {
    expect(sectionBadge({ wired: false, present: false }).label).toBe('placeholder')
    expect(sectionBadge({ wired: true, present: false }).label).toMatch(/none on this call/)
    expect(chainStatusVariant('exhausted')).toBe('destructive')
  })
  it('states the operations fallback: last-4, why not, or not configured', () => {
    expect(finalFallbackText({ finalFallbackLast4: '…7777' })).toBe('Operations fallback (Wayne) …7777, rung after the final director')
    expect(finalFallbackText({ finalFallbackLast4: null, finalFallbackProblem: 'not a phone number' })).toBe('not configured: not a phone number')
    expect(finalFallbackText({})).toMatch(/^not configured/)
    expect(ROLE_LABELS.operations_fallback).toBe('Operations fallback (Wayne)')
  })

  describe('audit date filters are Pacific days', () => {
    it('PST: midnight is 08:00 UTC, and the end is the next midnight', () => {
      expect(pacificMidnightIso('2026-12-04')).toBe('2026-12-04T08:00:00.000Z')
      expect(pacificNextMidnightIso('2026-12-04')).toBe('2026-12-05T08:00:00.000Z')
    })

    it('PDT: midnight is 07:00 UTC', () => {
      expect(pacificMidnightIso('2026-07-15')).toBe('2026-07-15T07:00:00.000Z')
      expect(pacificNextMidnightIso('2026-07-15')).toBe('2026-07-16T07:00:00.000Z')
    })

    it('spring forward (2026-03-08) is a 23-hour day', () => {
      expect(pacificMidnightIso('2026-03-08')).toBe('2026-03-08T08:00:00.000Z')
      expect(pacificNextMidnightIso('2026-03-08')).toBe('2026-03-09T07:00:00.000Z')
    })

    it('fall back (2026-11-01) is a 25-hour day', () => {
      expect(pacificMidnightIso('2026-11-01')).toBe('2026-11-01T07:00:00.000Z')
      expect(pacificNextMidnightIso('2026-11-01')).toBe('2026-11-02T08:00:00.000Z')
    })

    it('the day before each change ends at the change day’s midnight', () => {
      expect(pacificNextMidnightIso('2026-03-07')).toBe('2026-03-08T08:00:00.000Z')
      expect(pacificNextMidnightIso('2026-10-31')).toBe('2026-11-01T07:00:00.000Z')
    })

    it('month and year ends roll over', () => {
      expect(pacificNextMidnightIso('2026-12-31')).toBe('2027-01-01T08:00:00.000Z')
    })

    it('an empty or malformed day sends no filter', () => {
      expect(pacificMidnightIso('')).toBeNull()
      expect(pacificNextMidnightIso('')).toBeNull()
      expect(pacificMidnightIso('2026-13-01')).toBeNull()
      expect(pacificMidnightIso('12/04/2026')).toBeNull()
    })
  })

  describe('editCover', () => {
    const confirmed = { startsAt: '2026-12-04T17:00', endsAt: '2026-12-05T08:00', providerId: 3 as number | '', confirmOverlap: true }

    it('withdraws a confirmed overlap and the warning when the start, end or provider changes', () => {
      for (const patch of [{ startsAt: '2026-12-04T18:00' }, { endsAt: '2026-12-06T08:00' }, { providerId: 4 }]) {
        const r = editCover(confirmed, patch)
        expect(r.cover.confirmOverlap).toBe(false)
        expect(r.clearWarning).toBe(true)
        expect(r.cover).toMatchObject(patch)
      }
    })

    it('keeps the confirmation when nothing that decides the conflict changed', () => {
      expect(editCover(confirmed, { startsAt: confirmed.startsAt })).toEqual({ cover: confirmed, clearWarning: false })
      expect(editCover({ ...confirmed, confirmOverlap: false }, { confirmOverlap: true })).toEqual({ cover: confirmed, clearWarning: false })
    })
  })

  describe('extend preview', () => {
    const p8 = { count: 8, weeks: [{ week: '2026-12-01', providerId: 4, providerName: 'A' }], refusal: null }

    it('sends back the previewed weeks as the plan', () => {
      expect(extendPlan(p8)).toEqual([{ week: '2026-12-01', providerId: 4 }])
    })

    it('recognises only the server saying the schedule changed since the preview', () => {
      expect(isExtendPlanChanged({ response: { status: 409, data: { planChanged: true, error: 'x' } } })).toBe(true)
      expect(isExtendPlanChanged({ response: { status: 409, data: { overlap: [] } } })).toBe(false)
      expect(isExtendPlanChanged({ response: { status: 400, data: { planChanged: true } } })).toBe(false)
      expect(isExtendPlanChanged(new Error('net'))).toBe(false)
    })

    it('drops a preview answering an earlier count', () => {
      expect(acceptExtendPreview(12, p8)).toBe(false)
      expect(acceptExtendPreview(8, p8)).toBe(true)
    })

    it('allows adding weeks only when the preview for the current count is in and not refused', () => {
      expect(extendPreviewReady(null, 8)).toBe(false)
      expect(extendPreviewReady(p8, 12)).toBe(false)
      expect(extendPreviewReady({ ...p8, refusal: 'Dr. X has no phone.' }, 8)).toBe(false)
      expect(extendPreviewReady(p8, 8)).toBe(true)
    })
  })
})
