import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/components/ui/toast'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface OperatorLineSetting {
  enabled: boolean
  environmentEnabled: boolean
  effectiveEnabled: boolean
}

export function OperatorLineToggle() {
  const { user } = useAuth()
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const { data, isError, isLoading } = useQuery({
    queryKey: ['operator-line-setting'],
    queryFn: async () => (await apiClient.get<OperatorLineSetting>('/settings/operator-line')).data,
  })
  const update = useMutation({
    mutationFn: async (enabled: boolean) => (await apiClient.put<OperatorLineSetting>('/settings/operator-line', { enabled })).data,
    onSuccess: (setting) => queryClient.setQueryData(['operator-line-setting'], setting),
    onError: () => addToast({ title: 'Operator line setting could not be saved', variant: 'destructive' }),
  })
  return <Card>
    <CardHeader><CardTitle>Grok Bot operator line</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p>{isLoading ? 'Loading operator line status…' : isError ? 'Operator line status is unavailable.' : data?.effectiveEnabled ? 'Operator line is on.' : 'Operator line is off.'}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" role="switch" checked={data?.enabled ?? false}
          disabled={!data || update.isPending || user?.role !== 'admin'}
          onChange={(event) => update.mutate(event.target.checked)} />
        Allow operator calls and inbound messages
      </label>
      {data && !data.environmentEnabled && <p className="text-sm text-muted-foreground">The deployment setting has disabled the operator line. Enabling this switch will take effect when that setting is enabled.</p>}
      {user?.role !== 'admin' && <p className="text-sm text-muted-foreground">An administrator can change this setting.</p>}
    </CardContent>
  </Card>
}
