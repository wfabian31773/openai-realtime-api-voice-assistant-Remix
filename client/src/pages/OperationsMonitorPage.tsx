import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Activity, AlertTriangle, CheckCircle, Clock, Database, Phone, XCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DiagnosticsData {
  status: 'healthy' | 'degraded' | 'critical'
  timestamp: string
  last24Hours: {
    totalCalls: number
    successfulCalls: number
    acceptFailures: number
    dbErrors: number
    timeouts: number
    unaccountedCalls: number
    adjustedFailureRate: string
  }
  latency: {
    avgAcceptMs: number
    p95AcceptMs: number
  }
  activeCalls: number
  potentialOrphans: number
  tracesInMemory: number
}

interface ActiveTrace {
  traceId: string
  twilioCallSid: string | null
  openaiCallId: string | null
  agentSlug: string
  stageCount: number
  lastStage: string
  elapsedMs: number
}

interface RecentFailure {
  traceId: string
  twilioCallSid: string
  agentSlug: string
  outcome: string
  failureReason: string
  completedAt: number
  totalDurationMs: number
}

interface GraderStatsData {
  timeWindow: string
  totalGradedCalls: number
  graderStats: {
    handoffSuccessRate: number
    blockedPolicyCount: number
    tailSafetyFailCount: number
    durationMismatchFailCount: number
    criticalFailRate: number
    criticalFailCount: number
    emergencyMissCount: number
    providerMissCount: number
    medicalAdviceViolations: number
    actionableRequestMissCount: number
    callbackFieldsIncomplete: number
  }
}

