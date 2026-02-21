// Database schema for Azul Vision AI Operations Hub
// Reference: blueprint:javascript_database and blueprint:javascript_log_in_with_replit

import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import {
  index,
  uniqueIndex,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
  text,
  integer,
  boolean,
  pgEnum,
  bigint,
  date,
  numeric,
  uuid,
  time,
  real,
} from "drizzle-orm/pg-core";

// Session storage table (for Express sessions)
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User role enum
export const userRoleEnum = pgEnum('user_role', ['admin', 'manager', 'user']);

// User status enum
export const userStatusEnum = pgEnum('user_status', ['pending', 'active', 'suspended', 'deactivated']);

// User storage table with password authentication
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique().notNull(),
  passwordHash: varchar("password_hash"), // bcrypt hashed password
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: userRoleEnum("role").default("user"),
  status: userStatusEnum("status").default("pending"),
  emailVerified: boolean("email_verified").default(false),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// User invitations table
export const userInvitations = pgTable("user_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").notNull(),
  token: varchar("token").notNull().unique(),
  role: userRoleEnum("role").default("user"),
  invitedBy: varchar("invited_by").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_user_invitations_email").on(table.email),
  index("idx_user_invitations_token").on(table.token),
]);

export type UserInvitation = typeof userInvitations.$inferSelect;
export type InsertUserInvitation = typeof userInvitations.$inferInsert;

// Password reset tokens table
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  token: varchar("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_password_reset_tokens_token").on(table.token),
  index("idx_password_reset_tokens_user").on(table.userId),
]);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// Agent status enum
export const agentStatusEnum = pgEnum('agent_status', ['active', 'inactive', 'testing']);

// Voice agents table
export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(), // "After-Hours Triage", "DRS Scheduler", etc.
  slug: varchar("slug").notNull().unique(), // "after-hours", "drs-scheduler"
  description: text("description"),
  agentType: varchar("agent_type").notNull(), // "inbound", "outbound"
  status: agentStatusEnum("status").default("active"),
  
  // Agent configuration
  voice: varchar("voice").default("sage"), // OpenAI voice
  model: varchar("model").default("gpt-realtime"),
  temperature: integer("temperature").default(70), // 0-100, will be converted to 0.0-1.0
  systemPrompt: text("system_prompt").notNull(),
  welcomeGreeting: text("welcome_greeting"),
  
  // Twilio integration
  twilioPhoneNumber: varchar("twilio_phone_number").unique(), // Phone number assigned to this agent (E.164 format) - must be unique
  
  // Metadata
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

// Agent tools configuration
export const agentTools = pgTable("agent_tools", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").references(() => agents.id).notNull(),
  toolName: varchar("tool_name").notNull(),
  toolDescription: text("tool_description"),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AgentTool = typeof agentTools.$inferSelect;

// Phone endpoint environment enum
export const phoneEndpointEnvironmentEnum = pgEnum('phone_endpoint_environment', ['development', 'production', 'both']);

// Phone endpoints table - Source of truth for Twilio phone configuration
export const phoneEndpoints = pgTable("phone_endpoints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  twilioSid: varchar("twilio_sid").notNull().unique(), // Twilio Phone Number SID (PNXXXX)
  phoneNumber: varchar("phone_number").notNull().unique(), // E.164 format (+1XXXXXXXXXX)
  friendlyName: varchar("friendly_name"), // Twilio friendly name
  
  // Webhook configuration (synced with Twilio)
  voiceWebhookUrl: text("voice_webhook_url"), // Current voice webhook URL
  voiceWebhookMethod: varchar("voice_webhook_method").default("POST"),
  smsWebhookUrl: text("sms_webhook_url"), // Current SMS webhook URL
  statusCallbackUrl: text("status_callback_url"),
  
  // Assignment
  assignedAgentId: varchar("assigned_agent_id").references(() => agents.id),
  assignedCampaignId: varchar("assigned_campaign_id"), // Can't reference campaigns due to circular dependency
  
  // Configuration
  environment: phoneEndpointEnvironmentEnum("environment").default("both"),
  isActive: boolean("is_active").default(true),
  
  // Sync status
  lastSyncedAt: timestamp("last_synced_at"), // Last time we synced with Twilio
  syncStatus: varchar("sync_status").default("pending"), // pending, synced, error
  
  // Metadata
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type PhoneEndpoint = typeof phoneEndpoints.$inferSelect;
export type InsertPhoneEndpoint = typeof phoneEndpoints.$inferInsert;

// Campaign status enum
export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled'
]);

// Campaigns table
export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  description: text("description"),
  agentId: varchar("agent_id").references(() => agents.id).notNull(),
  campaignType: varchar("campaign_type").notNull(), // "call", "sms", "both"
  status: campaignStatusEnum("status").default("draft"),
  
  // Scheduling
  scheduledStartTime: timestamp("scheduled_start_time"),
  scheduledEndTime: timestamp("scheduled_end_time"),
  actualStartTime: timestamp("actual_start_time"),
  actualEndTime: timestamp("actual_end_time"),
  
  // Progress tracking
  totalContacts: integer("total_contacts").default(0),
  completedContacts: integer("completed_contacts").default(0),
  successfulContacts: integer("successful_contacts").default(0),
  failedContacts: integer("failed_contacts").default(0),
  
  // Ticket integration (for resolution callbacks)
  resolutionMessage: text("resolution_message"), // Message to deliver during callback
  
  // Metadata
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  deletedAt: timestamp("deleted_at"), // Soft delete - null means active
});

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = typeof campaigns.$inferInsert;

// Contact outreach status enum
export const contactOutreachStatusEnum = pgEnum('contact_outreach_status', [
  'pending',           // Not yet attempted
  'calling',           // Currently being called
  'answered',          // Call answered by human
  'voicemail',         // Voicemail left
  'no_answer',         // No answer, no voicemail
  'callback_scheduled', // Callback scheduled for retry
  'confirmed',         // Appointment confirmed
  'declined',          // Patient declined/cancelled
  'rescheduled',       // Patient wants to reschedule
  'wrong_number',      // Wrong number
  'do_not_call',       // Patient requested no calls
  'max_attempts',      // Max attempts reached without resolution
  'completed'          // Outreach complete (final state)
]);

