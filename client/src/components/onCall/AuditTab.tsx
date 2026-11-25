import React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { apiError, fmtPacific, pacificMidnightIso, pacificNextMidnightIso } from '@/lib/onCallView'
import { Banner, useOnCall } from './shared'

interface AuditRow {
  id: number
  actorUserId: string | null
  actorEmail: string | null
  action: string
  entityType: string
  entityId: string | null
  before: unknown
  after: unknown
  reason: string
  createdAt: string
}

export function AuditTab() {
  const [f, setF] = React.useState({ entityType: '', action: '', actor: '', since: '', until: '' })
  const qs = new URLSearchParams(
    // The table shows Pacific time, so the dates are Pacific days: from the
    // From day's midnight PT to the midnight PT after the To day (exclusive).
    Object.entries({ ...f, since: pacificMidnightIso(f.since) ?? '', until: pacificNextMidnightIso(f.until) ?? '' }).filter(
      ([, v]) => v,
    ) as [string, string][],
  ).toString()
  const q = useOnCall<{ applied: boolean; message?: string; rows: AuditRow[] }>(`/audit${qs ? `?${qs}` : ''}`)
  const [open, setOpen] = React.useState<number | null>(null)

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Every change made on this page, with who made it and why, written in the same transaction as the change. Changes made with
        scripts/on-call-change.ts are logged here too from 2026-11-24, their actor marked "(scripts/on-call-change.ts)".
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label>Type</Label>
          <Select value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })}>
            <option value="">All</option>
            <option value="schedule">Schedule</option>
            <option value="override">Override</option>
            <option value="provider">Provider</option>
            <option value="director">Director</option>
          </Select>
        </div>
        <div>
          <Label>Action</Label>
          <Input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="e.g. schedule.swap_week" />
        </div>
        <div>
          <Label>Who</Label>
          <Input value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} placeholder="email" />
        </div>
        <div>
          <Label>From</Label>
          <Input type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} />
        </div>
        <div>
          <Label>To</Label>
          <Input type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />
        </div>
      </div>
      {q.error && <Banner tone="error">{apiError(q.error)}</Banner>}
      {q.data && !q.data.applied && <Banner tone="warn">{q.data.message}</Banner>}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When (PT)</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.rows ?? []).map((r) => (
                <React.Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell className="whitespace-nowrap text-sm">{fmtPacific(r.createdAt)}</TableCell>
                    <TableCell className="text-sm">{r.actorEmail ?? r.actorUserId ?? 'unknown'}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.action}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.entityType} {r.entityId}
                    </TableCell>
                    <TableCell className="text-sm">{r.reason}</TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <div className="grid gap-2 md:grid-cols-2">
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">Before</div>
                            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(r.before, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">After</div>
                            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(r.after, null, 2)}</pre>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
              {q.data?.applied && q.data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No changes match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