export function OperationsMonitorPage() {
  const { data: diagnostics, isLoading: diagnosticsLoading, refetch: refetchDiagnostics } = useQuery<DiagnosticsData>({
    queryKey: ['diagnostics'],
    queryFn: async () => {
      const { data } = await apiClient.get('/voice/diagnostics')
      return data
    },
    refetchInterval: 15000,
  })

  const { data: activeTraces, isLoading: tracesLoading } = useQuery<{ count: number; traces: ActiveTrace[] }>({
    queryKey: ['diagnostics-active'],
    queryFn: async () => {
      const { data } = await apiClient.get('/voice/diagnostics/active')
      return data
    },
    refetchInterval: 5000,
  })

  const { data: recentFailures } = useQuery<{ failures: RecentFailure[] }>({
    queryKey: ['diagnostics-failures'],
    queryFn: async () => {
      const { data } = await apiClient.get('/voice/diagnostics/recent-failures')
      return data
    },
    refetchInterval: 30000,
  })

  const { data: graderStats } = useQuery<GraderStatsData>({
    queryKey: ['diagnostics-grader-stats'],
    queryFn: async () => {
      const { data } = await apiClient.get('/voice/diagnostics/grader-stats')
      return data
    },
    refetchInterval: 30000,
  })

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'text-green-600 bg-green-100'
      case 'degraded': return 'text-yellow-600 bg-yellow-100'
      case 'critical': return 'text-red-600 bg-red-100'
      default: return 'text-gray-600 bg-gray-100'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy': return <CheckCircle className="h-5 w-5" />
      case 'degraded': return <AlertTriangle className="h-5 w-5" />
      case 'critical': return <XCircle className="h-5 w-5" />
      default: return <Activity className="h-5 w-5" />
    }
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatTimeAgo = (timestamp: number) => {
    const ago = Date.now() - timestamp
    const mins = Math.floor(ago / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    return `${hours}h ago`
  }

  if (diagnosticsLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground">Operations Monitor</h1>
            {diagnostics && (
              <div className={`flex items-center gap-2 rounded-full px-3 py-1 ${getStatusColor(diagnostics.status)}`}>
                {getStatusIcon(diagnostics.status)}
                <span className="text-sm font-medium uppercase">{diagnostics.status}</span>
              </div>
            )}
          </div>
          <p className="text-muted-foreground mt-1">System health, active calls, and recent errors (auto-refreshes)</p>
        </div>
        <Button variant="outline" onClick={() => refetchDiagnostics()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Calls</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{diagnostics?.activeCalls || 0}</div>
            <p className="text-xs text-muted-foreground">
              {diagnostics?.potentialOrphans ? `${diagnostics.potentialOrphans} potential orphans` : 'No orphans detected'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">24h Calls</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{diagnostics?.last24Hours?.totalCalls || 0}</div>
            <p className="text-xs text-muted-foreground">
              {diagnostics?.last24Hours?.successfulCalls || 0} successful
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failure Rate</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${
              parseFloat(diagnostics?.last24Hours?.adjustedFailureRate || '0') > 5 
                ? 'text-red-600' 
                : 'text-green-600'
            }`}>
              {diagnostics?.last24Hours?.adjustedFailureRate || '0%'}
            </div>
            <p className="text-xs text-muted-foreground">
              Includes orphaned calls
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Accept Latency</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${
              (diagnostics?.latency?.avgAcceptMs || 0) > 3000 
                ? 'text-red-600' 
                : 'text-green-600'
            }`}>
              {diagnostics?.latency?.avgAcceptMs || 0}ms
            </div>
            <p className="text-xs text-muted-foreground">
              p95: {diagnostics?.latency?.p95AcceptMs || 0}ms
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Critical Grader Fails</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(graderStats?.graderStats?.criticalFailCount || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {graderStats?.graderStats?.criticalFailCount || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {graderStats?.graderStats?.criticalFailRate || 0}% of graded calls
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Handoff Success</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${
              (graderStats?.graderStats?.handoffSuccessRate || 100) > 95
                ? 'text-green-600'
                : (graderStats?.graderStats?.handoffSuccessRate || 100) > 80
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }`}>
              {graderStats?.graderStats?.handoffSuccessRate ?? 100}%
            </div>
            <p className="text-xs text-muted-foreground">
              {graderStats?.totalGradedCalls || 0} graded calls
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tail Safety Fails</CardTitle>
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(graderStats?.graderStats?.tailSafetyFailCount || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {graderStats?.graderStats?.tailSafetyFailCount || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              Tail safety check failures
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Duration Mismatches</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(graderStats?.graderStats?.durationMismatchFailCount || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {graderStats?.graderStats?.durationMismatchFailCount || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              Duration mismatch failures
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Healthcare Safety Graders (24h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Emergency Handling Misses</span>
                <Badge variant={(graderStats?.graderStats?.emergencyMissCount || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.emergencyMissCount || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Provider Escalation Misses</span>
                <Badge variant={(graderStats?.graderStats?.providerMissCount || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.providerMissCount || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Medical Advice Violations</span>
                <Badge variant={(graderStats?.graderStats?.medicalAdviceViolations || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.medicalAdviceViolations || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Actionable Request Misses</span>
                <Badge variant={(graderStats?.graderStats?.actionableRequestMissCount || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.actionableRequestMissCount || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Callback Fields Incomplete</span>
                <Badge variant={(graderStats?.graderStats?.callbackFieldsIncomplete || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.callbackFieldsIncomplete || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Blocked by Policy</span>
                <Badge variant={(graderStats?.graderStats?.blockedPolicyCount || 0) > 0 ? 'destructive' : 'secondary'}>
                  {graderStats?.graderStats?.blockedPolicyCount || 0}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              24h Failure Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Accept Failures</span>
                <Badge variant={diagnostics?.last24Hours?.acceptFailures ? 'destructive' : 'secondary'}>
                  {diagnostics?.last24Hours?.acceptFailures || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Database Errors</span>
                <Badge variant={diagnostics?.last24Hours?.dbErrors ? 'destructive' : 'secondary'}>
                  {diagnostics?.last24Hours?.dbErrors || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Timeouts</span>
                <Badge variant={diagnostics?.last24Hours?.timeouts ? 'destructive' : 'secondary'}>
                  {diagnostics?.last24Hours?.timeouts || 0}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Unaccounted</span>
                <Badge variant={diagnostics?.last24Hours?.unaccountedCalls ? 'warning' : 'secondary'}>
                  {diagnostics?.last24Hours?.unaccountedCalls || 0}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-green-600 animate-pulse" />
              Active Call Traces
              <Badge variant="outline" className="ml-2">{activeTraces?.count || 0}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tracesLoading ? (
              <div className="flex justify-center py-4">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : activeTraces?.traces?.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No active calls</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Progress</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeTraces?.traces?.slice(0, 10).map((trace) => (
                    <TableRow key={trace.traceId}>
                      <TableCell className="font-medium">{trace.agentSlug || 'unknown'}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{trace.lastStage}</Badge>
                      </TableCell>
                      <TableCell>{formatDuration(trace.elapsedMs)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {Array.from({ length: Math.min(trace.stageCount, 8) }).map((_, i) => (
                            <div key={i} className="w-2 h-2 rounded-full bg-blue-500" />
                          ))}
                          {trace.stageCount > 8 && <span className="text-xs text-muted-foreground">+{trace.stageCount - 8}</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-600" />
            Recent Failures
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!recentFailures?.failures?.length ? (
            <p className="text-center text-muted-foreground py-4">No recent failures</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentFailures.failures.map((failure) => (
                  <TableRow key={failure.traceId}>
                    <TableCell className="text-muted-foreground">{formatTimeAgo(failure.completedAt)}</TableCell>
                    <TableCell className="font-medium">{failure.agentSlug || 'unknown'}</TableCell>
                    <TableCell>
                      <Badge variant="destructive">{failure.outcome}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate" title={failure.failureReason}>
                      {failure.failureReason || 'Unknown'}
                    </TableCell>
                    <TableCell>{formatDuration(failure.totalDurationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