// Campaign contacts (from CSV upload)
export const campaignContacts = pgTable("campaign_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").references(() => campaigns.id).notNull(),
  phoneNumber: varchar("phone_number").notNull(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  email: varchar("email"),
  customData: jsonb("custom_data"), // Additional fields from CSV
  
  // Appointment details (for appointment confirmation campaigns)
  appointmentDate: timestamp("appointment_date"), // Date/time of the appointment
  appointmentDoctor: varchar("appointment_doctor"), // Provider name
  appointmentLocation: varchar("appointment_location"), // Office location
  appointmentType: varchar("appointment_type"), // Type of appointment
  patientDob: varchar("patient_dob"), // For verification
  
  // Outreach status tracking
  outreachStatus: contactOutreachStatusEnum("outreach_status").default("pending"),
  confirmationResult: varchar("confirmation_result"), // confirmed, declined, rescheduled, unknown
  
  // Contact status (legacy - keeping for backward compatibility)
  contacted: boolean("contacted").default(false),
  successful: boolean("successful").default(false),
  attempts: integer("attempts").default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  
  // Scheduling for callbacks/retries
  nextAttemptAt: timestamp("next_attempt_at"), // When to make next call attempt
  maxAttempts: integer("max_attempts").default(3), // Maximum call attempts
  voicemailLeft: boolean("voicemail_left").default(false), // Whether voicemail was left
  lastCallSid: varchar("last_call_sid"), // Track most recent call
  
  // Timezone for respecting 8am-8pm window
  timezone: varchar("timezone").default("America/Los_Angeles"),
  
  // Agent notes from conversation
  agentNotes: text("agent_notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_campaign_contacts_outreach").on(table.outreachStatus),
  index("idx_campaign_contacts_next_attempt").on(table.nextAttemptAt),
  index("idx_campaign_contacts_phone").on(table.phoneNumber),
]);

export type CampaignContact = typeof campaignContacts.$inferSelect;
export type InsertCampaignContact = typeof campaignContacts.$inferInsert;

// Campaign contact attempts - detailed log of each outreach attempt
export const campaignContactAttempts = pgTable("campaign_contact_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").references(() => campaignContacts.id).notNull(),
  campaignId: varchar("campaign_id").references(() => campaigns.id).notNull(),
  
  // Attempt details
  attemptNumber: integer("attempt_number").notNull(), // 1, 2, 3...
  callSid: varchar("call_sid"), // Twilio call SID
  direction: varchar("direction").notNull(), // outbound, inbound (callback)
  
  // Timing
  attemptedAt: timestamp("attempted_at").defaultNow(),
  answeredAt: timestamp("answered_at"),
  endedAt: timestamp("ended_at"),
  duration: integer("duration"), // seconds
  
  // Outcome
  status: varchar("status").notNull(), // initiated, answered, voicemail, no_answer, busy, failed
  answeredBy: varchar("answered_by"), // human, machine, fax, unknown
  outcome: varchar("outcome"), // confirmed, declined, rescheduled, callback_requested, wrong_number
  
  // Recording/transcript
  recordingUrl: varchar("recording_url"),
  transcriptSummary: text("transcript_summary"),
  
  // Agent notes from this specific call
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_contact_attempts_contact").on(table.contactId),
  index("idx_contact_attempts_call").on(table.callSid),
]);

export type CampaignContactAttempt = typeof campaignContactAttempts.$inferSelect;
export type InsertCampaignContactAttempt = typeof campaignContactAttempts.$inferInsert;

// Call status enum
export const callStatusEnum = pgEnum('call_status', [
  'initiated',
  'ringing',
  'in_progress',
  'completed',
  'failed',
  'no_answer',
  'busy',
  'transferred'
]);

// Call sentiment enum (for AI quality grading)
export const callSentimentEnum = pgEnum('call_sentiment', [
  'satisfied',
  'neutral',
  'frustrated',
  'irate'
]);

// Agent outcome enum (for AI quality grading)
export const agentOutcomeEnum = pgEnum('agent_outcome', [
  'resolved',
  'escalated',
  'follow_up_needed',
  'inconclusive'
]);

