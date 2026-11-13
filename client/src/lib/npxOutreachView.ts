/**
 * The NPX outreach tracking screen's client half: the response's shape (a
 * mirror of server/observatory/npxOutreach.logic.ts), the table's filters and
 * search, and the labels. Pure, so the filters are tested without a DOM.
 */

export type CancelState = 'landed' | 'not_landed' | 'not_recorded'
export type BookedBy = 'phone' | 'link'
export type DayKey = 'all' | 'today' | 'yesterday'
export type CampaignKey = 'live' | 'demo'

export type ContactResult =
  | 'booked'
  | 'staff_ticket'
  | 'opted_out'
  | 'declined'
  | 'wrong_number'
  | 'appointment_over'
  | 'reached'
  | 'not_called'
  | 'no_answer_yet'
  | 'never_reached'

export interface AttemptView {
  id: string
  at: string | null
  direction: 'outbound' | 'inbound'
  status: string
  label: string
  answeredBy: string | null
  durationSec: number | null
  callSid: string | null
  callLogId: string | null
  runtimeOutcome: string | null
  callerSpoke: boolean
  booked: boolean
  staffTicket: string | null
  /** Every ticket the call created: the call log's, then any other its timeline recorded. */
  tickets?: string[]
}

export interface BookingView {
  id: string | null
  by: BookedBy
  at: string | null
  cancel: CancelState
  callLogId: string | null
}

export interface ContactView {
  id: string
  name: string
  phoneLast4: string | null
  appointment: { event: string | null; date: string | null; time: string | null; office: string | null }
  status: string
  result: ContactResult
  calls: { placed: number; returned: number; latestAt: string | null; latestLabel: string | null }
  reached: boolean
  text: { state: string; sentAt: string | null; reason: string | null } | null
  link: { dobTried: boolean; verifiedAt: string | null }
  booking: BookingView | null
  staffTickets: string[]
  bookedThenStaffSameCall: boolean
  optOut: { voice: boolean; voiceAt: string | null; sms: boolean; smsAt: string | null }
  nextAttemptAt: string | null
  attempts: AttemptView[]
}

export type NeedsPersonReason = 'staff_ticket' | 'cancel_not_landed' | 'cancel_not_recorded' | 'booked_then_staff_same_call'

export interface NeedsPersonItem {
  contactId: string
  name: string
  reasons: NeedsPersonReason[]
  staffTickets: string[]
  bookingId: string | null
  bookedBy: BookedBy | null
  at: string | null
}

export interface Totals {
  onList: number
  called: number
  answeredByPerson: number
  connected: number
  returnedCalls: number
  textsSent: number
  textsUnknown: number
  linkDobTried: number | null
  linkDobConfirmed: number
  bookedByPhone: number
  bookedByLink: number
  cancelLanded: number
  cancelNotLanded: number
  cancelNotRecorded: number
  staffTickets: number
  optedOutVoice: number
  optedOutSms: number
  declined: number
  wrongNumber: number
}

export interface TrackingResponse {
  campaign: { key: CampaignKey; name: string; found: boolean }
  generatedAt: string
  day: { key: DayKey; date: string | null }
  totals: Totals
  needsPerson: NeedsPersonItem[]
  contacts: ContactView[]
}

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * The table's filters are FACTS, not the exclusive headline result: a person
 * who booked and then texted STOP shows under both "Booked" and "Opted out".
 */
export type ContactFilter =
  | 'all'
  | 'reached'
  | 'booked'
  | 'staff_ticket'
  | 'opted_out'
  | 'declined'
  | 'wrong_number'
  | 'appointment_over'
  | 'no_answer_yet'
  | 'never_reached'
  | 'not_called'

export const CONTACT_FILTERS: Array<{ key: ContactFilter; label: string; hint: string }> = [
  { key: 'all', label: 'All', hint: 'Everyone in view' },
  { key: 'reached', label: 'Reached', hint: 'A person spoke on a call, called us back, or confirmed their date of birth on the text link' },
  { key: 'booked', label: 'Booked', hint: 'Booked a sooner exam, by phone or by the text link' },
  { key: 'staff_ticket', label: 'Staff ticket', hint: 'Asked for a person: a ticket went to the HVA Hub' },
  { key: 'opted_out', label: 'Opted out', hint: 'Asked on a call not to be called, or texted STOP' },
  { key: 'declined', label: 'Declined', hint: 'Said no to a sooner exam' },
  { key: 'wrong_number', label: 'Wrong number', hint: 'Not the patient, or a fax' },
  { key: 'appointment_over', label: 'Appointment moved', hint: 'Cancelled or moved in NextGen, so no longer a reason to call' },
  { key: 'no_answer_yet', label: 'No answer yet', hint: 'Called, nobody reached yet, still being tried' },
  { key: 'never_reached', label: 'Never reached', hint: 'Called, nobody reached, no more tries' },
  { key: 'not_called', label: 'Not called yet', hint: 'No call has been placed' },
]

