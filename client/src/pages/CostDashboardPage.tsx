import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { 
  DollarSign, 
  TrendingUp, 
  Phone, 
  Star,
  ThumbsUp,
  ThumbsDown,
  Meh,
  AlertCircle,
  Cpu,
  RefreshCw,
  CheckCircle,
  Users,
  Bot
} from 'lucide-react'
import type { Agent } from '@/types'
import { DailyCostCharts } from '@/components/DailyCostCharts'
import { CostReconciliation } from '@/components/CostReconciliation'

interface OpenAIUsage {
  totalCostDollars: number
  costByModel: Record<string, number>
  costByDate: Record<string, number>
  realtimeCostDollars: number
  opsHubCostByDate: Record<string, number>
  opsHubCostByModel: Record<string, number>
  entries: Array<{
    date: string
    model: string
    costDollars: number
    inputTokens: number
    outputTokens: number
    audioInputSeconds?: number
    audioOutputSeconds?: number
  }>
  dateRange: { startDate: string; endDate: string }
}

interface CostAnalytics {
  summary: {
    totalCalls: number
    totalTwilioCents: number
    totalOpenAICents: number
    totalCents: number
    totalDurationMinutes: number
    avgCostPerCallCents: number
    costPerMinuteCents: number
  }
  byAgent: Array<{
    agentId: string
    agentName: string
    agentSlug: string
    callCount: number
    totalCents: number
    avgCostPerCallCents: number
    totalDurationMinutes: number
  }>
  daily: Array<{
    date: string
    callCount: number
    totalCents: number
    twilioCents: number
    openaiCents: number
  }>
  coverage?: {
    totalCompleted: number
    withCallSid: number
    withTwilioCost: number
    withOpenAICost: number
    withQualityScore: number
    twilioCostCoverage: number
    openaiCostCoverage: number
    qualityCoverage: number
  }
}

interface QualityAnalytics {
  summary: {
    totalGradedCalls: number
    avgQualityScore: string | null
  }
  sentimentDistribution: Record<string, number>
  qualityScoreDistribution: Record<string, number>
  byAgent: Array<{
    agentId: string
    agentName: string
    agentSlug: string
    callCount: number
    avgScore: string | null
  }>
}

const DATE_RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

