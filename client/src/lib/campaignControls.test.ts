import { describe, expect, it } from 'vitest'
import { RUNTIME_CAMPAIGN_NOTE, campaignButtons } from './campaignControls'

describe('a runtime campaign card (v277)', () => {
  it('running: Pause, and no Stop, Start or delete', () => {
    expect(campaignButtons({ campaignType: 'runtime_outbound', status: 'running', totalContacts: 1472 })).toEqual({
      add: false,
      start: false,
      stop: false,
      pause: true,
      resume: false,
      delete: false,
      note: RUNTIME_CAMPAIGN_NOTE,
    })
  })

  it('paused or cancelled: Resume, never the from-number Start dialog or delete', () => {
    for (const status of ['paused', 'cancelled']) {
      const b = campaignButtons({ campaignType: 'runtime_outbound', status, totalContacts: 1472 })
      expect(b.resume, status).toBe(true)
      expect(b.pause, status).toBe(false)
      expect(b.start, status).toBe(false)
      expect(b.delete, status).toBe(false)
    }
  })

  it('the note says what Pause does and that the switch still rules', () => {
    expect(RUNTIME_CAMPAIGN_NOTE).toMatch(/Pause stops new calls and texts/)
    expect(RUNTIME_CAMPAIGN_NOTE).toMatch(/environment switch/)
  })
})

describe('every other campaign keeps its buttons', () => {
  it('running: Stop', () => {
    expect(campaignButtons({ campaignType: 'call', status: 'running', totalContacts: 3 })).toEqual({
      add: false,
      start: false,
      stop: true,
      pause: false,
      resume: false,
      delete: false,
      note: null,
    })
  })

  it('not running: Add, delete, and Start once it has contacts', () => {
    expect(campaignButtons({ campaignType: 'call', status: 'paused', totalContacts: 3 })).toMatchObject({ add: true, start: true, delete: true, stop: false })
    expect(campaignButtons({ campaignType: 'call', status: 'draft', totalContacts: 0 })).toMatchObject({ add: true, start: false, delete: true })
  })
})
