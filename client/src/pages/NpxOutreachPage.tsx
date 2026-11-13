import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import {
  CANCEL_LABELS,
  CONTACT_FILTERS,
  REASON_LABELS,
  RESULT_LABELS,
  TEXT_STATE_LABELS,
  countByFilter,
  filterContacts,
  formatApptDate,
  formatApptTime,
  formatDuration,
  formatPacific,
  jumpStep,
  maskedPhone,
  type CampaignKey,
  type CancelState,
  type ContactFilter,
  type ContactResult,
  type ContactView,
  type DayKey,
  type TrackingResponse,
} from '@/lib/npxOutreachView'

const PAGE_SIZE = 100

const DAY_OPTIONS: Array<{ key: DayKey; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
]

const RESULT_VARIANT: Record<ContactResult, 'success' | 'info' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  booked: 'success',
  staff_ticket: 'info',
  opted_out: 'destructive',
  declined: 'secondary',
  wrong_number: 'secondary',
  appointment_over: 'outline',
  reached: 'info',
  not_called: 'outline',
  no_answer_yet: 'warning',
  never_reached: 'secondary',
}

const CANCEL_VARIANT: Record<CancelState, 'success' | 'destructive' | 'warning'> = {
  landed: 'success',
  not_landed: 'destructive',
  not_recorded: 'warning',
}

