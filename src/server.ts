import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { InvalidWebhookSignatureError, APIError } from "openai/error";
import {
  OpenAIRealtimeSIP,
  RealtimeItem,
  RealtimeSession,
  type RealtimeSessionOptions,
} from '@openai/agents/realtime';
import twilio from "twilio";
import { agentRegistry } from './config/agents';
import { medicalSafetyGuardrails, WELCOME_GREETING } from './agents/afterHoursAgent';
import { storage } from "../server/storage";
import { validateEnv, VOICE_AGENT_REQUIRED } from './lib/env';
import { setupVoiceAgentRoutes } from './voiceAgentRoutes';
import { ticketingApiClient } from '../server/services/ticketingApiClient';
import { ticketingSyncService } from '../server/services/ticketingSyncService';
import { dailyOpenaiReconciliation } from './services/dailyOpenaiReconciliation';
import { startKeepAlive, stopKeepAlive, warmupDatabase } from '../server/services/databaseKeepAlive';
import { initializeCallSessionService, callSessionService } from './services/callSessionService';
import { getCircuitBreakerMetrics } from './services/resilienceUtils';
import { getEnvironmentConfig, validateProductionConfig } from './config/environment';

// CRITICAL: Global error handlers to prevent server crashes
// These catch unhandled errors that would otherwise kill the Node process
process.on('uncaughtException', (error: Error) => {
  console.error('[CRITICAL] Uncaught Exception - server staying alive:', error);
  // Log but don't exit - keep the server running
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('[CRITICAL] Unhandled Promise Rejection - server staying alive:', reason);
  // Log but don't exit - keep the server running
});

validateEnv(VOICE_AGENT_REQUIRED);

// Load and validate environment configuration
const envConfig = getEnvironmentConfig();
validateProductionConfig();

// Environment variables (from centralized config)
const DOMAIN = envConfig.domain;
const PORT = Number(process.env.VOICE_AGENT_PORT ?? 8000);
const OPENAI_API_KEY = envConfig.openai.apiKey;
const OPENAI_PROJECT_ID = envConfig.openai.projectId;
const WEBHOOK_SECRET = envConfig.openai.webhookSecret;
const TWILIO_ACCOUNT_SID = envConfig.twilio.accountSid;
const TWILIO_AUTH_TOKEN = envConfig.twilio.authToken;
const HUMAN_AGENT_NUMBER = envConfig.twilio.humanAgentNumber || process.env.HUMAN_AGENT_NUMBER!;

// ANSI color codes
const BRIGHT_GREEN = '\x1b[92m';
const BRIGHT_RED = '\x1b[91m';
const RESET = '\x1b[0m';

// Initialize clients
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Express
const app = express();
app.use(bodyParser.raw({ type: "*/*" }));

// Setup voice agent routes (Twilio webhooks, OpenAI webhooks, etc.)
setupVoiceAgentRoutes(app);

// Tracking active calls and conference mappings
const activeCallTasks = new Map<string, Promise<void>>();
const callIDtoConferenceNameMapping: Record<string, string | undefined> = {};
const ConferenceNametoCallerIDMapping: Record<string, string | undefined> = {};
const ConferenceNametoCalledNumberMapping: Record<string, string | undefined> = {};
const ConferenceNametoCallTokenMapping: Record<string, string | undefined> = {};
const callIdToDbCallLogId: Map<string, string> = new Map();
const conferenceSidToDbCallLogId: Map<string, string> = new Map();

// Store structured patient info from agent tool
const patientInfoMap = new Map<string, {
  name: string;
  phone: string;
  dob?: string;
  email?: string;
  reason: string;
  priority: string;
}>();

// NOTE: Session options are now defined in voiceAgentRoutes.ts with correct camelCase fields.
// The old snake_case input_audio_transcription was silently dropped by SDK 0.3.7.

