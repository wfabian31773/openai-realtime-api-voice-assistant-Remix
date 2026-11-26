import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { useToast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RefreshCw, Phone, Link2, Settings, Check, AlertCircle, Info } from 'lucide-react'
import type { Agent } from '@/types'
import { formatPhoneNumber } from '@/lib/phoneFormat'
import {
  OPERATOR_INBOUND_URL,
  RUNTIME_URL_SHAPE,
  WHERE_TO_REPOINT,
  runtimePathFor,
  servableLanes,
  type VoiceHealthLanes,
} from '@/lib/twilioEndpointReference'

interface PhoneEndpoint {
  id: string
  twilioSid: string
  phoneNumber: string
  friendlyName: string | null
  voiceWebhookUrl: string | null
  voiceWebhookMethod: string | null
  smsWebhookUrl: string | null
  statusCallbackUrl: string | null
  assignedAgentId: string | null
  assignedCampaignId: string | null
  environment: 'development' | 'production' | 'both'
  isActive: boolean
  lastSyncedAt: string | null
  syncStatus: string
  agentName?: string
  agentSlug?: string
}

export function TwilioPage() {
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const [showConfigureDialog, setShowConfigureDialog] = useState(false)
  const [selectedEndpoint, setSelectedEndpoint] = useState<PhoneEndpoint | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState('')

  const { data: endpoints, isLoading } = useQuery({
    queryKey: ['phone-endpoints'],
    queryFn: async () => {
      const { data } = await apiClient.get<PhoneEndpoint[]>('/phone-endpoints')
      return data
    },
  })

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const { data } = await apiClient.get<Agent[]>('/agents')
      return data
    },
  })

  // The lanes this build can answer, for the reference card. Same request the
  // Operations Monitor makes; /voice/health is served on this origin.
  const health = useQuery<VoiceHealthLanes>({
    queryKey: ['voice-health'],
    queryFn: async () => {
      const res = await fetch('/voice/health', { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    retry: false,
  })
  const lanes = servableLanes(health.data)

  const syncMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post('/phone-endpoints/sync')
      return data
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['phone-endpoints'] })
      addToast({
        title: 'Sync Complete',
        description: data.message || 'Phone numbers synced from Twilio',
        variant: 'success',
      })
    },
    onError: (error: any) => {
      addToast({
        title: 'Sync Failed',
        description: error?.response?.data?.message || 'Failed to sync phone numbers',
        variant: 'destructive',
      })
    },
  })

  const configureForAgentMutation = useMutation({
    mutationFn: async ({ endpointId, agentId, agentSlug }: { endpointId: string; agentId: string; agentSlug: string }) => {
      const { data } = await apiClient.post(`/phone-endpoints/${endpointId}/configure-for-agent`, {
        agentId,
        agentSlug,
      })
      return data
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['phone-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowConfigureDialog(false)
      addToast({
        title: 'Configuration Complete',
        description: data.message || 'Phone configured for agent',
        variant: 'success',
      })
    },
    onError: (error: any) => {
      // A 409 is the server refusing on purpose (src/services/phoneLineGuard.ts):
      // nothing was changed, and the message says what the number points at now.
      const refused = error?.response?.status === 409
      if (refused) setShowConfigureDialog(false)
      addToast({
        title: refused ? 'Not changed' : 'Check failed',
        description: error?.response?.data?.message || 'Could not check this number with Twilio',
        variant: 'destructive',
      })
    },
  })

  const openConfigureDialog = (endpoint: PhoneEndpoint) => {
    setSelectedEndpoint(endpoint)
    setSelectedAgentId(endpoint.assignedAgentId || '')
    setShowConfigureDialog(true)
  }

  const handleConfigureForAgent = () => {
    if (!selectedEndpoint || !selectedAgentId) return
    const agent = agents?.find(a => a.id === selectedAgentId)
    if (!agent) return
    
    configureForAgentMutation.mutate({
      endpointId: selectedEndpoint.id,
      agentId: selectedAgentId,
      agentSlug: agent.slug,
    })
  }

  const getSyncStatusBadge = (status: string) => {
    switch (status) {
      case 'synced':
        return <Badge variant="success" className="text-xs"><Check className="w-3 h-3 mr-1" />Synced</Badge>
      case 'pending':
        return <Badge variant="warning" className="text-xs">Pending</Badge>
      case 'error':
        return <Badge variant="destructive" className="text-xs"><AlertCircle className="w-3 h-3 mr-1" />Error</Badge>
      default:
        return <Badge variant="outline" className="text-xs">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Twilio Phone Management</h1>
          <p className="text-muted-foreground">
            Manage phone numbers, webhooks, and agent assignments
          </p>
        </div>
        <Button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
          {syncMutation.isPending ? 'Syncing...' : 'Sync from Twilio'}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !endpoints?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Phone className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Phone Numbers Found</h3>
            <p className="text-muted-foreground mb-4 text-center max-w-md">
              Click "Sync from Twilio" to import your phone numbers and their current configurations.
            </p>
            <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
              <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
              Sync from Twilio
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5" />
              Phone Endpoints ({endpoints.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Friendly Name</TableHead>
                  <TableHead>Assigned Agent</TableHead>
                  <TableHead>Webhook URL</TableHead>
                  <TableHead>Sync Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell className="font-mono">
                      {formatPhoneNumber(endpoint.phoneNumber)}
                    </TableCell>
                    <TableCell>
                      {endpoint.friendlyName || <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell>
                      {endpoint.agentName ? (
                        <Badge variant="outline">{endpoint.agentName}</Badge>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      {endpoint.voiceWebhookUrl ? (
                        <div className="flex items-center gap-1">
                          <Link2 className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          <span className="text-xs text-muted-foreground truncate">
                            {endpoint.voiceWebhookUrl}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Not configured</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {getSyncStatusBadge(endpoint.syncStatus)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openConfigureDialog(endpoint)}
                      >
                        <Settings className="mr-2 h-3 w-3" />
                        Configure
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Production Endpoint Reference: only what the running code serves.
          See client/src/lib/twilioEndpointReference.ts. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            Production Endpoint Reference
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A number's Voice URL in Twilio decides where its calls go. {WHERE_TO_REPOINT}
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="p-4 border rounded-lg">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                Voice runtime lane
              </h4>
              <div className="p-2 bg-muted rounded">
                <code className="text-xs break-all">{RUNTIME_URL_SHAPE}</code>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Use the published deployment's host (it ends in .replit.app), never a workspace
                (*.replit.dev) URL: a workspace answers too, but runs a different build.
              </p>
            </div>

            <div className="p-4 border rounded-lg">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Phone className="h-4 w-4" />
                Operator line
              </h4>
              <div className="p-2 bg-muted rounded">
                <code className="text-xs break-all">{OPERATOR_INBOUND_URL}</code>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Exactly this path, no trailing slash. It is the only /api/voice path the voice
                runtime answers; any other /api/voice/... URL reaches the retired pipeline.
              </p>
            </div>
          </div>

          <div className="p-4 border rounded-lg">
            <h4 className="font-semibold mb-1">Lanes this deployment can answer</h4>
            <p className="text-xs text-muted-foreground mb-3">
              From this build's /voice/health. It does not say which number points where: that is
              the number's Voice URL in Twilio (Sync from Twilio refreshes the table above).
            </p>
            {lanes === null ? (
              <p className="text-sm text-muted-foreground">
                {health.isLoading ? 'Reading /voice/health…' : 'Could not read the lane list from /voice/health.'}
              </p>
            ) : lanes.length === 0 ? (
              <p className="text-sm text-muted-foreground">/voice/health reports no lane it can answer.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lane</TableHead>
                    <TableHead>Voice URL path</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lanes.map((slug) => (
                    <TableRow key={slug}>
                      <TableCell>
                        <Badge variant="outline">{slug}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{runtimePathFor(slug)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="flex gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <strong>Important:</strong> A TwiML App set on a number takes precedence over its
                Voice URL. Check both in the Twilio console before and after you repoint a number.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showConfigureDialog} onOpenChange={setShowConfigureDialog}>
        <DialogContent onClose={() => setShowConfigureDialog(false)}>
          <DialogHeader>
            <DialogTitle>Configure Phone Number</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">Phone Number</div>
              <div className="text-lg font-mono">
                {selectedEndpoint && formatPhoneNumber(selectedEndpoint.phoneNumber)}
              </div>
              {selectedEndpoint?.friendlyName && (
                <div className="text-sm text-muted-foreground">{selectedEndpoint.friendlyName}</div>
              )}
            </div>

            <div>
              <Label htmlFor="agentSelect">Assign to Agent</Label>
              <Select
                id="agentSelect"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
              >
                <option value="">Select an agent...</option>
                {agents?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.slug})
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-sm text-muted-foreground">
                This does not change the number. It reads the number's current Voice URL from
                Twilio and shows you what it is set to (a TwiML App on the number, if any, takes
                precedence over it). The URL this action used to write is served
                by neither voice pipeline, so it would have dropped every call. Repoint a number in
                the Twilio console.
              </p>
            </div>

            {selectedEndpoint?.voiceWebhookUrl && (
              <div className="p-4 bg-muted rounded-lg">
                <div className="text-sm text-muted-foreground">
                  Webhook URL at the last sync
                  {selectedEndpoint.lastSyncedAt
                    ? ` (${new Date(selectedEndpoint.lastSyncedAt).toLocaleDateString()}; may be out of date)`
                    : ' (may be out of date)'}
                </div>
                <div className="text-sm font-mono break-all">
                  {selectedEndpoint.voiceWebhookUrl}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowConfigureDialog(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfigureForAgent}
                disabled={!selectedAgentId || configureForAgentMutation.isPending}
              >
                {configureForAgentMutation.isPending ? 'Checking...' : 'Check with Twilio'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
