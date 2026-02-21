import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AlertTriangle, Phone, Eye, Clock, User } from 'lucide-react'
import type { CallLog } from '@/types'

export function UrgentCallsPage() {
  const navigate = useNavigate()

  const { data: urgentCallsResponse, isLoading, isError } = useQuery({
    queryKey: ['urgent-calls'],
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30000,
    queryFn: async () => {
      const { data } = await apiClient.get<{
        data: CallLog[]
        pagination: {
          page: number
          limit: number
          total: number
          totalPages: number
        }
      }>('/call-logs/urgent?limit=100')
      return data
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-8 w-8 text-red-600" />
          <div>
            <h1 className="text-2xl font-bold">Urgent Calls</h1>
            <p className="text-muted-foreground">Calls transferred to on-call provider</p>
          </div>
        </div>
        <Badge variant="destructive" className="text-lg px-4 py-2">
          {urgentCalls.length} Total
        </Badge>
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
              <p className="text-muted-foreground">No urgent calls yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Calls that are transferred to the on-call provider will appear here
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Caller</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Quality</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {urgentCalls.map((call) => (
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
                          <div className="font-medium">{call.callerName || 'Unknown'}</div>
                          <div className="text-sm text-muted-foreground">{formatPhone(call.from)}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{formatDuration(call.duration)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{call.agentId || 'Greeter'}</Badge>
                    </TableCell>
                    <TableCell>{getQualityBadge(call.qualityScore)}</TableCell>
                    <TableCell className="max-w-xs">
                      <p className="text-sm text-muted-foreground truncate">
                        {call.summary || 'No summary available'}
                      </p>
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
            <strong>Review calls:</strong> Click any row to see full details including 
            the transcript, recording, and AI summary.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