// Call logs table
export const callLogs = pgTable("call_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callSid: varchar("call_sid").unique(), // Twilio call SID
  
  // Call details
  agentId: varchar("agent_id").references(() => agents.id),
  campaignId: varchar("campaign_id").references(() => campaigns.id), // null for inbound
  contactId: varchar("contact_id").references(() => campaignContacts.id), // Link to campaign contact
  direction: varchar("direction").notNull(), // "inbound", "outbound"
  
  // Participants
  from: varchar("from").notNull(),
  to: varchar("to").notNull(),
  callerName: varchar("caller_name"),
  
  // Call lifecycle
  status: callStatusEnum("status").default("initiated"),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  duration: integer("duration"), // seconds
  
  // Call outcome
  transferredToHuman: boolean("transferred_to_human").default(false),
  humanAgentNumber: varchar("human_agent_number"),
  
  // Comprehensive Twilio status tracking (NEW)
  answeredBy: varchar("answered_by"), // human, machine, fax, unknown (from Twilio AMD)
  machineDetectionDuration: integer("machine_detection_duration"), // AMD duration in ms
  callDisposition: varchar("call_disposition"), // voicemail, wrong_number, out_of_service, line_disconnected, etc.
  isVoicemail: boolean("is_voicemail").default(false), // Quick flag for voicemail filtering
  twilioStatus: varchar("twilio_status"), // Raw Twilio status: completed, busy, no-answer, canceled, failed
  twilioErrorCode: varchar("twilio_error_code"), // Twilio error code if call failed
  
  // Twilio Insights - Connection Info (from Voice Insights API)
  fromConnectionType: varchar("from_connection_type"), // mobile, voip, landline
  fromCountry: varchar("from_country"), // US, MX, etc.
  fromCarrier: varchar("from_carrier"), // T-Mobile USA Inc., etc.
  toConnectionType: varchar("to_connection_type"), // mobile, voip, landline
  toCountry: varchar("to_country"),
  toCarrier: varchar("to_carrier"),
  
  // Twilio Insights - Call Properties
  whoHungUp: varchar("who_hung_up"), // caller, callee
  postDialDelayMs: integer("post_dial_delay_ms"), // Post-dial delay in milliseconds
  lastSipResponse: varchar("last_sip_response"), // 200 OK, 486 Busy, etc.
  callState: varchar("call_state"), // completed, busy, no-answer, etc.
  
  // Twilio Insights - Quality Metrics
  twilioRtpLatencyInbound: integer("twilio_rtp_latency_inbound"), // RTP latency inbound (ms)
  twilioRtpLatencyOutbound: integer("twilio_rtp_latency_outbound"), // RTP latency outbound (ms)
  codec: varchar("codec"), // pcmu, opus, etc.
  packetLossDetected: boolean("packet_loss_detected"),
  jitterDetected: boolean("jitter_detected"),
  highPostDialDelay: boolean("high_post_dial_delay"),
  edgeLocation: varchar("edge_location"), // Ashburn (us1), etc.
  
  // Twilio Insights - STIR/SHAKEN
  stirShakenStatus: varchar("stir_shaken_status"), // verified, partial, failed, unknown
  stirShakenAttestation: varchar("stir_shaken_attestation"), // A, B, C
  
  // Twilio Insights - Conference
  conferenceSid: varchar("conference_sid"), // CF... SID if call used conference
  
  // Twilio Insights - Fetched timestamp
  twilioInsightsFetchedAt: timestamp("twilio_insights_fetched_at"),
  
  // Conversation data
  transcript: text("transcript"),
  summary: text("summary"),
  detectedConditions: jsonb("detected_conditions"), // For medical triage
  
  // Recording
  recordingUrl: varchar("recording_url"),
  
  // Cost tracking (stored in cents for precision)
  twilioCostCents: integer("twilio_cost_cents"), // Twilio call cost in cents
  openaiCostCents: integer("openai_cost_cents"), // OpenAI API cost in cents
  totalCostCents: integer("total_cost_cents"), // Total cost in cents
  audioInputMinutes: integer("audio_input_minutes"), // OpenAI audio input duration (tenths of minutes for precision)
  audioOutputMinutes: integer("audio_output_minutes"), // OpenAI audio output duration (tenths of minutes)
  costCalculatedAt: timestamp("cost_calculated_at"), // When costs were last calculated
  
  // OpenAI token tracking for accurate cost calculation
  inputAudioTokens: integer("input_audio_tokens"), // Audio input tokens (caller speech)
  outputAudioTokens: integer("output_audio_tokens"), // Audio output tokens (agent speech)
  inputTextTokens: integer("input_text_tokens"), // Text input tokens (system prompt, tools)
  outputTextTokens: integer("output_text_tokens"), // Text output tokens (agent text responses)
  inputCachedTokens: integer("input_cached_tokens"), // Cached tokens (discounted rate)
  costIsEstimated: boolean("cost_is_estimated").default(true), // True until reconciled with OpenAI daily data
  costReconciledAt: timestamp("cost_reconciled_at"), // When costs were verified against OpenAI billing
  
  // Realtime turn telemetry (populated from response.done events during session)
  totalTurns: integer("total_turns"), // Number of response.done events (agent turns)
  interruptionCount: integer("interruption_count"), // Times caller interrupted agent
  truncationCount: integer("truncation_count"), // Times response was truncated
  firstTranscriptDelayMs: integer("first_transcript_delay_ms"), // Ms from session start to first caller transcript
  postTranscriptTailMs: integer("post_transcript_tail_ms"), // Ms from last transcript to session end
  inputCachedAudioTokens: integer("input_cached_audio_tokens"), // Cached audio input tokens
  inputCachedTextTokens: integer("input_cached_text_tokens"), // Cached text input tokens
  toolCallCount: integer("tool_call_count"), // Number of tool calls made during session
  telemetrySource: varchar("telemetry_source"), // 'realtime_events' or 'duration_estimate'
  durationMismatchRatio: real("duration_mismatch_ratio"), // Ratio of local vs Twilio duration (>0.35 = flagged)
  durationMismatchFlag: boolean("duration_mismatch_flag").default(false), // True when mismatch exceeds threshold
  localDurationSeconds: integer("local_duration_seconds"), // Duration from local session tracking
  transcriptWindowSeconds: integer("transcript_window_seconds"), // Duration from first to last transcript line

  // AI Quality grading
  sentiment: callSentimentEnum("sentiment"), // Patient sentiment: satisfied, neutral, frustrated, irate
  agentOutcome: agentOutcomeEnum("agent_outcome"), // Call outcome: resolved, escalated, follow_up_needed
  qualityScore: integer("quality_score"), // 1-5 star rating
  qualityAnalysis: jsonb("quality_analysis"), // Full AI analysis { strengths, improvements, keyMoments, patientConcerns }
  graderResults: jsonb("grader_results"), // Deterministic grader pass/fail results
  graderVersion: integer("grader_version"), // Version of grader applied (for idempotent re-runs)
  gradedAt: timestamp("graded_at"), // When quality was graded
  
  // Ticketing system sync tracking
  ticketNumber: varchar("ticket_number"), // External ticketing system ticket number (e.g., VA-1764200415200-229)
  ticketCreationPending: timestamp("ticket_creation_pending"), // Atomic lock to prevent duplicate ticket creation
  ticketingSynced: boolean("ticketing_synced").default(false), // Whether call data has been synced to ticketing system
  ticketingSyncedAt: timestamp("ticketing_synced_at"), // When the sync was completed
  ticketingSyncError: text("ticketing_sync_error"), // Last sync error message if failed
  ticketingSyncRetries: integer("ticketing_sync_retries").default(0), // Number of sync attempts made
  
  // Environment tracking - identifies which server processed the call
  environment: varchar("environment"), // 'development' or 'production' based on DOMAIN
  agentUsed: varchar("agent_used"), // Actual agent slug used (e.g., 'no-ivr', 'greeter') even if agentId is null
  agentVersion: varchar("agent_version"), // Version string of the agent that handled this call (e.g., 'v1.3.3')
  
  // Patient context from schedule lookup (populated when patient is found in system)
  dialedNumber: varchar("dialed_number"), // The number the caller dialed (indicates which office)
  patientName: varchar("patient_name"), // Patient name from schedule lookup
  patientDob: varchar("patient_dob"), // Patient DOB collected during call
  lastLocationSeen: varchar("last_location_seen"), // Patient's last office location (from most recent appointment)
  lastProviderSeen: varchar("last_provider_seen"), // Patient's last provider (from most recent appointment)
  patientFound: boolean("patient_found").default(false), // Whether patient was found in schedule system
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_call_logs_agent").on(table.agentId),
  index("idx_call_logs_campaign").on(table.campaignId),
  index("idx_call_logs_contact").on(table.contactId),
  index("idx_call_logs_created").on(table.createdAt),
  index("idx_call_logs_voicemail").on(table.isVoicemail),
]);

