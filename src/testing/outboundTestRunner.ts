import { getTwilioClient, getTwilioFromPhoneNumber, getTwilioAccountSid } from '../lib/twilioClient';
import { agentRegistry } from '../config/agents';
import { storage } from '../../server/storage';

interface TestCallOptions {
  agentSlug: string;
  toPhoneNumber: string;
  campaignId?: string;
  contactId?: string;
}

interface TestResult {
  success: boolean;
  callSid?: string;
  error?: string;
  logs: string[];
  timestamp: string;
  duration?: number;
}

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export class OutboundTestRunner {
  private logs: string[] = [];
  
  private log(level: 'INFO' | 'SUCCESS' | 'ERROR' | 'WARN', message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const colorMap = {
      INFO: colors.blue,
      SUCCESS: colors.green,
      ERROR: colors.red,
      WARN: colors.yellow
    };
    const color = colorMap[level];
    const prefix = `${color}[${level}]${colors.reset}`;
    
    const logMessage = `${timestamp} ${prefix} ${message}`;
    console.log(logMessage, data || '');
    this.logs.push(`${timestamp} [${level}] ${message} ${data ? JSON.stringify(data) : ''}`);
  }

  async testTwilioConnectivity(): Promise<{ connected: boolean; accountSid?: string; phoneNumber?: string; error?: string }> {
    this.log('INFO', '🔍 Testing Twilio Integration Connectivity...');
    
    try {
      this.log('INFO', '  → Fetching Twilio credentials from Replit Integration...');
      const accountSid = await getTwilioAccountSid();
      
      this.log('SUCCESS', '  ✓ Account SID retrieved', { accountSid });
      
      const phoneNumber = await getTwilioFromPhoneNumber();
      this.log('SUCCESS', '  ✓ Phone number retrieved', { phoneNumber });
      
      const client = await getTwilioClient();
      this.log('INFO', '  → Testing API connection...');
      
      const account = await client.api.v2010.accounts(accountSid).fetch();
      this.log('SUCCESS', '  ✓ API connection successful', {
        friendlyName: account.friendlyName,
        status: account.status
      });
      
      this.log('SUCCESS', '✅ Twilio Integration Connected Successfully');
      
      return {
        connected: true,
        accountSid,
        phoneNumber
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log('ERROR', '❌ Twilio Integration Connection Failed', { error: errorMessage });
      
      return {
        connected: false,
        error: errorMessage
      };
    }
  }

  async testAgentAvailability(agentSlug: string): Promise<{ available: boolean; error?: string }> {
    this.log('INFO', `🔍 Checking Agent Availability: ${agentSlug}`);
    
    try {
      const agentConfig = agentRegistry.getAgentConfig(agentSlug);
      
      if (!agentConfig) {
        this.log('ERROR', `❌ Agent not found in registry: ${agentSlug}`);
        return { available: false, error: 'Agent not found in registry' };
      }
      
      this.log('SUCCESS', `✓ Agent found in registry: ${agentSlug}`);
      
      this.log('INFO', '  → Creating test agent instance...');
      const agentFactory = agentRegistry.getAgentFactory(agentSlug);
      
      if (!agentFactory) {
        this.log('ERROR', `❌ Agent factory not available: ${agentSlug}`);
        return { available: false, error: 'Agent factory not available' };
      }
      
      const agent = await Promise.resolve(agentFactory());
      
      this.log('SUCCESS', '  ✓ Agent instance created', {
        name: agent.name
      });
      
      this.log('SUCCESS', `✅ Agent Available: ${agentSlug}`);
      
      return { available: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log('ERROR', `❌ Agent Availability Check Failed: ${agentSlug}`, { error: errorMessage });
      
      return { available: false, error: errorMessage };
    }
  }

  async makeTestCall(options: TestCallOptions): Promise<TestResult> {
    const startTime = Date.now();
    this.logs = [];
    
    this.log('INFO', '🚀 Starting Outbound Test Call', {
      agent: options.agentSlug,
      to: options.toPhoneNumber
    });
    
    try {
      this.log('INFO', 'Step 1/5: Testing Twilio Connectivity');
      const connectivityTest = await this.testTwilioConnectivity();
      
      if (!connectivityTest.connected) {
        throw new Error(`Twilio connectivity failed: ${connectivityTest.error}`);
      }
      
      this.log('INFO', 'Step 2/5: Checking Agent Availability');
      const agentTest = await this.testAgentAvailability(options.agentSlug);
      
      if (!agentTest.available) {
        throw new Error(`Agent not available: ${agentTest.error}`);
      }
      
      this.log('INFO', 'Step 3/5: Retrieving Twilio Client & Agent Phone');
      const client = await getTwilioClient();
      
      // Look up the agent's configured phone number for caller ID
      let fromNumber: string | undefined;
      try {
        const agentRecord = await storage.getAgentBySlug(options.agentSlug);
        if (agentRecord?.twilioPhoneNumber) {
          fromNumber = agentRecord.twilioPhoneNumber;
          this.log('SUCCESS', `  ✓ Using agent's configured phone: ${fromNumber}`);
        }
      } catch (lookupError) {
        this.log('WARN', '  → Agent phone lookup failed, using default');
      }
      
      // Fallback to default if agent doesn't have a phone configured
      if (!fromNumber) {
        fromNumber = await getTwilioFromPhoneNumber();
        this.log('INFO', `  → Using default Twilio phone: ${fromNumber}`);
      }
      
      if (!fromNumber) {
        throw new Error('Twilio phone number not configured in integration');
      }
      
      this.log('SUCCESS', '  ✓ Twilio client ready', { from: fromNumber });
      
      this.log('INFO', 'Step 4/5: Building TwiML for agent');
      
      // Build base URL - prefer PUBLIC_URL (includes https://), fallback to constructing from DOMAIN
      let baseHost: string;
      if (process.env.PUBLIC_URL) {
        baseHost = process.env.PUBLIC_URL;
      } else if (process.env.DOMAIN) {
        const domain = process.env.DOMAIN;
        baseHost = domain.startsWith('http') ? domain : `https://${domain}`;
      } else if (process.env.REPLIT_DEV_DOMAIN) {
        const domain = process.env.REPLIT_DEV_DOMAIN;
        baseHost = domain.startsWith('http') ? domain : `https://${domain}`;
      } else {
        throw new Error('No base URL configured - PUBLIC_URL, DOMAIN, or REPLIT_DEV_DOMAIN required');
      }
      
      this.log('INFO', `  → Base host resolved: ${baseHost}`);
      
      // Build URL with campaign/contact metadata as query parameters
      // Use URL parameter (not inline TwiML) so Twilio provides CallToken for OpenAI SIP participant
      const baseUrl = `${baseHost}/api/voice/test/incoming`;
      const urlParams = new URLSearchParams({
        agentSlug: options.agentSlug,
        ...(options.campaignId && { campaignId: options.campaignId }),
        ...(options.contactId && { contactId: options.contactId }),
      });
      const callbackUrl = `${baseUrl}?${urlParams.toString()}`;
      
      this.log('INFO', '  → Test callback URL', { url: callbackUrl });
      
      this.log('INFO', 'Step 5/5: Initiating Twilio Call');
      this.log('INFO', '  → Making outbound call...', {
        from: fromNumber,
        to: options.toPhoneNumber,
        agent: options.agentSlug,
        url: callbackUrl
      });
      
      const call = await client.calls.create({
        from: fromNumber,
        to: options.toPhoneNumber,
        url: callbackUrl, // Twilio fetches TwiML from this URL - provides CallToken for SIP
        method: 'POST',
        statusCallback: `${baseHost}/api/test-calls/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true, // Enable recording for test calls
        recordingStatusCallback: `${baseHost}/api/voice/recording-status`,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: ['completed']
      });
      
      this.log('SUCCESS', '✅ Call Initiated Successfully', {
        callSid: call.sid,
        status: call.status,
        from: call.from,
        to: call.to
      });
      
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        callSid: call.sid,
        logs: this.logs,
        timestamp: new Date().toISOString(),
        duration
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log('ERROR', '❌ Test Call Failed', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });
      
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        error: errorMessage,
        logs: this.logs,
        timestamp: new Date().toISOString(),
        duration
      };
    }
  }

  async listAvailableAgents(): Promise<Array<{ slug: string; name: string; description: string }>> {
    this.log('INFO', '📋 Listing Available Agents');
    
    try {
      const agentConfigs = agentRegistry.getAllAgents();
      const agents = agentConfigs.map(config => ({
        slug: config.id,
        name: config.id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: config.description
      }));
      
      this.log('SUCCESS', `✓ Found ${agents.length} agents`, agents);
      
      return agents;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log('ERROR', '❌ Failed to list agents', { error: errorMessage });
      
      return [];
    }
  }

  getLogs(): string[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export const testRunner = new OutboundTestRunner();
