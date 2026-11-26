import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import apiClient from '@/lib/apiClient'
import {
  failingSinceText,
  headline,
  orderResults,
  STATUS_CLASS,
  STATUS_TEXT,
  valueText,
  type AccuracyResponse,
} from '@/lib/accuracyView'

const TONE_CLASS = {
  good: 'border-green-500/50 bg-green-500/5',
  bad: 'border-red-500/60 bg-red-500/10',
  unsure: 'border-amber-500/60 bg-amber-500/10',
} as const

/**
 * The Observatory's Accuracy tab: each number a screen shows, read again
 * straight from the call records, and whether the two agree. The server runs
 * the checks hourly and keeps 90 days of results (server/accuracy/).
 */
export function AccuracyTab() {
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const q = useQuery<AccuracyResponse>({
    queryKey: ['obs-accuracy'],
    queryFn: async () => (await apiClient.get('/observatory/accuracy')).data,
    refetchInterval: 5 * 60_000,
  })

  async function runNow() {
    setRefreshing(true)
    try {
      const fresh = (await apiClient.get('/observatory/accuracy', { params: { refresh: 1 } })).data
      queryClient.setQueryData(['obs-accuracy'], fresh)
    } finally {
      setRefreshing(false)
    }
  }

  const r = q.data
  const head = r ? headline(r) : null

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each row reads one number the way its screen reads it, then reads the same number straight from the call
          records, and says whether they agree. It runs every hour on its own. &ldquo;Could not check&rdquo; means the
          true number could not be read, which is not the same as the screen being right.
        </p>
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          onClick={runNow}
          disabled={refreshing}
        >
          {refreshing ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {q.isLoading && <p className="text-sm text-muted-foreground">Running the checks…</p>}
      {q.isError && (
        <p className="text-sm text-red-600">
          The accuracy checks could not be run: {(q.error as any)?.response?.data?.error ?? String(q.error)}
        </p>
      )}

      {r && head && (
        <>
          <div className={`rounded-lg border p-3 text-sm ${TONE_CLASS[head.tone]}`}>
            <p className="font-medium">{head.text}</p>
            <p className="text-xs text-muted-foreground">
              Checked{' '}
              {new Date(r.ranAt).toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}{' '}
              PT in {(r.durationMs / 1000).toFixed(1)} s.
              {!r.historyAvailable && ' The history could not be read, so "failing since" is from this run only.'}
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Screen</th>
                  <th className="px-3 py-2">Number</th>
                  <th className="px-3 py-2 text-right">On screen</th>
                  <th className="px-3 py-2 text-right">True value</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {orderResults(r.results).map((c) => (
                  <tr key={c.id} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{c.screen}</td>
                    <td className="px-3 py-2">
                      <p>{c.widget}</p>
                      <p className="text-xs text-muted-foreground">{c.note}</p>
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">How the true value is read</summary>
                        <p className="mt-1">{c.claim}</p>
                        <p className="mt-1">{c.truthSource}</p>
                      </details>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{valueText(c.screenValue, c.unit)}</td>
                    <td className="px-3 py-2 text-right font-mono">{valueText(c.truthValue, c.unit)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[c.status]}`}>
                        {STATUS_TEXT[c.status]}
                      </span>
                      {failingSinceText(c.failingSince) && (
                        <p className="mt-1 text-xs text-muted-foreground">{failingSinceText(c.failingSince)}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