export type CallLog = typeof callLogs.$inferSelect;
export type InsertCallLog = typeof callLogs.$inferInsert;

// SMS logs table
export const smsLogs = pgTable("sms_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  messageSid: varchar("message_sid").unique(), // Twilio message SID
  
  // SMS details
  agentId: varchar("agent_id").references(() => agents.id),
  campaignId: varchar("campaign_id").references(() => campaigns.id),
  direction: varchar("direction").notNull(), // "inbound", "outbound"
  
  // Participants
  from: varchar("from").notNull(),
  to: varchar("to").notNull(),
  
  // Message
  body: text("body").notNull(),
  status: varchar("status").default("sent"), // sent, delivered, failed
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_sms_logs_campaign").on(table.campaignId),
  index("idx_sms_logs_created").on(table.createdAt),
]);

export type SmsLog = typeof smsLogs.$inferSelect;
export type InsertSmsLog = typeof smsLogs.$inferInsert;

// Callback queue status enum
export const callbackStatusEnum = pgEnum('callback_status', [
  'pending',
  'assigned',
  'completed',
  'cancelled'
]);

// Callback queue table
export const callbackQueue = pgTable("callback_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Patient information
  patientName: varchar("patient_name"),
  patientPhone: varchar("patient_phone").notNull(),
  patientDob: varchar("patient_dob"),
  patientEmail: varchar("patient_email"),
  
  // Callback details
  reason: text("reason").notNull(),
  priority: varchar("priority").default("normal"), // "stat", "urgent", "normal"
  notes: text("notes"),
  
  // Assignment
  assignedTo: varchar("assigned_to").references(() => users.id),
  assignedAt: timestamp("assigned_at"),
  status: callbackStatusEnum("status").default("pending"),
  completedAt: timestamp("completed_at"),
  
  // Related call
  callLogId: varchar("call_log_id").references(() => callLogs.id),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_callback_queue_status").on(table.status),
  index("idx_callback_queue_priority").on(table.priority),
  index("idx_callback_queue_created").on(table.createdAt),
]);

export type CallbackQueueItem = typeof callbackQueue.$inferSelect;
export type InsertCallbackQueueItem = typeof callbackQueue.$inferInsert;

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  createdAgents: many(agents),
  createdCampaigns: many(campaigns),
  assignedCallbacks: many(callbackQueue),
  sentInvitations: many(userInvitations),
  passwordResetTokens: many(passwordResetTokens),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  creator: one(users, {
    fields: [agents.createdBy],
    references: [users.id],
  }),
  tools: many(agentTools),
  campaigns: many(campaigns),
  callLogs: many(callLogs),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  agent: one(agents, {
    fields: [campaigns.agentId],
    references: [agents.id],
  }),
  creator: one(users, {
    fields: [campaigns.createdBy],
    references: [users.id],
  }),
  contacts: many(campaignContacts),
  callLogs: many(callLogs),
}));

export const callLogsRelations = relations(callLogs, ({ one, many }) => ({
  agent: one(agents, {
    fields: [callLogs.agentId],
    references: [agents.id],
  }),
  campaign: one(campaigns, {
    fields: [callLogs.campaignId],
    references: [campaigns.id],
  }),
  callbacks: many(callbackQueue),
}));

export const callbackQueueRelations = relations(callbackQueue, ({ one }) => ({
  assignedUser: one(users, {
    fields: [callbackQueue.assignedTo],
    references: [users.id],
  }),
  callLog: one(callLogs, {
    fields: [callbackQueue.callLogId],
    references: [callLogs.id],
  }),
}));

// Department enum for answering service
export const departmentEnum = pgEnum('department', ['optical', 'surgery_coordinator', 'clinical_tech']);

// Answering service routing logs
export const answeringServiceLogs = pgTable("answering_service_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callLogId: varchar("call_log_id").references(() => callLogs.id),
  
  // Routing decision
  department: departmentEnum("department").notNull(),
  routingReason: text("routing_reason"),
  action: varchar("action").notNull(), // "transferred", "message_taken", "callback_created", "ticket_created"
  
  // Details
  staffMemberContacted: varchar("staff_member_contacted"),
  messageDetails: text("message_details"),
  ticketId: varchar("ticket_id"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_answering_service_call").on(table.callLogId),
  index("idx_answering_service_dept").on(table.department),
]);

export type AnsweringServiceLog = typeof answeringServiceLogs.$inferSelect;
export type InsertAnsweringServiceLog = typeof answeringServiceLogs.$inferInsert;