export function matchesFilter(c: ContactView, filter: ContactFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'reached':
      return c.reached
    case 'booked':
      return c.booking !== null
    case 'staff_ticket':
      return c.staffTickets.length > 0
    case 'opted_out':
      return c.optOut.voice || c.optOut.sms || c.result === 'opted_out'
    case 'declined':
      return c.status === 'declined'
    case 'wrong_number':
      return c.status === 'wrong_number'
    case 'appointment_over':
      return c.status === 'rescheduled'
    case 'no_answer_yet':
      return c.result === 'no_answer_yet'
    case 'never_reached':
      return c.result === 'never_reached'
    case 'not_called':
      return c.calls.placed === 0
  }
}

/** Case and accents ignored, so "Jose" finds "José". */
export function foldName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Every word of the search must appear in the name, in any order. */
export function matchesSearch(c: ContactView, query: string): boolean {
  const words = foldName(query).split(' ').filter(Boolean)
  if (words.length === 0) return true
  const name = foldName(c.name)
  return words.every((w) => name.includes(w))
}

export function filterContacts(contacts: ContactView[], filter: ContactFilter, query: string): ContactView[] {
  return contacts.filter((c) => matchesFilter(c, filter) && matchesSearch(c, query))
}

export function countByFilter(contacts: ContactView[], query: string): Record<ContactFilter, number> {
  const out = {} as Record<ContactFilter, number>
  for (const f of CONTACT_FILTERS) out[f.key] = 0
  for (const c of contacts) {
    if (!matchesSearch(c, query)) continue
    for (const f of CONTACT_FILTERS) if (matchesFilter(c, f.key)) out[f.key]++
  }
  return out
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const RESULT_LABELS: Record<ContactResult, string> = {
  booked: 'Booked',
  staff_ticket: 'Staff ticket',
  opted_out: 'Opted out',
  declined: 'Declined',
  wrong_number: 'Wrong number',
  appointment_over: 'Appointment moved or cancelled',
  reached: 'Reached',
  not_called: 'Not called yet',
  no_answer_yet: 'No answer yet',
  never_reached: 'Never reached',
}

export const REASON_LABELS: Record<NeedsPersonReason, string> = {
  staff_ticket: 'Staff ticket filed',
  cancel_not_landed: 'Azul cancel did not land',
  cancel_not_recorded: 'Azul cancel not recorded',
  booked_then_staff_same_call: 'Booked, then asked for staff on the same call',
}

export const CANCEL_LABELS: Record<CancelState, string> = {
  landed: 'Cancelled',
  not_landed: 'Not cancelled',
  not_recorded: 'Not recorded',
}

export const TEXT_STATE_LABELS: Record<string, string> = {
  sent: 'Sent',
  unknown: 'May have sent',
  failed: 'Failed',
  skipped: 'Skipped',
  retry: 'Retrying',
  claimed: 'Sending',
}

const PACIFIC: Intl.DateTimeFormatOptions = { timeZone: 'America/Los_Angeles' }

/** An instant in Pacific time: "Nov 13, 9:05 AM". */
export function formatPacific(at: string | null | undefined): string {
  if (!at) return '-'
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('en-US', { ...PACIFIC, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** An appointment date (YYYY-MM-DD, a calendar day, no zone): "Feb 20, 2041". */
export function formatApptDate(date: string | null): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '-'
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** NextGen's HHMM begin time: "0930" is "9:30 AM". */
export function formatApptTime(time: string | null): string {
  if (!time || !/^\d{3,4}$/.test(time)) return '-'
  const padded = time.padStart(4, '0')
  const hours = Number(padded.slice(0, 2))
  const minutes = padded.slice(2)
  const period = hours >= 12 ? 'PM' : 'AM'
  const shown = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours
  return `${shown}:${minutes} ${period}`
}

export function formatDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return '-'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/** The phone as the page may show it: last four digits only. */
export function maskedPhone(last4: string | null): string {
  return last4 && /^\d{1,4}$/.test(last4) ? `***-${last4}` : '-'
}
