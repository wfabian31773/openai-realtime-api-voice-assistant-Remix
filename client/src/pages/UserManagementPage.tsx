import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
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
import apiClient from '@/lib/apiClient'
import { Users, UserPlus, Mail, Shield, Clock, Trash2, Edit } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

interface User {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  role: 'admin' | 'manager' | 'user'
  status: 'pending' | 'active' | 'suspended' | 'deactivated'
  lastLoginAt: string | null
  createdAt: string
}

interface Invitation {
  id: string
  email: string
  role: 'admin' | 'manager' | 'user'
  expiresAt: string
  createdAt: string
}

export function UserManagementPage() {
  const { addToast } = useToast()
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuth()
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'manager' | 'user'>('user')

  const { data: usersData } = useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ users: User[] }>('/auth/users')
      return data.users
    },
  })

  const { data: invitationsData } = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ invitations: Invitation[] }>('/auth/invitations')
      return data.invitations
    },
  })

  const inviteMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: string }) => {
      const { data } = await apiClient.post('/auth/invite', { email, role })
      return data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] })
      setShowInviteDialog(false)
      setInviteEmail('')
      setInviteRole('user')
      addToast({
        title: 'Invitation Sent',
        description: data.emailSent 
          ? `Invitation email sent to ${inviteEmail}`
          : 'Invitation created but email failed to send',
        variant: data.emailSent ? 'success' : 'default',
      })
    },
    onError: (error: any) => {
      addToast({
        title: 'Failed to send invitation',
        description: error.response?.data?.error || 'An error occurred',
        variant: 'destructive',
      })
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: async ({ id, role, status }: { id: string; role?: string; status?: string }) => {
      const { data } = await apiClient.put(`/auth/users/${id}`, { role, status })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowEditDialog(false)
      setSelectedUser(null)
      addToast({
        title: 'User Updated',
        description: 'User settings have been updated',
        variant: 'success',
      })
    },
    onError: (error: any) => {
      addToast({
        title: 'Failed to update user',
        description: error.response?.data?.error || 'An error occurred',
        variant: 'destructive',
      })
    },
  })

  const deleteInvitationMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/auth/invitations/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] })
      addToast({
        title: 'Invitation Cancelled',
        description: 'The invitation has been cancelled',
      })
    },
  })

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-red-100 text-red-800'
      case 'manager':
        return 'bg-blue-100 text-blue-800'
      default:
        return 'bg-muted text-foreground'
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800'
      case 'pending':
        return 'bg-yellow-100 text-yellow-800'
      case 'suspended':
        return 'bg-orange-100 text-orange-800'
      case 'deactivated':
        return 'bg-muted text-foreground'
      default:
        return 'bg-muted text-foreground'
    }
  }

  const isAdmin = currentUser?.role === 'admin'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6" />
            User Management
          </h1>
          <p className="text-muted-foreground">Manage users, roles, and invitations</p>
        </div>
        <Button onClick={() => setShowInviteDialog(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          Invite User
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Users</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersData?.map((user: User) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.firstName || user.lastName
                      ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                      : '—'}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge className={getRoleBadgeColor(user.role)}>
                      {user.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={getStatusBadgeColor(user.status)}>
                      {user.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleDateString()
                      : 'Never'}
                  </TableCell>
                  <TableCell>
                    {isAdmin && user.id !== currentUser?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedUser(user)
                          setShowEditDialog(true)
                        }}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {invitationsData && invitationsData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" />
              Pending Invitations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitationsData.map((invitation: Invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>
                      <Badge className={getRoleBadgeColor(invitation.role)}>
                        {invitation.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        {new Date(invitation.expiresAt).toLocaleDateString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteInvitationMutation.mutate(invitation.id)}
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite New User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email Address</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="user@azulvision.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'manager' | 'user')}
              >
                <option value="user">User</option>
                <option value="manager">Manager</option>
                {isAdmin && <option value="admin">Admin</option>}
              </Select>
              <p className="text-xs text-muted-foreground">
                <Shield className="w-3 h-3 inline mr-1" />
                Admins can manage all users. Managers can invite users (except admins).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => inviteMutation.mutate({ email: inviteEmail, role: inviteRole })}
              disabled={!inviteEmail || inviteMutation.isPending}
            >
              {inviteMutation.isPending ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          {selectedUser && (
            <div className="space-y-4">
              <div>
                <Label>Email</Label>
                <p className="text-sm text-muted-foreground">{selectedUser.email}</p>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  value={selectedUser.role}
                  onChange={(e) =>
                    setSelectedUser({ ...selectedUser, role: e.target.value as any })
                  }
                >
                  <option value="user">User</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={selectedUser.status}
                  onChange={(e) =>
                    setSelectedUser({ ...selectedUser, status: e.target.value as any })
                  }
                >
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                  <option value="deactivated">Deactivated</option>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                selectedUser &&
                updateUserMutation.mutate({
                  id: selectedUser.id,
                  role: selectedUser.role,
                  status: selectedUser.status,
                })
              }
              disabled={updateUserMutation.isPending}
            >
              {updateUserMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
