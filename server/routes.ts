// API routes for Azul Vision AI Operations Hub
// Reference: blueprint:javascript_log_in_with_replit

import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated as isReplitAuthenticated } from "./replitAuth";
import { authRouter, requireAuth, requireRole, requireAdmin, requireManager } from "./auth";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { getTwilioClient, getTwilioFromPhoneNumber } from "../src/lib/twilioClient";

// Hybrid authentication middleware - supports both Replit Auth and custom auth
const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  // First check custom session auth
  if (req.session?.userId) {
    return next();
  }
  // Fallback to Replit Auth
  return isReplitAuthenticated(req, res, next);
};

// Configure multer for CSV uploads
const upload = multer({ storage: multer.memoryStorage() });

// Helper to normalize call log fields to camelCase for frontend compatibility
function normalizeCallLog(log: any) {
  return {
    ...log,
    transferredToHuman: log.transferredToHuman ?? log.transferred_to_human ?? false,
    transcript: log.transcript ?? log.transcript_text ?? null,
    recordingUrl: log.recordingUrl ?? log.recording_url ?? null,
    callerName: log.callerName ?? log.caller_name ?? null,
    patientName: log.patientName ?? log.patient_name ?? null,
    ticketNumber: log.ticketNumber ?? log.ticket_number ?? null,
    createdAt: log.createdAt ?? log.created_at,
    updatedAt: log.updatedAt ?? log.updated_at,
    fromCarrier: log.fromCarrier ?? log.from_carrier ?? null,
    toCarrier: log.toCarrier ?? log.to_carrier ?? null,
    fromConnectionType: log.fromConnectionType ?? log.from_connection_type ?? null,
    toConnectionType: log.toConnectionType ?? log.to_connection_type ?? null,
    fromCountry: log.fromCountry ?? log.from_country ?? null,
    toCountry: log.toCountry ?? log.to_country ?? null,
    whoHungUp: log.whoHungUp ?? log.who_hung_up ?? null,
    postDialDelayMs: log.postDialDelayMs ?? log.post_dial_delay_ms ?? null,
    lastSipResponse: log.lastSipResponse ?? log.last_sip_response ?? null,
    edgeLocation: log.edgeLocation ?? log.edge_location ?? null,
    twilioInsightsFetchedAt: log.twilioInsightsFetchedAt ?? log.twilio_insights_fetched_at ?? null,
  };
}

// Rate limiting map for test calls (in-memory for MVP)
const testCallRateLimit = new Map<string, { count: number; resetTime: number }>();

// Legacy middleware removed - use requireRole from auth.ts instead
// requireRole('admin', 'manager') replaced with requireRole('admin', 'manager')

