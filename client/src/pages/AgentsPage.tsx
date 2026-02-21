import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { useToast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Phone, Settings, Play, Pause, PhoneIncoming, PhoneOutgoing, AlertCircle } from 'lucide-react'
import type { Agent } from '@/types'
import { VOICE_OPTIONS } from '@/types'
import { formatPhoneNumber } from '@/lib/phoneFormat'

export function AgentsPage() {
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showTestDialog, setShowTestDialog] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [testPhoneNumber, setTestPhoneNumber] = useState('')

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const { data } = await apiClient.get<Agent[]>('/agents')
      return data
    },
  })

  // Fetch available Twilio phone numbers
  const { data: twilioNumbers } = useQuery({
    queryKey: ['twilio-phone-numbers'],
    queryFn: async () => {
      const { data } = await apiClient.get<Array<{
        phoneNumber: string
        friendlyName: string
        capabilities: { voice: boolean; sms: boolean }
      }>>('/twilio/phone-numbers')
      return data
    },
  })

  const createAgentMutation = useMutation({
    mutationFn: async (agentData: Partial<Agent>) => {
      const { data } = await apiClient.post('/agents', agentData)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowCreateDialog(false)
      addToast({
        title: 'Success',
        description: 'Agent created successfully',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to create agent',
        variant: 'destructive',
      })
    },
  })

  const updateAgentMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string
      data: Partial<Agent>
    }) => {
      const response = await apiClient.patch(`/agents/${id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowEditDialog(false)
      addToast({
        title: 'Success',
        description: 'Agent updated successfully',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to update agent',
        variant: 'destructive',
      })
    },
  })

  const testCallMutation = useMutation({
    mutationFn: async ({
      agentId,
      phoneNumber,
    }: {
      agentId: string
      phoneNumber: string
    }) => {
      const { data } = await apiClient.post('/test-call', {
        agentId,
        phoneNumber,
      })
      return data
    },
    onSuccess: () => {
      setShowTestDialog(false)
      setTestPhoneNumber('')
      addToast({
        title: 'Success',
        description: 'Test call initiated',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to initiate test call',
        variant: 'destructive',
      })
    },
  })

  const handleCreateAgent = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const twilioPhoneNumber = formData.get('twilioPhoneNumber') as string
    createAgentMutation.mutate({
      name: formData.get('name') as string,
      slug: formData.get('slug') as string,
      description: formData.get('description') as string,
      agentType: formData.get('agentType') as 'inbound' | 'outbound',
      voice: formData.get('voice') as string,
      temperature: parseInt(formData.get('temperature') as string),
      systemPrompt: formData.get('systemPrompt') as string,
      welcomeGreeting: formData.get('welcomeGreeting') as string,
      ...(twilioPhoneNumber && { twilioPhoneNumber }),
    })
  }

  const handleUpdateAgent = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!selectedAgent) return
    const formData = new FormData(e.currentTarget)
    const twilioPhoneNumber = formData.get('twilioPhoneNumber') as string
    updateAgentMutation.mutate({
      id: selectedAgent.id,
      data: {
        voice: formData.get('voice') as string,
        temperature: parseInt(formData.get('temperature') as string),
        systemPrompt: formData.get('systemPrompt') as string,
        twilioPhoneNumber: twilioPhoneNumber || null, // Explicitly send null to clear the field
      },
    })
  }

  const handleTestCall = () => {
    if (!selectedAgent || !testPhoneNumber) return
    testCallMutation.mutate({
      agentId: selectedAgent.id,
      phoneNumber: testPhoneNumber,
    })
  }

  const handleToggleStatus = (agent: Agent) => {
    const newStatus = agent.status === 'active' ? 'inactive' : 'active'
    updateAgentMutation.mutate({
      id: agent.id,
      data: { status: newStatus },
    })
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Voice Agents</h1>
          <p className="text-muted-foreground">Manage your AI voice agents</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Agent
        </Button>
      </div>

      {!agents || agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No agents yet. Create your first agent to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg">{agent.name}</CardTitle>
                    <p className="text-sm text-muted-foreground">{agent.slug}</p>
                  </div>
                  <Badge
                    variant={
                      agent.status === 'active'
                        ? 'success'
                        : agent.status === 'testing'
                        ? 'warning'
                        : 'default'
                    }
                  >
                    {agent.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm">
                  <p className="text-muted-foreground">{agent.description}</p>
                </div>
                
                {/* Phone Number Assignment */}
                <div className="rounded-lg border border-border bg-muted p-3">
                  {agent.twilioPhoneNumber ? (
                    <div className="flex items-start gap-2">
                      {agent.agentType === 'inbound' ? (
                        <PhoneIncoming className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                      ) : (
                        <PhoneOutgoing className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {formatPhoneNumber(agent.twilioPhoneNumber)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {agent.agentType === 'inbound' 
                            ? 'Receives calls to this number'
                            : 'Calls from this number'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-amber-900">
                          No phone number assigned
                        </div>
                        <div className="text-xs text-amber-700">
                          Configure a Twilio number to enable calling
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{agent.agentType}</Badge>
                  <Badge variant="outline">{agent.voice}</Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedAgent(agent)
                      setShowEditDialog(true)
                    }}
                  >
                    <Settings className="mr-2 h-3 w-3" />
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedAgent(agent)
                      setShowTestDialog(true)
                    }}
                  >
                    <Phone className="mr-2 h-3 w-3" />
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant={agent.status === 'active' ? 'destructive' : 'default'}
                    onClick={() => handleToggleStatus(agent)}
                  >
                    {agent.status === 'active' ? (
                      <Pause className="h-3 w-3" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Agent Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent onClose={() => setShowCreateDialog(false)}>
          <DialogHeader>
            <DialogTitle>Create New Agent</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateAgent} className="space-y-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" name="slug" required />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" name="description" />
            </div>
            <div>
              <Label htmlFor="agentType">Type</Label>
              <Select id="agentType" name="agentType" required>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="twilioPhoneNumber">Twilio Phone Number (Optional)</Label>
              <Select id="twilioPhoneNumber" name="twilioPhoneNumber">
                <option value="">-- Select a phone number --</option>
                {twilioNumbers?.map((number) => (
                  <option key={number.phoneNumber} value={number.phoneNumber}>
                    {number.friendlyName} ({number.phoneNumber})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                <strong>Inbound:</strong> Routes calls to this number to this agent.<br />
                <strong>Outbound:</strong> Uses this number as caller ID when calling.
              </p>
            </div>
            <div>
              <Label htmlFor="voice">Voice</Label>
              <Select id="voice" name="voice" defaultValue="sage">
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="temperature">Temperature ({70})</Label>
              <Input
                id="temperature"
                name="temperature"
                type="range"
                min="0"
                max="100"
                defaultValue="70"
              />
            </div>
            <div>
              <Label htmlFor="systemPrompt">System Prompt</Label>
              <Textarea id="systemPrompt" name="systemPrompt" rows={4} required />
            </div>
            <div>
              <Label htmlFor="welcomeGreeting">Welcome Greeting</Label>
              <Textarea id="welcomeGreeting" name="welcomeGreeting" />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreateDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Create Agent</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Agent Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent onClose={() => setShowEditDialog(false)}>
          <DialogHeader>
            <DialogTitle>Configure Agent</DialogTitle>
          </DialogHeader>
          {selectedAgent && (
            <form onSubmit={handleUpdateAgent} className="space-y-4">
              <div>
                <Label htmlFor="edit-voice">Voice</Label>
                <Select
                  id="edit-voice"
                  name="voice"
                  defaultValue={selectedAgent.voice}
                >
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="edit-twilioPhoneNumber">Twilio Phone Number</Label>
                <Select
                  id="edit-twilioPhoneNumber"
                  name="twilioPhoneNumber"
                  defaultValue={selectedAgent.twilioPhoneNumber || ''}
                >
                  <option value="">-- No phone number assigned --</option>
                  {twilioNumbers?.map((number) => (
                    <option key={number.phoneNumber} value={number.phoneNumber}>
                      {number.friendlyName} ({number.phoneNumber})
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  <strong>Inbound:</strong> Routes calls to this number to this agent.<br />
                  <strong>Outbound:</strong> Uses this number as caller ID when calling.
                </p>
              </div>
              <div>
                <Label htmlFor="edit-temperature">
                  Temperature ({selectedAgent.temperature})
                </Label>
                <Input
                  id="edit-temperature"
                  name="temperature"
                  type="range"
                  min="0"
                  max="100"
                  defaultValue={selectedAgent.temperature}
                />
              </div>
              <div>
                <Label htmlFor="edit-systemPrompt">System Prompt</Label>
                <Textarea
                  id="edit-systemPrompt"
                  name="systemPrompt"
                  rows={6}
                  defaultValue={selectedAgent.systemPrompt}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowEditDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="submit">Save Changes</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Test Call Dialog */}
      <Dialog open={showTestDialog} onOpenChange={setShowTestDialog}>
        <DialogContent onClose={() => setShowTestDialog(false)}>
          <DialogHeader>
            <DialogTitle>Test Call</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+1234567890"
                value={testPhoneNumber}
                onChange={(e) => setTestPhoneNumber(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowTestDialog(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleTestCall}>Initiate Call</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
