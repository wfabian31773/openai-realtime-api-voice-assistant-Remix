/**
 * After-Hours On-Call (/on-call), admin only.
 *
 * Operator, 2026-11-24: "have a fully and completely robust page added to the
 * operations hub so that I can track and swap providers on call and have
 * complete admin control over that screen... I want to be able to see
 * everything that happens when a call comes in, what we do, what the
 * providers do, as much as possible."
 *
 * The API is server/onCallAdmin.ts; who is on call is the voice runtime's own
 * answer. Every change asks for a reason and lands with its audit row.
 */
import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { countdown, fmtPacific } from '@/lib/onCallView'
import { Banner, useOnCall } from '@/components/onCall/shared'
import { OverviewTab } from '@/components/onCall/OverviewTab'
import { ScheduleTab } from '@/components/onCall/ScheduleTab'
import { ProvidersTab } from '@/components/onCall/ProvidersTab'
import { EscalationTab } from '@/components/onCall/EscalationTab'
import { CallsTab } from '@/components/onCall/CallsTab'
import { AuditTab } from '@/components/onCall/AuditTab'
import { AlertTriangle, PhoneCall } from 'lucide-react'

interface Status {
  now: string
  tables: { rotation: boolean; admin: boolean; missing: string[]; unreadable?: boolean }
  tablesMessage: string | null
  config: {
    mode: 'off' | 'test' | 'live'
    rawMode: string
    disabledBecause?: string
    requireKept: boolean
    testPhones: number
    testPhonesLast4: (string | null)[]
    callerIdLast4: string | null
    urgentNotificationLast4: string | null
    fallbackNumberLast4: string | null
    transferMode: string
  }
  goLive: { at: string; pacific: string; msRemaining: number; passed: boolean }
}

type Tab = 'overview' | 'schedule' | 'providers' | 'escalation' | 'calls' | 'audit'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'providers', label: 'Providers' },
  { key: 'escalation', label: 'Escalation' },
  { key: 'calls', label: 'Calls' },
  { key: 'audit', label: 'Audit log' },
]

const MODE_VARIANT = { off: 'secondary', test: 'warning', live: 'success' } as const

export function OnCallPage() {
  const status = useOnCall<Status>('/status', { refetchInterval: 60_000 })
  const [tab, setTab] = React.useState<Tab>('overview')
  const s = status.data
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  // `tick` re-renders the countdown every 30 seconds.
  const remaining = React.useMemo(() => (s ? Math.max(0, new Date(s.goLive.at).getTime() - Date.now()) : 0), [s, tick])

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <PhoneCall className="h-6 w-6" />
        <h1 className="text-2xl font-bold">After-Hours On-Call</h1>
        {s && (
          <>
            <Badge variant={MODE_VARIANT[s.config.mode]}>rotation {s.config.mode.toUpperCase()}</Badge>
            <Badge variant={s.goLive.passed ? 'success' : 'info'}>
              go-live {s.goLive.pacific}: {s.goLive.passed ? 'passed' : `in ${countdown(remaining)}`}
            </Badge>
          </>
        )}
      </div>

      {status.isError && <Banner tone="error">The on-call status could not be read.</Banner>}
      {s && (
        <Card>
          <CardContent className="grid gap-3 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">ON_CALL_ROTATION_MODE (environment)</div>
              <div>
                {s.config.rawMode} → effective <strong>{s.config.mode}</strong>
              </div>
              {s.config.disabledBecause && <div className="text-destructive">forced off: {s.config.disabledBecause}</div>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Caller ID for provider calls · urgent notification number</div>
              <div>
                {s.config.callerIdLast4 ?? 'none'} · {s.config.urgentNotificationLast4 ?? 'unset'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Test phones · fallback (HUMAN_AGENT_NUMBER)</div>
              <div>
                {s.config.testPhonesLast4.length ? s.config.testPhonesLast4.join(', ') : 'none'} · {s.config.fallbackNumberLast4 ?? 'unset'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Post-op requires kept · transfer mode</div>
              <div>
                {s.config.requireKept ? 'yes' : 'no'} · {s.config.transferMode}
              </div>
              <div className="text-xs text-muted-foreground">as of {fmtPacific(s.now)}</div>
            </div>
          </CardContent>
        </Card>
      )}
      {s?.config.mode === 'off' && s.tables.rotation && (
        <Banner tone="info">
          The rotation is OFF: urgent after-hours calls ring the fixed on-call number today. This page shows who the rotation WOULD ring.
        </Banner>
      )}
      {s?.tablesMessage && (
        <Banner tone={s.tables.rotation ? 'warn' : 'error'}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div>{s.tablesMessage}</div>
            {s.tables.missing.length > 0 && <div className="text-xs">Missing: {s.tables.missing.join(', ')}</div>}
          </div>
        </Banner>
      )}

      {s && !s.tables.rotation ? null : (
        <>
          <div className="flex flex-wrap gap-1 border-b">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium ${
                  tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'overview' && <OverviewTab />}
          {tab === 'schedule' && <ScheduleTab />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'escalation' && <EscalationTab />}
          {tab === 'calls' && <CallsTab />}
          {tab === 'audit' && <AuditTab />}
        </>
      )}
    </div>
  )
}

export default OnCallPage
