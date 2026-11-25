import React from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  apiError,
  chainStatusVariant,
  fmtPacific,
  fmtPacificTime,
  fmtSeconds,
  sectionBadge,
  SOURCE_LABELS,
  timelineVariant,
} from '@/lib/onCallView'
import { Banner, useOnCall } from './shared'
import { ArrowLeft, ExternalLink } from 'lucide-react'

interface ChainSummary {
  mode: string
  status: string
  acceptedByName: string | null
  acceptedAt: string | null
  secondsToAccept: number | null
  calls: number
  texts: number
  levelsReached: number
  exhausted: boolean
  firstLevel: string | null
  routingReason: string | null
}

interface CallRow {
  callSid: string
  callLogId: string | null
  startedAt: string | null
  callerLast4: string | null
  agent: string | null
  runtimeOutcome: string | null
  durationSec: number | null
  chain: ChainSummary | null
}

interface TimelineItem {
  at: string
  source: string
  kind: string
  title: string
  detail?: string
  status?: string
  approximateTime?: boolean
  data?: Record<string, unknown>
}

interface CallDetail {
  callSid: string
  callLogId: string | null
  caller: string | null
  agent: string | null
  escalation: { id: number; mode: string; status: string; routing: Record<string, unknown> | null } | null
  outcome: Omit<ChainSummary, 'mode'>
  timeline: TimelineItem[]
  sections: Record<string, { wired: boolean; present: boolean }>
  notCapturedYet: string[]
  /** Set by the server when it answers without a detail (an error body). */
  message?: string
  error?: string
}

const SECTION_LABELS: Record<string, string> = {
  callLog: 'Call log',
  transcriptTurns: 'Transcript lines',
  toolCalls: 'Agent tool calls',
  callEvents: 'Call events',
  escalation: 'On-call chain',
  attempts: 'Chain attempts (calls, texts)',
  extraEvents: 'Extra per-call events (on_call_call_events)',
}

function Outcome({ o }: { o: Omit<ChainSummary, 'mode'> }) {
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <div className="text-xs text-muted-foreground">Result</div>
        <Badge variant={chainStatusVariant(o.status)}>{o.status === 'no_chain' ? 'no on-call chain' : o.status}</Badge>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Took the patient</div>
        {o.acceptedByName ?? '—'}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Time to accept</div>
        {fmtSeconds(o.secondsToAccept)}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Calls / texts</div>
        {o.calls} / {o.texts}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Levels reached</div>
        {o.levelsReached}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">First level · routing</div>
        {o.firstLevel ?? '—'}
        {o.routingReason ? ` · ${o.routingReason}` : ''}
      </div>
    </div>
  )
}