export async function registerRoutes(app: Express): Promise<Server> {
  // NOTE: Voice proxy moved to server/index.ts (before body parsers) to preserve raw bodies
  
  // Session/Auth middleware (keeps Replit Auth functional during transition)
  await setupAuth(app);
  
  // New custom auth routes (login, register, invite, password reset)
  app.use('/api/auth', authRouter);

  // ==================== Legacy Auth Routes (Replit Auth compatibility) ====================
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      // Support both custom auth and Replit Auth
      let userId: string;
      let user;
      
      if (req.session?.userId) {
        // Custom auth
        userId = req.session.userId;
        user = await storage.getUser(userId);
      } else if (req.user?.claims?.sub) {
        // Replit Auth
        userId = req.user.claims.sub;
        user = await storage.getUser(userId);
      }
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Strip sensitive fields before sending to client
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // ==================== Agent Routes ====================
  
  // Get all agents
  app.get('/api/agents', isAuthenticated, async (req, res) => {
    try {
      const agents = await storage.getAgents();
      res.json(agents);
    } catch (error) {
      console.error("Error fetching agents:", error);
      res.status(500).json({ message: "Failed to fetch agents" });
    }
  });

  // Get agent by ID
  app.get('/api/agents/:id', isAuthenticated, async (req, res) => {
    try {
      const agent = await storage.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ message: "Agent not found" });
      }
      res.json(agent);
    } catch (error) {
      console.error("Error fetching agent:", error);
      res.status(500).json({ message: "Failed to fetch agent" });
    }
  });

  // Create new agent
  app.post('/api/agents', isAuthenticated, async (req: any, res) => {
    let twilioPhoneNumber;
    try {
      const userId = req.user.claims.sub;
      twilioPhoneNumber = req.body.twilioPhoneNumber;
      
      // Normalize empty strings to null
      if (twilioPhoneNumber === '' || twilioPhoneNumber === undefined) {
        twilioPhoneNumber = null;
      }
      
      // Validate unique phone number assignment (only if assigning a number)
      if (twilioPhoneNumber !== null && twilioPhoneNumber.trim() !== '') {
        const normalizedNumber = twilioPhoneNumber.trim();
        const conflictingAgent = await storage.getAgentByPhoneNumber(normalizedNumber);
        
        if (conflictingAgent) {
          return res.status(400).json({ 
            message: `Phone number ${normalizedNumber} is already assigned to agent "${conflictingAgent.name}". Please choose a different number or unassign it from the other agent first.`
          });
        }
        
        // Use normalized number
        twilioPhoneNumber = normalizedNumber;
      } else {
        // Ensure it's null if empty
        twilioPhoneNumber = null;
      }
      
      const agentData = {
        ...req.body,
        twilioPhoneNumber,
        createdBy: userId,
      };
      const agent = await storage.createAgent(agentData);
      res.status(201).json(agent);
    } catch (error: any) {
      console.error("Error creating agent:", error);
      
      // Check for unique constraint violation on twilioPhoneNumber
      if (error.code === '23505' && error.constraint === 'agents_twilio_phone_number_unique') {
        return res.status(400).json({ 
          message: `Phone number ${twilioPhoneNumber} is already assigned to another agent. Please choose a different number or unassign it from the other agent first.`
        });
      }
      
      res.status(500).json({ message: "Failed to create agent" });
    }
  });

  // Update agent
  app.patch('/api/agents/:id', isAuthenticated, async (req, res) => {
    let twilioPhoneNumber;
    try {
      twilioPhoneNumber = req.body.twilioPhoneNumber;
      
      // Only validate if twilioPhoneNumber is being updated
      if ('twilioPhoneNumber' in req.body) {
        // Normalize empty strings to null
        if (twilioPhoneNumber === '' || twilioPhoneNumber === undefined) {
          twilioPhoneNumber = null;
        }
        
        // Validate unique phone number assignment (only if assigning a non-empty number)
        if (twilioPhoneNumber !== null && twilioPhoneNumber.trim() !== '') {
          const normalizedNumber = twilioPhoneNumber.trim();
          const conflictingAgent = await storage.getAgentByPhoneNumber(normalizedNumber);
          
          // Check if another agent (not this one) has the number
          if (conflictingAgent && conflictingAgent.id !== req.params.id) {
            return res.status(400).json({ 
              message: `Phone number ${normalizedNumber} is already assigned to agent "${conflictingAgent.name}". Please choose a different number or unassign it from the other agent first.`
            });
          }
          
          // Use normalized number
          twilioPhoneNumber = normalizedNumber;
        } else {
          // Ensure it's null if empty
          twilioPhoneNumber = null;
        }
      }
      
      // Build updates object
      const updates: any = { ...req.body };
      
      // If twilioPhoneNumber was in the request, use the normalized value
      if ('twilioPhoneNumber' in req.body) {
        updates.twilioPhoneNumber = twilioPhoneNumber;
      }
      
      const agent = await storage.updateAgent(req.params.id, updates);
      res.json(agent);
    } catch (error: any) {
      console.error("Error updating agent:", error);
      
      // Check for unique constraint violation on twilioPhoneNumber
      if (error.code === '23505' && error.constraint === 'agents_twilio_phone_number_unique') {
        return res.status(400).json({ 
          message: `Phone number ${twilioPhoneNumber} is already assigned to another agent. Please choose a different number or unassign it from the other agent first.`
        });
      }
      
      res.status(500).json({ message: "Failed to update agent" });
    }
  });

  // Get available Twilio phone numbers
  app.get('/api/twilio/phone-numbers', isAuthenticated, async (req, res) => {
    try {
      const twilioClient = await getTwilioClient();
      
      // Fetch all incoming phone numbers from Twilio account
      const phoneNumbers = await twilioClient.incomingPhoneNumbers.list({ limit: 100 });
      
      // Format phone numbers for dropdown
      const availableNumbers = phoneNumbers.map(number => ({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName || number.phoneNumber,
        capabilities: {
          voice: number.capabilities.voice,
          sms: number.capabilities.sms,
        }
      }));
      
      console.info(`[TWILIO] Found ${availableNumbers.length} phone numbers`);
      res.json(availableNumbers);
    } catch (error) {
      console.error("Error fetching Twilio phone numbers:", error);
      res.status(500).json({ 
        message: "Failed to fetch Twilio phone numbers",
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // ==================== Phone Endpoints (Twilio Management) Routes ====================
  
  // Get all phone endpoints with agent assignments
  app.get('/api/phone-endpoints', isAuthenticated, async (req, res) => {
    try {
      const { twilioPhoneManagementService } = await import('../src/services/twilioPhoneManagementService');
      const endpoints = await twilioPhoneManagementService.getPhoneEndpoints();
      res.json(endpoints);
    } catch (error) {
      console.error("Error fetching phone endpoints:", error);
      res.status(500).json({ message: "Failed to fetch phone endpoints" });
    }
  });

  // Sync phone numbers from Twilio
  app.post('/api/phone-endpoints/sync', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { twilioPhoneManagementService } = await import('../src/services/twilioPhoneManagementService');
      const result = await twilioPhoneManagementService.syncPhoneNumbersFromTwilio();
      res.json({ 
        success: true, 
        message: `Synced ${result.synced} phone numbers (${result.created} new, ${result.updated} updated)`,
        ...result 
      });
    } catch (error) {
      console.error("Error syncing phone endpoints:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to sync phone numbers from Twilio",
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Assign agent to phone endpoint
  app.post('/api/phone-endpoints/:id/assign-agent', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { twilioPhoneManagementService } = await import('../src/services/twilioPhoneManagementService');
      const { agentId } = req.body;
      
      const endpoint = await twilioPhoneManagementService.assignAgentToPhoneEndpoint(
        req.params.id, 
        agentId || null
      );
      
      res.json({ success: true, endpoint });
    } catch (error) {
      console.error("Error assigning agent to phone endpoint:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to assign agent",
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Update phone endpoint webhook (and optionally sync to Twilio)
  app.post('/api/phone-endpoints/:id/update-webhook', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { twilioPhoneManagementService } = await import('../src/services/twilioPhoneManagementService');
      const { webhookUrl, updateTwilio = false } = req.body;
      
      if (!webhookUrl) {
        return res.status(400).json({ success: false, message: 'webhookUrl is required' });
      }
      
      const endpoint = await twilioPhoneManagementService.updatePhoneEndpointWebhook(
        req.params.id,
        webhookUrl,
        { updateTwilio }
      );
      
      res.json({ 
        success: true, 
        message: updateTwilio ? 'Webhook updated in Twilio' : 'Webhook URL saved (not synced to Twilio)',
        endpoint 
      });
    } catch (error) {
      console.error("Error updating phone endpoint webhook:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to update webhook",
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Configure phone for agent (assign + update webhook)
  app.post('/api/phone-endpoints/:id/configure-for-agent', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { twilioPhoneManagementService } = await import('../src/services/twilioPhoneManagementService');
      const { agentId, agentSlug } = req.body;
      
      if (!agentId || !agentSlug) {
        return res.status(400).json({ success: false, message: 'agentId and agentSlug are required' });
      }
      
      const domain = process.env.DOMAIN;
      if (!domain) {
        return res.status(500).json({ success: false, message: 'DOMAIN environment variable not configured' });
      }
      
      const endpoint = await twilioPhoneManagementService.configurePhoneForAgent(
        req.params.id,
        agentId,
        agentSlug,
        domain
      );
      
      res.json({ 
        success: true, 
        message: `Phone configured for agent "${agentSlug}"`,
        endpoint 
      });
    } catch (error) {
      console.error("Error configuring phone for agent:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to configure phone for agent",
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // ==================== Agent Prompts Routes ====================
  
  // Get all agent prompts
  app.get('/api/agent-prompts', isAuthenticated, async (req, res) => {
    try {
      const prompts = await storage.getAllAgentPrompts();
      res.json(prompts);
    } catch (error) {
      console.error("Error fetching agent prompts:", error);
      res.status(500).json({ message: "Failed to fetch agent prompts" });
    }
  });

  // Get agent prompt by slug
  app.get('/api/agent-prompts/:slug', isAuthenticated, async (req, res) => {
    try {
      const prompt = await storage.getAgentPrompt(req.params.slug);
      res.json(prompt || null);
    } catch (error) {
      console.error("Error fetching agent prompt:", error);
      res.status(500).json({ message: "Failed to fetch agent prompt" });
    }
  });

  // Create or update agent prompt
  app.put('/api/agent-prompts/:slug', requireManager, async (req: any, res) => {
    try {
      const { slug } = req.params;
      const { greeting, personality, customInstructions, closingScript, changeNotes } = req.body;
      
      // Get current prompt for versioning
      const existingPrompt = await storage.getAgentPrompt(slug);
      
      // Upsert the prompt
      const prompt = await storage.upsertAgentPrompt({
        agentSlug: slug,
        greeting,
        personality,
        customInstructions,
        closingScript,
        publishedBy: req.session?.userId || null,
        publishedAt: new Date(),
      });
      
      // Create version history
      await storage.createAgentPromptVersion({
        agentSlug: slug,
        version: prompt.version || 1,
        greeting,
        personality,
        customInstructions,
        closingScript,
        createdBy: req.session?.userId || null,
        changeNotes: changeNotes || 'Updated prompt',
      });
      
      console.log(`[PROMPTS] Updated prompt for agent: ${slug}, version: ${prompt.version}`);
      res.json(prompt);
    } catch (error) {
      console.error("Error updating agent prompt:", error);
      res.status(500).json({ message: "Failed to update agent prompt" });
    }
  });

  // Get prompt version history
  app.get('/api/agent-prompts/:slug/versions', isAuthenticated, async (req, res) => {
    try {
      const versions = await storage.getAgentPromptVersions(req.params.slug);
      res.json(versions);
    } catch (error) {
      console.error("Error fetching prompt versions:", error);
      res.status(500).json({ message: "Failed to fetch prompt versions" });
    }
  });

  // ==================== Campaign Routes ====================
  
  // Get all campaigns
  app.get('/api/campaigns', isAuthenticated, async (req, res) => {
    try {
      const campaigns = await storage.getCampaigns();
      res.json(campaigns);
    } catch (error) {
      console.error("Error fetching campaigns:", error);
      res.status(500).json({ message: "Failed to fetch campaigns" });
    }
  });

  // Get campaign by ID
  app.get('/api/campaigns/:id', isAuthenticated, async (req, res) => {
    try {
      const campaign = await storage.getCampaign(req.params.id);
      if (!campaign) {
        return res.status(404).json({ message: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      console.error("Error fetching campaign:", error);
      res.status(500).json({ message: "Failed to fetch campaign" });
    }
  });

  // Create new campaign
  app.post('/api/campaigns', isAuthenticated, async (req: any, res) => {
    try {
      // Support both custom auth and Replit Auth
      let userId: string | undefined;
      if (req.session?.userId) {
        userId = req.session.userId;
      } else if (req.user?.claims?.sub) {
        userId = req.user.claims.sub;
      }
      
      const campaignData = {
        ...req.body,
        createdBy: userId,
      };
      const campaign = await storage.createCampaign(campaignData);
      res.status(201).json(campaign);
    } catch (error) {
      console.error("Error creating campaign:", error);
      res.status(500).json({ message: "Failed to create campaign" });
    }
  });

  // Update campaign
  app.patch('/api/campaigns/:id', isAuthenticated, async (req, res) => {
    try {
      const campaign = await storage.updateCampaign(req.params.id, req.body);
      res.json(campaign);
    } catch (error) {
      console.error("Error updating campaign:", error);
      res.status(500).json({ message: "Failed to update campaign" });
    }
  });

  // Upload contacts CSV for campaign
  app.post('/api/campaigns/:id/upload-contacts', isAuthenticated, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const csvContent = req.file.buffer.toString('utf-8');
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
      });

      const campaignId = req.params.id;

      const calculateInitialAttemptTime = (timezone: string = 'America/Los_Angeles'): Date => {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          hour12: false,
        });
        const currentHour = parseInt(formatter.format(now), 10);
        
        if (currentHour >= 8 && currentHour < 20) {
          return now;
        } else if (currentHour >= 20) {
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(8, 0, 0, 0);
          return tomorrow;
        } else {
          const today = new Date(now);
          today.setHours(8, 0, 0, 0);
          return today;
        }
      };

      const contacts = records.map((record: any) => {
        const timezone = record.timezone || record.Timezone || 'America/Los_Angeles';
        
        let appointmentDate: Date | undefined;
        const apptDateStr = record.appointmentDate || record.appointment_date || record.AppointmentDate || 
                           record.appt_date || record.ApptDate;
        const apptTimeStr = record.appointmentTime || record.appointment_time || record.AppointmentTime ||
                           record.appt_time || record.ApptTime;
        
        if (apptDateStr) {
          try {
            if (apptTimeStr) {
              appointmentDate = new Date(`${apptDateStr} ${apptTimeStr}`);
            } else {
              appointmentDate = new Date(apptDateStr);
            }
          } catch (e) {
            console.warn(`[UPLOAD] Could not parse appointment date: ${apptDateStr} ${apptTimeStr}`);
          }
        }

        return {
          campaignId: campaignId,
          phoneNumber: record.phone || record.phoneNumber || record.Phone || record.phone_number,
          firstName: record.firstName || record.first_name || record.FirstName,
          lastName: record.lastName || record.last_name || record.LastName,
          email: record.email || record.Email,
          customData: record,
          
          appointmentDate: appointmentDate,
          appointmentDoctor: record.doctor || record.Doctor || record.provider || record.Provider,
          appointmentLocation: record.location || record.Location || record.office || record.Office,
          appointmentType: record.appointmentType || record.appointment_type || record.type || record.Type,
          patientDob: record.dob || record.DOB || record.dateOfBirth || record.date_of_birth,
          
          outreachStatus: 'pending' as const,
          timezone: timezone,
          nextAttemptAt: calculateInitialAttemptTime(timezone),
          maxAttempts: 3,
        };
      });

      const createdContacts = await storage.createCampaignContacts(contacts);
      
      await storage.updateCampaign(campaignId, {
        totalContacts: createdContacts.length,
      });

      const pendingCount = createdContacts.filter(c => c.outreachStatus === 'pending').length;

      res.json({
        message: "Contacts uploaded successfully",
        count: createdContacts.length,
        pendingOutreach: pendingCount,
        appointmentsWithDates: createdContacts.filter(c => c.appointmentDate).length,
      });
    } catch (error) {
      console.error("Error uploading contacts:", error);
      res.status(500).json({ message: "Failed to upload contacts" });
    }
  });

  // Get campaign contacts
  app.get('/api/campaigns/:id/contacts', isAuthenticated, async (req, res) => {
    try {
      const contacts = await storage.getCampaignContacts(req.params.id);
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching campaign contacts:", error);
      res.status(500).json({ message: "Failed to fetch campaign contacts" });
    }
  });

  // ==================== Schedule Query for Campaign Building ====================
  
  // Get filter options for schedule query (unique values for dropdowns)
  app.get('/api/schedule/filter-options', isAuthenticated, async (req, res) => {
    try {
      const { schedule } = await import('../shared/schema');
      const { db } = await import('./db');
      const { sql } = await import('drizzle-orm');
      
      // Get unique locations (data is now clean - no normalization needed)
      const locations = await db.selectDistinct({ value: schedule.officeLocation })
        .from(schedule)
        .where(sql`${schedule.officeLocation} IS NOT NULL AND ${schedule.officeLocation} != ''`)
        .orderBy(schedule.officeLocation);
      
      // Get unique providers (renderingPhysician)
      const providers = await db.selectDistinct({ value: schedule.renderingPhysician })
        .from(schedule)
        .where(sql`${schedule.renderingPhysician} IS NOT NULL AND ${schedule.renderingPhysician} != ''`)
        .orderBy(schedule.renderingPhysician);
      
      // Get unique appointment types from serviceCategory1
      const appointmentTypes = await db.selectDistinct({ value: schedule.serviceCategory1 })
        .from(schedule)
        .where(sql`${schedule.serviceCategory1} IS NOT NULL AND ${schedule.serviceCategory1} != ''`)
        .orderBy(schedule.serviceCategory1);
      
      // Get unique appointment statuses
      const statuses = await db.selectDistinct({ value: schedule.appointmentStatus })
        .from(schedule)
        .where(sql`${schedule.appointmentStatus} IS NOT NULL AND ${schedule.appointmentStatus} != ''`)
        .orderBy(schedule.appointmentStatus);
      
      res.json({
        locations: locations.map(l => l.value).filter(Boolean),
        providers: providers.map(p => p.value).filter(Boolean),
        appointmentTypes: appointmentTypes.map(t => t.value).filter(Boolean),
        statuses: statuses.map(s => s.value).filter(Boolean),
      });
    } catch (error: any) {
      // If schedule table doesn't exist (dev environment), return empty arrays
      if (error?.message?.includes('does not exist') || error?.code === '42P01') {
        console.log("[SCHEDULE] Schedule table not available in this environment - returning empty filter options");
        return res.json({
          locations: [],
          providers: [],
          appointmentTypes: [],
          statuses: [],
        });
      }
      console.error("Error fetching schedule filter options:", error);
      res.status(500).json({ message: "Failed to fetch filter options" });
    }
  });
  
  // Preview schedule query results (returns matching patients with count)
  // Supports multi-select filters (arrays) for location, provider, appointmentType, appointmentStatus
  app.post('/api/schedule/query-preview', isAuthenticated, async (req, res) => {
    try {
      const { schedule } = await import('../shared/schema');
      const { db } = await import('./db');
      const { and, eq, gte, lte, isNotNull, or, sql, inArray } = await import('drizzle-orm');
      
      const {
        confirmationStatus, // 'unconfirmed', 'confirmed', 'all'
        dateFrom,
        dateTo,
        locations,       // Array for multi-select
        providers,       // Array for multi-select
        appointmentTypes, // Array for multi-select
        appointmentStatuses, // Array for multi-select
        // Keep single-value support for backwards compatibility
        location,
        provider,
        appointmentType,
        appointmentStatus,
        limit = 50 // Preview limit
      } = req.body;
      
      // Build filter conditions
      const conditions: any[] = [];
      
      // Must have a phone number to call
      conditions.push(
        or(
          and(isNotNull(schedule.patientCellPhone), sql`${schedule.patientCellPhone} != ''`),
          and(isNotNull(schedule.patientHomePhone), sql`${schedule.patientHomePhone} != ''`)
        )
      );
      
      // Confirmation status filter - now uses "Y"/"N" text instead of boolean
      if (confirmationStatus === 'unconfirmed') {
        conditions.push(or(sql`${schedule.confirmInd} = 'N'`, sql`${schedule.confirmInd} IS NULL`));
      } else if (confirmationStatus === 'confirmed') {
        conditions.push(sql`${schedule.confirmInd} = 'Y'`);
      }
      // 'all' = no filter on confirmation
      
      // Date range filter - AppointmentDate is now a clean date field
      if (dateFrom) {
        conditions.push(gte(schedule.appointmentDate, dateFrom));
      }
      if (dateTo) {
        conditions.push(lte(schedule.appointmentDate, dateTo));
      }
      
      // Location filter (multi-select or single) - data is now clean, no prefix expansion needed
      const locationValues = locations?.length ? locations : (location ? [location] : []);
      if (locationValues.length > 0) {
        conditions.push(inArray(schedule.officeLocation, locationValues));
      }
      
      // Provider filter (multi-select or single)
      const providerValues = providers?.length ? providers : (provider ? [provider] : []);
      if (providerValues.length > 0) {
        conditions.push(inArray(schedule.renderingPhysician, providerValues));
      }
      
      // Appointment type filter (multi-select or single) - use serviceCategory1
      const typeValues = appointmentTypes?.length ? appointmentTypes : (appointmentType ? [appointmentType] : []);
      if (typeValues.length > 0) {
        conditions.push(inArray(schedule.serviceCategory1, typeValues));
      }
      
      // Appointment status filter (multi-select or single)
      const statusValues = appointmentStatuses?.length ? appointmentStatuses : (appointmentStatus ? [appointmentStatus] : []);
      if (statusValues.length > 0) {
        conditions.push(inArray(schedule.appointmentStatus, statusValues));
      }
      
      // Get total count
      const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(schedule)
        .where(and(...conditions));
      const totalCount = Number(countResult[0]?.count || 0);
      
      // Get preview records
      const previewRecords = await db.select({
        patientFirstName: schedule.patientFirstName,
        patientLastName: schedule.patientLastName,
        patientCellPhone: schedule.patientCellPhone,
        patientHomePhone: schedule.patientHomePhone,
        appointmentDate: schedule.appointmentDate,
        appointmentStart: schedule.appointmentStart,
        appointmentEnd: schedule.appointmentEnd,
        officeLocation: schedule.officeLocation,
        renderingPhysician: schedule.renderingPhysician,
        serviceCategory1: schedule.serviceCategory1,
        confirmInd: schedule.confirmInd,
        patientDateOfBirth: schedule.patientDateOfBirth,
      })
        .from(schedule)
        .where(and(...conditions))
        .orderBy(schedule.appointmentDate, schedule.appointmentStart)
        .limit(limit);
      
      res.json({
        totalCount,
        previewCount: previewRecords.length,
        records: previewRecords.map(r => ({
          firstName: r.patientFirstName,
          lastName: r.patientLastName,
          phone: r.patientCellPhone || r.patientHomePhone,
          appointmentDate: r.appointmentDate,
          appointmentStart: r.appointmentStart,
          appointmentEnd: r.appointmentEnd,
          location: r.officeLocation,
          provider: r.renderingPhysician,
          appointmentType: r.serviceCategory1,
          confirmed: r.confirmInd === 'Y',
          dob: r.patientDateOfBirth,
        })),
      });
    } catch (error: any) {
      // If schedule table doesn't exist (dev environment), return empty results
      if (error?.message?.includes('does not exist') || error?.code === '42P01') {
        console.log("[SCHEDULE] Schedule table not available in this environment - returning empty preview");
        return res.json({
          totalCount: 0,
          previewCount: 0,
          records: [],
        });
      }
      console.error("Error previewing schedule query:", error);
      res.status(500).json({ message: "Failed to preview schedule query" });
    }
  });
  
  // Populate campaign contacts from schedule query
  // Supports multi-select filters (arrays) for location, provider, appointmentType, appointmentStatus
  app.post('/api/campaigns/:id/populate-from-schedule', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { schedule } = await import('../shared/schema');
      const { db } = await import('./db');
      const { and, eq, gte, lte, isNotNull, or, sql, inArray } = await import('drizzle-orm');
      
      const campaignId = req.params.id;
      const {
        confirmationStatus,
        dateFrom,
        dateTo,
        locations,       // Array for multi-select
        providers,       // Array for multi-select
        appointmentTypes, // Array for multi-select
        appointmentStatuses, // Array for multi-select
        // Keep single-value support for backwards compatibility
        location,
        provider,
        appointmentType,
        appointmentStatus,
      } = req.body;
      
      // Build filter conditions (same as preview)
      const conditions: any[] = [];
      
      conditions.push(
        or(
          and(isNotNull(schedule.patientCellPhone), sql`${schedule.patientCellPhone} != ''`),
          and(isNotNull(schedule.patientHomePhone), sql`${schedule.patientHomePhone} != ''`)
        )
      );
      
      // Confirmation status filter - now uses "Y"/"N" text instead of boolean
      if (confirmationStatus === 'unconfirmed') {
        conditions.push(or(sql`${schedule.confirmInd} = 'N'`, sql`${schedule.confirmInd} IS NULL`));
      } else if (confirmationStatus === 'confirmed') {
        conditions.push(sql`${schedule.confirmInd} = 'Y'`);
      }
      
      // Date range filter - AppointmentDate is now a clean date field
      if (dateFrom) {
        conditions.push(gte(schedule.appointmentDate, dateFrom));
      }
      if (dateTo) {
        conditions.push(lte(schedule.appointmentDate, dateTo));
      }
      
      // Location filter (multi-select or single) - data is now clean, no prefix expansion needed
      const locationValues = locations?.length ? locations : (location ? [location] : []);
      if (locationValues.length > 0) {
        conditions.push(inArray(schedule.officeLocation, locationValues));
      }
      
      // Provider filter (multi-select or single)
      const providerValues = providers?.length ? providers : (provider ? [provider] : []);
      if (providerValues.length > 0) {
        conditions.push(inArray(schedule.renderingPhysician, providerValues));
      }
      
      // Appointment type filter (multi-select or single) - use serviceCategory1
      const typeValues = appointmentTypes?.length ? appointmentTypes : (appointmentType ? [appointmentType] : []);
      if (typeValues.length > 0) {
        conditions.push(inArray(schedule.serviceCategory1, typeValues));
      }
      
      // Appointment status filter (multi-select or single)
      const statusValues = appointmentStatuses?.length ? appointmentStatuses : (appointmentStatus ? [appointmentStatus] : []);
      if (statusValues.length > 0) {
        conditions.push(inArray(schedule.appointmentStatus, statusValues));
      }
      
      // Fetch all matching records from schedule
      const scheduleRecords = await db.select({
        patientFirstName: schedule.patientFirstName,
        patientLastName: schedule.patientLastName,
        patientCellPhone: schedule.patientCellPhone,
        patientHomePhone: schedule.patientHomePhone,
        appointmentDate: schedule.appointmentDate,
        appointmentStart: schedule.appointmentStart,
        officeLocation: schedule.officeLocation,
        renderingPhysician: schedule.renderingPhysician,
        serviceCategory1: schedule.serviceCategory1,
        patientDateOfBirth: schedule.patientDateOfBirth,
      })
        .from(schedule)
        .where(and(...conditions))
        .orderBy(schedule.appointmentDate, schedule.appointmentStart);
      
      if (scheduleRecords.length === 0) {
        return res.status(400).json({ message: "No matching patients found with phone numbers" });
      }
      
      // Calculate initial attempt time respecting 8am-8pm window
      const calculateInitialAttemptTime = (timezone: string = 'America/Los_Angeles'): Date => {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          hour12: false,
        });
        const currentHour = parseInt(formatter.format(now), 10);
        
        if (currentHour >= 8 && currentHour < 20) {
          return now;
        } else if (currentHour >= 20) {
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(8, 0, 0, 0);
          return tomorrow;
        } else {
          const today = new Date(now);
          today.setHours(8, 0, 0, 0);
          return today;
        }
      };
      
      // Transform schedule records into campaign contacts
      const contacts = scheduleRecords.map(record => {
        const timezone = 'America/Los_Angeles'; // Default for now
        const phoneNumber = record.patientCellPhone || record.patientHomePhone;
        
        // Convert date string to Date object for the campaign_contacts table
        // Use noon Pacific time to avoid timezone boundary issues
        const appointmentDateObj = record.appointmentDate 
          ? new Date(record.appointmentDate + 'T12:00:00-08:00') // Pacific time noon
          : undefined;
        
        return {
          campaignId,
          phoneNumber: phoneNumber!,
          firstName: record.patientFirstName || undefined,
          lastName: record.patientLastName || undefined,
          appointmentDate: appointmentDateObj,
          appointmentDoctor: record.renderingPhysician || undefined,
          appointmentLocation: record.officeLocation || undefined,
          appointmentType: record.serviceCategory1 || undefined,
          patientDob: record.patientDateOfBirth || undefined,
          customData: {
            source: 'schedule_query',
            appointmentTime: record.appointmentStart || undefined, // Store time in customData
            queryParams: { 
              confirmationStatus, 
              dateFrom, 
              dateTo, 
              locations: locationValues.length ? locationValues : undefined,
              providers: providerValues.length ? providerValues : undefined,
              appointmentTypes: typeValues.length ? typeValues : undefined,
              appointmentStatuses: statusValues.length ? statusValues : undefined 
            },
          },
          outreachStatus: 'pending' as const,
          timezone,
          nextAttemptAt: calculateInitialAttemptTime(timezone),
          maxAttempts: 3,
        };
      });
      
      // Create contacts in database
      const createdContacts = await storage.createCampaignContacts(contacts);
      
      // Update campaign total
      await storage.updateCampaign(campaignId, {
        totalContacts: createdContacts.length,
      });
      
      console.log(`[SCHEDULE CAMPAIGN] Created ${createdContacts.length} contacts for campaign ${campaignId} from schedule query`);
      
      res.json({
        message: "Contacts populated from schedule successfully",
        count: createdContacts.length,
        pendingOutreach: createdContacts.filter(c => c.outreachStatus === 'pending').length,
        appointmentsWithDates: createdContacts.filter(c => c.appointmentDate).length,
      });
    } catch (error: any) {
      // If schedule table doesn't exist (dev environment), return meaningful error
      if (error?.message?.includes('does not exist') || error?.code === '42P01') {
        console.log("[SCHEDULE] Schedule table not available in this environment - cannot populate from schedule");
        return res.status(400).json({ 
          message: "Schedule data is not available in development. Use CSV upload instead, or test in production." 
        });
      }
      console.error("Error populating contacts from schedule:", error);
      res.status(500).json({ message: "Failed to populate contacts from schedule" });
    }
  });

  // ==================== Campaign Execution Control ====================
  
  // Start campaign execution
  app.post('/api/campaigns/:id/start', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { campaignExecutor } = await import('./services/campaignExecutor');
      
      // Execute campaign asynchronously
      campaignExecutor.executeCampaign(campaignId).catch(error => {
        console.error(`[API] Campaign execution error for ${campaignId}:`, error);
      });
      
      res.json({ 
        success: true, 
        message: 'Campaign execution started',
        campaignId 
      });
    } catch (error) {
      console.error("[API] Error starting campaign:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to start campaign execution",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Pause campaign execution
  app.post('/api/campaigns/:id/pause', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { campaignExecutor } = await import('./services/campaignExecutor');
      
      await campaignExecutor.pauseCampaign(campaignId);
      
      res.json({ 
        success: true, 
        message: 'Campaign paused',
        campaignId 
      });
    } catch (error) {
      console.error("[API] Error pausing campaign:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to pause campaign",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Resume campaign execution
  app.post('/api/campaigns/:id/resume', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { campaignExecutor } = await import('./services/campaignExecutor');
      
      // Resume campaign asynchronously
      campaignExecutor.resumeCampaign(campaignId).catch(error => {
        console.error(`[API] Campaign resume error for ${campaignId}:`, error);
      });
      
      res.json({ 
        success: true, 
        message: 'Campaign resumed',
        campaignId 
      });
    } catch (error) {
      console.error("[API] Error resuming campaign:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to resume campaign",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Cancel campaign execution
  app.post('/api/campaigns/:id/cancel', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { campaignExecutor } = await import('./services/campaignExecutor');
      
      await campaignExecutor.cancelCampaign(campaignId);
      
      res.json({ 
        success: true, 
        message: 'Campaign cancelled',
        campaignId 
      });
    } catch (error) {
      console.error("[API] Error cancelling campaign:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to cancel campaign",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Delete campaign (soft delete)
  app.delete('/api/campaigns/:id', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ success: false, message: 'Campaign not found' });
      }
      
      // Don't allow deleting running campaigns
      if (campaign.status === 'running') {
        return res.status(400).json({ 
          success: false, 
          message: 'Cannot delete a running campaign. Please pause or cancel it first.' 
        });
      }
      
      await storage.deleteCampaign(campaignId);
      
      console.log(`[API] Campaign deleted: ${campaignId} (${campaign.name})`);
      
      res.json({ 
        success: true, 
        message: 'Campaign deleted',
        campaignId 
      });
    } catch (error) {
      console.error("[API] Error deleting campaign:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to delete campaign",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ==================== Appointment Confirmation Campaign Routes ====================

  // Start appointment confirmation outbound scheduler
  app.post('/api/campaigns/:id/start-outbound-scheduler', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { fromNumber } = req.body;
      
      if (!fromNumber) {
        return res.status(400).json({ 
          success: false, 
          message: 'fromNumber is required - the Twilio phone number to call from' 
        });
      }
      
      const domain = process.env.DOMAIN;
      if (!domain) {
        return res.status(500).json({ 
          success: false, 
          message: 'DOMAIN environment variable not configured' 
        });
      }
      
      const campaign = await storage.getCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({ success: false, message: 'Campaign not found' });
      }
      
      const { createScheduler } = await import('../src/services/outboundCampaignScheduler');
      
      const scheduler = createScheduler({
        campaignId,
        fromNumber,
        webhookDomain: domain,
        concurrentCalls: 3,
        checkIntervalMs: 30000,
      });
      
      await scheduler.start();
      
      await storage.updateCampaign(campaignId, {
        status: 'running',
        actualStartTime: new Date(),
      });
      
      res.json({ 
        success: true, 
        message: 'Outbound appointment confirmation scheduler started',
        campaignId,
        fromNumber,
        callingHours: '8am-8pm',
        maxAttempts: 3,
        retryDelay: '1 hour',
      });
    } catch (error) {
      console.error("[API] Error starting outbound scheduler:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to start outbound scheduler",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Stop appointment confirmation outbound scheduler
  app.post('/api/campaigns/:id/stop-outbound-scheduler', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const campaignId = req.params.id;
      
      const { stopScheduler } = await import('../src/services/outboundCampaignScheduler');
      await stopScheduler(campaignId);
      
      await storage.updateCampaign(campaignId, {
        status: 'paused',
      });
      
      res.json({ 
        success: true, 
        message: 'Outbound scheduler stopped',
        campaignId,
      });
    } catch (error) {
      console.error("[API] Error stopping outbound scheduler:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to stop outbound scheduler",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get campaign outreach progress/stats
  app.get('/api/campaigns/:id/progress', isAuthenticated, async (req, res) => {
    try {
      const campaignId = req.params.id;
      const contacts = await storage.getCampaignContacts(campaignId);
      
      const stats = {
        total: contacts.length,
        pending: contacts.filter(c => c.outreachStatus === 'pending').length,
        calling: contacts.filter(c => c.outreachStatus === 'calling').length,
        answered: contacts.filter(c => c.outreachStatus === 'answered').length,
        confirmed: contacts.filter(c => c.outreachStatus === 'confirmed').length,
        declined: contacts.filter(c => c.outreachStatus === 'declined').length,
        rescheduled: contacts.filter(c => c.outreachStatus === 'rescheduled').length,
        voicemail: contacts.filter(c => c.outreachStatus === 'voicemail').length,
        noAnswer: contacts.filter(c => c.outreachStatus === 'no_answer').length,
        callbackScheduled: contacts.filter(c => c.outreachStatus === 'callback_scheduled').length,
        wrongNumber: contacts.filter(c => c.outreachStatus === 'wrong_number').length,
        maxAttempts: contacts.filter(c => c.outreachStatus === 'max_attempts').length,
        completed: contacts.filter(c => c.outreachStatus === 'completed').length,
      };
      
      const successRate = stats.total > 0 
        ? ((stats.confirmed + stats.declined + stats.rescheduled) / stats.total * 100).toFixed(1)
        : '0';
      
      res.json({
        campaignId,
        stats,
        successRate: `${successRate}%`,
        contactsWithAppointments: contacts.filter(c => c.appointmentDate).length,
        voicemailsLeft: contacts.filter(c => c.voicemailLeft).length,
      });
    } catch (error) {
      console.error("[API] Error fetching campaign progress:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to fetch campaign progress",
      });
    }
  });

  // Get attempt history for a specific contact
  app.get('/api/campaigns/:campaignId/contacts/:contactId/attempts', isAuthenticated, async (req, res) => {
    try {
      const { contactId } = req.params;
      const attempts = await storage.getContactAttempts(contactId);
      res.json(attempts);
    } catch (error) {
      console.error("[API] Error fetching contact attempts:", error);
      res.status(500).json({ message: "Failed to fetch contact attempts" });
    }
  });

  // ==================== Call Logs Routes ====================
  
  // Helper to sanitize query params - treats 'undefined', 'null', '' as missing
  const sanitizeQueryParam = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const str = String(value).trim();
    if (str === '' || str === 'undefined' || str === 'null') return undefined;
    return str;
  };
  
  // Get call logs with pagination and comprehensive filtering
  app.get('/api/call-logs', isAuthenticated, async (req, res) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const status = sanitizeQueryParam(req.query.status);
      const direction = sanitizeQueryParam(req.query.direction);
      const startDate = sanitizeQueryParam(req.query.startDate) ? new Date(req.query.startDate as string) : undefined;
      const endDate = sanitizeQueryParam(req.query.endDate) ? new Date(req.query.endDate as string) : undefined;
      const hasTicketRaw = sanitizeQueryParam(req.query.hasTicket);
      const hasTicket = hasTicketRaw === 'true' ? true : hasTicketRaw === 'false' ? false : undefined;
      const transferredRaw = sanitizeQueryParam(req.query.transferred);
      const transferred = transferredRaw === 'true' ? true : transferredRaw === 'false' ? false : undefined;
      const agentId = sanitizeQueryParam(req.query.agentId);
      const search = sanitizeQueryParam(req.query.search);
      const callQualityRaw = sanitizeQueryParam(req.query.callQuality);
      const callQuality = callQualityRaw === 'ghost' || callQualityRaw === 'real' ? callQualityRaw : undefined;

      console.log('[API] Fetching call logs:', { page, limit, status, direction, hasTicket, transferred, agentId, search, callQuality });

      const result = await storage.getCallLogs({
        page,
        limit,
        status,
        direction,
        startDate,
        endDate,
        hasTicket,
        transferred,
        agentId,
        search,
        callQuality,
      });

      console.log('[API] Call logs result:', { dataCount: result.data?.length, pagination: result.pagination });

      res.json({
        data: result.data.map(normalizeCallLog),
        pagination: result.pagination,
      });
    } catch (error) {
      console.error("Error fetching call logs:", error);
      res.status(500).json({ message: "Failed to fetch call logs" });
    }
  });

  // Get urgent calls - calls transferred to human agent
  app.get('/api/call-logs/urgent', isAuthenticated, async (req, res) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;

      const { db } = await import('./db');
      const { callLogs } = await import('../shared/schema');
      const { eq, desc, count } = await import('drizzle-orm');

      const urgentCalls = await db
        .select()
        .from(callLogs)
        .where(eq(callLogs.transferredToHuman, true))
        .orderBy(desc(callLogs.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);

      const [{ count: totalCount }] = await db
        .select({ count: count() })
        .from(callLogs)
        .where(eq(callLogs.transferredToHuman, true));

      res.json({
        data: urgentCalls.map(normalizeCallLog),
        pagination: {
          page,
          limit,
          total: Number(totalCount),
          totalPages: Math.ceil(Number(totalCount) / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching urgent calls:", error);
      res.status(500).json({ message: "Failed to fetch urgent calls" });
    }
  });

  // Get voicemail callback list - calls that reached voicemail and need follow-up
  app.get('/api/call-logs/voicemails', isAuthenticated, async (req, res) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const campaignId = req.query.campaignId as string | undefined;

      // Query for calls where isVoicemail = true  
      const { db } = await import('./db');
      const { callLogs } = await import('../shared/schema');
      const { eq, desc, and, sql, count } = await import('drizzle-orm');

      const conditions = [eq(callLogs.isVoicemail, true)];
      if (campaignId) {
        conditions.push(eq(callLogs.campaignId, campaignId));
      }

      const voicemails = await db
        .select()
        .from(callLogs)
        .where(and(...conditions))
        .orderBy(desc(callLogs.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);

      const [{ count: totalCount }] = await db
        .select({ count: count() })
        .from(callLogs)
        .where(and(...conditions));

      res.json({
        data: voicemails.map(normalizeCallLog),
        pagination: {
          page,
          limit,
          total: Number(totalCount),
          totalPages: Math.ceil(Number(totalCount) / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching voicemail callback list:", error);
      res.status(500).json({ message: "Failed to fetch voicemail callback list" });
    }
  });

  // Get call log by ID
  app.get('/api/call-logs/:id', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }
      res.json(normalizeCallLog(callLog));
    } catch (error) {
      console.error("Error fetching call log:", error);
      res.status(500).json({ message: "Failed to fetch call log" });
    }
  });

  // Cleanup stale calls (calls stuck in 'in_progress', 'ringing', or 'initiated' for > 5 minutes)
  // Verifies actual status with Twilio before marking as completed
  app.post('/api/call-logs/cleanup-stale', isAuthenticated, async (req, res) => {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const twilioClient = await getTwilioClient();
      
      // Include 'initiated' status to catch orphaned calls that never connected
      const staleCalls = await storage.getCallLogs({
        status: 'in_progress,ringing,initiated',
        endDate: fiveMinutesAgo,
        limit: 100,
      });
      
      let cleanedCount = 0;
      let verifiedCount = 0;
      const results: { id: string; callSid: string | null; twilioStatus: string | null; action: string }[] = [];
      
      for (const call of staleCalls.data) {
        const callTime = call.startTime || call.createdAt;
        if (callTime && new Date(callTime) < fiveMinutesAgo) {
          let twilioStatus: string | null = null;
          let actualDuration: number | null = null;
          let finalStatus: 'completed' | 'busy' | 'no_answer' | 'failed' = 'completed';
          
          // If we have a callSid, verify with Twilio
          if (call.callSid) {
            try {
              const twilioCall = await twilioClient.calls(call.callSid).fetch();
              twilioStatus = twilioCall.status;
              actualDuration = twilioCall.duration ? parseInt(twilioCall.duration) : null;
              verifiedCount++;
              
              // Map Twilio status to our status
              if (twilioStatus === 'in-progress' || twilioStatus === 'ringing' || twilioStatus === 'queued') {
                // Call is still active in Twilio - but check if it's been running too long
                const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
                const callStartTime = call.startTime || call.createdAt;
                if (callStartTime && new Date(callStartTime) < tenMinutesAgo) {
                  // Call has been running >10 minutes - FORCE terminate it
                  console.log(`[CLEANUP] Force terminating long-running call ${call.callSid} (>10 min)`);
                  try {
                    await twilioClient.calls(call.callSid).update({ status: 'completed' });
                    actualDuration = Math.floor((Date.now() - new Date(callStartTime).getTime()) / 1000);
                    results.push({ id: call.id, callSid: call.callSid, twilioStatus, action: 'FORCE terminated (>10 min)' });
                    // Continue to update DB below
                  } catch (forceError: any) {
                    console.error(`[CLEANUP] Failed to force terminate ${call.callSid}:`, forceError.message);
                    results.push({ id: call.id, callSid: call.callSid, twilioStatus, action: `force terminate failed: ${forceError.message}` });
                    continue;
                  }
                } else {
                  // Call is legitimately active (<10 min), skip cleanup
                  results.push({ id: call.id, callSid: call.callSid, twilioStatus, action: 'skipped (still active <10 min)' });
                  continue;
                }
              } else if (twilioStatus === 'busy') {
                finalStatus = 'busy';
              } else if (twilioStatus === 'no-answer') {
                finalStatus = 'no_answer';
              } else if (twilioStatus === 'failed' || twilioStatus === 'canceled') {
                finalStatus = 'failed';
              }
            } catch (twilioError: any) {
              // Call not found in Twilio (may have been deleted/archived), mark as completed
              console.log(`[CLEANUP] Twilio call ${call.callSid} not found, marking as completed`);
            }
          }
          
          const duration = actualDuration ?? (call.endTime 
            ? Math.floor((new Date(call.endTime).getTime() - new Date(callTime).getTime()) / 1000)
            : Math.floor((fiveMinutesAgo.getTime() - new Date(callTime).getTime()) / 1000));
          
          await storage.updateCallLog(call.id, {
            status: finalStatus,
            endTime: call.endTime || fiveMinutesAgo,
            duration: Math.max(0, duration),
          });
          cleanedCount++;
          results.push({ id: call.id, callSid: call.callSid, twilioStatus, action: `marked ${finalStatus}` });
        }
      }
      
      console.log(`[CLEANUP] Cleaned ${cleanedCount} stale calls (${verifiedCount} verified with Twilio)`);
      res.json({ 
        message: `Cleaned up ${cleanedCount} stale call(s) (${verifiedCount} verified with Twilio)`,
        cleaned: cleanedCount,
        verified: verifiedCount,
        details: results,
      });
    } catch (error) {
      console.error("Error cleaning up stale calls:", error);
      res.status(500).json({ message: "Failed to cleanup stale calls" });
    }
  });

  // Recalculate call durations and costs from Twilio for accurate data (admin only)
  app.post('/api/call-logs/recalculate-durations', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const twilioClient = await getTwilioClient();
      const startDate = req.body.startDate ? new Date(req.body.startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const calls = await storage.getCallLogs({
        startDate,
        limit: 200,
      });
      
      let updatedCount = 0;
      let errorCount = 0;
      const results: { 
        id: string; 
        callSid: string | null; 
        oldDuration: number | null; 
        newDuration: number | null;
        oldTwilioCost: number | null;
        newTwilioCost: number | null;
        status: string 
      }[] = [];
      
      for (const call of calls.data) {
        if (!call.callSid) continue;
        
        try {
          const twilioCall = await twilioClient.calls(call.callSid).fetch();
          const actualDuration = twilioCall.duration ? parseInt(twilioCall.duration) : null;
          const twilioStatus = twilioCall.status;
          
          // Get actual Twilio cost - price is negative (cost to you), convert to cents
          // Twilio returns price as a string like "-0.009" for $0.009
          const twilioPrice = twilioCall.price ? parseFloat(twilioCall.price) : null;
          const actualTwilioCostCents = twilioPrice !== null ? Math.round(Math.abs(twilioPrice) * 100) : null;
          
          const durationChanged = actualDuration !== null && actualDuration !== call.duration;
          const twilioCostChanged = actualTwilioCostCents !== null && actualTwilioCostCents !== call.twilioCostCents;
          
          if (durationChanged || twilioCostChanged) {
            let finalStatus: 'completed' | 'busy' | 'no_answer' | 'failed' = 'completed';
            if (twilioStatus === 'busy') finalStatus = 'busy';
            else if (twilioStatus === 'no-answer') finalStatus = 'no_answer';
            else if (twilioStatus === 'failed' || twilioStatus === 'canceled') finalStatus = 'failed';
            
            const finalDuration = actualDuration ?? call.duration ?? 0;
            const openaiCostCents = Math.round(finalDuration / 60 * 19);
            const finalTwilioCostCents = actualTwilioCostCents ?? call.twilioCostCents ?? 0;
            
            await storage.updateCallLog(call.id, {
              duration: finalDuration,
              status: finalStatus,
              twilioCostCents: finalTwilioCostCents,
              openaiCostCents,
              totalCostCents: finalTwilioCostCents + openaiCostCents,
            });
            
            results.push({ 
              id: call.id, 
              callSid: call.callSid, 
              oldDuration: call.duration, 
              newDuration: actualDuration,
              oldTwilioCost: call.twilioCostCents,
              newTwilioCost: actualTwilioCostCents,
              status: 'updated'
            });
            updatedCount++;
          } else {
            results.push({ 
              id: call.id, 
              callSid: call.callSid, 
              oldDuration: call.duration, 
              newDuration: actualDuration,
              oldTwilioCost: call.twilioCostCents,
              newTwilioCost: actualTwilioCostCents,
              status: 'unchanged'
            });
          }
        } catch (err: any) {
          results.push({ 
            id: call.id, 
            callSid: call.callSid, 
            oldDuration: call.duration, 
            newDuration: null,
            oldTwilioCost: call.twilioCostCents,
            newTwilioCost: null,
            status: `error: ${err.message}`
          });
          errorCount++;
        }
      }
      
      console.log(`[RECALCULATE] Updated ${updatedCount} calls (duration + Twilio costs), ${errorCount} errors`);
      res.json({
        message: `Recalculated ${updatedCount} call(s) with actual Twilio costs, ${errorCount} error(s)`,
        updated: updatedCount,
        errors: errorCount,
        details: results,
      });
    } catch (error) {
      console.error("Error recalculating durations:", error);
      res.status(500).json({ message: "Failed to recalculate durations" });
    }
  });

  // Fetch recording URL from Twilio for a specific call
  app.get('/api/call-logs/:id/recording', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }

      if (!callLog.callSid) {
        return res.status(404).json({ message: "No Twilio Call SID found for this call" });
      }

      // Fetch recordings from Twilio API
      const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

      if (!twilioAccountSid || !twilioAuthToken) {
        return res.status(500).json({ message: "Twilio credentials not configured" });
      }

      const authHeader = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls/${callLog.callSid}/Recordings.json`,
        {
          headers: {
            'Authorization': `Basic ${authHeader}`,
          },
        }
      );

      if (!response.ok) {
        console.error(`[TWILIO API] Failed to fetch recordings: ${response.status} ${response.statusText}`);
        return res.status(response.status).json({ 
          message: `Failed to fetch recording from Twilio: ${response.statusText}` 
        });
      }

      const data = await response.json();
      
      if (!data.recordings || data.recordings.length === 0) {
        return res.status(404).json({ message: "No recording found for this call" });
      }

      // Return the first (most recent) recording with full URL
      const recording = data.recordings[0];
      const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;

      res.json({
        url: recordingUrl,
        duration: recording.duration,
        sid: recording.sid,
        dateCreated: recording.date_created,
      });
    } catch (error) {
      console.error("Error fetching recording from Twilio:", error);
      res.status(500).json({ message: "Failed to fetch recording" });
    }
  });

  // ==================== Analytics Routes ====================
  
  // Get cost analytics summary
  app.get('/api/analytics/costs', isAuthenticated, async (req, res) => {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      const agentId = req.query.agentId as string | undefined;
      
      const { db } = await import('./db');
      const { callLogs, agents } = await import('../shared/schema');
      const { sql, eq, and, gte, lte, isNotNull, count, sum, avg } = await import('drizzle-orm');
      
      // Build conditions - only include calls with valid Twilio call_sid (excludes test calls)
      const conditions: any[] = [isNotNull(callLogs.callSid)];
      if (startDate) conditions.push(gte(callLogs.startTime, startDate));
      if (endDate) conditions.push(lte(callLogs.startTime, endDate));
      if (agentId) conditions.push(eq(callLogs.agentId, agentId));
      
      // Get summary stats
      const query = db
        .select({
          totalCalls: count(),
          totalTwilioCents: sum(callLogs.twilioCostCents),
          totalOpenAICents: sum(callLogs.openaiCostCents),
          totalCents: sum(callLogs.totalCostCents),
          totalDuration: sum(callLogs.duration),
          avgCostPerCall: avg(callLogs.totalCostCents),
        })
        .from(callLogs);
      
      const [summaryResult] = conditions.length > 0 
        ? await query.where(and(...conditions))
        : await query;
      
      // Get breakdown by agent (join with agents table to get name)
      const agentQuery = db
        .select({
          agentId: callLogs.agentId,
          agentName: agents.name,
          agentSlug: agents.slug,
          callCount: count(),
          totalCents: sum(callLogs.totalCostCents),
          avgCostPerCall: avg(callLogs.totalCostCents),
          totalDuration: sum(callLogs.duration),
        })
        .from(callLogs)
        .leftJoin(agents, eq(callLogs.agentId, agents.id));
      
      const agentBreakdown = conditions.length > 0
        ? await agentQuery.where(and(...conditions)).groupBy(callLogs.agentId, agents.name, agents.slug)
        : await agentQuery.groupBy(callLogs.agentId, agents.name, agents.slug);
      
      // Get daily breakdown (last 30 days if no date range specified)
      const effectiveStartDate = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const dailyConditions: any[] = [isNotNull(callLogs.callSid), gte(callLogs.startTime, effectiveStartDate)];
      if (endDate) dailyConditions.push(lte(callLogs.startTime, endDate));
      if (agentId) dailyConditions.push(eq(callLogs.agentId, agentId));
      
      const dailyBreakdown = await db
        .select({
          date: sql`DATE(${callLogs.startTime})`.as('date'),
          callCount: count(),
          totalCents: sum(callLogs.totalCostCents),
          twilioCents: sum(callLogs.twilioCostCents),
          openaiCents: sum(callLogs.openaiCostCents),
        })
        .from(callLogs)
        .where(and(...dailyConditions))
        .groupBy(sql`DATE(${callLogs.startTime})`)
        .orderBy(sql`DATE(${callLogs.startTime})`);
      
      // Get data coverage stats for accuracy indicators
      const coverageConditions: any[] = [];
      if (startDate) coverageConditions.push(gte(callLogs.startTime, startDate));
      if (endDate) coverageConditions.push(lte(callLogs.startTime, endDate));
      if (agentId) coverageConditions.push(eq(callLogs.agentId, agentId));
      
      const coverageQuery = db
        .select({
          totalCompleted: sql`COUNT(*) FILTER (WHERE status = 'completed')`.as('totalCompleted'),
          withCallSid: sql`COUNT(*) FILTER (WHERE status = 'completed' AND call_sid IS NOT NULL)`.as('withCallSid'),
          withTwilioCost: sql`COUNT(*) FILTER (WHERE status = 'completed' AND twilio_cost_cents IS NOT NULL)`.as('withTwilioCost'),
          withOpenAICost: sql`COUNT(*) FILTER (WHERE status = 'completed' AND openai_cost_cents IS NOT NULL)`.as('withOpenAICost'),
          withQualityScore: sql`COUNT(*) FILTER (WHERE status = 'completed' AND quality_score IS NOT NULL)`.as('withQualityScore'),
        })
        .from(callLogs);
      
      const [coverageResult] = coverageConditions.length > 0 
        ? await coverageQuery.where(and(...coverageConditions))
        : await coverageQuery;
      
      const totalCompleted = Number(coverageResult.totalCompleted) || 0;
      const coverage = {
        totalCompleted,
        withCallSid: Number(coverageResult.withCallSid) || 0,
        withTwilioCost: Number(coverageResult.withTwilioCost) || 0,
        withOpenAICost: Number(coverageResult.withOpenAICost) || 0,
        withQualityScore: Number(coverageResult.withQualityScore) || 0,
        twilioCostCoverage: totalCompleted > 0 ? Math.round((Number(coverageResult.withTwilioCost) || 0) / totalCompleted * 100) : 0,
        openaiCostCoverage: totalCompleted > 0 ? Math.round((Number(coverageResult.withOpenAICost) || 0) / totalCompleted * 100) : 0,
        qualityCoverage: totalCompleted > 0 ? Math.round((Number(coverageResult.withQualityScore) || 0) / totalCompleted * 100) : 0,
      };
      
      res.json({
        summary: {
          totalCalls: summaryResult.totalCalls || 0,
          totalTwilioCents: Number(summaryResult.totalTwilioCents) || 0,
          totalOpenAICents: Number(summaryResult.totalOpenAICents) || 0,
          totalCents: Number(summaryResult.totalCents) || 0,
          totalDurationMinutes: Math.round((Number(summaryResult.totalDuration) || 0) / 60),
          avgCostPerCallCents: Math.round(Number(summaryResult.avgCostPerCall) || 0),
          costPerMinuteCents: summaryResult.totalDuration 
            ? Math.round((Number(summaryResult.totalCents) || 0) / (Number(summaryResult.totalDuration) / 60))
            : 0,
        },
        byAgent: agentBreakdown.map(a => ({
          agentId: a.agentId,
          agentName: a.agentName || 'Unknown Agent',
          agentSlug: a.agentSlug || 'unknown',
          callCount: a.callCount || 0,
          totalCents: Number(a.totalCents) || 0,
          avgCostPerCallCents: Math.round(Number(a.avgCostPerCall) || 0),
          totalDurationMinutes: Math.round((Number(a.totalDuration) || 0) / 60),
        })),
        daily: dailyBreakdown.map(d => ({
          date: d.date,
          callCount: d.callCount || 0,
          totalCents: Number(d.totalCents) || 0,
          twilioCents: Number(d.twilioCents) || 0,
          openaiCents: Number(d.openaiCents) || 0,
        })),
        coverage,
      });
    } catch (error) {
      console.error("Error fetching cost analytics:", error);
      res.status(500).json({ message: "Failed to fetch cost analytics" });
    }
  });
  
  // Get quality/sentiment analytics summary
  app.get('/api/analytics/quality', isAuthenticated, async (req, res) => {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
      const agentId = req.query.agentId as string | undefined;
      
      const { db } = await import('./db');
      const { callLogs, agents } = await import('../shared/schema');
      const { sql, eq, and, gte, lte, isNotNull, count, avg } = await import('drizzle-orm');
      
      // Build conditions - exclude test calls without call_sid
      const conditions: any[] = [isNotNull(callLogs.callSid), isNotNull(callLogs.qualityScore)];
      if (startDate) conditions.push(gte(callLogs.startTime, startDate));
      if (endDate) conditions.push(lte(callLogs.startTime, endDate));
      if (agentId) conditions.push(eq(callLogs.agentId, agentId));
      
      // Get summary stats
      const [summaryResult] = await db
        .select({
          totalGradedCalls: count(),
          avgQualityScore: avg(callLogs.qualityScore),
        })
        .from(callLogs)
        .where(and(...conditions));
      
      // Get sentiment distribution - exclude test calls
      const sentimentConditions: any[] = [isNotNull(callLogs.callSid), isNotNull(callLogs.sentiment)];
      if (startDate) sentimentConditions.push(gte(callLogs.startTime, startDate));
      if (endDate) sentimentConditions.push(lte(callLogs.startTime, endDate));
      if (agentId) sentimentConditions.push(eq(callLogs.agentId, agentId));
      
      const sentimentBreakdown = await db
        .select({
          sentiment: callLogs.sentiment,
          count: count(),
        })
        .from(callLogs)
        .where(and(...sentimentConditions))
        .groupBy(callLogs.sentiment);
      
      // Get quality score distribution
      const qualityBreakdown = await db
        .select({
          score: callLogs.qualityScore,
          count: count(),
        })
        .from(callLogs)
        .where(and(...conditions))
        .groupBy(callLogs.qualityScore);
      
      // Get quality by agent (join with agents to get name)
      const agentQuality = await db
        .select({
          agentId: callLogs.agentId,
          agentName: agents.name,
          agentSlug: agents.slug,
          callCount: count(),
          avgScore: avg(callLogs.qualityScore),
        })
        .from(callLogs)
        .leftJoin(agents, eq(callLogs.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(callLogs.agentId, agents.name, agents.slug);
      
      res.json({
        summary: {
          totalGradedCalls: summaryResult.totalGradedCalls || 0,
          avgQualityScore: Number(summaryResult.avgQualityScore)?.toFixed(1) || null,
        },
        sentimentDistribution: Object.fromEntries(
          sentimentBreakdown.map(s => [s.sentiment || 'unknown', s.count])
        ),
        qualityScoreDistribution: Object.fromEntries(
          qualityBreakdown.map(q => [q.score || 0, q.count])
        ),
        byAgent: agentQuality.map(a => ({
          agentId: a.agentId,
          agentName: a.agentName || 'Unknown Agent',
          agentSlug: a.agentSlug || 'unknown',
          callCount: a.callCount || 0,
          avgScore: Number(a.avgScore)?.toFixed(1) || null,
        })),
      });
    } catch (error) {
      console.error("Error fetching quality analytics:", error);
      res.status(500).json({ message: "Failed to fetch quality analytics" });
    }
  });
  
  // Get OpenAI usage from reconciled daily costs table (no real-time API calls = no 504 errors)
  // Returns actual costs for reconciled days, estimates for today
  app.get('/api/analytics/openai-usage', isAuthenticated, async (req, res) => {
    try {
      const startDate = req.query.startDate as string || 
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const endDate = req.query.endDate as string || 
        new Date().toISOString().split('T')[0];
      
      const today = new Date().toISOString().split('T')[0];
      
      // Get reconciled daily costs from database (no API call)
      const dailyCosts = await storage.getDailyOpenaiCosts(startDate, endDate);
      
      // Build response in the format the frontend expects
      const opsHubCostByDate: Record<string, number> = {};
      const opsHubCostByModel: Record<string, number> = {};
      let totalReconciledCents = 0;
      let realtimeCostDollars = 0;
      
      for (const day of dailyCosts) {
        const actualCostDollars = (day.actualCostCents || 0) / 100;
        const dateStr = typeof day.date === 'string' ? day.date : new Date(day.date).toISOString().split('T')[0];
        opsHubCostByDate[dateStr] = actualCostDollars;
        totalReconciledCents += day.actualCostCents || 0;
        
        // Track realtime costs specifically
        if (day.realtimeCostCents) {
          realtimeCostDollars += day.realtimeCostCents / 100;
          opsHubCostByModel['gpt-realtime'] = 
            (opsHubCostByModel['gpt-realtime'] || 0) + (day.realtimeCostCents / 100);
        }
        if (day.otherCostCents) {
          opsHubCostByModel['other'] = 
            (opsHubCostByModel['other'] || 0) + (day.otherCostCents / 100);
        }
      }
      
      // For today, use estimated costs from call logs (not yet reconciled)
      const reconciledDates = new Set(dailyCosts.map(d => 
        typeof d.date === 'string' ? d.date : new Date(d.date).toISOString().split('T')[0]
      ));
      if (!reconciledDates.has(today) && today >= startDate && today <= endDate) {
        const todayEstimateCents = await storage.getEstimatedOpenaiCostForDate(today);
        opsHubCostByDate[today] = todayEstimateCents / 100;
        totalReconciledCents += todayEstimateCents;
      }
      
      res.json({
        totalCostDollars: totalReconciledCents / 100,
        realtimeCostDollars,
        opsHubCostByDate,
        opsHubCostByModel,
        costByDate: opsHubCostByDate, // Legacy field for backwards compatibility
        costByModel: opsHubCostByModel,
        dateRange: { startDate, endDate },
        entries: dailyCosts.map(d => ({
          date: typeof d.date === 'string' ? d.date : new Date(d.date).toISOString().split('T')[0],
          model: 'daily-aggregate',
          costDollars: (d.actualCostCents || 0) / 100,
          isReconciled: true,
          discrepancyPercent: d.discrepancyPercent,
        })),
        dataSource: 'reconciled_daily', // Indicates data comes from reconciled table, not live API
        reconciledDays: dailyCosts.length,
        estimatedToday: !reconciledDates.has(today),
      });
    } catch (error) {
      console.error("Error fetching OpenAI usage:", error);
      res.status(500).json({ message: "Failed to fetch OpenAI usage" });
    }
  });
  
  // Manually trigger daily OpenAI cost reconciliation (admin only)
  app.post('/api/analytics/reconcile-openai-daily', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { dailyOpenaiReconciliation } = await import('../src/services/dailyOpenaiReconciliation');
      const { date, startDate, endDate } = req.body;
      
      if (startDate && endDate) {
        // Reconcile a date range
        const result = await dailyOpenaiReconciliation.reconcileDateRange(
          startDate, 
          endDate,
          (req as any).user?.email || 'manual'
        );
        return res.json({
          ...result,
          message: `Reconciled ${result.totalReconciled} days, ${result.totalFailed} failed`,
        });
      } else if (date) {
        // Reconcile a specific date
        const result = await dailyOpenaiReconciliation.reconcileDate(
          date,
          (req as any).user?.email || 'manual'
        );
        return res.json(result);
      } else {
        // Default: reconcile yesterday
        const result = await dailyOpenaiReconciliation.reconcileYesterday();
        return res.json(result);
      }
    } catch (error) {
      console.error("Error reconciling OpenAI costs:", error);
      res.status(500).json({ 
        success: false, 
        message: "Failed to reconcile OpenAI costs",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  
  // Manually trigger cost calculation for a call (useful for backfilling)
  app.post('/api/call-logs/:id/calculate-costs', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }
      
      const { callCostService } = await import('../src/services/callCostService');
      
      // Calculate audio duration estimate from call duration
      const durationSeconds = callLog.duration || 0;
      const audioInputMs = durationSeconds * 700;
      const audioOutputMs = durationSeconds * 300;
      
      const costs = await callCostService.updateCallCosts(
        callLog.id,
        callLog.callSid || null,
        { inputDurationMs: audioInputMs, outputDurationMs: audioOutputMs }
      );
      
      res.json({ 
        success: true, 
        costs 
      });
    } catch (error) {
      console.error("Error calculating call costs:", error);
      res.status(500).json({ message: "Failed to calculate call costs" });
    }
  });

  // Run daily cost reconciliation (compares our calculated costs with OpenAI Usage API)
  app.post('/api/analytics/reconcile-costs', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { callCostService } = await import('../src/services/callCostService');
      const { date } = req.body;
      
      const targetDate = date ? new Date(date) : undefined;
      const result = await callCostService.runDailyReconciliation(targetDate);
      
      if (!result) {
        return res.status(500).json({ message: "Reconciliation failed" });
      }
      
      res.json({
        success: true,
        ...result,
        withinThreshold: result.discrepancyPercent <= 10,
      });
    } catch (error) {
      console.error("Error running cost reconciliation:", error);
      res.status(500).json({ message: "Failed to run cost reconciliation" });
    }
  });
  
  // Org billing ledger reconciliation (uses dual-ledger: org costs + per-call estimates)
  app.post('/api/analytics/reconcile-org-billing', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
      const { orgBillingLedger } = await import('../src/services/orgBillingLedger');
      const { date, startDate, endDate } = req.body;

      if (startDate && endDate) {
        const result = await orgBillingLedger.reconcileDateRange(startDate, endDate);
        return res.json(result);
      } else if (date) {
        const result = await orgBillingLedger.reconcileDay(date);
        return res.json(result);
      } else {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];
        const result = await orgBillingLedger.reconcileDay(dateStr);
        return res.json(result);
      }
    } catch (error) {
      console.error("Error in org billing reconciliation:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Org billing reconciliation failed'
      });
    }
  });

  // Import OpenAI usage CSV and generate audit report
  app.post('/api/analytics/import-openai-csv', isAuthenticated, requireRole('admin'), upload.single('csv'), async (req: any, res) => {
    try {
      const { importCsvToDatabase, generateAuditReport } = await import('../src/services/csvCostImport');

      let csvContent: string;
      if (req.file) {
        csvContent = req.file.buffer.toString('utf-8');
      } else if (req.body.csvContent) {
        csvContent = req.body.csvContent;
      } else {
        return res.status(400).json({ success: false, error: 'No CSV file or content provided' });
      }

      const importResult = await importCsvToDatabase(csvContent);
      const auditReport = await generateAuditReport(csvContent);

      res.json({
        success: true,
        import: importResult,
        audit: auditReport,
      });
    } catch (error) {
      console.error("Error importing OpenAI CSV:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'CSV import failed'
      });
    }
  });

  // Get reconciliation data for the cost dashboard
  app.get('/api/analytics/reconciliation-summary', isAuthenticated, async (req, res) => {
    try {
      const startDate = req.query.startDate as string || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const endDate = req.query.endDate as string || new Date().toISOString().split('T')[0];

      const { db } = await import('./db');
      const { dailyReconciliation, dailyOrgUsage, dailyOpenaiCosts } = await import('../shared/schema');
      const { and, gte, lte, sql, desc } = await import('drizzle-orm');

      const reconciliations = await db.select().from(dailyReconciliation)
        .where(and(gte(dailyReconciliation.dateUtc, startDate), lte(dailyReconciliation.dateUtc, endDate)))
        .orderBy(desc(dailyReconciliation.dateUtc));

      const orgUsage = await db.select().from(dailyOrgUsage)
        .where(and(gte(dailyOrgUsage.dateUtc, startDate), lte(dailyOrgUsage.dateUtc, endDate)));

      const legacyCosts = await db.select().from(dailyOpenaiCosts)
        .where(and(gte(dailyOpenaiCosts.date, startDate), lte(dailyOpenaiCosts.date, endDate)));

      const modelCostSummary: Record<string, { totalTokens: number, estimatedCostCents: number, requests: number }> = {};
      for (const row of orgUsage) {
        const model = row.model;
        if (!modelCostSummary[model]) {
          modelCostSummary[model] = { totalTokens: 0, estimatedCostCents: 0, requests: 0 };
        }
        modelCostSummary[model].totalTokens += (row.inputTokens || 0) + (row.outputTokens || 0);
        modelCostSummary[model].estimatedCostCents += row.estimatedCostCents || 0;
        modelCostSummary[model].requests += row.numModelRequests || 0;
      }

      let totalActualUsd = 0;
      let totalEstimatedUsd = 0;
      for (const r of reconciliations) {
        totalActualUsd += Number(r.actualUsd) || 0;
        totalEstimatedUsd += Number(r.estimatedUsd) || 0;
      }

      res.json({
        period: { startDate, endDate },
        totalActualUsd,
        totalEstimatedUsd,
        totalDeltaUsd: totalActualUsd - totalEstimatedUsd,
        daysReconciled: reconciliations.length,
        dailyReconciliations: reconciliations,
        modelCostSummary,
        legacyCosts: legacyCosts.map(c => ({
          date: c.date,
          actualCostCents: c.actualCostCents,
          estimatedCostCents: c.estimatedCostCents,
          discrepancyPercent: c.discrepancyPercent,
        })),
      });
    } catch (error) {
      console.error("Error fetching reconciliation summary:", error);
      res.status(500).json({ error: 'Failed to fetch reconciliation summary' });
    }
  });

  // Manually trigger quality grading for a call (useful for backfilling)
  app.post('/api/call-logs/:id/grade', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }
      
      if (!callLog.transcript || callLog.transcript.length < 50) {
        return res.status(400).json({ message: "Insufficient transcript for grading" });
      }
      
      const { callGradingService } = await import('../src/services/callGradingService');
      
      const grading = await callGradingService.gradeCall(callLog.id, callLog.transcript);
      
      res.json({ 
        success: true, 
        grading 
      });
    } catch (error) {
      console.error("Error grading call:", error);
      res.status(500).json({ message: "Failed to grade call" });
    }
  });

  // Fetch Twilio Insights for a specific call
  app.post('/api/call-logs/:id/fetch-insights', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }
      
      if (!callLog.callSid) {
        return res.status(400).json({ message: "No Call SID available for this call" });
      }
      
      const { twilioInsightsService } = await import('../src/services/twilioInsightsService');
      
      const success = await twilioInsightsService.fetchAndSaveInsights(callLog.id, callLog.callSid);
      
      if (success) {
        const updatedCallLog = await storage.getCallLog(req.params.id);
        res.json({ 
          success: true, 
          callLog: updatedCallLog 
        });
      } else {
        res.status(500).json({ message: "Failed to fetch Twilio insights" });
      }
    } catch (error) {
      console.error("Error fetching Twilio insights:", error);
      res.status(500).json({ message: "Failed to fetch Twilio insights" });
    }
  });

  // Backfill Twilio Insights for recent calls
  app.post('/api/call-logs/backfill-insights', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { hoursBack = 24, limit = 50 } = req.body;
      
      const { twilioInsightsService } = await import('../src/services/twilioInsightsService');
      
      const results = await twilioInsightsService.backfillInsightsForRecentCalls(hoursBack, limit);
      
      res.json(results);
    } catch (error) {
      console.error("Error backfilling Twilio insights:", error);
      res.status(500).json({ message: "Failed to backfill Twilio insights" });
    }
  });

  // Comprehensive backfill: fix prefixes, Twilio data, and OpenAI costs in one run
  app.post('/api/call-logs/comprehensive-backfill', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { daysBack = 30, limit = 500, dryRun = false } = req.body;
      const twilioClient = await getTwilioClient();
      const { db } = await import('./db');
      const { callLogs } = await import('../shared/schema');
      const { eq, like, or, isNull, and, sql, desc, gte } = await import('drizzle-orm');
      
      console.log(`[BACKFILL] Starting comprehensive backfill (daysBack=${daysBack}, limit=${limit}, dryRun=${dryRun})`);
      
      const results = {
        prefixesFixed: 0,
        twilioUpdated: 0,
        openaiCostsAdded: 0,
        errors: [] as string[],
        samples: [] as any[],
      };

      // STEP 1: Fix callSid prefixes
      console.log('[BACKFILL] Step 1: Fixing callSid prefixes...');
      const prefixedCalls = await db
        .select({ id: callLogs.id, callSid: callLogs.callSid })
        .from(callLogs)
        .where(or(
          like(callLogs.callSid, 'outbound_conf_%'),
          like(callLogs.callSid, 'test_conf_%'),
          like(callLogs.callSid, 'conf_%')
        ));

      for (const call of prefixedCalls) {
        if (!call.callSid) continue;
        const cleanSid = call.callSid.replace(/^(outbound_|test_)?conf_/, '');
        if (cleanSid.startsWith('CA')) {
          if (!dryRun) {
            await db.update(callLogs).set({ callSid: cleanSid }).where(eq(callLogs.id, call.id));
          }
          results.prefixesFixed++;
          if (results.samples.length < 5) {
            results.samples.push({ step: 'prefix', old: call.callSid, new: cleanSid });
          }
        }
      }
      console.log(`[BACKFILL] Fixed ${results.prefixesFixed} callSid prefixes`);

      // STEP 2: Fetch Twilio data and update durations/costs
      console.log('[BACKFILL] Step 2: Fetching Twilio data...');
      const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      
      const allCalls = await db
        .select({
          id: callLogs.id,
          callSid: callLogs.callSid,
          duration: callLogs.duration,
          twilioCostCents: callLogs.twilioCostCents,
          openaiCostCents: callLogs.openaiCostCents,
        })
        .from(callLogs)
        .where(and(
          like(callLogs.callSid, 'CA%'),
          gte(callLogs.createdAt, startDate)
        ))
        .orderBy(desc(callLogs.createdAt))
        .limit(limit);

      console.log(`[BACKFILL] Processing ${allCalls.length} calls...`);

      for (const call of allCalls) {
        if (!call.callSid) continue;

        await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit

        try {
          const twilioCall = await twilioClient.calls(call.callSid).fetch();
          const twilioDuration = twilioCall.duration ? parseInt(twilioCall.duration) : null;
          const twilioPrice = twilioCall.price ? parseFloat(twilioCall.price) : null;
          const twilioCostCents = twilioPrice !== null ? Math.round(Math.abs(twilioPrice) * 100) : null;

          const needsUpdate = 
            (twilioDuration !== null && twilioDuration !== call.duration) ||
            (twilioCostCents !== null && twilioCostCents !== call.twilioCostCents);

          if (needsUpdate) {
            const finalDuration = twilioDuration ?? call.duration ?? 0;
            const openaiCostCents = Math.round(finalDuration / 60 * 15); // $0.15/min avg

            if (!dryRun) {
              await storage.updateCallLog(call.id, {
                duration: finalDuration,
                twilioCostCents: twilioCostCents ?? call.twilioCostCents,
                openaiCostCents,
                costIsEstimated: true,
              });
            }
            results.twilioUpdated++;
            
            if (results.samples.length < 10) {
              results.samples.push({
                step: 'twilio',
                callSid: call.callSid,
                oldDuration: call.duration,
                newDuration: finalDuration,
                oldCost: call.twilioCostCents,
                newCost: twilioCostCents,
              });
            }
          }
        } catch (err: any) {
          if (err.code !== 20404) { // Ignore not found errors
            results.errors.push(`${call.callSid}: ${err.message}`);
          }
        }
      }
      console.log(`[BACKFILL] Updated ${results.twilioUpdated} calls with Twilio data`);

      // STEP 3: Add missing OpenAI costs
      console.log('[BACKFILL] Step 3: Adding missing OpenAI costs...');
      const callsMissingCost = await db
        .select({ id: callLogs.id, duration: callLogs.duration })
        .from(callLogs)
        .where(and(
          isNull(callLogs.openaiCostCents),
          sql`${callLogs.duration} > 0`
        ))
        .limit(500);

      for (const call of callsMissingCost) {
        if (!call.duration) continue;
        const openaiCostCents = Math.round(call.duration / 60 * 15);
        if (!dryRun) {
          await db.update(callLogs).set({ 
            openaiCostCents,
            costIsEstimated: true,
          }).where(eq(callLogs.id, call.id));
        }
        results.openaiCostsAdded++;
      }
      console.log(`[BACKFILL] Added OpenAI costs to ${results.openaiCostsAdded} calls`);

      console.log(`[BACKFILL] Complete: prefixes=${results.prefixesFixed}, twilio=${results.twilioUpdated}, openai=${results.openaiCostsAdded}, errors=${results.errors.length}`);
      
      res.json({
        success: true,
        dryRun,
        summary: {
          prefixesFixed: results.prefixesFixed,
          twilioUpdated: results.twilioUpdated,
          openaiCostsAdded: results.openaiCostsAdded,
          errorCount: results.errors.length,
        },
        samples: results.samples,
        errors: results.errors.slice(0, 10),
      });
    } catch (error) {
      console.error("[BACKFILL] Fatal error:", error);
      res.status(500).json({ message: "Backfill failed", error: String(error) });
    }
  });

  // AI-powered call review for prompt improvement suggestions
  app.post('/api/call-logs/:id/review', isAuthenticated, async (req, res) => {
    try {
      const callLog = await storage.getCallLog(req.params.id);
      if (!callLog) {
        return res.status(404).json({ message: "Call log not found" });
      }
      
      if (!callLog.transcript || callLog.transcript.length < 100) {
        return res.status(400).json({ message: "Insufficient transcript for review (minimum 100 characters)" });
      }
      
      const { callReviewService } = await import('../src/services/callReviewService');
      
      const review = await callReviewService.reviewCallForPromptImprovement(
        callLog.transcript,
        callLog.agentUsed || callLog.agentId || 'unknown',
        undefined
      );
      
      res.json({ 
        success: true, 
        review 
      });
    } catch (error) {
      console.error("Error reviewing call:", error);
      res.status(500).json({ message: "Failed to review call" });
    }
  });

  // Bulk call pattern analysis
  app.post('/api/call-logs/analyze-patterns', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { callIds } = req.body;
      
      if (!callIds || !Array.isArray(callIds) || callIds.length < 2) {
        return res.status(400).json({ message: "At least 2 call IDs required for pattern analysis" });
      }
      
      if (callIds.length > 20) {
        return res.status(400).json({ message: "Maximum 20 calls for pattern analysis" });
      }
      
      const calls = await Promise.all(
        callIds.map(id => storage.getCallLog(id))
      );
      
      const validCalls = calls.filter(c => c && c.transcript && c.transcript.length > 100);
      
      if (validCalls.length < 2) {
        return res.status(400).json({ message: "At least 2 calls with sufficient transcripts required" });
      }
      
      const { callReviewService } = await import('../src/services/callReviewService');
      
      const analysis = await callReviewService.reviewMultipleCallsForPatterns(
        validCalls.map(c => ({
          transcript: c!.transcript!,
          agentSlug: c!.agentUsed || c!.agentId || 'unknown',
          qualityScore: c!.qualityScore || undefined
        }))
      );
      
      res.json({ 
        success: true, 
        analysis,
        analyzedCalls: validCalls.length
      });
    } catch (error) {
      console.error("Error analyzing call patterns:", error);
      res.status(500).json({ message: "Failed to analyze call patterns" });
    }
  });

  // ==================== SMS Logs Routes ====================
  
  // Get SMS logs
  app.get('/api/sms-logs', isAuthenticated, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const smsLogs = await storage.getSmsLogs(limit);
      res.json(smsLogs);
    } catch (error) {
      console.error("Error fetching SMS logs:", error);
      res.status(500).json({ message: "Failed to fetch SMS logs" });
    }
  });

  // ==================== Callback Queue Routes ====================
  
  // Get callback queue with filtering
  app.get('/api/callback-queue', isAuthenticated, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const priority = req.query.priority as string | undefined;
      const assignedTo = req.query.assignedTo as string | undefined;
      
      const queue = await storage.getCallbackQueue({
        status,
        priority,
        assignedTo,
      });
      
      res.json(queue);
    } catch (error) {
      console.error("Error fetching callback queue:", error);
      res.status(500).json({ message: "Failed to fetch callback queue" });
    }
  });

  // Update callback queue item
  app.patch('/api/callback-queue/:id', isAuthenticated, async (req: any, res) => {
    try {
      const updates = { ...req.body };
      
      // If assigning to current user and no assignedTo specified
      if (req.body.status === 'assigned' && !req.body.assignedTo) {
        updates.assignedTo = req.user.claims.sub;
        updates.assignedAt = new Date();
      }
      
      const item = await storage.updateCallbackQueueItem(req.params.id, updates);
      res.json(item);
    } catch (error) {
      console.error("Error updating callback queue item:", error);
      res.status(500).json({ message: "Failed to update callback queue item" });
    }
  });

  // ==================== Scheduling Workflows Routes ====================
  
  // Get all active scheduling workflows (form-filling in progress)
  app.get('/api/scheduling-workflows/active', isAuthenticated, async (req, res) => {
    try {
      const workflows = await storage.getActiveSchedulingWorkflows();
      res.json(workflows);
    } catch (error) {
      console.error("Error fetching active scheduling workflows:", error);
      res.status(500).json({ message: "Failed to fetch active scheduling workflows" });
    }
  });
  
  // Get all scheduling workflows with optional filters
  app.get('/api/scheduling-workflows', isAuthenticated, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const campaignId = req.query.campaignId as string | undefined;
      
      const workflows = await storage.getSchedulingWorkflows({ status, campaignId });
      res.json(workflows);
    } catch (error) {
      console.error("Error fetching scheduling workflows:", error);
      res.status(500).json({ message: "Failed to fetch scheduling workflows" });
    }
  });
  
  // Get scheduling workflow by ID
  app.get('/api/scheduling-workflows/:id', isAuthenticated, async (req, res) => {
    try {
      const workflow = await storage.getSchedulingWorkflow(req.params.id);
      if (!workflow) {
        return res.status(404).json({ message: "Workflow not found" });
      }
      res.json(workflow);
    } catch (error) {
      console.error("Error fetching scheduling workflow:", error);
      res.status(500).json({ message: "Failed to fetch scheduling workflow" });
    }
  });
  
  // Update scheduling workflow (manual intervention)
  app.patch('/api/scheduling-workflows/:id', isAuthenticated, async (req: any, res) => {
    try {
      const workflowId = req.params.id;
      const userId = req.user.claims.sub;
      const updates = { ...req.body };
      
      // Server-side validation and operator tracking
      const allowedUpdates = ['status', 'manualOverrideEnabled', 'operatorNotes'];
      const requestedUpdates = Object.keys(updates);
      const invalidUpdates = requestedUpdates.filter(key => !allowedUpdates.includes(key));
      
      if (invalidUpdates.length > 0) {
        return res.status(400).json({ 
          message: `Invalid fields: ${invalidUpdates.join(', ')}. Allowed: ${allowedUpdates.join(', ')}` 
        });
      }
      
      // Use transaction with row-level locking to prevent race conditions
      const { WorkflowStateHelper } = await import('./services/workflowStateHelper');
      const { WorkflowValidationError } = await import('./errors');
      
      const workflow = await storage.updateSchedulingWorkflowWithLock(workflowId, (currentWorkflow) => {
        // Validate operator actions based on locked current state
        const validation = WorkflowStateHelper.validateOperatorAction(currentWorkflow, updates);
        
        if (!validation.valid) {
          throw new WorkflowValidationError(validation.error || 'Invalid operator action');
        }
        
        // Log warnings for reopen scenarios
        if (validation.warnings && validation.warnings.length > 0) {
          validation.warnings.forEach(warning => {
            console.warn(`[SCHEDULING] Operator ${userId}: ${warning}`);
          });
        }
        
        // Build atomic updates based on locked current state
        const atomicUpdates: Partial<typeof currentWorkflow> = {};
        
        // Stamp operator metadata for ALL manual interventions
        atomicUpdates.operatorId = userId;
        atomicUpdates.operatorInterventionAt = new Date();
        atomicUpdates.updatedAt = new Date();
        
        // Copy requested fields
        if (req.body.operatorNotes !== undefined) {
          atomicUpdates.operatorNotes = req.body.operatorNotes;
        }
        if (req.body.status !== undefined) {
          atomicUpdates.status = req.body.status;
        }
        
        // Handle specific operator actions and enforce invariants
        if (req.body.status === 'cancelled') {
          // Force clear manual override on cancellation
          atomicUpdates.manualOverrideEnabled = false;
          atomicUpdates.operatorNotes = null;
          console.info(`[SCHEDULING] Operator ${userId} cancelling workflow ${workflowId} from state: ${currentWorkflow.status}`);
        } else if (req.body.status && WorkflowStateHelper.isTerminal(req.body.status)) {
          // Force clear manual override on any terminal state
          atomicUpdates.manualOverrideEnabled = false;
          atomicUpdates.operatorNotes = null;
          console.info(`[SCHEDULING] Operator ${userId} setting workflow ${workflowId} to terminal state: ${req.body.status}`);
        } else if (req.body.hasOwnProperty('manualOverrideEnabled')) {
          // Only mutate manualOverrideEnabled if explicitly provided
          if (req.body.manualOverrideEnabled === true) {
            atomicUpdates.manualOverrideEnabled = true;
            console.info(`[SCHEDULING] Operator ${userId} pausing workflow ${workflowId}: ${req.body.operatorNotes || 'No reason provided'}`);
          } else if (req.body.manualOverrideEnabled === false) {
            // Explicit resume - clear override and notes
            atomicUpdates.manualOverrideEnabled = false;
            atomicUpdates.operatorNotes = null;
            console.info(`[SCHEDULING] Operator ${userId} resuming workflow ${workflowId}`);
          }
        }
        
        // Log successful transition if status changed
        if (req.body.status && req.body.status !== currentWorkflow.status) {
          const metadata = WorkflowStateHelper.getTransitionMetadata(currentWorkflow.status, req.body.status);
          if (metadata.isReopen) {
            console.info(`[SCHEDULING] Operator ${userId} reopening workflow ${workflowId}: ${currentWorkflow.status} → ${req.body.status}`);
          } else if (metadata.isTerminating) {
            console.info(`[SCHEDULING] Operator ${userId} terminating workflow ${workflowId}: ${currentWorkflow.status} → ${req.body.status}`);
          } else {
            console.info(`[SCHEDULING] Operator ${userId} transitioning workflow ${workflowId}: ${currentWorkflow.status} → ${req.body.status}`);
          }
        }
        
        return atomicUpdates;
      });
      
      res.json(workflow);
    } catch (error: any) {
      const { isWorkflowValidationError } = await import('./errors');
      
      // Return 400 for validation errors, 500 for system errors
      if (isWorkflowValidationError(error)) {
        console.warn(`[SCHEDULING] Validation error: ${error.message}`);
        return res.status(400).json({ message: error.message });
      }
      
      console.error("Error updating scheduling workflow:", error);
      res.status(500).json({ message: "Failed to update scheduling workflow" });
    }
  });

  // ==================== Stats Route ====================
  
  // Get dashboard statistics
  app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  // ==================== Test Call Route ====================
  
  // Initiate test call
  app.post('/api/test-call', isAuthenticated, async (req: any, res) => {
    try {
      const { agentId, phoneNumber } = req.body;
      // Support both Replit auth (req.user.claims.sub) and custom auth (req.user.id)
      const userId = req.user?.claims?.sub || req.user?.id || 'unknown';
      
      if (!agentId || !phoneNumber) {
        return res.status(400).json({ message: "Agent ID and phone number are required" });
      }

      // 1. Validate phone number (E.164 format only)
      const e164Regex = /^\+[1-9]\d{1,14}$/;
      if (!e164Regex.test(phoneNumber)) {
        return res.status(400).json({
          message: 'Invalid phone number. Must be E.164 format (e.g., +12345678900)'
        });
      }

      // 2. Rate limiting (5 calls per hour per user)
      const now = Date.now();
      const userLimit = testCallRateLimit.get(userId);
      
      if (userLimit) {
        if (now < userLimit.resetTime) {
          if (userLimit.count >= 5) {
            return res.status(429).json({
              message: 'Rate limit exceeded. Maximum 5 test calls per hour.'
            });
          }
          userLimit.count++;
        } else {
          testCallRateLimit.set(userId, { count: 1, resetTime: now + 3600000 });
        }
      } else {
        testCallRateLimit.set(userId, { count: 1, resetTime: now + 3600000 });
      }

      // 3. Audit logging
      console.log(`[AUDIT] Test call initiated by user ${userId} to ${phoneNumber}`);

      // 4. Validate agent exists
      const agent = await storage.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ message: 'Agent not found' });
      }

      // 5. Get Twilio client from integration
      const twilioClient = await getTwilioClient();
      const fromPhoneNumber = await getTwilioFromPhoneNumber();
      const DOMAIN = process.env.DOMAIN || process.env.REPL_SLUG + '.replit.dev';

      if (!fromPhoneNumber) {
        return res.status(500).json({ message: "Twilio phone number not configured in integration" });
      }

      // 6. Make Twilio call with agent metadata
      // Use test/incoming endpoint which supports agent metadata via query params
      const testCallUrl = `https://${DOMAIN}/api/voice/test/incoming?agentSlug=${encodeURIComponent(agent.slug)}`;
      
      const call = await twilioClient.calls.create({
        to: phoneNumber,
        from: fromPhoneNumber,
        url: testCallUrl,
        method: 'POST',
        statusCallback: `https://${DOMAIN}/api/test-calls/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true,
        recordingStatusCallback: `https://${DOMAIN}/api/voice/recording-status`,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: ['completed']
      });

      await storage.createCallLog({
        callSid: call.sid,
        agentId: agentId,
        direction: 'outbound',
        from: fromPhoneNumber,
        to: phoneNumber,
        status: 'initiated',
        startTime: new Date(),
      });

      res.json({
        message: "Test call initiated",
        callSid: call.sid,
        agentId,
        phoneNumber,
        status: call.status,
      });
    } catch (error) {
      console.error("[TEST CALL] Error:", error);
      res.status(500).json({ message: "Failed to initiate test call", error: String(error) });
    }
  });

  // ==================== Testing Routes ====================
  
  // Test Twilio connectivity
  app.post('/api/test/twilio-connectivity', isAuthenticated, async (req, res) => {
    try {
      const { testRunner } = await import('../src/testing/outboundTestRunner');
      const result = await testRunner.testTwilioConnectivity();
      res.json(result);
    } catch (error) {
      console.error("[TEST] Twilio connectivity error:", error);
      res.status(500).json({ 
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // List available agents for testing
  app.get('/api/test/agents', isAuthenticated, async (req, res) => {
    try {
      const { testRunner } = await import('../src/testing/outboundTestRunner');
      const agents = await testRunner.listAvailableAgents();
      res.json(agents);
    } catch (error) {
      console.error("[TEST] List agents error:", error);
      res.status(500).json({ 
        message: 'Failed to list agents',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Test agent availability
  app.post('/api/test/agent-availability/:agentSlug', isAuthenticated, async (req, res) => {
    try {
      const { testRunner } = await import('../src/testing/outboundTestRunner');
      const result = await testRunner.testAgentAvailability(req.params.agentSlug);
      res.json(result);
    } catch (error) {
      console.error("[TEST] Agent availability error:", error);
      res.status(500).json({ 
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Make comprehensive test call
  app.post('/api/test/call/:agentSlug', isAuthenticated, async (req, res) => {
    try {
      const { agentSlug } = req.params;
      const { toPhoneNumber, campaignId, contactId } = req.body;

      if (!toPhoneNumber) {
        return res.status(400).json({ 
          success: false,
          error: 'Phone number is required' 
        });
      }

      // Rate limiting check (max 5 calls per hour per user per agent)
      const userId = (req as any).user.claims.sub;
      const rateLimitKey = `${userId}-${agentSlug}-test-calls`;
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      let rateLimit = testCallRateLimit.get(rateLimitKey);
      
      if (!rateLimit || now > rateLimit.resetTime) {
        rateLimit = { count: 0, resetTime: now + oneHour };
      }

      if (rateLimit.count >= 5) {
        return res.status(429).json({
          success: false,
          error: `Rate limit exceeded for ${agentSlug}. Maximum 5 test calls per hour per agent.`,
          resetTime: new Date(rateLimit.resetTime).toISOString()
        });
      }

      // Increment rate limit BEFORE attempting call (counts failures too)
      rateLimit.count++;
      testCallRateLimit.set(rateLimitKey, rateLimit);

      const { testRunner } = await import('../src/testing/outboundTestRunner');
      const result = await testRunner.makeTestCall({
        agentSlug,
        toPhoneNumber,
        campaignId,
        contactId
      });

      res.json(result);
    } catch (error) {
      console.error("[TEST] Test call error:", error);
      res.status(500).json({ 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        logs: []
      });
    }
  });

  // Run predefined test suite
  app.post('/api/test/suite/:agentSlug', isAuthenticated, async (req, res) => {
    try {
      const { agentSlug } = req.params;
      const { phoneNumber, campaignId, contactId, scenarioName } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ 
          success: false,
          error: 'Phone number is required for test suite' 
        });
      }

      const { runAgentTest } = await import('../src/testing/agentTests');
      const result = await runAgentTest(agentSlug, phoneNumber, scenarioName, campaignId, contactId);

      res.json(result);
    } catch (error) {
      console.error("[TEST] Test suite error:", error);
      res.status(500).json({ 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ==================== Live Call Monitoring ====================
  
  // Get active conferences (ongoing calls)
  app.get('/api/monitoring/active-calls', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const twilioClient = await getTwilioClient();
      
      // Get all conferences that are in progress
      const conferences = await twilioClient.conferences.list({
        status: 'in-progress',
        limit: 50
      });
      
      const activeCalls = conferences.map(conf => ({
        conferenceSid: conf.sid,
        conferenceName: conf.friendlyName,
        status: conf.status,
        dateCreated: conf.dateCreated,
        participantCount: 0 // Will be populated by participant query if needed
      }));
      
      res.json({ success: true, calls: activeCalls });
    } catch (error) {
      console.error("[MONITORING] Error fetching active calls:", error);
      res.status(500).json({ 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Join conference for live monitoring (supervisor barge-in or whisper coaching)
  app.post('/api/monitoring/join-call', isAuthenticated, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { conferenceSid, supervisorPhoneNumber, mode, agentCallSid } = req.body;
      
      // Validate required fields
      if (!conferenceSid || !supervisorPhoneNumber) {
        return res.status(400).json({ 
          success: false,
          error: 'Conference SID and supervisor phone number are required' 
        });
      }
      
      // Validate agentCallSid if coach mode is requested
      if (mode === 'coach' && !agentCallSid) {
        return res.status(400).json({ 
          success: false,
          error: 'Agent Call SID is required for coach/whisper mode. Use "listen" for monitoring without coaching.' 
        });
      }
      
      // Validate agentCallSid format if provided (Twilio Call SIDs start with CA and are 34 chars)
      if (agentCallSid && (typeof agentCallSid !== 'string' || !agentCallSid.startsWith('CA') || agentCallSid.length !== 34)) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid agent Call SID format' 
        });
      }
      
      // Validate conference SID format (Twilio SIDs start with CF and are 34 chars)
      if (typeof conferenceSid !== 'string' || !conferenceSid.startsWith('CF') || conferenceSid.length !== 34) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid conference SID format' 
        });
      }
      
      // Validate phone number format (E.164)
      const phoneRegex = /^\+[1-9]\d{1,14}$/;
      if (!phoneRegex.test(supervisorPhoneNumber)) {
        return res.status(400).json({ 
          success: false,
          error: 'Supervisor phone number must be in E.164 format (e.g., +12345678900)' 
        });
      }
      
      const twilioClient = await getTwilioClient();
      const twilioPhoneNumber = await getTwilioFromPhoneNumber();
      
      // Validate mode parameter
      const validModes = ['listen', 'coach'];
      const selectedMode = mode && validModes.includes(mode) ? mode : 'listen';
      
      // Verify conference exists and is in progress
      try {
        const conference = await twilioClient.conferences(conferenceSid).fetch();
        if (conference.status !== 'in-progress') {
          return res.status(400).json({ 
            success: false,
            error: `Conference is not active (status: ${conference.status})` 
          });
        }
      } catch (fetchError: any) {
        if (fetchError.status === 404) {
          return res.status(404).json({ 
            success: false,
            error: 'Conference not found' 
          });
        }
        throw fetchError;
      }
      
      // Add supervisor as participant with proper mute/coach settings
      // Mode options:
      //   'listen': Supervisor is muted, can only listen (muted=true, coaching=false)
      //   'coach': Supervisor can whisper to agent only (muted=false, coaching=true, callSidToCoach=agentCallSid)
      const participantConfig: any = {
        from: twilioPhoneNumber,
        to: supervisorPhoneNumber,
        earlyMedia: true,
        label: 'supervisor',
        startConferenceOnEnter: false,
        endConferenceOnExit: false,
      };
      
      // Configure based on mode
      if (selectedMode === 'listen') {
        // Listen-only mode: muted, no coaching
        participantConfig.muted = true;
        participantConfig.coaching = false;
      } else if (selectedMode === 'coach' && agentCallSid) {
        // Whisper coaching mode: supervisor can speak to agent only, customer cannot hear
        participantConfig.muted = false;
        participantConfig.coaching = true;
        participantConfig.callSidToCoach = agentCallSid;
      } else {
        // Fallback to listen mode if invalid configuration
        participantConfig.muted = true;
        participantConfig.coaching = false;
      }
      
      const participant = await twilioClient.conferences(conferenceSid).participants.create(participantConfig);
      
      console.log(`[MONITORING] Supervisor joined conference ${conferenceSid} in ${selectedMode} mode (muted: ${participantConfig.muted}, coaching: ${participantConfig.coaching})`);
      
      // Extract participantSid from response (Twilio SDK types may not expose all properties)
      const participantSid = (participant as any).sid || (participant as any).callSid || 'unknown';
      
      res.json({ 
        success: true, 
        participantSid,
        mode: selectedMode,
        muted: participantConfig.muted,
        coaching: participantConfig.coaching,
        message: selectedMode === 'coach' 
          ? `Supervisor added in whisper coaching mode (can speak to agent only)` 
          : `Supervisor added in listen-only mode (muted)`
      });
    } catch (error: any) {
      console.error("[MONITORING] Error joining call:", error);
      
      // Provide specific error messages for common Twilio errors
      if (error.code === 21205) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid phone number format' 
        });
      }
      if (error.code === 21227) {
        return res.status(400).json({ 
          success: false,
          error: 'Conference has already ended' 
        });
      }
      
      res.status(500).json({ 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get test call logs
  app.get('/api/test/logs', isAuthenticated, async (req, res) => {
    try {
      const { testRunner } = await import('../src/testing/outboundTestRunner');
      const logs = testRunner.getLogs();
      res.json({ logs });
    } catch (error) {
      console.error("[TEST] Get logs error:", error);
      res.status(500).json({ 
        logs: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ==================== Ticketing Webhook Endpoint ====================
  
  // Webhook: Receive ticket resolution notifications from external ticketing system
  // Called by external system when ticket is resolved with phone contact method
  app.post('/api/campaigns/ticket-resolved', async (req, res) => {
    try {
      // Authenticate using API key
      const providedApiKey = req.headers['x-api-key'];
      const expectedApiKey = process.env.VOICE_AGENT_WEBHOOK_SECRET;

      if (!expectedApiKey) {
        console.error('[TICKET WEBHOOK] VOICE_AGENT_WEBHOOK_SECRET not configured');
        return res.status(500).json({
          success: false,
          error: 'Server configuration error'
        });
      }

      if (!providedApiKey || providedApiKey !== expectedApiKey) {
        console.warn('[TICKET WEBHOOK] Unauthorized access attempt');
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid API key'
        });
      }

      // Parse webhook payload
      const {
        ticketId,
        ticketNumber,
        patientFirstName,
        patientLastName,
        patientPhone,
        patientEmail,
        preferredContactMethod,
        resolutionNotes,
        departmentId,
      } = req.body;

      console.info('[TICKET WEBHOOK] Received ticket resolution:', {
        ticketId,
        ticketNumber,
        patient: `${patientFirstName} ${patientLastName}`,
        phone: patientPhone,
        contactMethod: preferredContactMethod,
      });

      // Validate required fields
      if (!ticketId || !ticketNumber || !patientPhone || !resolutionNotes) {
        console.error('[TICKET WEBHOOK] Missing required fields');
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: ticketId, ticketNumber, patientPhone, resolutionNotes'
        });
      }

      // Only process if preferred contact method is phone
      if (preferredContactMethod !== 'phone') {
        console.info(`[TICKET WEBHOOK] Skipping callback - contact method is ${preferredContactMethod}, not phone`);
        return res.json({
          success: true,
          message: 'Ticket received but callback not needed for this contact method'
        });
      }

      // Get the answering service agent (will be used for callbacks)
      const agents = await storage.getAgents();
      const answeringAgent = agents.find(a => a.slug === 'answering-service');
      
      if (!answeringAgent) {
        console.error('[TICKET WEBHOOK] Answering service agent not found');
        return res.status(500).json({
          success: false,
          error: 'Answering service agent not configured'
        });
      }

      // Check if ticket already exists (idempotency)
      const existingTickets = await storage.getSupportTickets({ status: 'resolved' });
      const existingTicket = existingTickets.find(t => t.externalTicketId === String(ticketId));
      
      if (existingTicket) {
        console.info(`[TICKET WEBHOOK] Ticket ${ticketNumber} already processed, skipping duplicate`);
        return res.json({
          success: true,
          message: 'Ticket already processed (idempotent)',
          ticketId: existingTicket.id,
          campaignId: existingTicket.campaignId,
        });
      }

      // Create support ticket record with correct external IDs
      const ticket = await storage.createSupportTicket({
        ticketNumber: `TICKET-${ticketId}`, // Internal format
        patientName: `${patientFirstName} ${patientLastName}`,
        contactInfo: patientPhone,
        department: departmentId === 1 ? 'optical' : departmentId === 2 ? 'surgery_coordinator' : 'clinical_tech',
        issueSummary: `Ticket ${ticketNumber} Resolution Callback`,
        issueDetails: resolutionNotes,
        priority: 'medium',
        status: 'resolved',
        externalTicketId: String(ticketId), // Foreign key to external system
        externalTicketNumber: ticketNumber, // Human-readable from external system
        patientPhone,
        patientEmail,
        preferredContactMethod,
        resolutionNotes,
        resolvedAt: new Date(),
      });

      // Atomically get or create the single ongoing Resolution Callbacks campaign
      const RESOLUTION_CAMPAIGN_NAME = 'Resolution Callbacks';
      const campaign = await storage.getOrCreateCampaignByName(RESOLUTION_CAMPAIGN_NAME, {
        name: RESOLUTION_CAMPAIGN_NAME,
        description: 'Ongoing campaign for resolved ticket callbacks. Contacts are added automatically when tickets are resolved.',
        agentId: answeringAgent.id,
        campaignType: 'call',
        status: 'running',
        totalContacts: 0,
        scheduledStartTime: new Date(),
      });

      // Update ticket with campaign link
      await storage.updateSupportTicket(ticket.id, {
        campaignId: campaign.id,
      });

      // Add contact to the ongoing campaign
      await storage.createCampaignContacts([{
        campaignId: campaign.id,
        phoneNumber: patientPhone,
        firstName: patientFirstName,
        lastName: patientLastName,
        email: patientEmail,
        customData: {
          ticketId,
          ticketNumber,
          resolutionNotes,
        },
      }]);

      // Update campaign total contacts count
      const campaignContacts = await storage.getCampaignContacts(campaign.id);
      await storage.updateCampaign(campaign.id, {
        totalContacts: campaignContacts.length,
      });

      console.info(`[TICKET WEBHOOK] ✓ Contact added to Resolution Callbacks campaign for ticket ${ticketNumber} (total: ${campaignContacts.length})`);

      res.json({
        success: true,
        message: 'Contact added to Resolution Callbacks campaign',
        campaignId: campaign.id,
        ticketId: ticket.id,
        totalContacts: campaignContacts.length,
      });
    } catch (error) {
      console.error('[TICKET WEBHOOK] Error processing webhook:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  });

  // ============================================================
  // COST RECONCILIATION (Admin only)
  // ============================================================
  
  app.post('/api/reconcile/costs', isAuthenticated, requireRole('admin'), upload.fields([
    { name: 'twilio_csv', maxCount: 1 },
    { name: 'openai_csv', maxCount: 1 },
  ]), async (req: any, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const twilioCsv = files?.twilio_csv?.[0];
      const openaiCsv = files?.openai_csv?.[0];
      const applyChanges = req.body?.apply === 'true';

      if (!twilioCsv || !openaiCsv) {
        return res.status(400).json({
          success: false,
          error: 'Both twilio_csv and openai_csv files are required'
        });
      }

      const parseTwilioData = (content: string) => {
        try {
          const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
          if (!Array.isArray(records) || records.length === 0) {
            throw new Error('Twilio CSV appears to be empty or invalid');
          }
          const firstRow = records[0] as Record<string, unknown>;
          if (!('Call Sid' in firstRow) || !('Direction' in firstRow)) {
            throw new Error('Twilio CSV missing required columns (Call Sid, Direction)');
          }
          return records.filter((r: any) => r['Direction'] === 'Incoming' && r['Type'] === 'Phone')
            .map((r: any) => ({
              callSid: r['Call Sid'],
              from: r['From'],
              price: r['Price'] && r['Price'] !== 'null' ? parseFloat(r['Price']) : null,
              duration: parseInt(r['Duration'] || '0', 10),
              startTime: new Date(r['Date Created']),
            }));
        } catch (e) {
          throw new Error(`Failed to parse Twilio CSV: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      const parseOpenAIData = (content: string) => {
        try {
          const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
          if (!Array.isArray(records) || records.length === 0) {
            throw new Error('OpenAI CSV appears to be empty or invalid');
          }
          return records
            .filter((r: any) => r['amount_value'] && r['amount_value'] !== '' && r['amount_value'] !== '0E-6176')
            .map((r: any) => ({
              date: r['start_time_iso']?.split('T')[0],
              amountUsd: parseFloat(r['amount_value']),
            }))
            .filter((r: any) => !isNaN(r.amountUsd) && r.amountUsd > 0);
        } catch (e) {
          throw new Error(`Failed to parse OpenAI CSV: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      let twilioCalls: any[];
      let openaiDaily: any[];
      
      try {
        twilioCalls = parseTwilioData(twilioCsv.buffer.toString('utf-8'));
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: e instanceof Error ? e.message : 'Failed to parse Twilio CSV'
        });
      }
      
      try {
        openaiDaily = parseOpenAIData(openaiCsv.buffer.toString('utf-8'));
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: e instanceof Error ? e.message : 'Failed to parse OpenAI CSV'
        });
      }

      const twilioCsvTotalCents = Math.round(
        twilioCalls.filter((c: any) => c.price !== null)
          .reduce((sum: number, c: any) => sum + Math.abs(c.price!) * 100, 0)
      );

      const openaiCsvTotalCents = Math.round(
        openaiDaily.reduce((sum: number, d: any) => sum + d.amountUsd * 100, 0)
      );

      const allDates = [
        ...twilioCalls.map((c: any) => c.startTime),
        ...openaiDaily.map((o: any) => new Date(o.date)),
      ].filter((d: Date) => d instanceof Date && !isNaN(d.getTime()));

      if (allDates.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid dates found in CSV files. Please check that your files contain valid date fields.'
        });
      }

      const dateRange = {
        start: new Date(Math.min(...allDates.map((d: Date) => d.getTime()))),
        end: new Date(Math.max(...allDates.map((d: Date) => d.getTime()))),
      };

      const dbCallsResult = await storage.getCallLogs({
        startDate: dateRange.start,
        endDate: dateRange.end,
        direction: 'inbound',
        limit: 10000,
      });
      const dbCalls = dbCallsResult.data;

      const twilioByCallSid = new Map(twilioCalls.map((c: any) => [c.callSid, c]));
      
      let callsUpdated = 0;
      const callsNeedingUpdate: any[] = [];

      for (const dbCall of dbCalls) {
        if (!dbCall.callSid) continue;
        const twilioCall = twilioByCallSid.get(dbCall.callSid);
        if (!twilioCall || twilioCall.price === null) continue;

        const newCostCents = Math.round(Math.abs(twilioCall.price) * 100);
        if (dbCall.twilioCostCents !== newCostCents) {
          callsNeedingUpdate.push({
            id: dbCall.id,
            callSid: dbCall.callSid,
            oldCost: dbCall.twilioCostCents,
            newCost: newCostCents,
          });

          if (applyChanges) {
            await storage.updateCallLog(dbCall.id, {
              twilioCostCents: newCostCents,
              totalCostCents: newCostCents + (dbCall.openaiCostCents || 0),
            });
            callsUpdated++;
          }
        }
      }

      const dbTwilioCostCents = dbCalls.reduce((sum, c) => sum + (c.twilioCostCents || 0), 0);
      const dbOpenaiCostCents = dbCalls.reduce((sum, c) => sum + (c.openaiCostCents || 0), 0);

      const report = {
        dateRange: {
          start: dateRange.start.toISOString(),
          end: dateRange.end.toISOString(),
        },
        twilio: {
          csvTotalCents: twilioCsvTotalCents,
          dbTotalCents: dbTwilioCostCents,
          discrepancyCents: twilioCsvTotalCents - dbTwilioCostCents,
          callsInCsv: twilioCalls.length,
          callsInDb: dbCalls.filter(c => c.callSid).length,
          callsNeedingUpdate: callsNeedingUpdate.length,
          callsUpdated: callsUpdated,
        },
        openai: {
          csvTotalCents: openaiCsvTotalCents,
          dbTotalCents: dbOpenaiCostCents,
          discrepancyCents: openaiCsvTotalCents - dbOpenaiCostCents,
          daysInCsv: openaiDaily.length,
        },
        summary: {
          totalActualCents: twilioCsvTotalCents + openaiCsvTotalCents,
          totalTrackedCents: dbTwilioCostCents + dbOpenaiCostCents,
          totalDiscrepancyCents: (twilioCsvTotalCents + openaiCsvTotalCents) - (dbTwilioCostCents + dbOpenaiCostCents),
          discrepancyPercent: ((twilioCsvTotalCents + openaiCsvTotalCents) > 0)
            ? (((twilioCsvTotalCents + openaiCsvTotalCents) - (dbTwilioCostCents + dbOpenaiCostCents)) / (twilioCsvTotalCents + openaiCsvTotalCents) * 100).toFixed(1)
            : '0.0',
        },
        applied: applyChanges,
      };

      console.info(`[RECONCILE] Cost reconciliation completed: ${JSON.stringify(report.summary)}`);

      res.json({
        success: true,
        report,
      });
    } catch (error) {
      console.error('[RECONCILE] Error during cost reconciliation:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Reconciliation failed'
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
