import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import apiClient from '@/lib/apiClient'
import { apiError, fmtPacific, fmtWeek, ROLE_LABELS, toPacificInput, WINDOW_LABELS } from '@/lib/onCallView'
import { Banner, useOnCall, type PublicProvider } from './shared'
import { AlertTriangle, ArrowDown } from 'lucide-react'

export interface Answer {
  at: string
  window: { onCall: boolean; reason: string }
  weekStartsOn: string
  source: 'override' | 'schedule' | 'none'
  note: string | null
  provider: PublicProvider | null
  override: { id: number; startsAt: string; endsAt: string } | null
  director: PublicProvider | null
  final: PublicProvider | null
  chain: {
    levels: Array<{ index: number; role: string; providerId: number; name: string; region: string | null; phoneLast4: string | null; dialable: boolean }>
    notes: string[]
  }
}

const NOTE_TEXT: Record<string, string> = {
  no_schedule_for_week: 'No provider is scheduled for this week: only the final director is rung.',
  provider_inactive: "The week's provider is inactive: only the directors are rung.",
  provider_missing: "The week's provider is not on file.",
  override_provider_inactive: "An override covers this moment but its provider is inactive; the week's provider is used.",
  override_provider_missing: "An override covers this moment but its provider is not on file; the week's provider is used.",
  no_director_for_region: 'This region has no director: the chain skips straight to the final director.',
  region_director_inactive: "The region's director is inactive and is skipped.",
  no_final_director: 'No FINAL director is set.',
  final_director_inactive: 'The FINAL director is inactive.',
  no_first_level: 'Nobody to ring first.',
}

export function AnswerCard({ title, answer, highlight }: { title: string; answer: Answer; highlight?: boolean }) {
  const warn = [answer.note, ...answer.chain.notes].filter(Boolean) as string[]
  return (
    <Card className={highlight ? 'border-primary' : ''}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {title}
          <Badge variant={answer.window.onCall ? 'info' : 'secondary'}>{WINDOW_LABELS[answer.window.reason] ?? answer.window.reason}</Badge>
          {answer.source === 'override' && <Badge variant="warning">override</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {fmtPacific(answer.at)} · rotation week of {fmtWeek(answer.weekStartsOn)}
          {answer.override && <> · override until {fmtPacific(answer.override.endsAt)}</>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-2xl font-semibold">{answer.provider?.fullName ?? 'Nobody scheduled'}</div>
        {answer.provider && (
          <div className="text-sm text-muted-foreground">
            {answer.provider.region} · phone {answer.provider.phoneLast4 ?? 'none on file'}
          </div>
        )}
        {warn.map((n) => (
          <Banner key={n} tone="warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {NOTE_TEXT[n] ?? n}
          </Banner>
        ))}
        <div>
          <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Escalation chain a non-post-op urgent call would ring</div>
          <ol className="space-y-1">
            {answer.chain.levels.map((l, i) => (
              <li key={l.index}>
                {i > 0 && <ArrowDown className="mx-2 h-3 w-3 text-muted-foreground" />}
                <div className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-sm">
                  <Badge variant="outline">{i + 1}</Badge>
                  <span className="font-medium">{l.name}</span>
                  <span className="text-muted-foreground">{ROLE_LABELS[l.role] ?? l.role}</span>
                  {l.region && <span className="text-muted-foreground">· {l.region}</span>}
                  <span className="text-muted-foreground">· {l.phoneLast4 ?? 'no phone'}</span>
                  {!l.dialable && <Badge variant="destructive">not dialable: skipped</Badge>}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-xs text-muted-foreground">
            Each level: details text, then a call; a second call and a reminder text if not taken. A post-op patient (surgery 0–7
            days ago) goes to their surgeon first instead.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export function OverviewTab() {
  const q = useOnCall<{ now: Answer; nextWindow: Answer | null; nextWeek: Answer }>('/now', { refetchInterval: 60_000 })
  const [at, setAt] = React.useState(() => toPacificInput(new Date()))
  const [preview, setPreview] = React.useState<Answer | null>(null)
  const [previewError, setPreviewError] = React.useState<string | null>(null)

  const runPreview = async () => {
    setPreviewError(null)
    try {
      const { data } = await apiClient.get('/on-call/preview', { params: { at } })
      setPreview(data.preview)
    } catch (e) {
      setPreview(null)
      setPreviewError(apiError(e))
    }
  }

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (q.error) return <Banner tone="error">{apiError(q.error)}</Banner>
  if (!q.data?.now) return null
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <AnswerCard title="On call right now" answer={q.data.now} highlight />
        {q.data.nextWindow ? (
          <AnswerCard title="Tonight (when the on-call window opens)" answer={q.data.nextWindow} />
        ) : (
          <AnswerCard title="Next rotation week" answer={q.data.nextWeek} />
        )}
      </div>
      {q.data.nextWindow && <AnswerCard title="Next rotation week" answer={q.data.nextWeek} />}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Who would be called at…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="preview-at">Date and time (Pacific)</Label>
              <Input id="preview-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </div>
            <Button onClick={runPreview}>Show</Button>
          </div>
          {previewError && <Banner tone="error">{previewError}</Banner>}
          {preview && <AnswerCard title="Preview" answer={preview} />}
        </CardContent>
      </Card>
    </div>
  )
}
