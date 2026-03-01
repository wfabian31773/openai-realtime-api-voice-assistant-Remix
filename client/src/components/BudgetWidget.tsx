import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Shield, AlertTriangle, XCircle } from 'lucide-react'

interface BudgetStatus {
  todaySpendCents: number
  dailyBudgetCents: number
  percentUsed: number
  isOverBudget: boolean
  isWarning: boolean
  remainingCents: number
  spendRateCentsPerHour: number
  projectedDailyCents: number
  hoursElapsedToday: number
}

export function BudgetWidget() {
  const { data: budget, isLoading } = useQuery({
    queryKey: ['budget-status'],
    queryFn: async () => {
      const { data } = await apiClient.get<BudgetStatus>('/analytics/budget-status')
      return data
    },
    refetchInterval: 60_000, // refresh every minute
  })

  if (isLoading || !budget) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Daily Budget</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-4">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const spendDollars = budget.todaySpendCents / 100
  const budgetDollars = budget.dailyBudgetCents / 100
  const remainingDollars = budget.remainingCents / 100
  const projectedDollars = budget.projectedDailyCents / 100
  const ratePerHour = budget.spendRateCentsPerHour / 100
  const percentCapped = Math.min(budget.percentUsed * 100, 100)

  const barColor = budget.isOverBudget
    ? 'bg-red-500'
    : budget.isWarning
      ? 'bg-yellow-500'
      : 'bg-emerald-500'

  const StatusIcon = budget.isOverBudget
    ? XCircle
    : budget.isWarning
      ? AlertTriangle
      : Shield

  const iconColor = budget.isOverBudget
    ? 'text-red-500'
    : budget.isWarning
      ? 'text-yellow-500'
      : 'text-emerald-500'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Daily Budget</CardTitle>
        <StatusIcon className={`h-5 w-5 ${iconColor}`} />
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Spend vs Budget */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-2xl font-bold text-foreground">${spendDollars.toFixed(2)}</span>
            <span className="text-sm text-muted-foreground">/ ${budgetDollars.toFixed(2)}</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-muted">
            <div
              className={`h-2.5 rounded-full transition-all ${barColor}`}
              style={{ width: `${percentCapped}%` }}
            />
          </div>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <p className="text-xs text-muted-foreground">Remaining</p>
            <p className={`text-sm font-medium ${budget.isOverBudget ? 'text-red-500' : 'text-foreground'}`}>
              {budget.isOverBudget ? '-' : ''}${remainingDollars.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Spend Rate</p>
            <p className="text-sm font-medium text-foreground">
              ${ratePerHour.toFixed(2)}/hr
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Projected Daily Total</p>
            <p className={`text-sm font-medium ${projectedDollars > budgetDollars ? 'text-red-500' : 'text-emerald-500'}`}>
              ${projectedDollars.toFixed(2)}
              {projectedDollars > budgetDollars && (
                <span className="text-xs ml-1">(over budget)</span>
              )}
            </p>
          </div>
        </div>

        {/* Status text */}
        {budget.isOverBudget && (
          <p className="text-xs text-red-500 font-medium">
            Outbound calls paused until tomorrow
          </p>
        )}
        {budget.isWarning && !budget.isOverBudget && (
          <p className="text-xs text-yellow-600 font-medium">
            Approaching daily budget limit
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {budget.hoursElapsedToday}h elapsed today (Pacific)
        </p>
      </CardContent>
    </Card>
  )
}
