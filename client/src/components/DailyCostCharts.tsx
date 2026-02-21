import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

interface DailyData {
  date: string
  callCount: number
  totalCents: number
  twilioCents: number
  openaiCents: number
}

interface DailyCostChartsProps {
  dailyData: DailyData[]
  totalOpenAICents: number
  totalTwilioCents: number
  totalCents: number
  dateRangeLabel: string
}

const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`

const formatDate = (dateStr: string) => {
  const date = new Date(dateStr + 'T00:00:00')
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const value = payload[0].value
    const dateStr = payload[0].payload.date
    return (
      <div className="rounded-lg border border-border bg-background p-3 shadow-lg">
        <p className="text-sm font-medium text-foreground">{formatDate(dateStr)}</p>
        <p className="text-lg font-bold" style={{ color: payload[0].fill }}>
          {formatCurrency(value)}
        </p>
        {payload[0].payload.callCount !== undefined && (
          <p className="text-xs text-muted-foreground">
            {payload[0].payload.callCount} calls
          </p>
        )}
      </div>
    )
  }
  return null
}

export function DailyCostCharts({
  dailyData,
  totalOpenAICents,
  totalTwilioCents,
  totalCents,
  dateRangeLabel,
}: DailyCostChartsProps) {
  const chartData = useMemo(() => {
    return dailyData.slice(-14).map((day) => ({
      date: day.date,
      shortDate: formatDate(day.date),
      openai: day.openaiCents,
      twilio: day.twilioCents,
      total: day.totalCents,
      callCount: day.callCount,
    }))
  }, [dailyData])

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-transparent">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">OpenAI Spend</p>
                <p className="text-3xl font-bold text-violet-600 dark:text-violet-400">
                  {formatCurrency(totalOpenAICents)}
                </p>
              </div>
              <div className="rounded-full bg-violet-500/10 p-2">
                <svg className="h-5 w-5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{dateRangeLabel}</p>
          </CardHeader>
          <CardContent>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <XAxis
                    dataKey="shortDate"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip costType="OpenAI" />} />
                  <Bar dataKey="openai" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.date === today ? '#a78bfa' : '#8b5cf6'}
                        opacity={entry.date === today ? 0.7 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center justify-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-violet-500" />
                <span>Reconciled</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 rounded-full bg-violet-400 opacity-70" />
                <span>Today (est.)</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Twilio Spend</p>
                <p className="text-3xl font-bold text-primary">
                  {formatCurrency(totalTwilioCents)}
                </p>
              </div>
              <div className="rounded-full bg-primary/10 p-2">
                <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{dateRangeLabel}</p>
          </CardHeader>
          <CardContent>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <XAxis
                    dataKey="shortDate"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip costType="Twilio" />} />
                  <Bar dataKey="twilio" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.date === today ? 'hsl(var(--primary) / 0.7)' : 'hsl(var(--primary))'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-green-500/20 bg-gradient-to-br from-green-500/5 to-transparent">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Spend</p>
                <p className="text-3xl font-bold text-green-600 dark:text-green-400">
                  {formatCurrency(totalCents)}
                </p>
              </div>
              <div className="rounded-full bg-green-500/10 p-2">
                <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{dateRangeLabel}</p>
          </CardHeader>
          <CardContent>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <XAxis
                    dataKey="shortDate"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip costType="Total" />} />
                  <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.date === today ? '#4ade80' : '#22c55e'}
                        opacity={entry.date === today ? 0.7 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="text-violet-500">OpenAI: {Math.round((totalOpenAICents / (totalCents || 1)) * 100)}%</span>
                <span className="text-primary">Twilio: {Math.round((totalTwilioCents / (totalCents || 1)) * 100)}%</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
