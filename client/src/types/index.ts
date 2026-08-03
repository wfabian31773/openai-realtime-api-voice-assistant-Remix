export interface Agent {
  id: string
  name: string
  slug: string
  description?: string
  agentType: 'inbound' | 'outbound'
  status: 'active' | 'inactive' | 'testing'
  voice: string
  model: string
  temperature: number
  systemPrompt: string
  welcomeGreeting?: string
  twilioPhoneNumber?: string | null
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface Campaign {
  id: string
  name: string
  description?: string
  agentId: string
  campaignType: 'call' | 'sms' | 'both'
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled'
  scheduledStartTime?: string
  scheduledEndTime?: string
  actualStartTime?: string
  actualEndTime?: string
  totalContacts: number
  completedContacts: number
  successfulContacts: number
  failedContacts: number
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface CampaignContact {
  id: string
  campaignId: string
  phoneNumber: string
  firstName?: string
  lastName?: string
  email?: string
  customData?: Record<string, any>
  contacted: boolean
  successful: boolean
  attempts: number
  lastAttemptAt?: string
  createdAt: string
}

export interface CallLog {
  id: string
  callSid?: string
  agentId?: string
  campaignId?: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string
  callerName?: string
  status: 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer' | 'busy' | 'transferred'
  startTime?: string
  endTime?: string
  duration?: number
  transferredToHuman: boolean
  humanAgentNumber?: string
  transcript?: string
  summary?: string
  detectedConditions?: unknown
  recordingUrl?: string
  createdAt: string
  
  // Cost tracking
  twilioCostCents?: number
  openaiCostCents?: number
  audioInputMinutes?: number
  audioOutputMinutes?: number
  totalCostCents?: number
  
  // Agent attribution + SD pilot tool timeline (agentUsed lives under Call metadata below)
  agentOutcome?: string
  toolTimeline?: {
    purpose?: string
    result?: string
    toolCallCount?: number
    events?: Array<{
      at: string
      tool: string
      args: Record<string, unknown>
      outcome: Record<string, unknown>
      ms: number
    }>
    /** Director interventions — present only when the reasoning layer acted.
     *  Verdict only: `topic` is a field NAME, never the caller's answer. */
    director?: {
      count: number
      maxEnforcement: 'inject' | 'author' | 'force_exit'
      topics: string[]
      actions: Array<{
        at: string
        enforcement: 'inject' | 'author' | 'force_exit'
        code: string
        topic: string
      }>
    }
  }

  // Quality grading
  sentiment?: 'satisfied' | 'neutral' | 'frustrated' | 'irate'
  qualityScore?: number
  qualityAnalysis?: {
    conversationQuality?: string
    patientExperience?: string
    agentPerformance?: string
    issuesDetected?: string[]
  }
  
  // Twilio Insights fields
  fromConnectionType?: string
  fromCountry?: string
  fromCarrier?: string
  toConnectionType?: string
  toCountry?: string
  toCarrier?: string
  whoHungUp?: string
  lastSipResponse?: string
  postDialDelayMs?: number
  callState?: string
  codec?: string
  edgeLocation?: string
  twilioRtpLatencyInbound?: number
  twilioRtpLatencyOutbound?: number
  packetLossDetected?: boolean
  jitterDetected?: boolean
  highPostDialDelay?: boolean
  stirShakenStatus?: string
  stirShakenAttestation?: string
  conferenceSid?: string
  twilioInsightsFetchedAt?: string
  
  // Patient context
  patientFound?: boolean
  patientName?: string
  patientDob?: string
  
  // Call metadata
  agentUsed?: string
  environment?: string
  dialedNumber?: string
  
  // Additional patient context
  preferredLocation?: string
  preferredProvider?: string
  
  // Cost calculation
  costIsEstimated?: boolean
  costCalculatedAt?: string
  costReconciledAt?: string

  // Token usage
  inputAudioTokens?: number
  outputAudioTokens?: number
  inputTextTokens?: number
  outputTextTokens?: number
  inputCachedTokens?: number

  // Ticketing
  ticketNumber?: string
  ticketingSynced?: boolean

  // Escalation
  escalationReason?: string
}

export interface SmsLog {
  id: string
  messageSid?: string
  agentId?: string
  campaignId?: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string
  body: string
  status: string
  createdAt: string
}

export interface CallbackQueueItem {
  id: string
  patientName?: string
  patientPhone: string
  patientDob?: string
  patientEmail?: string
  reason: string
  priority: 'stat' | 'urgent' | 'normal'
  notes?: string
  assignedTo?: string
  assignedAt?: string
  status: 'pending' | 'assigned' | 'completed' | 'cancelled'
  completedAt?: string
  callLogId?: string
  createdAt: string
  updatedAt: string
}

export const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'nova', label: 'Nova' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'sage', label: 'Sage' },
] as const
