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
interface SyncFeedStatus {
  key: string
  app: string
  name: string
  feeds: string
  runBy: string
  lastRunAt: string | null
  ageHours: number | null
  slaHours: number
  status: 'ok' | 'stale' | 'error' | 'unavailable'
  detail: string | null
}
interface SyncsOverview {
  feeds: SyncFeedStatus[]
  consoleActivity: Array<{ day: string; apptsSynced: number; cancelled: number }>
  consoleConfigured: boolean
}

interface GraderCheckStat {
  grader: string
  total: number
  fails: number
  criticalFails: number
  avgScore: number | null
  sampleReasons: string[]
}
interface OpsHubWorstCall {
  id: string
  createdAt: string
  durationSec: number | null
  outcome: string | null
  qualityScore: number | null
  criticalFailures: number
  failing: Array<{ grader: string; reason: string; severity: string | null }>
}
interface OpsHubAgentDetail {
  windowDays: number
  graderChecks: GraderCheckStat[]
  worstCalls: OpsHubWorstCall[]
}
interface SageHallucinationIncident {
  id: string
  createdAt: string
  guard: string | null
  detectedLanguage: string | null
  slotsOfferedSummary: string | null
  transcript: string | null
  callSid: string | null
}
interface SageDirectorEvent {
  initiatedAt: string
  reason: string | null
  outcome: string | null
  answered: boolean
  bridgeSeconds: number | null
  resultedInAppointment: boolean | null
  callLogId: string | null
  notes: string | null
}
interface SageToolErrorStat {
  toolName: string
  calls: number
  errors: number
  avgDurationMs: number | null
  sampleErrors: string[]
}
interface SageWorstTelemetryCall {
  callLogId: string | null
  callSid: string | null
  startedAt: string
  direction: string | null
  outcome: string | null
  maxLatencyMs: number | null
  greetingLatencyMs: number | null
  openaiErrors: number
  toolErrors: number
  reconnects: number
  terminationReason: string | null
}
interface SageDetail {
  windowDays: number
  hallucinations: SageHallucinationIncident[]
  hallucinationsByGuard: Record<string, number>
  directorFeed: SageDirectorEvent[]
  toolErrors: SageToolErrorStat[]
  worstTelemetry: SageWorstTelemetryCall[]
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

// ─── Tabs ────────────────────────────────────────────────────────────────
// Structure mirrors 5Star's SAGE program pages: one concern per tab,
// comprehensive inside the tab, never jumbled across them (Wayne
// 2026-08-07). Overview answers "is anything red"; every red opens into
// the tab that explains WHY.

type ObsTab = 'overview' | 'guards' | 'director' | 'telemetry' | 'openings' | 'funnel' | 'syncs' | 'changes'

const TABS: Array<{ key: ObsTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'guards', label: 'Guards & Failures' },
  { key: 'director', label: 'Director' },
  { key: 'telemetry', label: 'Telemetry & Tools' },
  { key: 'openings', label: 'Openings' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'syncs', label: 'Scripts & Syncs' },
  { key: 'changes', label: 'Change Trail' },
]

