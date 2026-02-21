import { storage } from '../storage';
import { getTwilioClient, getTwilioFromPhoneNumber } from '../../src/lib/twilioClient';

interface CampaignExecutionOptions {
  maxConcurrentCalls?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export class CampaignExecutor {
  private activeCalls = new Map<string, Promise<void>>();
  private callResolutions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private maxConcurrent: number;
  private retryAttempts: number;
  private retryDelay: number;

  constructor(options: CampaignExecutionOptions = {}) {
    this.maxConcurrent = options.maxConcurrentCalls || 5;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelayMs || 60000; // 1 minute default
  }

  // Called by StatusCallback webhook to notify that a call has completed
  notifyCallComplete(callSid: string): void {
    const resolution = this.callResolutions.get(callSid);
    if (resolution) {
      resolution.resolve();
      this.callResolutions.delete(callSid);
    }
  }

  async executeCampaign(campaignId: string): Promise<void> {
    console.info(`[CAMPAIGN EXECUTOR] Starting campaign: ${campaignId}`);

    try {
      // Get campaign details
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      // Validate campaign can be executed
      if (campaign.status !== 'scheduled' && campaign.status !== 'running') {
        throw new Error(`Campaign cannot be executed. Current status: ${campaign.status}`);
      }

      // Get agent details
      const agent = await storage.getAgent(campaign.agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${campaign.agentId}`);
      }

      // Update campaign status to running
      await storage.updateCampaign(campaignId, {
        status: 'running',
        actualStartTime: new Date(),
      });

      // Get all pending contacts
      const allContacts = await storage.getCampaignContacts(campaignId);
      const pendingContacts = allContacts.filter(c => !c.contacted && (c.attempts || 0) < this.retryAttempts);

      console.info(`[CAMPAIGN EXECUTOR] Found ${pendingContacts.length} pending contacts for campaign ${campaign.name}`);

      if (pendingContacts.length === 0) {
        console.info(`[CAMPAIGN EXECUTOR] No pending contacts, marking campaign as completed`);
        await storage.updateCampaign(campaignId, {
          status: 'completed',
          actualEndTime: new Date(),
        });
        return;
      }

      // Process contacts in batches to respect concurrent call limits
      for (let i = 0; i < pendingContacts.length; i++) {
        const contact = pendingContacts[i];

        // Wait if max concurrent calls reached
        while (this.activeCalls.size >= this.maxConcurrent) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Check if campaign was paused/cancelled
        const currentCampaign = await storage.getCampaign(campaignId);
        if (currentCampaign?.status === 'paused' || currentCampaign?.status === 'cancelled') {
          console.info(`[CAMPAIGN EXECUTOR] Campaign ${campaignId} was ${currentCampaign.status}, stopping execution`);
          break;
        }

        // Make the call and track it
        const callPromise = this.makeOutboundCall(campaignId, contact.id, contact.phoneNumber, agent.slug)
          .catch(error => {
            console.error(`[CAMPAIGN EXECUTOR] Error calling ${contact.phoneNumber}:`, error);
          });
        
        // Don't await - let calls run concurrently
        // But track them so we know when all are done
        const callKey = `${campaignId}-${contact.id}`;
        this.activeCalls.set(callKey, callPromise);
      }

      // Wait for all active calls to complete
      while (this.activeCalls.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Update campaign completion status
      const finalCampaign = await storage.getCampaign(campaignId);
      const finalContacts = await storage.getCampaignContacts(campaignId);
      const completedCount = finalContacts.filter(c => c.contacted).length;
      const successfulCount = finalContacts.filter(c => c.successful).length;

      await storage.updateCampaign(campaignId, {
        status: 'completed',
        actualEndTime: new Date(),
        completedContacts: completedCount,
        successfulContacts: successfulCount,
      });

      console.info(`[CAMPAIGN EXECUTOR] ✓ Campaign ${campaign.name} completed. Success: ${successfulCount}/${completedCount}`);

    } catch (error) {
      console.error(`[CAMPAIGN EXECUTOR] ✗ Campaign execution failed:`, error);
      
      // Mark campaign as failed
      await storage.updateCampaign(campaignId, {
        status: 'cancelled',
        actualEndTime: new Date(),
      });
      
      throw error;
    }
  }

  private async makeOutboundCall(
    campaignId: string,
    contactId: string,
    phoneNumber: string,
    agentSlug: string
  ): Promise<void> {
    try {
      console.info(`[OUTBOUND CALL] Calling ${phoneNumber} for campaign ${campaignId}`);

      const twilioClient = await getTwilioClient();
      const twilioFromNumber = await getTwilioFromPhoneNumber();
      const domain = process.env.DOMAIN || process.env.REPL_SLUG + '.repl.co';

      // Increment attempt count
      const contact = (await storage.getCampaignContacts(campaignId)).find(c => c.id === contactId);
      if (contact) {
        await storage.updateCampaignContact(contactId, {
          attempts: (contact.attempts || 0) + 1,
          lastAttemptAt: new Date(),
        });
      }

      // Make Twilio call with machine detection enabled
      const call = await twilioClient.calls.create({
        to: phoneNumber,
        from: twilioFromNumber,
        url: `https://${domain}/api/voice/test/incoming?agentSlug=${agentSlug}&campaignId=${campaignId}&contactId=${contactId}`,
        method: 'POST',
        machineDetection: 'DetectMessageEnd', // Enable voicemail detection
        asyncAmd: 'true', // Asynchronous AMD for better detection
        statusCallback: `https://${domain}/api/voice/status-callback`, // CRITICAL: Use StatusCallback
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeout: 60, // 60 second timeout
      });

      console.info(`[OUTBOUND CALL] ✓ Call initiated: ${call.sid} to ${phoneNumber}`);

      // Create call log in database with CallSid for tracking
      const agent = await storage.getAgentBySlug(agentSlug);
      await storage.createCallLog({
        callSid: call.sid, // CRITICAL: Set CallSid for StatusCallback lookups
        direction: 'outbound',
        from: twilioFromNumber,
        to: phoneNumber,
        agentId: agent?.id || null,
        campaignId,
        contactId,
        status: 'initiated',
        startTime: new Date(),
      });

      // Create a promise that resolves when StatusCallback completes
      await new Promise<void>((resolve, reject) => {
        // Store resolution callbacks for this CallSid
        this.callResolutions.set(call.sid, { resolve, reject });
        
        // Set timeout (2 minutes max wait for status callback)
        setTimeout(() => {
          if (this.callResolutions.has(call.sid)) {
            console.warn(`[OUTBOUND CALL] Timeout waiting for status callback: ${call.sid}`);
            resolve(); // Resolve anyway to not block campaign
            this.callResolutions.delete(call.sid);
          }
        }, 120000); // 2 minute timeout
      });

      console.info(`[OUTBOUND CALL] ✓ Call completed: ${call.sid}`);

      // Remove from active calls
      const callKey = `${campaignId}-${contactId}`;
      this.activeCalls.delete(callKey);

    } catch (error) {
      console.error(`[OUTBOUND CALL] ✗ Failed to call ${phoneNumber}:`, error);
      
      // Mark contact as failed
      await storage.updateCampaignContact(contactId, {
        contacted: true,
        successful: false,
      });
      
      // Remove from active calls
      const callKey = `${campaignId}-${contactId}`;
      this.activeCalls.delete(callKey);
    }
  }

  async pauseCampaign(campaignId: string): Promise<void> {
    await storage.updateCampaign(campaignId, { status: 'paused' });
    console.info(`[CAMPAIGN EXECUTOR] Campaign ${campaignId} paused`);
  }

  async resumeCampaign(campaignId: string): Promise<void> {
    await storage.updateCampaign(campaignId, { status: 'running' });
    console.info(`[CAMPAIGN EXECUTOR] Campaign ${campaignId} resumed`);
    
    // Re-execute to continue processing
    await this.executeCampaign(campaignId);
  }

  async cancelCampaign(campaignId: string): Promise<void> {
    await storage.updateCampaign(campaignId, {
      status: 'cancelled',
      actualEndTime: new Date(),
    });
    console.info(`[CAMPAIGN EXECUTOR] Campaign ${campaignId} cancelled`);
  }
}

// Singleton instance
export const campaignExecutor = new CampaignExecutor({
  maxConcurrentCalls: 5,
  retryAttempts: 3,
  retryDelayMs: 60000,
});
