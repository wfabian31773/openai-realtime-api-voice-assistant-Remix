/**
 * The NPX outreach screen's table filters, search and labels. Synthetic
 * patients only ("Testa Synthetic").
 *
 * The last block runs the SERVER's own builder and reads its output with
 * these filters, so a result or a reason the server adds that this page has
 * no label or filter for goes red here rather than rendering as a blank.
 */
import { describe, expect, it } from 'vitest'
import {
  CANCEL_LABELS,
  CONTACT_FILTERS,
  REASON_LABELS,
  RESULT_LABELS,
  countByFilter,
  filterContacts,
  foldName,
  formatApptDate,
  formatApptTime,
  formatDuration,
  formatPacific,
  maskedPhone,
  matchesFilter,
  matchesSearch,
  type ContactView,
} from './npxOutreachView'
import { buildTracking, type RawAttempt, type RawContact } from '../../../server/observatory/npxOutreach.logic'

function view(over: Partial<ContactView> = {}): ContactView {
  return {
    id: 'c1',
    name: 'Testa Synthetic',
    phoneLast4: '5551',
    appointment: { event: 'Comprehensive Exam', date: '2041-02-20', time: '0930', office: 'Test Office' },
    status: 'pending',
    result: 'not_called',
    calls: { placed: 0, returned: 0, latestAt: null, latestLabel: null },
    reached: false,
    text: null,
    link: { dobTried: false, verifiedAt: null },
    booking: null,
    staffTickets: [],
    bookedThenStaffSameCall: false,
    optOut: { voice: false, voiceAt: null, sms: false, smsAt: null },
    nextAttemptAt: null,
    attempts: [],
    ...over,
  }
}

describe('the table filters are facts, not the headline result', () => {
  it('a booking that later texted STOP is under both Booked and Opted out', () => {
    const c = view({
      result: 'booked',
      status: 'completed',
      booking: { id: 'npx-1', by: 'phone', at: null, cancel: 'landed', callLogId: null },
      optOut: { voice: false, voiceAt: null, sms: true, smsAt: null },
    })
    expect(matchesFilter(c, 'booked')).toBe(true)
    expect(matchesFilter(c, 'opted_out')).toBe(true)
    expect(matchesFilter(c, 'staff_ticket')).toBe(false)
  })

  it('separates not called, no answer yet and never reached', () => {
    const notCalled = view()
    const trying = view({ result: 'no_answer_yet', status: 'voicemail', calls: { placed: 1, returned: 0, latestAt: null, latestLabel: 'Voicemail' } })
    const done = view({ result: 'never_reached', status: 'max_attempts', calls: { placed: 3, returned: 0, latestAt: null, latestLabel: 'No answer' } })
    expect(filterContacts([notCalled, trying, done], 'not_called', '').map((c) => c.result)).toEqual(['not_called'])
    expect(filterContacts([notCalled, trying, done], 'no_answer_yet', '').map((c) => c.result)).toEqual(['no_answer_yet'])
    expect(filterContacts([notCalled, trying, done], 'never_reached', '').map((c) => c.result)).toEqual(['never_reached'])
  })

  it('counts each filter over the searched rows', () => {
    const rows = [
      view({ id: 'a', name: 'Testa Synthetic', staffTickets: ['VA-1'], result: 'staff_ticket', calls: { placed: 1, returned: 0, latestAt: null, latestLabel: null } }),
      view({ id: 'b', name: 'Other Person', status: 'declined', result: 'declined', calls: { placed: 1, returned: 0, latestAt: null, latestLabel: null } }),
    ]
    expect(countByFilter(rows, '')).toMatchObject({ all: 2, staff_ticket: 1, declined: 1, not_called: 0 })
    expect(countByFilter(rows, 'testa')).toMatchObject({ all: 1, staff_ticket: 1, declined: 0 })
  })
})

describe('search', () => {
  it('ignores case, accents and word order', () => {
    const c = view({ name: 'José Synthetic' })
    expect(matchesSearch(c, 'jose')).toBe(true)
    expect(matchesSearch(c, 'SYNTHETIC jose')).toBe(true)
    expect(matchesSearch(c, '  ')).toBe(true)
    expect(matchesSearch(c, 'maria')).toBe(false)
    expect(foldName('  Ña   Ñu ')).toBe('na nu')
  })
})