/** One shared sage-detail fetch for the Guards/Director/Telemetry tabs. */
function useSageDetail(days: number, enabled: boolean) {
  return useQuery<SageDetail>({
    queryKey: ['obs-sage-detail', days],
    queryFn: async () => (await apiClient.get(`/observatory/sage-detail?days=${days}`)).data,
    enabled,
  })
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function ObservatoryPage() {
  const [windowDays, setWindowDays] = useState(7)
  const [tab, setTab] = useState<ObsTab>('overview')
  // Guards tab focus: an Ops Hub agent, or 'sage'
  const [guardsAgent, setGuardsAgent] = useState<{ id: string; name: string } | 'sage' | null>(null)

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

  const fs = health.data?.fivestar
  const mirrorStale = (fs?.mirrorAgeHours ?? 0) > 26

  const openGuardsFor = (target: { id: string; name: string } | 'sage') => {
    setGuardsAgent(target)
    setTab('guards')
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Telescope className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Agent Observatory</h1>
            <p className="text-sm text-muted-foreground">
              Every agent, one place — and every red number opens into why.
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
            }}
            className="ml-1 rounded-md border border-input p-1.5 hover:bg-accent"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Freshness / integrity strip — always visible */}
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
          {fs?.readOnly ? (
            <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
          )}
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
          {fs?.mirrorAgeHours != null
            ? `${fs.mirrorAgeHours}h old${mirrorStale ? ' — STALE (SLA 26h): run the morning sync' : ''}`
            : '…'}
        </span>
        {fs?.latestDeploySha && (
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
            5Star deploy: <code>{fs.latestDeploySha}</code>
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab scorecards={scorecards} onOpenGuards={openGuardsFor} onOpenDirector={() => setTab('director')} />
      )}
      {tab === 'guards' && (
        <GuardsTab
          scorecards={scorecards.data}
          windowDays={windowDays}
          focus={guardsAgent}
          setFocus={setGuardsAgent}
        />
      )}
      {tab === 'director' && <DirectorTab days={windowDays} summary={scorecards.data?.sage?.directorHandoffReasons} />}
      {tab === 'telemetry' && <TelemetryTab days={windowDays} />}
      {tab === 'openings' && <OpeningsTab />}
      {tab === 'funnel' && <FunnelTab />}
      {tab === 'syncs' && <SyncsTab />}
      {tab === 'changes' && <ChangesTab />}
    </div>
  )
}

// ─── Overview tab ────────────────────────────────────────────────────────

function OverviewTab({
  scorecards,
  onOpenGuards,
  onOpenDirector,
}: {
  scorecards: ReturnType<typeof useQuery<ScorecardsResponse>>
  onOpenGuards: (t: { id: string; name: string } | 'sage') => void
  onOpenDirector: () => void
}) {
  return (
    <section>
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
                <button
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => onOpenGuards({ id: s.agentId, name: s.agentName })}
                >
                  Failing checks &amp; worst calls →
                </button>
              </CardContent>
            </Card>
          )
        })}

        {scorecards.data &&
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
                  <div className="flex gap-3">
                    <button
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => onOpenGuards('sage')}
                    >
                      Guards &amp; incidents →
                    </button>
                    <button className="text-xs font-medium text-primary hover:underline" onClick={onOpenDirector}>
                      Director feed →
                    </button>
                  </div>
                </CardContent>
              </Card>
            )
          })()}
      </div>
    </section>
  )
}

// ─── Guards & Failures tab ───────────────────────────────────────────────

function GuardsTab({
  scorecards,
  windowDays,
  focus,
  setFocus,
}: {
  scorecards: ScorecardsResponse | undefined
  windowDays: number
  focus: { id: string; name: string } | 'sage' | null
  setFocus: (f: { id: string; name: string } | 'sage') => void
}) {
  const agents = scorecards?.opsHub ?? []
  const active = focus ?? (agents.length ? { id: agents[0].agentId, name: agents[0].agentName } : null)
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {agents.map((a) => (
          <button
            key={a.agentId}
            onClick={() => setFocus({ id: a.agentId, name: a.agentName })}
            className={`rounded-full border px-3 py-1 text-sm ${
              active && active !== 'sage' && active.id === a.agentId
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input hover:bg-accent'
            }`}
          >
            {a.agentName}
          </button>
        ))}
        <button
          onClick={() => setFocus('sage')}
          className={`rounded-full border px-3 py-1 text-sm ${
            active === 'sage' ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent'
          }`}
        >
          SAGE
        </button>
      </div>
      {active === 'sage' ? (
        <SageGuardsPanel days={windowDays} />
      ) : active ? (
        <OpsHubGuardsPanel agentId={active.id} agentName={active.name} days={windowDays} />
      ) : (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      )}
    </section>
  )
}