function CallDetailView({ callSid, onBack }: { callSid: string; onBack: () => void }) {
  const q = useOnCall<CallDetail>(`/calls/${callSid}`)
  const [showTranscript, setShowTranscript] = React.useState(false)
  // Review of #520: the way back stays on screen while the detail loads, fails or comes back empty.
  const back = (
    <Button variant="outline" size="sm" onClick={onBack}>
      <ArrowLeft className="mr-1 h-4 w-4" /> All calls
    </Button>
  )
  const d = q.data
  if (q.isLoading || q.error || !d?.timeline) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {back}
          <span className="font-mono text-sm">{callSid}</span>
        </div>
        {q.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : q.error ? (
          <Banner tone="error">{apiError(q.error)}</Banner>
        ) : (
          <Banner tone="error">{d?.message ?? d?.error ?? 'No detail came back for this call.'}</Banner>
        )}
      </div>
    )
  }
  const items = d.timeline.filter((i) => showTranscript || i.source !== 'transcript')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {back}
        <span className="font-mono text-sm">{d.callSid}</span>
        <span className="text-sm text-muted-foreground">
          caller {d.caller ?? 'withheld'} · {d.agent ?? 'agent unknown'}
          {d.escalation && ` · chain #${d.escalation.id} (${d.escalation.mode})`}
        </span>
        <div className="flex-1" />
        {d.callLogId && (
          <Link to={`/call-logs/${d.callLogId}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            Full call details and transcript <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Outcome</CardTitle>
        </CardHeader>
        <CardContent>
          <Outcome o={d.outcome} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {Object.entries(d.sections).map(([k, s]) => {
          const b = sectionBadge(s)
          return (
            <Badge key={k} variant={b.variant} title={k}>
              {SECTION_LABELS[k] ?? k}: {b.label}
            </Badge>
          )
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Everything that happened (Pacific time)</CardTitle>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showTranscript} onChange={(e) => setShowTranscript(e.target.checked)} />
            Show transcript lines
          </label>
        </CardHeader>
        <CardContent>
          {items.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded for this call.</p>}
          <ol className="relative space-y-3 border-l pl-4">
            {items.map((i, n) => (
              <li key={n} className="relative">
                <span
                  className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${
                    i.status === 'ok' ? 'bg-green-500' : i.status === 'fail' ? 'bg-red-500' : i.status === 'warn' ? 'bg-yellow-500' : 'bg-muted-foreground'
                  }`}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground" title={i.approximateTime ? 'approximate time' : undefined}>
                    {i.approximateTime ? '~' : ''}
                    {fmtPacificTime(i.at)}
                  </span>
                  <Badge variant="outline">{SOURCE_LABELS[i.source] ?? i.source}</Badge>
                  <span className={i.source === 'transcript' ? '' : 'font-medium'}>{i.title}</span>
                  {i.status && i.status !== 'info' && <Badge variant={timelineVariant(i.status)}>{i.status}</Badge>}
                </div>
                {i.detail && <div className="mt-0.5 text-sm text-muted-foreground">{i.detail}</div>}
                {i.data && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">details</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(i.data, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            Not captured yet <Badge variant="outline">placeholder</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {d.notCapturedYet.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

export function CallsTab() {
  const [days, setDays] = React.useState(14)
  const [open, setOpen] = React.useState<string | null>(null)
  const q = useOnCall<{ days: number; calls: CallRow[] }>(`/calls?days=${days}`, { refetchInterval: open ? undefined : 60_000 })

  if (open) return <CallDetailView callSid={open} onBack={() => setOpen(null)} />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-sm font-medium">Window</label>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30, 90].map((n) => (
              <option key={n} value={n}>
                last {n} day{n > 1 ? 's' : ''}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Urgent after-hours calls: every on-call chain, plus after-hours calls whose agent asked to escalate and opened no chain (the rotation
          was off, or the escalation was refused).
        </p>
      </div>
      {q.error && <Banner tone="error">{apiError(q.error)}</Banner>}
      {!q.error && q.data && !Array.isArray(q.data.calls) && (
        <Banner tone="error">{q.data.message ?? q.data.error ?? 'The call list did not come back.'}</Banner>
      )}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started (PT)</TableHead>
                <TableHead>Caller</TableHead>
                <TableHead>Chain</TableHead>
                <TableHead>First level</TableHead>
                <TableHead>Took the patient</TableHead>
                <TableHead>To accept</TableHead>
                <TableHead>Calls / texts</TableHead>
                <TableHead>Call outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.calls ?? []).map((c) => (
                <TableRow key={c.callSid} className="cursor-pointer hover:bg-muted/50" onClick={() => setOpen(c.callSid)}>
                  <TableCell className="whitespace-nowrap text-sm">{fmtPacific(c.startedAt)}</TableCell>
                  <TableCell>{c.callerLast4 ?? 'withheld'}</TableCell>
                  <TableCell>
                    {c.chain ? (
                      <>
                        <Badge variant={chainStatusVariant(c.chain.status)}>{c.chain.status}</Badge>{' '}
                        {c.chain.mode === 'test' && <Badge variant="outline">test</Badge>}
                      </>
                    ) : (
                      <Badge variant="secondary">no chain</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{c.chain?.firstLevel ?? '—'}</TableCell>
                  <TableCell className="text-sm">{c.chain?.acceptedByName ?? '—'}</TableCell>
                  <TableCell className="text-sm">{fmtSeconds(c.chain?.secondsToAccept)}</TableCell>
                  <TableCell className="text-sm">{c.chain ? `${c.chain.calls} / ${c.chain.texts}` : '—'}</TableCell>
                  <TableCell className="text-sm">
                    {c.runtimeOutcome ?? '—'}
                    {c.durationSec !== null ? ` · ${fmtSeconds(c.durationSec)}` : ''}
                  </TableCell>
                </TableRow>
              ))}
              {q.isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {q.data && q.data.calls?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No urgent after-hours calls in this window.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