describe('labels and formats', () => {
  it('shows an appointment the way NextGen books it', () => {
    expect(formatApptTime('0930')).toBe('9:30 AM')
    expect(formatApptTime('1400')).toBe('2:00 PM')
    expect(formatApptTime('0005')).toBe('12:05 AM')
    expect(formatApptTime(null)).toBe('-')
    // A calendar day, never shifted by the viewer's zone.
    expect(formatApptDate('2041-02-20')).toBe('Feb 20, 2041')
    expect(formatApptDate('garbage')).toBe('-')
  })

  it('shows an instant in Pacific time', () => {
    // 17:05Z on 2026-11-13 is 9:05 AM PST.
    expect(formatPacific('2026-11-13T17:05:00.000Z')).toBe('Nov 13, 9:05 AM')
    expect(formatPacific(null)).toBe('-')
  })

  it('masks the phone to its last four digits', () => {
    expect(maskedPhone('5551')).toBe('***-5551')
    expect(maskedPhone('+15555551234')).toBe('-')
    expect(maskedPhone(null)).toBe('-')
  })

  it('formats a duration', () => {
    expect(formatDuration(140)).toBe('2m 20s')
    expect(formatDuration(9)).toBe('9s')
    expect(formatDuration(null)).toBe('-')
  })
})

describe('the page can read everything the server builds', () => {
  const NOW = new Date('2026-11-13T18:00:00.000Z')
  const base: RawContact = {
    id: 'x',
    firstName: 'Testa',
    lastName: 'Synthetic',
    phoneLast4: '5551',
    status: 'pending',
    agentNotes: null,
    nextAttemptAt: null,
    eventName: null,
    appointmentDate: null,
    beginTime: null,
    office: null,
    textState: null,
    textSentAt: null,
    textClaimedAt: null,
    textReason: null,
    dobTries: null,
    verifiedAt: null,
    linkBookedAt: null,
    linkBookingId: null,
    smsStopAt: null,
    voiceOptOutAt: null,
  }
  const call = (contactId: string, over: Partial<RawAttempt> = {}): RawAttempt => ({
    id: `${contactId}-a`,
    contactId,
    direction: 'outbound',
    status: 'no-answer',
    answeredBy: null,
    durationSec: null,
    callSid: null,
    attemptedAt: '2026-11-13T17:00:00.000Z',
    callLogId: null,
    runtimeOutcome: null,
    callerSpoke: false,
    bookingAt: null,
    bookingSay: null,
    staffAt: null,
    staffTicket: null,
    ...over,
  })

  it('every result and reason the server can produce has a label', () => {
    const contacts: RawContact[] = [
      { ...base, id: 'booked', agentNotes: 'npx_booking:n1; staff_callback:VA-1' },
      { ...base, id: 'staff', agentNotes: 'staff_callback:VA-2' },
      { ...base, id: 'stop', smsStopAt: '2026-11-13T17:00:00.000Z' },
      { ...base, id: 'declined', status: 'declined' },
      { ...base, id: 'wrong', status: 'wrong_number' },
      { ...base, id: 'over', status: 'rescheduled' },
      { ...base, id: 'reached', status: 'answered' },
      { ...base, id: 'notcalled' },
      { ...base, id: 'trying', status: 'voicemail' },
      { ...base, id: 'done', status: 'max_attempts' },
      { ...base, id: 'notlanded', agentNotes: 'npx_booking:n2' },
    ]
    const attempts = [
      call('booked', { status: 'completed', callerSpoke: true, bookingAt: '2026-11-13T17:01:00.000Z', staffAt: '2026-11-13T17:02:00.000Z', staffTicket: 'VA-1' }),
      call('declined', { status: 'completed', callerSpoke: true }),
      call('reached', { status: 'completed', callerSpoke: true }),
      call('trying', { status: 'voicemail' }),
      call('done'),
      call('wrong', { status: 'fax' }),
      call('over'),
      call('notlanded', { status: 'completed', callerSpoke: true, bookingAt: '2026-11-13T17:01:00.000Z', bookingSay: 'Our team will cancel your appointment with us on Friday' }),
    ]
    const t = buildTracking({ contacts, attempts }, { day: 'all', now: NOW })
    const results = new Set(t.contacts.map((c) => c.result))
    expect(results.size).toBe(Object.keys(RESULT_LABELS).length)
    for (const r of results) expect(RESULT_LABELS[r]).toBeTruthy()
    const reasons = new Set(t.needsPerson.flatMap((n) => n.reasons))
    expect([...reasons].sort()).toEqual(Object.keys(REASON_LABELS).sort())
    for (const c of t.contacts) if (c.booking) expect(CANCEL_LABELS[c.booking.cancel]).toBeTruthy()
    // Every row the server sends lands under at least one filter besides All.
    for (const c of t.contacts as ContactView[]) {
      expect(CONTACT_FILTERS.some((f) => f.key !== 'all' && matchesFilter(c, f.key))).toBe(true)
    }
  })
})
