import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef } from 'react'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts'
import {
  AlertCircle,
  CheckCircle,
  Upload,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  FileText,
  Cpu,
  Phone,
  Download,
  AlertTriangle,
  Clock,
  Save,
  Bell,
} from 'lucide-react'

interface ReconciliationSummary {
  period: { startDate: string; endDate: string }
  totalActualUsd: number
  totalEstimatedUsd: number
  totalDeltaUsd: number
  daysReconciled: number
  dailyReconciliations: Array<{
    dateUtc: string
    estimatedUsd: string | null
    actualUsd: string | null
    deltaUsd: string | null
    deltaPercent: string | null
    perCallSumCents: number | null
    orgBilledCents: number | null
    unallocatedCents: number | null
    modelBreakdown: any
    hasDiscrepancyAlert: boolean | null
    discrepancyThresholdPct: string | null
  }>
  modelCostSummary: Record<string, {
    totalTokens: number
    estimatedCostCents: number
    requests: number
  }>
  legacyCosts: Array<{
    date: string
    actualCostCents: number | null
    estimatedCostCents: number | null
    discrepancyPercent: string | null
  }>
}

interface CsvImportResponse {
  success: boolean
  detectedFormat?: string
  error?: string
  missingColumns?: string[]
  import: {
    totalRows: number
    skippedRows: number
    datesImported: number
    totalEstimatedCostDollars: number
    costByModel: Record<string, number>
    costByDate: Record<string, number>
    detectedFormat?: string
  }
  audit: {
    period: { startDate: string; endDate: string }
    csvTotals: {
      totalCostDollars: number
      costByModel: Record<string, number>
    }
    internalTotals: {
      orgBilledDollars: number
      perCallEstimatedDollars: number
    }
    discrepancy: {
      csvVsOrgBilled: number
      orgBilledVsPerCall: number
    }
    dailyComparison: Array<{
      date: string
      csvCostDollars: number
      orgBilledDollars: number
      perCallDollars: number
      unallocatedDollars: number
    }>
  }
}

interface TwilioCostsResponse {
  daily: Array<{
    dateUtc: string
    totalCostCents: number | null
    estimatedCostCents: number | null
    deltaCents: number | null
    callCount: number
    totalDurationSeconds: number
    breakdown: Record<string, number> | null
  }>
  totalCostDollars: number
  totalEstimatedDollars: number
  totalDeltaDollars: number
  totalCallCount: number
  daysAvailable: number
  daysWithEstimates: number
}

interface TwilioCsvImportResponse {
  success: boolean
  rowsProcessed: number
  datesImported: number
  dateRange: { startDate: string; endDate: string } | null
  totalCostDollars: number
  error?: string
}