// Support tickets table
export const supportTickets = pgTable("support_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Ticket details
  ticketNumber: varchar("ticket_number").unique().notNull(), // Auto-generated: TICK-YYYYMMDD-XXXX or external format
  patientName: varchar("patient_name").notNull(),
  contactInfo: varchar("contact_info").notNull(),
  department: departmentEnum("department").notNull(),
  
  // Issue details
  issueSummary: varchar("issue_summary").notNull(),
  issueDetails: text("issue_details").notNull(),
  priority: varchar("priority").default("medium"), // low, medium, high
  
  // Status tracking
  status: varchar("status").default("open"), // open, in_progress, resolved, closed
  assignedTo: varchar("assigned_to").references(() => users.id),
  assignedAt: timestamp("assigned_at"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"), // Notes about how ticket was resolved
  
  // External integration (for ticketing system API)
  externalTicketId: varchar("external_ticket_id").unique(), // ID from external ticketing system
  externalTicketNumber: varchar("external_ticket_number"), // Human-readable ticket number from external system
  externalTicketUrl: varchar("external_ticket_url"),
  
  // Patient details (for callback campaigns)
  patientPhone: varchar("patient_phone"), // Primary phone for callbacks
  patientEmail: varchar("patient_email"),
  preferredContactMethod: varchar("preferred_contact_method"), // "phone", "email", "sms"
  
  // Related records
  callLogId: varchar("call_log_id").references(() => callLogs.id),
  campaignId: varchar("campaign_id").references(() => campaigns.id), // Link to resolution callback campaign
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_support_tickets_status").on(table.status),
  index("idx_support_tickets_dept").on(table.department),
  index("idx_support_tickets_created").on(table.createdAt),
  index("idx_support_tickets_external").on(table.externalTicketId),
]);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type InsertSupportTicket = typeof supportTickets.$inferInsert;

export const answeringServiceLogsRelations = relations(answeringServiceLogs, ({ one }) => ({
  callLog: one(callLogs, {
    fields: [answeringServiceLogs.callLogId],
    references: [callLogs.id],
  }),
}));

export const supportTicketsRelations = relations(supportTickets, ({ one }) => ({
  assignedUser: one(users, {
    fields: [supportTickets.assignedTo],
    references: [users.id],
  }),
  callLog: one(callLogs, {
    fields: [supportTickets.callLogId],
    references: [callLogs.id],
  }),
  resolutionCampaign: one(campaigns, {
    fields: [supportTickets.campaignId],
    references: [campaigns.id],
  }),
}));

// Scheduling workflow status enum
export const schedulingWorkflowStatusEnum = pgEnum('scheduling_workflow_status', [
  'initiated',
  'collecting_data',
  'form_filling',
  'otp_requested',
  'otp_verified',
  'submitting',
  'completed',
  'failed',
  'cancelled'
]);

// Scheduling workflows table (for Phreesia form automation)
export const schedulingWorkflows = pgTable("scheduling_workflows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Linked records
  callLogId: varchar("call_log_id").references(() => callLogs.id),
  campaignId: varchar("campaign_id").references(() => campaigns.id),
  contactId: varchar("contact_id").references(() => campaignContacts.id),
  agentId: varchar("agent_id").references(() => agents.id),
  
  // Workflow status
  status: schedulingWorkflowStatusEnum("status").default("initiated"),
  
  // Patient data collected from voice call
  patientData: jsonb("patient_data"), // { firstName, lastName, dob, address, insurance, etc. }
  
  // Form filling progress
  currentStep: varchar("current_step"), // "patient_type", "location", "calendar", "patient_info", "otp", "confirmation"
  selectedLocation: varchar("selected_location"),
  selectedProvider: varchar("selected_provider"),
  selectedDateTime: timestamp("selected_date_time"),
  
  // OTP verification
  otpRequested: boolean("otp_requested").default(false),
  otpRequestedAt: timestamp("otp_requested_at"),
  otpAttempts: integer("otp_attempts").default(0),
  otpVerified: boolean("otp_verified").default(false),
  otpVerifiedAt: timestamp("otp_verified_at"),
  otpFailureReason: varchar("otp_failure_reason"),
  
  // Form submission result
  phreesiaConfirmationNumber: varchar("phreesia_confirmation_number"),
  phreesiaAppointmentDetails: jsonb("phreesia_appointment_details"), // Appointment date, time, location
  submissionSuccessful: boolean("submission_successful").default(false),
  
  // Error handling
  errorDetails: jsonb("error_details"), // Store error messages, stack traces
  fallbackLinkSent: boolean("fallback_link_sent").default(false), // Did we send manual appointment link?
  
  // Audit trail (screenshots for operator visibility)
  screenshots: jsonb("screenshots"), // Array of { step: string, timestamp: string, base64: string }
  
  // Operator intervention
  manualOverrideEnabled: boolean("manual_override_enabled").default(false),
  operatorId: varchar("operator_id").references(() => users.id), // Who intervened
  operatorNotes: text("operator_notes"),
  operatorInterventionAt: timestamp("operator_intervention_at"), // When operator took control
  
  // Timestamps
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_scheduling_workflows_call").on(table.callLogId),
  index("idx_scheduling_workflows_campaign").on(table.campaignId),
  index("idx_scheduling_workflows_status").on(table.status),
  index("idx_scheduling_workflows_created").on(table.createdAt),
]);

export type SchedulingWorkflow = typeof schedulingWorkflows.$inferSelect;
export type InsertSchedulingWorkflow = typeof schedulingWorkflows.$inferInsert;

export const schedulingWorkflowsRelations = relations(schedulingWorkflows, ({ one }) => ({
  callLog: one(callLogs, {
    fields: [schedulingWorkflows.callLogId],
    references: [callLogs.id],
  }),
  campaign: one(campaigns, {
    fields: [schedulingWorkflows.campaignId],
    references: [campaigns.id],
  }),
  contact: one(campaignContacts, {
    fields: [schedulingWorkflows.contactId],
    references: [campaignContacts.id],
  }),
  agent: one(agents, {
    fields: [schedulingWorkflows.agentId],
    references: [agents.id],
  }),
  operator: one(users, {
    fields: [schedulingWorkflows.operatorId],
    references: [users.id],
  }),
}));