function OpsHubGuardsPanel({ agentId, agentName, days }: { agentId: string; agentName: string; days: number }) {
  const detail = useQuery<OpsHubAgentDetail>({
    queryKey: ['obs-agent-detail', agentId, days],
    queryFn: async () => (await apiClient.get(`/observatory/agent-detail/${agentId}?days=${days}`)).data,
  })
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading {agentName}…</p>
  if (detail.isError)
    return (
      <p className="text-sm text-red-600">
        Detail failed: {(detail.error as any)?.response?.data?.error ?? String(detail.error)}
      </p>
    )
  const d = detail.data!
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-1.5 text-sm font-medium">Grader checks — which are failing, and why ({d.windowDays}d)</h4>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left uppercase text-muted-foreground">
                <th className="px-2 py-1.5">Check</th>
                <th className="px-2 py-1.5 text-right">Fails</th>
                <th className="px-2 py-1.5 text-right">Fail rate</th>
                <th className="px-2 py-1.5 text-right">Avg score</th>
                <th className="px-2 py-1.5">Latest fail reasons (grader's own words)</th>
              </tr>
            </thead>
            <tbody>
              {d.graderChecks.map((c) => {
                const rate = c.total ? c.fails / c.total : 0
                return (
                  <tr
                    key={c.grader}
                    className={`border-b last:border-0 ${c.criticalFails > 0 && rate >= 0.1 ? 'bg-red-500/5' : ''}`}
                  >
                    <td className="px-2 py-1.5 font-mono">{c.grader}</td>
                    <td className="px-2 py-1.5 text-right">
                      {c.fails}/{c.total}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right ${
                        rate >= 0.2 ? 'font-semibold text-red-600 dark:text-red-400' : ''
                      }`}
                    >
                      {pct(rate, 1)}
                    </td>
                    <td className="px-2 py-1.5 text-right">{c.avgScore ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      {c.sampleReasons.map((r, i) => (
                        <p key={i} className="mb-0.5 last:mb-0">
                          · {r}
                        </p>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h4 className="mb-1.5 text-sm font-medium">Worst calls — what failed, transcript one click away</h4>
        {!d.worstCalls.length && (
          <p className="text-xs text-muted-foreground">No critical-failure calls in this window.</p>
        )}
        <div className="space-y-2">
          {d.worstCalls.map((c) => (
            <div key={c.id} className="rounded-md border bg-background p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono">{new Date(c.createdAt).toLocaleString()}</span>
                <span>
                  {c.criticalFailures} critical · quality {c.qualityScore ?? '—'} · {c.outcome ?? 'no outcome'} ·{' '}
                  {c.durationSec != null ? `${c.durationSec}s` : '—'}
                  <a href={`/call-logs/${c.id}`} className="ml-2 font-medium text-primary hover:underline">
                    full transcript →
                  </a>
                </span>
              </div>
              {c.failing.map((f, i) => (
                <p key={i} className="mt-1">
                  <span className={`font-mono ${f.severity === 'critical' ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {f.grader}
                  </span>
                  : {f.reason}
                </p>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SageGuardsPanel({ days }: { days: number }) {
  const [openIncident, setOpenIncident] = useState<string | null>(null)
  const detail = useSageDetail(days, true)
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading SAGE guards…</p>
  if (detail.isError)
    return (
      <p className="text-sm text-red-600">
        SAGE detail failed: {(detail.error as any)?.response?.data?.error ?? String(detail.error)}
      </p>
    )
  const d = detail.data!
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">
        Hallucination guards — every incident, the guard that fired, and the transcript ({d.windowDays}d)
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(d.hallucinationsByGuard).map(([g, n]) => (
          <span key={g} className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs">
            {g}: {n}
          </span>
        ))}
        {!Object.keys(d.hallucinationsByGuard).length && (
          <span className="text-xs text-muted-foreground">No guard hits in this window.</span>
        )}
      </div>
      <div className="space-y-1.5">
        {d.hallucinations.map((h) => (
          <div key={h.id} className="rounded-md border bg-background p-2 text-xs">
            <button
              className="flex w-full items-center justify-between text-left"
              onClick={() => setOpenIncident(openIncident === h.id ? null : h.id)}
            >
              <span>
                <span className="font-mono text-red-600 dark:text-red-400">{h.guard ?? '(unlabelled)'}</span>
                {' · '}
                {new Date(h.createdAt).toLocaleString()}
                {h.detectedLanguage ? ` · ${h.detectedLanguage}` : ''}
              </span>
              <span className="text-primary">{openIncident === h.id ? 'hide transcript ▴' : 'transcript ▾'}</span>
            </button>
            {h.slotsOfferedSummary && (
              <p className="mt-1 text-muted-foreground">Slots offered: {h.slotsOfferedSummary}</p>
            )}
            {openIncident === h.id && (
              <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap border-t pt-2 leading-relaxed">
                {h.transcript ?? '(no transcript stored)'}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Director tab ────────────────────────────────────────────────────────

function DirectorTab({ days, summary }: { days: number; summary: Record<string, number> | undefined }) {
  const [transcriptCall, setTranscriptCall] = useState<string | null>(null)
  const detail = useSageDetail(days, true)
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading director feed…</p>
  if (detail.isError)
    return (
      <p className="text-sm text-red-600">
        Director feed failed: {(detail.error as any)?.response?.data?.error ?? String(detail.error)}
      </p>
    )
  const d = detail.data!
  return (
    <section className="space-y-3">
      {summary && Object.keys(summary).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(summary)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <span
                key={k}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  /timeout|loop|safety|invalid/.test(k) ? 'border-red-500/40 bg-red-500/10' : ''
                }`}
              >
                {k}: {v}
              </span>
            ))}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-left uppercase text-muted-foreground">
              <th className="px-2 py-1.5">When</th>
              <th className="px-2 py-1.5">Reason (verbatim)</th>
              <th className="px-2 py-1.5">Outcome</th>
              <th className="px-2 py-1.5 text-right">Answered</th>
              <th className="px-2 py-1.5 text-right">Bridge</th>
              <th className="px-2 py-1.5 text-right">Appt?</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {d.directorFeed.map((e, i) => (
              <tr
                key={i}
                className={`border-b last:border-0 ${
                  e.reason && /timeout|loop|safety|invalid/i.test(e.reason) ? 'bg-red-500/5' : ''
                }`}
              >
                <td className="whitespace-nowrap px-2 py-1.5 font-mono">{new Date(e.initiatedAt).toLocaleString()}</td>
                <td className="max-w-md px-2 py-1.5">{e.reason ?? '—'}</td>
                <td className="px-2 py-1.5">{e.outcome ?? '—'}</td>
                <td className="px-2 py-1.5 text-right">{e.answered ? 'yes' : 'no'}</td>
                <td className="px-2 py-1.5 text-right">{e.bridgeSeconds != null ? `${e.bridgeSeconds}s` : '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  {e.resultedInAppointment === null ? '—' : e.resultedInAppointment ? 'yes' : 'no'}
                </td>
                <td className="px-2 py-1.5">
                  {e.callLogId && (
                    <button className="text-primary hover:underline" onClick={() => setTranscriptCall(e.callLogId)}>
                      transcript
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {transcriptCall && <SageTranscriptModal callLogId={transcriptCall} onClose={() => setTranscriptCall(null)} />}
    </section>
  )
}

// ─── Telemetry & Tools tab ───────────────────────────────────────────────

function TelemetryTab({ days }: { days: number }) {
  const [transcriptCall, setTranscriptCall] = useState<string | null>(null)
  const detail = useSageDetail(days, true)
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading telemetry…</p>
  if (detail.isError)
    return (
      <p className="text-sm text-red-600">
        Telemetry failed: {(detail.error as any)?.response?.data?.error ?? String(detail.error)}
      </p>
    )
  const d = detail.data!
  return (
    <section className="space-y-5">
      <div>
        <h4 className="mb-1.5 text-sm font-medium">
          Tool calls — error rate per tool, with the actual error messages ({d.windowDays}d)
        </h4>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left uppercase text-muted-foreground">
                <th className="px-2 py-1.5">Tool</th>
                <th className="px-2 py-1.5 text-right">Errors</th>
                <th className="px-2 py-1.5 text-right">Error rate</th>
                <th className="px-2 py-1.5 text-right">Avg ms</th>
                <th className="px-2 py-1.5">Latest errors</th>
              </tr>
            </thead>
            <tbody>
              {d.toolErrors.map((t) => {
                const rate = t.calls ? t.errors / t.calls : 0
                return (
                  <tr key={t.toolName} className={`border-b last:border-0 ${rate >= 0.15 ? 'bg-red-500/5' : ''}`}>
                    <td className="px-2 py-1.5 font-mono">{t.toolName}</td>
                    <td className="px-2 py-1.5 text-right">
                      {t.errors}/{t.calls}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right ${
                        rate >= 0.15 ? 'font-semibold text-red-600 dark:text-red-400' : ''
                      }`}
                    >
                      {pct(rate, 1)}
                    </td>
                    <td className="px-2 py-1.5 text-right">{t.avgDurationMs ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      {t.sampleErrors.map((e, i) => (
                        <p key={i} className="mb-0.5 last:mb-0">
                          · {e}
                        </p>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-sm font-medium">
          Telemetry — calls with OpenAI errors, tool errors, reconnects, or 6s+ latency spikes
        </h4>
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left uppercase text-muted-foreground">
                <th className="px-2 py-1.5">Started</th>
                <th className="px-2 py-1.5">Dir</th>
                <th className="px-2 py-1.5">Outcome</th>
                <th className="px-2 py-1.5 text-right">Max latency</th>
                <th className="px-2 py-1.5 text-right">Greeting</th>
                <th className="px-2 py-1.5 text-right">OpenAI err</th>
                <th className="px-2 py-1.5 text-right">Tool err</th>
                <th className="px-2 py-1.5 text-right">Reconnects</th>
                <th className="px-2 py-1.5">Ended by</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {d.worstTelemetry.map((t, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">{new Date(t.startedAt).toLocaleString()}</td>
                  <td className="px-2 py-1.5">{t.direction ?? '—'}</td>
                  <td className="px-2 py-1.5">{t.outcome ?? '—'}</td>
                  <td
                    className={`px-2 py-1.5 text-right ${
                      (t.maxLatencyMs ?? 0) > 6000 ? 'font-semibold text-red-600 dark:text-red-400' : ''
                    }`}
                  >
                    {t.maxLatencyMs != null ? `${t.maxLatencyMs}ms` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {t.greetingLatencyMs != null ? `${t.greetingLatencyMs}ms` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">{t.openaiErrors}</td>
                  <td className="px-2 py-1.5 text-right">{t.toolErrors}</td>
                  <td className="px-2 py-1.5 text-right">{t.reconnects}</td>
                  <td className="px-2 py-1.5">{t.terminationReason ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    {t.callLogId && (
                      <button className="text-primary hover:underline" onClick={() => setTranscriptCall(t.callLogId)}>
                        transcript
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {transcriptCall && <SageTranscriptModal callLogId={transcriptCall} onClose={() => setTranscriptCall(null)} />}
    </section>
  )
}

// ─── Openings tab ────────────────────────────────────────────────────────

function OpeningsTab() {
  const openings = useQuery<OpeningsResponse>({
    queryKey: ['obs-openings'],
    queryFn: async () => (await apiClient.get('/observatory/openings?days=7')).data,
    refetchInterval: 300_000,
  })
  return (
    <section>
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
                    {a.callsSampled
                      ? `${pct(a.greetingAdherence)} adherent · ${a.callsSampled} calls`
                      : 'no calls sampled'}
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
                        <span className="mr-1.5 inline-block w-8 text-right font-mono text-muted-foreground">
                          {o.n}×
                        </span>
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
  )
}

// ─── Funnel tab ──────────────────────────────────────────────────────────

function FunnelTab() {
  const funnel = useQuery<FunnelResponse>({
    queryKey: ['obs-funnel'],
    queryFn: async () => (await apiClient.get('/observatory/funnel?weeks=12')).data,
    refetchInterval: 300_000,
  })
  return (
    <section>
      <p className="mb-3 text-sm text-muted-foreground">
        SAGE bookings by week: booked → entered in NextGen → materialized on the schedule → kept, with losses by
        verdict. Restored July bookings count in their original booking week.
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
  )
}

// ─── Change Trail tab ────────────────────────────────────────────────────

function ChangesTab() {
  const changes = useQuery<ChangesResponse>({
    queryKey: ['obs-changes'],
    queryFn: async () => (await apiClient.get('/observatory/agent-changes?limit=100')).data,
    refetchInterval: 120_000,
  })
  return (
    <section>
      <p className="mb-3 text-sm text-muted-foreground">
        <History className="mr-1 inline h-4 w-4" />
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
          {!changes.data.changes.length && <p className="p-4 text-sm text-muted-foreground">No changes recorded yet.</p>}
        </div>
      )}
    </section>
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

function SageTranscriptModal({ callLogId, onClose }: { callLogId: string; onClose: () => void }) {
  const t = useQuery<{
    id: string
    createdAt: string
    direction: string | null
    outcome: string | null
    transcript: string | null
  }>({
    queryKey: ['obs-sage-transcript', callLogId],
    queryFn: async () => (await apiClient.get(`/observatory/sage-transcript/${callLogId}`)).data,
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-lg border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold">
            SAGE call transcript{' '}
            {t.data && (
              <span className="font-normal text-muted-foreground">
                — {new Date(t.data.createdAt).toLocaleString()} · {t.data.direction} · {t.data.outcome ?? 'no outcome'}
              </span>
            )}
          </h4>
          <button onClick={onClose} className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent">
            Close
          </button>
        </div>
        {t.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {t.isError && <p className="text-sm text-red-600">{(t.error as any)?.response?.data?.error ?? String(t.error)}</p>}
        {t.data && (
          <pre className="whitespace-pre-wrap text-xs leading-relaxed">{t.data.transcript ?? '(no transcript stored)'}</pre>
        )}
      </div>
    </div>
  )
}

// ─── Scripts & Syncs tab ─────────────────────────────────────────────────

function SyncsTab() {
  const syncs = useQuery<SyncsOverview>({
    queryKey: ['obs-syncs'],
    queryFn: async () => (await apiClient.get('/observatory/syncs')).data,
    refetchInterval: 120_000,
  })
  if (syncs.isLoading) return <p className="text-sm text-muted-foreground">Loading sync feeds…</p>
  if (syncs.isError)
    return (
      <p className="text-sm text-red-600">
        Syncs failed: {(syncs.error as any)?.response?.data?.error ?? String(syncs.error)}
      </p>
    )
  const d = syncs.data!
  const toneFor = (s: SyncFeedStatus['status']): Tone =>
    s === 'ok' ? 'green' : s === 'stale' ? 'red' : s === 'error' ? 'red' : 'grey'
  return (
    <section className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Every feed that keeps every application's data fresh — including the scripts that run on your Mac each
        morning. Red = past its freshness SLA: run the script or investigate before trusting downstream numbers.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">Application</th>
              <th className="px-3 py-2">Feed</th>
              <th className="px-3 py-2">What it keeps fresh</th>
              <th className="px-3 py-2">Runs via</th>
              <th className="px-3 py-2 text-right">Last success</th>
              <th className="px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-right">SLA</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {d.feeds.map((f) => (
              <tr key={f.key} className={`border-b text-xs last:border-0 ${f.status === 'stale' || f.status === 'error' ? 'bg-red-500/5' : ''}`}>
                <td className="px-3 py-1.5">
                  <StatusDot tone={toneFor(f.status)} />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">{f.app}</td>
                <td className="px-3 py-1.5 font-medium">{f.name}</td>
                <td className="max-w-xs px-3 py-1.5 text-muted-foreground">{f.feeds}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{f.runBy}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono">
                  {f.lastRunAt ? new Date(f.lastRunAt).toLocaleString() : '—'}
                </td>
                <td className={`px-3 py-1.5 text-right ${f.status === 'stale' ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}>
                  {f.ageHours != null ? `${f.ageHours}h` : '—'}
                </td>
                <td className="px-3 py-1.5 text-right text-muted-foreground">{f.slaHours ? `${f.slaHours}h` : '—'}</td>
                <td className="max-w-xs px-3 py-1.5 text-muted-foreground">{f.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="mb-1.5 text-sm font-medium">
          Patient Console — NextGen appointment activity (all sources: Sage, SD pilot, staff in the console)
        </h4>
        {!d.consoleConfigured && (
          <p className="text-xs text-muted-foreground">
            Add the OBS_CONSOLE_DATABASE_URL secret and redeploy to light this up.
          </p>
        )}
        {d.consoleActivity.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50 text-left uppercase text-muted-foreground">
                  <th className="px-3 py-1.5">Day (sync date)</th>
                  <th className="px-3 py-1.5 text-right">Appointments synced</th>
                  <th className="px-3 py-1.5 text-right">Of which cancelled</th>
                </tr>
              </thead>
              <tbody>
                {d.consoleActivity.map((a) => (
                  <tr key={a.day} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono">{a.day}</td>
                    <td className="px-3 py-1.5 text-right">{a.apptsSynced.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right">{a.cancelled.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
