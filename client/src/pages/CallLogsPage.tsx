import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import apiClient from '@/lib/apiClient'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Phone, Search, Eye, X, ChevronLeft, ChevronRight, Ticket, UserCheck, ArrowDownLeft, ArrowUpRight, FileText, Mic } from 'lucide-react'
import type { CallLog } from '@/types'

interface CallLogsResponse {
  data: CallLog[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export function CallLogsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || 'all'
  const direction = searchParams.get('direction') || 'all'
  const hasTicket = searchParams.get('hasTicket') || 'all'
  const transferred = searchParams.get('transferred') || 'all'
  const callQuality = searchParams.get('callQuality') || 'all'
  const page = parseInt(searchParams.get('page') || '1')
  const limit = 50

  const [searchInput, setSearchInput] = useState(search)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setSearchInput(search)
  }, [search])

  const updateParams = useCallback((updates: Record<string, string | number | undefined>) => {
    const newParams = new URLSearchParams(searchParams)
    Object.entries(updates).forEach(([key, value]) => {
      if (value === undefined || value === '' || value === 'all') {
        newParams.delete(key)
      } else {
        newParams.set(key, String(value))
      }
    })
    if (updates.page === undefined && !('page' in updates)) {
      newParams.delete('page')
    }
    setSearchParams(newParams, { replace: true })
  }, [searchParams, setSearchParams])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    
    debounceTimerRef.current = setTimeout(() => {
      updateParams({ search: value, page: 1 })
    }, 400)
  }, [updateParams])

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams()
    params.set('page', page.toString())
    params.set('limit', limit.toString())
    if (search) params.set('search', search)
    if (status !== 'all') params.set('status', status)
    if (direction !== 'all') params.set('direction', direction)
    if (hasTicket !== 'all') params.set('hasTicket', hasTicket)
    if (transferred !== 'all') params.set('transferred', transferred)
    if (callQuality !== 'all') params.set('callQuality', callQuality)
    return params.toString()
  }, [page, limit, search, status, direction, hasTicket, transferred, callQuality])

  const { data: callLogsResponse, isLoading, isError, error } = useQuery({
    queryKey: ['call-logs', page, search, status, direction, hasTicket, transferred, callQuality],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async () => {
      const { data } = await apiClient.get<CallLogsResponse>(`/call-logs?${buildQueryString()}`)
      return data
    },
  })

  const callLogs = useMemo(() => {
    if (!callLogsResponse?.data || !Array.isArray(callLogsResponse.data)) return []
    return callLogsResponse.data
  }, [callLogsResponse])

  const pagination = callLogsResponse?.pagination

  const clearFilters = () => {
    setSearchParams({}, { replace: true })
  }

  const hasActiveFilters = search || status !== 'all' || direction !== 'all' || hasTicket !== 'all' || transferred !== 'all' || callQuality !== 'all'

  const getStatusVariant = (callStatus: string) => {
    switch (callStatus) {
      case 'completed':
        return 'default'
      case 'failed':
      case 'no_answer':
      case 'busy':
        return 'destructive'
      case 'in_progress':
      case 'ringing':
        return 'secondary'
      default:
        return 'outline'
    }
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-'
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Call Logs</h1>
          <p className="text-muted-foreground">View all call history and transcripts</p>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-destructive font-medium">Failed to load call logs</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Please try refreshing the page'}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Call Logs</h1>
          <p className="text-muted-foreground">
            {pagination ? `${pagination.total.toLocaleString()} total calls` : 'View all call history and transcripts'}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
                <Search className="h-5 w-5 text-muted-foreground" />
                <Input
                  placeholder="Search phone, name, or ticket..."
                  value={searchInput}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="flex-1"
                />
              </div>
              
              <Select 
                value={status} 
                onChange={(e) => updateParams({ status: e.target.value, page: 1 })}
                className="w-[140px]"
              >
                <option value="all">All Status</option>
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="failed">Failed</option>
                <option value="no_answer">No Answer</option>
                <option value="busy">Busy</option>
              </Select>

              <Select 
                value={direction} 
                onChange={(e) => updateParams({ direction: e.target.value, page: 1 })}
                className="w-[140px]"
              >
                <option value="all">All Directions</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </Select>

              <Select 
                value={hasTicket} 
                onChange={(e) => updateParams({ hasTicket: e.target.value, page: 1 })}
                className="w-[140px]"
              >
                <option value="all">All Tickets</option>
                <option value="true">Has Ticket</option>
                <option value="false">No Ticket</option>
              </Select>

              <Select 
                value={transferred} 
                onChange={(e) => updateParams({ transferred: e.target.value, page: 1 })}
                className="w-[140px]"
              >
                <option value="all">All Calls</option>
                <option value="true">Transferred</option>
                <option value="false">Not Transferred</option>
              </Select>

              <Select 
                value={callQuality} 
                onChange={(e) => updateParams({ callQuality: e.target.value, page: 1 })}
                className="w-[150px]"
              >
                <option value="all">All Quality</option>
                <option value="real">Real Calls</option>
                <option value="ghost">Ghost Calls</option>
              </Select>

              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          {callLogs.length === 0 ? (
            <div className="py-12 text-center">
              <Phone className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">
                {hasActiveFilters ? 'No matching calls found' : 'No calls yet'}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-md border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Direction</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Media</TableHead>
                      <TableHead>Ticket</TableHead>
                      <TableHead>Patient</TableHead>
                      <TableHead className="w-[80px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {callLogs.map((log) => (
                      <TableRow
                        key={log.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => navigate(`/call-logs/${log.id}`)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {log.direction === 'inbound' ? (
                              <ArrowDownLeft className="h-4 w-4 text-emerald-500" />
                            ) : (
                              <ArrowUpRight className="h-4 w-4 text-primary" />
                            )}
                            <span className="text-xs text-muted-foreground capitalize">{log.direction || '-'}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>
                            <div className="font-medium text-foreground">{log.from || '-'}</div>
                            {log.callerName && (
                              <div className="text-sm text-muted-foreground">{log.callerName}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-foreground">{log.to || '-'}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(log.createdAt)}
                        </TableCell>
                        <TableCell className="text-foreground">{formatDuration(log.duration)}</TableCell>
                        <TableCell>
                          <Badge variant={getStatusVariant(log.status || '')}>
                            {log.status || 'unknown'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span title={log.transcript ? "Transcript available" : "No transcript"}>
                              <FileText className={`h-4 w-4 ${log.transcript ? 'text-emerald-500' : 'text-muted-foreground/30'}`} />
                            </span>
                            <span title={log.recordingUrl ? "Recording available" : "No recording"}>
                              <Mic className={`h-4 w-4 ${log.recordingUrl ? 'text-primary' : 'text-muted-foreground/30'}`} />
                            </span>
                            <span title={log.transferredToHuman ? "Transferred to human" : "No transfer"}>
                              <UserCheck className={`h-4 w-4 ${log.transferredToHuman ? 'text-orange-500' : 'text-muted-foreground/30'}`} />
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {(log as any).ticketNumber ? (
                            <div className="flex items-center gap-1 text-sm">
                              <Ticket className="h-3 w-3 text-purple-500" />
                              <span className="text-purple-500">{(log as any).ticketNumber}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="font-medium text-emerald-500">
                            {(log as any).patientName || (log as any).callerName || '-'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/call-logs/${log.id}`)
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {pagination && pagination.totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Showing {((page - 1) * limit) + 1} to {Math.min(page * limit, pagination.total)} of {pagination.total} calls
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => updateParams({ page: page - 1 })}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {page} of {pagination.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= pagination.totalPages}
                      onClick={() => updateParams({ page: page + 1 })}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
