import { getTwilioClient, getTwilioAccountSid } from '../lib/twilioClient';
import { getEnvironmentConfig, isDevCallbackUrl } from '../config/environment';
import { db } from '../../server/db';
import { phoneEndpoints } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import type { PhoneEndpoint, InsertPhoneEndpoint } from '../../shared/schema';
import {
  configureForAgentRefusal,
  webhookWriteRefusal,
  type LiveVoiceUrl,
} from './phoneLineGuard';

interface TwilioPhoneNumber {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  voiceUrl: string | null;
  voiceMethod: string;
  smsUrl: string | null;
  statusCallback: string | null;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

interface PhoneEndpointWithAgent extends PhoneEndpoint {
  agentName?: string;
  agentSlug?: string;
}

class TwilioPhoneManagementService {
  private static instance: TwilioPhoneManagementService;

  private constructor() {}

  static getInstance(): TwilioPhoneManagementService {
    if (!TwilioPhoneManagementService.instance) {
      TwilioPhoneManagementService.instance = new TwilioPhoneManagementService();
    }
    return TwilioPhoneManagementService.instance;
  }

  async listTwilioPhoneNumbers(): Promise<TwilioPhoneNumber[]> {
    try {
      const client = await getTwilioClient();
      const numbers = await client.incomingPhoneNumbers.list();
      
      return numbers.map(num => ({
        sid: num.sid,
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName,
        voiceUrl: num.voiceUrl,
        voiceMethod: num.voiceMethod,
        smsUrl: num.smsUrl,
        statusCallback: num.statusCallback,
        capabilities: {
          voice: num.capabilities?.voice ?? false,
          sms: num.capabilities?.sms ?? false,
          mms: num.capabilities?.mms ?? false,
        },
      }));
    } catch (error) {
      console.error('[TWILIO PHONE MGMT] Error listing phone numbers:', error);
      throw error;
    }
  }

  async syncPhoneNumbersFromTwilio(): Promise<{ synced: number; created: number; updated: number }> {
    try {
      const twilioNumbers = await this.listTwilioPhoneNumbers();
      let created = 0;
      let updated = 0;

      for (const num of twilioNumbers) {
        const existing = await db.select()
          .from(phoneEndpoints)
          .where(eq(phoneEndpoints.twilioSid, num.sid))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(phoneEndpoints).values({
            twilioSid: num.sid,
            phoneNumber: num.phoneNumber,
            friendlyName: num.friendlyName,
            voiceWebhookUrl: num.voiceUrl,
            voiceWebhookMethod: num.voiceMethod,
            smsWebhookUrl: num.smsUrl,
            statusCallbackUrl: num.statusCallback,
            lastSyncedAt: new Date(),
            syncStatus: 'synced',
          });
          created++;
        } else {
          await db.update(phoneEndpoints)
            .set({
              friendlyName: num.friendlyName,
              voiceWebhookUrl: num.voiceUrl,
              voiceWebhookMethod: num.voiceMethod,
              smsWebhookUrl: num.smsUrl,
              statusCallbackUrl: num.statusCallback,
              lastSyncedAt: new Date(),
              syncStatus: 'synced',
              updatedAt: new Date(),
            })
            .where(eq(phoneEndpoints.twilioSid, num.sid));
          updated++;
        }
      }

      console.log(`[TWILIO PHONE MGMT] Sync complete: ${created} created, ${updated} updated`);
      return { synced: twilioNumbers.length, created, updated };
    } catch (error) {
      console.error('[TWILIO PHONE MGMT] Error syncing phone numbers:', error);
      throw error;
    }
  }

  async getPhoneEndpoints(): Promise<PhoneEndpointWithAgent[]> {
    try {
      const { agents } = await import('../../shared/schema');
      
      const endpoints = await db.select({
        endpoint: phoneEndpoints,
        agentName: agents.name,
        agentSlug: agents.slug,
      })
        .from(phoneEndpoints)
        .leftJoin(agents, eq(phoneEndpoints.assignedAgentId, agents.id))
        .orderBy(phoneEndpoints.phoneNumber);

      return endpoints.map(e => ({
        ...e.endpoint,
        agentName: e.agentName ?? undefined,
        agentSlug: e.agentSlug ?? undefined,
      }));
    } catch (error) {
      console.error('[TWILIO PHONE MGMT] Error getting phone endpoints:', error);
      throw error;
    }
  }

  async getPhoneEndpoint(id: string): Promise<PhoneEndpoint | undefined> {
    const [endpoint] = await db.select()
      .from(phoneEndpoints)
      .where(eq(phoneEndpoints.id, id));
    return endpoint;
  }

  async assignAgentToPhoneEndpoint(endpointId: string, agentId: string | null): Promise<PhoneEndpoint> {
    const [updated] = await db.update(phoneEndpoints)
      .set({
        assignedAgentId: agentId,
        updatedAt: new Date(),
      })
      .where(eq(phoneEndpoints.id, endpointId))
      .returning();
    return updated;
  }

