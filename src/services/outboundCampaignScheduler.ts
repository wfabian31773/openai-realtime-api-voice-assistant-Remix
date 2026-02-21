import { storage } from '../../server/storage';
import { getTwilioClient } from '../lib/twilioClient';
import type { CampaignContact, Campaign } from '../../shared/schema';
import { distributedLockService } from './distributedLock';
import { createLogger } from './structuredLogger';

const logger = createLogger('SCHEDULER');

const CALLING_HOURS = {
  start: 8,
  end: 20,
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60 * 60 * 1000;

interface SchedulerConfig {
  campaignId: string;
  fromNumber: string;
  webhookDomain: string;
  concurrentCalls?: number;
  checkIntervalMs?: number;
}

export class OutboundCampaignScheduler {
  private config: SchedulerConfig;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private activeCalls: Set<string> = new Set();

  constructor(config: SchedulerConfig) {
    this.config = {
      concurrentCalls: 3,
      checkIntervalMs: 30000,
      ...config,
    };
  }

  isWithinCallingHours(timezone: string = 'America/Los_Angeles'): boolean {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      });
      const hour = parseInt(formatter.format(now), 10);
      return hour >= CALLING_HOURS.start && hour < CALLING_HOURS.end;
    } catch (error) {
      console.error('[SCHEDULER] Error checking calling hours:', error);
      return false;
    }
  }

  getNextCallableTime(timezone: string = 'America/Los_Angeles'): Date {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const currentHour = parseInt(formatter.format(now), 10);

    if (currentHour >= CALLING_HOURS.end) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(CALLING_HOURS.start, 0, 0, 0);
      return tomorrow;
    } else if (currentHour < CALLING_HOURS.start) {
      const today = new Date(now);
      today.setHours(CALLING_HOURS.start, 0, 0, 0);
      return today;
    }

    return now;
  }

  scheduleNextAttempt(contact: CampaignContact, timezoneOverride?: string): Date {
    const timezone = timezoneOverride || contact.timezone || 'America/Los_Angeles';
    const retryTime = new Date(Date.now() + RETRY_DELAY_MS);

    const nextCallable = this.getNextCallableTime(timezone);
    const scheduledTime = retryTime > nextCallable ? retryTime : nextCallable;
    
    console.log(`[SCHEDULER] Next attempt scheduled for ${contact.id}: ${scheduledTime.toISOString()} (timezone: ${timezone})`);
    return scheduledTime;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info('Already running');
      return;
    }

    const lockName = `campaign-scheduler:${this.config.campaignId}`;
    const lockResult = await distributedLockService.acquireLock({
      lockName,
      holderId: 'scheduler',
      ttlSeconds: 120,
    });

    if (!lockResult.acquired) {
      logger.warn(`Cannot start - another instance holds the lock`, {
        campaignId: this.config.campaignId,
        holder: lockResult.holder,
        expiresAt: lockResult.expiresAt?.toISOString(),
      });
      return;
    }

    this.isRunning = true;
    
    distributedLockService.onLockLost(({ lockName: lostLockName }) => {
      if (lostLockName === lockName && this.isRunning) {
        logger.error(`Lock lost unexpectedly - stopping scheduler`, {
          campaignId: this.config.campaignId,
          lockName: lostLockName,
        });
        this.handleLockLost();
      }
    });
    
    logger.info(`Starting outbound campaign scheduler for campaign: ${this.config.campaignId}`, {
      campaignId: this.config.campaignId,
      callingHoursStart: CALLING_HOURS.start,
      callingHoursEnd: CALLING_HOURS.end,
      maxConcurrent: this.config.concurrentCalls,
    });

    await this.processQueue();

    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        await this.processQueue();
      }
    }, this.config.checkIntervalMs);
  }

  private handleLockLost(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.warn('Scheduler stopped due to lock loss', { campaignId: this.config.campaignId });
  }

  async stop(): Promise<void> {
    const lockName = `campaign-scheduler:${this.config.campaignId}`;
    
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await distributedLockService.releaseLock(lockName, 'scheduler');
    logger.info('Stopped', { campaignId: this.config.campaignId });
  }

  private async processQueue(): Promise<void> {
    try {
      const availableSlots = (this.config.concurrentCalls || 3) - this.activeCalls.size;
      if (availableSlots <= 0) {
        console.log('[SCHEDULER] All call slots in use');
        return;
      }

      const contacts = await storage.getContactsDueForOutreach(
        this.config.campaignId,
        availableSlots * 2
      );

      if (contacts.length === 0) {
        console.log('[SCHEDULER] No contacts due for outreach');
        return;
      }

      console.log(`[SCHEDULER] Evaluating ${contacts.length} contacts`);

      let processedCount = 0;
      for (const contact of contacts) {
        if (processedCount >= availableSlots) break;

        if ((contact.attempts || 0) >= (contact.maxAttempts || MAX_ATTEMPTS)) {
          await storage.updateCampaignContact(contact.id, {
            outreachStatus: 'max_attempts',
          });
          console.log(`[SCHEDULER] Contact ${contact.id} reached max attempts`);
          continue;
        }

        const timezone = contact.timezone || 'America/Los_Angeles';
        if (!this.isWithinCallingHours(timezone)) {
          console.log(`[SCHEDULER] Contact ${contact.id} outside calling hours for timezone ${timezone}, rescheduling`);
          await storage.updateCampaignContact(contact.id, {
            nextAttemptAt: this.getNextCallableTime(timezone),
          });
          continue;
        }

        await this.initiateCall(contact);
        processedCount++;
      }
    } catch (error) {
      console.error('[SCHEDULER] Error processing queue:', error);
    }
  }

  private async initiateCall(contact: CampaignContact): Promise<void> {
    const contactId = contact.id;
    const phoneNumber = contact.phoneNumber;
    const attemptNumber = (contact.attempts || 0) + 1;

    console.log(`[SCHEDULER] Initiating call to ${phoneNumber} (attempt ${attemptNumber}/${MAX_ATTEMPTS})`);

    try {
      await storage.updateCampaignContact(contactId, {
        outreachStatus: 'calling',
      });
      this.activeCalls.add(contactId);

      const twilioClient = await getTwilioClient();
      const webhookUrl = `https://${this.config.webhookDomain}/api/voice/outbound-confirmation?contactId=${encodeURIComponent(contactId)}&campaignId=${encodeURIComponent(this.config.campaignId)}`;
      const statusCallbackUrl = `https://${this.config.webhookDomain}/api/voice/outbound-confirmation-status?contactId=${encodeURIComponent(contactId)}&campaignId=${encodeURIComponent(this.config.campaignId)}`;

      // No AMD - connect directly to AI agent, let agent handle voicemail detection
      const call = await twilioClient.calls.create({
        to: phoneNumber,
        from: this.config.fromNumber,
        url: webhookUrl,
        method: 'POST',
        statusCallback: statusCallbackUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeout: 30,
      });

      console.log(`[SCHEDULER] Call initiated: ${call.sid} to ${phoneNumber}`);

      const attempt = await storage.createContactAttempt({
        contactId: contactId,
        campaignId: this.config.campaignId,
        attemptNumber: attemptNumber,
        callSid: call.sid,
        direction: 'outbound',
        status: 'initiated',
      });

      await storage.updateCampaignContact(contactId, {
        attempts: attemptNumber,
        lastAttemptAt: new Date(),
        lastCallSid: call.sid,
      });

      console.log(`[SCHEDULER] Attempt ${attempt.id} created for contact ${contactId}`);
    } catch (error) {
      console.error(`[SCHEDULER] Failed to initiate call to ${phoneNumber}:`, error);

      await storage.updateCampaignContact(contactId, {
        outreachStatus: 'callback_scheduled',
        attempts: (contact.attempts || 0) + 1,
        nextAttemptAt: this.scheduleNextAttempt(contact),
      });

      this.activeCalls.delete(contactId);
    }
  }

  async handleCallCompleted(
    callSid: string,
    answeredBy: string,
    callStatus: string,
    duration: number
  ): Promise<void> {
    console.log(`[SCHEDULER] Call completed: ${callSid}, answeredBy: ${answeredBy}, status: ${callStatus}`);

    const attempt = await storage.getContactAttemptByCallSid(callSid);
    if (!attempt) {
      console.error(`[SCHEDULER] No attempt found for callSid: ${callSid}`);
      return;
    }

    const contact = await storage.getCampaignContacts(attempt.campaignId)
      .then(contacts => contacts.find(c => c.id === attempt.contactId));

    if (!contact) {
      console.error(`[SCHEDULER] No contact found for attempt: ${attempt.id}`);
      return;
    }

    this.activeCalls.delete(contact.id);

    await storage.updateContactAttempt(attempt.id, {
      status: callStatus,
      answeredBy: answeredBy,
      endedAt: new Date(),
      duration: duration,
    });

    // With DetectMessageEnd AMD, voicemail/fax/unknown are handled in the webhook
    // Only update status if webhook hasn't already marked it
    // Note: voicemail now sets 'callback_scheduled' with voicemailLeft=true
    const skipStatuses = ['confirmed', 'declined', 'rescheduled', 'wrong_number', 'max_attempts'];
    if (skipStatuses.includes(contact.outreachStatus || '')) {
      console.log(`[SCHEDULER] Contact already has status '${contact.outreachStatus}', skipping status update`);
      return;
    }
    
    // Human answered - waiting for agent to mark outcome
    if ((answeredBy === 'human' || !answeredBy) && callStatus === 'completed' && duration > 0) {
      await storage.updateCampaignContact(contact.id, {
        outreachStatus: 'answered',
      });
      console.log(`[SCHEDULER] Human answered (${duration}s), waiting for agent outcome`);
    } else if (callStatus === 'completed' && duration === 0) {
      // Call completed instantly with no duration - likely failed to connect
      const currentAttempts = contact.attempts || 0;
      const maxAttempts = contact.maxAttempts || MAX_ATTEMPTS;
      const contactTimezone = contact.timezone || 'America/Los_Angeles';
      
      await storage.updateCampaignContact(contact.id, {
        outreachStatus: currentAttempts >= maxAttempts ? 'max_attempts' : 'callback_scheduled',
        lastAttemptAt: new Date(),
        nextAttemptAt: currentAttempts < maxAttempts ? this.scheduleNextAttempt(contact, contactTimezone) : undefined,
      });
      console.log(`[SCHEDULER] Call completed with 0 duration, scheduling retry`);
    } else if (callStatus === 'no-answer' || callStatus === 'busy') {
      const currentAttempts = contact.attempts || 0;
      const maxAttempts = contact.maxAttempts || MAX_ATTEMPTS;
      const newStatus = currentAttempts >= maxAttempts ? 'max_attempts' : 'callback_scheduled';
      const contactTimezone = contact.timezone || 'America/Los_Angeles';

      await storage.updateCampaignContact(contact.id, {
        outreachStatus: newStatus,
        attempts: currentAttempts,
        lastAttemptAt: new Date(),
        nextAttemptAt: currentAttempts < maxAttempts ? this.scheduleNextAttempt(contact, contactTimezone) : undefined,
      });

      console.log(`[SCHEDULER] ${callStatus} (attempt ${currentAttempts}/${maxAttempts}), ${newStatus === 'max_attempts' ? 'max attempts reached' : 'scheduling retry'}`);
    } else if (callStatus === 'failed') {
      const contactTimezone = contact.timezone || 'America/Los_Angeles';
      await storage.updateCampaignContact(contact.id, {
        outreachStatus: 'callback_scheduled',
        nextAttemptAt: this.scheduleNextAttempt(contact, contactTimezone),
      });
      console.log(`[SCHEDULER] Call failed, scheduling retry`);
    }
  }

  async handleAgentOutcome(
    contactId: string,
    outcome: 'confirmed' | 'declined' | 'rescheduled' | 'callback_requested' | 'wrong_number',
    notes?: string
  ): Promise<void> {
    console.log(`[SCHEDULER] Agent outcome for ${contactId}: ${outcome}`);

    let outreachStatus: CampaignContact['outreachStatus'];
    switch (outcome) {
      case 'confirmed':
        outreachStatus = 'confirmed';
        break;
      case 'declined':
        outreachStatus = 'declined';
        break;
      case 'rescheduled':
        outreachStatus = 'rescheduled';
        break;
      case 'wrong_number':
        outreachStatus = 'wrong_number';
        break;
      case 'callback_requested':
        outreachStatus = 'callback_scheduled';
        break;
      default:
        outreachStatus = 'completed';
    }

    await storage.updateCampaignContact(contactId, {
      outreachStatus: outreachStatus,
      confirmationResult: outcome,
      agentNotes: notes,
    });

    const contact = await storage.getCampaignContacts(this.config.campaignId)
      .then(contacts => contacts.find(c => c.id === contactId));

    if (contact?.lastCallSid) {
      await storage.updateContactAttempt(contact.lastCallSid, {
        outcome: outcome,
        notes: notes,
      });
    }
  }

  async handleInboundCallback(callerPhone: string): Promise<CampaignContact | null> {
    console.log(`[SCHEDULER] Inbound callback from: ${callerPhone}`);

    const contacts = await storage.getCampaignContacts(this.config.campaignId);
    const normalizedCaller = callerPhone.replace(/\D/g, '').slice(-10);

    const contact = contacts.find(c => {
      const normalizedContact = c.phoneNumber.replace(/\D/g, '').slice(-10);
      return normalizedContact === normalizedCaller;
    });

    if (!contact) {
      console.log(`[SCHEDULER] No matching contact for callback from ${callerPhone}`);
      return null;
    }

    console.log(`[SCHEDULER] Found contact ${contact.id} for callback`);

    const attemptNumber = (contact.attempts || 0) + 1;
    await storage.createContactAttempt({
      contactId: contact.id,
      campaignId: this.config.campaignId,
      attemptNumber: attemptNumber,
      direction: 'inbound',
      status: 'answered',
      answeredBy: 'human',
    });

    await storage.updateCampaignContact(contact.id, {
      outreachStatus: 'answered',
      attempts: attemptNumber,
      lastAttemptAt: new Date(),
    });

    return contact;
  }
}

const activeSchedulers: Map<string, OutboundCampaignScheduler> = new Map();

export function getScheduler(campaignId: string): OutboundCampaignScheduler | undefined {
  return activeSchedulers.get(campaignId);
}

export function createScheduler(config: SchedulerConfig): OutboundCampaignScheduler {
  const existing = activeSchedulers.get(config.campaignId);
  if (existing) {
    return existing;
  }

  const scheduler = new OutboundCampaignScheduler(config);
  activeSchedulers.set(config.campaignId, scheduler);
  return scheduler;
}

export async function stopScheduler(campaignId: string): Promise<void> {
  const scheduler = activeSchedulers.get(campaignId);
  if (scheduler) {
    await scheduler.stop();
    activeSchedulers.delete(campaignId);
  }
}

export async function stopAllSchedulers(): Promise<void> {
  for (const [campaignId, scheduler] of activeSchedulers) {
    await scheduler.stop();
  }
  activeSchedulers.clear();
}