function Stat({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value === null ? '-' : value.toLocaleString()}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

function CallLink({ callLogId, children }: { callLogId: string | null; children: React.ReactNode }) {
  if (!callLogId) return <>{children}</>
  return (
    <Link to={`/call-logs/${callLogId}`} className="text-primary underline-offset-2 hover:underline">
      {children}
    </Link>
  )
}

function Attempts({ contact }: { contact: ContactView }) {
  if (contact.attempts.length === 0) {
    return <p className="text-sm text-muted-foreground">No call attempts on this contact yet.</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When (Pacific)</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>AMD</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Call outcome</TableHead>
          <TableHead>On this call</TableHead>
          <TableHead>Call SID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contact.attempts.map((a) => (
          <TableRow key={a.id}>
            <TableCell className="whitespace-nowrap">{formatPacific(a.at)}</TableCell>
            <TableCell>{a.direction === 'inbound' ? 'They called us' : 'We called'}</TableCell>
            <TableCell>{a.label}</TableCell>
            <TableCell>{a.answeredBy ?? '-'}</TableCell>
            <TableCell>{formatDuration(a.durationSec)}</TableCell>
            <TableCell>{a.runtimeOutcome ?? (a.callLogId ? '-' : 'no call log')}</TableCell>
            <TableCell className="space-x-1">
              {a.booked ? <Badge variant="success">Booked</Badge> : null}
              {(a.tickets && a.tickets.length > 0 ? a.tickets : a.staffTicket ? [a.staffTicket] : []).map((t) => (
                <Badge key={t} variant="info">{t}</Badge>
              ))}
            </TableCell>
            <TableCell className="font-mono text-xs">
              <CallLink callLogId={a.callLogId}>{a.callSid ?? '-'}</CallLink>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ContactRow({ contact, open, onToggle }: { contact: ContactView; open: boolean; onToggle: () => void }) {
  const c = contact
  return (
    <Fragment>
      <TableRow id={`npx-contact-${c.id}`} className="cursor-pointer" onClick={onToggle}>
        <TableCell className="w-6 align-top">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
        <TableCell className="align-top">
          <div className="font-medium">{c.name}</div>
          <div className="text-xs text-muted-foreground">{maskedPhone(c.phoneLast4)}</div>
        </TableCell>
        <TableCell className="align-top">
          <div>{c.appointment.event ?? '-'}</div>
          <div className="text-xs text-muted-foreground">
            {formatApptDate(c.appointment.date)} {formatApptTime(c.appointment.time)}
          </div>
          <div className="text-xs text-muted-foreground">{c.appointment.office ?? '-'}</div>
        </TableCell>
        <TableCell className="align-top">
          <div>
            {c.calls.placed} call{c.calls.placed === 1 ? '' : 's'}
            {c.calls.returned > 0 ? `, ${c.calls.returned} back` : ''}
          </div>
          <div className="text-xs text-muted-foreground">
            {c.calls.latestLabel ? `${c.calls.latestLabel}, ${formatPacific(c.calls.latestAt)}` : '-'}
          </div>
        </TableCell>
        <TableCell className="align-top">
          {c.text ? (
            <>
              <div>{TEXT_STATE_LABELS[c.text.state] ?? c.text.state}</div>
              <div className="text-xs text-muted-foreground">{c.text.sentAt ? formatPacific(c.text.sentAt) : c.text.reason ?? ''}</div>
            </>
          ) : (
            '-'
          )}
        </TableCell>
        <TableCell className="align-top">
          {c.link.verifiedAt ? (
            <>
              <div>Verified</div>
              <div className="text-xs text-muted-foreground">{formatPacific(c.link.verifiedAt)}</div>
            </>
          ) : c.link.dobTried ? (
            'Tried, not verified'
          ) : (
            'No'
          )}
        </TableCell>
        <TableCell className="align-top">
          {c.booking ? (
            <>
              <div className="font-mono text-xs">{c.booking.id ?? 'id not in the Hub'}</div>
              <div className="text-xs text-muted-foreground">
                by {c.booking.by}
                {c.booking.at ? `, ${formatPacific(c.booking.at)}` : ''}
              </div>
            </>
          ) : (
            '-'
          )}
        </TableCell>
        <TableCell className="align-top">
          {c.booking ? <Badge variant={CANCEL_VARIANT[c.booking.cancel]}>{CANCEL_LABELS[c.booking.cancel]}</Badge> : '-'}
        </TableCell>
        <TableCell className="align-top font-mono text-xs">{c.staffTickets.length > 0 ? c.staffTickets.join(', ') : '-'}</TableCell>
        <TableCell className="align-top text-xs">
          {c.optOut.voice || c.optOut.sms ? (
            <>
              {c.optOut.voice ? <div>Voice{c.optOut.voiceAt ? `, ${formatPacific(c.optOut.voiceAt)}` : ''}</div> : null}
              {c.optOut.sms ? <div>SMS STOP{c.optOut.smsAt ? `, ${formatPacific(c.optOut.smsAt)}` : ''}</div> : null}
            </>
          ) : (
            '-'
          )}
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={RESULT_VARIANT[c.result]}>{RESULT_LABELS[c.result]}</Badge>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell />
          <TableCell colSpan={10} className="bg-muted/30">
            <Attempts contact={c} />
            {c.booking && !c.booking.id ? (
              <p className="mt-2 text-xs text-muted-foreground">
                The NPX booking id is not in the Hub for this contact: a later staff note replaced it. The staff ticket's
                description carries it.
              </p>
            ) : null}
            {c.nextAttemptAt ? (
              <p className="mt-2 text-xs text-muted-foreground">Next look by the dialler: {formatPacific(c.nextAttemptAt)}</p>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  )
}

export function NpxOutreachPage() {
  const [campaign, setCampaign] = useState<CampaignKey>('live')
  const [day, setDay] = useState<DayKey>('all')
  const [filter, setFilter] = useState<ContactFilter>('all')
  const [query, setQuery] = useState('')
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE_SIZE)

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['npx-outreach-tracking', campaign, day],
    queryFn: async () => (await apiClient.get<TrackingResponse>(`/npx-outreach/tracking?campaign=${campaign}&day=${day}`)).data,
    staleTime: 60_000,
  })

  const contacts = data?.contacts ?? []
  const counts = useMemo(() => countByFilter(contacts, query), [contacts, query])
  const rows = useMemo(() => filterContacts(contacts, filter, query), [contacts, filter, query])

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // The needs-a-person list is all time; the table follows the day filter. A
  // contact not in view brings the table back to all time, and the jump waits
  // for those rows before it pages and scrolls (`jumpStep`).
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  const showContact = (id: string) => {
    if (!contacts.some((c) => c.id === id)) setDay('all')
    setFilter('all')
    setQuery('')
    setOpenIds((prev) => new Set(prev).add(id))
    setJumpTo(id)
  }
  const jumpReady = !!data && !isFetching && filter === 'all' && query === ''
  useEffect(() => {
    if (!jumpTo) return
    const step = jumpStep({ rows, id: jumpTo, shown, pageSize: PAGE_SIZE, ready: jumpReady, allTime: day === 'all' })
    if (step.kind === 'show') setShown(step.shown)
    else if (step.kind === 'give_up') setJumpTo(null)
    else if (step.kind === 'scroll') {
      document.getElementById(`npx-contact-${jumpTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setJumpTo(null)
    }
  }, [jumpTo, rows, shown, jumpReady, day])

  const t = data?.totals
  const dayLabel = DAY_OPTIONS.find((d) => d.key === day)?.label ?? 'All time'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">NPX Outreach</h1>
          <p className="text-sm text-muted-foreground">
            Who the campaign reached, what came of it, who booked and who needs a person. Read from the Hub; times in Pacific.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {(['live', 'demo'] as const).map((k) => (
              <Button key={k} size="sm" variant={campaign === k ? 'default' : 'ghost'} onClick={() => setCampaign(k)}>
                {k === 'live' ? 'Live' : 'Demo'}
              </Button>
            ))}
          </div>
          <div className="flex rounded-md border p-0.5">
            {DAY_OPTIONS.map((d) => (
              <Button key={d.key} size="sm" variant={day === d.key ? 'default' : 'ghost'} onClick={() => setDay(d.key)}>
                {d.label}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">Could not load the NPX outreach tracking. Try Refresh.</CardContent>
        </Card>
      ) : null}
      {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {data && !data.campaign.found ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            The {data.campaign.name} campaign has no row on the Hub yet: it has never run.
          </CardContent>
        </Card>
      ) : null}

      {data && t ? (
        <>
          <div className="text-xs text-muted-foreground">
            {dayLabel}
            {data.day.date ? ` (${data.day.date})` : ''} · campaign {data.campaign.name} · as of {formatPacific(data.generatedAt)}
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label="On the list (now)" value={t.onList} />
            <Stat label="Called at least once" value={t.called} />
            <Stat
              label="Answered by a person"
              value={t.answeredByPerson}
              sub={`put through ${t.connected}, called us back ${t.returnedCalls}`}
            />
            <Stat label="Texts sent" value={t.textsSent} sub={t.textsUnknown > 0 ? `${t.textsUnknown} may have sent` : undefined} />
            <Stat
              label="Link: date of birth confirmed"
              value={t.linkDobConfirmed}
              sub={t.linkDobTried === null ? 'tries carry no time' : `${t.linkDobTried} tried`}
            />
            <Stat label="Booked by phone" value={t.bookedByPhone} />
            <Stat label="Booked by link" value={t.bookedByLink} />
            <Stat
              label="Azul cancel landed"
              value={t.cancelLanded}
              sub={`not landed ${t.cancelNotLanded}, not recorded ${t.cancelNotRecorded}`}
            />
            <Stat label="Staff tickets" value={t.staffTickets} />
            <Stat label="Opted out" value={t.optedOutVoice + t.optedOutSms} sub={`voice ${t.optedOutVoice}, SMS STOP ${t.optedOutSms}`} />
            <Stat label="Declined" value={t.declined} />
            <Stat label="Wrong number" value={t.wrongNumber} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                Needs a person ({data.needsPerson.length})
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                All time, whatever the day filter: staff tickets, bookings whose Azul cancel did not land or is not recorded, and
                calls that booked and then asked for staff. Whether a ticket has been worked lives in the Support Center.
              </p>
            </CardHeader>
            <CardContent>
              {data.needsPerson.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing waiting.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Patient</TableHead>
                      <TableHead>Why</TableHead>
                      <TableHead>Staff ticket</TableHead>
                      <TableHead>NPX booking</TableHead>
                      <TableHead>When (Pacific)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.needsPerson.map((n) => (
                      <TableRow key={n.contactId}>
                        <TableCell>
                          <button className="text-left text-primary underline-offset-2 hover:underline" onClick={() => showContact(n.contactId)}>
                            {n.name}
                          </button>
                        </TableCell>
                        <TableCell className="space-x-1 space-y-1">
                          {n.reasons.map((r) => (
                            <Badge key={r} variant={r === 'staff_ticket' ? 'info' : 'warning'}>
                              {REASON_LABELS[r]}
                            </Badge>
                          ))}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{n.staffTickets.join(', ') || '-'}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {n.bookingId ?? (n.bookedBy ? 'id not in the Hub' : '-')}
                          {n.bookedBy ? <span className="ml-1 font-sans text-muted-foreground">({n.bookedBy})</span> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{formatPacific(n.at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Contacts ({rows.length}
                {day !== 'all' ? ` with activity ${dayLabel.toLowerCase()}` : ''})
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {CONTACT_FILTERS.map((f) => (
                  <Button
                    key={f.key}
                    size="sm"
                    variant={filter === f.key ? 'default' : 'outline'}
                    title={f.hint}
                    onClick={() => {
                      setFilter(f.key)
                      setShown(PAGE_SIZE)
                    }}
                  >
                    {f.label} <span className="ml-1 tabular-nums opacity-70">{counts[f.key]}</span>
                  </Button>
                ))}
                <div className="relative ml-auto w-full sm:w-64">
                  <Search className="absolute left-2 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Search by name"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setShown(PAGE_SIZE)
                    }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead>Patient</TableHead>
                    <TableHead>Appointment</TableHead>
                    <TableHead>Calls</TableHead>
                    <TableHead>Text</TableHead>
                    <TableHead>Link</TableHead>
                    <TableHead>NPX booking</TableHead>
                    <TableHead>Azul cancel</TableHead>
                    <TableHead>Staff ticket</TableHead>
                    <TableHead>Opt-out</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, shown).map((c) => (
                    <ContactRow key={c.id} contact={c} open={openIds.has(c.id)} onToggle={() => toggle(c.id)} />
                  ))}
                </TableBody>
              </Table>
              {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No contacts match.</p> : null}
              {rows.length > shown ? (
                <div className="pt-3 text-center">
                  <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                    Show {Math.min(PAGE_SIZE, rows.length - shown)} more of {rows.length - shown}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Where these numbers come from</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-muted-foreground">
              <p>Every count is of contacts. With a day filter a contact counts when the event happened that Pacific day; an event the Hub holds no time for counts for all time only.</p>
              <p>Called: an outbound attempt Twilio placed. Answered by a person: the call's transcript has the caller speaking (a silent pickup is "put through", not answered).</p>
              <p>Texts and the link: the contact's outreach text record. Booked by link: the booking the link page recorded.</p>
              <p>Booked by phone: a successful booking on one of the contact's calls. The NPX id comes from the contact's note and is missing where a later staff note replaced it.</p>
              <p>Azul cancel: what the booking confirmation told the caller. The link page records no cancel result here, so a link booking reads "not recorded"; check NPX's backup list.</p>
              <p>Opted out: the do-not-contact list (SMS STOP, or a voice opt-out on any NPX call). Declined and wrong number: the contact's status, timed by its latest call.</p>
              <p>Not shown: NPX's own booking table (another database), and whether a staff ticket has been worked (the Support Center).</p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

export default NpxOutreachPage