export function CostDashboardPage() {
  const [dateRange, setDateRange] = useState('30')
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const { data } = await apiClient.get<Agent[]>('/agents')
      return data
    },
  })

  const getDateParams = () => {
    if (dateRange === 'all') return {}
    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - parseInt(dateRange))
    return { 
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    }
  }

  const { data: costAnalytics, isLoading: costLoading } = useQuery({
    queryKey: ['analytics-costs', dateRange, selectedAgentId],
    queryFn: async () => {
      const params = new URLSearchParams(getDateParams() as any)
      if (selectedAgentId) params.set('agentId', selectedAgentId)
      const { data } = await apiClient.get<CostAnalytics>(`/analytics/costs?${params}`)
      return data
    },
  })

  const { data: qualityAnalytics, isLoading: qualityLoading } = useQuery({
    queryKey: ['analytics-quality', dateRange, selectedAgentId],
    queryFn: async () => {
      const params = new URLSearchParams(getDateParams() as any)
      if (selectedAgentId) params.set('agentId', selectedAgentId)
      const { data } = await apiClient.get<QualityAnalytics>(`/analytics/quality?${params}`)
      return data
    },
  })

  const getOpenAIDateParams = () => {
    const endDate = new Date().toISOString().split('T')[0]
    if (dateRange === 'all') {
      const startDate = new Date()
      startDate.setFullYear(startDate.getFullYear() - 1)
      return { startDate: startDate.toISOString().split('T')[0], endDate }
    }
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - parseInt(dateRange))
    return { startDate: startDate.toISOString().split('T')[0], endDate }
  }

  const { data: openaiUsage, isLoading: openaiLoading, refetch: refetchOpenAI, isFetching: openaiRefetching } = useQuery({
    queryKey: ['openai-usage', dateRange],
    queryFn: async () => {
      const { startDate, endDate } = getOpenAIDateParams()
      const params = new URLSearchParams({ startDate, endDate })
      const { data } = await apiClient.get<OpenAIUsage>(`/analytics/openai-usage?${params}`)
      return data
    },
    retry: 1,
  })

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`
  }

  const getSentimentIcon = (sentiment: string) => {
    switch (sentiment) {
      case 'satisfied': return <ThumbsUp className="h-4 w-4 text-green-500" />
      case 'neutral': return <Meh className="h-4 w-4 text-muted-foreground" />
      case 'frustrated': return <ThumbsDown className="h-4 w-4 text-orange-500" />
      case 'irate': return <AlertCircle className="h-4 w-4 text-red-500" />
      default: return null
    }
  }

  if (costLoading || qualityLoading) {
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
          <h1 className="text-3xl font-bold text-foreground">Cost & Quality Dashboard</h1>
          <p className="text-muted-foreground">Track call costs and patient satisfaction metrics</p>
        </div>
        <div className="flex gap-3">
          <select 
            value={dateRange} 
            onChange={(e) => setDateRange(e.target.value)}
            className="rounded-md border border-border bg-background text-foreground px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {DATE_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>
          <select 
            value={selectedAgentId} 
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="rounded-md border border-border bg-background text-foreground px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All Agents</option>
            {agents?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
            <DollarSign className="h-5 w-5 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">
              {formatCurrency(costAnalytics?.summary.totalCents || 0)}
            </div>
            <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
              <span className="text-primary">Twilio: {formatCurrency(costAnalytics?.summary.totalTwilioCents || 0)}</span>
              <span className="text-violet-600 dark:text-violet-400">OpenAI: {formatCurrency(costAnalytics?.summary.totalOpenAICents || 0)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Calls</CardTitle>
            <Phone className="h-5 w-5 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">
              {costAnalytics?.summary.totalCalls || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {costAnalytics?.summary.totalDurationMinutes || 0} minutes total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Cost/Call</CardTitle>
            <TrendingUp className="h-5 w-5 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">
              {formatCurrency(costAnalytics?.summary.avgCostPerCallCents || 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              {costAnalytics?.summary.costPerMinuteCents 
                ? `${formatCurrency(costAnalytics.summary.costPerMinuteCents)}/min`
                : 'Based on call duration'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Quality Score</CardTitle>
            <Star className="h-5 w-5 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1">
              {qualityAnalytics?.summary.avgQualityScore ? (
                <>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`h-6 w-6 ${
                        i < Math.round(parseFloat(qualityAnalytics.summary.avgQualityScore || '0'))
                          ? 'fill-yellow-400 text-yellow-400'
                          : 'text-muted-foreground'
                      }`}
                    />
                  ))}
                  <span className="ml-2 text-xl font-bold text-foreground">
                    {parseFloat(qualityAnalytics.summary.avgQualityScore).toFixed(1)}
                  </span>
                </>
              ) : (
                <span className="text-3xl font-bold text-muted-foreground">-</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {qualityAnalytics?.summary.totalGradedCalls || 0} calls graded
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Daily Cost Charts - OpenAI Style */}
      {costAnalytics?.daily && costAnalytics.daily.length > 0 && (
        <DailyCostCharts
          dailyData={costAnalytics.daily}
          totalOpenAICents={costAnalytics.summary.totalOpenAICents}
          totalTwilioCents={costAnalytics.summary.totalTwilioCents}
          totalCents={costAnalytics.summary.totalCents}
          dateRangeLabel={DATE_RANGES.find(r => r.value === dateRange)?.label || 'Selected period'}
        />
      )}

      {/* Data Coverage & AI vs Staff Comparison */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Data Coverage Indicators */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Data Coverage
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Accuracy indicators for cost and quality metrics
            </p>
          </CardHeader>
          <CardContent>
            {costAnalytics?.coverage ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Twilio Costs</span>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 rounded-full bg-muted">
                      <div 
                        className={`h-2 rounded-full ${costAnalytics.coverage.twilioCostCoverage >= 80 ? 'bg-green-500' : costAnalytics.coverage.twilioCostCoverage >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${costAnalytics.coverage.twilioCostCoverage}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{costAnalytics.coverage.twilioCostCoverage}%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">OpenAI Costs</span>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 rounded-full bg-muted">
                      <div 
                        className={`h-2 rounded-full ${costAnalytics.coverage.openaiCostCoverage >= 80 ? 'bg-green-500' : costAnalytics.coverage.openaiCostCoverage >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${costAnalytics.coverage.openaiCostCoverage}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{costAnalytics.coverage.openaiCostCoverage}%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Quality Scores</span>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 rounded-full bg-muted">
                      <div 
                        className={`h-2 rounded-full ${costAnalytics.coverage.qualityCoverage >= 80 ? 'bg-green-500' : costAnalytics.coverage.qualityCoverage >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${costAnalytics.coverage.qualityCoverage}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{costAnalytics.coverage.qualityCoverage}%</span>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t text-xs text-muted-foreground">
                  {costAnalytics.coverage.withTwilioCost} of {costAnalytics.coverage.totalCompleted} completed calls have verified Twilio cost data
                </div>
              </div>
            ) : (
              <div className="py-4 text-center text-muted-foreground">
                <CheckCircle className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2">Loading coverage data...</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI vs Staff Cost Comparison */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              AI vs Staff Cost Analysis
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Estimated savings from AI-powered call handling
            </p>
          </CardHeader>
          <CardContent>
            {costAnalytics?.summary && costAnalytics.coverage ? (
              <div className="space-y-4">
                {(() => {
                  const totalMinutes = costAnalytics.summary.totalDurationMinutes || 0
                  const totalAICost = costAnalytics.summary.totalCents / 100
                  const staffHourlyRate = 18
                  const staffCostPerMinute = staffHourlyRate / 60
                  const estimatedStaffCost = totalMinutes * staffCostPerMinute
                  const savings = estimatedStaffCost - totalAICost
                  const savingsPercent = estimatedStaffCost > 0 ? Math.round((savings / estimatedStaffCost) * 100) : 0
                  const coverageWarning = (costAnalytics.coverage?.twilioCostCoverage || 0) < 80 || (costAnalytics.coverage?.openaiCostCoverage || 0) < 80
                  
                  return (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="text-center p-3 rounded-lg bg-primary/10 dark:bg-primary/20">
                          <Bot className="h-6 w-6 mx-auto text-primary" />
                          <p className="text-xs text-muted-foreground mt-1">AI Cost</p>
                          <p className="text-lg font-bold text-primary">${totalAICost.toFixed(2)}</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-muted">
                          <Users className="h-6 w-6 mx-auto text-muted-foreground" />
                          <p className="text-xs text-muted-foreground mt-1">Staff Est.</p>
                          <p className="text-lg font-bold text-foreground">${estimatedStaffCost.toFixed(2)}</p>
                        </div>
                      </div>
                      
                      <div className="text-center py-3 rounded-lg bg-green-500/10 dark:bg-green-500/20">
                        <p className="text-xs text-muted-foreground">Estimated Savings</p>
                        <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                          ${savings.toFixed(2)} ({savingsPercent}%)
                        </p>
                      </div>
                      
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>Based on {totalMinutes} minutes of calls</p>
                        <p>Staff rate: ${staffHourlyRate}/hr assumed</p>
                        {coverageWarning && (
                          <p className="text-orange-600 font-medium">
                            Note: Data coverage below 80% - numbers may be understated
                          </p>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            ) : (
              <div className="py-4 text-center text-muted-foreground">
                <Users className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2">Calculating comparison...</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actual OpenAI Usage from API */}
      <Card className="border-border bg-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-violet-600 dark:text-violet-400" />
              Operations Hub OpenAI Usage
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Real-time voice agent costs (realtime, audio, whisper, transcription)
            </p>
          </div>
          <button
            onClick={() => refetchOpenAI()}
            disabled={openaiRefetching}
            className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${openaiRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </CardHeader>
        <CardContent>
          {openaiLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" />
            </div>
          ) : openaiUsage ? (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Total Cost Summary */}
              <div className="space-y-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted-foreground">Ops Hub OpenAI Cost</span>
                  <span className="text-3xl font-bold text-violet-600 dark:text-violet-400">
                    ${openaiUsage.realtimeCostDollars.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted-foreground">Other OpenAI Usage</span>
                  <span className="text-lg text-muted-foreground">
                    ${(openaiUsage.totalCostDollars - openaiUsage.realtimeCostDollars).toFixed(2)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {openaiUsage.dateRange.startDate} to {openaiUsage.dateRange.endDate}
                </div>
              </div>

              {/* Cost by Model - Only Ops Hub Models */}
              <div>
                <h4 className="text-sm font-medium text-foreground mb-3">Voice Agent Models</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {Object.entries(openaiUsage.opsHubCostByModel || {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([model, cost]) => (
                      <div key={model} className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground truncate max-w-[200px]" title={model}>
                          {model.replace(/-20\d{2}-\d{2}-\d{2}/, '').replace('gpt-', '').replace('realtime api | ', '')}
                        </span>
                        <span className="font-medium text-violet-600 dark:text-violet-400">
                          ${cost.toFixed(2)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <Cpu className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2">Unable to fetch OpenAI usage</p>
              <p className="text-xs mt-1">Make sure your API key has usage read permissions</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cost Reconciliation */}
      <CostReconciliation
        startDate={getOpenAIDateParams().startDate}
        endDate={getOpenAIDateParams().endDate}
      />

      {/* Sentiment Distribution */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Patient Sentiment Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {qualityAnalytics?.sentimentDistribution && Object.keys(qualityAnalytics.sentimentDistribution).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(qualityAnalytics.sentimentDistribution).map(([sentiment, count]) => {
                  const total = Object.values(qualityAnalytics.sentimentDistribution).reduce((a, b) => a + b, 0)
                  const percentage = total > 0 ? Math.round((count / total) * 100) : 0
                  
                  return (
                    <div key={sentiment} className="flex items-center gap-3">
                      {getSentimentIcon(sentiment)}
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium capitalize">{sentiment}</span>
                          <span className="text-sm text-muted-foreground">{count} ({percentage}%)</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted">
                          <div 
                            className={`h-2 rounded-full ${
                              sentiment === 'satisfied' ? 'bg-green-500' :
                              sentiment === 'neutral' ? 'bg-muted-foreground' :
                              sentiment === 'frustrated' ? 'bg-orange-500' :
                              'bg-red-500'
                            }`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <Meh className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2">No sentiment data available</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quality Score Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {qualityAnalytics?.qualityScoreDistribution && Object.keys(qualityAnalytics.qualityScoreDistribution).length > 0 ? (
              <div className="flex items-end justify-between gap-2 h-32">
                {[1, 2, 3, 4, 5].map((score) => {
                  const count = qualityAnalytics.qualityScoreDistribution[score] || 0
                  const total = Object.values(qualityAnalytics.qualityScoreDistribution).reduce((a, b) => a + b, 0)
                  const height = total > 0 ? Math.max(10, (count / total) * 100) : 10
                  
                  return (
                    <div key={score} className="flex flex-col items-center flex-1">
                      <span className="text-xs text-muted-foreground mb-1">{count}</span>
                      <div 
                        className="w-full rounded-t bg-yellow-400"
                        style={{ height: `${height}%` }}
                      />
                      <div className="flex items-center gap-0.5 mt-2">
                        {Array.from({ length: score }).map((_, i) => (
                          <Star key={i} className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <Star className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2">No quality scores available</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost by Agent */}
      <Card>
        <CardHeader>
          <CardTitle>Cost by Agent</CardTitle>
        </CardHeader>
        <CardContent>
          {costAnalytics?.byAgent && costAnalytics.byAgent.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm font-medium text-muted-foreground">
                    <th className="pb-3">Agent</th>
                    <th className="pb-3 text-right">Calls</th>
                    <th className="pb-3 text-right">Duration</th>
                    <th className="pb-3 text-right">Total Cost</th>
                    <th className="pb-3 text-right">Avg Cost/Call</th>
                    <th className="pb-3 text-right">Quality</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {costAnalytics.byAgent.map((agent) => {
                    const qualityData = qualityAnalytics?.byAgent.find(a => a.agentId === agent.agentId)
                    
                    return (
                      <tr key={agent.agentId || 'unknown'} className="text-sm">
                        <td className="py-3">
                          <div>
                            <p className="font-medium text-foreground">{agent.agentName}</p>
                            <p className="text-xs text-muted-foreground">{agent.agentSlug}</p>
                          </div>
                        </td>
                        <td className="py-3 text-right">{agent.callCount}</td>
                        <td className="py-3 text-right">{agent.totalDurationMinutes} min</td>
                        <td className="py-3 text-right font-medium text-green-600">
                          {formatCurrency(agent.totalCents)}
                        </td>
                        <td className="py-3 text-right">
                          {formatCurrency(agent.avgCostPerCallCents)}
                        </td>
                        <td className="py-3 text-right">
                          {qualityData?.avgScore ? (
                            <div className="flex items-center justify-end gap-1">
                              <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                              <span>{qualityData.avgScore}/5</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <DollarSign className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2">No cost data available for this period</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily Trend */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Cost Trend</CardTitle>
        </CardHeader>
        <CardContent>
          {costAnalytics?.daily && costAnalytics.daily.length > 0 ? (
            <div className="space-y-2">
              {(() => {
                const dailyData = costAnalytics.daily.slice(-14)
                const maxCost = Math.max(...dailyData.map(d => d.totalCents), 1)
                
                return dailyData.map((day) => {
                  const percentage = maxCost > 0 ? (day.totalCents / maxCost) * 100 : 0
                  const twilioWidth = day.totalCents > 0 ? ((day.twilioCents || 0) / day.totalCents) * 100 : 0
                  const openaiWidth = day.totalCents > 0 ? ((day.openaiCents || 0) / day.totalCents) * 100 : 0
                  
                  return (
                    <div key={day.date} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-muted-foreground">
                        {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                      <div className="flex-1">
                        <div className="h-6 w-full rounded bg-muted">
                          <div 
                            className="flex h-6 items-center rounded"
                            style={{ width: `${Math.max(percentage, 2)}%` }}
                          >
                            {twilioWidth > 0 && (
                              <div 
                                className="h-full rounded-l bg-primary/100"
                                style={{ width: `${twilioWidth}%` }}
                              />
                            )}
                            {openaiWidth > 0 && (
                              <div 
                                className={`h-full bg-purple-500 ${twilioWidth === 0 ? 'rounded-l' : ''} rounded-r`}
                                style={{ width: `${openaiWidth}%` }}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex w-36 items-center justify-end gap-2 text-xs">
                        <span className="font-medium">{formatCurrency(day.totalCents)}</span>
                        <span className="text-muted-foreground">({day.callCount} calls)</span>
                      </div>
                    </div>
                  )
                })
              })()}
              <div className="mt-3 flex justify-center gap-4 text-xs">
                <div className="flex items-center gap-1">
                  <div className="h-3 w-3 rounded bg-primary/100" />
                  <span>Twilio</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="h-3 w-3 rounded bg-purple-500" />
                  <span>OpenAI</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2">No daily data available</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
