import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef } from 'react'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  BarChart,
  Bar,
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
  import: {
    totalRows: number
    skippedRows: number
    datesImported: number
    totalEstimatedCostDollars: number
    costByModel: Record<string, number>
    costByDate: Record<string, number>
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

const formatUsd = (dollars: number) => `$${dollars.toFixed(2)}`
const formatDate = (dateStr: string) => {
  const date = new Date(dateStr + 'T00:00:00')
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const DeltaTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    return (
      <div className="rounded-lg border border-border bg-background p-3 shadow-lg text-sm">
        <p className="font-medium text-foreground mb-1">{formatDate(data.date)}</p>
        <div className="space-y-1">
          <div className="flex justify-between gap-4">
            <span className="text-violet-500">Actual (Billed)</span>
            <span className="font-medium">{formatUsd(data.actual)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-blue-500">Estimated (Per-call)</span>
            <span className="font-medium">{formatUsd(data.estimated)}</span>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-1">
            <span className="text-muted-foreground">Unallocated</span>
            <span className={`font-medium ${data.delta > 0 ? 'text-amber-500' : 'text-green-500'}`}>
              {data.delta > 0 ? '+' : ''}{formatUsd(data.delta)}
            </span>
          </div>
        </div>
      </div>
    )
  }
  return null
}

interface CostReconciliationProps {
  startDate: string
  endDate: string
}

export function CostReconciliation({ startDate, endDate }: CostReconciliationProps) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [csvResult, setCsvResult] = useState<CsvImportResponse | null>(null)
  const [showCsvDetails, setShowCsvDetails] = useState(false)

  const { data: reconciliation, isLoading, isFetching } = useQuery({
    queryKey: ['reconciliation-summary', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate })
      const { data } = await apiClient.get<ReconciliationSummary>(`/analytics/reconciliation-summary?${params}`)
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
      setCsvResult(data)
      setShowCsvDetails(true)
      queryClient.invalidateQueries({ queryKey: ['reconciliation-summary'] })
    },
  })

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      csvMutation.mutate(file)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const chartData = (reconciliation?.dailyReconciliations || [])
    .map(r => ({
      date: r.dateUtc,
      actual: Number(r.actualUsd) || 0,
      estimated: Number(r.estimatedUsd) || 0,
      delta: Number(r.deltaUsd) || 0,
      deltaPercent: Number(r.deltaPercent) || 0,
    }))
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

  return (
    <div className="space-y-6">
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
          <div className="flex gap-2">
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={csvMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              <Upload className={`h-4 w-4 ${csvMutation.isPending ? 'animate-pulse' : ''}`} />
              Import CSV
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
              <div className="grid gap-4 md:grid-cols-4">
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-4 text-center">
                  <p className="text-xs text-muted-foreground">Actual Billed</p>
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
                  </p>
                </div>
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
                  <h4 className="text-sm font-medium text-foreground mb-3">Daily: Actual vs Estimated</h4>
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
                            if (value === 'actual') return 'Actual (Billed)'
                            if (value === 'estimated') return 'Estimated (Per-call)'
                            return value
                          }}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--border))" />
                        <Bar dataKey="actual" fill="#8b5cf6" radius={[4, 4, 0, 0]} barSize={12} />
                        <Bar dataKey="estimated" fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={12} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <FileText className="mx-auto h-8 w-8" />
              <p className="mt-2">No reconciliation data yet</p>
              <p className="text-xs mt-1">Click "Reconcile" to fetch actual billing data from OpenAI, or "Import CSV" to upload a usage export</p>
            </div>
          )}
        </CardContent>
      </Card>

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
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-amber-500" />
              CSV Audit Report
            </CardTitle>
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

      {reconcileMutation.isError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Reconciliation failed. Make sure the OPENAI_ADMIN_API_KEY is configured.
          </div>
        </div>
      )}

      {csvMutation.isError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            CSV import failed. Please check the file format matches OpenAI's usage export.
          </div>
        </div>
      )}
    </div>
  )
}