const formatUsd = (dollars: number) => `$${dollars.toFixed(2)}`
const formatDate = (dateStr: string) => {
  const date = new Date(dateStr + 'T00:00:00')
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const DeltaTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    const total = data.actual + (data.twilioActual || 0)
    const hasTwilio = !!data.hasTwilioInPeriod
    const twilioOnly = !!data.twilioOnly
    return (
      <div className="rounded-lg border border-border bg-background p-3 shadow-lg text-sm">
        <p className="font-medium text-foreground mb-1">{formatDate(data.date)}</p>
        {twilioOnly && (
          <p className="text-xs text-amber-500 mb-2 italic">No OpenAI reconciliation entry for this day</p>
        )}
        <div className="space-y-1">
          <div className={`flex justify-between gap-4 ${twilioOnly ? 'opacity-40' : ''}`}>
            <span className="text-violet-500">OpenAI Actual</span>
            <span className="font-medium">{formatUsd(data.actual)}</span>
          </div>
          <div className={`flex justify-between gap-4 ${twilioOnly ? 'opacity-40' : ''}`}>
            <span className="text-blue-500">OpenAI Estimated</span>
            <span className="font-medium">{formatUsd(data.estimated)}</span>
          </div>
          {hasTwilio && (
            <div className="flex justify-between gap-4">
              <span className="text-emerald-500">Twilio Actual</span>
              <span className="font-medium">{formatUsd(data.twilioActual || 0)}</span>
            </div>
          )}
          {hasTwilio && (
            <div className="flex justify-between gap-4 border-t border-border pt-1">
              <span className="font-medium text-foreground">Total Spend</span>
              <span className="font-bold">{formatUsd(total)}</span>
            </div>
          )}
          {!twilioOnly && (
            <div className="flex justify-between gap-4 border-t border-border pt-1">
              <span className="text-muted-foreground">OpenAI Unallocated</span>
              <span className={`font-medium ${data.delta > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                {data.delta > 0 ? '+' : ''}{formatUsd(data.delta)}
              </span>
            </div>
          )}
        </div>
      </div>
    )
  }
  return null
}

const CSV_FORMAT_LABELS: Record<string, string> = {
  'token-usage': 'Token Usage Export',
  'audio-speeches': 'Audio Speeches (TTS) Export',
  'completions': 'Completions Export',
}

interface CostReconciliationProps {
  startDate: string
  endDate: string
}

export function CostReconciliation({ startDate, endDate }: CostReconciliationProps) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const twilioFileInputRef = useRef<HTMLInputElement>(null)
  const [csvResult, setCsvResult] = useState<CsvImportResponse | null>(null)
  const [csvError, setCsvError] = useState<string | null>(null)
  const [showCsvDetails, setShowCsvDetails] = useState(false)
  const [twilioImportResult, setTwilioImportResult] = useState<TwilioCsvImportResponse | null>(null)
  const [scheduleEditHour, setScheduleEditHour] = useState<number | null>(null)
  const [scheduleSaveError, setScheduleSaveError] = useState<string | null>(null)
  const [scheduleSaved, setScheduleSaved] = useState(false)
  const [testAlertResult, setTestAlertResult] = useState<{ success: boolean; channels: string[]; errors: string[] } | null>(null)

  const { data: reconciliation, isLoading, isFetching } = useQuery({
    queryKey: ['reconciliation-summary', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate })
      const { data } = await apiClient.get<ReconciliationSummary>(`/analytics/reconciliation-summary?${params}`)
      return data
    },
    retry: 1,
  })

  const { data: twilioCosts } = useQuery({
    queryKey: ['twilio-costs', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate })
      const { data } = await apiClient.get<TwilioCostsResponse>(`/analytics/twilio-costs?${params}`)
      return data
    },
    retry: 1,
  })

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post('/analytics/reconcile-org-billing', { startDate, endDate })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-summary'] })
      queryClient.invalidateQueries({ queryKey: ['openai-usage'] })
    },
  })

  const csvMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text()
      const { data } = await apiClient.post<CsvImportResponse>('/analytics/import-openai-csv', { csvContent: text })
      return data
    },
    onSuccess: (data) => {
      if (data.success) {
        setCsvResult(data)
        setCsvError(null)
        setShowCsvDetails(true)
        queryClient.invalidateQueries({ queryKey: ['reconciliation-summary'] })
      } else {
        setCsvError(data.error || 'Import failed')
        setCsvResult(null)
      }
    },
    onError: (err: unknown) => {
      const apiErr = err as { response?: { data?: { error?: string } }; message?: string }
      const msg = apiErr?.response?.data?.error || apiErr?.message || 'CSV import failed'
      setCsvError(msg)
      setCsvResult(null)
    },
  })

  const twilioCsvMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text()
      const { data } = await apiClient.post<TwilioCsvImportResponse>('/analytics/import-twilio-csv', { csvContent: text })
      return data
    },
    onSuccess: (data) => {
      setTwilioImportResult(data)
      queryClient.invalidateQueries({ queryKey: ['twilio-costs'] })
    },
  })

  const { data: nightlySchedule } = useQuery({
    queryKey: ['nightly-reconcile-hour'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ hour: number; updatedAt: string | null; updatedBy: string | null; source: string }>('/settings/nightly-reconcile-hour')
      return data
    },
    retry: 1,
  })

  const nightlyScheduleMutation = useMutation({
    mutationFn: async (hour: number) => {
      const { data } = await apiClient.put('/settings/nightly-reconcile-hour', { hour })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nightly-reconcile-hour'] })
      setScheduleEditHour(null)
      setScheduleSaved(true)
      setScheduleSaveError(null)
      setTimeout(() => setScheduleSaved(false), 3000)
    },
    onError: (err: unknown) => {
      const apiErr = err as { response?: { data?: { error?: string } }; message?: string }
      setScheduleSaveError(apiErr?.response?.data?.error || apiErr?.message || 'Failed to save')
    },
  })

  const testAlertMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{ success: boolean; channels: string[]; errors: string[] }>('/reconciliation/test-alert')
      return data
    },
    onSuccess: (data) => {
      setTestAlertResult(data)
    },
    onError: (err: unknown) => {
      const apiErr = err as { response?: { data?: { error?: string } }; message?: string }
      const msg = apiErr?.response?.data?.error || apiErr?.message || 'Test alert failed'
      setTestAlertResult({ success: false, channels: [], errors: [msg] })
    },
  })

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setCsvError(null)
      csvMutation.mutate(file)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleTwilioFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) twilioCsvMutation.mutate(file)
    if (twilioFileInputRef.current) twilioFileInputRef.current.value = ''
  }

  const handleExportReport = () => {
    const params = new URLSearchParams({ startDate, endDate })
    window.location.href = `/api/analytics/reconciliation-export?${params}`
  }

  const twilioDailyMap = new Map(
    (twilioCosts?.daily || []).map(d => [
      d.dateUtc,
      d.totalCostCents !== null ? d.totalCostCents / 100 : 0,
    ])
  )

  const hasTwilioData = !!(twilioCosts && twilioCosts.daysAvailable > 0)

  const reconciliationMap = new Map(
    (reconciliation?.dailyReconciliations || []).map(r => [r.dateUtc, r])
  )

  const allDates = new Set([
    ...reconciliationMap.keys(),
    ...twilioDailyMap.keys(),
  ])

  const chartData = Array.from(allDates)
    .map(date => {
      const r = reconciliationMap.get(date)
      const twilioActual = twilioDailyMap.get(date) ?? 0
      const twilioOnly = !r && twilioActual > 0
      return {
        date,
        actual: r ? Number(r.actualUsd) || 0 : 0,
        estimated: r ? Number(r.estimatedUsd) || 0 : 0,
        delta: r ? Number(r.deltaUsd) || 0 : 0,
        deltaPercent: r ? Number(r.deltaPercent) || 0 : 0,
        hasAlert: r ? r.hasDiscrepancyAlert : false,
        twilioActual,
        hasTwilioInPeriod: hasTwilioData,
        twilioOnly,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)

  const modelData = Object.entries(reconciliation?.modelCostSummary || {})
    .map(([model, stats]) => ({
      model: model.replace(/-20\d{2}-\d{2}-\d{2}/, '').replace('gpt-', ''),
      fullModel: model,
      costDollars: stats.estimatedCostCents / 100,
      requests: stats.requests,
      tokens: stats.totalTokens,
    }))
    .sort((a, b) => b.costDollars - a.costDollars)

  const totalDelta = reconciliation?.totalDeltaUsd || 0
  const totalActual = reconciliation?.totalActualUsd || 0
  const totalEstimated = reconciliation?.totalEstimatedUsd || 0
  const deltaPercent = totalActual > 0 ? ((totalDelta / totalActual) * 100) : 0
  const twilioTotalActual = twilioCosts?.totalCostDollars || 0
  const combinedTotalSpend = totalActual + twilioTotalActual

  const alertDays = reconciliation?.dailyReconciliations.filter(r => r.hasDiscrepancyAlert) || []

  return (
    <div className="space-y-6">
      {/* Test alert result banner */}
      {testAlertResult && (
        <div className={`rounded-lg border p-4 flex items-start gap-3 ${
          testAlertResult.success
            ? 'border-green-500/40 bg-green-500/10'
            : 'border-red-500/40 bg-red-500/10'
        }`}>
          {testAlertResult.success ? (
            <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            {testAlertResult.success ? (
              <>
                <p className="font-medium text-green-700 dark:text-green-400">
                  Test alert sent successfully
                </p>
                <p className="text-sm text-green-600 dark:text-green-500 mt-1">
                  Delivered via: {testAlertResult.channels.join(', ')}
                  {testAlertResult.errors.length > 0 && ` (some channels failed: ${testAlertResult.errors.join('; ')})`}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-red-700 dark:text-red-400">
                  Test alert failed
                </p>
                <p className="text-sm text-red-600 dark:text-red-500 mt-1">
                  {testAlertResult.errors.join('; ')}
                </p>
              </>
            )}
          </div>
          <button
            onClick={() => setTestAlertResult(null)}
            className="text-muted-foreground hover:text-foreground text-xs ml-2 flex-shrink-0"
          >
            ✕
          </button>
        </div>
      )}

      {/* Discrepancy alert banner */}
      {alertDays.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-700 dark:text-amber-400">
              Discrepancy Alert: {alertDays.length} day{alertDays.length > 1 ? 's' : ''} exceed threshold
            </p>
            <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
              Days with delta &gt;{alertDays[0]?.discrepancyThresholdPct || 15}% between actual and estimated:&nbsp;
              {alertDays.map(d => formatDate(d.dateUtc)).join(', ')}
            </p>
          </div>
        </div>
      )}

      <Card className="border-border bg-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-amber-500" />
              Cost Reconciliation
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Actual OpenAI billing vs per-call estimates
            </p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <input
              type="file"
              ref={twilioFileInputRef}
              accept=".csv"
              onChange={handleTwilioFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={csvMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
              title="Import OpenAI usage CSV (token-usage, audio-speeches, or completions format)"
            >
              <Upload className={`h-4 w-4 ${csvMutation.isPending ? 'animate-pulse' : ''}`} />
              Import OpenAI CSV
            </button>
            <button
              onClick={() => twilioFileInputRef.current?.click()}
              disabled={twilioCsvMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
              title="Import Twilio usage CSV"
            >
              <Phone className={`h-4 w-4 ${twilioCsvMutation.isPending ? 'animate-pulse' : ''}`} />
              Import Twilio CSV
            </button>
            <button
              onClick={handleExportReport}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80"
              title="Download reconciliation report as CSV"
            >
              <Download className="h-4 w-4" />
              Export Report
            </button>
            <button
              onClick={() => { setTestAlertResult(null); testAlertMutation.mutate() }}
              disabled={testAlertMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
              title="Send a test discrepancy alert to verify your alert configuration"
            >
              <Bell className={`h-4 w-4 ${testAlertMutation.isPending ? 'animate-pulse' : ''}`} />
              Test Alert
            </button>
            <button
              onClick={() => reconcileMutation.mutate()}
              disabled={reconcileMutation.isPending || isFetching}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${reconcileMutation.isPending ? 'animate-spin' : ''}`} />
              Reconcile
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            </div>
          ) : reconciliation && reconciliation.daysReconciled > 0 ? (
            <div className="space-y-6">
              <div className={`grid gap-4 ${hasTwilioData ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-4 text-center">
                  <p className="text-xs text-muted-foreground">OpenAI Actual</p>
                  <p className="text-2xl font-bold text-violet-600 dark:text-violet-400">{formatUsd(totalActual)}</p>
                  <p className="text-xs text-muted-foreground mt-1">from OpenAI org API</p>
                </div>
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-center">
                  <p className="text-xs text-muted-foreground">Per-Call Estimated</p>
                  <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{formatUsd(totalEstimated)}</p>
                  <p className="text-xs text-muted-foreground mt-1">from call log sums</p>
                </div>
                <div className={`rounded-lg border p-4 text-center ${
                  Math.abs(deltaPercent) <= 10 
                    ? 'border-green-500/20 bg-green-500/5' 
                    : 'border-amber-500/20 bg-amber-500/5'
                }`}>
                  <p className="text-xs text-muted-foreground">Unallocated</p>
                  <div className="flex items-center justify-center gap-1">
                    {totalDelta > 0 ? (
                      <TrendingUp className="h-5 w-5 text-amber-500" />
                    ) : (
                      <TrendingDown className="h-5 w-5 text-green-500" />
                    )}
                    <p className={`text-2xl font-bold ${
                      Math.abs(deltaPercent) <= 10 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
                    }`}>
                      {totalDelta > 0 ? '+' : ''}{formatUsd(totalDelta)}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {deltaPercent.toFixed(1)}% of billed
                    {alertDays.length > 0 && (
                      <span className="ml-1 text-amber-500">⚠ {alertDays.length} alert{alertDays.length > 1 ? 's' : ''}</span>
                    )}
                  </p>
                </div>
                {hasTwilioData && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-center">
                    <p className="text-xs text-muted-foreground">Total Daily Spend</p>
                    <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{formatUsd(combinedTotalSpend)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      OpenAI + Twilio
                    </p>
                  </div>
                )}
                <div className="rounded-lg border border-border bg-muted/30 p-4 text-center">
                  <p className="text-xs text-muted-foreground">Days Reconciled</p>
                  <p className="text-2xl font-bold text-foreground">{reconciliation.daysReconciled}</p>
                  <div className="flex items-center justify-center gap-1 mt-1">
                    {reconciliation.daysReconciled > 0 ? (
                      <CheckCircle className="h-3 w-3 text-green-500" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-amber-500" />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {reconciliation.daysReconciled > 0 ? 'data available' : 'run reconcile'}
                    </p>
                  </div>
                </div>
              </div>

              {chartData.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-foreground mb-3">
                    Daily Costs: OpenAI{hasTwilioData ? ' + Twilio' : ' Actual vs Estimated'}
                  </h4>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                        <XAxis
                          dataKey="date"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickFormatter={formatDate}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                          width={45}
                        />
                        <Tooltip content={<DeltaTooltip />} />
                        <Legend
                          wrapperStyle={{ fontSize: '12px' }}
                          formatter={(value: string) => {
                            if (value === 'actual') return 'OpenAI Actual'
                            if (value === 'estimated') return 'OpenAI Estimated'
                            if (value === 'twilioActual') return 'Twilio Actual'
                            return value
                          }}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--border))" />
                        <Bar dataKey="actual" fill="#8b5cf6" radius={[4, 4, 0, 0]} barSize={10}>
                          {chartData.map((entry, index) => (
                            <Cell key={`actual-${index}`} fill={entry.twilioOnly ? '#8b5cf630' : '#8b5cf6'} />
                          ))}
                        </Bar>
                        <Bar dataKey="estimated" fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={10}>
                          {chartData.map((entry, index) => (
                            <Cell key={`estimated-${index}`} fill={entry.twilioOnly ? '#3b82f630' : '#3b82f6'} />
                          ))}
                        </Bar>
                        {hasTwilioData && (
                          <Bar dataKey="twilioActual" fill="#10b981" radius={[4, 4, 0, 0]} barSize={10} />
                        )}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {hasTwilioData && chartData.some(d => d.twilioOnly) && (
                    <p className="text-xs text-muted-foreground mt-2">
                      <span className="inline-block w-2 h-2 rounded-sm bg-amber-500/40 mr-1 align-middle" />
                      Some days have Twilio data but no OpenAI reconciliation entry — hover those bars for details.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <FileText className="mx-auto h-8 w-8" />
              <p className="mt-2">No reconciliation data yet</p>
              <p className="text-xs mt-1">Click "Reconcile" to fetch actual billing data from OpenAI, or "Import OpenAI CSV" to upload a usage export</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Twilio Cost Panel */}
      {twilioCosts && (twilioCosts.daysAvailable > 0 || twilioCosts.daysWithEstimates > 0) && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-primary" />
              Twilio Cost Reconciliation
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Actual (from imported CSV) vs Estimated (from per-call cost data)
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-center">
                <p className="text-xs text-muted-foreground">Actual (CSV Import)</p>
                <p className="text-2xl font-bold text-primary">{formatUsd(twilioCosts.totalCostDollars)}</p>
                <p className="text-xs text-muted-foreground mt-1">{twilioCosts.daysAvailable} days</p>
              </div>
              <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-center">
                <p className="text-xs text-muted-foreground">Estimated (Per-Call)</p>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{formatUsd(twilioCosts.totalEstimatedDollars)}</p>
                <p className="text-xs text-muted-foreground mt-1">{twilioCosts.daysWithEstimates} days with logs</p>
              </div>
              <div className={`rounded-lg border p-4 text-center ${
                Math.abs(twilioCosts.totalDeltaDollars) < twilioCosts.totalCostDollars * 0.1
                  ? 'border-green-500/20 bg-green-500/5'
                  : 'border-amber-500/20 bg-amber-500/5'
              }`}>
                <p className="text-xs text-muted-foreground">Delta (Actual − Est.)</p>
                <p className={`text-2xl font-bold ${
                  Math.abs(twilioCosts.totalDeltaDollars) < twilioCosts.totalCostDollars * 0.1
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}>
                  {twilioCosts.totalDeltaDollars > 0 ? '+' : ''}{formatUsd(twilioCosts.totalDeltaDollars)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {twilioCosts.totalCostDollars > 0
                    ? `${((twilioCosts.totalDeltaDollars / twilioCosts.totalCostDollars) * 100).toFixed(1)}% of actual`
                    : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-center">
                <p className="text-xs text-muted-foreground">Total Calls</p>
                <p className="text-2xl font-bold text-foreground">{twilioCosts.totalCallCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">from imported CSV</p>
              </div>
            </div>

            {twilioCosts.daily.length > 0 && (
              <div className="mt-4">
                <h4 className="text-sm font-medium text-foreground mb-3">Daily Twilio: Actual vs Estimated</h4>
                <div className="space-y-2 max-h-56 overflow-y-auto">
                  {twilioCosts.daily.slice(-14).reverse().map(day => {
                    const actual = day.totalCostCents !== null ? day.totalCostCents / 100 : null
                    const est = day.estimatedCostCents !== null ? day.estimatedCostCents / 100 : null
                    const delta = day.deltaCents !== null ? day.deltaCents / 100 : null
                    return (
                      <div key={day.dateUtc} className="flex items-center justify-between text-sm rounded-md bg-muted/40 px-3 py-2">
                        <span className="text-muted-foreground w-16 flex-shrink-0">{formatDate(day.dateUtc)}</span>
                        <div className="flex gap-4 text-right flex-1 justify-end">
                          <span className="text-xs text-muted-foreground">{day.callCount} calls</span>
                          {est !== null && (
                            <span className="text-xs text-blue-500">est {formatUsd(est)}</span>
                          )}
                          {actual !== null ? (
                            <span className="font-medium text-foreground">{formatUsd(actual)}</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">no CSV</span>
                          )}
                          {delta !== null && (
                            <span className={`text-xs ${Math.abs(delta) > 1 ? 'text-amber-500' : 'text-green-500'}`}>
                              {delta > 0 ? '+' : ''}{formatUsd(delta)}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Twilio import no-data placeholder */}
      {(!twilioCosts || (twilioCosts.daysAvailable === 0 && twilioCosts.daysWithEstimates === 0)) && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-primary" />
              Twilio Cost Reconciliation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="py-6 text-center text-muted-foreground">
              <Phone className="mx-auto h-8 w-8 mb-2" />
              <p>No Twilio usage data imported yet</p>
              <p className="text-xs mt-1">Click "Import Twilio CSV" to upload a Twilio usage export and compare estimated vs actual Twilio spend</p>
              {twilioCsvMutation.isPending && (
                <div className="mt-3 flex justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}
              {twilioCsvMutation.isError && (
                <p className="mt-2 text-sm text-red-500">
                  {(() => {
                    const e = twilioCsvMutation.error as { response?: { data?: { error?: string } }; message?: string } | null
                    return `Import failed: ${e?.response?.data?.error || e?.message || 'Unknown error'}`
                  })()}
                </p>
              )}
              {twilioImportResult && (
                <p className="mt-2 text-sm text-green-600 dark:text-green-400">
                  Imported {twilioImportResult.rowsProcessed} rows across {twilioImportResult.datesImported} days (${twilioImportResult.totalCostDollars.toFixed(2)})
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {modelData.length > 0 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-violet-500" />
              Cost by Model (Token-Based)
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Estimated costs from org usage data, broken down by model
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {modelData.map(m => {
                const maxCost = modelData[0]?.costDollars || 1
                const barWidth = Math.max(2, (m.costDollars / maxCost) * 100)
                return (
                  <div key={m.fullModel} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground truncate max-w-[250px]" title={m.fullModel}>
                        {m.model}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {m.requests.toLocaleString()} reqs
                        </span>
                        <span className="font-medium text-violet-600 dark:text-violet-400 min-w-[70px] text-right">
                          {formatUsd(m.costDollars)}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-violet-500"
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {showCsvDetails && csvResult?.audit && (
        <Card className="border-amber-500/20 bg-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-amber-500" />
                CSV Audit Report
              </CardTitle>
              {csvResult.detectedFormat && (
                <p className="text-xs text-muted-foreground mt-1">
                  Detected format: <span className="font-medium text-foreground">{CSV_FORMAT_LABELS[csvResult.detectedFormat] || csvResult.detectedFormat}</span>
                </p>
              )}
            </div>
            <button
              onClick={() => setShowCsvDetails(false)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">CSV Total (Token-Based)</p>
                  <p className="text-xl font-bold text-foreground">{formatUsd(csvResult.audit.csvTotals.totalCostDollars)}</p>
                  <p className="text-xs text-muted-foreground">{csvResult.import.totalRows} rows, {csvResult.import.datesImported} days</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Org Billed</p>
                  <p className="text-xl font-bold text-foreground">{formatUsd(csvResult.audit.internalTotals.orgBilledDollars)}</p>
                  <p className="text-xs text-muted-foreground">from reconciled data</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Per-Call Estimated</p>
                  <p className="text-xl font-bold text-foreground">{formatUsd(csvResult.audit.internalTotals.perCallEstimatedDollars)}</p>
                  <p className="text-xs text-muted-foreground">from call logs</p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className={`rounded-lg border p-3 ${
                  Math.abs(csvResult.audit.discrepancy.csvVsOrgBilled) < 1 
                    ? 'border-green-500/20 bg-green-500/5' 
                    : 'border-amber-500/20 bg-amber-500/5'
                }`}>
                  <p className="text-xs text-muted-foreground">CSV vs Org Billed</p>
                  <p className="text-lg font-bold">
                    {csvResult.audit.discrepancy.csvVsOrgBilled > 0 ? '+' : ''}
                    {formatUsd(csvResult.audit.discrepancy.csvVsOrgBilled)}
                  </p>
                </div>
                <div className={`rounded-lg border p-3 ${
                  Math.abs(csvResult.audit.discrepancy.orgBilledVsPerCall) < 5 
                    ? 'border-green-500/20 bg-green-500/5' 
                    : 'border-amber-500/20 bg-amber-500/5'
                }`}>
                  <p className="text-xs text-muted-foreground">Org Billed vs Per-Call</p>
                  <p className="text-lg font-bold">
                    {csvResult.audit.discrepancy.orgBilledVsPerCall > 0 ? '+' : ''}
                    {formatUsd(csvResult.audit.discrepancy.orgBilledVsPerCall)}
                  </p>
                </div>
              </div>

              {Object.entries(csvResult.audit.csvTotals.costByModel).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-foreground mb-2">CSV Cost by Model</h4>
                  <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                    {Object.entries(csvResult.audit.csvTotals.costByModel)
                      .sort(([, a], [, b]) => b - a)
                      .map(([model, cost]) => (
                        <div key={model} className="flex items-center justify-between text-sm rounded-md bg-muted/50 px-3 py-2">
                          <span className="text-muted-foreground truncate max-w-[150px]" title={model}>
                            {model.replace(/-20\d{2}-\d{2}-\d{2}/, '').replace('gpt-', '')}
                          </span>
                          <span className="font-medium text-foreground">{formatUsd(cost)}</span>
                        </div>
                      ))
                    }
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nightly Reconciliation Schedule */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            Nightly Reconciliation Schedule
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Automatic reconciliation runs once per day at the configured UTC hour
          </p>
        </CardHeader>
        <CardContent>
          {nightlySchedule ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
                  <Clock className="h-5 w-5 text-amber-500 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Current Schedule</p>
                    <p className="text-xl font-bold text-foreground">
                      {String(nightlySchedule.hour).padStart(2, '0')}:00 UTC
                    </p>
                    {nightlySchedule.source === 'database' && nightlySchedule.updatedBy && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Set by {nightlySchedule.updatedBy}
                        {nightlySchedule.updatedAt && (
                          <> on {new Date(nightlySchedule.updatedAt).toLocaleDateString()}</>
                        )}
                      </p>
                    )}
                    {nightlySchedule.source === 'default' && (
                      <p className="text-xs text-muted-foreground mt-0.5">Using default (env var)</p>
                    )}
                  </div>
                </div>

                <div className="flex items-end gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Change Hour (0–23 UTC)</label>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={scheduleEditHour ?? nightlySchedule.hour}
                      onChange={(e) => {
                        setScheduleSaved(false)
                        setScheduleSaveError(null)
                        setScheduleEditHour(parseInt(e.target.value, 10))
                      }}
                      className="w-20 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <button
                    onClick={() => {
                      const h = scheduleEditHour ?? nightlySchedule.hour
                      if (h >= 0 && h <= 23) nightlyScheduleMutation.mutate(h)
                    }}
                    disabled={nightlyScheduleMutation.isPending || scheduleEditHour === null || scheduleEditHour === nightlySchedule.hour}
                    className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {nightlyScheduleMutation.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>

              {scheduleSaved && (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  Schedule updated. The new hour will take effect at the next scheduled run.
                </div>
              )}
              {scheduleSaveError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4" />
                  {scheduleSaveError}
                </div>
              )}
            </div>
          ) : (
            <div className="flex justify-center py-4">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* CSV format/validation error */}
      {csvError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">CSV Import Error</p>
              <p className="mt-1">{csvError}</p>
            </div>
          </div>
        </div>
      )}

      {reconcileMutation.isError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Reconciliation failed. Make sure the OPENAI_ADMIN_API_KEY is configured.
          </div>
        </div>
      )}
    </div>
  )
}
