import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Telescope,
  Database,
  ShieldCheck,
  ShieldAlert,
  Clock,
  AlertTriangle,
  CheckCircle,
  MessageSquareQuote,
  History,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'

// ─── Types mirroring server/observatory/queries.ts ───────────────────────

interface FivestarHealth {
  configured: boolean
  reachable: boolean
  readOnly: boolean
  role: string | null
  mirrorLastSyncAt: string | null
  mirrorAgeHours: number | null
  latestDeploySha: string | null
  error: string | null
}
interface HealthResponse {
  ok: boolean
  opshub: { reachable: boolean; error: string | null }
  fivestar: FivestarHealth
}
interface OpsHubScorecard {
  agentId: string
  agentName: string
  calls: number
  calls7d: number
  criticalFailureRate: number | null
  avgQualityScore: number | null
  longCalls: number
  avgInterruptions: number | null
  telephonyErrors: number
  outcomes: Record<string, number>
  avgDurationSec: number | null
}
interface SageScorecard {
  calls: number
  calls7d: number
  hallucinationHits: number
  bookingCriticalWarnings: number
  openaiErrorCallRate: number | null
  avgResponseLatencyMs: number | null
  maxResponseLatencyMs: number | null
  reviewsAvgScore: number | null
  outcomes: Record<string, number>
  directorHandoffReasons: Record<string, number>
  inboundScheduledRate: number | null
  outboundScheduledRate: number | null
  error?: string
}
interface ScorecardsResponse {
  windowDays: number
  opsHub: OpsHubScorecard[]
  sage: SageScorecard
}
interface FunnelWeek {
  weekStart: string
  reachedCalls: number
  reachedSmsDelivered: number
  engagedCalls: number
  smsClicks: number
  booked: number
  entered: number
  materialized: number
  kept: number
  cancelled: number
  noShow: number
  pendingReview: number
}
interface FunnelResponse {
  weeks: number
  sage: FunnelWeek[]
}
interface AgentOpenings {
  agentSlug: string
  agentName: string
  configuredGreeting: string | null
  callsSampled: number
  greetingAdherence: number | null
  topOpenings: Array<{ opening: string; n: number }>
  sampleOpeningSequences: Array<{ callLogId: string; turns: string[] }>
}
interface OpeningsResponse {
  windowDays: number
  agents: AgentOpenings[]
}
interface AgentChange {
  id: number
  changedAt: string
  tableName: string
  operation: string
  agentRef: string | null
  dbUser: string
  changedFields: Record<string, unknown> | null
}
interface ChangesResponse {
  changes: AgentChange[]
}

// ─── Small helpers ───────────────────────────────────────────────────────

