import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { MessageSquare, Search } from 'lucide-react'
import type { SmsLog } from '@/types'

export function SmsLogsPage() {
  const [searchTerm, setSearchTerm] = useState('')

  const { data: smsLogs, isLoading } = useQuery({
    queryKey: ['sms-logs'],
    queryFn: async () => {
      const { data } = await apiClient.get<SmsLog[]>('/sms-logs?limit=100')
      return data
    },
  })

  const filteredLogs = smsLogs?.filter(
    (log) =>
      log.from.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.to.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.body.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'success'
      case 'failed':
        return 'destructive'
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">SMS Logs</h1>
          <p className="text-muted-foreground">View all SMS message history</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center gap-2">
            <Search className="h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search by phone number or message..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-md"
            />
          </div>

          {!filteredLogs || filteredLogs.length === 0 ? (
            <div className="py-12 text-center">
              <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-2 text-muted-foreground">
                {searchTerm ? 'No matching messages found' : 'No messages yet'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{log.direction}</Badge>
                      </TableCell>
                      <TableCell>{log.from}</TableCell>
                      <TableCell>{log.to}</TableCell>
                      <TableCell className="max-w-md">
                        <p className="truncate">{log.body}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusVariant(log.status)}>
                          {log.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