// Agent prompts table for editable system prompts
export const agentPrompts = pgTable("agent_prompts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentSlug: varchar("agent_slug").notNull().unique(), // matches agents.slug
  
  // Editable sections of the prompt
  greeting: text("greeting"), // Custom greeting override
  personality: text("personality"), // Personality/style instructions
  customInstructions: text("custom_instructions"), // Additional instructions
  closingScript: text("closing_script"), // How to end calls
  
  // Version control
  version: integer("version").default(1),
  publishedAt: timestamp("published_at"),
  publishedBy: varchar("published_by").references(() => users.id),
  
  // Metadata
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_agent_prompts_slug").on(table.agentSlug),
]);

export type AgentPrompt = typeof agentPrompts.$inferSelect;
export type InsertAgentPrompt = typeof agentPrompts.$inferInsert;

// Agent prompt versions for audit trail
export const agentPromptVersions = pgTable("agent_prompt_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentSlug: varchar("agent_slug").notNull(),
  version: integer("version").notNull(),
  
  // Snapshot of prompts at this version
  greeting: text("greeting"),
  personality: text("personality"),
  customInstructions: text("custom_instructions"),
  closingScript: text("closing_script"),
  
  // Metadata
  createdBy: varchar("created_by").references(() => users.id),
  changeNotes: text("change_notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_agent_prompt_versions_slug").on(table.agentSlug),
  index("idx_agent_prompt_versions_version").on(table.version),
]);

export type AgentPromptVersion = typeof agentPromptVersions.$inferSelect;
export type InsertAgentPromptVersion = typeof agentPromptVersions.$inferInsert;

// Active call sessions - replaces volatile in-memory state
// This table stores all call/conference mappings durably to survive server restarts
export const activeCallSessions = pgTable("active_call_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Core identifiers
  conferenceName: varchar("conference_name").notNull().unique(), // Primary key for lookups (e.g., "conf_CA...")
  twilioCallSid: varchar("twilio_call_sid"), // Twilio's call SID (CA...)
  openaiCallId: varchar("openai_call_id"), // OpenAI's call ID (rtc_u2_...)
  conferenceSid: varchar("conference_sid"), // Twilio conference SID
  callLogId: varchar("call_log_id").references(() => callLogs.id), // Link to our call log record
  
  // Call context
  callerNumber: varchar("caller_number"), // From/caller number
  calledNumber: varchar("called_number"), // To/dialed number  
  callToken: varchar("call_token"), // Token for the call
  agentSlug: varchar("agent_slug"), // Which agent is handling this call
  
  // Session state
  state: varchar("state").default("initializing"), // initializing, connected, transferring, completed, failed
  openaiSessionEstablished: boolean("openai_session_established").default(false),
  humanTransferInitiated: boolean("human_transfer_initiated").default(false),
  
  // Error tracking
  lastError: text("last_error"),
  retryCount: integer("retry_count").default(0),
  
  // Timestamps for TTL cleanup
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  expiresAt: timestamp("expires_at"), // For automatic cleanup of stale sessions
}, (table) => [
  index("idx_active_call_sessions_twilio_sid").on(table.twilioCallSid),
  index("idx_active_call_sessions_openai_id").on(table.openaiCallId),
  index("idx_active_call_sessions_conference_sid").on(table.conferenceSid),
  index("idx_active_call_sessions_call_log").on(table.callLogId),
  index("idx_active_call_sessions_expires").on(table.expiresAt),
  index("idx_active_call_sessions_state").on(table.state),
]);

export type ActiveCallSession = typeof activeCallSessions.$inferSelect;
export type InsertActiveCallSession = typeof activeCallSessions.$inferInsert;

