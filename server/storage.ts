// Storage layer for Azul Vision AI Operations Hub
// Reference: blueprint:javascript_database and blueprint:javascript_log_in_with_replit

import { withRetry } from './services/dbResilience';
import {
  users,
  agents,
  campaigns,
  campaignContacts,
  campaignContactAttempts,
  callLogs,
  smsLogs,
  callbackQueue,
  agentTools,
  supportTickets,
  schedulingWorkflows,
  userInvitations,
  passwordResetTokens,
  agentPrompts,
  agentPromptVersions,
  dailyOpenaiCosts,
  type User,
  type UpsertUser,
  type Agent,
  type InsertAgent,
  type Campaign,
  type InsertCampaign,
  type CampaignContact,
  type InsertCampaignContact,
  type CampaignContactAttempt,
  type InsertCampaignContactAttempt,
  type CallLog,
  type InsertCallLog,
  type SmsLog,
  type InsertSmsLog,
  type CallbackQueueItem,
  type InsertCallbackQueueItem,
  type SupportTicket,
  type InsertSupportTicket,
  type SchedulingWorkflow,
  type InsertSchedulingWorkflow,
  type UserInvitation,
  type InsertUserInvitation,
  type PasswordResetToken,
  type InsertPasswordResetToken,
  type AgentPrompt,
  type InsertAgentPrompt,
  type AgentPromptVersion,
  type InsertAgentPromptVersion,
  type DailyOpenaiCost,
  type InsertDailyOpenaiCost,
} from "../shared/schema";
import { db } from "./db";
import { eq, desc, and, or, count, gte, lte, lt, inArray, isNull, isNotNull, ilike, sql } from "drizzle-orm";

export interface IStorage {
  // User operations (required for Replit Auth)
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  
  // Agent operations
  getAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  getAgentBySlug(slug: string): Promise<Agent | undefined>;
  getAgentByPhoneNumber(phoneNumber: string): Promise<Agent | undefined>;
  createAgent(agent: InsertAgent): Promise<Agent>;
  updateAgent(id: string, updates: Partial<InsertAgent>): Promise<Agent>;
  
  // Campaign operations
  getCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  getCampaignByName(name: string): Promise<Campaign | undefined>;
  getOrCreateCampaignByName(name: string, defaults: InsertCampaign): Promise<Campaign>;
  createCampaign(campaign: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: string, updates: Partial<InsertCampaign>): Promise<Campaign>;
  deleteCampaign(id: string): Promise<void>;
  
  // Campaign contacts
  createCampaignContacts(contacts: InsertCampaignContact[]): Promise<CampaignContact[]>;
  getCampaignContacts(campaignId: string): Promise<CampaignContact[]>;
  
