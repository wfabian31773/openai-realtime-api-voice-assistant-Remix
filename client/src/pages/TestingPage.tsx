import { useState, useEffect } from 'react';
import { apiClient } from '../lib/apiClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { useToast } from '../components/ui/toast';

interface Agent {
  slug: string;
  name: string;
  description: string;
}

interface TestResult {
  success: boolean;
  callSid?: string;
  error?: string;
  logs: string[];
  timestamp: string;
  duration?: number;
}

interface ConnectivityResult {
  connected: boolean;
  accountSid?: string;
  phoneNumber?: string;
  error?: string;
}

export default function TestingPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [connectivity, setConnectivity] = useState<ConnectivityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [testingConnectivity, setTestingConnectivity] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const response = await apiClient.get('/test/agents');
      setAgents(response.data);
      if (response.data.length > 0) {
        setSelectedAgent(response.data[0].slug);
      }
    } catch (error) {
      addToast({
        title: 'Error',
        description: 'Failed to load agents',
        variant: 'destructive',
      });
    }
  };

  const testTwilioConnectivity = async () => {
    setTestingConnectivity(true);
    setConnectivity(null);
    
    try {
      const response = await apiClient.post('/test/twilio-connectivity');
      setConnectivity(response.data);
      
      if (response.data.connected) {
        addToast({
          title: '✅ Twilio Connected',
          description: `Account: ${response.data.accountSid}`,
        });
      } else {
        addToast({
          title: '❌ Connection Failed',
          description: response.data.error,
          variant: 'destructive',
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setConnectivity({ connected: false, error: errorMessage });
      addToast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setTestingConnectivity(false);
    }
  };

  const makeTestCall = async () => {
    if (!phoneNumber) {
      addToast({
        title: 'Error',
        description: 'Please enter a phone number',
        variant: 'destructive',
      });
      return;
    }

    if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
      addToast({
        title: 'Invalid Phone Number',
        description: 'Please enter a valid phone number in E.164 format (e.g., +12345678900)',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    setTestResult(null);

    try {
      const response = await apiClient.post(`/test/call/${selectedAgent}`, {
        toPhoneNumber: phoneNumber,
      });

      setTestResult(response.data);

      if (response.data.success) {
        addToast({
          title: '✅ Test Call Initiated',
          description: `Call SID: ${response.data.callSid}`,
        });
      } else {
        addToast({
          title: '❌ Test Call Failed',
          description: response.data.error,
          variant: 'destructive',
        });
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.error || error.message || 'Unknown error';
      setTestResult({
        success: false,
        error: errorMessage,
        logs: [],
        timestamp: new Date().toISOString(),
      });
      addToast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const selectedAgentData = agents.find(a => a.slug === selectedAgent);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Agent Testing Suite</h1>
        <p className="text-muted-foreground mt-2">
          Comprehensive testing and diagnostics for all voice agents
        </p>
      </div>

      {/* Twilio Connectivity Test */}
      <Card>
        <CardHeader>
          <CardTitle>🔌 Twilio Integration Status</CardTitle>
          <CardDescription>Test Twilio connectivity and credentials</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button 
            onClick={testTwilioConnectivity} 
            disabled={testingConnectivity}
            className="w-full sm:w-auto"
          >
            {testingConnectivity ? 'Testing...' : 'Test Twilio Connection'}
          </Button>

          {connectivity && (
            <div className={`p-4 rounded-lg border ${
              connectivity.connected 
                ? 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800' 
                : 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant={connectivity.connected ? 'default' : 'destructive'}>
                  {connectivity.connected ? '✅ Connected' : '❌ Disconnected'}
                </Badge>
              </div>
              
              {connectivity.connected ? (
                <div className="space-y-1 text-sm">
                  <p><strong>Account SID:</strong> {connectivity.accountSid}</p>
                  <p><strong>Phone Number:</strong> {connectivity.phoneNumber || 'Not configured'}</p>
                </div>
              ) : (
                <div className="text-sm text-red-600 dark:text-red-400">
                  <strong>Error:</strong> {connectivity.error}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test Call Interface */}
      <Card>
        <CardHeader>
          <CardTitle>📞 Make Test Call</CardTitle>
          <CardDescription>
            Test outbound calling functionality for any agent
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent">Agent</Label>
              <select
                id="agent"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              >
                {agents.map((agent) => (
                  <option key={agent.slug} value={agent.slug}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {selectedAgentData && (
                <p className="text-sm text-muted-foreground">
                  {selectedAgentData.description}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+12345678900"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Format: E.164 (e.g., +12345678900)
              </p>
            </div>
          </div>

          <Button 
            onClick={makeTestCall} 
            disabled={loading || !selectedAgent || !phoneNumber}
            className="w-full sm:w-auto"
          >
            {loading ? 'Initiating Call...' : '📞 Make Test Call'}
          </Button>

          <div className="text-xs text-muted-foreground">
            Rate limit: 5 calls per hour per user
          </div>
        </CardContent>
      </Card>

      {/* Test Results */}
      {testResult && (
        <Card>
          <CardHeader>
            <CardTitle>📊 Test Results</CardTitle>
            <CardDescription>
              {new Date(testResult.timestamp).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant={testResult.success ? 'default' : 'destructive'}>
                {testResult.success ? '✅ Success' : '❌ Failed'}
              </Badge>
              {testResult.duration && (
                <span className="text-sm text-muted-foreground">
                  Duration: {testResult.duration}ms
                </span>
              )}
            </div>

            {testResult.callSid && (
              <div className="p-3 bg-muted rounded-md">
                <p className="text-sm">
                  <strong>Call SID:</strong> {testResult.callSid}
                </p>
              </div>
            )}

            {testResult.error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md dark:bg-red-950 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">
                  <strong>Error:</strong> {testResult.error}
                </p>
              </div>
            )}

            {testResult.logs && testResult.logs.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Detailed Logs:</h4>
                <div className="bg-black text-green-400 p-4 rounded-md font-mono text-xs overflow-x-auto max-h-96 overflow-y-auto">
                  {testResult.logs.map((log, index) => (
                    <div key={index} className="whitespace-pre-wrap break-all">
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Available Agents Reference */}
      <Card>
        <CardHeader>
          <CardTitle>🤖 Available Agents</CardTitle>
          <CardDescription>All registered voice agents</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => (
              <div 
                key={agent.slug} 
                className="p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <h4 className="font-semibold">{agent.name}</h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {agent.description}
                </p>
                <Badge variant="outline" className="mt-2">
                  {agent.slug}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Testing Tips */}
      <Card>
        <CardHeader>
          <CardTitle>💡 Testing Tips</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Always test Twilio connectivity before making calls</li>
            <li>Use your own phone number for initial testing</li>
            <li>Check the detailed logs to debug any issues</li>
            <li>Verify the agent's behavior matches expectations</li>
            <li>For STAT emergencies, test the human handoff feature</li>
            <li>Monitor the Call Logs page for call status updates</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