// Relations for new tables
export const userInvitationsRelations = relations(userInvitations, ({ one }) => ({
  inviter: one(users, {
    fields: [userInvitations.invitedBy],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}));

export const agentPromptsRelations = relations(agentPrompts, ({ one }) => ({
  publisher: one(users, {
    fields: [agentPrompts.publishedBy],
    references: [users.id],
  }),
}));

export const agentPromptVersionsRelations = relations(agentPromptVersions, ({ one }) => ({
  creator: one(users, {
    fields: [agentPromptVersions.createdBy],
    references: [users.id],
  }),
}));

// Distributed locks table - for multi-instance coordination
export const distributedLocks = pgTable("distributed_locks", {
  lockName: varchar("lock_name").primaryKey(),
  holderId: varchar("holder_id").notNull(),
  acquiredAt: timestamp("acquired_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  index("idx_distributed_locks_expires").on(table.expiresAt),
  index("idx_distributed_locks_holder").on(table.holderId),
]);

export type DistributedLock = typeof distributedLocks.$inferSelect;
export type InsertDistributedLock = typeof distributedLocks.$inferInsert;

// Schedule table - synced from external scheduling system (Supabase production)
// Note: This table is managed externally (Supabase foreign data wrapper to on-prem view)
// We only read from it - clean data with normalized locations and times
export const schedule = pgTable("Schedule", {
  // Appointment date and times (clean format)
  appointmentDate: date("AppointmentDate").notNull(),
  appointmentStart: text("AppointmentStart"), // 24hr format e.g. "1550" for 3:50 PM
  appointmentEnd: text("AppointmentEnd"), // 24hr format e.g. "1600" for 4:00 PM
  sessionPartOfDay: text("SessionPartOfDay"),
  entryDateTime: timestamp("EntryDateTime"),
  dateType: text("DateType"),
  daysToDate: integer("DaysToDate"),
  
  // Appointment status
  appointmentStatus: text("AppointmentStatus"),
  confirmInd: text("ConfirmInd"), // "Y" or "N" (varchar, not boolean)
  
  // Patient identifiers
  patientPartialKey: text("PatientPartialKey"),
  patientPartialKey5Version: text("PatientPartialKey_5Version"),
  patientVisitKey: text("PatientVisitKey"),
  
  // Patient demographics
  patientLastName: text("PatientLastName"),
  patientFirstName: text("PatientFirstName"),
  patientDateOfBirth: date("PatientDateOfBirth"),
  patientEmailAddress: text("PatientEmailAddress"),
  patientCellPhone: text("PatientCellPhone"),
  patientHomePhone: text("PatientHomePhone"),
  patientAddressLine1: text("PatientAddressLine1"),
  patientAddressLine2: text("PatientAddressLine2"),
  patientCity: text("PatientCity"),
  patientCounty: text("PatientCounty"),
  patientState: text("PatientState"),
  patientZip: text("PatientZip"),
  patientLanguage: text("PatientLanguage"),
  
  // Office/Location information (clean - no "Azul Vision" or "Atlantis Eyecare" prefixes)
  officeLocation: text("OfficeLocation"),
  officeLocationEntity: text("OfficeLocationEntity"),
  officeLocationType: text("OfficeLocationType"),
  regionalManager: text("RegionalManager"),
  officeManager: text("OfficeManager"),
  
  // Provider information (clean names like "Jay Patel, MD")
  renderingPhysician: text("RenderingPhysician"),
  doctorType: text("DoctorType"),
  resourceType: text("ResourceType"),
  resourceClinicSessionVolumeCommittment: integer("ResourceClinicSessionVolumeCommittment"),
  
  // Service categories
  serviceCategory1: text("ServiceCategory1"),
  serviceCategory2: text("ServiceCategory2"),
  serviceCategory3: text("ServiceCategory3"),
  lineOfBusiness: text("LineOfBusiness"),
  
  // Payer information
  primaryPayer: text("PrimaryPayer"),
  secondaryPayer: text("SecondaryPayer"),
  visionPayer: text("VisionPayer"),
  hasAnyCapIns: text("HasAnyCapIns"),
  hasMedicare: text("HasMedicare"),
  isOptum: text("IsOptum"),
  payerDemo1: text("PayerDemo1"),
  payerDemo2: text("PayerDemo2"),
  payerDemo3: text("PayerDemo3"),
  
  // Template/Resource sourcing
  resourceFromTemplate: text("ResourceFromTemplate"),
});

export type Schedule = typeof schedule.$inferSelect;
export type InsertSchedule = typeof schedule.$inferInsert;

// Daily OpenAI costs table - stores reconciled daily totals from OpenAI Usage API
// Used for accurate cost tracking without real-time API calls (which timeout/504)
export const dailyOpenaiCosts = pgTable("daily_openai_costs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  date: date("date").notNull().unique(), // The date these costs are for (YYYY-MM-DD)
  
  // OpenAI Usage API data (actual costs from billing)
  actualCostCents: integer("actual_cost_cents").notNull(), // Actual cost from OpenAI
  
  // Our estimated costs (sum of individual call estimates for this day)
  estimatedCostCents: integer("estimated_cost_cents"), // What we calculated per-call
  
  // Breakdown by model type (from OpenAI Usage API)
  realtimeCostCents: integer("realtime_cost_cents"), // Realtime API costs (voice agents)
  otherCostCents: integer("other_cost_cents"), // Other OpenAI costs (transcription, etc.)
  
  // Reconciliation metadata
  discrepancyCents: integer("discrepancy_cents"), // actualCostCents - estimatedCostCents
  discrepancyPercent: numeric("discrepancy_percent", { precision: 5, scale: 2 }),
  
  // Tracking
  reconciledAt: timestamp("reconciled_at").notNull().defaultNow(),
  reconciledBy: varchar("reconciled_by"), // 'auto' for scheduled job, user ID for manual
  rawApiResponse: jsonb("raw_api_response"), // Store raw response for debugging
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("daily_openai_costs_date_idx").on(table.date),
]);

export type DailyOpenaiCost = typeof dailyOpenaiCosts.$inferSelect;
export type InsertDailyOpenaiCost = typeof dailyOpenaiCosts.$inferInsert;

export const dailyOrgUsage = pgTable("daily_org_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dateUtc: date("date_utc").notNull(),
  projectId: varchar("project_id"),
  model: varchar("model").notNull(),
  apiKeyId: varchar("api_key_id"),
  serviceTier: varchar("service_tier"),
  numModelRequests: integer("num_model_requests").default(0),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  inputCachedTokens: integer("input_cached_tokens").default(0),
  inputTextTokens: integer("input_text_tokens").default(0),
  outputTextTokens: integer("output_text_tokens").default(0),
  inputCachedTextTokens: integer("input_cached_text_tokens").default(0),
  inputAudioTokens: integer("input_audio_tokens").default(0),
  inputCachedAudioTokens: integer("input_cached_audio_tokens").default(0),
  outputAudioTokens: integer("output_audio_tokens").default(0),
  estimatedCostCents: integer("estimated_cost_cents"),
  source: varchar("source").default('api'),
  createdAt: timestamp("created_at").defaultNow(),
  processedVersion: integer("processed_version").notNull().default(1),
  processedAt: timestamp("processed_at").defaultNow(),
}, (table) => [
  index("idx_daily_org_usage_date").on(table.dateUtc),
  index("idx_daily_org_usage_model").on(table.model),
  index("idx_daily_org_usage_date_model").on(table.dateUtc, table.model),
]);

export type DailyOrgUsage = typeof dailyOrgUsage.$inferSelect;
export type InsertDailyOrgUsage = typeof dailyOrgUsage.$inferInsert;

export const dailyReconciliation = pgTable("daily_reconciliation", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dateUtc: date("date_utc").notNull().unique(),
  estimatedUsd: numeric("estimated_usd", { precision: 10, scale: 4 }),
  actualUsd: numeric("actual_usd", { precision: 10, scale: 4 }),
  deltaUsd: numeric("delta_usd", { precision: 10, scale: 4 }),
  deltaPercent: numeric("delta_percent", { precision: 7, scale: 2 }),
  perCallSumCents: integer("per_call_sum_cents"),
  orgBilledCents: integer("org_billed_cents"),
  unallocatedCents: integer("unallocated_cents"),
  modelBreakdown: jsonb("model_breakdown"),
  source: varchar("source").default('auto'),
  reconciledAt: timestamp("reconciled_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  processedVersion: integer("processed_version").notNull().default(1),
  processedAt: timestamp("processed_at").defaultNow(),
}, (table) => [
  index("idx_daily_reconciliation_date").on(table.dateUtc),
]);

export type DailyReconciliation = typeof dailyReconciliation.$inferSelect;
export type InsertDailyReconciliation = typeof dailyReconciliation.$inferInsert;

export const handoffStateEnum = pgEnum("handoff_state", [
  "requested",
  "dialing",
  "initiated",
  "ringing",
  "answered",
  "voicemail",
  "failed",
  "blocked_policy",
  "completed",
  "timeout",
]);

export const HANDOFF_TERMINAL_STATES = ['answered', 'voicemail', 'failed', 'blocked_policy', 'completed', 'timeout'] as const;

export const HANDOFF_VALID_TRANSITIONS: Record<string, string[]> = {
  requested: ['dialing', 'blocked_policy', 'failed'],
  dialing: ['initiated', 'failed'],
  initiated: ['ringing', 'answered', 'failed', 'timeout', 'completed'],
  ringing: ['answered', 'failed', 'timeout', 'completed', 'voicemail'],
  answered: ['completed'],
  voicemail: [],
  failed: [],
  blocked_policy: [],
  completed: [],
  timeout: [],
};

export const handoffStates = pgTable("handoff_states", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanCallSid: varchar("human_call_sid").notNull().unique(),
  openaiCallId: varchar("openai_call_id").notNull(),
  conferenceName: varchar("conference_name").notNull(),
  callLogId: varchar("call_log_id").references(() => callLogs.id),
  calledNumber: varchar("called_number"),
  humanAgentNumber: varchar("human_agent_number"),
  state: handoffStateEnum("state").notNull().default("initiated"),
  answeredBy: varchar("answered_by"),
  duration: integer("duration"),
  failureReason: varchar("failure_reason"),
  handoffRequestedAt: timestamp("handoff_requested_at"),
  handoffDialedAt: timestamp("handoff_dialed_at"),
  handoffAnsweredAt: timestamp("handoff_answered_at"),
  handoffCompletedAt: timestamp("handoff_completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("idx_handoff_states_openai_call").on(table.openaiCallId),
  index("idx_handoff_states_conference").on(table.conferenceName),
  index("idx_handoff_states_state").on(table.state),
  index("idx_handoff_states_created").on(table.createdAt),
  index("idx_handoff_states_call_log").on(table.callLogId),
]);

export type HandoffState = typeof handoffStates.$inferSelect;
export type InsertHandoffState = typeof handoffStates.$inferInsert;

export const promptVersionStatusEnum = pgEnum("prompt_version_status", [
  "draft",
  "active", 
  "rolled_back",
  "archived",
]);

export const promptVersions = pgTable("prompt_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentSlug: varchar("agent_slug", { length: 100 }).notNull(),
  version: integer("version").notNull(),
  promptContent: text("prompt_content").notNull(),
  status: promptVersionStatusEnum("status").notNull().default("draft"),
  promotedBy: varchar("promoted_by", { length: 255 }),
  promotionReason: text("promotion_reason"),
  evalRunId: varchar("eval_run_id", { length: 255 }),
  rolledBackBy: varchar("rolled_back_by", { length: 255 }),
  rolledBackAt: timestamp("rolled_back_at"),
  rollbackReason: text("rollback_reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_prompt_versions_agent").on(table.agentSlug),
  index("idx_prompt_versions_status").on(table.status),
  uniqueIndex("uq_prompt_versions_agent_version").on(table.agentSlug, table.version),
]);