  // Call logs
  createCallLog(callLog: InsertCallLog): Promise<CallLog>;
  updateCallLog(id: string, updates: Partial<InsertCallLog>): Promise<CallLog>;
  getCallLogs(options?: {
    page?: number;
    limit?: number;
    status?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    data: CallLog[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }>;
  getCallLog(id: string): Promise<CallLog | undefined>;
  getCallLogByCallSid(callSid: string): Promise<CallLog | undefined>;
  claimTicketCreation(callSid: string, timeoutMs?: number): Promise<{ claimed: boolean; existingTicket?: string }>;
  releaseTicketCreationLock(callSid: string, ticketNumber?: string): Promise<void>;
  
  // SMS logs
  createSmsLog(smsLog: InsertSmsLog): Promise<SmsLog>;
  getSmsLogs(limit?: number): Promise<SmsLog[]>;
  
  // Callback queue
  createCallbackQueueItem(item: InsertCallbackQueueItem): Promise<CallbackQueueItem>;
  getCallbackQueue(options?: {
    status?: string;
    priority?: string;
    assignedTo?: string;
  }): Promise<CallbackQueueItem[]>;
  updateCallbackQueueItem(id: string, updates: Partial<InsertCallbackQueueItem>): Promise<CallbackQueueItem>;
  
  // Stats
  getStats(): Promise<{
    totalCalls: number;
    activeCallbacks: number;
    activeCampaigns: number;
    totalAgents: number;
    recentCalls: CallLog[];
    recentCallbacks: CallbackQueueItem[];
  }>;
}

export class DatabaseStorage implements IStorage {
  // User operations (required for Replit Auth)
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  // Agent operations
  async getAgents(): Promise<Agent[]> {
    return await withRetry(async () => {
      return await db.select().from(agents).orderBy(desc(agents.createdAt));
    }, 'getAgents');
  }

  async getAgent(id: string): Promise<Agent | undefined> {
    return await withRetry(async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      return agent;
    }, `getAgent(${id.slice(-8)})`);
  }

  async getAgentBySlug(slug: string): Promise<Agent | undefined> {
    return await withRetry(async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.slug, slug));
      return agent;
    }, `getAgentBySlug(${slug})`);
  }

  async getAgentByPhoneNumber(phoneNumber: string): Promise<Agent | undefined> {
    return await withRetry(async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.twilioPhoneNumber, phoneNumber));
      return agent;
    }, `getAgentByPhone(${phoneNumber.slice(-4)})`);
  }

  async createAgent(agentData: InsertAgent): Promise<Agent> {
    const [agent] = await db.insert(agents).values(agentData).returning();
    return agent;
  }

  async updateAgent(id: string, updates: Partial<InsertAgent>): Promise<Agent> {
    const [agent] = await db
      .update(agents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    return agent;
  }

  // Campaign operations
  async getCampaigns(): Promise<Campaign[]> {
    return await withRetry(async () => {
      return await db.select().from(campaigns).where(isNull(campaigns.deletedAt)).orderBy(desc(campaigns.createdAt));
    }, 'getCampaigns');
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    return await withRetry(async () => {
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
      return campaign;
    }, `getCampaign(${id.slice(-8)})`);
  }

  async getCampaignByName(name: string): Promise<Campaign | undefined> {
    return await withRetry(async () => {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(and(
          eq(campaigns.name, name),
          eq(campaigns.status, 'running'),
          isNull(campaigns.deletedAt)
        ));
      return campaign;
    }, `getCampaignByName(${name})`);
  }

  async getOrCreateCampaignByName(name: string, defaults: InsertCampaign): Promise<Campaign> {
    const existing = await this.getCampaignByName(name);
    if (existing) {
      return existing;
    }
    
    try {
      const [created] = await db.insert(campaigns).values({ ...defaults, name }).returning();
      console.info(`[STORAGE] Created new campaign: ${name} (${created.id})`);
      return created;
    } catch (error: any) {
      if (error?.code === '23505') {
        const retryExisting = await this.getCampaignByName(name);
        if (retryExisting) {
          console.info(`[STORAGE] Campaign already exists (concurrent create): ${name}`);
          return retryExisting;
        }
      }
      throw error;
    }
  }

  async createCampaign(campaignData: InsertCampaign): Promise<Campaign> {
    const [campaign] = await db.insert(campaigns).values(campaignData).returning();
    return campaign;
  }

  async updateCampaign(id: string, updates: Partial<InsertCampaign>): Promise<Campaign> {
    const [campaign] = await db
      .update(campaigns)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(campaigns.id, id))
      .returning();
    return campaign;
  }

  async deleteCampaign(id: string): Promise<void> {
    await db
      .update(campaigns)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(campaigns.id, id));
  }

  // Campaign contacts
  async createCampaignContacts(contactsData: InsertCampaignContact[]): Promise<CampaignContact[]> {
    return await db.insert(campaignContacts).values(contactsData).returning();
  }

  async getCampaignContacts(campaignId: string): Promise<CampaignContact[]> {
    return await db
      .select()
      .from(campaignContacts)
      .where(eq(campaignContacts.campaignId, campaignId));
  }

  async updateCampaignContact(id: string, updates: Partial<InsertCampaignContact>): Promise<CampaignContact> {
    const [contact] = await db
      .update(campaignContacts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(campaignContacts.id, id))
      .returning();
    return contact;
  }

  async getCampaignContactByPhone(campaignId: string, phoneNumber: string): Promise<CampaignContact | undefined> {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    const variants = [
      normalizedPhone,
      `+${normalizedPhone}`,
      `+1${normalizedPhone}`,
      normalizedPhone.slice(-10),
    ];
    
    const [contact] = await db
      .select()
      .from(campaignContacts)
      .where(
        and(
          eq(campaignContacts.campaignId, campaignId),
          or(
            ...variants.map(v => eq(campaignContacts.phoneNumber, v))
          )
        )
      )
      .limit(1);
    return contact;
  }

  async getContactsDueForOutreach(campaignId: string, limit: number = 10): Promise<CampaignContact[]> {
    return await withRetry(async () => {
      const now = new Date();
      // Include contacts stuck in 'calling' status for more than 10 minutes (likely failed calls)
      const stuckCallingThreshold = new Date(now.getTime() - 10 * 60 * 1000);
      // Include contacts stuck in 'answered' status for more than 30 minutes (agent never marked outcome)
      const stuckAnsweredThreshold = new Date(now.getTime() - 30 * 60 * 1000);
      
      return await db
        .select()
        .from(campaignContacts)
        .where(
          and(
            eq(campaignContacts.campaignId, campaignId),
            or(
              // Normal pending contacts ready for outreach
              and(
                or(
                  eq(campaignContacts.outreachStatus, 'pending'),
                  eq(campaignContacts.outreachStatus, 'callback_scheduled')
                ),
                or(
                  isNull(campaignContacts.nextAttemptAt),
                  lte(campaignContacts.nextAttemptAt, now)
                )
              ),
              // Stuck 'calling' contacts - their call likely failed without callback
              and(
                eq(campaignContacts.outreachStatus, 'calling'),
                lte(campaignContacts.updatedAt, stuckCallingThreshold)
              ),
              // Stuck 'answered' contacts - call was answered but agent never marked final outcome
              and(
                eq(campaignContacts.outreachStatus, 'answered'),
                lte(campaignContacts.updatedAt, stuckAnsweredThreshold)
              )
            )
          )
        )
        .orderBy(campaignContacts.nextAttemptAt)
        .limit(limit);
    }, `getContactsDue(${campaignId.slice(-8)})`);
  }

  async createContactAttempt(attemptData: InsertCampaignContactAttempt): Promise<CampaignContactAttempt> {
    const [attempt] = await db.insert(campaignContactAttempts).values(attemptData).returning();
    return attempt;
  }

  async getContactAttempts(contactId: string): Promise<CampaignContactAttempt[]> {
    return await db
      .select()
      .from(campaignContactAttempts)
      .where(eq(campaignContactAttempts.contactId, contactId))
      .orderBy(desc(campaignContactAttempts.attemptedAt));
  }

  async updateContactAttempt(id: string, updates: Partial<InsertCampaignContactAttempt>): Promise<CampaignContactAttempt> {
    const [attempt] = await db
      .update(campaignContactAttempts)
      .set(updates)
      .where(eq(campaignContactAttempts.id, id))
      .returning();
    return attempt;
  }

  async getContactAttemptByCallSid(callSid: string): Promise<CampaignContactAttempt | undefined> {
    const [attempt] = await db
      .select()
      .from(campaignContactAttempts)
      .where(eq(campaignContactAttempts.callSid, callSid))
      .limit(1);
    return attempt;
  }

  // Call logs
  async createCallLog(callLogData: InsertCallLog): Promise<CallLog> {
    return await withRetry(async () => {
      const [callLog] = await db.insert(callLogs).values(callLogData).returning();
      return callLog;
    }, `createCallLog(${callLogData.callSid?.slice(-8) || 'new'})`);
  }

  async updateCallLog(id: string, updates: Partial<InsertCallLog>): Promise<CallLog> {
    return await withRetry(async () => {
      const [callLog] = await db
        .update(callLogs)
        .set(updates)
        .where(eq(callLogs.id, id))
        .returning();
      return callLog;
    }, `updateCallLog(${id.slice(-8)})`);
  }

  async getCallLogBySid(callSid: string): Promise<CallLog | undefined> {
    const [callLog] = await db
      .select()
      .from(callLogs)
      .where(eq(callLogs.callSid, callSid))
      .limit(1);
    return callLog;
  }

  /**
   * Atomically claim the right to create a ticket for this call.
   * Returns { claimed: true } if lock acquired, or { claimed: false, existingTicket } if ticket exists.
   */
  async claimTicketCreation(callSid: string, timeoutMs: number = 60000): Promise<{ claimed: boolean; existingTicket?: string }> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() - timeoutMs);
    
    // First check if ticket already exists
    const existing = await this.getCallLogBySid(callSid);
    if (!existing) {
      return { claimed: false }; // No call log to lock
    }
    if (existing.ticketNumber) {
      return { claimed: false, existingTicket: existing.ticketNumber };
    }
    
    // Atomic compare-and-set: only claim if no active lock exists
    const result = await db
      .update(callLogs)
      .set({ ticketCreationPending: now })
      .where(
        and(
          eq(callLogs.callSid, callSid),
          isNull(callLogs.ticketNumber), // No ticket exists
          or(
            isNull(callLogs.ticketCreationPending), // No lock
            lte(callLogs.ticketCreationPending, lockExpiry) // Lock expired
          )
        )
      )
      .returning();
    
    return { claimed: result.length > 0 };
  }

  /**
   * Release the ticket creation lock, optionally saving the ticket number.
   */
  async releaseTicketCreationLock(callSid: string, ticketNumber?: string): Promise<void> {
    await db
      .update(callLogs)
      .set({ 
        ticketCreationPending: null,
        ...(ticketNumber ? { ticketNumber } : {})
      })
      .where(eq(callLogs.callSid, callSid));
  }

  async getCallLogs(options?: {
    page?: number;
    limit?: number;
    status?: string;
    direction?: string;
    startDate?: Date;
    endDate?: Date;
    hasTicket?: boolean;
    transferred?: boolean;
    agentId?: string;
    search?: string;
    callQuality?: 'ghost' | 'real';
  }) {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const offset = (page - 1) * limit;

    const conditions = [];
    
    if (options?.status) {
      const statuses = options.status.split(',').map(s => s.trim());
      if (statuses.length > 1) {
        conditions.push(inArray(callLogs.status, statuses as any));
      } else {
        conditions.push(eq(callLogs.status, options.status as any));
      }
    }
    
    if (options?.direction) {
      conditions.push(eq(callLogs.direction, options.direction as any));
    }
    
    if (options?.startDate) {
      conditions.push(gte(callLogs.createdAt, options.startDate));
    }
    
    if (options?.endDate) {
      conditions.push(lte(callLogs.createdAt, options.endDate));
    }
    
    if (options?.hasTicket === true) {
      conditions.push(isNotNull(callLogs.ticketNumber));
    } else if (options?.hasTicket === false) {
      conditions.push(isNull(callLogs.ticketNumber));
    }
    
    if (options?.transferred === true) {
      conditions.push(eq(callLogs.transferredToHuman, true));
    } else if (options?.transferred === false) {
      conditions.push(or(eq(callLogs.transferredToHuman, false), isNull(callLogs.transferredToHuman)));
    }
    
    if (options?.agentId) {
      conditions.push(eq(callLogs.agentId, options.agentId));
    }
    
    if (options?.search) {
      const searchPattern = `%${options.search}%`;
      conditions.push(
        or(
          ilike(callLogs.from, searchPattern),
          ilike(callLogs.to, searchPattern),
          ilike(callLogs.callerName, searchPattern),
          ilike(callLogs.patientName, searchPattern),
          ilike(callLogs.ticketNumber, searchPattern)
        )
      );
    }
    
    if (options?.callQuality === 'ghost') {
      conditions.push(
        or(
          and(isNull(callLogs.recordingUrl), isNull(callLogs.transcript)),
          lt(callLogs.duration, 60)
        )
      );
    } else if (options?.callQuality === 'real') {
      conditions.push(
        and(
          or(isNotNull(callLogs.recordingUrl), isNotNull(callLogs.transcript)),
          gte(callLogs.duration, 60)
        )
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult] = await db
      .select({ count: count() })
      .from(callLogs)
      .where(whereClause);

    const data = await db
      .select()
      .from(callLogs)
      .where(whereClause)
      .orderBy(desc(callLogs.createdAt))
      .limit(limit)
      .offset(offset);

    const total = totalResult?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async getCallLog(id: string): Promise<CallLog | undefined> {
    const [callLog] = await db.select().from(callLogs).where(eq(callLogs.id, id));
    return callLog;
  }

  async getCallLogByCallSid(callSid: string): Promise<CallLog | undefined> {
    return await withRetry(async () => {
      const [callLog] = await db.select().from(callLogs).where(eq(callLogs.callSid, callSid));
      return callLog;
    }, `getCallLogByCallSid(${callSid.slice(-8)})`);
  }

  async getCallLogsWithoutGrades(limit: number = 10): Promise<CallLog[]> {
    return await db
      .select()
      .from(callLogs)
      .where(
        and(
          isNull(callLogs.gradedAt),
          isNotNull(callLogs.transcript),
          eq(callLogs.status, 'completed')
        )
      )
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
  }

  async getCallLogsWithoutCosts(limit: number = 10): Promise<CallLog[]> {
    return await db
      .select()
      .from(callLogs)
      .where(
        and(
          isNull(callLogs.costCalculatedAt),
          eq(callLogs.status, 'completed')
        )
      )
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
  }

  async getCallLogsNeedingInsights(afterDate: Date, limit: number = 50): Promise<CallLog[]> {
    return await db
      .select()
      .from(callLogs)
      .where(
        and(
          isNull(callLogs.twilioInsightsFetchedAt),
          isNotNull(callLogs.callSid),
          eq(callLogs.status, 'completed'),
          gte(callLogs.createdAt, afterDate)
        )
      )
      .orderBy(desc(callLogs.createdAt))
      .limit(limit);
  }

  async getCallHistoryByPhone(phoneNumber: string, maxCalls: number = 5): Promise<CallLog[]> {
    return await withRetry(async () => {
      const normalizedPhone = phoneNumber.replace(/\D/g, "");
      const phoneVariants = [
        phoneNumber,
        `+1${normalizedPhone}`,
        `+${normalizedPhone}`,
        normalizedPhone,
      ];

      return await db
        .select()
        .from(callLogs)
        .where(
          and(
            or(
              inArray(callLogs.from, phoneVariants),
              inArray(callLogs.to, phoneVariants)
            ),
            eq(callLogs.status, 'completed')
          )
        )
        .orderBy(desc(callLogs.createdAt))
        .limit(maxCalls);
    }, `getCallHistory(${phoneNumber.slice(-4)})`);
  }

  // SMS logs
  async createSmsLog(smsLogData: InsertSmsLog): Promise<SmsLog> {
    const [smsLog] = await db.insert(smsLogs).values(smsLogData).returning();
    return smsLog;
  }

  async getSmsLogs(limit: number = 100): Promise<SmsLog[]> {
    return await db
      .select()
      .from(smsLogs)
      .orderBy(desc(smsLogs.createdAt))
      .limit(limit);
  }

  // Callback queue
  async createCallbackQueueItem(itemData: InsertCallbackQueueItem): Promise<CallbackQueueItem> {
    const [item] = await db.insert(callbackQueue).values(itemData).returning();
    return item;
  }

  async getCallbackQueue(options?: {
    status?: string;
    priority?: string;
    assignedTo?: string;
  }): Promise<CallbackQueueItem[]> {
    const conditions = [];
    
    if (options?.status) {
      conditions.push(eq(callbackQueue.status, options.status as any));
    }
    if (options?.priority) {
      conditions.push(eq(callbackQueue.priority, options.priority as any));
    }
    if (options?.assignedTo) {
      conditions.push(eq(callbackQueue.assignedTo, options.assignedTo));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return await db
      .select()
      .from(callbackQueue)
      .where(whereClause)
      .orderBy(desc(callbackQueue.createdAt));
  }

  async updateCallbackQueueItem(id: string, updates: Partial<InsertCallbackQueueItem>): Promise<CallbackQueueItem> {
    const [item] = await db
      .update(callbackQueue)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(callbackQueue.id, id))
      .returning();
    return item;
  }

  async createSupportTicket(ticketData: InsertSupportTicket): Promise<SupportTicket> {
    const [ticket] = await db.insert(supportTickets).values(ticketData).returning();
    return ticket;
  }

  async updateSupportTicket(id: string, updates: Partial<InsertSupportTicket>): Promise<SupportTicket> {
    const [ticket] = await db
      .update(supportTickets)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(supportTickets.id, id))
      .returning();
    return ticket;
  }

  async getSupportTicket(id: string): Promise<SupportTicket | undefined> {
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, id));
    return ticket;
  }

  async getSupportTickets(options?: {
    status?: string;
    department?: string;
  }): Promise<SupportTicket[]> {
    const conditions = [];
    
    if (options?.status) {
      conditions.push(eq(supportTickets.status, options.status as any));
    }
    if (options?.department) {
      conditions.push(eq(supportTickets.department, options.department as any));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return await db
      .select()
      .from(supportTickets)
      .where(whereClause)
      .orderBy(desc(supportTickets.createdAt));
  }

  async getStats() {
    const [totalCallsResult] = await db
      .select({ count: db.$count(callLogs.id) })
      .from(callLogs);
    
    const [activeCallbacksResult] = await db
      .select({ count: db.$count(callbackQueue.id) })
      .from(callbackQueue)
      .where(eq(callbackQueue.status, 'pending'));
    
    const [activeCampaignsResult] = await db
      .select({ count: db.$count(campaigns.id) })
      .from(campaigns)
      .where(eq(campaigns.status, 'running'));
    
    const [totalAgentsResult] = await db
      .select({ count: db.$count(agents.id) })
      .from(agents);
    
    const recentCalls = await db
      .select()
      .from(callLogs)
      .orderBy(desc(callLogs.createdAt))
      .limit(5);
    
    const recentCallbacks = await db
      .select()
      .from(callbackQueue)
      .orderBy(desc(callbackQueue.createdAt))
      .limit(5);

    return {
      totalCalls: totalCallsResult?.count ?? 0,
      activeCallbacks: activeCallbacksResult?.count ?? 0,
      activeCampaigns: activeCampaignsResult?.count ?? 0,
      totalAgents: totalAgentsResult?.count ?? 0,
      recentCalls,
      recentCallbacks,
    };
  }

  async createSchedulingWorkflow(data: InsertSchedulingWorkflow) {
    const [workflow] = await db.insert(schedulingWorkflows).values(data).returning();
    return workflow;
  }

  async getSchedulingWorkflow(id: string) {
    const [workflow] = await db.select().from(schedulingWorkflows).where(eq(schedulingWorkflows.id, id));
    return workflow;
  }

  async getSchedulingWorkflowByCallLog(callLogId: string) {
    const [workflow] = await db.select().from(schedulingWorkflows).where(eq(schedulingWorkflows.callLogId, callLogId));
    return workflow;
  }

  async updateSchedulingWorkflow(id: string, data: Partial<SchedulingWorkflow>) {
    const [updated] = await db
      .update(schedulingWorkflows)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schedulingWorkflows.id, id))
      .returning();
    return updated;
  }

  // Transaction-safe update with row-level locking for operator interventions
  async updateSchedulingWorkflowWithLock(id: string, updateFn: (current: SchedulingWorkflow) => Partial<SchedulingWorkflow>) {
    const { WorkflowValidationError } = await import('./errors');
    
    return await db.transaction(async (tx) => {
      // Lock the row to prevent concurrent updates
      const [current] = await tx
        .select()
        .from(schedulingWorkflows)
        .where(eq(schedulingWorkflows.id, id))
        .for('update'); // SELECT FOR UPDATE lock
      
      if (!current) {
        throw new WorkflowValidationError(`Workflow ${id} not found`);
      }
      
      // Calculate updates based on locked current state (may throw WorkflowValidationError)
      const updates = updateFn(current);
      
      // Apply updates within transaction
      const [updated] = await tx
        .update(schedulingWorkflows)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schedulingWorkflows.id, id))
        .returning();
      
      return updated;
    });
  }

  async getActiveSchedulingWorkflows() {
    return await db
      .select()
      .from(schedulingWorkflows)
      .where(
        or(
          eq(schedulingWorkflows.status, 'initiated'),
          eq(schedulingWorkflows.status, 'collecting_data'),
          eq(schedulingWorkflows.status, 'form_filling'),
          eq(schedulingWorkflows.status, 'otp_requested'),
          eq(schedulingWorkflows.status, 'otp_verified'),
          eq(schedulingWorkflows.status, 'submitting')
        )
      )
      .orderBy(desc(schedulingWorkflows.createdAt));
  }

  async getSchedulingWorkflows(filters?: { status?: string; campaignId?: string }) {
    let query = db.select().from(schedulingWorkflows);

    if (filters) {
      const conditions = [];
      if (filters.status) {
        conditions.push(eq(schedulingWorkflows.status, filters.status as any));
      }
      if (filters.campaignId) {
        conditions.push(eq(schedulingWorkflows.campaignId, filters.campaignId));
      }
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }
    }

    return await query.orderBy(desc(schedulingWorkflows.createdAt));
  }

  // Agent Prompts operations
  async getAgentPrompt(agentSlug: string): Promise<AgentPrompt | undefined> {
    const [prompt] = await db.select().from(agentPrompts).where(eq(agentPrompts.agentSlug, agentSlug));
    return prompt;
  }

  async getAllAgentPrompts(): Promise<AgentPrompt[]> {
    return await db.select().from(agentPrompts).orderBy(desc(agentPrompts.updatedAt));
  }

  async upsertAgentPrompt(data: InsertAgentPrompt): Promise<AgentPrompt> {
    const [existing] = await db.select().from(agentPrompts).where(eq(agentPrompts.agentSlug, data.agentSlug));
    
    if (existing) {
      const [updated] = await db
        .update(agentPrompts)
        .set({ ...data, version: (existing.version || 1) + 1, updatedAt: new Date() })
        .where(eq(agentPrompts.agentSlug, data.agentSlug))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(agentPrompts).values(data).returning();
      return created;
    }
  }

  async createAgentPromptVersion(data: InsertAgentPromptVersion): Promise<AgentPromptVersion> {
    const [version] = await db.insert(agentPromptVersions).values(data).returning();
    return version;
  }

  async getAgentPromptVersions(agentSlug: string): Promise<AgentPromptVersion[]> {
    return await db
      .select()
      .from(agentPromptVersions)
      .where(eq(agentPromptVersions.agentSlug, agentSlug))
      .orderBy(desc(agentPromptVersions.version));
  }

  // User operations for custom auth
  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async createUser(userData: UpsertUser): Promise<User> {
    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async updateUser(id: string, updates: Partial<UpsertUser>): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  // Daily OpenAI costs operations
  async getDailyOpenaiCost(date: string): Promise<DailyOpenaiCost | undefined> {
    const [cost] = await db.select().from(dailyOpenaiCosts).where(eq(dailyOpenaiCosts.date, date));
    return cost;
  }

  async getDailyOpenaiCosts(startDate: string, endDate: string): Promise<DailyOpenaiCost[]> {
    return await db
      .select()
      .from(dailyOpenaiCosts)
      .where(and(
        gte(dailyOpenaiCosts.date, startDate),
        lte(dailyOpenaiCosts.date, endDate)
      ))
      .orderBy(desc(dailyOpenaiCosts.date));
  }

  async upsertDailyOpenaiCost(cost: InsertDailyOpenaiCost): Promise<DailyOpenaiCost> {
    const [result] = await db
      .insert(dailyOpenaiCosts)
      .values(cost)
      .onConflictDoUpdate({
        target: dailyOpenaiCosts.date,
        set: {
          actualCostCents: cost.actualCostCents,
          estimatedCostCents: cost.estimatedCostCents,
          realtimeCostCents: cost.realtimeCostCents,
          otherCostCents: cost.otherCostCents,
          discrepancyCents: cost.discrepancyCents,
          discrepancyPercent: cost.discrepancyPercent,
          reconciledAt: new Date(),
          reconciledBy: cost.reconciledBy,
          rawApiResponse: cost.rawApiResponse,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async getEstimatedOpenaiCostForDate(date: string): Promise<number> {
    const startOfDay = new Date(date + 'T00:00:00Z');
    const endOfDay = new Date(date + 'T23:59:59.999Z');
    
    const result = await db
      .select({ totalCents: sql`COALESCE(SUM(openai_cost_cents), 0)` })
      .from(callLogs)
      .where(and(
        gte(callLogs.createdAt, startOfDay),
        lte(callLogs.createdAt, endOfDay)
      ));
    
    return Number(result[0]?.totalCents) || 0;
  }
}

export const storage = new DatabaseStorage();
