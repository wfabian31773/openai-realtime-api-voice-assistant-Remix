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
      addToast({
        title: 'Configuration Failed',
        description: error?.response?.data?.message || 'Failed to configure phone for agent',
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

      {/* Production Endpoint Reference */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            Production Endpoint Reference
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The webhook URL determines which agent handles calls. Use this reference when configuring phone numbers.
          </p>
          
          <div className="grid gap-4 md:grid-cols-2">
            {/* Known Production Mappings */}
            <div className="p-4 border rounded-lg">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Phone className="h-4 w-4" />
                Known Production Numbers
              </h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center p-2 bg-muted rounded">
                  <span className="font-mono">(626) 382-1543</span>
                  <Badge variant="outline">no-ivr</Badge>
                </div>
                <div className="flex justify-between items-center p-2 bg-muted rounded">
                  <span className="font-mono">(909) 413-5645</span>
                  <Badge variant="outline">answering-service</Badge>
                </div>
              </div>
            </div>

            {/* Webhook URL Patterns */}
            <div className="p-4 border rounded-lg">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                Webhook URL Patterns
              </h4>
              <div className="space-y-2 text-sm">
                <div className="p-2 bg-muted rounded">
                  <div className="text-muted-foreground text-xs mb-1">Direct Agent Routing:</div>
                  <code className="text-xs">/api/voice/inbound?agent=AGENT_SLUG</code>
                </div>
                <div className="p-2 bg-muted rounded">
                  <div className="text-muted-foreground text-xs mb-1">SIP Header Routing:</div>
                  <code className="text-xs">/api/voice/inbound</code>
                  <div className="text-xs text-muted-foreground mt-1">Uses X-Agent-Slug SIP header</div>
                </div>
              </div>
            </div>
          </div>

          {/* Agent Webhook URLs */}
          <div className="p-4 border rounded-lg">
            <h4 className="font-semibold mb-3">Available Agent Webhooks</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Production Webhook URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents?.filter(a => a.status === 'active').map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{agent.slug}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">https://YOUR_DOMAIN</span>
                        <span>/api/voice/inbound?agent={agent.slug}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="flex gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <strong>Important:</strong> The webhook URL is the source of truth for agent routing. 
                Changing the phone number alone does not change which agent handles calls - you must 
                update the webhook URL in Twilio to route to a different agent.
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
                This will update the Twilio webhook to route calls to the selected agent.
              </p>
            </div>

            {selectedEndpoint?.voiceWebhookUrl && (
              <div className="p-4 bg-muted rounded-lg">
                <div className="text-sm text-muted-foreground">Current Webhook URL</div>
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
                {configureForAgentMutation.isPending ? 'Configuring...' : 'Configure & Update Twilio'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
