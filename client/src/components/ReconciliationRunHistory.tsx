import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle, XCircle, Clock, History, AlertTriangle } from 'lucide-react'

interface ReconciliationRun {
  id: string
  runAt: string
  triggeredBy: string
  dateReconciled: string
  success: boolean
  errorMessage: string | null
  durationMs: number | null
  createdAt: string
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatRunAt(runAt: string): string {
  const d = new Date(runAt)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function triggerLabel(triggeredBy: string): string {
  if (triggeredBy === 'auto') return 'Nightly'
  if (triggeredBy === 'backfill') return 'Backfill'
  return triggeredBy
}

export function ReconciliationRunHistory() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['reconciliation-runs'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ runs: ReconciliationRun[] }>(
        '/analytics/reconciliation-runs?limit=20'
      )
      return data
    },
    refetchInterval: 60_000,
  })

  const runs = data?.runs ?? []

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          Reconciliation Run History
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Audit log of recent automatic and manual reconciliation runs
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : isError ? (
          <div className="py-6 text-center text-muted-foreground">
            <AlertTriangle className="mx-auto h-8 w-8 mb-2 text-orange-500" />
            <p className="text-sm text-orange-600 dark:text-orange-400 font-medium">Failed to load run history</p>
            <p className="text-xs mt-1">Check your connection or permissions and try refreshing.</p>
          </div>
        ) : runs.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground">
            <History className="mx-auto h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No reconciliation runs recorded yet.</p>
            <p className="text-xs mt-1">Runs will appear here after the nightly job executes.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Run Time</th>
                  <th className="pb-2 pr-4 font-medium">Date Reconciled</th>
                  <th className="pb-2 pr-4 font-medium">Triggered By</th>
                  <th className="pb-2 pr-4 font-medium">Duration</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-muted/40">
                    <td className="py-2 pr-4 text-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        {formatRunAt(run.runAt)}
                      </div>
                    </td>
                    <td className="py-2 pr-4 font-mono text-foreground">
                      {run.dateReconciled}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        run.triggeredBy === 'auto'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                          : run.triggeredBy === 'backfill'
                          ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                          : 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300'
                      }`}>
                        {triggerLabel(run.triggeredBy)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatDuration(run.durationMs)}
                    </td>
                    <td className="py-2">
                      {run.success ? (
                        <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                          <CheckCircle className="h-4 w-4 flex-shrink-0" />
                          <span className="text-xs font-medium">Success</span>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
                            <XCircle className="h-4 w-4 flex-shrink-0" />
                            <span className="text-xs font-medium">Failed</span>
                          </div>
                          {run.errorMessage && (
                            <span className="text-xs text-muted-foreground max-w-xs truncate" title={run.errorMessage}>
                              {run.errorMessage}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
