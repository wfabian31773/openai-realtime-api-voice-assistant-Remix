import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Bot, Megaphone, Phone, ClipboardList } from 'lucide-react'
import type { Agent, Campaign, CallLog, CallbackQueueItem } from '@/types'

export function Dashboard() {
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<Agent[]>('/agents')
        return Array.isArray(data) ? data : []
      } catch (error) {
        console.error('Failed to fetch agents:', error)
        return []
      }
    },
  })

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<Campaign[]>('/campaigns')
        return Array.isArray(data) ? data : []
      } catch (error) {
        console.error('Failed to fetch campaigns:', error)
        return []
      }
    },
  })

  const { data: callLogs = [] } = useQuery({
    queryKey: ['call-logs'],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<CallLog[]>('/call-logs?limit=10')
        return Array.isArray(data) ? data : []
      } catch (error) {
        console.error('Failed to fetch call logs:', error)
        return []
      }
    },
  })

  const { data: callbacks = [] } = useQuery({
    queryKey: ['callback-queue'],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<CallbackQueueItem[]>('/callback-queue')
        return Array.isArray(data) ? data : []
      } catch (error) {
        console.error('Failed to fetch callbacks:', error)
        return []
      }
    },
  })

  const activeAgents = agents?.filter((a) => a.status === 'active').length || 0
  const activeCampaigns =
    campaigns?.filter((c) => c.status === 'running').length || 0
  const recentCalls = callLogs?.length || 0
  const pendingCallbacks =
    callbacks?.filter((c) => c.status === 'pending').length || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground">Welcome to Azul Vision AI Operations Hub</p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Agents
            </CardTitle>
            <Bot className="h-5 w-5 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{activeAgents}</div>
            <p className="text-xs text-muted-foreground">
              {agents?.length || 0} total agents
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Campaigns
            </CardTitle>
            <Megaphone className="h-5 w-5 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{activeCampaigns}</div>
            <p className="text-xs text-muted-foreground">
              {campaigns?.length || 0} total campaigns
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recent Calls
            </CardTitle>
            <Phone className="h-5 w-5 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{recentCalls}</div>
            <p className="text-xs text-muted-foreground">Last 10 calls</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending Callbacks
            </CardTitle>
            <ClipboardList className="h-5 w-5 text-orange-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{pendingCallbacks}</div>
            <p className="text-xs text-muted-foreground">
              {callbacks?.length || 0} total in queue
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Calls</CardTitle>
          </CardHeader>
          <CardContent>
            {!callLogs || callLogs.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No recent calls</p>
            ) : (
              <div className="space-y-4">
                {callLogs.slice(0, 5).map((call) => (
                  <div
                    key={call.id}
                    className="flex items-center justify-between border-b border-border pb-3 last:border-0"
                  >
                    <div className="flex-1">
                      <p className="font-medium text-foreground">
                        {call.direction === 'inbound' ? call.from : call.to}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(call.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant={
                        call.status === 'completed'
                          ? 'success'
                          : call.status === 'failed'
                          ? 'destructive'
                          : 'default'
                      }
                    >
                      {call.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Campaign Progress</CardTitle>
          </CardHeader>
          <CardContent>
            {!campaigns || campaigns.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No active campaigns
              </p>
            ) : (
              <div className="space-y-4">
                {campaigns.slice(0, 5).map((campaign) => {
                  const progress =
                    campaign.totalContacts > 0
                      ? (campaign.completedContacts / campaign.totalContacts) *
                        100
                      : 0
                  return (
                    <div key={campaign.id} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-foreground">{campaign.name}</p>
                        <Badge>{campaign.status}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {campaign.completedContacts}/{campaign.totalContacts}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
