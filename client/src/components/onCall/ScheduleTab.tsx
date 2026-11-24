import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import apiClient from '@/lib/apiClient'
import { apiError, fmtPacific, fmtWeek, toPacificInput } from '@/lib/onCallView'
import { Banner, ProviderSelect, ReasonDialog, useOnCall, useOnCallWrite, type PublicProvider } from './shared'
import { AlertTriangle, CalendarPlus, Repeat, ShieldPlus } from 'lucide-react'

interface Week {
  week: string
  startsAt: string
  endsAt: string
  providerId: number | null
  providerName: string | null
  providerActive: boolean | null
  note: string | null
  gap: boolean
  current: boolean
  overrides: Array<{ id: number; startsAt: string; endsAt: string; providerId: number; providerName: string | null; reason: string | null }>
}

interface ScheduleResponse {
  from: string
  to: string
  currentWeek: string
  lastScheduledWeek: string | null
  weeks: Week[]
  gaps: string[]
  providers: PublicProvider[]
}

interface OverrideView {
  id: number
  startsAt: string
  endsAt: string
  providerId: number
  providerName: string | null
  reason: string | null
  state: 'past' | 'active' | 'upcoming'
}

export function ScheduleTab() {
  const [range, setRange] = React.useState<{ from?: string; to?: string }>({})
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v) as [string, string][]).toString()
  const q = useOnCall<ScheduleResponse>(`/schedule${qs ? `?${qs}` : ''}`)
  const ov = useOnCall<{ overrides: OverrideView[] }>('/overrides')
  const write = useOnCallWrite()

  const [assign, setAssign] = React.useState<Week | null>(null)
  const [assignTo, setAssignTo] = React.useState<number | ''>('')
  const [swapOpen, setSwapOpen] = React.useState(false)
  const [swap, setSwap] = React.useState<{ a: string; b: string }>({ a: '', b: '' })
  const [extendOpen, setExtendOpen] = React.useState(false)
  const [extendWeeks, setExtendWeeks] = React.useState(8)
  const [extendPreview, setExtendPreview] = React.useState<{ weeks: Array<{ week: string; providerName: string | null }>; warnings: string[] } | null>(null)
  const [coverOpen, setCoverOpen] = React.useState(false)
  const [cover, setCover] = React.useState<{ startsAt: string; endsAt: string; providerId: number | ''; confirmOverlap: boolean }>({
    startsAt: toPacificInput(new Date()),
    endsAt: toPacificInput(new Date(Date.now() + 15 * 3_600_000)),
    providerId: '',
    confirmOverlap: false,
  })
  const [overlap, setOverlap] = React.useState<string | null>(null)
  const [cancel, setCancel] = React.useState<OverrideView | null>(null)

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (q.error) return <Banner tone="error">{apiError(q.error)}</Banner>
  const data = q.data
  if (!data?.weeks) return null
  const scheduled = data.weeks.filter((w) => !w.gap)

  const loadExtendPreview = async (n: number) => {
    try {
      const { data: d } = await apiClient.post('/on-call/schedule/extend', { weeks: n, dryRun: true })
      setExtendPreview(d)
    } catch (e) {
      setExtendPreview({ weeks: [], warnings: [apiError(e)] })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label>From (Tuesday)</Label>
          <Input type="date" value={range.from ?? data.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        </div>
        <div>
          <Label>To (Tuesday)</Label>
          <Input type="date" value={range.to ?? data.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        </div>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => setSwapOpen(true)}>
          <Repeat className="mr-1 h-4 w-4" /> Swap two weeks
        </Button>
        <Button variant="outline" onClick={() => { setCover((c) => ({ ...c, confirmOverlap: false })); setOverlap(null); setCoverOpen(true) }}>
          <ShieldPlus className="mr-1 h-4 w-4" /> Cover part of a week
        </Button>
        <Button variant="outline" onClick={() => { setExtendOpen(true); loadExtendPreview(extendWeeks) }}>
          <CalendarPlus className="mr-1 h-4 w-4" /> Extend schedule
        </Button>
      </div>

      {data.gaps.length > 0 && (
        <Banner tone="error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {data.gaps.length} week(s) in this range have nobody scheduled ({data.gaps.map(fmtWeek).join(', ')}). An urgent call in
          those weeks rings only the final director.
        </Banner>
      )}
      <p className="text-xs text-muted-foreground">
        All times Pacific. A rotation week runs Tuesday 5:00 PM to the next Tuesday 8:00 AM; weekday daytime (Mon–Fri 8:00 AM–4:59 PM) is
        not on call. Schedule ends {data.lastScheduledWeek ? `with the week of ${fmtWeek(data.lastScheduledWeek)}` : '— nothing scheduled'}.
      </p>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Week</TableHead>
                <TableHead>On call</TableHead>
                <TableHead>Overrides in this week</TableHead>
                <TableHead>Note</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.weeks.map((w) => (
                <TableRow key={w.week} className={w.gap ? 'bg-red-500/10' : w.current ? 'bg-primary/10' : ''}>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-medium">{fmtWeek(w.week)} 5 PM</div>
                    <div className="text-xs text-muted-foreground">to {fmtPacific(w.endsAt)}</div>
                    {w.current && <Badge variant="info">this week</Badge>}
                  </TableCell>
                  <TableCell>
                    {w.gap ? (
                      <Badge variant="destructive">GAP — nobody scheduled</Badge>
                    ) : (
                      <span className={w.providerActive ? '' : 'text-destructive'}>
                        {w.providerName}
                        {!w.providerActive && ' (inactive!)'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {w.overrides.map((o) => (
                      <div key={o.id}>
                        <Badge variant="warning">#{o.id}</Badge> {o.providerName} · {fmtPacific(o.startsAt)} → {fmtPacific(o.endsAt)}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={w.note ?? ''}>
                    {w.note}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant={w.gap ? 'default' : 'outline'} onClick={() => { setAssign(w); setAssignTo('') }}>
                      {w.gap ? 'Fill' : 'Swap'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Overrides (covers)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Window (PT)</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(ov.data?.overrides ?? []).map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.id}</TableCell>
                  <TableCell className="text-sm">
                    {fmtPacific(o.startsAt)} → {fmtPacific(o.endsAt)}
                  </TableCell>
                  <TableCell>{o.providerName}</TableCell>
                  <TableCell className="text-sm">{o.reason}</TableCell>
                  <TableCell>
                    <Badge variant={o.state === 'active' ? 'info' : o.state === 'upcoming' ? 'warning' : 'secondary'}>{o.state}</Badge>
                  </TableCell>
                  <TableCell>
                    {o.state !== 'past' && (
                      <Button size="sm" variant="destructive" onClick={() => setCancel(o)}>
                        {o.state === 'active' ? 'End now' : 'Cancel'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(ov.data?.overrides ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No overrides on file.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ReasonDialog
        open={assign !== null}
        onOpenChange={(o) => !o && setAssign(null)}
        title={assign?.gap ? `Fill the week of ${assign ? fmtWeek(assign.week) : ''}` : `Swap the week of ${assign ? fmtWeek(assign.week) : ''}`}
        description={assign && !assign.gap ? `Currently ${assign.providerName}. The whole week (Tue 5 PM → Tue 8 AM PT) goes to the provider you pick.` : 'Nobody is scheduled for this week.'}
        confirmLabel={assign?.gap ? 'Fill week' : 'Swap week'}
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: '/schedule/assign', body: { week: assign!.week, providerId: assignTo, reason } })}
      >
        <Label>New provider</Label>
        <ProviderSelect providers={data.providers} value={assignTo} onChange={setAssignTo} />
      </ReasonDialog>

      <ReasonDialog
        open={swapOpen}
        onOpenChange={setSwapOpen}
        title="Swap two weeks"
        description="The two weeks' providers trade places."
        confirmLabel="Swap"
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: '/schedule/swap-weeks', body: { weekA: swap.a, weekB: swap.b, reason } })}
      >
        {(['a', 'b'] as const).map((k) => (
          <div key={k}>
            <Label>Week {k.toUpperCase()}</Label>
            <Select value={swap[k]} onChange={(e) => setSwap((s) => ({ ...s, [k]: e.target.value }))}>
              <option value="">Choose a week…</option>
              {scheduled.map((w) => (
                <option key={w.week} value={w.week}>
                  {fmtWeek(w.week)} — {w.providerName}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </ReasonDialog>

      <ReasonDialog
        open={extendOpen}
        onOpenChange={setExtendOpen}
        title="Extend the schedule"
        description="Adds weeks after the last one, continuing the rotation order among active providers (the same as scripts/on-call-change.ts extend)."
        confirmLabel="Add these weeks"
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: '/schedule/extend', body: { weeks: extendWeeks, reason } })}
      >
        <Label>Weeks to add</Label>
        <Input
          type="number"
          min={1}
          max={104}
          value={extendWeeks}
          onChange={(e) => {
            const n = Number(e.target.value)
            setExtendWeeks(n)
            loadExtendPreview(n)
          }}
        />
        {extendPreview && (
          <div className="max-h-48 overflow-y-auto rounded border p-2 text-sm">
            {extendPreview.warnings.map((w) => (
              <div key={w} className="text-destructive">
                {w}
              </div>
            ))}
            {extendPreview.weeks.map((w) => (
              <div key={w.week}>
                {fmtWeek(w.week)} — {w.providerName}
              </div>
            ))}
          </div>
        )}
      </ReasonDialog>

      <ReasonDialog
        open={coverOpen}
        onOpenChange={setCoverOpen}
        title="Cover part of a week"
        description="Someone covers a window (an evening, a weekend). It decides WHO for those hours and never WHETHER: weekday daytime inside it is still not on call. When overrides overlap, the one that starts latest wins."
        confirmLabel={cover.confirmOverlap ? 'Save despite overlap' : 'Save cover'}
        onConfirm={async (reason) => {
          try {
            await write.mutateAsync({ method: 'post', path: '/overrides', body: { ...cover, reason } })
            setOverlap(null)
          } catch (e: any) {
            if (e?.response?.status === 409 && e.response.data?.overlap) {
              setOverlap(`Overlaps override(s) #${e.response.data.overlap.map((o: any) => o.id).join(', #')}. Tick the box to save anyway.`)
            }
            throw e
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label>Starts (Pacific)</Label>
            <Input type="datetime-local" value={cover.startsAt} onChange={(e) => setCover((c) => ({ ...c, startsAt: e.target.value }))} />
          </div>
          <div>
            <Label>Ends (Pacific)</Label>
            <Input type="datetime-local" value={cover.endsAt} onChange={(e) => setCover((c) => ({ ...c, endsAt: e.target.value }))} />
          </div>
        </div>
        <Label>Covering provider</Label>
        <ProviderSelect providers={data.providers} value={cover.providerId} onChange={(id) => setCover((c) => ({ ...c, providerId: id }))} />
        {overlap && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cover.confirmOverlap} onChange={(e) => setCover((c) => ({ ...c, confirmOverlap: e.target.checked }))} />
            {overlap}
          </label>
        )}
      </ReasonDialog>

      <ReasonDialog
        open={cancel !== null}
        onOpenChange={(o) => !o && setCancel(null)}
        title={cancel?.state === 'active' ? `End override #${cancel?.id} now` : `Cancel override #${cancel?.id}`}
        description={cancel?.state === 'active' ? "It is running: it will end now and the week's provider takes over." : 'It has not started: it will be removed.'}
        destructive
        confirmLabel={cancel?.state === 'active' ? 'End now' : 'Cancel override'}
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: `/overrides/${cancel!.id}/cancel`, body: { reason } })}
      />
    </div>
  )
}
