import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { apiError, fmtWeek } from '@/lib/onCallView'
import { Banner, ReasonDialog, useOnCall, useOnCallWrite } from './shared'
import { ArrowDown, ArrowUp, ListOrdered, UserPlus } from 'lucide-react'

interface Provider {
  id: number
  fullName: string
  npi: string | null
  phone: string
  email: string | null
  region: string
  rotationOrder: number | null
  active: boolean
  upcomingWeeks: string[]
  upcomingOverrides: number
  directsRegions: string[]
  phoneDialable: boolean
}

interface Form {
  fullName: string
  phone: string
  email: string
  npi: string
  region: string
  newRegion: boolean
  inRotation: boolean
}

const EMPTY: Form = { fullName: '', phone: '', email: '', npi: '', region: '', newRegion: false, inRotation: true }

export function ProvidersTab() {
  const q = useOnCall<{ providers: Provider[]; regions: string[] }>('/providers')
  const write = useOnCallWrite()
  const [edit, setEdit] = React.useState<{ id: number | null; form: Form } | null>(null)
  const [toggle, setToggle] = React.useState<Provider | null>(null)
  const [del, setDel] = React.useState<Provider | null>(null)
  const [order, setOrder] = React.useState<number[] | null>(null)
  const [orderOpen, setOrderOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')

  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (q.error) return <Banner tone="error">{apiError(q.error)}</Banner>
  if (!q.data?.providers) return null
  const providers = q.data.providers
  const byId = new Map(providers.map((p) => [p.id, p]))
  const rotation = providers.filter((p) => p.rotationOrder !== null).sort((a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0))
  const shown = providers.filter((p) => `${p.fullName} ${p.region} ${p.npi ?? ''}`.toLowerCase().includes(filter.toLowerCase()))

  const openEdit = (p: Provider | null) =>
    setEdit({
      id: p?.id ?? null,
      form: p
        ? { fullName: p.fullName, phone: p.phone, email: p.email ?? '', npi: p.npi ?? '', region: p.region, newRegion: false, inRotation: p.rotationOrder !== null }
        : EMPTY,
    })
  const setF = (patch: Partial<Form>) => setEdit((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e))
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      if (!o) return o
      const n = [...o]
      const j = i + d
      if (j < 0 || j >= n.length) return o
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label>Search</Label>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="name, region, NPI" />
        </div>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => setOrder(rotation.map((p) => p.id))} disabled={order !== null}>
          <ListOrdered className="mr-1 h-4 w-4" /> Reorder rotation
        </Button>
        <Button onClick={() => openEdit(null)}>
          <UserPlus className="mr-1 h-4 w-4" /> Add provider
        </Button>
      </div>

      {order && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm text-muted-foreground">
              Rotation order decides who `Extend schedule` gives the next weeks to. Weeks already scheduled do not change.
            </p>
            <ol className="max-h-96 space-y-1 overflow-y-auto">
              {order.map((id, i) => (
                <li key={id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
                  <Badge variant="outline">{i + 1}</Badge>
                  <span className="flex-1">
                    {byId.get(id)?.fullName}
                    {!byId.get(id)?.active && <span className="text-muted-foreground"> (inactive, skipped)</span>}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === order.length - 1}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex gap-2">
              <Button onClick={() => setOrderOpen(true)}>Save order…</Button>
              <Button variant="outline" onClick={() => setOrder(null)}>
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>NPI</TableHead>
                <TableHead>Upcoming</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => (
                <TableRow key={p.id} className={p.active ? '' : 'opacity-60'}>
                  <TableCell>{p.rotationOrder ?? <span className="text-xs text-muted-foreground">escalation only</span>}</TableCell>
                  <TableCell className="font-medium">
                    {p.fullName}
                    {p.directsRegions.map((r) => (
                      <Badge key={r} variant="info" className="ml-1">
                        director: {r}
                      </Badge>
                    ))}
                  </TableCell>
                  <TableCell>{p.region}</TableCell>
                  <TableCell className={p.phoneDialable ? 'font-mono text-sm' : 'font-mono text-sm text-destructive'}>{p.phone || 'none'}</TableCell>
                  <TableCell className="text-sm">{p.email}</TableCell>
                  <TableCell className="font-mono text-sm">{p.npi}</TableCell>
                  <TableCell className="text-xs" title={p.upcomingWeeks.map(fmtWeek).join(', ')}>
                    {p.upcomingWeeks.length} week(s)
                    {p.upcomingOverrides ? `, ${p.upcomingOverrides} override(s)` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.active ? 'success' : 'secondary'}>{p.active ? 'active' : 'inactive'}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                      Edit
                    </Button>{' '}
                    <Button size="sm" variant={p.active ? 'destructive' : 'outline'} onClick={() => setToggle(p)}>
                      {p.active ? 'Deactivate' : 'Reactivate'}
                    </Button>{' '}
                    <Button size="sm" variant="ghost" onClick={() => setDel(p)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ReasonDialog
        open={edit !== null}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.id ? `Edit ${byId.get(edit.id)?.fullName}` : 'Add a provider'}
        description={edit?.id ? undefined : 'A new provider joins at the END of the rotation; their first week is the first one Extend adds.'}
        confirmLabel={edit?.id ? 'Save changes' : 'Add provider'}
        onConfirm={(reason) => {
          const f = edit!.form
          const body = { fullName: f.fullName, phone: f.phone, email: f.email, npi: f.npi, region: f.region, newRegion: f.newRegion, inRotation: f.inRotation, reason }
          return edit!.id
            ? write.mutateAsync({ method: 'patch', path: `/providers/${edit!.id}`, body })
            : write.mutateAsync({ method: 'post', path: '/providers', body })
        }}
      >
        {edit && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Full name</Label>
              <Input value={edit.form.fullName} onChange={(e) => setF({ fullName: e.target.value })} />
            </div>
            <div>
              <Label>Phone (the chain rings and texts this)</Label>
              <Input value={edit.form.phone} onChange={(e) => setF({ phone: e.target.value })} />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={edit.form.email} onChange={(e) => setF({ email: e.target.value })} />
            </div>
            <div>
              <Label>NPI (10 digits; how a post-op surgeon is matched)</Label>
              <Input value={edit.form.npi} onChange={(e) => setF({ npi: e.target.value })} />
            </div>
            <div>
              <Label>Region</Label>
              <Input list="oncall-regions" value={edit.form.region} onChange={(e) => setF({ region: e.target.value })} />
              <datalist id="oncall-regions">
                {q.data!.regions.filter((r) => r !== 'FINAL').map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.form.newRegion} onChange={(e) => setF({ newRegion: e.target.checked })} />
              This is a new region (no director yet)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.form.inRotation} onChange={(e) => setF({ inRotation: e.target.checked })} />
              In the weekly rotation (untick for escalation only)
            </label>
          </div>
        )}
      </ReasonDialog>

      <ReasonDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.active ? `Deactivate ${toggle?.fullName}` : `Reactivate ${toggle?.fullName}`}
        description={
          toggle?.active
            ? `They are skipped by Extend and cannot be given a week or a cover. ${toggle.upcomingWeeks.length ? `They are still on ${toggle.upcomingWeeks.length} upcoming week(s), which ring only the directors until swapped.` : ''} ${toggle.directsRegions.length ? `They direct ${toggle.directsRegions.join(', ')}; that level is skipped until a new director is set.` : ''}`
            : 'They return at the rotation place they had.'
        }
        destructive={toggle?.active}
        confirmLabel={toggle?.active ? 'Deactivate' : 'Reactivate'}
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: `/providers/${toggle!.id}/active`, body: { active: !toggle!.active, reason } })}
      />

      <ReasonDialog
        open={del !== null}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete ${del?.fullName} permanently`}
        description="Only a provider never referenced anywhere (no week, cover, director row or past call) can be deleted. Otherwise deactivate them."
        destructive
        confirmLabel="Delete"
        onConfirm={(reason) => write.mutateAsync({ method: 'post', path: `/providers/${del!.id}/delete`, body: { reason } })}
      />

      <ReasonDialog
        open={orderOpen}
        onOpenChange={setOrderOpen}
        title="Save the new rotation order"
        confirmLabel="Save order"
        onConfirm={async (reason) => {
          await write.mutateAsync({ method: 'post', path: '/providers/reorder', body: { orderedIds: order, reason } })
          setOrder(null)
        }}
      />
    </div>
  )
}