// Log conversation history
function logHistoryItem(item: unknown): void {
  const msg = item as any;
  if (msg.type !== 'message') return;

  if (msg.role === 'user') {
    for (const content of msg.content) {
      if (content.type === 'input_text' && content.text) {
        console.log(`${BRIGHT_GREEN}[CALLER SPOKE] ${content.text}${RESET}`);
      } else if (content.type === 'input_audio' && content.transcript) {
        console.log(`${BRIGHT_GREEN}[CALLER SPOKE] ${content.transcript}${RESET}`);
      }
    }
  } else if (msg.role === 'assistant') {
    for (const content of msg.content) {
      if (content.type === 'output_text' && content.text) {
        console.log(`${BRIGHT_GREEN}[AGENT SPOKE] ${content.text}${RESET}`);
      } else if (content.type === 'output_audio' && content.transcript) {
        console.log(`${BRIGHT_GREEN}[AGENT SPOKE] ${content.transcript}${RESET}`);
      }
    }
  }
}

// Handle human agent handoff
async function addHumanAgent(openAiCallId: string): Promise<void> {
  const conferenceName = callIDtoConferenceNameMapping[openAiCallId];
  if (!conferenceName) {
    console.error('[HANDOFF] ✗ Conference name not found for call ID:', openAiCallId);
    return;
  }

  if (!HUMAN_AGENT_NUMBER) {
    console.error('[HANDOFF] ✗ HUMAN_AGENT_NUMBER not configured');
    return;
  }

  console.log('\n========================================');
  console.log(`[HANDOFF] Transferring to human agent`);
  console.log(`   Conference: ${conferenceName}`);
  console.log(`   Human Number: ${HUMAN_AGENT_NUMBER}`);
  console.log('========================================\n');

  const callToken = ConferenceNametoCallTokenMapping[conferenceName];
  const callerID = ConferenceNametoCallerIDMapping[conferenceName];

  if (!callToken || !callerID) {
    console.error('[HANDOFF] ✗ Missing callToken or callerID');
    return;
  }

  try {
    const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
    await twilioClient.conferences(conferenceName).participants.create({
      from: twilioPhoneNumber || callerID,
      label: "human agent",
      to: HUMAN_AGENT_NUMBER,
      earlyMedia: false,
      callToken: callToken,
    });
    console.log('[HANDOFF] ✓ Human agent added to conference successfully\n');
    
    // Update database to mark human transfer
    const dbCallLogId = callIdToDbCallLogId.get(openAiCallId);
    if (dbCallLogId) {
      await storage.updateCallLog(dbCallLogId, {
        transferredToHuman: true,
        humanAgentNumber: HUMAN_AGENT_NUMBER,
        status: 'transferred',
      });
      console.log('[DATABASE] ✓ Updated call log with human transfer');
    }
  } catch (error) {
    console.error('[HANDOFF] ✗ Error adding human agent:', error);
  }
}

// NOTE: acceptCall has been moved to voiceAgentRoutes.ts
// This function was causing double greetings by creating afterHoursAgent before the intended agent

// Create callback for recording patient info with validation
function createRecordPatientInfoCallback(callId: string) {
  return async (patientInfo: any) => {
    // Validate tool payload before storing - reject incomplete submissions
    const name = patientInfo.patient_name?.trim();
    const phone = patientInfo.phone_number?.trim();
    const dob = patientInfo.date_of_birth?.trim();
    const email = patientInfo.email?.trim();
    const reason = patientInfo.reason?.trim();
    
    if (!name || !phone || !reason) {
      const missing = [];
      if (!name) missing.push('patient_name');
      if (!phone) missing.push('phone_number');
      if (!reason) missing.push('reason');
      console.warn(`[PATIENT INFO] ⚠️ Rejected incomplete payload - missing: ${missing.join(', ')}`);
      return { 
        success: false, 
        error: `Missing required fields: ${missing.join(', ')}. Please collect all patient information before calling this tool.` 
      };
    }
    
    // Use contact validation utility for format enforcement
    const { validatePhoneNumber, validateEmail, validateDateOfBirth, validateName } = await import('./utils/contactValidation');
    
    // Validate name
    const nameValidation = validateName(name, 'Patient name');
    if (!nameValidation.valid) {
      console.warn(`[PATIENT INFO] ⚠️ Rejected invalid name: ${nameValidation.error}`);
      return { 
        success: false, 
        error: nameValidation.error 
      };
    }
    
    // Validate phone number
    const phoneValidation = validatePhoneNumber(phone);
    if (!phoneValidation.valid) {
      console.warn(`[PATIENT INFO] ⚠️ Rejected invalid phone: ${phoneValidation.error}`);
      return { 
        success: false, 
        error: phoneValidation.error 
      };
    }
    
    // Validate date of birth if provided
    if (dob) {
      const dobValidation = validateDateOfBirth(dob);
      if (!dobValidation.valid) {
        console.warn(`[PATIENT INFO] ⚠️ Rejected invalid DOB: ${dobValidation.error}`);
        return { 
          success: false, 
          error: dobValidation.error 
        };
      }
    }
    
    // Validate email if provided
    if (email) {
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        console.warn(`[PATIENT INFO] ⚠️ Rejected invalid email: ${emailValidation.error}`);
        return { 
          success: false, 
          error: emailValidation.error 
        };
      }
    }
    
    // Store validated data
    patientInfoMap.set(callId, {
      name: nameValidation.sanitized!,
      phone: phoneValidation.sanitized!,
      dob: dob,
      email: email,
      reason,
      priority: patientInfo.priority || 'normal'
    });
    console.log('[PATIENT INFO] ✓ Recorded:', { name: nameValidation.sanitized, phone: phoneValidation.sanitized, dob, email, reason });
    return { success: true, message: "Patient information recorded successfully" };
  };
}

