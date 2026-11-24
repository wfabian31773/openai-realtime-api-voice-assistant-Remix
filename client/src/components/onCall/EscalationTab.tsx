import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { apiError } from '@/lib/onCallView'
import { Banner, ProviderSelect, ReasonDialog, useOnCall, useOnCallWrite, type PublicProvider } from './shared'
import { Info } from 'lucide-react'

interface EscalationResponse {
  directors: Array<{ region: string; providerId: number; updatedAt: string | null; isFinal: boolean; provider: PublicProvider | null }>
  providerRegions: string[]
  environment: { label: string; values: Record<string, string> }
  cadence: { label: string; values: Record<string, string> }
  openDecisions: string[]
}

function KeyValues({ values }: { values: Record<string, string> }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      {Object.entries(values).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function EscalationTab() {
  const q = useOnCall<EscalationResponse>('/escalation')
  const sched = useOnCall<{ providers: PublicProvider[] }>('/schedule')
  const write = useOnCallWrite()
  const [set, setSet] = React.useState<{ region: string; isNew: boolean } | null>(null)
  const [setTo, setSetTo] = React.useState<number | ''>('')
  const [newRegion, setNewRegion] = React.useState('')
  const [remove, setRemove] = React.useState<string | null>(null)

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (q.error) return <Banner tone="error">{apiError(q.error)}</Banner>
  if (!q.data?.directors) return null
  const d = q.data
  const providers = sched.data?.providers ?? []
  const directed = new Set(d.directors.map((x) => x.region.toLowerCase()))
  const orphans = d.providerRegions.filter((r) => !directed.has(r.toLowerCase()))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            Region → director <Badge variant="success">wired: the runtime reads this</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            After the on-call provider (or surgeon), the chain rings that provider's region director, then the FINAL director. A region whose
            director IS the final director goes straight to FINAL. After FINAL, the operations fallback (Wayne) is called when
            ON_CALL_FINAL_FALLBACK_NUMBER is set: {d.environment.values.ON_CALL_FINAL_FALLBACK_NUMBER ?? 'not configured'}.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Region</TableHead>
                <TableHead>Director</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.directors.map((r) => (
                <TableRow key={r.region} className={r.isFinal ? 'bg-primary/5' : ''}>
                  <TableCell className="font-medium">
                    {r.region} {r.isFinal && <Badge variant="info">last level of every chain</Badge>}
                  </TableCell>
                  <TableCell className={r.provider?.active === false ? 'text-destructive' : ''}>
                    {r.provider?.fullName ?? `#${r.providerId} (not on file)`}
                    {r.provider?.active === false && ' (inactive: skipped)'}
                  </TableCell>
                  <TableCell>{r.provider?.phoneLast4 ?? 'none'}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button size="sm" variant="outline" onClick={() => { setSet({ region: r.region, isNew: false }); setSetTo('') }}>
                      Change
                    </Button>{' '}
                    {!r.isFinal && (
                      <Button size="sm" variant="ghost" onClick={() => setRemove(r.region)}>
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-end gap-2 p-4">
            <div>
              <Label>New region</Label>
              <Input value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="e.g. Orange County" />
            </div>
            <Button variant="outline" disabled={!newRegion.trim()} onClick={() => { setSet({ region: newRegion.trim(), isNew: true }); setSetTo('') }}>
              Add region…
            </Button>
          </div>
        </CardContent>
      </Card>

      {orphans.length > 0 && (
        <Banner tone="warn">
          Providers work in region(s) with no director: {orphans.join(', ')}. Their chains go straight to the final director.
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Environment (read-only)</CardTitle>
            <p className="text-xs text-muted-foreground">{d.environment.label}</p>
          </CardHeader>
          <CardContent>
            <KeyValues values={d.environment.values} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cadence and timeouts (read-only)</CardTitle>
            <p className="text-xs text-muted-foreground">{d.cadence.label}</p>
          </CardHeader>
          <CardContent>
            <KeyValues values={d.cadence.values} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="h-4 w-4" /> Open decisions (docs/ON_CALL_ROTATION.md §8)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {d.openDecisions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <ReasonDialog
        open={set !== null}
        onOpenChange={(o) => !o && setSet(null)}
        title={set?.isNew ? `Add region "${set.region}"` : `Director for ${set?.region}`}
        description={set?.isNew ? 'A new region and its director. Providers can then be put in it.' : undefined}
        confirmLabel="Save director"
        onConfirm={(reason) => write.mutateAsync({ method: 'put', path: '/directors', body: { region: set!.region, providerId: setTo, newRegion: set!.isNew, reason } })}
      >
        <Label>Director</Label>
        <ProviderSelect providers={providers} value={setTo} onChange={setSetTo} />
      </ReasonDialog>

      <ReasonDialog
        open={remove !== null}
        onOpenChange={(o) => !o && setRemove(null)}
        title={`Remove region ${remove}`}
        description="Only a region no provider works in can be removed."
        destructive
        confirmLabel="Remove"
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: '/directors/delete', body: { region: remove, reason } })}
      />
    </div>
  )
}
