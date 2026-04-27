import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import apiClient from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AlertTriangle, Phone, Eye, Clock, User, Copy, Check, X, ExternalLink, Link2, Save, CalendarRange } from 'lucide-react'
import type { CallLog } from '@/types'

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function CopyPhoneButton({ phone, formatted }: { phone: string; formatted: string }) {
  const [copied, setCopied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!navigator.clipboard) {
      setFailed(true)
      setTimeout(() => setFailed(false), 2000)
      return
    }
    navigator.clipboard.writeText(phone).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {
        setFailed(true)
        setTimeout(() => setFailed(false), 2000)
      }
    )
  }

  return (
    <button
      onClick={handleCopy}
      title={failed ? 'Copy failed' : 'Copy phone number'}
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors group"
    >
      <span>{formatted}</span>
      {copied && <Check className="h-3 w-3 text-green-600" />}
      {failed && <X className="h-3 w-3 text-red-500" />}
      {!copied && !failed && (
        <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  )
}

function LastUpdatedIndicator({ dataUpdatedAt }: { dataUpdatedAt: number }) {
  const [secondsAgo, setSecondsAgo] = React.useState(0)

  React.useEffect(() => {
    const tick = () => setSecondsAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [dataUpdatedAt])

  const label =
    secondsAgo < 5
      ? 'just now'
      : secondsAgo < 60
      ? `${secondsAgo}s ago`
      : `${Math.floor(secondsAgo / 60)}m ago`

  return (
    <span className="text-xs text-muted-foreground">
      Last updated {label}
    </span>
  )
}

function getEscalationReason(call: CallLog): string | null {
  if (call.escalationReason) return call.escalationReason

  const dc: unknown = call.detectedConditions
  if (!dc) return null

  if (Array.isArray(dc)) {
    const items = dc.filter((item): item is string => typeof item === 'string')
    return items.length > 0 ? items.join(', ') : null
  }

  if (typeof dc === 'object' && dc !== null) {
    const obj = dc as Record<string, unknown>

    if (typeof obj.escalationReason === 'string' && obj.escalationReason) {
      return obj.escalationReason
    }

    if (Array.isArray(obj.conditions)) {
      const items = obj.conditions.filter((item): item is string => typeof item === 'string')
      if (items.length > 0) return items.join(', ')
    }

    const trueKeys = Object.entries(obj)
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim())
    if (trueKeys.length > 0) return trueKeys.join(', ')

    const strVals = Object.values(obj).filter(
      (v): v is string => typeof v === 'string' && v.length > 0
    )
    if (strVals.length > 0) return strVals[0]
  }

  return null
}

function isNoAnswerTransfer(call: CallLog): boolean {
  return !!(call.humanAgentNumber && call.status === 'transferred' && !call.duration)
}

export function UrgentCallsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [portalUrlEdit, setPortalUrlEdit] = React.useState<string | null>(null)
  const [portalUrlSaved, setPortalUrlSaved] = React.useState(false)
  const [portalUrlError, setPortalUrlError] = React.useState<string | null>(null)

  const defaultEnd = React.useMemo(() => new Date(), [])
  const defaultStart = React.useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 90)
    return d
  }, [])

  const [startDate, setStartDate] = React.useState<string>(toDateInputValue(defaultStart))
  const [endDate, setEndDate] = React.useState<string>(toDateInputValue(defaultEnd))

  const { data: urgentCallsResponse, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['urgent-calls', startDate, endDate],
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 15000,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '100', startDate, endDate })
      const { data } = await apiClient.get<{
        data: CallLog[]
        pagination: {
          page: number
          limit: number
          total: number
          totalPages: number
        }
      }>(`/call-logs/urgent?${params.toString()}`)
      return data
    },
  })

  const { data: ticketPortalData } = useQuery({
    queryKey: ['settings-ticket-portal-url'],
    staleTime: 60000,
    queryFn: async () => {
      const { data } = await apiClient.get<{ url: string | null }>('/settings/ticket-portal-url')
      return data
    },
  })

  const ticketPortalUrl: string | null = ticketPortalData?.url ?? null

  const ticketPortalUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      const { data } = await apiClient.put<{ success: boolean; url: string | null }>('/settings/ticket-portal-url', { url })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-ticket-portal-url'] })
      setPortalUrlEdit(null)
      setPortalUrlSaved(true)
      setPortalUrlError(null)
      setTimeout(() => setPortalUrlSaved(false), 3000)
    },
    onError: (err: unknown) => {
      const apiErr = err as { response?: { data?: { error?: string } }; message?: string }
      setPortalUrlError(apiErr?.response?.data?.error || apiErr?.message || 'Failed to save')
    },
  })

  const urgentCalls = React.useMemo(() => {
    if (!urgentCallsResponse?.data) return []
    return urgentCallsResponse.data
  }, [urgentCallsResponse])

  const formatDate = (date?: string) => {
    if (!date) return '-'
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-'
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  }

  const formatPhone = (phone?: string) => {
    if (!phone) return '-'
    const cleaned = phone.replace(/\D/g, '')
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `(${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`
    }
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`
    }
    return phone
  }

  const getQualityBadge = (score?: number) => {
    if (!score) return null
    if (score >= 4) return <Badge className="bg-green-100 text-green-800">Good ({score}/5)</Badge>
    if (score >= 3) return <Badge className="bg-yellow-100 text-yellow-800">Fair ({score}/5)</Badge>
    return <Badge className="bg-red-100 text-red-800">Poor ({score}/5)</Badge>
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-red-600 border-t-transparent" />
      </div>
    )
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-red-500">Error loading urgent calls</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-8 w-8 text-red-600" />
          <div>
            <h1 className="text-2xl font-bold">Urgent Calls</h1>
            <p className="text-muted-foreground">Calls transferred to on-call provider</p>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <div className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="urgent-start-date" className="text-sm whitespace-nowrap">From</Label>
                <Input
                  id="urgent-start-date"
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-36 h-8 text-sm"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="urgent-end-date" className="text-sm whitespace-nowrap">To</Label>
                <Input
                  id="urgent-end-date"
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-36 h-8 text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStartDate(toDateInputValue(defaultStart))
                  setEndDate(toDateInputValue(defaultEnd))
                }}
                className="h-8 text-xs"
              >
                Reset
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {dataUpdatedAt > 0 && <LastUpdatedIndicator dataUpdatedAt={dataUpdatedAt} />}
            <Badge variant="destructive" className="text-lg px-4 py-2">
              {urgentCalls.length} Total
            </Badge>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Recent Urgent Transfers
          </CardTitle>
        </CardHeader>
        <CardContent>
          {urgentCalls.length === 0 ? (
            <div className="py-12 text-center">
              <AlertTriangle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground font-medium">
                No urgent calls from {startDate} to {endDate}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Calls transferred to the on-call provider appear here. An SMS notification is sent each time a new urgent transfer occurs.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Caller</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Escalation Reason</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ticket</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {urgentCalls.map((call) => {
                  const escalationReason = getEscalationReason(call)
                  const noAnswer = isNoAnswerTransfer(call)
                  const ticketHref = (() => {
                    if (!call.ticketNumber || !ticketPortalUrl) return null
                    try {
                      const base = new URL(ticketPortalUrl.replace(/\/$/, ''))
                      if (base.protocol !== 'https:' && base.protocol !== 'http:') return null
                      return `${base.origin}${base.pathname}/tickets/${encodeURIComponent(call.ticketNumber)}`
                    } catch {
                      return null
                    }
                  })()

                  return (
                    <TableRow
                      key={call.id}
                      className="cursor-pointer hover:bg-red-50"
                      onClick={() => navigate(`/call-logs/${call.id}`)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{formatDate(call.startTime)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="font-medium">{call.callerName || formatPhone(call.from)}</div>
                            {call.from && (
                              <CopyPhoneButton
                                phone={call.from}
                                formatted={formatPhone(call.from)}
                              />
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{formatDuration(call.duration)}</TableCell>
                      <TableCell className="max-w-[200px]">
                        {escalationReason ? (
                          <span className="text-sm font-medium text-orange-700 capitalize">
                            {escalationReason}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{call.agentId || 'Greeter'}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {getQualityBadge(call.qualityScore)}
                          {noAnswer && (
                            <Badge className="bg-orange-100 text-orange-800 border-orange-200 w-fit">
                              No Answer
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {call.ticketNumber ? (
                          ticketHref ? (
                            <a
                              href={ticketHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200 transition-colors"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {call.ticketNumber}
                            </a>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/call-logs/${call.id}`)
                              }}
                              title="View call details and ticket"
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200 transition-colors cursor-pointer"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {call.ticketNumber}
                            </button>
                          )
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/call-logs/${call.id}`)
                          }}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-blue-500" />
              Ticketing System URL
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Base URL for your ticketing portal. When configured, ticket badges link directly to the ticket in a new tab.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[260px]">
                <label className="text-xs text-muted-foreground block mb-1">Portal base URL (e.g. https://tickets.example.com)</label>
                <input
                  type="url"
                  placeholder={ticketPortalUrl ?? 'Not configured'}
                  value={portalUrlEdit ?? (ticketPortalUrl || '')}
                  onChange={(e) => {
                    setPortalUrlSaved(false)
                    setPortalUrlError(null)
                    setPortalUrlEdit(e.target.value)
                  }}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                onClick={() => {
                  const val = portalUrlEdit ?? ''
                  ticketPortalUrlMutation.mutate(val)
                }}
                disabled={
                  ticketPortalUrlMutation.isPending ||
                  portalUrlEdit === null ||
                  (portalUrlEdit || '') === (ticketPortalUrl || '')
                }
                className="flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {ticketPortalUrlMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
            {ticketPortalUrl && portalUrlEdit === null && (
              <p className="mt-2 text-xs text-muted-foreground">
                Current: <span className="font-mono">{ticketPortalUrl}</span>
              </p>
            )}
            {portalUrlSaved && (
              <div className="mt-2 flex items-center gap-2 text-sm text-green-600">
                <Check className="h-4 w-4" />
                Ticketing portal URL saved.
              </div>
            )}
            {portalUrlError && (
              <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                <X className="h-4 w-4" />
                {portalUrlError}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>About Urgent Calls</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong>What triggers an urgent transfer?</strong> The triage agent transfers calls
            when it detects red-flag symptoms like sudden vision loss, flashes with floaters,
            chemical exposure, eye trauma, or post-surgery complications with vision changes.
          </p>
          <p>
            <strong>SMS Notifications:</strong> When configured, an SMS is sent to the
            notification number each time an urgent call is transferred.
          </p>
          <p>
            <strong>Date range:</strong> Use the date pickers at the top of the page to choose any
            start and end date. The default range is the last 90 days.
          </p>
          <p>
            <strong>Review calls:</strong> Click any row to see full details including
            the transcript, recording, and AI summary.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