export type PromptVersion = typeof promptVersions.$inferSelect;
export type InsertPromptVersion = typeof promptVersions.$inferInsert;

export const webhookEventStatusEnum = pgEnum("webhook_event_status", [
  "received",
  "processing",
  "completed",
  "failed",
  "dead_letter",
]);

export const webhookEvents = pgTable("webhook_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: varchar("source", { length: 50 }).notNull(),
  eventType: varchar("event_type", { length: 100 }),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  payload: jsonb("payload"),
  status: webhookEventStatusEnum("status").notNull().default("received"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_webhook_events_idempotency").on(table.idempotencyKey),
  index("idx_webhook_events_status").on(table.status),
  index("idx_webhook_events_source").on(table.source),
  index("idx_webhook_events_next_retry").on(table.nextRetryAt),
  uniqueIndex("uq_webhook_events_source_key").on(table.source, table.idempotencyKey),
]);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type InsertWebhookEvent = typeof webhookEvents.$inferInsert;

export const ticketOutboxStatusEnum = pgEnum("ticket_outbox_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "dead_letter",
]);

export const ticketOutbox = pgTable("ticket_outbox", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  callSid: varchar("call_sid"),
  callLogId: varchar("call_log_id"),
  idempotencyKey: varchar("idempotency_key").unique(),
  payload: jsonb("payload").notNull(),
  status: ticketOutboxStatusEnum("status").notNull().default("pending"),
  ticketNumber: varchar("ticket_number"),
  externalTicketId: integer("external_ticket_id"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
}, (table) => [
  index("idx_ticket_outbox_status").on(table.status),
  index("idx_ticket_outbox_next_retry").on(table.nextRetryAt),
  index("idx_ticket_outbox_call_sid").on(table.callSid),
  index("idx_ticket_outbox_idempotency").on(table.idempotencyKey),
]);

export type TicketOutboxEntry = typeof ticketOutbox.$inferSelect;
export type InsertTicketOutboxEntry = typeof ticketOutbox.$inferInsert;
