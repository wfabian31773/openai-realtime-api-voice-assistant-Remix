import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useRef, useState } from 'react'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Download, Play, Pause, DollarSign, Star, ThumbsUp, ThumbsDown, Meh, AlertCircle, Sparkles, Loader2, ChevronDown, ChevronUp, Phone, Signal, RefreshCw } from 'lucide-react'
import type { CallLog } from '@/types'

interface RecordingData {
  url: string
  duration: number
  sid: string
  dateCreated: string
}

interface CallReviewResult {
  overallAssessment: string;
  conversationFlowIssues: {
    issue: string;
    timestamp?: string;
    severity: 'minor' | 'moderate' | 'major';
    suggestion: string;
  }[];
  promptImprovements: {
    area: string;
    currentBehavior: string;
    suggestedChange: string;
    expectedImpact: string;
  }[];
  positives: string[];
  naturalness: number;
  efficiency: number;
  patientExperience: number;
}

export function CallDetailsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isPlaying, setIsPlaying] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [reviewResult, setReviewResult] = useState<CallReviewResult | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const { data: callLog, isLoading } = useQuery({
    queryKey: ['call-log', id],
    queryFn: async () => {
      const { data } = await apiClient.get<CallLog>(`/call-logs/${id}`)
      return data
    },
    enabled: !!id,
  })

  // Fetch recording from Twilio dynamically
  const { data: recording, isLoading: recordingLoading } = useQuery({
    queryKey: ['recording', id],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<RecordingData>(`/call-logs/${id}/recording`)
        return data
      } catch (error: any) {
        if (error.response?.status === 404) {
          return null
        }
        throw error
      }
    },
    enabled: !!id && !!callLog?.callSid,
    retry: false,
  })

  const reviewMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{ success: boolean; review: CallReviewResult }>(`/call-logs/${id}/review`)
      return data.review
    },
    onSuccess: (data) => {
      setReviewResult(data)
      setShowReview(true)
    }
  })

  const insightsMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post(`/call-logs/${id}/fetch-insights`)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['call-log', id] })
    }
  })

  const formatDate = (date?: string) => {
    if (!date) return '-'
    return new Date(date).toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  }

  const formatTime = (date?: string) => {
    if (!date) return '-'
    return new Date(date).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-'
    return `${seconds} sec`
  }

  const togglePlayPause = () => {
    if (!audioRef.current) return
    
    if (isPlaying) {
      audioRef.current.pause()
    } else {
      audioRef.current.play()
    }
    setIsPlaying(!isPlaying)
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!callLog) {
    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          onClick={() => navigate('/call-logs')}
          className="mb-4"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Call Logs
        </Button>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Call log not found</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          onClick={() => navigate('/call-logs')}
          size="sm"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-foreground">Call Details</h1>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Properties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Call SID</p>
              <p className="font-mono text-sm">{callLog.callSid || callLog.id}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Date</p>
              <p className="text-sm">{formatDate(callLog.startTime)}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Start Time</p>
                <p className="text-sm">{formatTime(callLog.startTime)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">End Time</p>
                <p className="text-sm">{formatTime(callLog.endTime)}</p>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Duration</p>
              <p className="text-sm">{formatDuration(callLog.duration)}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">From</p>
                <p className="text-sm">{callLog.from}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">To</p>
                <p className="text-sm">{callLog.to}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Direction</p>
                <Badge variant="outline" className="mt-1">
                  {callLog.direction}
                </Badge>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Type</p>
                <p className="text-sm">Phone</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Status</p>
                <Badge 
                  variant={callLog.status === 'completed' ? 'success' : 'default'}
                  className="mt-1"
                >
                  {callLog.status}
                </Badge>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Transferred Status</p>
                <p className="text-sm">
                  {callLog.transferredToHuman ? (
                    <span className="text-primary">Transferred to Human</span>
                  ) : (
                    '-'
                  )}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Call Recording</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {recordingLoading ? (
              <div className="py-8 text-center">
                <div className="mx-auto h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <p className="mt-2 text-sm text-muted-foreground">Fetching recording from Twilio...</p>
              </div>
            ) : recording ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Recording SID</p>
                    <p className="font-mono text-xs text-primary break-all">
                      {recording.sid}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Duration</p>
                    <p className="text-sm">{recording.duration} seconds</p>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Created</p>
                  <p className="text-sm">{formatDate(recording.dateCreated)}</p>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">Download</p>
                  <div className="flex gap-2">
                    <a
                      href={recording.url}
                      download
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <Download className="h-4 w-4" />
                      Download MP3
                    </a>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">Listen</p>
                  <div className="flex items-center gap-3 rounded-lg border bg-muted p-3">
                    <button
                      onClick={togglePlayPause}
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white hover:bg-primary/90 transition-colors"
                    >
                      {isPlaying ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </button>
                    <div className="flex-1">
                      <audio
                        ref={audioRef}
                        src={recording.url}
                        onEnded={() => setIsPlaying(false)}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        className="w-full"
                        controls
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No recording available</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {!callLog.callSid 
                    ? 'No Call SID available for this call'
                    : 'Recording may still be processing or was not enabled'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Twilio Insights Summary */}
      {(callLog.fromCarrier || callLog.whoHungUp || callLog.twilioInsightsFetchedAt || callLog.callSid) && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Phone className="h-5 w-5 text-primary" />
                Insights Summary
              </CardTitle>
              {callLog.callSid && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => insightsMutation.mutate()}
                  disabled={insightsMutation.isPending}
                >
                  {insightsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Refresh
                    </>
                  )}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* FROM endpoint info */}
              <div className="rounded-lg border bg-primary/10 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">FROM: {callLog.from}</p>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Connection</p>
                    <p className="font-medium">{callLog.fromConnectionType || 'unknown'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Country</p>
                    <p className="font-medium">{callLog.fromCountry || 'US'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Carrier</p>
                    <p className="font-medium truncate" title={callLog.fromCarrier}>
                      {callLog.fromCarrier || '-'}
                    </p>
                  </div>
                </div>
              </div>

              {/* TO endpoint info */}
              <div className="rounded-lg border bg-emerald-500/10 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">TO: {callLog.to}</p>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Connection</p>
                    <p className="font-medium">{callLog.toConnectionType || 'voip'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Country</p>
                    <p className="font-medium">{callLog.toCountry || 'US'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Carrier</p>
                    <p className="font-medium">{callLog.toCarrier || 'Twilio'}</p>
                  </div>
                </div>
              </div>

              {/* Properties */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">PROPERTIES</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Who Hung Up</p>
                    <p className="font-medium">{callLog.whoHungUp || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last SIP Response</p>
                    <p className="font-medium">{callLog.lastSipResponse || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Post-Dial Delay</p>
                    <p className="font-medium">
                      {callLog.postDialDelayMs !== undefined 
                        ? `${(callLog.postDialDelayMs / 1000).toFixed(3)} seconds`
                        : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Call State</p>
                    <p className="font-medium">{callLog.callState || callLog.status}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Signal className="h-5 w-5 text-green-600" />
                Quality Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Metrics grid */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Codec</p>
                  <p className="font-medium">{callLog.codec || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Edge Location</p>
                  <p className="font-medium">{callLog.edgeLocation || '-'}</p>
                </div>
                {callLog.twilioRtpLatencyInbound && (
                  <div>
                    <p className="text-xs text-muted-foreground">RTP Latency (ms)</p>
                    <p className="font-medium">
                      {callLog.twilioRtpLatencyInbound}/{callLog.twilioRtpLatencyOutbound || callLog.twilioRtpLatencyInbound}
                    </p>
                  </div>
                )}
              </div>

              {/* Quality Flags */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">QUALITY FLAGS</p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={callLog.packetLossDetected ? 'destructive' : 'secondary'}>
                    Packet Loss: {callLog.packetLossDetected ? 'Yes' : 'No'}
                  </Badge>
                  <Badge variant={callLog.jitterDetected ? 'destructive' : 'secondary'}>
                    Jitter: {callLog.jitterDetected ? 'Yes' : 'No'}
                  </Badge>
                  <Badge variant={callLog.highPostDialDelay ? 'warning' : 'secondary'}>
                    High PDD: {callLog.highPostDialDelay ? 'Yes' : 'No'}
                  </Badge>
                </div>
              </div>

              {/* STIR/SHAKEN */}
              {callLog.stirShakenStatus && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">STIR/SHAKEN</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Status</p>
                      <Badge variant={callLog.stirShakenStatus === 'verified' ? 'success' : 'secondary'}>
                        {callLog.stirShakenStatus}
                      </Badge>
                    </div>
                    {callLog.stirShakenAttestation && (
                      <div>
                        <p className="text-xs text-muted-foreground">Attestation</p>
                        <p className="font-medium">{callLog.stirShakenAttestation}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Conference Info */}
              {callLog.conferenceSid && (
                <div>
                  <p className="text-xs text-muted-foreground">Conference SID</p>
                  <p className="font-mono text-xs text-primary break-all">{callLog.conferenceSid}</p>
                </div>
              )}

              {/* Insights fetch timestamp */}
              {callLog.twilioInsightsFetchedAt && (
                <p className="text-xs text-muted-foreground mt-2">
                  Insights fetched: {formatDate(callLog.twilioInsightsFetchedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Call Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Agent</p>
              <p className="text-sm">{callLog.agentUsed || (callLog.agentId ? `ID: ${callLog.agentId}` : '-')}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Environment</p>
              <Badge variant={callLog.environment === 'production' ? 'default' : 'secondary'}>
                {callLog.environment || 'unknown'}
              </Badge>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Campaign</p>
              <p className="text-sm">{callLog.campaignId ? `Campaign ID: ${callLog.campaignId}` : '-'}</p>
            </div>
          </div>
          {callLog.callerName && (
            <div>
              <p className="text-sm font-medium text-muted-foreground">Caller Name</p>
              <p className="text-sm">{callLog.callerName}</p>
            </div>
          )}
          {callLog.humanAgentNumber && (
            <div>
              <p className="text-sm font-medium text-muted-foreground">Human Agent Number</p>
              <p className="text-sm">{callLog.humanAgentNumber}</p>
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-muted-foreground">Created At</p>
            <p className="text-sm">{formatDate(callLog.createdAt)}</p>
          </div>
          {callLog.dialedNumber && (
            <div>
              <p className="text-sm font-medium text-muted-foreground">Dialed Number (Office)</p>
              <p className="text-sm">{callLog.dialedNumber}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Patient Context Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Patient Context
            {callLog.patientFound ? (
              <Badge variant="default" className="bg-green-600">Found in System</Badge>
            ) : (
              <Badge variant="secondary">New Patient</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {callLog.patientFound ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Patient Name</p>
                  <p className="text-sm font-semibold">{callLog.patientName || '-'}</p>
                </div>
                {callLog.patientDob && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">DOB</p>
                    <p className="text-sm">{callLog.patientDob}</p>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                {callLog.preferredLocation && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Preferred Location</p>
                    <p className="text-sm">{callLog.preferredLocation}</p>
                  </div>
                )}
                {callLog.preferredProvider && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Preferred Provider</p>
                    <p className="text-sm">{callLog.preferredProvider}</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No patient record found for caller phone number. This may be a new patient or they're calling from a different number.</p>
          )}
        </CardContent>
      </Card>

      {/* Cost and Quality Section */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Cost Breakdown Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-green-600" />
              Cost Breakdown
              {callLog.costIsEstimated && (
                <Badge variant="warning" className="ml-2">Estimated</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {callLog.totalCostCents !== undefined && callLog.totalCostCents !== null ? (
              <>
                <div className="flex items-center justify-between border-b pb-3">
                  <span className="text-lg font-semibold text-foreground">Total Cost</span>
                  <span className="text-2xl font-bold text-green-600">
                    ${(callLog.totalCostCents / 100).toFixed(2)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-lg bg-blue-50 dark:bg-blue-950 p-3">
                    <p className="text-xs font-medium text-blue-700 dark:text-blue-300">Twilio</p>
                    <p className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                      ${((callLog.twilioCostCents || 0) / 100).toFixed(2)}
                    </p>
                    {callLog.costIsEstimated && (
                      <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">Pending reconciliation</p>
                    )}
                  </div>
                  <div className="rounded-lg bg-purple-50 dark:bg-purple-950 p-3">
                    <p className="text-xs font-medium text-purple-700 dark:text-purple-300">OpenAI</p>
                    <p className="text-lg font-semibold text-purple-900 dark:text-purple-100">
                      ${((callLog.openaiCostCents || 0) / 100).toFixed(2)}
                    </p>
                  </div>
                </div>
                {(callLog.audioInputMinutes || callLog.audioOutputMinutes) && (
                  <div className="text-sm text-muted-foreground">
                    <p>Audio Input: {(callLog.audioInputMinutes || 0).toFixed(1)} min</p>
                    <p>Audio Output: {(callLog.audioOutputMinutes || 0).toFixed(1)} min</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Cost per minute: ${callLog.duration && callLog.totalCostCents 
                        ? ((callLog.totalCostCents / 100) / (callLog.duration / 60)).toFixed(2)
                        : '-'}
                    </p>
                  </div>
                )}
                {callLog.costCalculatedAt && (
                  <p className="text-xs text-muted-foreground">
                    Cost calculated: {formatDate(callLog.costCalculatedAt)}
                  </p>
                )}
              </>
            ) : (
              <div className="py-6 text-center">
                <DollarSign className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Cost data not available</p>
                <p className="text-xs text-muted-foreground">Costs are calculated after call completion</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quality Grading Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              Quality Grade
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {callLog.qualityScore !== undefined && callLog.qualityScore !== null ? (
              <>
                <div className="flex items-center justify-between border-b pb-3">
                  <span className="text-lg font-semibold text-foreground">Quality Score</span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`h-6 w-6 ${
                          star <= (callLog.qualityScore || 0)
                            ? 'fill-yellow-400 text-yellow-400'
                            : 'text-muted-foreground'
                        }`}
                      />
                    ))}
                    <span className="ml-2 text-xl font-bold text-foreground">
                      {callLog.qualityScore}/5
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Patient Sentiment</p>
                  <div className="mt-1 flex items-center gap-2">
                    {callLog.sentiment === 'satisfied' && (
                      <>
                        <ThumbsUp className="h-5 w-5 text-green-500" />
                        <Badge variant="success">Satisfied</Badge>
                      </>
                    )}
                    {callLog.sentiment === 'neutral' && (
                      <>
                        <Meh className="h-5 w-5 text-muted-foreground" />
                        <Badge variant="secondary">Neutral</Badge>
                      </>
                    )}
                    {callLog.sentiment === 'frustrated' && (
                      <>
                        <ThumbsDown className="h-5 w-5 text-orange-500" />
                        <Badge variant="warning">Frustrated</Badge>
                      </>
                    )}
                    {callLog.sentiment === 'irate' && (
                      <>
                        <AlertCircle className="h-5 w-5 text-red-500" />
                        <Badge variant="destructive">Irate</Badge>
                      </>
                    )}
                    {!callLog.sentiment && (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </div>
                </div>
                {callLog.qualityAnalysis && (
                  <div className="space-y-3 rounded-lg bg-muted p-3 text-sm">
                    {callLog.qualityAnalysis.conversationQuality && (
                      <div>
                        <p className="font-medium text-foreground">Conversation Quality</p>
                        <p className="text-muted-foreground">{callLog.qualityAnalysis.conversationQuality}</p>
                      </div>
                    )}
                    {callLog.qualityAnalysis.patientExperience && (
                      <div>
                        <p className="font-medium text-foreground">Patient Experience</p>
                        <p className="text-muted-foreground">{callLog.qualityAnalysis.patientExperience}</p>
                      </div>
                    )}
                    {callLog.qualityAnalysis.agentPerformance && (
                      <div>
                        <p className="font-medium text-foreground">Agent Performance</p>
                        <p className="text-muted-foreground">{callLog.qualityAnalysis.agentPerformance}</p>
                      </div>
                    )}
                    {callLog.qualityAnalysis.issuesDetected && callLog.qualityAnalysis.issuesDetected.length > 0 && (
                      <div>
                        <p className="font-medium text-red-700">Issues Detected</p>
                        <ul className="list-disc list-inside text-red-600">
                          {callLog.qualityAnalysis.issuesDetected.map((issue, idx) => (
                            <li key={idx}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="py-6 text-center">
                <Star className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Quality grade not available</p>
                <p className="text-xs text-muted-foreground">Calls are graded after completion with transcript</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {callLog.transcript && (
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 overflow-y-auto rounded-lg border bg-muted p-4">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                {callLog.transcript}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}

      {callLog.transcript && (
        <Card className="border-purple-200 bg-purple-50/30">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-600" />
              AI Call Review
            </CardTitle>
            {!reviewResult && (
              <Button
                onClick={() => reviewMutation.mutate()}
                disabled={reviewMutation.isPending}
                className="bg-purple-600 hover:bg-purple-700"
              >
                {reviewMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Analyze for Improvements
                  </>
                )}
              </Button>
            )}
            {reviewResult && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowReview(!showReview)}
              >
                {showReview ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {reviewMutation.isError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                Failed to analyze call. Please try again.
              </div>
            )}
            
            {!reviewResult && !reviewMutation.isPending && !reviewMutation.isError && (
              <p className="text-sm text-muted-foreground">
                Use AI to analyze this call and get suggestions for improving the agent's prompts and conversation flow.
              </p>
            )}

            {reviewResult && showReview && (
              <div className="space-y-6">
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-lg border bg-white p-3 text-center">
                    <div className="text-2xl font-bold text-purple-600">{reviewResult.naturalness}/10</div>
                    <div className="text-xs text-muted-foreground">Naturalness</div>
                  </div>
                  <div className="rounded-lg border bg-white p-3 text-center">
                    <div className="text-2xl font-bold text-primary">{reviewResult.efficiency}/10</div>
                    <div className="text-xs text-muted-foreground">Efficiency</div>
                  </div>
                  <div className="rounded-lg border bg-white p-3 text-center">
                    <div className="text-2xl font-bold text-green-600">{reviewResult.patientExperience}/10</div>
                    <div className="text-xs text-muted-foreground">Patient Experience</div>
                  </div>
                </div>

                <div className="rounded-lg border bg-white p-4">
                  <h4 className="mb-2 font-semibold text-foreground">Overall Assessment</h4>
                  <p className="text-sm text-foreground">{reviewResult.overallAssessment}</p>
                </div>

                {reviewResult.positives.length > 0 && (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                    <h4 className="mb-2 font-semibold text-green-800">What Went Well</h4>
                    <ul className="list-inside list-disc space-y-1 text-sm text-green-700">
                      {reviewResult.positives.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {reviewResult.conversationFlowIssues.length > 0 && (
                  <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
                    <h4 className="mb-3 font-semibold text-orange-800">Conversation Flow Issues</h4>
                    <div className="space-y-3">
                      {reviewResult.conversationFlowIssues.map((issue, i) => (
                        <div key={i} className="rounded border border-orange-100 bg-white p-3">
                          <div className="mb-1 flex items-center gap-2">
                            <Badge variant={issue.severity === 'major' ? 'destructive' : issue.severity === 'moderate' ? 'warning' : 'secondary'}>
                              {issue.severity}
                            </Badge>
                            {issue.timestamp && <span className="text-xs text-muted-foreground">{issue.timestamp}</span>}
                          </div>
                          <p className="mb-2 text-sm font-medium text-foreground">{issue.issue}</p>
                          <p className="text-sm text-muted-foreground"><span className="font-medium">Suggestion:</span> {issue.suggestion}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {reviewResult.promptImprovements.length > 0 && (
                  <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
                    <h4 className="mb-3 font-semibold text-purple-800">Prompt Improvements</h4>
                    <div className="space-y-4">
                      {reviewResult.promptImprovements.map((imp, i) => (
                        <div key={i} className="rounded border border-purple-100 bg-white p-3">
                          <div className="mb-1 text-sm font-semibold text-purple-700">{imp.area}</div>
                          <div className="mb-2 text-sm">
                            <span className="font-medium text-foreground">Current:</span>{' '}
                            <span className="text-muted-foreground">{imp.currentBehavior}</span>
                          </div>
                          <div className="mb-2 rounded bg-purple-100 p-2 text-sm">
                            <span className="font-medium text-purple-800">Suggested Change:</span>{' '}
                            <span className="text-purple-700">{imp.suggestedChange}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <span className="font-medium">Expected Impact:</span> {imp.expectedImpact}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {callLog.summary && (
        <Card>
          <CardHeader>
            <CardTitle>Call Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-blue-50 p-4">
              <p className="text-sm">{callLog.summary}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {callLog.detectedConditions && Object.keys(callLog.detectedConditions).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Detected Conditions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-yellow-50 p-4">
              <pre className="text-sm">{JSON.stringify(callLog.detectedConditions, null, 2)}</pre>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
