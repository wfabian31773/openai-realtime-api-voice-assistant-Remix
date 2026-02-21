import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
import { Phone, PhoneCall, Activity, Trash2 } from 'lucide-react'
import type { CallLog } from '@/types'

export function LiveCallsPage() {
  const [currentTime, setCurrentTime] = useState(Date.now())
  const queryClient = useQueryClient()

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const { data: activeCalls = [], isLoading, isError, error } = useQuery({
    queryKey: ['active-calls'],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        data: CallLog[]
      }>('/call-logs?status=in_progress,ringing,initiated&limit=100')
      
      return data.data || []
    },
    refetchInterval: 3000,
  })

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{ message: string; cleaned: number }>('/call-logs/cleanup-stale')
      return data
    },
    onSuccess: (data) => {
      alert(`✓ ${data.message}`)
      queryClient.invalidateQueries({ queryKey: ['active-calls'] })
    },
    onError: (error: any) => {
      alert(`✗ Cleanup failed: ${error.message}`)
    },
  })

  const calculateDuration = (startTime?: string, createdAt?: string) => {
    const timeRef = startTime || createdAt
    if (!timeRef) return '0:00'
    const start = new Date(timeRef).getTime()
    const now = currentTime
    const diffSeconds = Math.floor((now - start) / 1000)
    const mins = Math.floor(diffSeconds / 60)
    const secs = diffSeconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'ringing':
        return 'warning'
      case 'in_progress':
        return 'success'
      case 'initiated':
        return 'secondary'
      default:
        return 'default'
    }
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
          <h1 className="text-3xl font-bold text-foreground">Live Call Monitor</h1>
          <p className="text-muted-foreground">Real-time view of active calls</p>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-red-600 font-medium">Failed to load active calls</p>
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
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground">Live Call Monitor</h1>
            <div className="flex items-center gap-2 rounded-full bg-green-100 px-3 py-1">
              <Activity className="h-4 w-4 text-green-600 animate-pulse" />
              <span className="text-sm font-medium text-green-700">LIVE</span>
            </div>
          </div>
          <p className="text-muted-foreground mt-1">Real-time view of active calls (auto-refreshes every 3s)</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-2xl font-bold text-blue-600">{activeCalls.length}</p>
            <p className="text-sm text-muted-foreground">Active Call{activeCalls.length !== 1 ? 's' : ''}</p>
          </div>
          {activeCalls.length > 0 && (
            <Button
              onClick={() => cleanupMutation.mutate()}
              disabled={cleanupMutation.isPending}
              variant="outline"
              size="sm"
              className="text-orange-600 border-orange-600 hover:bg-orange-50"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {cleanupMutation.isPending ? 'Cleaning...' : 'Cleanup Stale'}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Calls</CardTitle>
        </CardHeader>
        <CardContent>
          {activeCalls.length === 0 ? (
            <div className="py-12 text-center">
              <PhoneCall className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-3 text-muted-foreground font-medium">No active calls</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Calls will appear here when agents are on the phone
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Call SID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Started At</TableHead>
                    <TableHead>Age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeCalls.map((call) => {
                    const timeRef = call.startTime || call.createdAt;
                    const ageMinutes = timeRef
                      ? Math.floor((currentTime - new Date(timeRef).getTime()) / 60000)
                      : 0;
                    const isStale = ageMinutes > 5;
                    
                    return (
                      <TableRow 
                        key={call.id} 
                        className={isStale ? 'bg-orange-50' : ''}
                      >
                        <TableCell className="font-mono text-xs">
                          {call.callSid ? (
                            <span className="text-blue-600" title={call.callSid}>
                              {call.callSid.substring(0, 12)}...
                            </span>
                          ) : (
                            <span className="text-muted-foreground">No SID</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={getStatusBadgeVariant(call.status)}>
                            {call.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{call.direction}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">{call.from}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">{call.to}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${isStale ? 'bg-orange-500' : 'bg-red-600'} animate-pulse`} />
                            <span className="font-mono text-sm font-medium">
                              {calculateDuration(call.startTime, call.createdAt)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {timeRef ? new Date(timeRef).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell>
                          <span className={`text-xs font-medium ${isStale ? 'text-orange-600' : 'text-muted-foreground'}`}>
                            {ageMinutes}m ago
                            {isStale && <span className="ml-1">⚠️</span>}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Initiated</p>
              <p className="text-2xl font-bold text-muted-foreground">
                {activeCalls.filter(c => c.status === 'initiated').length}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Ringing</p>
              <p className="text-2xl font-bold text-yellow-600">
                {activeCalls.filter(c => c.status === 'ringing').length}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">In Progress</p>
              <p className="text-2xl font-bold text-green-600">
                {activeCalls.filter(c => c.status === 'in_progress').length}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Active</p>
              <p className="text-2xl font-bold text-blue-600">
                {activeCalls.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
