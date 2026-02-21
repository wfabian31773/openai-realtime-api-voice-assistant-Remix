import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
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
import { UserCheck, CheckCircle, AlertCircle } from 'lucide-react'
import type { CallbackQueueItem } from '@/types'

export function CallbackQueuePage() {
  const { user } = useAuth()
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showCompleteDialog, setShowCompleteDialog] = useState(false)
  const [selectedCallback, setSelectedCallback] = useState<CallbackQueueItem | null>(
    null
  )

  const { data: callbacks, isLoading } = useQuery({
    queryKey: ['callback-queue', statusFilter],
    queryFn: async () => {
      const url =
        statusFilter === 'all'
          ? '/callback-queue'
          : `/callback-queue?status=${statusFilter}`
      const { data } = await apiClient.get<CallbackQueueItem[]>(url)
      return data
    },
  })

  const updateCallbackMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string
      data: Partial<CallbackQueueItem>
    }) => {
      const response = await apiClient.patch(`/callback-queue/${id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['callback-queue'] })
      addToast({
        title: 'Success',
        description: 'Callback updated successfully',
        variant: 'success',
      })
    },
    onError: () => {
      addToast({
        title: 'Error',
        description: 'Failed to update callback',
        variant: 'destructive',
      })
    },
  })

  const handleAssignToMe = (callback: CallbackQueueItem) => {
    updateCallbackMutation.mutate({
      id: callback.id,
      data: {
        status: 'assigned',
        assignedTo: user?.id,
      },
    })
  }

  const handleMarkComplete = () => {
    if (!selectedCallback) return
    updateCallbackMutation.mutate({
      id: selectedCallback.id,
      data: {
        status: 'completed',
        completedAt: new Date().toISOString(),
      },
    })
    setShowCompleteDialog(false)
    setSelectedCallback(null)
  }

  const getPriorityVariant = (priority: string) => {
    switch (priority) {
      case 'stat':
        return 'destructive'
      case 'urgent':
        return 'warning'
      default:
        return 'info'
    }
  }

  const getPriorityIcon = (priority: string) => {
    if (priority === 'stat' || priority === 'urgent') {
      return <AlertCircle className="h-4 w-4" />
    }
    return null
  }

  const sortedCallbacks = [...(callbacks || [])].sort((a, b) => {
    const priorityOrder = { stat: 0, urgent: 1, normal: 2 }
    return (
      priorityOrder[a.priority as keyof typeof priorityOrder] -
      priorityOrder[b.priority as keyof typeof priorityOrder]
    )
  })

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
          <h1 className="text-3xl font-bold text-foreground">Callback Queue</h1>
          <p className="text-muted-foreground">Manage patient callback requests</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="status-filter">Filter:</Label>
          <Select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="assigned">Assigned</option>
            <option value="completed">Completed</option>
          </Select>
        </div>
      </div>

      {!sortedCallbacks || sortedCallbacks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              {statusFilter === 'all'
                ? 'No callbacks in queue'
                : `No ${statusFilter} callbacks`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedCallbacks.map((callback) => (
            <Card key={callback.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      {callback.patientName || 'Unknown Patient'}
                      {getPriorityIcon(callback.priority)}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {callback.patientPhone}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={getPriorityVariant(callback.priority)}>
                      {callback.priority.toUpperCase()}
                    </Badge>
                    <Badge variant="outline">{callback.status}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  {callback.patientDob && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        Date of Birth
                      </p>
                      <p className="text-sm">{callback.patientDob}</p>
                    </div>
                  )}
                  {callback.patientEmail && (
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Email</p>
                      <p className="text-sm">{callback.patientEmail}</p>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-sm font-medium text-muted-foreground">Reason</p>
                  <p className="text-sm">{callback.reason}</p>
                </div>

                {callback.notes && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Notes</p>
                    <p className="text-sm text-foreground">{callback.notes}</p>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Created: {new Date(callback.createdAt).toLocaleString()}</span>
                  {callback.assignedAt && (
                    <span>
                      • Assigned: {new Date(callback.assignedAt).toLocaleString()}
                    </span>
                  )}
                </div>

                {callback.status === 'pending' && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleAssignToMe(callback)}
                    >
                      <UserCheck className="mr-2 h-4 w-4" />
                      Assign to Me
                    </Button>
                  </div>
                )}

                {callback.status === 'assigned' &&
                  callback.assignedTo === user?.id && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedCallback(callback)
                          setShowCompleteDialog(true)
                        }}
                      >
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Mark Complete
                      </Button>
                    </div>
                  )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={showCompleteDialog} onOpenChange={setShowCompleteDialog}>
        <DialogContent onClose={() => setShowCompleteDialog(false)}>
          <DialogHeader>
            <DialogTitle>Mark Callback Complete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to mark this callback as completed?
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCompleteDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleMarkComplete}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
