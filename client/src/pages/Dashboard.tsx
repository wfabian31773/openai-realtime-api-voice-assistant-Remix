import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Bot, Megaphone, Phone, ClipboardList } from 'lucide-react'
import type { Agent, Campaign, CallLog, CallbackQueueItem } from '@/types'
import type { OperationsReport } from '@/lib/operationsView'

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

  // /api/call-logs answers { data, pagination }. This read an array, so the
  // list was always empty and the card always read 0 (2026-11-26).
  const { data: callLogs = [] } = useQuery({
    queryKey: ['call-logs', 'dashboard'],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ data?: CallLog[] } | CallLog[]>('/call-logs?limit=10')
        if (Array.isArray(data)) return data
        return Array.isArray(data?.data) ? data.data : []
      } catch (error) {
        console.error('Failed to fetch call logs:', error)
        return []
      }
    },
  })

  // The calls themselves, counted from the call records (the Operations Monitor's reader).
  const { data: ops } = useQuery<OperationsReport>({
    queryKey: ['operations', 24],
    queryFn: async () => (await apiClient.get('/observatory/operations', { params: { hours: 24 } })).data,
    refetchInterval: 60_000,
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
  const linesWithCalls = ops?.lanes.length
  const activeCampaigns =
    campaigns?.filter((c) => c.status === 'running').length || 0
  const pendingCallbacks =
    callbacks?.filter((c) => c.status === 'pending').length || 0
  const newestCallback = callbacks.reduce<string | null>((max, c) => {
    const t = (c as { createdAt?: string }).createdAt
    return t && (!max || t > max) ? t : max
  }, null)

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
              Lines that took calls
            </CardTitle>
            <Bot className="h-5 w-5 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{linesWithCalls ?? '—'}</div>
            <p className="text-xs text-muted-foreground">
              In the last 24 hours · {activeAgents} of {agents?.length || 0} agents are marked active in settings
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
              Marked running, of {campaigns?.length || 0} campaigns (the operator line is one of them)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Calls (last 24 hours)
            </CardTitle>
            <Phone className="h-5 w-5 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-foreground">{ops ? ops.calls.total.toLocaleString() : '—'}</div>
            <p className="text-xs text-muted-foreground">
              {ops ? `${ops.calls.dropped} dropped by the voice provider` : 'Counted from the call records'}
            </p>
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
              {callbacks?.length || 0} in the queue
              {newestCallback ? ` · nothing added since ${new Date(newestCallback).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}; the agents file tickets instead` : ''}
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
                        {call.agentUsed ? `${call.agentUsed} · ` : ''}
                        {new Date(call.createdAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT
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
                      <p className="text-xs text-muted-foreground">
                        {campaign.campaignType === 'runtime_outbound'
                          ? `${campaign.completedContacts.toLocaleString()} of ${campaign.totalContacts.toLocaleString()} called at least once · ${campaign.successfulContacts.toLocaleString()} completed`
                          : `${campaign.completedContacts} of ${campaign.totalContacts} done`}
                      </p>
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
