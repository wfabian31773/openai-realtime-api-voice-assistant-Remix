import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { apiError } from '@/lib/onCallView'
import { useToast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle } from 'lucide-react'

export const ON_CALL_KEY = 'on-call'

/** A GET under /api/on-call; a 409 "tables not applied" comes back as data, not an error. */
export function useOnCall<T>(path: string, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<T & { error?: string; message?: string }>({
    queryKey: [ON_CALL_KEY, path],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get(`/on-call${path}`)
        return data
      } catch (e: any) {
        if (e?.response?.status === 409 && e.response.data) return e.response.data
        throw e
      }
    },
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
  })
}

export type WriteMethod = 'post' | 'put' | 'patch'

/** A change under /api/on-call. Refreshes every on-call view on success. */
export function useOnCallWrite() {
  const qc = useQueryClient()
  const { addToast } = useToast()
  return useMutation({
    mutationFn: async (v: { method: WriteMethod; path: string; body: Record<string, unknown> }) => {
      const { data } = await apiClient[v.method](`/on-call${v.path}`, v.body)
      return data
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: [ON_CALL_KEY] })
      addToast({ title: 'Saved', description: 'The change and its audit row were written.', variant: 'success' })
      for (const w of (data?.warnings as string[] | undefined) ?? []) addToast({ title: 'Check this', description: w, variant: 'destructive' })
    },
  })
}

/**
 * Every change asks for a reason (the audit log requires one) and shows the
 * server's refusal in place. `children` holds the change's own fields.
 */
export function ReasonDialog(props: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  destructive?: boolean
  children?: React.ReactNode
  /** Throw to show the error; resolve to close. */
  onConfirm: (reason: string) => Promise<unknown>
}) {
  const [reason, setReason] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (props.open) {
      setReason('')
      setError(null)
    }
  }, [props.open])
  const submit = async () => {
    if (!reason.trim()) return setError('A reason is required.')
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm(reason.trim())
      props.onOpenChange(false)
    } catch (e) {
      setError(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent onClose={() => props.onOpenChange(false)} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          {props.children}
          <div>
            <Label htmlFor="oncall-reason">Reason (required, saved in the audit log)</Label>
            <Textarea id="oncall-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={props.destructive ? 'destructive' : 'default'} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : props.confirmLabel ?? 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface PublicProvider {
  id: number
  fullName: string
  region: string
  active: boolean
  phoneLast4: string | null
  rotationOrder: number | null
}

export function ProviderSelect(props: {
  providers: PublicProvider[]
  value: number | ''
  onChange: (id: number | '') => void
  id?: string
}) {
  const sorted = [...props.providers].sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName))
  return (
    <Select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value ? Number(e.target.value) : '')}>
      <option value="">Choose a provider…</option>
      {sorted.map((p) => (
        <option key={p.id} value={p.id} disabled={!p.active}>
          {p.fullName} — {p.region}
          {!p.active ? ' (inactive)' : ''}
          {!p.phoneLast4 ? ' (no phone)' : ''}
        </option>
      ))}
    </Select>
  )
}

export function Banner({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'warn'
        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-800 dark:text-yellow-200'
        : 'border-blue-500/40 bg-blue-500/10 text-blue-800 dark:text-blue-200'
  return <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${cls}`}>{children}</div>
}