  async updatePhoneEndpointWebhook(
    endpointId: string,
    webhookUrl: string,
    options?: {
      updateTwilio?: boolean;
      webhookMethod?: string;
    }
  ): Promise<PhoneEndpoint> {
    const endpoint = await this.getPhoneEndpoint(endpointId);
    if (!endpoint) {
      throw new Error('Phone endpoint not found');
    }

    if (options?.updateTwilio) {
      // A number answered by the voice runtime may only be pointed at another
      // runtime URL from here (src/services/phoneLineGuard.ts). The stored
      // voiceWebhookUrl is not trusted for this: the Hub's copy was nine
      // months stale on 2026-11-26, so the number is read from Twilio.
      const refusal = webhookWriteRefusal(
        endpoint.phoneNumber,
        await this.readLiveVoiceUrl(endpoint.twilioSid),
        webhookUrl,
      );
      if (refusal) {
        console.warn(
          `[TWILIO PHONE MGMT] ✗ REFUSED a webhook write on ${endpoint.phoneNumber}: ${refusal.reason}`,
        );
        throw refusal;
      }
      // Never point a live number at a development host. Publishing recomputes
      // callback URLs, and a dev URL written onto a production number sends every
      // inbound call to a workspace that no longer answers — with the number looking
      // correctly configured in Twilio. Saving the URL in our own table is still
      // allowed (syncStatus stays 'pending') so the intent isn't lost.
      if (getEnvironmentConfig().isProduction && isDevCallbackUrl(webhookUrl)) {
        throw new Error(
          `Refusing to write a development webhook (${webhookUrl}) onto ${endpoint.phoneNumber} from a production deployment. Use the published host, or set the DOMAIN secret and retry.`,
        );
      }
      try {
        const client = await getTwilioClient();
        await client.incomingPhoneNumbers(endpoint.twilioSid).update({
          voiceUrl: webhookUrl,
          voiceMethod: options?.webhookMethod || 'POST',
        });
        console.log(`[TWILIO PHONE MGMT] Updated Twilio webhook for ${endpoint.phoneNumber} to ${webhookUrl}`);
      } catch (error) {
        console.error('[TWILIO PHONE MGMT] Error updating Twilio webhook:', error);
        throw new Error('Failed to update webhook in Twilio');
      }
    }

    const [updated] = await db.update(phoneEndpoints)
      .set({
        voiceWebhookUrl: webhookUrl,
        voiceWebhookMethod: options?.webhookMethod || 'POST',
        lastSyncedAt: options?.updateTwilio ? new Date() : undefined,
        syncStatus: options?.updateTwilio ? 'synced' : 'pending',
        updatedAt: new Date(),
      })
      .where(eq(phoneEndpoints.id, endpointId))
      .returning();

    return updated;
  }

  buildWebhookUrl(domain: string, agentSlug?: string): string {
    const baseUrl = `https://${domain}/api/voice`;
    if (agentSlug) {
      return `${baseUrl}/${agentSlug}/incoming`;
    }
    return `${baseUrl}/incoming`;
  }

  /** The number's Voice URL as Twilio has it now. A failed read is
   * reported, never guessed, so a caller can refuse rather than assume. */
  async readLiveVoiceUrl(twilioSid: string): Promise<LiveVoiceUrl> {
    try {
      const client = await getTwilioClient();
      const number = await client.incomingPhoneNumbers(twilioSid).fetch();
      return { ok: true, url: number.voiceUrl || null };
    } catch (error) {
      console.error(
        '[TWILIO PHONE MGMT] Could not read a number\'s Voice URL from Twilio:',
        error instanceof Error ? error.message : error,
      );
      return { ok: false };
    }
  }

  /**
   * "Configure for agent" on the Twilio page. It used to write
   * buildWebhookUrl()'s `/api/voice/<slug>/incoming` onto the number, a path
   * neither pipeline serves, so on any live line it could only break every
   * call. It now changes nothing, in Twilio or in our table, and always
   * throws a PhoneLineRefusal saying what the number is pointed at now (read
   * from Twilio). See src/services/phoneLineGuard.ts.
   */
  async configurePhoneForAgent(
    endpointId: string,
    _agentId: string,
    agentSlug: string,
    domain: string | undefined,
  ): Promise<never> {
    const endpoint = await this.getPhoneEndpoint(endpointId);
    if (!endpoint) {
      throw new Error('Phone endpoint not found');
    }
    const refusal = configureForAgentRefusal(
      endpoint.phoneNumber,
      await this.readLiveVoiceUrl(endpoint.twilioSid),
      domain ? this.buildWebhookUrl(domain, agentSlug) : null,
    );
    console.warn(
      `[TWILIO PHONE MGMT] ✗ REFUSED configure-for-agent on ${endpoint.phoneNumber}: ${refusal.reason} — nothing changed`,
    );
    throw refusal;
  }
}

export const twilioPhoneManagementService = TwilioPhoneManagementService.getInstance();