// NOTE: Old observeCall, /incoming-call, /recording-status, and /conference-events handlers
// have been removed. All call handling is now in voiceAgentRoutes.ts at /api/voice/* routes.

// All call handling routes are in voiceAgentRoutes.ts at /api/voice/* paths.
// Old broken handlers (/incoming-call, /conference-events, /recording-status) and dead observeCall() removed.

// NOTE: OpenAI webhook handling is now in voiceAgentRoutes.ts at /api/voice/realtime
// The duplicate root "/" handler has been removed to prevent double greetings and session conflicts

// Health check endpoints
app.get("/health", async (req: Request, res: Response) => {
  return res.status(200).send({ status: 'ok', agents: agentRegistry.getAllAgents().length });
});

// Standard health check for production monitoring
app.get("/healthz", async (req: Request, res: Response) => {
  try {
    // Import health metrics service (safe path from src -> server)
    const { getSystemHealthMetrics, checkDatabaseConnectivity } = await import('../server/services/healthMetrics');
    const { systemAlertService } = await import('../server/services/systemAlertService');
    
    // Check database connectivity
    const dbConnected = await checkDatabaseConnectivity();
    if (!dbConnected) {
      return res.status(503).json({
        status: 'unhealthy',
        server: 'voice-agent',
        error: 'database connection failed',
        timestamp: new Date().toISOString()
      });
    }
    
    // Get full system health metrics
    const health = getSystemHealthMetrics();
    const alertStatus = systemAlertService.getHealthStatus();
    
    return res.status(health.status === 'unhealthy' ? 503 : 200).json({ 
      ...health,
      server: 'voice-agent',
      port: PORT,
      agents: agentRegistry.getAllAgents().length,
      alerts: {
        systemHealthy: alertStatus.healthy,
        consecutiveFailures: alertStatus.consecutiveFailures,
        recentAlertCount: alertStatus.recentAlerts.length,
      },
    });
  } catch (error) {
    console.error('[HEALTHZ] Health check failed:', error);
    return res.status(503).json({ 
      status: 'unhealthy', 
      server: 'voice-agent',
      error: 'health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Shutdown handler
const shutdown = async () => {
  try {
    console.log('\n[SERVER] Shutting down gracefully...');
    // Stop background services
    ticketingSyncService.stop();
    stopKeepAlive();
    // Wait for active calls to complete (with timeout)
    await Promise.race([
      Promise.all(Array.from(activeCallTasks.values())),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  } catch (error) {
    console.error('[SERVER] Error during shutdown:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server with database warmup
async function startVoiceServer() {
  // Warm up database connection before starting server
  console.log("[STARTUP] Warming up database connection...");
  await warmupDatabase();
  
  // Start database keep-alive service
  startKeepAlive();
  
  // Initialize system alert service for downtime notifications
  const { systemAlertService } = await import('../server/services/systemAlertService');
  await systemAlertService.initialize();
  
  // Initialize call session service (load active sessions from DB)
  await initializeCallSessionService();
  
  // Build version for tracking deployments - update when making system changes
  const BUILD_VERSION = '2026.02.16a'; // Format: YYYY.MM.DDx where x is revision letter - GO-LIVE CHECKLIST: burn-rate, RBAC, secret validation, traffic ramp
  
  // ========== Startup Secret Validation ==========
  const secretChecks = [
    { name: 'TWILIO_ACCOUNT_SID', present: !!process.env.TWILIO_ACCOUNT_SID },
    { name: 'TWILIO_AUTH_TOKEN', present: !!process.env.TWILIO_AUTH_TOKEN },
    { name: 'TWILIO_PHONE_NUMBER', present: !!process.env.TWILIO_PHONE_NUMBER },
    { name: 'OPENAI_API_KEY', present: !!process.env.OPENAI_API_KEY },
    { name: 'DATABASE_URL', present: !!process.env.DATABASE_URL },
  ];
  const missingSecrets = secretChecks.filter(s => !s.present);
  const isProd = process.env.APP_ENV === 'production';
  
  console.log('\n[SECRET VALIDATION]');
  secretChecks.forEach(s => {
    console.log(`  ${s.present ? 'PASS' : 'FAIL'}: ${s.name} ${s.present ? 'loaded' : 'MISSING'}`);
  });
  
  if (missingSecrets.length > 0 && isProd) {
    console.error(`[SECRET VALIDATION] CRITICAL: ${missingSecrets.length} required secret(s) missing in production: ${missingSecrets.map(s => s.name).join(', ')}`);
  } else if (missingSecrets.length > 0) {
    console.warn(`[SECRET VALIDATION] WARNING: ${missingSecrets.length} secret(s) missing in development (expected for some): ${missingSecrets.map(s => s.name).join(', ')}`);
  } else {
    console.log('[SECRET VALIDATION] All required secrets loaded successfully');
  }
  
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n========================================`);
    console.log(`🚀 Azul Vision AI Operations Hub`);
    console.log(`   Build: ${BUILD_VERSION}`);
    console.log(`========================================`);
    console.log(`Server listening on port ${PORT}`);
    console.log(`Agents registered: ${agentRegistry.getAllAgents().length}`);
    
    // Log all agent versions for tracking which versions are active
    console.log(`\n[AGENT VERSIONS]`);
    agentRegistry.getAllAgents().forEach(agent => {
      const version = agent.version || 'unversioned';
      console.log(`  - ${agent.id}: ${version}`);
    });
    
    console.log(`\nMedical guardrails active: ${medicalSafetyGuardrails.length}`);
    console.log(`Database keep-alive: Active (4 min interval)`);
    console.log(`Ticketing sync: Background service enabled (5 min interval)`);
    console.log(`OpenAI cost reconciliation: Daily at 6:00 AM`);
    console.log(`System alerts: SMS notifications enabled`);
    console.log(`Secret validation: ${missingSecrets.length === 0 ? 'ALL PASS' : `${missingSecrets.length} MISSING`}`);
    console.log(`========================================\n`);
    
    // Start background ticketing sync service
    ticketingSyncService.start();
    
    // Start ticket outbox retry worker (ensures no ticket data is ever lost)
    import('./services/ticketOutboxService').then(({ TicketOutboxService }) => {
      TicketOutboxService.startWorker();
    }).catch(err => console.error('[STARTUP] Failed to start ticket outbox worker:', err));
    
    // Start daily OpenAI cost reconciliation scheduler
    dailyOpenaiReconciliation.startDailySchedule();
    
    // Start grader-based push alerting (checks every 15 min)
    systemAlertService.startGraderAlertSchedule();
    
    // Start data retention policy scheduler (purges expired data daily)
    import('./services/retentionPolicyService').then(({ retentionPolicyService }) => {
      retentionPolicyService.startSchedule();
    }).catch(err => console.error('[STARTUP] Failed to start retention scheduler:', err));
    
    // Start webhook retry worker (retries failed webhook events every 60s)
    import('./services/webhookRetryWorker').then(({ webhookRetryWorker }) => {
      webhookRetryWorker.start();
    }).catch(err => console.error('[STARTUP] Failed to start webhook retry worker:', err));
    
    // Start data quality SLO monitoring (checks every 60 min)
    import('./services/dataQualitySloService').then(({ dataQualitySloService }) => {
      dataQualitySloService.startMonitoring(60);
    }).catch(err => console.error('[STARTUP] Failed to start SLO monitoring:', err));
  });
}

startVoiceServer().catch((error) => {
  console.error("Failed to start voice server:", error);
  process.exit(1);
});
