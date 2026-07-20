/**
 * SD Pilot Command Center — dedicated screen for the San Diego scheduling
 * pilot (azul-scheduling agent, Encinitas + Oceanside).
 *
 * Everything on this page is scoped to agentUsed='azul-scheduling':
 *   - live calls with near-live transcript + tool timeline
 *   - pilot scoreboard (calls, bookings, cancellations, handoffs, cost)
 *   - purpose + outcome mix
 *   - full call history with per-call evidence drill-in
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Activity, CalendarCheck, CalendarX, PhoneForwarded, Phone,
  DollarSign, Clock, ChevronDown, ChevronRight, Wrench, FileText,
} from 'lucide-react'
import type { CallLog } from '@/types'

const AGENT_SLUG = 'azul-scheduling'

interface PilotStats {
  days: number
  totals: {
    totalCalls: number
    completed: number
    inProgress: number
    avgDurationSec: number
    totalDurationSec: number
    transfers: number
    bookings: number
    cancellations: number
    handoffs: number
    totalOpenaiCostCents: number
    totalTwilioCostCents: number
  }
  byPurpose: Array<{ purpose: string; callCount: number }>
  byOutcome: Array<{ outcome: string; callCount: number }>
}

interface CallLogsResponse {
  data: CallLog[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatCents(cents?: number): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`
}

function purposeBadgeVariant(purpose?: string): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' {
  if (!purpose) return 'secondary'
  if (purpose.startsWith('Handoff')) return 'secondary'
  if (purpose === 'Cancel appointment') return 'destructive'
  if (purpose === 'Schedule appointment') return 'info'
  return 'secondary'
}

function resultBadgeVariant(result?: string): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' {
  if (!result) return 'secondary'
  if (result.startsWith('Booked') || result === 'Cancelled' || result === 'Answered') return 'success'
  if (result.includes('failed') || result.includes('unknown')) return 'destructive'
  if (result.includes('Callback') || result.includes('Transferred')) return 'secondary'
  return 'secondary'
}

function ToolTimeline({ events }: { events: NonNullable<NonNullable<CallLog['toolTimeline']>['events']> }) {
  if (!events.length) {
    return <p className="text-sm text-muted-foreground">No tool calls recorded.</p>
  }
  return (
    <ol className="space-y-1.5">
      {events.map((e, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="font-mono text-xs text-muted-foreground">
            {new Date(e.at).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false })}
          </span>
          <span className="font-medium text-foreground">{e.tool}</span>
          {Object.entries(e.args).map(([k, v]) => (
            <span key={k} className="text-xs text-muted-foreground">{k}={String(v)}</span>
          ))}
          <span className="text-xs text-muted-foreground">→</span>
          {Object.entries(e.outcome).length === 0 ? (
            <span className="text-xs text-muted-foreground">ok</span>
          ) : (
            Object.entries(e.outcome).map(([k, v]) => (
              <span
                key={k}
                className={`text-xs ${k === 'error' ? 'text-destructive font-medium' : k === 'decision' || k === 'booking_status' ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
              >
                {k}={String(v)}
              </span>
            ))
          )}
          <span className="text-xs text-muted-foreground">({e.ms}ms)</span>
        </li>
      ))}
    </ol>
  )
}

function LiveCallCard({ call }: { call: CallLog }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const { data: liveTimeline } = useQuery({
    queryKey: ['azul-timeline', call.callSid],
    queryFn: async () => {
      const res = await apiClient.get(`/voice/azul/tool-timeline/${call.callSid}`)
      return res.data as { events: NonNullable<NonNullable<CallLog['toolTimeline']>['events']>; live: boolean }
    },
    enabled: !!call.callSid,
    refetchInterval: 3000,
    retry: false,
  })

  const startedMs = call.startTime ? new Date(call.startTime).getTime() : new Date(call.createdAt).getTime()
  const liveSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
  const transcriptTail = (call.transcript ?? '').split('\n').filter(Boolean).slice(-8)

  return (
    <Card className="border-primary/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
            </span>
            {call.callerName || call.from}
          </CardTitle>
          <span className="font-mono text-sm text-muted-foreground">{formatDuration(liveSeconds)}</span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
            <FileText className="h-3 w-3" /> Live transcript
          </p>
          {transcriptTail.length ? (
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md bg-muted/50 p-2 text-sm">
              {transcriptTail.map((line, i) => (
                <p key={i} className={line.startsWith('AGENT') ? 'text-primary' : 'text-foreground'}>{line}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for first transcript line…</p>
          )}
        </div>
        <div>
          <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
            <Wrench className="h-3 w-3" /> Tool activity
          </p>
          <div className="max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2">
            <ToolTimeline events={liveTimeline?.events ?? []} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function HistoryRow({ call }: { call: CallLog }) {
  const [open, setOpen] = useState(false)
  const tl = call.toolTimeline

  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setOpen(!open)}>
        <TableCell className="w-8 p-2">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm">
          {new Date(call.createdAt).toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
          })}
        </TableCell>
        <TableCell className="text-sm">{call.callerName || call.from}</TableCell>
        <TableCell><Badge variant={purposeBadgeVariant(tl?.purpose)}>{tl?.purpose ?? 'Not classified'}</Badge></TableCell>
        <TableCell><Badge variant={resultBadgeVariant(tl?.result)}>{tl?.result ?? '—'}</Badge></TableCell>
        <TableCell className="text-sm">{formatDuration(call.duration)}</TableCell>
        <TableCell className="text-sm">
          {call.sentiment ? (
            <Badge variant={call.sentiment === 'satisfied' ? 'success' : call.sentiment === 'neutral' ? 'secondary' : 'destructive'}>
              {call.sentiment}
            </Badge>
          ) : '—'}
        </TableCell>
        <TableCell className="text-right text-sm">{formatCents((call.openaiCostCents ?? 0) + (call.twilioCostCents ?? 0))}</TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30 p-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
                  <Wrench className="h-3 w-3" /> What the agent did
                </p>
                <ToolTimeline events={tl?.events ?? []} />
              </div>
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
                  <FileText className="h-3 w-3" /> Transcript
                </p>
                {call.transcript ? (
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-background p-2 font-sans text-sm">{call.transcript}</pre>
                ) : (
                  <p className="text-sm text-muted-foreground">No transcript captured.</p>
                )}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Link to={`/call-logs/${call.id}`} onClick={(e) => e.stopPropagation()}>
                <Button variant="outline" size="sm">Full call details</Button>
              </Link>
              {call.recordingUrl && <Badge variant="secondary">recording available</Badge>}
              {call.transferredToHuman && <Badge variant="secondary">transferred to human</Badge>}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export function SdPilotPage() {
  const [days, setDays] = useState(30)

  const { data: stats } = useQuery({
    queryKey: ['sd-pilot-stats', days],
    queryFn: async () => (await apiClient.get(`/sd-pilot/stats?days=${days}`)).data as PilotStats,
    refetchInterval: 15000,
  })

  const { data: liveCalls } = useQuery({
    queryKey: ['sd-pilot-live'],
    queryFn: async () =>
      (await apiClient.get(`/call-logs?agentUsed=${AGENT_SLUG}&status=in_progress,ringing,initiated&limit=20`)).data as CallLogsResponse,
    refetchInterval: 3000,
  })

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['sd-pilot-history', days],
    queryFn: async () =>
      (await apiClient.get(`/call-logs?agentUsed=${AGENT_SLUG}&limit=50&sortBy=date&sortOrder=desc`)).data as CallLogsResponse,
    refetchInterval: 10000,
  })

  const totals = stats?.totals
  const active = (liveCalls?.data ?? []).filter((c) => c.status === 'in_progress' || c.status === 'ringing' || c.status === 'initiated')
  const completedCalls = (history?.data ?? []).filter((c) => !active.some((a) => a.id === c.id))

  const kpis = [
    { label: 'Calls', value: totals?.totalCalls ?? 0, icon: Phone, color: 'text-foreground' },
    { label: 'Bookings', value: totals?.bookings ?? 0, icon: CalendarCheck, color: 'text-green-600' },
    { label: 'Cancellations', value: totals?.cancellations ?? 0, icon: CalendarX, color: 'text-orange-600' },
    { label: 'Handoffs', value: totals?.handoffs ?? 0, icon: PhoneForwarded, color: 'text-muted-foreground' },
    { label: 'Avg duration', value: formatDuration(Number(totals?.avgDurationSec ?? 0)), icon: Clock, color: 'text-foreground' },
    {
      label: 'Cost',
      value: formatCents(Number(totals?.totalOpenaiCostCents ?? 0) + Number(totals?.totalTwilioCostCents ?? 0)),
      icon: DollarSign,
      color: 'text-foreground',
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">SD Pilot Command Center</h1>
          <p className="text-muted-foreground">
            Azul scheduling line — San Diego pilot (Encinitas + Oceanside). Every call, every decision, every booking.
          </p>
        </div>
        <div className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'} onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
        </div>
      </div>

      {/* Scoreboard */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardHeader className="pb-1">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <kpi.icon className="h-3.5 w-3.5" /> {kpi.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Live calls */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-foreground">
          <Activity className="h-5 w-5 text-green-600" />
          Live calls {active.length > 0 && <Badge variant="success">{active.length} active</Badge>}
        </h2>
        {active.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No active calls on the scheduling line right now.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {active.map((call) => <LiveCallCard key={call.id} call={call} />)}
          </div>
        )}
      </div>

      {/* Purpose + outcome mix */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Why patients called ({stats?.days ?? days}d)</CardTitle></CardHeader>
          <CardContent>
            {(stats?.byPurpose ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No calls yet.</p>
            ) : (
              <div className="space-y-1.5">
                {(stats?.byPurpose ?? []).map((p) => (
                  <div key={p.purpose} className="flex items-center justify-between text-sm">
                    <Badge variant={purposeBadgeVariant(p.purpose)}>{p.purpose}</Badge>
                    <span className="font-medium">{p.callCount}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Call outcomes (AI-graded)</CardTitle></CardHeader>
          <CardContent>
            {(stats?.byOutcome ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No graded calls yet.</p>
            ) : (
              <div className="space-y-1.5">
                {(stats?.byOutcome ?? []).map((o) => (
                  <div key={o.outcome} className="flex items-center justify-between text-sm">
                    <span className="capitalize text-foreground">{o.outcome.replace(/_/g, ' ')}</span>
                    <span className="font-medium">{o.callCount}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Call history */}
      <div>
        <h2 className="mb-2 text-lg font-semibold text-foreground">Call history</h2>
        <Card>
          <CardContent className="p-0">
            {historyLoading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : completedCalls.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No calls yet — once the pilot number is live, every call lands here with its full evidence trail.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>When (PT)</TableHead>
                    <TableHead>Caller</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Sentiment</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {completedCalls.map((call) => <HistoryRow key={call.id} call={call} />)}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