const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`

type Tone = 'green' | 'amber' | 'red' | 'grey'

const toneClasses: Record<Tone, string> = {
  green: 'border-green-500/50 bg-green-500/5',
  amber: 'border-amber-500/60 bg-amber-500/10',
  red: 'border-red-500/60 bg-red-500/10',
  grey: 'border-gray-300 dark:border-gray-700 opacity-75',
}
const toneDot: Record<Tone, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  grey: 'bg-gray-400',
}

/** Scorecard tone + plain-language diagnoses. Every claim names its number. */
function opsHubDiagnosis(s: OpsHubScorecard): { tone: Tone; notes: string[] } {
  if (!s.calls) return { tone: 'grey', notes: ['No calls in this window.'] }
  const notes: string[] = []
  let tone: Tone = 'green'
  const bump = (t: Tone) => {
    if (t === 'red' || (t === 'amber' && tone === 'green')) tone = t
  }
  if (s.criticalFailureRate !== null && s.criticalFailureRate >= 0.4) {
    bump('red')
    notes.push(
      `Grader flags critical failures on ${pct(s.criticalFailureRate)} of graded calls — open Call Logs, sort by grade, and read the worst 5 transcripts for the failing check.`,
    )
  } else if (s.criticalFailureRate !== null && s.criticalFailureRate >= 0.2) {
    bump('amber')
    notes.push(`Critical-failure rate ${pct(s.criticalFailureRate)} — elevated, worth a transcript sample.`)
  }
  if (s.avgQualityScore !== null && s.avgQualityScore < 3) {
    bump('amber')
    notes.push(`Average quality ${s.avgQualityScore.toFixed(2)}/5 — below the 3.0 line.`)
  }
  if (s.telephonyErrors > 0 && s.telephonyErrors / s.calls > 0.05) {
    bump('amber')
    notes.push(`${s.telephonyErrors} calls with Twilio error codes (${pct(s.telephonyErrors / s.calls)}).`)
  }
  if (s.longCalls > 0 && s.longCalls / s.calls > 0.1) {
    bump('amber')
    notes.push(`${s.longCalls} calls ran past 45 turns — possible loops.`)
  }
  if (!notes.length) notes.push('All pillars inside normal ranges.')
  return { tone, notes }
}

function sageDiagnosis(s: SageScorecard): { tone: Tone; notes: string[] } {
  if (s.error) return { tone: 'red', notes: [`SAGE column failed to load: ${s.error}`] }
  if (!s.calls) return { tone: 'grey', notes: ['No calls in this window.'] }
  const notes: string[] = []
  let tone: Tone = 'green'
  const bump = (t: Tone) => {
    if (t === 'red' || (t === 'amber' && tone === 'green')) tone = t
  }
  const timeouts = s.directorHandoffReasons['reasoning_timeout'] ?? 0
  const loops = s.directorHandoffReasons['loop_detected'] ?? 0
  if (timeouts > 0) {
    bump(timeouts >= 8 ? 'red' : 'amber')
    notes.push(
      `${timeouts} director reasoning-timeout handoffs in the window — bursts of these (8 straight on Aug 6) dump callers on coordinators. Circuit breaker is the queued fix.`,
    )
  }
  if (loops > 0) {
    bump('amber')
    notes.push(`${loops} loop-detected handoffs.`)
  }
  if (s.hallucinationHits > 0) {
    bump('amber')
    notes.push(`${s.hallucinationHits} hallucination-guard hits.`)
  }
  if (s.openaiErrorCallRate !== null && s.openaiErrorCallRate > 0.1) {
    bump('amber')
    notes.push(`OpenAI errors on ${pct(s.openaiErrorCallRate)} of telemetered calls.`)
  }
  if (s.inboundScheduledRate !== null && s.inboundScheduledRate < 0.25) {
    bump('amber')
    notes.push(`Inbound engaged→scheduled at ${pct(s.inboundScheduledRate)} — below the historical 30-36% band.`)
  }
  if (!notes.length) notes.push('All pillars inside normal ranges.')
  return { tone, notes }
}

function adherenceTone(a: number | null, sampled: number): Tone {
  if (!sampled || a === null) return 'grey'
  if (a >= 0.9) return 'green'
  if (a >= 0.6) return 'amber'
  return 'red'
}

function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${toneDot[tone]}`} />
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function ObservatoryPage() {
  const [windowDays, setWindowDays] = useState(7)

  const health = useQuery<HealthResponse>({
    queryKey: ['obs-health'],
    queryFn: async () => (await apiClient.get('/observatory/health')).data,
    refetchInterval: 60_000,
    retry: 1,
  })
  const scorecards = useQuery<ScorecardsResponse>({
    queryKey: ['obs-scorecards', windowDays],
    queryFn: async () => (await apiClient.get(`/observatory/scorecards?days=${windowDays}`)).data,
    refetchInterval: 120_000,
  })
  const funnel = useQuery<FunnelResponse>({
    queryKey: ['obs-funnel'],
    queryFn: async () => (await apiClient.get('/observatory/funnel?weeks=12')).data,
    refetchInterval: 300_000,
  })
  const openings = useQuery<OpeningsResponse>({
    queryKey: ['obs-openings'],
    queryFn: async () => (await apiClient.get('/observatory/openings?days=7')).data,
    refetchInterval: 300_000,
  })
  const changes = useQuery<ChangesResponse>({
    queryKey: ['obs-changes'],
    queryFn: async () => (await apiClient.get('/observatory/agent-changes?limit=100')).data,
    refetchInterval: 120_000,
  })

  const fs = health.data?.fivestar
  const mirrorStale = (fs?.mirrorAgeHours ?? 0) > 26

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Telescope className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Agent Observatory</h1>
            <p className="text-sm text-muted-foreground">
              Every agent, one place — scorecards, funnel, openings, and the change trail.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Window:</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`rounded-md border px-2.5 py-1 ${
                windowDays === d ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent'
              }`}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={() => {
              health.refetch()
              scorecards.refetch()
              funnel.refetch()
              openings.refetch()
              changes.refetch()
            }}
            className="ml-1 rounded-md border border-input p-1.5 hover:bg-accent"
            title="Refresh all"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Freshness / integrity strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
          <Database className="h-3.5 w-3.5" />
          Ops Hub DB:{' '}
          {health.data ? (
            health.data.opshub.reachable ? (
              <span className="text-green-600 dark:text-green-400">connected</span>
            ) : (
              <span className="text-red-600 dark:text-red-400">{health.data.opshub.error ?? 'unreachable'}</span>
            )
          ) : (
            '…'
          )}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
          {fs?.readOnly ? <ShieldCheck className="h-3.5 w-3.5 text-green-600" /> : <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />}
          SAGE (5Star):{' '}
          {fs ? (
            fs.reachable ? (
              <span className="text-green-600 dark:text-green-400">
                {fs.role} {fs.readOnly ? '(read-only)' : '(NOT read-only!)'}
              </span>
            ) : (
              <span className="text-red-600 dark:text-red-400">{fs.error ?? 'unreachable'}</span>
            )
          ) : (
            '…'
          )}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
            mirrorStale ? 'border-red-500 text-red-600 dark:text-red-400' : ''
          }`}
        >
          <Clock className="h-3.5 w-3.5" />
          NextGen mirror:{' '}
          {fs?.mirrorAgeHours != null ? `${fs.mirrorAgeHours}h old${mirrorStale ? ' — STALE (SLA 26h): run the morning sync' : ''}` : '…'}
        </span>
        {fs?.latestDeploySha && (
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
            5Star deploy: <code>{fs.latestDeploySha}</code>
          </span>
        )}
      </div>

      {/* Scorecards */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Agent scorecards ({scorecards.data?.windowDays ?? windowDays}d)</h2>
        {scorecards.isLoading && <p className="text-sm text-muted-foreground">Loading scorecards…</p>}
        {scorecards.isError && (
          <p className="text-sm text-red-600">
            Scorecards failed: {(scorecards.error as any)?.response?.data?.error ?? String(scorecards.error)}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {scorecards.data?.opsHub.map((s) => {
            const d = opsHubDiagnosis(s)
            return (
              <Card key={s.agentId} className={`border ${toneClasses[d.tone]}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={d.tone} />
                      {s.agentName}
                    </span>
                    <span className="text-sm font-normal text-muted-foreground">{s.calls} calls</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <span className="text-muted-foreground">Critical fails</span>
                    <span>{pct(s.criticalFailureRate)}</span>
                    <span className="text-muted-foreground">Quality</span>
                    <span>{s.avgQualityScore != null ? `${s.avgQualityScore.toFixed(2)}/5` : '—'}</span>
                    <span className="text-muted-foreground">45+ turn calls</span>
                    <span>{s.longCalls}</span>
                    <span className="text-muted-foreground">Telephony errors</span>
                    <span>{s.telephonyErrors}</span>
                  </div>
                  {Object.keys(s.outcomes).length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Outcomes:{' '}
                      {Object.entries(s.outcomes)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                    </p>
                  )}
                  <div className="border-t pt-2">
                    {d.notes.map((n, i) => (
                      <p key={i} className="flex items-start gap-1.5 text-xs">
                        {d.tone === 'green' ? (
                          <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        )}
                        {n}
                      </p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })}

          {/* SAGE card */}
          {scorecards.data && (
            (() => {
              const s = scorecards.data.sage
              const d = sageDiagnosis(s)
              return (
                <Card className={`border ${toneClasses[d.tone]}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span className="flex items-center gap-2">
                        <StatusDot tone={d.tone} />
                        SAGE (5Star DRS line)
                      </span>
                      <span className="text-sm font-normal text-muted-foreground">{s.calls ?? '—'} calls</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {!s.error && (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <span className="text-muted-foreground">Inbound→scheduled</span>
                        <span>{pct(s.inboundScheduledRate)}</span>
                        <span className="text-muted-foreground">Outbound→scheduled</span>
                        <span>{pct(s.outboundScheduledRate)}</span>
                        <span className="text-muted-foreground">Hallucination hits</span>
                        <span>{s.hallucinationHits}</span>
                        <span className="text-muted-foreground">Avg latency</span>
                        <span>{s.avgResponseLatencyMs != null ? `${s.avgResponseLatencyMs}ms` : '—'}</span>
                        <span className="text-muted-foreground">Review score</span>
                        <span>{s.reviewsAvgScore != null ? `${s.reviewsAvgScore}/5` : '—'}</span>
                      </div>
                    )}
                    {!s.error && Object.keys(s.directorHandoffReasons).length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Director handoffs:{' '}
                        {Object.entries(s.directorHandoffReasons)
                          .sort((a, b) => b[1] - a[1])
                          .map(([k, v]) => `${k} ${v}`)
                          .join(' · ')}
                      </p>
                    )}
                    <div className="border-t pt-2">
                      {d.notes.map((n, i) => (
                        <p key={i} className="flex items-start gap-1.5 text-xs">
                          {d.tone === 'green' ? (
                            <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                          ) : (
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                          )}
                          {n}
                        </p>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )
            })()
          )}
        </div>
      </section>

      {/* Openings / greeting adherence */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Openings — what each agent actually says first (7d)</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Adherence = share of calls whose first words match the configured greeting. Recognized callers get the
          personalized “Am I speaking with …?” open by design, so 100% is not expected on lines with caller-ID matching.
        </p>
        {openings.isError && (
          <p className="text-sm text-red-600">
            Openings failed: {(openings.error as any)?.response?.data?.error ?? String(openings.error)}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {openings.data?.agents.map((a) => {
            const tone = adherenceTone(a.greetingAdherence, a.callsSampled)
            return (
              <Card key={a.agentSlug} className={`border ${toneClasses[tone]}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={tone} />
                      {a.agentName}
                    </span>
                    <span className="text-sm font-normal">
                      {a.callsSampled ? `${pct(a.greetingAdherence)} adherent · ${a.callsSampled} calls` : 'no calls sampled'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="flex items-start gap-1.5 text-xs">
                    <MessageSquareQuote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="text-muted-foreground">Configured: </span>
                      {a.configuredGreeting ?? <em>none set</em>}
                    </span>
                  </p>
                  {a.topOpenings.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Actual openings heard:</p>
                      {a.topOpenings.map((o, i) => (
                        <p key={i} className="truncate text-xs" title={o.opening}>
                          <span className="mr-1.5 inline-block w-8 text-right font-mono text-muted-foreground">{o.n}×</span>
                          {o.opening}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      {/* SAGE funnel */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">SAGE booking funnel — weekly (12w)</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Booked → entered in NextGen → materialized on the schedule → kept. Losses shown by verdict. Weeks with
          restored bookings (the July re-audit) count them in their original booking week.
        </p>
        {funnel.isError && (
          <p className="text-sm text-red-600">
            Funnel failed: {(funnel.error as any)?.response?.data?.error ?? String(funnel.error)}
          </p>
        )}
        {funnel.data && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2">Week</th>
                  <th className="px-3 py-2 text-right">Calls</th>
                  <th className="px-3 py-2 text-right">Engaged</th>
                  <th className="px-3 py-2 text-right">Booked</th>
                  <th className="px-3 py-2 text-right">Entered</th>
                  <th className="px-3 py-2 text-right">Materialized</th>
                  <th className="px-3 py-2 text-right">Kept</th>
                  <th className="px-3 py-2 text-right">Kept/Booked</th>
                  <th className="px-3 py-2 text-right">Cancelled</th>
                  <th className="px-3 py-2 text-right">No-show</th>
                  <th className="px-3 py-2 text-right">In review</th>
                </tr>
              </thead>
              <tbody>
                {funnel.data.sage.map((w) => {
                  const keptRate = w.booked ? w.kept / w.booked : null
                  const rateTone: Tone =
                    keptRate === null ? 'grey' : keptRate >= 0.6 ? 'green' : keptRate >= 0.4 ? 'amber' : 'red'
                  return (
                    <tr key={w.weekStart} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-1.5 font-mono text-xs">{w.weekStart}</td>
                      <td className="px-3 py-1.5 text-right">{w.reachedCalls}</td>
                      <td className="px-3 py-1.5 text-right">{w.engagedCalls}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{w.booked}</td>
                      <td className="px-3 py-1.5 text-right">{w.entered}</td>
                      <td className="px-3 py-1.5 text-right">{w.materialized}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{w.kept}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot tone={rateTone} />
                          {keptRate === null ? '—' : pct(keptRate)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right">{w.cancelled}</td>
                      <td className="px-3 py-1.5 text-right">{w.noShow}</td>
                      <td className="px-3 py-1.5 text-right">{w.pendingReview}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Change trail */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">
          <History className="mr-1.5 inline h-5 w-5" />
          Agent change trail
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Every change to any agent — config, prompt, tools — captured by database triggers, no matter who or what wrote
          it. Timestamp-only touches are filtered out.
        </p>
        {changes.isError && (
          <p className="text-sm text-red-600">
            Change trail failed: {(changes.error as any)?.response?.data?.error ?? String(changes.error)}
          </p>
        )}
        {changes.data && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2">Table</th>
                  <th className="px-3 py-2">Op</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2">Fields changed</th>
                </tr>
              </thead>
              <tbody>
                {changes.data.changes.map((c) => (
                  <ChangeRow key={c.id} change={c} />
                ))}
              </tbody>
            </table>
            {!changes.data.changes.length && (
              <p className="p-4 text-sm text-muted-foreground">No changes recorded yet.</p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function ChangeRow({ change }: { change: AgentChange }) {
  const [open, setOpen] = useState(false)
  const fields = change.changedFields ? Object.keys(change.changedFields) : []
  return (
    <>
      <tr className="cursor-pointer border-b last:border-0 hover:bg-muted/30" onClick={() => setOpen(!open)}>
        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
          {new Date(change.changedAt).toLocaleString()}
        </td>
        <td className="px-3 py-1.5">{change.agentRef ?? '—'}</td>
        <td className="px-3 py-1.5 text-xs">{change.tableName}</td>
        <td className="px-3 py-1.5 text-xs uppercase">{change.operation}</td>
        <td className="px-3 py-1.5 text-xs">{change.dbUser}</td>
        <td className="px-3 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {fields.join(', ') || '—'}
          </span>
        </td>
      </tr>
      {open && change.changedFields && (
        <tr className="border-b bg-muted/20 last:border-0">
          <td colSpan={6} className="px-3 py-2">
            {Object.entries(change.changedFields).map(([field, diff]) => {
              const d = diff as { old?: unknown; new?: unknown }
              return (
                <div key={field} className="mb-2 text-xs last:mb-0">
                  <p className="font-medium">{field}</p>
                  <p className="text-red-600 dark:text-red-400">
                    − {typeof d?.old === 'string' ? d.old : JSON.stringify(d?.old ?? null)}
                  </p>
                  <p className="text-green-600 dark:text-green-400">
                    + {typeof d?.new === 'string' ? d.new : JSON.stringify(d?.new ?? null)}
                  </p>
                </div>
              )
            })}
          </td>
        </tr>
      )}
    </>
  )
}
