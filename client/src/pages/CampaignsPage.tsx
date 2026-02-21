import { useState, useRef } from 'react'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Plus, Upload, Eye, Phone, PhoneOff, Calendar, Search, Database, Trash2, FileSpreadsheet, CheckCircle2 } from 'lucide-react'
import type { Campaign, CampaignContact, Agent } from '@/types'

interface TwilioPhoneNumber {
  phoneNumber: string
  friendlyName: string
}

interface ScheduleFilterOptions {
  locations: string[]
  providers: string[]
  appointmentTypes: string[]
  statuses: string[]
}

interface ScheduleQueryFilters {
  confirmationStatus: 'all' | 'unconfirmed' | 'confirmed'
  dateFrom: string
  dateTo: string
  locations: string[]
  providers: string[]
  appointmentTypes: string[]
  appointmentStatuses: string[]
}

interface SchedulePreviewRecord {
  firstName: string | null
  lastName: string | null
  phone: string
  appointmentDate: string | null
  appointmentStart: string | null  // 24hr format like "1550" 
  appointmentEnd: string | null    // 24hr format like "1600"
  location: string | null
  provider: string | null
  appointmentType: string | null
  confirmed: boolean
  dob: string | null
}

// Helper to format 24hr time string (e.g., "1550") to readable format (e.g., "3:50 PM")
function formatTime24(time: string | null): string {
  if (!time || time.length < 3) return '-';
  // Pad to 4 digits if needed (e.g., "930" -> "0930")
  const padded = time.padStart(4, '0');
  const hours = parseInt(padded.slice(0, 2), 10);
  const minutes = padded.slice(2, 4);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHours}:${minutes} ${period}`;
}

interface SchedulePreviewResponse {
  totalCount: number
  previewCount: number
  records: SchedulePreviewRecord[]
}

const defaultFilters: ScheduleQueryFilters = {
  confirmationStatus: 'all',
  dateFrom: '',
  dateTo: '',
  locations: [],
  providers: [],
  appointmentTypes: [],
  appointmentStatuses: [],
}

type ContactSourceTab = 'none' | 'csv' | 'schedule'
type CreateWizardStep = 'details' | 'contacts'

interface NewCampaignData {
  name: string
  description: string
  agentId: string
  campaignType: 'call' | 'sms' | 'both'
}

export function CampaignsPage() {
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showContactsDialog, setShowContactsDialog] = useState(false)
  const [showStartOutboundDialog, setShowStartOutboundDialog] = useState(false)
  const [showAddContactsDialog, setShowAddContactsDialog] = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [selectedFromNumber, setSelectedFromNumber] = useState('')
  
  const [wizardStep, setWizardStep] = useState<CreateWizardStep>('details')
  const [contactSourceTab, setContactSourceTab] = useState<ContactSourceTab>('none')
  const [existingCampaignContactTab, setExistingCampaignContactTab] = useState<ContactSourceTab>('none')
  const [newCampaignData, setNewCampaignData] = useState<NewCampaignData>({
    name: '',
    description: '',
    agentId: '',
    campaignType: 'call',
  })
  const [createdCampaignId, setCreatedCampaignId] = useState<string | null>(null)
  
  const [scheduleFilters, setScheduleFilters] = useState<ScheduleQueryFilters>(defaultFilters)
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreviewResponse | null>(null)

  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => {
      const { data } = await apiClient.get<Campaign[]>('/campaigns')
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

  const { data: phoneNumbers } = useQuery({
    queryKey: ['twilio-phone-numbers'],
    queryFn: async () => {
      const { data } = await apiClient.get<TwilioPhoneNumber[]>('/twilio/phone-numbers')
      return data
    },
  })

  const { data: filterOptions } = useQuery({
    queryKey: ['schedule-filter-options'],
    queryFn: async () => {
      const { data } = await apiClient.get<ScheduleFilterOptions>('/schedule/filter-options')
      return data
    },
  })

  const { data: contacts } = useQuery({
    queryKey: ['campaign-contacts', selectedCampaign?.id],
    queryFn: async () => {
      if (!selectedCampaign) return []
      const { data } = await apiClient.get<CampaignContact[]>(
        `/campaigns/${selectedCampaign.id}/contacts`
      )
      return data
    },
    enabled: !!selectedCampaign,
  })

  const createCampaignMutation = useMutation({
    mutationFn: async (campaignData: Partial<Campaign>) => {
      const { data } = await apiClient.post('/campaigns', campaignData)
      return data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      setCreatedCampaignId(data.id)
      setWizardStep('contacts')
      addToast({
        title: 'Campaign Created',
        description: 'Now add contacts to your campaign',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to create campaign',
        variant: 'destructive',
      })
    },
  })

  const uploadContactsMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const formData = new FormData()
      formData.append('file', file)
      const { data } = await apiClient.post(
        `/campaigns/${id}/upload-contacts`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
        }
      )
      return data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      addToast({
        title: 'Contacts Uploaded',
        description: `${data.count || 'Contacts'} added successfully`,
        variant: 'success',
      })
      handleCloseCreateDialog()
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to upload contacts',
        variant: 'destructive',
      })
    },
  })

  const previewScheduleMutation = useMutation({
    mutationFn: async (filters: ScheduleQueryFilters) => {
      const { data } = await apiClient.post<SchedulePreviewResponse>('/schedule/query-preview', filters)
      return data
    },
    onSuccess: (data) => {
      setSchedulePreview(data)
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to preview schedule data',
        variant: 'destructive',
      })
    },
  })

  const populateFromScheduleMutation = useMutation({
    mutationFn: async ({ id, filters }: { id: string; filters: ScheduleQueryFilters }) => {
      const { data } = await apiClient.post(`/campaigns/${id}/populate-from-schedule`, filters)
      return data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      addToast({
        title: 'Contacts Added',
        description: `${data.count} contacts added from schedule`,
        variant: 'success',
      })
      handleCloseCreateDialog()
    },
    onError: (error: any) => {
      addToast({
        title: 'Error',
        description: error?.response?.data?.message || 'Failed to populate contacts from schedule',
        variant: 'destructive',
      })
    },
  })

  const startOutboundMutation = useMutation({
    mutationFn: async ({ id, fromNumber }: { id: string; fromNumber: string }) => {
      const { data } = await apiClient.post(`/campaigns/${id}/start-outbound-scheduler`, { fromNumber })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      setShowStartOutboundDialog(false)
      setSelectedFromNumber('')
      addToast({
        title: 'Outbound Calls Started',
        description: 'The campaign is now making calls to contacts',
        variant: 'success',
      })
    },
    onError: (error: any) => {
      addToast({
        title: 'Error',
        description: error?.response?.data?.message || 'Failed to start outbound calls',
        variant: 'destructive',
      })
    },
  })

  const stopOutboundMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post(`/campaigns/${id}/stop-outbound-scheduler`)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      addToast({
        title: 'Outbound Calls Stopped',
        description: 'The campaign has stopped making calls',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to stop outbound calls',
        variant: 'destructive',
      })
    },
  })

  const deleteCampaignMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete(`/campaigns/${id}`)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      addToast({
        title: 'Campaign Deleted',
        description: 'The campaign has been deleted',
        variant: 'success',
      })
    },
    onError: (error: any) => {
      addToast({
        title: 'Error',
        description: error?.response?.data?.message || 'Failed to delete campaign',
        variant: 'destructive',
      })
    },
  })

  const handleDeleteCampaign = (campaign: Campaign) => {
    if (window.confirm(`Are you sure you want to delete "${campaign.name}"? This action cannot be undone.`)) {
      deleteCampaignMutation.mutate(campaign.id)
    }
  }

  const handleStartOutbound = () => {
    if (!selectedCampaign || !selectedFromNumber) return
    startOutboundMutation.mutate({
      id: selectedCampaign.id,
      fromNumber: selectedFromNumber,
    })
  }

  const handleCloseCreateDialog = () => {
    setShowCreateDialog(false)
    setWizardStep('details')
    setContactSourceTab('none')
    setNewCampaignData({ name: '', description: '', agentId: '', campaignType: 'call' })
    setCreatedCampaignId(null)
    setScheduleFilters(defaultFilters)
    setSchedulePreview(null)
  }

  const handleCloseAddContactsDialog = () => {
    setShowAddContactsDialog(false)
    setSelectedCampaign(null)
    setExistingCampaignContactTab('none')
    setScheduleFilters(defaultFilters)
    setSchedulePreview(null)
  }

  const openAddContactsDialog = (campaign: Campaign) => {
    setSelectedCampaign(campaign)
    setExistingCampaignContactTab('none')
    setScheduleFilters(defaultFilters)
    setSchedulePreview(null)
    setShowAddContactsDialog(true)
  }

  const handleCreateCampaign = () => {
    if (!newCampaignData.name || !newCampaignData.agentId) {
      addToast({
        title: 'Missing Fields',
        description: 'Please fill in the campaign name and select an agent',
        variant: 'destructive',
      })
      return
    }
    createCampaignMutation.mutate(newCampaignData)
  }

  const handleUploadContacts = () => {
    if (!createdCampaignId || !fileInputRef.current?.files?.[0]) return
    uploadContactsMutation.mutate({
      id: createdCampaignId,
      file: fileInputRef.current.files[0],
    })
  }

  const handleUploadContactsToExisting = () => {
    if (!selectedCampaign || !fileInputRef.current?.files?.[0]) return
    uploadContactsMutation.mutate(
      {
        id: selectedCampaign.id,
        file: fileInputRef.current.files[0],
      },
      {
        onSuccess: () => {
          handleCloseAddContactsDialog()
        },
      }
    )
  }

  const handlePreviewSchedule = () => {
    previewScheduleMutation.mutate(scheduleFilters)
  }

  const handlePopulateFromSchedule = () => {
    if (!createdCampaignId) return
    populateFromScheduleMutation.mutate({
      id: createdCampaignId,
      filters: scheduleFilters,
    })
  }

  const handlePopulateExistingFromSchedule = () => {
    if (!selectedCampaign) return
    populateFromScheduleMutation.mutate(
      {
        id: selectedCampaign.id,
        filters: scheduleFilters,
      },
      {
        onSuccess: () => {
          handleCloseAddContactsDialog()
        },
      }
    )
  }

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'running':
        return 'success'
      case 'completed':
        return 'info'
      case 'paused':
        return 'warning'
      case 'cancelled':
        return 'destructive'
      default:
        return 'default'
    }
  }

  const isDetailsValid = newCampaignData.name && newCampaignData.agentId

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
          <h1 className="text-3xl font-bold text-foreground">Campaigns</h1>
          <p className="text-muted-foreground">Manage outreach campaigns</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Campaign
        </Button>
      </div>

      {!campaigns || campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No campaigns yet. Create your first campaign to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((campaign) => {
            const progress =
              campaign.totalContacts > 0
                ? (campaign.completedContacts / campaign.totalContacts) * 100
                : 0
            const showStartButton = campaign.status !== 'running' && campaign.totalContacts > 0
            return (
              <Card key={campaign.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{campaign.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">{campaign.description}</p>
                    </div>
                    <Badge variant={getStatusVariant(campaign.status)}>
                      {campaign.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Progress</span>
                      <span className="font-medium">
                        {campaign.completedContacts}/{campaign.totalContacts}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <Badge variant="outline">{campaign.campaignType}</Badge>
                    {(() => {
                      const agent = agents?.find(a => a.id === campaign.agentId)
                      return agent ? (
                        <span className="text-muted-foreground">
                          Agent: {agent.name}
                        </span>
                      ) : null
                    })()}
                    <span className="text-muted-foreground">
                      Success: {campaign.successfulContacts}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedCampaign(campaign)
                        setShowContactsDialog(true)
                      }}
                    >
                      <Eye className="mr-2 h-3 w-3" />
                      View
                    </Button>
                    {campaign.status !== 'running' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openAddContactsDialog(campaign)}
                      >
                        <Plus className="mr-2 h-3 w-3" />
                        Add
                      </Button>
                    )}
                    {showStartButton && (
                      <Button
                        size="sm"
                        variant="default"
                        className="bg-green-600 hover:bg-green-700"
                        onClick={() => {
                          setSelectedCampaign(campaign)
                          setShowStartOutboundDialog(true)
                        }}
                      >
                        <Phone className="mr-2 h-3 w-3" />
                        Start
                      </Button>
                    )}
                    {campaign.status === 'running' && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => stopOutboundMutation.mutate(campaign.id)}
                        disabled={stopOutboundMutation.isPending}
                      >
                        <PhoneOff className="mr-2 h-3 w-3" />
                        Stop
                      </Button>
                    )}
                    {campaign.status !== 'running' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteCampaign(campaign)}
                        disabled={deleteCampaignMutation.isPending}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Unified Create Campaign Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => !open && handleCloseCreateDialog()}>
        <DialogContent 
          onClose={handleCloseCreateDialog}
          className="max-w-3xl max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create New Campaign
            </DialogTitle>
          </DialogHeader>
          
          {/* Step Indicator */}
          <div className="flex items-center gap-4 py-4 border-b">
            <div className={`flex items-center gap-2 ${wizardStep === 'details' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                wizardStep === 'contacts' ? 'bg-primary text-primary-foreground' : 
                wizardStep === 'details' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}>
                {wizardStep === 'contacts' ? <CheckCircle2 className="h-5 w-5" /> : '1'}
              </div>
              <span>Campaign Details</span>
            </div>
            <div className="flex-1 h-px bg-muted" />
            <div className={`flex items-center gap-2 ${wizardStep === 'contacts' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                wizardStep === 'contacts' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}>
                2
              </div>
              <span>Add Contacts</span>
            </div>
          </div>

          {/* Step 1: Campaign Details */}
          {wizardStep === 'details' && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="name">Campaign Name *</Label>
                  <Input 
                    id="name" 
                    value={newCampaignData.name}
                    onChange={(e) => setNewCampaignData(d => ({ ...d, name: e.target.value }))}
                    placeholder="e.g., Tomorrow's Appointment Confirmations"
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea 
                    id="description" 
                    value={newCampaignData.description}
                    onChange={(e) => setNewCampaignData(d => ({ ...d, description: e.target.value }))}
                    placeholder="Brief description of this campaign's purpose"
                    rows={2}
                  />
                </div>
                <div>
                  <Label htmlFor="agentId">Voice Agent *</Label>
                  <Select 
                    id="agentId" 
                    value={newCampaignData.agentId}
                    onChange={(e) => setNewCampaignData(d => ({ ...d, agentId: e.target.value }))}
                  >
                    <option value="">Choose an agent...</option>
                    {agents?.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="campaignType">Campaign Type</Label>
                  <Select 
                    id="campaignType" 
                    value={newCampaignData.campaignType}
                    onChange={(e) => setNewCampaignData(d => ({ ...d, campaignType: e.target.value as any }))}
                  >
                    <option value="call">Call Only</option>
                    <option value="sms">SMS Only</option>
                    <option value="both">Both Call & SMS</option>
                  </Select>
                </div>
              </div>
              
              <DialogFooter className="pt-4">
                <Button variant="outline" onClick={handleCloseCreateDialog}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleCreateCampaign}
                  disabled={!isDetailsValid || createCampaignMutation.isPending}
                >
                  {createCampaignMutation.isPending ? 'Creating...' : 'Next: Add Contacts'}
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* Step 2: Add Contacts */}
          {wizardStep === 'contacts' && (
            <div className="space-y-4 py-4">
              <div className="text-center mb-4">
                <p className="text-muted-foreground">
                  Choose how to add contacts to <strong>{newCampaignData.name}</strong>
                </p>
              </div>
              
              {/* Contact Source Tabs */}
              <div className="grid grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setContactSourceTab('csv')}
                  className={`p-6 rounded-lg border-2 text-left transition-all ${
                    contactSourceTab === 'csv' 
                      ? 'border-primary bg-primary/5' 
                      : 'border-muted hover:border-muted-foreground/50'
                  }`}
                >
                  <FileSpreadsheet className={`h-8 w-8 mb-3 ${contactSourceTab === 'csv' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <h3 className="font-semibold mb-1">Upload CSV</h3>
                  <p className="text-sm text-muted-foreground">
                    Import contacts from a spreadsheet file
                  </p>
                </button>
                
                <button
                  type="button"
                  onClick={() => setContactSourceTab('schedule')}
                  className={`p-6 rounded-lg border-2 text-left transition-all ${
                    contactSourceTab === 'schedule' 
                      ? 'border-primary bg-primary/5' 
                      : 'border-muted hover:border-muted-foreground/50'
                  }`}
                >
                  <Calendar className={`h-8 w-8 mb-3 ${contactSourceTab === 'schedule' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <h3 className="font-semibold mb-1">Build from Schedule</h3>
                  <p className="text-sm text-muted-foreground">
                    Query upcoming appointments to find patients
                  </p>
                </button>
              </div>

              {/* CSV Upload Section */}
              {contactSourceTab === 'csv' && (
                <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
                  <div>
                    <Label htmlFor="csv-file">Select CSV File</Label>
                    <Input
                      id="csv-file"
                      type="file"
                      accept=".csv"
                      ref={fileInputRef}
                      className="mt-2"
                    />
                    <p className="mt-2 text-sm text-muted-foreground">
                      CSV should include columns: phone, firstName, lastName, email
                    </p>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={handleCloseCreateDialog}>
                      Skip for Now
                    </Button>
                    <Button 
                      onClick={handleUploadContacts}
                      disabled={uploadContactsMutation.isPending}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {uploadContactsMutation.isPending ? 'Uploading...' : 'Upload Contacts'}
                    </Button>
                  </DialogFooter>
                </div>
              )}

              {/* Schedule Query Section */}
              {contactSourceTab === 'schedule' && (
                <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
                  {filterOptions && filterOptions.locations.length === 0 && filterOptions.providers.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p className="font-medium">Schedule data not available in development</p>
                      <p className="text-sm mt-1">
                        Use CSV upload to add contacts, or test this feature in production where schedule data is synced.
                      </p>
                    </div>
                  ) : (
                    <>
                  <p className="text-sm text-muted-foreground">
                    Query the scheduling system to find patients matching your criteria.
                    Only patients with phone numbers will be included.
                  </p>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="confirmationStatus">Confirmation Status</Label>
                      <Select
                        id="confirmationStatus"
                        value={scheduleFilters.confirmationStatus}
                        onChange={(e) => setScheduleFilters(f => ({ ...f, confirmationStatus: e.target.value as any }))}
                      >
                        <option value="all">All</option>
                        <option value="unconfirmed">Unconfirmed Only</option>
                        <option value="confirmed">Confirmed Only</option>
                      </Select>
                    </div>
                    
                    <div>
                      <Label htmlFor="appointmentStatus">Appointment Status</Label>
                      <select
                        id="appointmentStatus"
                        multiple
                        className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={scheduleFilters.appointmentStatuses}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, option => option.value)
                          setScheduleFilters(f => ({ ...f, appointmentStatuses: selected }))
                        }}
                      >
                        {filterOptions?.statuses.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                    </div>
                    
                    <div>
                      <Label htmlFor="dateFrom">Date From</Label>
                      <Input
                        id="dateFrom"
                        type="date"
                        value={scheduleFilters.dateFrom}
                        onChange={(e) => setScheduleFilters(f => ({ ...f, dateFrom: e.target.value }))}
                      />
                    </div>
                    
                    <div>
                      <Label htmlFor="dateTo">Date To</Label>
                      <Input
                        id="dateTo"
                        type="date"
                        value={scheduleFilters.dateTo}
                        onChange={(e) => setScheduleFilters(f => ({ ...f, dateTo: e.target.value }))}
                      />
                    </div>
                    
                    <div>
                      <Label htmlFor="location">Location</Label>
                      <select
                        id="location"
                        multiple
                        className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={scheduleFilters.locations}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, option => option.value)
                          setScheduleFilters(f => ({ ...f, locations: selected }))
                        }}
                      >
                        {filterOptions?.locations.map((loc) => (
                          <option key={loc} value={loc}>{loc}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                    </div>
                    
                    <div>
                      <Label htmlFor="provider">Provider</Label>
                      <select
                        id="provider"
                        multiple
                        className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={scheduleFilters.providers}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, option => option.value)
                          setScheduleFilters(f => ({ ...f, providers: selected }))
                        }}
                      >
                        {filterOptions?.providers.map((prov) => (
                          <option key={prov} value={prov}>{prov}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                    </div>
                    
                    <div className="col-span-2">
                      <Label htmlFor="appointmentType">Appointment Type (Service Category)</Label>
                      <select
                        id="appointmentType"
                        multiple
                        className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={scheduleFilters.appointmentTypes}
                        onChange={(e) => {
                          const selected = Array.from(e.target.selectedOptions, option => option.value)
                          setScheduleFilters(f => ({ ...f, appointmentTypes: selected }))
                        }}
                      >
                        {filterOptions?.appointmentTypes.map((type) => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple. Leave empty for all.</p>
                    </div>
                  </div>
                  
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      onClick={handlePreviewSchedule}
                      disabled={previewScheduleMutation.isPending}
                    >
                      <Search className="mr-2 h-4 w-4" />
                      {previewScheduleMutation.isPending ? 'Searching...' : 'Preview Matching Patients'}
                    </Button>
                  </div>
                  
                  {schedulePreview && (
                    <div className="space-y-3 border-t pt-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium">
                          Found {schedulePreview.totalCount} matching patients
                        </h4>
                        {schedulePreview.totalCount > schedulePreview.previewCount && (
                          <span className="text-sm text-muted-foreground">
                            Showing first {schedulePreview.previewCount}
                          </span>
                        )}
                      </div>
                      
                      {schedulePreview.records.length > 0 ? (
                        <div className="max-h-64 overflow-auto rounded border bg-background">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Phone</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead>Time</TableHead>
                                <TableHead>Provider</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Confirmed</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {schedulePreview.records.map((record, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-medium whitespace-nowrap">
                                    {record.firstName} {record.lastName}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">{record.phone}</TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {record.appointmentDate || '-'}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {record.appointmentStart && record.appointmentEnd 
                                      ? `${formatTime24(record.appointmentStart)} - ${formatTime24(record.appointmentEnd)}`
                                      : formatTime24(record.appointmentStart)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">{record.provider || '-'}</TableCell>
                                  <TableCell>{record.appointmentType || '-'}</TableCell>
                                  <TableCell>
                                    <Badge variant={record.confirmed ? 'success' : 'warning'}>
                                      {record.confirmed ? 'Yes' : 'No'}
                                    </Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <p className="text-center text-muted-foreground py-4">
                          No patients found with phone numbers matching your criteria
                        </p>
                      )}
                    </div>
                  )}
                  
                  <DialogFooter>
                    <Button variant="outline" onClick={handleCloseCreateDialog}>
                      Skip for Now
                    </Button>
                    <Button
                      onClick={handlePopulateFromSchedule}
                      disabled={!schedulePreview || schedulePreview.totalCount === 0 || populateFromScheduleMutation.isPending}
                    >
                      <Database className="mr-2 h-4 w-4" />
                      {populateFromScheduleMutation.isPending ? 'Adding...' : `Add ${schedulePreview?.totalCount || 0} Contacts`}
                    </Button>
                  </DialogFooter>
                    </>
                  )}
                </div>
              )}

              {/* No selection yet */}
              {contactSourceTab === 'none' && (
                <DialogFooter className="pt-4">
                  <Button variant="outline" onClick={handleCloseCreateDialog}>
                    Skip for Now
                  </Button>
                </DialogFooter>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* View Contacts Dialog */}
      <Dialog open={showContactsDialog} onOpenChange={setShowContactsDialog}>
        <DialogContent onClose={() => setShowContactsDialog(false)}>
          <DialogHeader>
            <DialogTitle>Campaign Contacts</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {!contacts || contacts.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">No contacts yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.map((contact) => (
                    <TableRow key={contact.id}>
                      <TableCell>
                        {contact.firstName} {contact.lastName}
                      </TableCell>
                      <TableCell>{contact.phoneNumber}</TableCell>
                      <TableCell>
                        <Badge
                          variant={contact.successful ? 'success' : 'default'}
                        >
                          {contact.contacted
                            ? contact.successful
                              ? 'Success'
                              : 'Failed'
                            : 'Pending'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Start Outbound Calls Dialog */}
      <Dialog open={showStartOutboundDialog} onOpenChange={setShowStartOutboundDialog}>
        <DialogContent onClose={() => setShowStartOutboundDialog(false)}>
          <DialogHeader>
            <DialogTitle>Start Outbound Calls</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-4">
                This will start calling contacts in <strong>{selectedCampaign?.name}</strong>.
                The system will respect each contact's timezone (8am-8pm local time) and make up to 3 attempts per contact.
              </p>
            </div>
            <div>
              <Label htmlFor="fromNumber">Select Caller ID (From Number)</Label>
              <Select
                id="fromNumber"
                value={selectedFromNumber}
                onChange={(e) => setSelectedFromNumber(e.target.value)}
              >
                <option value="">Choose a phone number...</option>
                {phoneNumbers?.map((num) => (
                  <option key={num.phoneNumber} value={num.phoneNumber}>
                    {num.friendlyName || num.phoneNumber}
                  </option>
                ))}
              </Select>
              <p className="mt-2 text-sm text-muted-foreground">
                This number will appear as the caller ID for outbound calls.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowStartOutboundDialog(false)
                  setSelectedFromNumber('')
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleStartOutbound}
                disabled={!selectedFromNumber || startOutboundMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                <Phone className="mr-2 h-4 w-4" />
                {startOutboundMutation.isPending ? 'Starting...' : 'Start Calls'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Contacts to Existing Campaign Dialog */}
      <Dialog open={showAddContactsDialog} onOpenChange={(open) => !open && handleCloseAddContactsDialog()}>
        <DialogContent 
          onClose={handleCloseAddContactsDialog}
          className="max-w-3xl max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Add Contacts to {selectedCampaign?.name}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="text-center mb-4">
              <p className="text-muted-foreground">
                Choose how to add contacts to this campaign
              </p>
            </div>
            
            {/* Contact Source Tabs */}
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setExistingCampaignContactTab('csv')}
                className={`p-6 rounded-lg border-2 text-left transition-all ${
                  existingCampaignContactTab === 'csv' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-muted hover:border-muted-foreground/50'
                }`}
              >
                <FileSpreadsheet className={`h-8 w-8 mb-3 ${existingCampaignContactTab === 'csv' ? 'text-primary' : 'text-muted-foreground'}`} />
                <h3 className="font-semibold mb-1">Upload CSV</h3>
                <p className="text-sm text-muted-foreground">
                  Import contacts from a spreadsheet file
                </p>
              </button>
              
              <button
                type="button"
                onClick={() => setExistingCampaignContactTab('schedule')}
                className={`p-6 rounded-lg border-2 text-left transition-all ${
                  existingCampaignContactTab === 'schedule' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-muted hover:border-muted-foreground/50'
                }`}
              >
                <Calendar className={`h-8 w-8 mb-3 ${existingCampaignContactTab === 'schedule' ? 'text-primary' : 'text-muted-foreground'}`} />
                <h3 className="font-semibold mb-1">Build from Schedule</h3>
                <p className="text-sm text-muted-foreground">
                  Query upcoming appointments to find patients
                </p>
              </button>
            </div>

            {/* CSV Upload Section */}
            {existingCampaignContactTab === 'csv' && (
              <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
                <div>
                  <Label htmlFor="csv-file-existing">Select CSV File</Label>
                  <Input
                    id="csv-file-existing"
                    type="file"
                    accept=".csv"
                    ref={fileInputRef}
                    className="mt-2"
                  />
                  <p className="mt-2 text-sm text-muted-foreground">
                    CSV should include columns: phone, firstName, lastName, email
                  </p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={handleCloseAddContactsDialog}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleUploadContactsToExisting}
                    disabled={uploadContactsMutation.isPending}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {uploadContactsMutation.isPending ? 'Uploading...' : 'Upload Contacts'}
                  </Button>
                </DialogFooter>
              </div>
            )}

            {/* Schedule Query Section */}
            {existingCampaignContactTab === 'schedule' && (
              <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
                {filterOptions && filterOptions.locations.length === 0 && filterOptions.providers.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground">
                    <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p className="font-medium">Schedule data not available in development</p>
                    <p className="text-sm mt-1">
                      Use CSV upload to add contacts, or test this feature in production where schedule data is synced.
                    </p>
                  </div>
                ) : (
                  <>
                <p className="text-sm text-muted-foreground">
                  Query the scheduling system to find patients matching your criteria.
                  Only patients with phone numbers will be included.
                </p>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="confirmationStatus2">Confirmation Status</Label>
                    <Select
                      id="confirmationStatus2"
                      value={scheduleFilters.confirmationStatus}
                      onChange={(e) => setScheduleFilters(f => ({ ...f, confirmationStatus: e.target.value as any }))}
                    >
                      <option value="all">All</option>
                      <option value="unconfirmed">Unconfirmed Only</option>
                      <option value="confirmed">Confirmed Only</option>
                    </Select>
                  </div>
                  
                  <div>
                    <Label htmlFor="appointmentStatus2">Appointment Status</Label>
                    <select
                      id="appointmentStatus2"
                      multiple
                      className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={scheduleFilters.appointmentStatuses}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value)
                        setScheduleFilters(f => ({ ...f, appointmentStatuses: selected }))
                      }}
                    >
                      {filterOptions?.statuses.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                  </div>
                  
                  <div>
                    <Label htmlFor="dateFrom2">Date From</Label>
                    <Input
                      id="dateFrom2"
                      type="date"
                      value={scheduleFilters.dateFrom}
                      onChange={(e) => setScheduleFilters(f => ({ ...f, dateFrom: e.target.value }))}
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="dateTo2">Date To</Label>
                    <Input
                      id="dateTo2"
                      type="date"
                      value={scheduleFilters.dateTo}
                      onChange={(e) => setScheduleFilters(f => ({ ...f, dateTo: e.target.value }))}
                    />
                  </div>
                  
                  <div>
                    <Label htmlFor="location2">Location</Label>
                    <select
                      id="location2"
                      multiple
                      className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={scheduleFilters.locations}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value)
                        setScheduleFilters(f => ({ ...f, locations: selected }))
                      }}
                    >
                      {filterOptions?.locations.map((loc) => (
                        <option key={loc} value={loc}>{loc}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                  </div>
                  
                  <div>
                    <Label htmlFor="provider2">Provider</Label>
                    <select
                      id="provider2"
                      multiple
                      className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={scheduleFilters.providers}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value)
                        setScheduleFilters(f => ({ ...f, providers: selected }))
                      }}
                    >
                      {filterOptions?.providers.map((prov) => (
                        <option key={prov} value={prov}>{prov}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple</p>
                  </div>
                  
                  <div className="col-span-2">
                    <Label htmlFor="appointmentType2">Appointment Type (Service Category)</Label>
                    <select
                      id="appointmentType2"
                      multiple
                      className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={scheduleFilters.appointmentTypes}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value)
                        setScheduleFilters(f => ({ ...f, appointmentTypes: selected }))
                      }}
                    >
                      {filterOptions?.appointmentTypes.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">Hold Ctrl/Cmd to select multiple. Leave empty for all.</p>
                  </div>
                </div>
                
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    onClick={handlePreviewSchedule}
                    disabled={previewScheduleMutation.isPending}
                  >
                    <Search className="mr-2 h-4 w-4" />
                    {previewScheduleMutation.isPending ? 'Searching...' : 'Preview Matching Patients'}
                  </Button>
                </div>
                
                {schedulePreview && (
                  <div className="space-y-3 border-t pt-4">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium">
                        Found {schedulePreview.totalCount} matching patients
                      </h4>
                      {schedulePreview.totalCount > schedulePreview.previewCount && (
                        <span className="text-sm text-muted-foreground">
                          Showing first {schedulePreview.previewCount}
                        </span>
                      )}
                    </div>
                    
                    {schedulePreview.records.length > 0 ? (
                      <div className="max-h-64 overflow-auto rounded border bg-background">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Phone</TableHead>
                              <TableHead>Date</TableHead>
                              <TableHead>Time</TableHead>
                              <TableHead>Provider</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Confirmed</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {schedulePreview.records.map((record, i) => (
                              <TableRow key={i}>
                                <TableCell className="font-medium whitespace-nowrap">
                                  {record.firstName} {record.lastName}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">{record.phone}</TableCell>
                                <TableCell className="whitespace-nowrap">
                                  {record.appointmentDate || '-'}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  {record.appointmentStart && record.appointmentEnd 
                                    ? `${formatTime24(record.appointmentStart)} - ${formatTime24(record.appointmentEnd)}`
                                    : formatTime24(record.appointmentStart)}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">{record.provider || '-'}</TableCell>
                                <TableCell>{record.appointmentType || '-'}</TableCell>
                                <TableCell>
                                  <Badge variant={record.confirmed ? 'success' : 'warning'}>
                                    {record.confirmed ? 'Yes' : 'No'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-center text-muted-foreground py-4">
                        No patients found with phone numbers matching your criteria
                      </p>
                    )}
                  </div>
                )}
                
                <DialogFooter>
                  <Button variant="outline" onClick={handleCloseAddContactsDialog}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handlePopulateExistingFromSchedule}
                    disabled={!schedulePreview || schedulePreview.totalCount === 0 || populateFromScheduleMutation.isPending}
                  >
                    <Database className="mr-2 h-4 w-4" />
                    {populateFromScheduleMutation.isPending ? 'Adding...' : `Add ${schedulePreview?.totalCount || 0} Contacts`}
                  </Button>
                </DialogFooter>
                  </>
                )}
              </div>
            )}

            {/* No selection yet */}
            {existingCampaignContactTab === 'none' && (
              <DialogFooter className="pt-4">
                <Button variant="outline" onClick={handleCloseAddContactsDialog}>
                  Cancel
                </Button>
              </DialogFooter>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
