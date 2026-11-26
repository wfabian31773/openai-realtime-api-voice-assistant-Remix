import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Activity, AlertTriangle, PhoneCall, PhoneOff, RefreshCw, RotateCcw, Ticket, Timer, Wifi } from 'lucide-react'
import {
  agoText,
  durationText,
  outcomeLabel,
  pacificTime,
  pctText,
  RECONNECT_RESULT_LABEL,
  shareText,
  STATUS_CLASS,
  STATUS_LABEL,
  WINDOWS,
  type OperationsReport,
} from '@/lib/operationsView'

interface VoiceHealth {
  marker?: string
  buildSha?: string | null
}

/**
 * The Operations Monitor, read from the call records themselves
 * (GET /api/observatory/operations). Until 2026-11-26 this page read the
 * retired old core's in-memory traces and showed 0 calls and "HEALTHY" while
 * hundreds of calls were being taken.
 */
export function OperationsMonitorPage() {
  const [hours, setHours] = React.useState(24)
  const q = useQuery<OperationsReport>({
    queryKey: ['operations', hours],
    queryFn: async () => (await apiClient.get('/observatory/operations', { params: { hours } })).data,
    refetchInterval: 30_000,
  })
  // The deploy marker the running build reports, so a stale deploy is visible here too.
  const health = useQuery<VoiceHealth>({
    queryKey: ['voice-health'],
    queryFn: async () => {
      const res = await fetch('/voice/health', { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: 60_000,
    retry: false,
  })

  const r = q.data
  const windowLabel = WINDOWS.find((w) => w.hours === hours)?.label.toLowerCase() ?? `last ${hours} hours`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground">Operations Monitor</h1>
            {r && (
              <span className={`rounded-full px-3 py-1 text-sm font-medium uppercase ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
            )}
          </div>
          <p className="mt-1 text-muted-foreground">
            Every call on every line, counted from the call records. Refreshes every 30 seconds.
            {r && <> As of {pacificTime(r.generatedAt)}.</>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Running build: {health.data?.marker ?? (health.isError ? 'unavailable' : '…')}
            {health.data?.buildSha ? ` (${health.data.buildSha})` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(hours)} onChange={(e) => setHours(Number(e.target.value))} className="w-44" aria-label="Window">
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </Select>
          <Button variant="outline" onClick={() => q.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
      {q.isError && (
        <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          The call records could not be read just now, so nothing on this page can be shown. This is not the same as zero calls.
        </div>
      )}

      {r && (
        <>
          <Card>
            <CardContent className="space-y-1 pt-6 text-sm">
              {r.statusReasons.map((s) => (
                <p key={s}>{s}</p>
              ))}
              <p className="text-xs text-muted-foreground">
                Degraded above {r.thresholds.droppedDegradedPct}% dropped or {r.thresholds.deadAirDegradedPct}% dead air, or any call whose end was
                never written; critical above {r.thresholds.droppedCriticalPct}% dropped. Shares are not judged on fewer than{' '}
                {r.thresholds.minCallsForRates} calls.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Tile icon={<Activity className="h-4 w-4" />} title={`Calls (${windowLabel})`} value={r.calls.total.toLocaleString()}>
              Last call {agoText(r.calls.lastCallAt)}
              {r.calls.oldCore > 0 ? ` · ${r.calls.oldCore} on the old core` : ''}
            </Tile>
            <Tile icon={<PhoneCall className="h-4 w-4" />} title="On a call now" value={String(r.calls.live)}>
              Calls started in the last 15 minutes that have not ended
            </Tile>
            <Tile
              icon={<PhoneOff className="h-4 w-4" />}
              title="Dropped by the voice provider"
              value={String(r.calls.dropped)}
              tone={r.rates.droppedPct !== null && r.rates.droppedPct > r.thresholds.droppedDegradedPct ? 'bad' : undefined}
            >
              {pctText(r.rates.droppedPct)} of calls
              {r.calls.failedOther > 0 ? ` · ${r.calls.failedOther} more never connected` : ''}
            </Tile>
            <Tile
              icon={<Timer className="h-4 w-4" />}
              title="Dead air"
              value={String(r.calls.deadAir)}
              tone={r.rates.deadAirPct !== null && r.rates.deadAirPct > r.thresholds.deadAirDegradedPct ? 'bad' : undefined}
            >
              {pctText(r.rates.deadAirPct)} of calls · {r.calls.callerSilent} where the caller never spoke
            </Tile>
            <Tile icon={<RotateCcw className="h-4 w-4" />} title="Drops saved by reconnecting" value={r.reconnects ? String(r.reconnects.reconnected) : '—'}>
              {r.reconnects ? `of ${r.reconnects.drops} provider drops mid-call` : 'No reconnect records available'}
            </Tile>
            <Tile icon={<Wifi className="h-4 w-4" />} title="Transferred to a person or queue" value={String(r.calls.transferred)}>
              {shareText(r.calls.transferred, r.calls.total)} of calls
            </Tile>
            <Tile icon={<Ticket className="h-4 w-4" />} title="Ticket number on the call" value={String(r.calls.withTicket)}>
              {shareText(r.calls.withTicket, r.calls.total)} of all calls, including hang-ups and robocalls; the Observatory has the filing rate
            </Tile>
            <Tile
              icon={<AlertTriangle className="h-4 w-4" />}
              title="End never written"
              value={String(r.calls.stuck)}
              tone={r.calls.stuck > 0 ? 'bad' : undefined}
            >
              Still "in progress" more than 15 minutes after starting
            </Tile>
          </div>

          {r.reconnects && r.reconnects.drops > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What happened to each provider drop</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {Object.entries(r.reconnects.byResult)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <Badge key={k} variant={k === 'reconnected' ? 'secondary' : 'destructive'}>
                      {v} {RECONNECT_RESULT_LABEL[k] ?? k}
                    </Badge>
                  ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By line</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Dropped</TableHead>
                    <TableHead className="text-right">Dead air</TableHead>
                    <TableHead className="text-right">Transferred</TableHead>
                    <TableHead className="text-right">Ticket number on the call</TableHead>
                    <TableHead className="text-right">Average length</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.lanes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                        No calls in this window
                      </TableCell>
                    </TableRow>
                  ) : (
                    r.lanes.map((l) => (
                      <TableRow key={l.lane}>
                        <TableCell className="font-medium">{l.lane}</TableCell>
                        <TableCell className="text-right">{l.calls.toLocaleString()}</TableCell>
                        <TableCell className={`text-right ${l.dropped ? 'text-red-700' : ''}`}>{l.dropped}</TableCell>
                        <TableCell className="text-right">{l.deadAir}</TableCell>
                        <TableCell className="text-right">{l.transferred}</TableCell>
                        <TableCell className="text-right">
                          {l.withTicket} ({shareText(l.withTicket, l.calls)})
                        </TableCell>
                        <TableCell className="text-right">{durationText(l.avgSeconds)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent problem calls</CardTitle>
              <p className="text-xs text-muted-foreground">
                Dropped, dead air, caller never spoke, the 10-minute limit, never connected, or an end never written. The newest 25.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {r.recentProblems.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">None in this window</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When (PT)</TableHead>
                      <TableHead>Line</TableHead>
                      <TableHead>What happened</TableHead>
                      <TableHead className="text-right">Length</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.recentProblems.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{pacificTime(p.at)}</TableCell>
                        <TableCell className="font-medium">{p.lane}</TableCell>
                        <TableCell>{outcomeLabel(p.outcome)}</TableCell>
                        <TableCell className="text-right">{durationText(p.seconds)}</TableCell>
                        <TableCell className="text-right">
                          <Link className="text-sm text-primary underline" to={`/call-logs/${p.id}`}>
                            Open call
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function Tile(props: { icon: React.ReactNode; title: string; value: string; tone?: 'bad'; children?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{props.title}</CardTitle>
        <span className="text-muted-foreground">{props.icon}</span>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${props.tone === 'bad' ? 'text-red-600' : ''}`}>{props.value}</div>
        <p className="text-xs text-muted-foreground">{props.children}</p>
      </CardContent>
    </Card>
  )
}
