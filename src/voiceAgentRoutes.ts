// Voice Agent Routes - Extracted from src/server.ts for modular integration
// Handles Twilio SIP integration and OpenAI Realtime API voice calls

process.on('unhandledRejection', (reason, promise) => {
  console.error('[PROCESS] Unhandled Promise rejection:', reason);
});

import { Express } from "express";
import OpenAI from "openai";
import { InvalidWebhookSignatureError, APIError } from "openai/error";
import { webhookRateLimiter } from './middleware/rateLimiter';
import { noCacheHeaders } from './middleware/cacheControl';
import {
  OpenAIRealtimeSIP,
  RealtimeAgent,
  RealtimeItem,
  RealtimeSession,
  type RealtimeSessionOptions,
} from '@openai/agents/realtime';
import { getTwilioClient, getTwilioFromPhoneNumber } from './lib/twilioClient';
import { medicalSafetyGuardrails, WELCOME_GREETING, getUrgentTriageGreeting } from './agents/afterHoursAgent';
import { callLifecycleCoordinator } from './services/callLifecycleCoordinator';
import { callSessionService } from './services/callSessionService';
import { withRetry, withResiliency, TICKETING_RETRY_CONFIG, TWILIO_RETRY_CONFIG, getCircuitBreaker } from './services/resilienceUtils';
import { getGreeterOpeningGreeting } from './utils/timeAware';
import { storage } from '../server/storage';
import { registerTicketingSyncRoutes } from './voiceAgent';
import { getEnvironmentConfig, getDomain, getWebhookBaseUrl } from './config/environment';
import { CallDiagnostics } from './services/callDiagnostics';

// Load centralized environment configuration
let envConfig: ReturnType<typeof getEnvironmentConfig>;
try {
  envConfig = getEnvironmentConfig();
} catch (e) {
  console.error('[ENV] Failed to load environment config, using fallback:', e);
  envConfig = {
    env: (process.env.APP_ENV as 'development' | 'production') || 'development',
    isDevelopment: process.env.APP_ENV !== 'production',
    isProduction: process.env.APP_ENV === 'production',
    domain: process.env.DOMAIN || 'localhost:8000',
    webhookBaseUrl: `https://${process.env.DOMAIN || 'localhost:8000'}`,
    database: { url: process.env.DATABASE_URL || '', isSupabase: false },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      projectId: process.env.OPENAI_PROJECT_ID || '',
      webhookSecret: process.env.OPENAI_WEBHOOK_SECRET || '',
      realtimeWebhookUrl: `https://${process.env.DOMAIN}/api/voice/realtime`,
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
      humanAgentNumber: process.env.HUMAN_AGENT_NUMBER,
      urgentNotificationNumber: process.env.URGENT_NOTIFICATION_NUMBER,
    },
    ticketing: {
      apiKey: process.env.TICKETING_API_KEY,
      systemUrl: process.env.TICKETING_SYSTEM_URL,
      webhookSecret: process.env.VOICE_AGENT_WEBHOOK_SECRET,
      enabled: !!(process.env.TICKETING_API_KEY && process.env.TICKETING_SYSTEM_URL),
    },
    session: { secret: process.env.SESSION_SECRET || '' },
    supabase: {
      serviceKey: process.env.SUPABASE_SERVICE_KEY,
      restUrl: process.env.SUPABASE_REST_URL,
    },
    features: {
      disablePhiLogging: process.env.DISABLE_PHI_LOGGING === 'true',
    },
  };
}

// Environment variables (from centralized config)
const OPENAI_API_KEY = envConfig.openai.apiKey;
const OPENAI_PROJECT_ID = envConfig.openai.projectId;
const isProductionEnv = envConfig.isProduction;
const WEBHOOK_SECRET = envConfig.openai.webhookSecret;
const HUMAN_AGENT_NUMBER = envConfig.twilio.humanAgentNumber;
const CONFIGURED_DOMAIN = envConfig.domain;
const WEBHOOK_BASE_URL = envConfig.webhookBaseUrl;

// Validate critical production requirements
if (isProductionEnv && !WEBHOOK_SECRET) {
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('[FATAL] PRODUCTION: OPENAI_WEBHOOK_SECRET is REQUIRED but missing!');
  console.error('[FATAL] Production cannot start without proper webhook secret.');
  console.error('═══════════════════════════════════════════════════════════════');
}

// CRITICAL: Validate HUMAN_AGENT_NUMBER for handoff functionality
if (isProductionEnv && !HUMAN_AGENT_NUMBER) {
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('[FATAL] PRODUCTION: HUMAN_AGENT_NUMBER is REQUIRED but missing!');
  console.error('[FATAL] Handoffs to human agents WILL FAIL without this number.');
  console.error('[FATAL] Add HUMAN_AGENT_NUMBER=+1XXXXXXXXXX to your .env file.');
  console.error('═══════════════════════════════════════════════════════════════');
}

// PHI Logging Protection - Set DISABLE_PHI_LOGGING=true in production for HIPAA compliance
const DISABLE_PHI_LOGGING = process.env.DISABLE_PHI_LOGGING === 'true';
const logPHI = (message: string) => {
  if (!DISABLE_PHI_LOGGING) {
    console.log(message);
  }
};

// Debug: Log environment and webhook secret status on module load
console.log(`[DEBUG] Environment: ${isProductionEnv ? 'PRODUCTION' : 'DEVELOPMENT'} (APP_ENV=${envConfig.env})`);
console.log(`[DEBUG] DOMAIN: ${CONFIGURED_DOMAIN.substring(0, 40)}...`);
console.log(`[DEBUG] Webhook Base URL: ${WEBHOOK_BASE_URL}`);
console.log(`[DEBUG] Database: ${envConfig.database.isSupabase ? 'Supabase (production)' : 'Replit PostgreSQL (development)'}`);
console.log(`[DEBUG] OPENAI_WEBHOOK_SECRET loaded: ${WEBHOOK_SECRET ? 'YES (length: ' + WEBHOOK_SECRET.length + ')' : 'NO - MISSING!'}`);
if (isProductionEnv && !WEBHOOK_SECRET) {
  console.error(`[CRITICAL] Production is running WITHOUT webhook secret - calls will fail!`);
}
if (DISABLE_PHI_LOGGING) {
  console.log(`[SECURITY] PHI logging is DISABLED for production compliance`);
}

// ANSI color codes for logging
const BRIGHT_GREEN = '\x1b[92m';
const RESET = '\x1b[0m';

// Security: Validate keys to prevent prototype pollution
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeObjectKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key) && !key.includes('__proto__');
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY!,
  webhookSecret: WEBHOOK_SECRET!,
});

// Twilio client will be initialized from integration
let twilioClient: Awaited<ReturnType<typeof getTwilioClient>>;

// Tracking active calls and conference mappings
const activeCallTasks = new Map<string, Promise<void>>();
const activeSessions = new Map<string, RealtimeSession>();
const callMetadata = new Map<string, { agentSlug: string; campaignId?: string; contactId?: string; agentGreeting?: string; language?: string; ivrSelection?: '1' | '2' | '3' | '4' }>();
const callIDtoConferenceNameMapping: Record<string, string | undefined> = {};
const ConferenceNametoCallerIDMapping: Record<string, string | undefined> = {};
const ConferenceNametoCalledNumberMapping: Record<string, string | undefined> = {}; // Dialed/To number
const ConferenceNametoCallTokenMapping: Record<string, string | undefined> = {};
const conferenceNameToCallID: Record<string, string | undefined> = {};
const conferenceNameToTwilioCallSid: Record<string, string | undefined> = {}; // Map conference name → Twilio CallSid
const conferenceSidToCallLogId: Record<string, string | undefined> = {}; // Map Twilio conference SID → DB call log ID

// Note: conferenceState import removed - warm transfer disabled

// ============================================================================
// MIGRATION HELPERS: Bridge legacy maps with CallSessionService
// These functions check both the legacy in-memory maps AND the service cache
// to ensure lookups work for both new writes and sessions restored from DB
// ============================================================================

/**
 * Get conference name by OpenAI call ID (checks legacy map first, then service cache)
 * This enables sessions to survive server restarts
 */
function getConferenceName(openAiCallId: string): string | undefined {
  // Check legacy map first (for backwards compatibility)
  const legacyResult = callIDtoConferenceNameMapping[openAiCallId];
  if (legacyResult) return legacyResult;
  
  // Fall back to service cache (populated from DB on startup)
  return callSessionService.getConferenceNameByCallIdSync(openAiCallId);
}

/**
 * Get caller ID by conference name (checks legacy map first, then service cache)
 */
function getCallerNumber(conferenceName: string): string | undefined {
  // Check legacy map first
  const legacyResult = ConferenceNametoCallerIDMapping[conferenceName];
  if (legacyResult) return legacyResult;
  
  // Fall back to service cache
  return callSessionService.getCallerByConferenceNameSync(conferenceName);
}

/**
 * Get Twilio CallSid by conference name (checks legacy map first, then service cache)
 */
function getTwilioCallSid(conferenceName: string): string | undefined {
  // Check legacy map first
  const legacyResult = conferenceNameToTwilioCallSid[conferenceName];
  if (legacyResult) return legacyResult;
  
  // Fall back to service cache
  return callSessionService.getTwilioCallSidByConferenceNameSync(conferenceName);
}

/**
 * Get OpenAI call ID by conference name (checks legacy map first, then service cache)
 */
function getCallIdByConference(conferenceName: string): string | undefined {
  // Check legacy map first
  const legacyResult = conferenceNameToCallID[conferenceName];
  if (legacyResult) return legacyResult;
  
  // Fall back to service cache
  return callSessionService.getCallIdByConferenceNameSync(conferenceName);
}

/**
 * Get called/dialed number by conference name (checks legacy map first, then service cache)
 */
function getCalledNumber(conferenceName: string): string | undefined {
  // Check legacy map first
  const legacyResult = ConferenceNametoCalledNumberMapping[conferenceName];
  if (legacyResult) return legacyResult;
  
  // Fall back to service cache - stored as 'dialedNumber' in session
  return callSessionService.getDialedNumberByConferenceNameSync(conferenceName);
}

// ============================================================================

// CRITICAL: Caller-ready synchronization
// The agent must NOT speak until the caller has actually joined the conference
// This map holds promises that resolve when participant-join fires for the customer
const callerReadyResolvers = new Map<string, () => void>();
const callerReadyPromises = new Map<string, Promise<void>>();

// Handoff-ready synchronization: Wait for human agent to actually answer before disconnecting AI
// Maps the human's CallSid to a resolver that fires when they answer
const handoffReadyResolvers = new Map<string, {
  resolve: () => void;
  reject: (err: Error) => void;
  openAiCallId: string;
  conferenceName?: string;
  callLogId?: string;
}>();

// Pending agent additions - stored by incoming-call handler, processed by webhook handler
// This ensures OpenAI SIP is only added AFTER we accept the call via REST API
interface PendingAgentAddition {
  dialedNumber: string;
  agentSlug: string;
  addedAt: number;
}
const pendingConferenceAgentAdditions = new Map<string, PendingAgentAddition>();

// SIP Watchdog - Tracks pending SIP participants and retries if webhook doesn't arrive
interface SIPWatchdog {
  conferenceName: string;
  sipCallSid: string;
  callToken: string;
  callerIDNumber: string;
  domain: string;
  timer: ReturnType<typeof setTimeout>;
  maxDurationTimer: ReturnType<typeof setTimeout>; // Hard limit to terminate orphaned SIP calls
  retryCount: number;
  createdAt: number;
  environment: string; // CRITICAL: Store originating APP_ENV to prevent cross-environment contamination
}

// Maximum duration for any SIP call (10 minutes) - safety net for orphaned connections
const SIP_MAX_DURATION_MS = 10 * 60 * 1000;
const sipWatchdogs = new Map<string, SIPWatchdog>();

// Cancel watchdog when webhook arrives (also clears max-duration timer)
function cancelSIPWatchdog(conferenceName: string) {
  const watchdog = sipWatchdogs.get(conferenceName);
  if (watchdog) {
    clearTimeout(watchdog.timer);
    clearTimeout(watchdog.maxDurationTimer);
    sipWatchdogs.delete(conferenceName);
    console.info(`[WATCHDOG] ✓ Cancelled for ${conferenceName} - webhook received`);
  }
}

// CRITICAL: Terminate orphaned SIP call when caller disconnects before call is registered
// This prevents 60-minute OpenAI sessions when caller hangs up early
async function terminateOrphanedSIPCall(conferenceName: string, reason: string) {
  const watchdog = sipWatchdogs.get(conferenceName);
  if (!watchdog) {
    return; // No orphaned SIP call for this conference
  }
  
  console.warn(`[WATCHDOG] ⚠️ Terminating orphaned SIP call: ${watchdog.sipCallSid} (reason: ${reason})`);
  
  // Cancel both watchdog timers
  clearTimeout(watchdog.timer);
  clearTimeout(watchdog.maxDurationTimer);
  sipWatchdogs.delete(conferenceName);
  
  try {
    const client = await getTwilioClient();
    await client.calls(watchdog.sipCallSid).update({ status: 'completed' });
    console.info(`[WATCHDOG] ✓ Orphaned SIP call terminated: ${watchdog.sipCallSid}`);
  } catch (error: any) {
    // Call may already be completed, which is fine
    if (error.code === 20404) {
      console.info(`[WATCHDOG] SIP call already completed: ${watchdog.sipCallSid}`);
    } else {
      console.error(`[WATCHDOG] ✗ Failed to terminate orphaned SIP call:`, error.message);
    }
  }
}

// Add SIP participant with watchdog retry and fallback
async function addSIPParticipantWithWatchdog(
  conferenceName: string,
  callerIDNumber: string,
  callToken: string,
  domain: string,
  twilioCallSid: string,
  agentSlug?: string  // Optional: explicitly pass agent slug for reliable routing
) {
  // CRITICAL: ALWAYS use current environment's domain for Twilio callbacks
  // This prevents cross-environment contamination from shared database records
  // The passed `domain` parameter may come from stale DB records pointing to wrong environment
  const safeDomain = process.env.DOMAIN || domain;
  
  // Log if we're correcting a contaminated domain
  if (domain && safeDomain !== domain) {
    const isPassedDev = domain.includes('replit.dev');
    const isSafeProd = safeDomain.includes('replit.app');
    if ((isPassedDev && isSafeProd) || (!isPassedDev && !isSafeProd)) {
      console.warn(`[ENV GUARD] ⚠️ Correcting domain contamination:`);
      console.warn(`[ENV GUARD]   Passed: ${domain}`);
      console.warn(`[ENV GUARD]   Using: ${safeDomain}`);
      console.warn(`[ENV GUARD]   Conference: ${conferenceName}`);
    }
  }

  if (!OPENAI_PROJECT_ID) {
    console.error(`[WATCHDOG] ✗ OPENAI_PROJECT_ID not configured`);
    return;
  }

  if (!envConfig.twilio.phoneNumber) {
    console.error(`[WATCHDOG] ✗ TWILIO_PHONE_NUMBER not configured — SIP calls require a verified Twilio number as 'from'`);
    return;
  }

  const client = await getTwilioClient();
  
  async function addParticipant(retryCount: number): Promise<string | null> {
    console.info(`[WATCHDOG] Adding SIP participant to ${conferenceName} (attempt ${retryCount + 1})`);
    
    // Build SIP URI with optional headers for reliable routing
    // CRITICAL: X-Environment header enables cross-environment detection when webhook arrives
    const currentEnv = process.env.APP_ENV || 'development';
    let sipUri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-Environment=${encodeURIComponent(currentEnv)}`;
    if (agentSlug) {
      sipUri += `&X-agentSlug=${encodeURIComponent(agentSlug)}`;
    }
    
    // Use resilience utilities for SIP participant creation
    const twilioSipCircuitBreaker = getCircuitBreaker('twilio-sip');
    const sipResult = await withResiliency(
      async () => client.conferences(conferenceName).participants.create({
        from: envConfig.twilio.phoneNumber!,
        label: "virtual agent",
        to: sipUri,
        earlyMedia: true,
        callToken: callToken,
        conferenceStatusCallback: `https://${safeDomain}/api/voice/conference-events`,
        conferenceStatusCallbackEvent: ['join']
      }),
      twilioSipCircuitBreaker,
      TWILIO_RETRY_CONFIG,
      `Twilio SIP watchdog for conference ${conferenceName}`
    );
    
    if (!sipResult.success) {
      console.error(`[WATCHDOG] ✗ Failed to add SIP participant after ${sipResult.attempts} attempts:`, sipResult.error);
      return null;
    }
    
    const participant = sipResult.result!;
    console.info(`[WATCHDOG] ✓ SIP participant added: callSid=${participant.callSid} (${sipResult.attempts} attempts, ${sipResult.totalTimeMs}ms)`);
    return participant.callSid;
  }

  async function handleWatchdogTimeout(watchdog: SIPWatchdog) {
    // CRITICAL: Cross-environment protection - only process watchdogs from this environment
    const currentEnv = process.env.APP_ENV || 'development';
    if (watchdog.environment !== currentEnv) {
      console.warn(`[WATCHDOG] ✗ SKIPPING ${conferenceName} - belongs to ${watchdog.environment}, we are ${currentEnv}`);
      sipWatchdogs.delete(conferenceName);
      return;
    }
    
    // Check if session was created (webhook arrived)
    const hasSession = Array.from(activeSessions.keys()).some(k => 
      k.includes(conferenceName) || conferenceNameToCallID[conferenceName]
    );
    
    if (hasSession) {
      console.info(`[WATCHDOG] Session found for ${conferenceName} - no action needed`);
      sipWatchdogs.delete(conferenceName);
      return;
    }

    // PASSIVE MONITORING: Do NOT tear down the SIP leg or retry
    // OpenAI's webhook may still arrive - killing the SIP leg destroys the session
    if (watchdog.retryCount < 3) {
      // Log warning and extend the wait time
      console.warn(`[WATCHDOG] ⚠️ OpenAI webhook not yet received after ${(watchdog.retryCount + 1) * 15}s for ${conferenceName} - continuing to wait...`);
      
      // Set up another check in 15s (total max wait: 60s)
      const newTimer = setTimeout(() => handleWatchdogTimeout(sipWatchdogs.get(conferenceName)!), 15000);
      sipWatchdogs.set(conferenceName, {
        ...watchdog,
        timer: newTimer,
        retryCount: watchdog.retryCount + 1,
      });
    } else {
      // After 60s total, give up and play fallback
      console.error(`[WATCHDOG] ✗ OpenAI SIP failed after 60s for ${conferenceName} - falling back to human transfer`);
      // Clear max-duration timer before deleting watchdog
      if (watchdog.maxDurationTimer) {
        clearTimeout(watchdog.maxDurationTimer);
      }
      sipWatchdogs.delete(conferenceName);
      await playFallbackMessage(conferenceName, twilioCallSid, safeDomain);
    }
  }

  async function playFallbackMessage(conf: string, callSid: string, dom: string) {
    console.warn(`[WATCHDOG] Playing fallback message for ${conf}`);
    const existingWatchdog = sipWatchdogs.get(conf);
    if (existingWatchdog?.maxDurationTimer) {
      clearTimeout(existingWatchdog.maxDurationTimer);
    }
    sipWatchdogs.delete(conf);
    
    try {
      // Update the caller's leg with a fallback TwiML
      await client.calls(callSid).update({
        twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We apologize, but we are experiencing technical difficulties connecting you to our assistant. Please hold while we transfer you to our answering service.</Say>
  <Pause length="2"/>
  <Dial callerId="${callerIDNumber}">
    <Number>${process.env.HUMAN_AGENT_NUMBER || '+18186021567'}</Number>
  </Dial>
  <Say voice="Polly.Joanna">We were unable to complete your call. Please try again later or call back during regular business hours. Goodbye.</Say>
  <Hangup/>
</Response>`
      });
      console.info(`[WATCHDOG] ✓ Fallback message sent and transfer initiated for ${callSid}`);
    } catch (fallbackError) {
      console.error(`[WATCHDOG] ✗ Failed to play fallback:`, fallbackError);
    }
  }

  // Start the first attempt
  const sipCallSid = await addParticipant(0);
  if (!sipCallSid) {
    console.error(`[WATCHDOG] ✗ Initial SIP add failed for ${conferenceName}`);
    return;
  }

  // Set up watchdog timer (15 seconds - OpenAI SIP can have high latency)
  const timer = setTimeout(() => handleWatchdogTimeout(sipWatchdogs.get(conferenceName)!), 15000);
  
  // CRITICAL: Set up max-duration safety timer (10 minutes)
  // This terminates orphaned SIP calls even if no conference events are received
  // Prevents 60-minute OpenAI sessions from accumulating costs
  const maxDurationTimer = setTimeout(async () => {
    console.warn(`[WATCHDOG] ⚠️ Max duration (${SIP_MAX_DURATION_MS / 60000}min) reached for ${conferenceName}`);
    await terminateOrphanedSIPCall(conferenceName, 'max_duration_exceeded');
  }, SIP_MAX_DURATION_MS);
  
  sipWatchdogs.set(conferenceName, {
    conferenceName,
    sipCallSid,
    callToken,
    callerIDNumber,
    domain: safeDomain,  // Use corrected domain to prevent contamination
    timer,
    maxDurationTimer,
    retryCount: 0,
    createdAt: Date.now(),
    environment: process.env.APP_ENV || 'development', // Tag with originating environment
  });
  
  console.info(`[WATCHDOG] Started for ${conferenceName} (15s check, ${SIP_MAX_DURATION_MS / 60000}min max)`);
}

// Session options for consistent configuration
// NOTE: Voice and language are NOT set here - they're configured at call accept time
// This prevents "cannot_update_voice" errors when session connects
// IMPORTANT: SDK 0.3.7 uses toNewSessionConfig() which has two paths:
// - "deprecated" path: triggered by top-level camelCase fields (turnDetection, inputAudioTranscription)
// - "new" path: expects nested audio.input.turnDetection structure
// We use the new nested structure to ensure fields pass through correctly.
// SIP MODE: Do NOT set audio format here. Audio codec is negotiated at the SIP/SDP transport
// layer between Twilio and OpenAI. Setting format in session config conflicts with SIP negotiation.
const sessionOptions: Partial<RealtimeSessionOptions> = {
  model: 'gpt-realtime',
  config: {
    audio: {
      input: {
        transcription: { model: 'gpt-4o-transcribe' },
        turnDetection: {
          type: 'semantic_vad',
          eagerness: 'medium',
          createResponse: true,
          interruptResponse: true,
        },
      },
    },
  } as any,
  outputGuardrails: medicalSafetyGuardrails,
};

// Store transcripts by call ID
const callTranscripts = new Map<string, string[]>();

// Track calls where we've sent AirCall DTMF (avoid sending multiple times)
const aircallDTMFSent = new Set<string>();

// Store call metadata for database logging
const callMetadataForDB = new Map<string, {
  dbCallLogId?: string;
  startTime: Date;
  agentSlug: string;
  agentVersion?: string;
  twilioCallSid?: string;
  from?: string;
  to?: string;
  transferredToHuman: boolean;
  audioInputMs: number; // Track audio input duration for cost calculation
  audioOutputMs: number; // Track audio output duration for cost calculation
}>();

// Import escalation details from shared store (avoids circular dependency with noIvrAgent.ts)
import { escalationDetailsMap, type EscalationDetails } from './services/escalationStore';

// Log conversation history (PHI-protected)
function logHistoryItem(item: RealtimeItem, callId?: string): void {
  // Type guard: only message items have role and content
  const role = 'role' in item ? (item as any).role : undefined;
  const content = 'content' in item ? (item as any).content : undefined;
  
  // Only log structure, not content (PHI protection)
  logPHI(`[HISTORY DEBUG] Item: type=${item.type}, role=${role}, content count=${content?.length || 0}`);
  
  // Debug: Log the content structure only (no actual content for PHI protection)
  if (content && content.length > 0) {
    content.forEach((c: any, idx: number) => {
      logPHI(`[CONTENT ${idx}] type=${c.type}, has text=${!!c.text}, has transcript=${!!c.transcript}`);
    });
  }
  
  if (item.type !== 'message') return;

  let transcriptEntry: string | null = null;

  if (item.role === 'user') {
    for (const content of item.content) {
      if (content.type === 'input_text' && content.text) {
        transcriptEntry = `CALLER: ${content.text}`;
        logPHI(`${BRIGHT_GREEN}[CALLER SPOKE] ${content.text}${RESET}`);
      } else if (content.type === 'input_audio' && content.transcript) {
        transcriptEntry = `CALLER: ${content.transcript}`;
        logPHI(`${BRIGHT_GREEN}[CALLER SPOKE] ${content.transcript}${RESET}`);
      }
    }
  } else if (item.role === 'assistant') {
    for (const content of item.content) {
      if (content.type === 'output_text' && content.text) {
        transcriptEntry = `AGENT: ${content.text}`;
        logPHI(`${BRIGHT_GREEN}[AGENT SPOKE] ${content.text}${RESET}`);
      } else if (content.type === 'output_audio' && content.transcript) {
        transcriptEntry = `AGENT: ${content.transcript}`;
        logPHI(`${BRIGHT_GREEN}[AGENT SPOKE] ${content.transcript}${RESET}`);
      }
    }
  }
  
  // Store transcript entry for database logging (always store, but don't log content)
  if (transcriptEntry && callId) {
    if (!callTranscripts.has(callId)) {
      callTranscripts.set(callId, []);
    }
    callTranscripts.get(callId)!.push(transcriptEntry);
    // PHI protection: Only log count, not content
    console.log(`[TRANSCRIPT] Stored entry for call ${callId} (${callTranscripts.get(callId)!.length} entries)`);
  }
}

// Handle human agent handoff
async function addHumanAgent(openAiCallId: string): Promise<void> {
  // Use wrapper function that checks both legacy maps and service cache
  const conferenceName = getConferenceName(openAiCallId);
  if (!conferenceName) {
    console.error('[HANDOFF] ✗ Conference name not found for call ID:', openAiCallId);
    return;
  }

  if (!HUMAN_AGENT_NUMBER) {
    console.error('[HANDOFF] ✗ HUMAN_AGENT_NUMBER not configured');
    return;
  }

  // Get escalation details for this call
  const escalationDetails = escalationDetailsMap.get(openAiCallId);
  
  // SERVER-SIDE VALIDATION: Only allow handoffs for legitimate urgent cases
  // This prevents the AI from making handoffs for routine requests like cancellations
  const ALLOWED_HANDOFF_CALLER_TYPES = ['patient_urgent', 'patient_urgent_medical', 'healthcare_provider', 'patient_unresponsive'];
  const callerType = escalationDetails?.callerType;
  
  if (!callerType || !ALLOWED_HANDOFF_CALLER_TYPES.includes(callerType)) {
    console.warn(`[HANDOFF] ⚠️ BLOCKED - Invalid caller type for handoff: "${callerType || 'none'}"`);
    console.warn(`[HANDOFF]   Reason given: ${escalationDetails?.reason || 'Not specified'}`);
    console.warn(`[HANDOFF]   Allowed types: ${ALLOWED_HANDOFF_CALLER_TYPES.join(', ')}`);
    console.warn(`[HANDOFF]   AI should have created a ticket instead - blocking this handoff`);
    // Don't disconnect caller - AI will continue the conversation
    return;
  }
  
  console.log('\n========================================');
  console.log(`[HANDOFF] ✓ Validated - Transferring to human agent`);
  console.log(`   Conference: ${conferenceName}`);
  console.log(`   Human Number: ${HUMAN_AGENT_NUMBER}`);
  if (escalationDetails) {
    console.log(`   Reason: ${escalationDetails.reason || 'Not specified'}`);
    console.log(`   Caller Type: ${escalationDetails.callerType || 'Unknown'}`);
    if (escalationDetails.providerInfo) {
      console.log(`   Provider: ${escalationDetails.providerInfo}`);
    }
    if (escalationDetails.patientFirstName) {
      console.log(`   Patient: ${escalationDetails.patientFirstName} ${escalationDetails.patientLastName || ''}`);
    }
  }
  console.log('========================================\n');

  const callToken = ConferenceNametoCallTokenMapping[conferenceName];
  const callerID = getCallerNumber(conferenceName); // Uses wrapper with fallback to service cache

  if (!callToken || !callerID) {
    console.error('[HANDOFF] ✗ Missing callToken or callerID');
    return;
  }

  try {
    // Initialize Twilio client if not already done
    if (!twilioClient) {
      twilioClient = await getTwilioClient();
    }
    
    // CRITICAL: Must use TWILIO_PHONE_NUMBER as 'from' (verified number)
    // Use centralized config to ensure production .env file values are read correctly
    const twilioPhoneNumber = envConfig.twilio.phoneNumber;
    if (!twilioPhoneNumber) {
      console.error('[HANDOFF] ✗ TWILIO_PHONE_NUMBER not configured in environment');
      throw new Error('TWILIO_PHONE_NUMBER environment variable not set');
    }
    console.log(`[HANDOFF] Using Twilio phone number: ${twilioPhoneNumber}`);
    
    // STEP 1: Send SMS notification immediately (fire and forget)
    // Provider gets heads-up while we're dialing them
    // Use centralized config for production compatibility
    const URGENT_NOTIFICATION_NUMBER = envConfig.twilio.urgentNotificationNumber;
    if (URGENT_NOTIFICATION_NUMBER) {
      (async () => {
        try {
          const callerNumber = callerID || 'Unknown';
          const callTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          
          let smsBody = `📞 INCOMING TRANSFER - ${callTime}\n`;
          smsBody += `From: ${callerNumber}\n`;
          
          if (escalationDetails) {
            if (escalationDetails.callerType === 'healthcare_provider' && escalationDetails.providerInfo) {
              smsBody += `\n👨‍⚕️ PROVIDER CALL\n`;
              smsBody += `Provider: ${escalationDetails.providerInfo}\n`;
            } else if (escalationDetails.callerType === 'patient_urgent') {
              smsBody += `\n🚨 URGENT PATIENT\n`;
            }
            
            if (escalationDetails.patientFirstName) {
              smsBody += `Patient: ${escalationDetails.patientFirstName} ${escalationDetails.patientLastName || ''}\n`;
            }
            if (escalationDetails.patientDob) {
              smsBody += `DOB: ${escalationDetails.patientDob}\n`;
            }
            if (escalationDetails.callbackNumber) {
              smsBody += `Callback: ${escalationDetails.callbackNumber}\n`;
            }
            if (escalationDetails.reason) {
              smsBody += `\nReason: ${escalationDetails.reason}\n`;
            }
            if (escalationDetails.symptomsSummary) {
              smsBody += `Symptoms: ${escalationDetails.symptomsSummary}\n`;
            }
          }
          
          smsBody += `\n📱 Connecting patient to you now...`;
          
          await twilioClient!.messages.create({
            body: smsBody,
            from: twilioPhoneNumber,
            to: URGENT_NOTIFICATION_NUMBER,
          });
          console.log('[HANDOFF] ✓ SMS notification sent to', URGENT_NOTIFICATION_NUMBER);
        } catch (smsError) {
          console.error('[HANDOFF] ⚠️ SMS notification failed:', smsError);
        }
      })();
    } else {
      console.log('[HANDOFF] ℹ️ SMS notification skipped - URGENT_NOTIFICATION_NUMBER not configured');
    }
    
    // STEP 2: Dial human agent into the conference WHILE AI is still connected
    // Use statusCallback to know when human actually answers
    console.log('[HANDOFF] Step 1: Dialing human agent into conference (AI still connected)...');
    
    // Declare resolver variables outside the Promise executor
    // Using definite assignment assertion since Promise executor runs synchronously
    let humanCallSid: string | undefined;
    let resolveHumanAnswered!: () => void;
    let rejectHumanAnswered!: (err: Error) => void;
    let timeoutId: ReturnType<typeof setTimeout>;
    
    const humanAnsweredPromise = new Promise<void>((resolve, reject) => {
      resolveHumanAnswered = resolve;
      rejectHumanAnswered = reject;
    });
    
    try {
      // Get the domain for status callback URL - use centralized config for production compatibility
      const domain = envConfig.domain;
      const statusCallbackUrl = `https://${domain}/api/voice/handoff-status`;
      
      // Use resilience utilities for critical handoff operation
      const twilioCircuitBreaker = getCircuitBreaker('twilio-handoff');
      const handoffResult = await withResiliency(
        async () => twilioClient.conferences(conferenceName).participants.create({
          from: twilioPhoneNumber,
          to: HUMAN_AGENT_NUMBER,
          label: 'human agent',
          earlyMedia: true,
          endConferenceOnExit: true,
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: ['answered', 'completed'],
          timeout: 45, // Ring for 45 seconds max
        }),
        twilioCircuitBreaker,
        TWILIO_RETRY_CONFIG,
        `Twilio handoff for conference ${conferenceName}`
      );
      
      if (!handoffResult.success) {
        throw handoffResult.error;
      }
      
      const participant = handoffResult.result!;
      humanCallSid = participant.callSid;
      console.log(`[HANDOFF] ✓ Dialing human agent, CallSid: ${humanCallSid} (${handoffResult.attempts} attempts, ${handoffResult.totalTimeMs}ms)`);
      
      // Set up timeout now that we have the callSid
      timeoutId = setTimeout(() => {
        console.warn('[HANDOFF] ⚠️ Timeout waiting for human to answer');
        handoffReadyResolvers.delete(humanCallSid!);
        rejectHumanAnswered(new Error('Human agent did not answer within 45 seconds'));
      }, 45000);
      
      // Register the resolver with the callSid
      handoffReadyResolvers.set(humanCallSid, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolveHumanAnswered();
        },
        reject: rejectHumanAnswered,
        openAiCallId,
        conferenceName,
        callLogId: callMetadataForDB.get(openAiCallId)?.dbCallLogId,
      });
    } catch (dialError) {
      console.error('[HANDOFF] ✗ Failed to dial human agent:', dialError);
      // AI is still connected - caller is not stranded
      // Don't throw - let the AI continue the conversation
      return;
    }

    // STEP 3: Wait for human to actually answer before disconnecting AI
    console.log('[HANDOFF] Step 2: Waiting for human to answer...');
    try {
      await humanAnsweredPromise;
      console.log('[HANDOFF] ✓ Human agent answered the call');
    } catch (waitError) {
      console.error('[HANDOFF] ✗ Human agent did not answer:', waitError);
      // AI is still connected - caller is not stranded
      // Clean up
      if (humanCallSid) {
        handoffReadyResolvers.delete(humanCallSid);
      }
      return;
    }
    
    // STEP 4: Disconnect AI agent ONLY AFTER human successfully answers
    console.log('[HANDOFF] Step 3: Disconnecting AI agent...');
    const hangupResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(openAiCallId)}/hangup`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );
    
    if (hangupResponse.ok) {
      console.log('[HANDOFF] ✓ AI agent disconnected - caller now connected to human');
    } else {
      console.warn('[HANDOFF] ⚠️ AI agent disconnect returned:', hangupResponse.status);
      // Continue anyway - human is already in conference
    }
    
    // Mark call as transferred in metadata
    const callMeta = callMetadataForDB.get(openAiCallId);
    if (callMeta) {
      callMeta.transferredToHuman = true;
      
      // CRITICAL: Also mark in callLifecycleCoordinator to prevent it from overwriting
      // the transferredToHuman flag when it finalizes the call
      if (callMeta.dbCallLogId) {
        const { callLifecycleCoordinator } = await import('./services/callLifecycleCoordinator');
        callLifecycleCoordinator.markTransferred(callMeta.dbCallLogId);
        console.log('[HANDOFF] ✓ Marked transferred in callLifecycleCoordinator');
      }
    }
    
    // Clean up escalation details only after successful handoff
    escalationDetailsMap.delete(openAiCallId);
    
    // Save transcript and finalize call log
    setTimeout(async () => {
      const callMeta = callMetadataForDB.get(openAiCallId);
      if (callMeta?.dbCallLogId) {
        try {
          const { DatabaseStorage } = await import('../server/storage');
          const storage = new DatabaseStorage();
          
          const transcript = callTranscripts.get(openAiCallId)?.join('\n') || '';
          const endTime = new Date();
          
          // CRITICAL: DO NOT save duration - TWILIO IS THE SOURCE OF TRUTH
          // Let Twilio status callback set the authoritative duration
          await storage.updateCallLog(callMeta.dbCallLogId, {
            status: 'transferred',
            endTime,
            // DO NOT SET DURATION - Twilio status callback will set it
            transcript,
            transferredToHuman: true,
            humanAgentNumber: HUMAN_AGENT_NUMBER,
            costIsEstimated: true,  // Mark as estimated until Twilio confirms
          });
          
          console.info(`[DB] Call log updated after handoff: ${callMeta.dbCallLogId}, Duration=AWAITING_TWILIO, Transferred: true`);
          console.info(`[DB] Transcript saved (${transcript.split('\n').length} lines)`);
          
          // Async: Calculate costs and grade call
          const callLogId = callMeta.dbCallLogId;
          setImmediate(async () => {
            try {
              const { callCostService } = await import('./services/callCostService');
              const { callGradingService } = await import('./services/callGradingService');
              
              await callCostService.recalculateOpenAICostFromDuration(callLogId);
              
              if (callMeta.twilioCallSid) {
                await callCostService.retryTwilioCostFetch(callLogId, callMeta.twilioCallSid);
              }
              
              if (transcript.length > 50) {
                await callGradingService.gradeCall(callLogId, transcript);
              }
              
              console.info(`[POST-CALL] Cost and grading processed for handoff call ${callLogId}`);
            } catch (postCallError) {
              console.error('[POST-CALL ERROR] Handoff cost/grading failed:', postCallError);
            }
          });
          
          // Clean up
          callMetadataForDB.delete(openAiCallId);
          callTranscripts.delete(openAiCallId);
        } catch (dbError) {
          console.error('[DB ERROR] Failed to update call log after handoff:', dbError);
        }
      }
    }, 1000);
  } catch (error) {
    console.error('[HANDOFF ERROR]', error);
    throw error;
  }
}

// Observe and manage call session with dynamic agent selection
const OBSERVE_CALL_VERSION = 'v2.3.0-restore-rest-accept';

async function observeCall(
  callId: string, 
  agentSlug?: string,
  metadata?: { campaignId?: string; contactId?: string; language?: string; agentGreeting?: string; ivrSelection?: '1' | '2' | '3' | '4' }
): Promise<void> {
  const observeCallStart = Date.now();
  console.info(`[SESSION] ▶ observeCall ${OBSERVE_CALL_VERSION} started for ${callId} (agent: ${agentSlug || 'default'})`);
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const { agentRegistry } = await import('./config/agents');
  const { createDatabaseAgent } = await import('./agents/databaseAgent');
  
  // AGENT ROUTING with strict validation
  // Only these agents are allowed (defense in depth - validated at webhook AND here)
  const validAgentSlugs = ['no-ivr', 'dev-no-ivr', 'after-hours', 'answering-service', 'drs-scheduler', 'appointment-confirmation', 'fantasy-football'];
  const legacyDeletedSlugs = ['greeter', 'non-urgent-ticketing'];
  
  let effectiveSlug = agentSlug || 'no-ivr';
  
  // Coerce legacy slugs
  if (legacyDeletedSlugs.includes(effectiveSlug)) {
    console.info(`[SESSION] Coercing deleted slug '${effectiveSlug}' → 'after-hours' (agent cleanup)`);
    effectiveSlug = 'after-hours';
  }
  
  // Final validation: reject any unknown slugs
  if (!validAgentSlugs.includes(effectiveSlug)) {
    console.warn(`[SESSION] ⚠️ Unknown agent slug '${effectiveSlug}' - coercing to 'after-hours' (strict enforcement)`);
    effectiveSlug = 'after-hours';
  }
  
  // Check if this slug exists in the hardcoded registry (even if disabled)
  const agentConfig = agentRegistry.getAgentConfig(effectiveSlug);
  const isHardcodedAgent = !!agentConfig;
  
  // Get factory only if agent is enabled
  const agentFactory = agentRegistry.getAgentFactory(effectiveSlug);
  
  // If it's a hardcoded agent but disabled/not found, fail fast - don't fall through to DB
  if (isHardcodedAgent && !agentFactory) {
    console.error(`[SESSION ERROR] Hardcoded agent is disabled or not found: ${effectiveSlug}`);
    throw new Error(`Agent disabled or not found: ${effectiveSlug}`);
  }
  
  console.info(`[SESSION] Creating agent: ${effectiveSlug}`, metadata || {});
  
  // Import actual adapter functions for database operations
  const { CallbackQueueAdapter, CampaignAdapter } = await import('./db/agentAdapters');
  
  // Handoff callback for all agents
  const handoffCallback = async () => {
    await addHumanAgent(callId);
  };
  
  // Patient info callback for after-hours and no-ivr agents
  const recordPatientInfoCallback = async (info: any) => {
    // Handle patient info from voice agents
    const patientName = info.patient_name || 
      (info.first_name && info.last_name ? `${info.first_name} ${info.last_name}` : undefined);
    const patientPhone = info.phone_number || info.callback_number || from;
    const reason = info.reason || info.reason_for_call;
    
    // Only add to callback queue if we have required fields
    if (!patientName || !patientPhone) {
      console.log('[PatientInfo] Skipping callback queue - missing name or phone:', {
        hasName: !!patientName,
        hasPhone: !!patientPhone,
      });
      return { success: true, message: "Patient information recorded (not queued - incomplete)" };
    }
    
    try {
      const result = await CallbackQueueAdapter.addToQueue({
        patient_name: patientName,
        patient_phone: patientPhone,
        patient_dob: info.date_of_birth,
        patient_email: info.email,
        reason: reason,
        priority: info.priority || (info.is_urgent ? 'urgent' : 'normal'),
      });
      return { success: true, message: "Patient information recorded for callback" };
    } catch (error) {
      console.error('[PatientInfo] Error adding to callback queue:', error);
      return { success: true, message: "Patient information recorded" };
    }
  };
  
  // Lookup and mark callbacks for DRS agent
  const lookupPatientCallback = async (campaignId: string, contactId: string) => {
    return await CampaignAdapter.lookupPatient(campaignId, contactId);
  };
  
  const markContactCompletedCallback = async (contactId: string, outcome: string, notes?: string) => {
    // Map outcome to expected type
    const mappedOutcome: 'success' | 'failed' | 'no_answer' = 
      outcome === 'success' ? 'success' :
      outcome === 'no_answer' ? 'no_answer' : 'failed';
    return await CampaignAdapter.markContactCompleted(contactId, mappedOutcome, notes);
  };
  
  // CRITICAL: Create call log BEFORE agent instantiation so we have callLogId for DRS agent
  // First try mapping lookup, then fall back to SIP headers passed via metadata
  // Use wrapper functions for restart recovery - checks legacy maps first, then service cache
  const confNameForDB = getConferenceName(callId);
  const extMeta = metadata as any;
  
  // Use SIP header data as primary source (more reliable), fall back to mapping
  const from = extMeta?.callerPhoneFromSIP || 
               (confNameForDB ? getCallerNumber(confNameForDB) : undefined);
  const to = extMeta?.dialedPhoneFromSIP ||
             (confNameForDB ? getCalledNumber(confNameForDB) : undefined) ||
             process.env.TWILIO_PHONE_NUMBER;
  const twilioCallSid = extMeta?.twilioCallSidFromSIP ||
                        (confNameForDB ? getTwilioCallSid(confNameForDB) : undefined);
  const conferenceNameFromMeta = extMeta?.conferenceNameFromSIP || confNameForDB;
  
  let callLogId: string | undefined;
  let agentId: string | undefined;
  
  const { storage } = await import('../server/storage');
  
  // GHOST CALL FIX: Only create call log if we have valid caller data
  const hasValidCallerData = !!from && from !== 'Unknown';
  
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKGROUND DB OPERATIONS — launched immediately but NOT awaited until
  // AFTER session.connect() succeeds. This prevents 3 sequential DB queries
  // (getAgentBySlug + getCallLogByCallSid + createCallLog) from consuming
  // the 10-15 second OpenAI SIP accept window, which caused dead air.
  // ═══════════════════════════════════════════════════════════════════════════
  const dbOpsStartTime = Date.now();
  CallDiagnostics.recordStage(callId, 'db_get_agent_started', true);
  
  const backgroundDbOps = (async (): Promise<{ callLogId?: string; agentId?: string }> => {
    try {
      const dbGetAgentStart = Date.now();
      const agentRecord = await storage.getAgentBySlug(effectiveSlug);
      CallDiagnostics.recordDbOperation(callId, 'get_agent', dbGetAgentStart, true);
      CallDiagnostics.recordStage(callId, 'db_get_agent_completed', true, { durationMs: Date.now() - dbGetAgentStart });
      const resolvedAgentId = agentRecord?.id;
      
      let resolvedCallLogId: string | undefined;
      
      if (hasValidCallerData) {
        const currentDomain = process.env.DOMAIN || '';
        const isProduction = currentDomain.includes('replit.app');
        const environment = isProduction ? 'production' : 'development';
        
        let existingCallLog = null;
        if (twilioCallSid) {
          existingCallLog = await storage.getCallLogByCallSid(twilioCallSid);
        }
        
        if (existingCallLog) {
          resolvedCallLogId = existingCallLog.id;
          console.info(`[DB-BG] Using existing call log: ${resolvedCallLogId}, CallSid: ${twilioCallSid}`);
        } else {
          const agentConfigForLog = agentRegistry.getAgentConfig(effectiveSlug);
          const agentVersionForLog = agentConfigForLog?.version || 'unknown';
          
          CallDiagnostics.recordStage(callId, 'db_create_call_log_started', true);
          const dbCreateLogStart = Date.now();
          const callLog = await storage.createCallLog({
            callSid: twilioCallSid,
            direction: 'inbound',
            from: from,
            to: to || '',
            agentId: agentRecord?.id,
            status: 'in_progress',
            startTime: new Date(),
            environment: environment,
            agentUsed: effectiveSlug,
            agentVersion: agentVersionForLog,
            dialedNumber: to || undefined,
          });
          CallDiagnostics.recordDbOperation(callId, 'create_call_log', dbCreateLogStart, true);
          CallDiagnostics.recordStage(callId, 'db_create_call_log_completed', true, { durationMs: Date.now() - dbCreateLogStart });
          
          resolvedCallLogId = callLog.id;
          CallDiagnostics.addCorrelationId(callId, 'callLogId', resolvedCallLogId);
          CallDiagnostics.updateTrace(callId, { 
            agentSlug: effectiveSlug, 
            twilioCallSid,
            callLogId: resolvedCallLogId,
          });
          console.info(`[DB-BG] Call log created: ${resolvedCallLogId}, CallSid: ${twilioCallSid}, Agent: ${effectiveSlug} ${agentVersionForLog}, Env: ${environment}`);
        }
      } else {
        console.warn(`[DB-BG] Skipping call log creation - no caller data:`, {
          from: from || 'N/A',
          callSid: twilioCallSid?.slice(-8) || 'N/A',
          callId: callId.slice(-8),
        });
      }
      
      // Register call with lifecycle coordinator
      if (resolvedCallLogId) {
        callLifecycleCoordinator.registerCall({
          callLogId: resolvedCallLogId,
          twilioCallSid,
          openAiCallId: callId,
          agentSlug: effectiveSlug,
          from,
          to,
        });
        
        for (const [key, mappedCallId] of Object.entries(conferenceNameToCallID)) {
          if (mappedCallId === callId && key.startsWith('CF')) {
            conferenceSidToCallLogId[key] = resolvedCallLogId;
            console.info(`[DB-BG] ✓ Mapped ConferenceSid ${key} → callLogId ${resolvedCallLogId}`);
            break;
          }
        }
      }
      
      const totalDbMs = Date.now() - dbOpsStartTime;
      console.info(`[DB-BG] ✓ All DB operations completed in ${totalDbMs}ms (ran in background, did NOT block accept)`);
      
      return { callLogId: resolvedCallLogId, agentId: resolvedAgentId };
    } catch (dbError) {
      console.error('[DB-BG ERROR] Background DB operations failed:', dbError);
      const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
      CallDiagnostics.recordStage(callId, 'db_create_call_log_completed', false, undefined, errorMsg);
      CallDiagnostics.updateTrace(callId, { failureReason: `DB Error: ${errorMsg}` });
      return { callLogId: undefined, agentId: undefined };
    }
  })().catch((fatalErr) => {
    console.error('[DB-BG FATAL] Unhandled error in background DB ops:', fatalErr);
    return { callLogId: undefined, agentId: undefined };
  });
  
  // Agent factory runs immediately — does NOT wait for DB ops.
  // callLogId is undefined here; it gets backfilled after session.connect().
  // The factory's callerMemory/schedule lookups run in parallel with DB ops.
  
  // Build after-hours specific metadata with caller phone for automatic caller ID recognition
  const afterHoursMetadata = {
    ...metadata,
    callerPhone: from,
    dialedNumber: to,
    callSid: twilioCallSid,
  };
  
  // Create agent with correct signature per agent type
  // Use factoryResult to capture potentially async factory returns, then normalize with Promise.resolve
  let factoryResult: RealtimeAgent | Promise<RealtimeAgent> | undefined;
  
  // For hardcoded agents, use the factory from registry
  if (isHardcodedAgent && agentFactory) {
    switch (effectiveSlug) {
      case 'after-hours':
        // createAfterHoursAgent(handoffCallback?, recordPatientInfoCallback?, metadata?)
        factoryResult = agentFactory(
          handoffCallback,
          recordPatientInfoCallback, // Use real DB adapter
          afterHoursMetadata // ← Pass caller phone for automatic ID recognition
        );
        break;
      
      case 'drs-scheduler':
        // createDRSSchedulerAgent(lookupCallback?, markCallback?, computer?, handoffCallback?, metadata?)
        factoryResult = agentFactory(
          lookupPatientCallback, // Use real DB adapter
          markContactCompletedCallback, // Use real DB adapter
          undefined, // computer - no Computer Use instance
          handoffCallback,
          { ...metadata, callLogId: undefined, agentId: undefined } // callLogId backfilled after session.connect()
        );
        break;
      
      case 'appointment-confirmation':
        // createAppointmentConfirmationAgent(getCallback?, confirmCallback?, rescheduleCallback?, cancelCallback?, markCallback?, handoffCallback?, metadata?)
        // Use default DB adapters for appointment operations
        factoryResult = agentFactory(
          undefined, // getAppointmentCallback - use CampaignAdapter default
          undefined, // confirmCallback - use CampaignAdapter default
          undefined, // rescheduleCallback - use CampaignAdapter default
          undefined, // cancelCallback - use CampaignAdapter default
          undefined, // markConfirmedCallback - use CampaignAdapter default
          handoffCallback,
          metadata
        );
        break;
      
      case 'answering-service':
        // createAnsweringServiceAgent(handoffCallback, metadata) - simplified v2.0
        factoryResult = agentFactory(
          handoffCallback,
          {
            callId,
            callSid: twilioCallSid,
            callerPhone: from,
            dialedNumber: to,
            callLogId,
          }
        );
        break;
      
      case 'fantasy-football':
        // createFantasyFootballAgent(metadata?)
        // Do async contact lookup HERE (observeCall is async), then pass to factory (which is synchronous)
        let contactName = 'there';
        if (metadata?.campaignId && metadata?.contactId) {
          try {
            const contact = await CampaignAdapter.lookupPatient(metadata.campaignId, metadata.contactId);
            if (contact?.first_name?.trim()) {
              contactName = contact.first_name.trim();
              console.log(`[SESSION] Fantasy Football - Contact name: "${contactName}"`);
            }
          } catch (error) {
            console.error('[SESSION] Fantasy Football - Contact lookup failed:', error);
          }
        }
        factoryResult = agentFactory({ ...metadata, contactName });
        break;
      
      case 'no-ivr':
        // createNoIvrAgent(handoffCallback, metadata) - async
        // PRODUCTION agent - determines caller type and urgency through conversation
        // Includes Name+DOB fallback lookup feature (v1.7.0)
        factoryResult = agentFactory(
          handoffCallback,
          {
            callId,
            callSid: twilioCallSid,
            callerPhone: from,
            dialedNumber: to,
            callLogId: callLogId, // For patient context updates
            variant: 'production' as const, // PRODUCTION variant with full features
          }
        );
        break;
      
      case 'dev-no-ivr':
        // DEV version of no-ivr agent - for development testing
        // v1.10.0-dev: direct appointment answers, ghost call filtering, improved language detection, same-day urgency
        factoryResult = agentFactory(
          handoffCallback,
          {
            callId,
            callSid: twilioCallSid,
            callerPhone: from,
            dialedNumber: to,
            callLogId: callLogId,
            variant: 'development' as const, // DEVELOPMENT variant - testing new features before production
          }
        );
        break;
      
      default:
        console.error(`[SESSION ERROR] Unknown hardcoded agent: ${effectiveSlug}`);
        throw new Error(`Unknown hardcoded agent: ${effectiveSlug}`);
    }
  } else {
    // Not a hardcoded agent - use database-configured agent
    console.info(`[SESSION] Agent not in registry, checking database: ${effectiveSlug}`);
    const agentRecord = await storage.getAgentBySlug(effectiveSlug);
    
    if (agentRecord && agentRecord.systemPrompt) {
      console.info(`[SESSION] ✓ Found database-configured agent: ${agentRecord.name}`);
      factoryResult = createDatabaseAgent(
        agentRecord,
        handoffCallback,
        {
          callerPhone: from,
          callSid: twilioCallSid,
          dialedNumber: to,
        }
      );
    } else {
      console.error(`[SESSION ERROR] Agent not found in registry or database: ${effectiveSlug}`);
      throw new Error(`Agent not found: ${effectiveSlug}`);
    }
  }

  console.info(`[SESSION] CHECKPOINT A: Awaiting factory result for ${effectiveSlug}... (T+${Date.now() - observeCallStart}ms)`);
  let sessionAgent: any;
  try {
    sessionAgent = await Promise.resolve(factoryResult);
  } catch (factoryError) {
    console.error(`[SESSION] FATAL: Agent factory threw for ${effectiveSlug}:`, factoryError);
    throw factoryError;
  }
  console.info(`[SESSION] CHECKPOINT B: Factory resolved (T+${Date.now() - observeCallStart}ms), agent type: ${sessionAgent?.constructor?.name}, name: ${sessionAgent?.name}`);
  
  if (!sessionAgent) {
    throw new Error(`Failed to create agent: ${effectiveSlug}`);
  }

  const isSpanish = metadata?.language === 'spanish' || metadata?.ivrSelection === '4';
  const voiceForCall = (metadata as any)?.voiceForCall || agentConfig?.voice || (isSpanish ? 'coral' : 'sage');
  const languageForCall = (metadata as any)?.languageForCall;
  const agentLanguage = agentConfig?.language || 'en';
  const languageCode = languageForCall || (isSpanish ? 'es' : agentLanguage);
  console.info(`[SESSION] Call config: voice=${voiceForCall}, language=${languageCode}, isSpanish=${isSpanish}, ivrSelection=${metadata?.ivrSelection || 'none'}`);
  
  console.info(`[SESSION] CHECKPOINT C: Creating RealtimeSession... (T+${Date.now() - observeCallStart}ms)`);
  const session = new RealtimeSession(sessionAgent, {
    transport: new OpenAIRealtimeSIP(),
    ...sessionOptions,
    // TRACING: Enable OpenAI dashboard visibility
    // View traces at: platform.openai.com → Logs → Traces
    tracingDisabled: false,
    // Top-level tracing config for custom workflow labels
    tracing: {
      workflowName: `AzulVision_${effectiveSlug}`,
      groupId: twilioCallSid || callId,
    },
    config: {
      ...sessionOptions.config,
      voice: voiceForCall,
      audio: {
        input: {
          transcription: { model: 'gpt-4o-transcribe', language: languageCode },
          turnDetection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            createResponse: true,
            interruptResponse: true,
          },
        },
        output: {
          voice: voiceForCall,
        },
      },
    },
  } as any);
  
  // Log tracing info for OpenAI dashboard visibility
  // Traces viewable at: platform.openai.com → Logs → Traces
  console.info(`[TRACING] Session created for ${effectiveSlug} v${agentConfig?.version || 'unknown'}`, {
    callId,
    twilioCallSid,
    agent: effectiveSlug,
  });
  
  // Store session for potential cleanup from conference events
  activeSessions.set(callId, session);
  const confName = getConferenceName(callId); // Uses wrapper with fallback to service cache
  if (confName) {
    conferenceNameToCallID[confName] = callId;
    // Note: caller-ready promise is created EARLIER in the incoming-call handler
    // to avoid race condition where customer joins before this code runs
    console.info(`[SESSION] Mapped conference ${confName} to callId ${callId}`);
  }

  session.on('history_added', (item: RealtimeItem) => logHistoryItem(item, callId));
  
  session.on('agent_handoff', (_context, fromAgent, toAgent) => {
    // NOTE: With single-agent architecture, AI-to-AI handoffs should NOT occur
    // This handler is kept for legacy compatibility but should log a warning
    console.warn(`[HANDOFF WARNING] Unexpected AI-to-AI handoff: ${fromAgent.name} → ${toAgent.name}`);
    console.warn('[HANDOFF WARNING] Single-agent architecture should use tools, not agent handoffs');
  });

  session.on('error', (event) => {
    console.error('[SESSION ERROR]', event.error);
  });

  // Debug: Track function call events
  session.transport.on('function_call', (event: any) => {
    console.info(`[TOOL CALL] Received function_call event: ${event.name}`, {
      callId: event.callId,
      arguments: event.arguments ? JSON.parse(event.arguments) : null,
    });
  });

  // Debug: Track tool execution
  session.on('agent_tool_start', (_context: any, _agent: any, tool: any, details: any) => {
    console.info(`[TOOL EXECUTION] Starting tool: ${tool.name}`, {
      toolCall: details.toolCall,
    });
  });

  session.on('agent_tool_end', (_context: any, _agent: any, tool: any, result: string, details: any) => {
    console.info(`[TOOL EXECUTION] Tool completed: ${tool.name}`, {
      resultLength: result?.length,
    });
  });

  // CRITICAL: Listen to raw transport events for transcripts
  // The SDK's history_added fires before transcription completes
  session.transport.on('*', (event: any) => {
    const eventType = event?.type;
    
    // Log specific events for debugging
    if (eventType === 'conversation.item.input_audio_transcription.completed') {
      const transcript = event?.transcript;
      const itemId = event?.item_id;
      logPHI(`${BRIGHT_GREEN}[CALLER TRANSCRIPT] ${transcript}${RESET}`);
      
      if (transcript) {
        // Persist transcript incrementally via coordinator (saves to DB immediately)
        // Try to get callLogId from metadata, or directly from coordinator by openAiCallId
        const callMeta = callMetadataForDB.get(callId);
        const callLogId = callMeta?.dbCallLogId;
        if (callLogId) {
          callLifecycleCoordinator.appendTranscript(callLogId, `CALLER: ${transcript}`);
        } else {
          // Fallback: try to append using openAiCallId (coordinator may have the mapping)
          callLifecycleCoordinator.appendTranscript(callId, `CALLER: ${transcript}`);
        }
        // Also keep in-memory for backward compatibility
        if (!callTranscripts.has(callId)) {
          callTranscripts.set(callId, []);
        }
        callTranscripts.get(callId)!.push(`CALLER: ${transcript}`);
        
        // AIRCALL WORKAROUND: Auto-press "1" to accept forwarded calls
        // AirCall plays "Press 1 to answer" when forwarding to external numbers
        // Detect this prompt and automatically send DTMF tone to accept the call
        const lowerTranscript = transcript.toLowerCase();
        if ((lowerTranscript.includes('press 1') || lowerTranscript.includes('aircall') || lowerTranscript.includes('air call')) && 
            !aircallDTMFSent.has(callId)) {
          console.log(`${BRIGHT_GREEN}[AIRCALL DETECTION] Detected AirCall prompt: "${transcript}"${RESET}`);
          console.log(`${BRIGHT_GREEN}[AIRCALL] Sending DTMF tone "1" to accept call${RESET}`);
          aircallDTMFSent.add(callId);
          
          // Send DTMF tone "1" using Twilio's participant update with announceUrl
          (async () => {
            try {
              const confName = getConferenceName(callId); // Uses wrapper with fallback
              if (!confName) {
                console.error('[AIRCALL] Cannot send DTMF - no conference name found');
                return;
              }
              
              const client = await getTwilioClient();
              const conferences = await client.conferences.list({ friendlyName: confName, limit: 1 });
              
              if (conferences.length === 0) {
                console.error('[AIRCALL] Cannot send DTMF - conference not found');
                return;
              }
              
              const conferenceSid = conferences[0].sid;
              const participants = await client.conferences(conferenceSid).participants.list();
              
              // Find the virtual agent participant (labeled "virtual agent")
              const agentParticipant = participants.find(p => p.label === 'virtual agent');
              
              if (agentParticipant) {
                const domain = process.env.DOMAIN || process.env.REPLIT_DEV_DOMAIN;
                await client.conferences(conferenceSid)
                  .participants(agentParticipant.callSid)
                  .update({ 
                    announceUrl: `https://${domain}/api/voice/aircall-dtmf`,
                    announceMethod: 'POST'
                  });
                
                console.log(`${BRIGHT_GREEN}[AIRCALL] ✓ DTMF tone "1" sent to conference${RESET}`);
              } else {
                console.error('[AIRCALL] Cannot send DTMF - virtual agent participant not found');
              }
            } catch (error) {
              console.error('[AIRCALL] Error sending DTMF:', error);
            }
          })();
        }
      }
    } else if (eventType === 'response.output_audio_transcript.done' || eventType === 'response.audio_transcript.done') {
      // Handle agent speech transcripts - OpenAI sends these for agent audio output
      const transcript = event?.transcript;
      logPHI(`${BRIGHT_GREEN}[AGENT TRANSCRIPT] ${transcript}${RESET}`);
      
      if (transcript) {
        // Persist transcript incrementally via coordinator (saves to DB immediately)
        const callMeta = callMetadataForDB.get(callId);
        const callLogId = callMeta?.dbCallLogId;
        if (callLogId) {
          callLifecycleCoordinator.appendTranscript(callLogId, `AGENT: ${transcript}`);
        } else {
          // Fallback: try to append using openAiCallId (coordinator may have the mapping)
          callLifecycleCoordinator.appendTranscript(callId, `AGENT: ${transcript}`);
        }
        // Also keep in-memory for backward compatibility
        if (!callTranscripts.has(callId)) {
          callTranscripts.set(callId, []);
        }
        callTranscripts.get(callId)!.push(`AGENT: ${transcript}`);
      }
    } else if (eventType === 'response.done') {
      // Also capture from response.done which contains output items
      const output = event?.response?.output;
      if (output && Array.isArray(output)) {
        output.forEach((item: any) => {
          if (item.type === 'message' && item.content) {
            item.content.forEach((content: any) => {
              if (content.type === 'audio' && content.transcript) {
                logPHI(`${BRIGHT_GREEN}[AGENT SPOKE] ${content.transcript}${RESET}`);
                if (!callTranscripts.has(callId)) {
                  callTranscripts.set(callId, []);
                }
                callTranscripts.get(callId)!.push(`AGENT: ${content.transcript}`);
              }
            });
          }
        });
      }
    }
    
    // console.log(`[RAW EVENT] ${eventType}`);
  });

  // Initialize call metadata for database logging (call log already created above)
  // Get agent version from registry for tracing
  const agentVersion = agentConfig?.version;
  
  callMetadataForDB.set(callId, {
    startTime: new Date(),
    agentSlug: effectiveSlug,
    agentVersion,
    from,
    to,
    transferredToHuman: false,
    dbCallLogId: callLogId, // Store the call log ID we created earlier
    audioInputMs: 0,
    audioOutputMs: 0,
  });

  try {
    const confNameForWait = getConferenceName(callId);
    // Grab the caller-ready promise NOW (before any async work) so we can await it later.
    // It was created in the no-IVR handler BEFORE the TwiML greeting started playing.
    // We must NOT delete it here — we need it after session.connect().
    let callerReadyPromise: Promise<void> | null = callerReadyPromises.get(confNameForWait ?? '') ?? null;
    if (confNameForWait && callerReadyPromise) {
      console.info(`[SESSION] Caller-ready promise found for ${confNameForWait} — will await before greeting`);
    }
    
    // STEP 1: Build accept payload using SDK's buildInitialConfig (full agent config)
    console.info(`[SESSION] CHECKPOINT D: Building accept payload... (T+${Date.now() - observeCallStart}ms)`);
    const BUILD_CONFIG_TIMEOUT_MS = 5000;
    let acceptPayload: any;
    try {
      const buildConfigPromise = OpenAIRealtimeSIP.buildInitialConfig(sessionAgent, sessionOptions, {
        voice: voiceForCall,
        audio: {
          input: {
            format: 'g711_ulaw',
            transcription: languageCode 
              ? { model: 'gpt-4o-transcribe', language: languageCode }
              : { model: 'gpt-4o-transcribe' },
            turnDetection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              createResponse: true,
              interruptResponse: true,
            },
          },
          output: {
            format: 'g711_ulaw',
            voice: voiceForCall,
          },
        },
      } as any);
      
      acceptPayload = await Promise.race([
        buildConfigPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`buildInitialConfig timed out after ${BUILD_CONFIG_TIMEOUT_MS}ms`)), BUILD_CONFIG_TIMEOUT_MS)),
      ]);
    } catch (buildError) {
      console.error(`[SESSION] FATAL: buildInitialConfig failed for ${callId}:`, buildError);
      throw buildError;
    }
    console.info(`[SESSION] CHECKPOINT E: Accept payload built, keys: ${JSON.stringify(Object.keys(acceptPayload || {}))}`);
    const tdCheck = (acceptPayload as any)?.audio?.input?.turn_detection;
    const audioFmt = (acceptPayload as any)?.audio?.input?.format;
    const outputFmt = (acceptPayload as any)?.audio?.output?.format;
    console.info(`[SESSION] Accept payload audit: turn_detection=${tdCheck ? 'YES' : 'MISSING'}, input_format=${JSON.stringify(audioFmt) || 'MISSING'}, output_format=${JSON.stringify(outputFmt) || 'MISSING'}`);
    
    if (!acceptPayload) acceptPayload = {};
    if (!acceptPayload.audio) acceptPayload.audio = {};
    if (!acceptPayload.audio.input) acceptPayload.audio.input = {};
    if (!acceptPayload.audio.output) acceptPayload.audio.output = {};
    
    if (!tdCheck) {
      console.error(`[SESSION] ⚠ turn_detection MISSING — injecting fallback!`);
      acceptPayload.audio.input.turn_detection = {
        type: 'semantic_vad',
        eagerness: 'medium',
        create_response: true,
        interrupt_response: true,
      };
    }
    if (!acceptPayload.audio.input.transcription) {
      acceptPayload.audio.input.transcription = {
        model: 'gpt-4o-transcribe',
        language: languageCode || 'en',
      };
    }
    if (!audioFmt || (typeof audioFmt === 'object' && audioFmt?.type === 'audio/pcm')) {
      console.error(`[SESSION] ⚠ Input audio format is PCM16 (wrong for SIP) — forcing G.711 μ-law!`);
      acceptPayload.audio.input.format = { type: 'audio/pcmu' };
    }
    if (!outputFmt || (typeof outputFmt === 'object' && outputFmt?.type === 'audio/pcm')) {
      console.error(`[SESSION] ⚠ Output audio format is PCM16 (wrong for SIP) — forcing G.711 μ-law!`);
      acceptPayload.audio.output.format = { type: 'audio/pcmu' };
    }
    console.info(`[SESSION] ✓ Final accept payload audio: input=${JSON.stringify(acceptPayload.audio.input.format)}, output=${JSON.stringify(acceptPayload.audio.output.format)}, td=${JSON.stringify(acceptPayload.audio.input.turn_detection)?.substring(0, 80)}`);
    
    // STEP 2: Accept the call via REST API with retry logic for 404 errors
    const MAX_ACCEPT_RETRIES = 8;
    const INITIAL_RETRY_DELAY_MS = 200;
    const MAX_RETRY_DELAY_MS = 3000;
    let lastError: string = '';
    let acceptSucceeded = false;
    
    CallDiagnostics.recordStage(callId, 'accept_started', true);
    const acceptStartTime = Date.now();
    
    for (let attempt = 0; attempt < MAX_ACCEPT_RETRIES; attempt++) {
      if (attempt > 0) {
        const baseDelay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
        const jitter = Math.random() * 100;
        const delayMs = Math.floor(baseDelay + jitter);
        console.info(`[SESSION] Retry ${attempt}/${MAX_ACCEPT_RETRIES - 1} for call ${callId} - waiting ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
      try {
        const acceptResponse = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(acceptPayload),
        });
        
        if (acceptResponse.ok) {
          const acceptLatencyMs = Date.now() - acceptStartTime;
          if (attempt > 0) {
            console.info(`[SESSION] ✓ Accept succeeded on retry ${attempt} for call ${callId} (total time: ~${acceptLatencyMs}ms)`);
          }
          CallDiagnostics.recordAcceptAttempt(callId, attempt + 1, MAX_ACCEPT_RETRIES, true, acceptResponse.status);
          CallDiagnostics.recordStage(callId, 'accept_completed', true, { 
            acceptLatencyMs, 
            attempts: attempt + 1 
          });
          acceptSucceeded = true;
          break;
        }
        
        lastError = await acceptResponse.text();
        
        if (acceptResponse.status !== 404) {
          console.error(`[SESSION] Non-retryable error ${acceptResponse.status} for call ${callId}: ${lastError}`);
          break;
        }
        
        console.warn(`[SESSION] ⚠️ Accept attempt ${attempt + 1}/${MAX_ACCEPT_RETRIES} failed with 404 for call ${callId}`);
        CallDiagnostics.recordAcceptAttempt(callId, attempt + 1, MAX_ACCEPT_RETRIES, false, acceptResponse.status, lastError);
        
      } catch (fetchError) {
        lastError = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.warn(`[SESSION] ⚠️ Accept fetch error on attempt ${attempt + 1}: ${lastError}`);
        CallDiagnostics.recordAcceptAttempt(callId, attempt + 1, MAX_ACCEPT_RETRIES, false, undefined, lastError);
      }
    }
    
    if (!acceptSucceeded) {
      const confName = getConferenceName(callId);
      let twilioCallSid = confName ? getTwilioCallSid(confName) : undefined;
      if (!twilioCallSid && confName) {
        const derived = confName.replace(/^(test_|outbound_)?conf_/, '');
        if (derived.startsWith('CA') && derived.length === 34) {
          twilioCallSid = derived;
        }
      }
      
      const domain = process.env.DOMAIN || 'dcf9f10f-5436-45b2-9ddd-3056216aaa94-00-10mvu4n0j43c2.worf.replit.dev';
      const hasValidCallSid = twilioCallSid && twilioCallSid.startsWith('CA') && twilioCallSid.length === 34;
      
      console.error(`[SESSION] ✗ All ${MAX_ACCEPT_RETRIES} accept attempts failed for call ${callId}`);
      console.error(`[SESSION] Last error: ${lastError}`);
      
      if (hasValidCallSid && confName) {
        try {
          const client = await getTwilioClient();
          const callerNumber = getCallerNumber(confName) || 
                               (from && from !== 'Unknown' ? from : undefined) || 
                               '+16263821543';
          const humanNumber = process.env.HUMAN_AGENT_NUMBER || '+18186021567';
          
          await client.calls(twilioCallSid!).update({
            twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We apologize, but we are experiencing technical difficulties connecting you to our assistant. Please hold while we transfer you to our answering service.</Say>
  <Pause length="2"/>
  <Dial callerId="${callerNumber}" timeout="30" action="https://${domain}/api/voice/fallback-complete">
    <Number>${humanNumber}</Number>
  </Dial>
  <Say voice="Polly.Joanna">We were unable to complete your call. Please try again later or call back during regular business hours. Goodbye.</Say>
  <Hangup/>
</Response>`
          });
          console.info(`[SESSION] ✓ Fallback to human agent initiated for ${twilioCallSid}`);
          CallDiagnostics.recordStage(callId, 'fallback_to_human', true, { twilioCallSid });
          CallDiagnostics.completeTrace(callId, 'handoff', 'Accept failed - transferred to human');
          
          if (callLogId) {
            try {
              await storage.updateCallLog(callLogId, {
                status: 'transferred',
                transferredToHuman: true,
                summary: `Accept failed after ${MAX_ACCEPT_RETRIES} attempts - transferred to human. Error: ${lastError.substring(0, 200)}`,
              });
            } catch (logError) {
              console.error(`[SESSION] Failed to update call log for fallback:`, logError);
            }
          }
          return;
        } catch (fallbackError) {
          console.error(`[SESSION] ✗ Conference-based fallback also failed:`, fallbackError);
        }
      }
      
      throw new Error(`Failed to accept call ${callId} after ${MAX_ACCEPT_RETRIES} attempts: ${lastError}`);
    }
    console.info(`[SESSION] ✓ Call ${callId} accepted via REST API (T+${Date.now() - observeCallStart}ms)`);
    
    // STEP 3: Connect WebSocket for event streaming (call already accepted via REST)
    CallDiagnostics.recordStage(callId, 'session_connect_started', true);
    const sessionConnectStart = Date.now();
    
    // Listen for raw transport events BEFORE connecting to capture session.created/updated
    // IMPORTANT: Use session.transport.on('*') — the SDK emits events through the transport's
    // EventEmitterDelegate, NOT through transport.eventEmitter.
    let sessionUpdatedResolve: (() => void) | null = null;
    const sessionUpdatedPromise = new Promise<void>((resolve) => {
      sessionUpdatedResolve = resolve;
      // Safety timeout — don't block forever if session.updated never arrives
      setTimeout(() => { resolve(); sessionUpdatedResolve = null; }, 3000);
    });

    session.transport.on('*', (event: any) => {
      const eventType = event?.type || 'unknown';
      if (eventType === 'session.created' || eventType === 'session.updated') {
        const sess = event?.session || {};
        const audioIn = sess?.audio?.input;
        const audioOut = sess?.audio?.output;
        const td = sess?.audio?.input?.turn_detection;
        console.info(`[SESSION] OpenAI ${eventType}: voice=${audioOut?.voice}, td=${JSON.stringify(td)?.substring(0, 80)}, audio_in=${JSON.stringify(audioIn?.format)}, audio_out=${JSON.stringify(audioOut?.format)}`);
        if (eventType === 'session.updated' && sessionUpdatedResolve) {
          console.info(`[SESSION] ✓ session.updated confirmed — safe to send response.create`);
          sessionUpdatedResolve();
          sessionUpdatedResolve = null;
        }
      } else if (eventType === 'error') {
        console.error(`[SESSION] OpenAI error for ${callId}:`, JSON.stringify(event).substring(0, 500));
      } else if (eventType === 'response.done') {
        const resp = event?.response;
        const statusDetails = resp?.status_details;
        console.info(`[SESSION] response.done for ${callId}: status=${resp?.status}, output_count=${resp?.output?.length || 0}${statusDetails ? `, details=${JSON.stringify(statusDetails).substring(0, 200)}` : ''}`);
      }
    });

    await session.connect({ apiKey: OPENAI_API_KEY!, callId });
    
    const connectDurationMs = Date.now() - sessionConnectStart;
    CallDiagnostics.recordStage(callId, 'session_connected', true, { 
      connectDurationMs,
      agent: effectiveSlug 
    });
    console.info(`[SESSION] ✓ Connected to realtime call ${callId} with agent: ${effectiveSlug}${agentVersion ? ` v${agentVersion}` : ''}`);
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3C: Await background DB operations NOW (after accept + connect)
    // The call is already live and processing audio. DB results are needed
    // only for metadata tracking, transcript persistence, and lifecycle mgmt.
    // If DB fails, the call continues — graceful degradation.
    // ═══════════════════════════════════════════════════════════════════════
    try {
      const dbResults = await backgroundDbOps;
      const dbOpsTotalMs = Date.now() - dbOpsStartTime;
      callLogId = dbResults.callLogId;
      agentId = dbResults.agentId;
      
      const existingMeta = callMetadataForDB.get(callId);
      if (existingMeta && callLogId) {
        existingMeta.dbCallLogId = callLogId;
        CallDiagnostics.recordStage(callId, 'db_backfill_complete', true, { dbOpsTotalMs, callLogId });
        console.info(`[DB-BG] ✓ Backfilled callLogId=${callLogId} into call metadata (DB ops took ${dbOpsTotalMs}ms, ran in background)`);
      } else if (!callLogId) {
        CallDiagnostics.recordStage(callId, 'db_backfill_complete', false, { dbOpsTotalMs }, 'no callLogId resolved');
        console.warn(`[DB-BG] No callLogId resolved — call continues without DB tracking (${dbOpsTotalMs}ms elapsed)`);
      }
    } catch (backfillErr) {
      const dbOpsTotalMs = Date.now() - dbOpsStartTime;
      console.error(`[DB-BG] Background DB ops failed after ${dbOpsTotalMs}ms — call continues without DB tracking:`, backfillErr);
      CallDiagnostics.recordStage(callId, 'db_backfill_complete', false, { dbOpsTotalMs }, 'backfill await threw');
    }
    
    // STEP 3D: Wait for session.updated BEFORE sending response.create.
    // session.connect() sends a session.update over WebSocket. If we fire response.create
    // before OpenAI acknowledges it, the response fails with status=failed.
    console.info(`[SESSION] Awaiting session.updated from OpenAI before greeting... (T+${Date.now() - observeCallStart}ms)`);
    await sessionUpdatedPromise;
    console.info(`[SESSION] ✓ Session ready (T+${Date.now() - observeCallStart}ms)`);

    // STEP 3E: Wait for caller to join the conference before triggering the greeting.
    // response.create fires audio INTO the conference room. If the caller has not joined yet
    // (they are still hearing TwiML), the AI speaks into an empty room.
    if (callerReadyPromise) {
      console.info(`[SESSION] Awaiting caller-ready signal — caller is still hearing TwiML greeting... (T+${Date.now() - observeCallStart}ms)`);
      const CALLER_READY_WAIT_MS = 8000;
      await Promise.race([
        callerReadyPromise,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            console.warn(`[SESSION] Caller-ready external timeout after ${CALLER_READY_WAIT_MS}ms — proceeding with greeting`);
            resolve();
          }, CALLER_READY_WAIT_MS)
        ),
      ]);
      console.info(`[SESSION] ✓ Caller is in the conference — triggering greeting now (T+${Date.now() - observeCallStart}ms)`);
      // Cleanup the maps — the promise has fired (or timed out)
      if (confNameForWait) {
        callerReadyPromises.delete(confNameForWait);
        callerReadyResolvers.delete(confNameForWait);
      }
      callerReadyPromise = null;
    }

    // STEP 4: Force the agent to speak first by sending response.create
    // ALWAYS send response.create — even when TwiML delivered the greeting audio.
    // Without this, the agent sits in listen-only mode and never speaks.
    const agentGreeting = metadata?.agentGreeting;
    
    if (agentGreeting && agentGreeting.trim() !== '') {
      console.info(`[SESSION] Triggering greeting via response.create: "${agentGreeting.substring(0, 50)}..."`);
      
      try {
        (session.transport as any).sendEvent({
          type: 'response.create',
          response: {
            instructions: `Say exactly this greeting to the caller: "${agentGreeting}" - Then wait for their response.`,
          },
        });
        console.info(`[SESSION] ✓ Greeting triggered for call ${callId}`);
        CallDiagnostics.recordStage(callId, 'first_audio_sent', true, { source: 'agent_greeting' });
      } catch (greetingError) {
        console.error(`[SESSION] Failed to trigger greeting:`, greetingError);
      }
    } else {
      console.info(`[SESSION] TwiML delivered greeting — sending response.create to activate agent for call ${callId}`);
      try {
        (session.transport as any).sendEvent({
          type: 'response.create',
          response: {
            instructions: `The caller just heard a TwiML greeting. They are on the line now. Listen for their response and engage naturally. If they haven't spoken yet, briefly let them know you're here to help.`,
          },
        });
        console.info(`[SESSION] ✓ Post-TwiML response.create sent for call ${callId}`);
        CallDiagnostics.recordStage(callId, 'first_audio_sent', true, { source: 'post_twiml_activation' });
      } catch (activationError) {
        console.error(`[SESSION] Failed to send post-TwiML activation:`, activationError);
        CallDiagnostics.recordStage(callId, 'first_audio_sent', true, { source: 'twiml_greeting_only' });
      }
    }
    
    // Keep session alive - don't return immediately
    // Wait for the session to end naturally (when user hangs up or handoff completes)
    // Add timeout to prevent hung sessions
    await new Promise((resolve) => {
      const sessionTimeout = setTimeout(() => {
        console.warn(`[SESSION] Timeout (10min) reached for call ${callId}, forcing cleanup`);
        // DIAGNOSTICS: Record timeout cleanup
        CallDiagnostics.recordStage(callId, 'timeout_cleanup', true, { reason: '10min_timeout' });
        CallDiagnostics.completeTrace(callId, 'timeout', 'Session timeout after 10 minutes');
        resolve(null);
      }, 10 * 60 * 1000); // 10 minute timeout
      
      const cleanup = (reason: string) => {
        clearTimeout(sessionTimeout);
        console.info(`[SESSION] ${reason} for call ${callId}, ending session`);
        // Notify coordinator that the OpenAI realtime session ended.
        // This avoids waiting for stale-call detection when conference callbacks are delayed/missed.
        try {
          callLifecycleCoordinator.handleOpenAiSessionEnded(callId);
        } catch (coordError) {
          console.error(`[SESSION] Failed to signal openai session end for ${callId}:`, coordError);
        }
        // DIAGNOSTICS: Record call completion
        CallDiagnostics.recordStage(callId, 'call_completed', true, { reason });
        CallDiagnostics.completeTrace(callId, 'success', reason);
        resolve(null);
      };
      
      session.on('error', (err: any) => {
        console.error(`[SESSION] Error event for call ${callId}:`, err);
        
        // Check if this is a non-fatal error that shouldn't terminate the session
        // These are specific error codes from session update attempts that don't affect the call
        const errorCode = err?.error?.error?.code || err?.error?.code || '';
        const nonFatalErrors = [
          'cannot_update_voice',            // Session update during active audio
          'unknown_parameter',               // Malformed session update structure
          'conversation_already_has_active_response' // Multiple responses in progress
        ];
        
        if (nonFatalErrors.includes(errorCode)) {
          console.warn(`[SESSION] Non-fatal error (${errorCode}) - session continues for call ${callId}`);
          // Don't cleanup - let the session continue
          return;
        }
        
        // Fatal error - terminate session
        cleanup('Fatal error event');
      });
      
      // Session will end when transport closes
      session.transport.on('close', () => {
        cleanup('Transport closed');
      });
    });
    
    console.info(`[SESSION] Call ${callId} ended, cleaning up...`);
    
  } catch (error) {
    console.error(`[SESSION ERROR] Failed to connect call ${callId}:`, error);
    throw error;
  } finally {
    // Update call log with transcript and final status when call actually ends
    const callMeta = callMetadataForDB.get(callId);
    if (callMeta?.dbCallLogId) {
      try {
        const transcript = callTranscripts.get(callId)?.join('\n') || '';
        const endTime = new Date();
        
        // CRITICAL: DO NOT save duration from OpenAI session - TWILIO IS THE SOURCE OF TRUTH
        // The Twilio status callback will provide the authoritative duration via CallDuration
        // We only save transcript and metadata here - duration comes from Twilio later
        
        await storage.updateCallLog(callMeta.dbCallLogId, {
          status: 'completed',
          endTime,
          // DO NOT SET DURATION HERE - Twilio status callback will set it
          // Setting it here with session time causes the 600s bug
          transcript,
          transferredToHuman: callMeta.transferredToHuman,
          humanAgentNumber: callMeta.transferredToHuman ? HUMAN_AGENT_NUMBER : undefined,
          // Mark as estimated until Twilio confirms
          costIsEstimated: true,
        });
        
        console.info(`[DB] Call log updated: ${callMeta.dbCallLogId}, Duration=AWAITING_TWILIO, Transferred: ${callMeta.transferredToHuman}`);
        console.info(`[DB] Transcript saved (${transcript.split('\n').length} lines)`);
        
        // Async: Calculate costs, grade call, and push to ticketing API (don't block call cleanup)
        // Store ALL required data before cleanup deletes the maps
        const asyncCallId = callId;
        const twilioCallSid = callMeta.twilioCallSid;
        const dbCallLogId = callMeta.dbCallLogId;
        const agentSlug = callMeta.agentSlug;
        const startTime = callMeta.startTime;
        const callerPhone = callMeta.from;
        const dialedNumber = callMeta.to;
        const transferredToHuman = callMeta.transferredToHuman;
        const savedTranscript = transcript; // Save transcript captured at call end
        // NOTE: Duration will be fetched from Twilio, not calculated here
        const savedEndTime = endTime;
        
        // Use setTimeout instead of setImmediate to give more time for transcription
        setTimeout(async () => {
          try {
            const { callCostService } = await import('./services/callCostService');
            const { callGradingService } = await import('./services/callGradingService');
            const { ticketingApiClient } = await import('../server/services/ticketingApiClient');
            const { storage } = await import('../server/storage');
            
            // Poll for transcript availability (max 15 seconds, check every 2 seconds)
            let finalTranscript = savedTranscript;
            const maxWaitMs = 15000;
            const pollIntervalMs = 2000;
            let waitedMs = 0;
            
            while (waitedMs < maxWaitMs) {
              await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
              waitedMs += pollIntervalMs;
              
              // Re-fetch from database to get latest transcript
              const callLog = await storage.getCallLog(dbCallLogId!);
              if (callLog?.transcript && callLog.transcript.length > savedTranscript.length) {
                finalTranscript = callLog.transcript;
                console.info(`[POST-CALL] Transcript updated (${callLog.transcript.split('\n').length} lines) after ${waitedMs}ms`);
              }
              
              // If we have a good transcript, stop waiting
              if (finalTranscript && finalTranscript.length > 100) {
                break;
              }
            }
            
            // Reconcile with Twilio to get REAL duration (after a delay to let Twilio finalize)
            // The session-based duration (durationSeconds) may be wrong (e.g., 600s timeout)
            // Twilio needs a few seconds to finalize call data after hangup
            if (twilioCallSid) {
              // Wait 5 seconds for Twilio to finalize call data
              await new Promise(resolve => setTimeout(resolve, 5000));
              
              const reconcileResult = await callCostService.reconcileTwilioCallData(dbCallLogId!, twilioCallSid);
              if (reconcileResult.success && !reconcileResult.skipped) {
                console.info(`[POST-CALL] Twilio reconcile: duration=${reconcileResult.actualDuration}s (TWILIO AUTHORITATIVE)`);
              } else if (reconcileResult.skipped) {
                console.info(`[POST-CALL] Twilio reconcile skipped: ${reconcileResult.twilioStatus}, duration=${reconcileResult.actualDuration}s - background service will retry`);
              }
            }
            
            // Calculate OpenAI costs based on current duration in database
            // (will be recalculated again when background service gets final Twilio data)
            await callCostService.recalculateOpenAICostFromDuration(dbCallLogId!);
            
            // Grade the call if we have a transcript
            let gradeResult: { qualityScore?: number; patientSentiment?: string; agentOutcome?: string } = {};
            if (finalTranscript && finalTranscript.length > 50) {
              const analysisResult = await callGradingService.gradeCall(dbCallLogId!, finalTranscript);
              if (analysisResult) {
                gradeResult = {
                  qualityScore: analysisResult.qualityScore,
                  patientSentiment: analysisResult.sentiment,
                  agentOutcome: analysisResult.agentOutcome,
                };
              }
            }
            
            console.info(`[POST-CALL] Cost and grading processed for ${dbCallLogId}`);
            
            // Push complete call data to ticketing API (for agents that create tickets)
            // GUARD: Only try to update if:
            // 1. We have a valid Twilio call SID
            // 2. The agent is one that creates tickets  
            // 3. The call actually connected (has meaningful transcript)
            // 4. The call has a ticket number (meaning a ticket was created during the call)
            const updatedCallLog = await storage.getCallLog(dbCallLogId!);
            const hasValidTicket = updatedCallLog?.ticketNumber && updatedCallLog.ticketNumber.trim().length > 0;
            const hasValidTranscript = finalTranscript && finalTranscript.length > 50;
            
            if (twilioCallSid && (agentSlug === 'after-hours' || agentSlug === 'no-ivr' || agentSlug === 'answering-service') && hasValidTicket && hasValidTranscript) {
              
              // Use shared retry utility for ticketing API updates
              const ticketResult = await withRetry(
                async () => {
                  const result = await ticketingApiClient.updateTicketCallData({
                    callSid: twilioCallSid,
                    recordingUrl: updatedCallLog?.recordingUrl || undefined,
                    transcript: finalTranscript || undefined,
                    callerPhone: callerPhone || undefined,
                    dialedNumber: dialedNumber || undefined,
                    agentUsed: agentSlug || undefined,
                    callStartTime: startTime?.toISOString(),
                    callEndTime: savedEndTime.toISOString(),
                    // Use duration from database (set by Twilio status callback)
                    callDurationSeconds: updatedCallLog?.duration || undefined,
                    humanHandoffOccurred: transferredToHuman,
                    qualityScore: gradeResult.qualityScore,
                    patientSentiment: gradeResult.patientSentiment,
                    agentOutcome: gradeResult.agentOutcome,
                  });
                  
                  if (!result.success) {
                    throw new Error(result.error || 'Unknown ticketing API error');
                  }
                  return result;
                },
                TICKETING_RETRY_CONFIG,
                `Ticketing API update for ${twilioCallSid}`
              );
              
              if (ticketResult.success) {
                console.info(`[POST-CALL] ✓ Ticketing API updated for ${twilioCallSid} (${ticketResult.attempts} attempts, ${ticketResult.totalTimeMs}ms)`);
              } else {
                console.error(`[POST-CALL] ✗ Ticketing API failed after ${ticketResult.attempts} attempts for ${twilioCallSid}`);
              }
            }
          } catch (postCallError) {
            console.error('[POST-CALL ERROR] Cost/grading/ticketing failed:', postCallError);
          }
        }, 3000); // Start async work 3 seconds after call cleanup begins
      } catch (dbError) {
        console.error('[DB ERROR] Failed to update call log:', dbError);
      }
    }
    
    // Clean up metadata and session
    activeSessions.delete(callId);
    callMetadataForDB.delete(callId);
    callTranscripts.delete(callId);
    
    // Clean up conference mappings to prevent stale entries
    // Use wrapper for restart recovery - may find session in service cache
    const conf = getConferenceName(callId);
    if (conf) {
      // Remove all conference-related mappings
      delete conferenceNameToCallID[conf];
      delete callIDtoConferenceNameMapping[callId];
      
      // Also clean up from durable service cache (using conference name)
      callSessionService.deleteSession(conf).catch(err => 
        console.error(`[CLEANUP] Failed to delete session from service cache:`, err)
      );
      
      // Also try to clean up by ConferenceSid if we stored it
      // (We don't have direct access to it here, so we iterate and clean up any that point to this callId)
      for (const key in conferenceNameToCallID) {
        if (conferenceNameToCallID[key] === callId) {
          delete conferenceNameToCallID[key];
        }
      }
    }
  }
}

// Setup voice agent routes on Express app
export function setupVoiceAgentRoutes(app: Express): void {
  // Apply cache control to all voice routes
  app.use('/api/voice', noCacheHeaders);
  
  // Rate limiting for Twilio webhooks (high volume) - applied selectively below
  // OpenAI realtime uses its own signature validation, no rate limit needed there
  
  // OpenAI webhook endpoint (OpenAI signature validation is handled internally)
  // NOTE: No Twilio validation or rate limiting here - uses OpenAI's own auth
  app.post("/api/voice/realtime", async (req, res) => {
    console.info(`[WEBHOOK] *** Endpoint hit! Headers present: openai-signature=${req.headers["openai-signature"] ? 'YES' : 'NO'}`);
    
    try {
      const signature = req.headers["openai-signature"] as string;
      
      // Debug: Log raw body type and content
      console.info(`[WEBHOOK] Body type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}, isEmpty: ${!req.body}`);
      
      // req.body is a Buffer from bodyParser.raw()
      // Convert to string for signature verification
      let bodyString: string;
      if (Buffer.isBuffer(req.body)) {
        bodyString = req.body.toString('utf-8');
      } else if (typeof req.body === 'string') {
        bodyString = req.body;
      } else if (req.body && typeof req.body === 'object') {
        bodyString = JSON.stringify(req.body);
      } else {
        console.error(`[WEBHOOK] ✗ Empty or invalid body received!`);
        res.status(400).json({ error: 'Empty body' });
        return;
      }

      console.info(`[WEBHOOK] Body length: ${bodyString.length}, Secret configured: ${WEBHOOK_SECRET ? 'YES (length: ' + WEBHOOK_SECRET.length + ')' : 'NO'}`);
      
      // Debug: Log first 200 chars of body (truncated for security)
      console.info(`[WEBHOOK] Body preview: ${bodyString.substring(0, 200)}...`);

      let event: any;
      try {
        event = await openai.webhooks.unwrap(
          bodyString,
          req.headers as Record<string, string>,
          WEBHOOK_SECRET!
        );
        console.info(`[WEBHOOK] ✓ Signature verified successfully`);
      } catch (unwrapError: any) {
        console.error(`[WEBHOOK] ✗ Signature verification FAILED:`, unwrapError.message);
        
        const whId = req.headers["webhook-id"];
        const whTs = req.headers["webhook-timestamp"];
        const whSig = req.headers["webhook-signature"];
        console.error(`[WEBHOOK] Debug: webhook-id=${whId}, webhook-timestamp=${whTs}, webhook-signature=${typeof whSig === 'string' ? whSig.substring(0, 10) + '...' : 'MISSING'}`);
        console.error(`[WEBHOOK] Debug: secret prefix=${WEBHOOK_SECRET?.substring(0, 6)}, secret length=${WEBHOOK_SECRET?.length}`);
        
        const crypto = await import('crypto');
        if (whId && whTs && WEBHOOK_SECRET) {
          try {
            const secretBytes = Buffer.from(WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
            const signedContent = `${whId}.${whTs}.${bodyString}`;
            const expectedSig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
            console.error(`[WEBHOOK] Debug: manual computed sig=v1,${expectedSig.substring(0, 10)}...`);
            console.error(`[WEBHOOK] Debug: received sig=${typeof whSig === 'string' ? whSig.substring(0, 14) + '...' : 'MISSING'}`);
            console.error(`[WEBHOOK] Debug: sigs match=${('v1,' + expectedSig) === whSig}`);
            
            if (('v1,' + expectedSig) === whSig) {
              console.info(`[WEBHOOK] Manual verification PASSED - SDK bug? Proceeding with parsed event`);
              event = JSON.parse(bodyString);
            } else {
              console.error(`[WEBHOOK] Manual verification also FAILED - webhook secret mismatch with OpenAI dashboard`);
              console.error(`[WEBHOOK] Headers:`, JSON.stringify(req.headers));
              res.status(401).json({ error: 'Signature verification failed', details: unwrapError.message });
              return;
            }
          } catch (manualError: any) {
            console.error(`[WEBHOOK] Manual verification error:`, manualError.message);
            console.error(`[WEBHOOK] Headers:`, JSON.stringify(req.headers));
            res.status(401).json({ error: 'Signature verification failed', details: unwrapError.message });
            return;
          }
        } else {
          console.error(`[WEBHOOK] Missing required webhook headers or secret`);
          console.error(`[WEBHOOK] Headers:`, JSON.stringify(req.headers));
          res.status(401).json({ error: 'Signature verification failed', details: unwrapError.message });
          return;
        }
      }

      const type = (event as any)?.type;

      if (type === "realtime.call.incoming") {
        const callId: string = (event as any)?.data?.call_id;
        const sipHeaders = (event as any)?.data?.sip_headers;

        console.info(`\n[WEBHOOK] Incoming call: ${callId}`);
        
        // Handle test webhooks from OpenAI dashboard (no real call_id)
        if (!callId) {
          console.info(`[WEBHOOK] Test webhook received (no call_id) - acknowledging`);
          res.json({ acknowledged: true, message: "Test webhook received successfully" });
          return;
        }

        // Check for existing task
        const existingTask = activeCallTasks.get(callId);
        if (existingTask) {
          res.json({ acknowledged: true, message: "Already processing" });
          return;
        }
        
        // START CALL DIAGNOSTICS TRACE
        CallDiagnostics.startTrace(callId, { openaiCallId: callId });
        CallDiagnostics.recordStage(callId, 'openai_webhook_received', true);

        // Parse SIP headers for metadata if available
        let conferenceNameFromSIP: string | undefined;
        let dialedPhoneNumber: string | undefined;
        let callerPhoneNumber: string | undefined;
        let agentSlugFromSIP: string | undefined;
        let sipDomain: string | undefined; // Domain from SIP URI for environment isolation check
        let callEnvironment: string | undefined; // Environment tag from originating server
        let contactIdFromSIP: string | undefined; // Campaign contact ID for outbound calls
        let campaignIdFromSIP: string | undefined; // Campaign ID for outbound calls
        
        // DEBUG: Log all SIP headers to see what OpenAI is actually sending
        if (Array.isArray(sipHeaders)) {
          console.info(`[WEBHOOK] SIP headers received (${sipHeaders.length}):`, 
            sipHeaders.map((h: any) => `${h.name}=${h.value?.substring(0, 50)}`).join(', '));
          
          const conferenceHeader = sipHeaders.find(
            (header: any) => header.name === "X-conferenceName"
          );
          conferenceNameFromSIP = conferenceHeader?.value;
          
          // Extract To/From headers for agent routing and caller ID
          const toHeader = sipHeaders.find((header: any) => header.name === "To" || header.name === "X-To");
          const fromHeader = sipHeaders.find((header: any) => header.name === "From" || header.name === "X-From");
          // X-CallerPhone is our custom header with the actual caller's phone (From/To are Twilio's numbers)
          const callerPhoneHeader = sipHeaders.find((header: any) => header.name === "X-CallerPhone");
          // X-agentSlug is our custom header to explicitly route to a specific agent (bypasses all lookups)
          const agentSlugHeader = sipHeaders.find((header: any) => header.name === "X-agentSlug");
          
          if (agentSlugHeader?.value) {
            agentSlugFromSIP = decodeURIComponent(agentSlugHeader.value);
            console.info(`[WEBHOOK] ✓ Agent slug from SIP header: ${agentSlugFromSIP}`);
          }
          
          // Extract contact/campaign IDs for outbound appointment confirmation calls
          const contactIdHeader = sipHeaders.find((header: any) => header.name === "X-contactId");
          const campaignIdHeader = sipHeaders.find((header: any) => header.name === "X-campaignId");
          if (contactIdHeader?.value) {
            contactIdFromSIP = decodeURIComponent(contactIdHeader.value);
            console.info(`[WEBHOOK] ✓ Contact ID from SIP header: ${contactIdFromSIP}`);
          }
          if (campaignIdHeader?.value) {
            campaignIdFromSIP = decodeURIComponent(campaignIdHeader.value);
            console.info(`[WEBHOOK] ✓ Campaign ID from SIP header: ${campaignIdFromSIP}`);
          }
          
          // CRITICAL: Extract X-Environment for cross-environment detection
          const envHeader = sipHeaders.find((header: any) => header.name === "X-Environment");
          if (envHeader?.value) {
            callEnvironment = decodeURIComponent(envHeader.value);
            console.info(`[WEBHOOK] Call originated from environment: ${callEnvironment}`);
          }
          
          if (toHeader?.value) {
            // Parse SIP URI: <sip:+16263821543@domain.example.com> or sip:+16263821543@domain.example.com
            // Strip angle brackets first, then extract phone number AND domain
            const cleanTo = toHeader.value.replace(/^<|>$/g, '').trim();
            const toMatch = cleanTo.match(/sip:([^@]+)@/) || cleanTo.match(/^(\+?\d+)$/);
            dialedPhoneNumber = toMatch ? toMatch[1] : cleanTo;
            
            // Extract domain for environment isolation check
            const domainMatch = cleanTo.match(/@([^>;\s]+)/);
            sipDomain = domainMatch ? domainMatch[1] : undefined;
            
            console.info(`[WEBHOOK] Dialed number from SIP: ${dialedPhoneNumber}${sipDomain ? `, domain: ${sipDomain}` : ''}`);
          }
          
          // Prefer X-CallerPhone (actual caller) over From header (Twilio's number)
          if (callerPhoneHeader?.value) {
            callerPhoneNumber = decodeURIComponent(callerPhoneHeader.value);
            console.info(`[WEBHOOK] Caller number from X-CallerPhone: ${callerPhoneNumber}`);
          } else if (fromHeader?.value) {
            // Fallback to From header for legacy flows
            const cleanFrom = fromHeader.value.replace(/^<|>$/g, '').trim();
            const fromMatch = cleanFrom.match(/sip:([^@]+)@/) || cleanFrom.match(/^(\+?\d+)$/);
            callerPhoneNumber = fromMatch ? fromMatch[1] : cleanFrom;
            console.info(`[WEBHOOK] Caller number from SIP From: ${callerPhoneNumber}`);
          }
          
          if (conferenceNameFromSIP) {
            callIDtoConferenceNameMapping[callId] = conferenceNameFromSIP;
            conferenceNameToCallID[conferenceNameFromSIP] = callId;
            console.info(`[WEBHOOK] Conference name from SIP: ${conferenceNameFromSIP}`);
            
            // Add correlation IDs to trace
            CallDiagnostics.addCorrelationId(callId, 'conferenceName', conferenceNameFromSIP);
            const extractedCallSid = conferenceNameFromSIP.replace(/^(test_|outbound_)?conf_/, '');
            if (extractedCallSid && extractedCallSid.startsWith('CA')) {
              CallDiagnostics.addCorrelationId(callId, 'twilioCallSid', extractedCallSid);
            }
            
            // DUAL-WRITE: Update session with OpenAI call ID for durability
            callSessionService.upsertSession(conferenceNameFromSIP, {
              openaiCallId: callId,
              state: 'connected',
              openaiSessionEstablished: true,
            }).catch(err => console.error(`[CALL SESSION] Failed to update session with OpenAI callId:`, err));
            
            // Cancel SIP watchdog - webhook arrived successfully
            cancelSIPWatchdog(conferenceNameFromSIP);
            
            // CRITICAL: Extract Twilio CallSid and map it to OpenAI callId
            // Conference name format: conf_CA123..., test_conf_CA123..., or outbound_conf_CA123...
            // This enables conference events to find sessions even with only ConferenceSid
            const twilioCallSid = conferenceNameFromSIP.replace(/^(test_|outbound_)?conf_/, '');
            if (twilioCallSid && twilioCallSid !== conferenceNameFromSIP) {
              conferenceNameToCallID[twilioCallSid] = callId;
              conferenceNameToCallID[conferenceNameFromSIP] = callId;
              
              // Add mappings to lifecycle coordinator for reliable termination detection
              // Use coordinator's existing record (registered via openAiCallId) to get callLogId
              const existingRecord = callLifecycleCoordinator.getCallByAnyId(callId);
              if (existingRecord) {
                callLifecycleCoordinator.addMapping(twilioCallSid, existingRecord.callLogId);
                callLifecycleCoordinator.addMapping(conferenceNameFromSIP, existingRecord.callLogId);
                console.info(`[WEBHOOK] ✓ Added coordinator mappings: ${twilioCallSid}, ${conferenceNameFromSIP} → ${existingRecord.callLogId}`);
              } else {
                // Webhook arrived before call was registered - queue pending mappings
                // They will be applied when registerCall is called with this openAiCallId
                callLifecycleCoordinator.queuePendingMapping(callId, twilioCallSid);
                callLifecycleCoordinator.queuePendingMapping(callId, conferenceNameFromSIP);
                console.info(`[WEBHOOK] Queued pending mappings for callId: ${callId} (call not yet registered)`);
              }
              
              console.info(`[WEBHOOK] ✓ Mapped Twilio CallSid and conf name to OpenAI callId:`);
              console.info(`  - ${twilioCallSid} → ${callId}`);
              console.info(`  - ${conferenceNameFromSIP} → ${callId}`);
            }
          }
        }

        // ENVIRONMENT ISOLATION CHECK: Verify webhook is for this environment
        // Uses X-Environment header (set by originating server) for detection
        // NOTE: We log but DO NOT reject - if OpenAI only has one webhook URL configured,
        // rejecting would cause the call to fail with no fallback. The real fix is separate
        // OpenAI projects with separate webhook secrets per environment.
        const currentEnv = process.env.APP_ENV || 'development';
        if (callEnvironment && callEnvironment !== currentEnv) {
          console.error(`[WEBHOOK] ════════════════════════════════════════════════════════════`);
          console.error(`[WEBHOOK] ⚠️ ENVIRONMENT MISMATCH DETECTED`);
          console.error(`[WEBHOOK] Call originated from: ${callEnvironment}`);
          console.error(`[WEBHOOK] This server is: ${currentEnv}`);
          console.error(`[WEBHOOK] Processing anyway - rejection would break the call.`);
          console.error(`[WEBHOOK] ═══════════════════════════════════════════════════════════`);
          console.error(`[WEBHOOK] TO FIX: Configure separate OpenAI projects per environment.`);
          console.error(`[WEBHOOK] 1. Create separate OpenAI project for ${currentEnv}`);
          console.error(`[WEBHOOK] 2. Set its webhook URL to this server's domain`);
          console.error(`[WEBHOOK] 3. Add OPENAI_WEBHOOK_SECRET_DEV secret in Replit`);
          console.error(`[WEBHOOK] See ENVIRONMENT_ISOLATION.md for detailed setup.`);
          console.error(`[WEBHOOK] ════════════════════════════════════════════════════════════`);
          // Continue processing - the call would fail otherwise
        }

        // Check if this is a test call with metadata
        // Use conference name to retrieve metadata since callId might be different
        const metadata = conferenceNameFromSIP ? callMetadata.get(conferenceNameFromSIP) : callMetadata.get(callId);
        
        // AGENT ROUTING: Priority order for inbound calls
        // 1. X-agentSlug SIP header (most reliable - works across servers)
        // 2. Metadata from in-memory store (only works on same server)
        // 3. Phone number lookup
        // 4. Default to after-hours (IVR-based calls) - no-ivr uses dedicated endpoint
        
        // Valid inbound agents (strict allowlist)
        const validInboundAgents = ['no-ivr', 'after-hours', 'answering-service'];
        const validOutboundAgents = ['drs-scheduler', 'appointment-confirmation', 'fantasy-football'];
        const legacyDeletedAgents = ['greeter', 'non-urgent-ticketing'];
        
        let agentSlug = 'after-hours'; // Default for IVR-based inbound calls
        
        // PRIORITY 1: Check SIP header for agent slug (works even when servers don't share memory)
        if (agentSlugFromSIP) {
          // Coerce legacy slugs to after-hours
          if (legacyDeletedAgents.includes(agentSlugFromSIP)) {
            agentSlug = 'after-hours';
            console.info(`[WEBHOOK] Coercing legacy SIP header slug '${agentSlugFromSIP}' → 'after-hours'`);
          } else {
            agentSlug = agentSlugFromSIP;
            console.info(`[WEBHOOK] ✓ Using agent from SIP header: ${agentSlug}`);
          }
        } else {
          // PRIORITY 2: Check metadata for explicitly set agent (e.g., no-ivr bypass on same server)
          const configuredSlug = metadata?.agentSlug;
          
          if (configuredSlug === 'no-ivr') {
            agentSlug = 'no-ivr';
            console.info(`[WEBHOOK] ✓ Using no-ivr agent from metadata (IVR bypassed)`);
          } else if (configuredSlug === 'after-hours') {
            agentSlug = 'after-hours';
            console.info(`[WEBHOOK] ✓ Using after-hours agent from metadata (IVR flow)`);
          } else if (configuredSlug && validOutboundAgents.includes(configuredSlug)) {
            agentSlug = configuredSlug;
            console.info(`[WEBHOOK] ✓ Using outbound agent from metadata: ${agentSlug}`);
          } else if (configuredSlug && legacyDeletedAgents.includes(configuredSlug)) {
            agentSlug = 'after-hours';
            console.info(`[WEBHOOK] Coercing legacy metadata slug '${configuredSlug}' → 'after-hours'`);
          }
        }
        
        // For phone-based routing, use stored conference mapping (SIP dialed number is project ID, not real phone)
        // Use wrapper for restart recovery
        const realDialedNumber = conferenceNameFromSIP ? getCalledNumber(conferenceNameFromSIP) : null;
        if (realDialedNumber && agentSlug === 'after-hours') {
          try {
            // TIMING FIX: Race the DB lookup against a 500ms timeout.
            // A Neon serverless cold-start can take 2-10 seconds; without the timeout that
            // blocking await consumed the entire OpenAI SIP accept window BEFORE observeCall()
            // was ever called, causing dead air on every call after a cold start.
            // Warm DB connections (~5-50 ms) still resolve in time for correct routing;
            // cold starts fall back to 'after-hours' immediately.
            const PHONE_LOOKUP_TIMEOUT_MS = 500;
            const agentByPhone = await Promise.race([
              storage.getAgentByPhoneNumber(realDialedNumber),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), PHONE_LOOKUP_TIMEOUT_MS)),
            ]);
            // Only use phone-based routing for valid non-legacy agents
            if (agentByPhone && !legacyDeletedAgents.includes(agentByPhone.slug)) {
              agentSlug = agentByPhone.slug;
              console.info(`[WEBHOOK] ✓ Agent found by phone number: ${realDialedNumber} → ${agentSlug}`);
            }
          } catch (lookupError) {
            console.error(`[WEBHOOK] Agent lookup by phone failed:`, lookupError);
          }
        }
        
        // Pass full metadata including language, agentGreeting, and ivrSelection for proper agent configuration
        // Agent speaks greeting naturally per its instructions (no orchestration needed)
        // PRIORITY: SIP headers override callMetadata (SIP is more reliable for outbound calls)
        const fullMetadata = { 
          campaignId: campaignIdFromSIP || metadata?.campaignId, 
          contactId: contactIdFromSIP || metadata?.contactId,
          language: metadata?.language,
          agentGreeting: metadata?.agentGreeting,
          ivrSelection: metadata?.ivrSelection,
        };
        
        if (conferenceNameFromSIP && metadata) {
          console.info(`[WEBHOOK] Retrieved metadata for conference: ${conferenceNameFromSIP}`, metadata);
        }
        
        // Log outbound campaign context if present
        if (fullMetadata.contactId || fullMetadata.campaignId) {
          console.info(`[WEBHOOK] ✓ Outbound campaign context: contactId=${fullMetadata.contactId}, campaignId=${fullMetadata.campaignId}`);
        }

        // Voice/language config determined by IVR selection: option 4 = Spanish (coral), otherwise English (sage)
        // These settings are passed to observeCall and applied via session.connect()
        const isSpanishCall = metadata?.ivrSelection === '4' || metadata?.language === 'spanish';
        const voiceForCall = isSpanishCall ? 'coral' : 'sage';
        const languageForCall = isSpanishCall ? 'es' : 'en';
        console.info(`[WEBHOOK] Creating session for call: ${callId} with voice=${voiceForCall}, language=${languageForCall}`);
        
        // Extend metadata with voice/language settings and caller info for session configuration
        const extendedMetadata = {
          ...fullMetadata,
          voiceForCall,
          languageForCall,
          // Pass caller info from SIP headers for reliable call log creation
          callerPhoneFromSIP: callerPhoneNumber,
          // CRITICAL: Only use realDialedNumber (from mapping) - dialedPhoneNumber from SIP is project ID, not phone
          // Don't fall back to dialedPhoneNumber as it's like "proj_fsAu2Z4CM..." which fails ticketing validation
          dialedPhoneFromSIP: realDialedNumber || undefined,
          twilioCallSidFromSIP: conferenceNameFromSIP?.replace(/^(test_|outbound_)?conf_/, ''),
          conferenceNameFromSIP,
        };
        
        // FINAL VALIDATION: Ensure only valid agents are used (strict enforcement)
        const allValidAgents = [...validInboundAgents, ...validOutboundAgents];
        if (!allValidAgents.includes(agentSlug)) {
          console.warn(`[WEBHOOK] ⚠️ Invalid agent slug '${agentSlug}' - coercing to 'after-hours' (strict enforcement)`);
          agentSlug = 'after-hours';
        }
        
        console.info(`[WEBHOOK] ✓ Final agent selection: ${agentSlug}`);
        
        // observeCall performs: buildInitialConfig → REST accept (8 retries) → session.connect()
        const task = observeCall(callId, agentSlug, extendedMetadata);
        activeCallTasks.set(callId, task);

        task.catch((error) => {
          console.error(`[SESSION] Error in session for call ${callId}:`, error);
          // Record failure in diagnostics
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('accept') || errorMsg.includes('call_id_not_found')) {
            CallDiagnostics.completeTrace(callId, 'accept_failed', errorMsg);
          } else if (errorMsg.includes('Connection') || errorMsg.includes('database') || errorMsg.includes('DB')) {
            CallDiagnostics.completeTrace(callId, 'db_error', errorMsg);
          } else {
            CallDiagnostics.completeTrace(callId, 'unknown', errorMsg);
          }
        }).finally(() => {
          activeCallTasks.delete(callId);
          // Clean up metadata (both callId and conference name)
          callMetadata.delete(callId);
          // Clean up memory leak: aircallDTMFSent tracking
          aircallDTMFSent.delete(callId);
          if (conferenceNameFromSIP) {
            callMetadata.delete(conferenceNameFromSIP);
            // Clean up memory leak: pendingConferenceAgentAdditions
            pendingConferenceAgentAdditions.delete(conferenceNameFromSIP);
            // Clean up caller ready tracking
            callerReadyPromises.delete(conferenceNameFromSIP);
            callerReadyResolvers.delete(conferenceNameFromSIP);
          }
          console.info(`[SESSION] Call ${callId} finalized`);
        });

        res.json({ acknowledged: true });
      } else if (type === "realtime.call.disconnected") {
        // Fallback cleanup mechanism - ensure session cleanup when OpenAI notifies call ended
        const callId: string = (event as any)?.data?.call_id;
        console.info(`[WEBHOOK] Call disconnected: ${callId}`);
        
        const session = activeSessions.get(callId);
        if (session) {
          try {
            console.info(`[WEBHOOK] Closing session transport for disconnected call: ${callId}`);
            session.transport.close();
            console.info(`[WEBHOOK] ✓ Session transport closed via disconnected event`);
          } catch (error) {
            console.error(`[WEBHOOK] ✗ Error closing session transport ${callId}:`, error);
          }
        }
        
        res.json({ acknowledged: true });
      } else {
        // Other event types
        console.info(`[WEBHOOK] Unhandled event type: ${type}`);
        res.json({ acknowledged: true });
      }
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        console.error("[WEBHOOK] Invalid signature - check OPENAI_WEBHOOK_SECRET matches OpenAI dashboard");
        console.error("[WEBHOOK] Secret length configured:", WEBHOOK_SECRET?.length || 0);
        res.status(401).json({ error: "Invalid signature" });
      } else {
        console.error("[WEBHOOK ERROR]", error instanceof Error ? error.message : error);
        console.error("[WEBHOOK ERROR STACK]", error instanceof Error ? error.stack : 'no stack');
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Test call webhook endpoint - handles test calls with metadata
  app.post("/api/voice/test/incoming", async (req, res) => {
    // Parse Twilio's URL-encoded body (same as inbound call endpoint)
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    
    // Extract metadata from query parameters
    const agentSlug = req.query.agentSlug as string;
    const campaignId = req.query.campaignId as string | undefined;
    const contactId = req.query.contactId as string | undefined;

    console.info(`\n[TEST CALL] Incoming: ${callSid} from ${callerIDNumber}`);
    console.info(`[TEST CALL] Agent: ${agentSlug}, Campaign: ${campaignId || 'N/A'}, Contact: ${contactId || 'N/A'}`);

    const conferenceName = `test_conf_${callSid}`;
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // DUAL-WRITE: Persist to PostgreSQL for durability across restarts
    callSessionService.upsertSession(conferenceName, {
      twilioCallSid: callSid,
      callerNumber: callerIDNumber,
      callToken: callToken,
      agentSlug: agentSlug,
      state: 'initializing',
    }).catch(err => console.error(`[CALL SESSION] Failed to persist test call session:`, err));

    const domain = process.env.DOMAIN || req.get('host');

    // Set agent-specific greetings for test calls
    let agentGreeting: string | undefined;
    switch (agentSlug) {
      case 'drs-scheduler':
        agentGreeting = "Hi, this is the Azul Vision scheduling assistant. I'm here to help you schedule a diabetic retinopathy screening appointment. Is now a good time to get you scheduled?";
        break;
      case 'appointment-confirmation':
        agentGreeting = "Hi, this is Azul Vision calling to confirm your upcoming appointment. Do you have a moment?";
        break;
      case 'after-hours':
        agentGreeting = WELCOME_GREETING;
        break;
      case 'no-ivr':
        agentGreeting = ""; // No-IVR uses TwiML greeting, agent listens first
        break;
      default:
        agentGreeting = undefined; // Use default
    }

    try {
      // Store metadata by conference name AND callSid for reliable retrieval
      // Conference name is how we'll retrieve it when OpenAI webhook arrives
      callMetadata.set(conferenceName, { agentSlug, campaignId, contactId, agentGreeting });
      callMetadata.set(callSid, { agentSlug, campaignId, contactId, agentGreeting });
      
      console.info(`[TEST CALL] Metadata stored for conference: ${conferenceName}`);

      // Add OpenAI as SIP participant to the conference (same as inbound call flow)
      (async () => {
        try {
          if (!OPENAI_PROJECT_ID) {
            throw new Error('OPENAI_PROJECT_ID not configured');
          }

          const client = await getTwilioClient();
          
          console.info(`[TEST CALL] Adding OpenAI participant to conference: ${conferenceName}`);

          // Build SIP URI with agent routing headers
          const sipUri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=${encodeURIComponent(agentSlug)}`;
          
          await client
            .conferences(conferenceName)
            .participants.create({
              from: envConfig.twilio.phoneNumber!,
              label: "virtual agent",
              to: sipUri,
              earlyMedia: false,
              callToken: callToken,
              conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
              conferenceStatusCallbackEvent: ['join']
            });
          
          console.info(`[TEST CALL] ✓ OpenAI participant successfully added to conference: ${conferenceName}`);
        } catch (error) {
          console.error('[TEST CALL] ✗ ERROR creating OpenAI participant:', error);
        }
      })();

      const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference 
      startConferenceOnEnter="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

      res.setHeader("Content-Type", "application/xml");
      res.send(twimlResponse);
    } catch (error) {
      console.error('[TEST CALL ERROR]', error);
      res.status(500).send('Error processing test call');
    }
  });

  // Twilio Programmable Voice webhook - receives incoming calls FIRST
  // This must be configured as the Voice URL in Twilio Number settings
  // IVR Menu - Initial incoming call handler with auto-attendant
  // NOW WITH AGENT-BASED ROUTING: Checks database for assigned agent and routes accordingly
  // Security: Twilio signature validation + rate limiting
  app.post("/api/voice/incoming-call", webhookRateLimiter, async (req, res) => {
    // Parse Twilio's URL-encoded body (req.body is Buffer from raw parser)
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[IVR] ✓ Incoming call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callToken || !callerIDNumber) {
      console.error('[IVR] ✗ Missing required parameters in webhook');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }

    // Store call data for use after IVR selection
    const conferenceName = `conf_${callSid}`;
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;

    // DUAL-WRITE: Persist to PostgreSQL for durability across restarts
    callSessionService.upsertSession(conferenceName, {
      twilioCallSid: callSid,
      callerNumber: callerIDNumber,
      calledNumber: dialedNumber,
      callToken: callToken,
      state: 'initializing',
    }).catch(err => console.error(`[CALL SESSION] Failed to persist IVR call session:`, err));

    const domain = process.env.DOMAIN || req.get('host');
    console.info(`[IVR] Using domain for callbacks: ${domain} (DOMAIN env: ${process.env.DOMAIN ? 'SET' : 'NOT SET'})`);

    // AGENT-BASED ROUTING: Check if this phone number is assigned to a No-IVR agent
    // If so, skip the IVR menu and route directly to the agent
    try {
      const assignedAgent = await storage.getAgentByPhoneNumber(dialedNumber);
      if (assignedAgent && assignedAgent.slug === 'no-ivr') {
        console.info(`[IVR] Phone ${dialedNumber} assigned to no-ivr agent - bypassing IVR menu`);
        
        // Store metadata for no-ivr agent
        // AI agent delivers the full greeting via response.create — no long TwiML greeting
        const noIvrGreeting = WELCOME_GREETING;
        callMetadata.set(conferenceName, {
          agentSlug: 'no-ivr',
          agentGreeting: noIvrGreeting,
          language: 'english',
          ivrSelection: undefined,
        } as any);
        const extendedMeta = callMetadata.get(conferenceName) as any;
        if (extendedMeta) {
          extendedMeta.voiceForCall = 'sage';
          extendedMeta.languageForCall = 'en';
        }
        
        // CRITICAL: Create caller-ready promise BEFORE customer joins conference
        const callerReadyPromise = new Promise<void>((resolve) => {
          callerReadyResolvers.set(conferenceName, resolve);
          setTimeout(() => {
            if (callerReadyResolvers.has(conferenceName)) {
              console.warn(`[IVR] Caller-ready timeout (10s) for ${conferenceName}, proceeding anyway`);
              callerReadyResolvers.delete(conferenceName);
              resolve();
            }
          }, 10000);
        });
        callerReadyPromises.set(conferenceName, callerReadyPromise);
        console.info(`[IVR] Caller-ready promise created EARLY for conference: ${conferenceName}`);

        // Minimal TwiML: brief hold message then immediately join conference
        // AI agent delivers the full greeting via response.create once caller is in the conference
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while we connect you.</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

        res.setHeader("Content-Type", "application/xml");
        res.send(twimlResponse);
        console.info(`[IVR] ✓ Routed directly to no-ivr agent (bypassed IVR)`);
        
        // Add AI agent to conference via OpenAI SIP with watchdog retry/fallback
        // CRITICAL: Pass 'no-ivr' as agentSlug so webhook routes to correct agent
        addSIPParticipantWithWatchdog(conferenceName, callerIDNumber, callToken!, domain!, callSid!, 'no-ivr');
        
        return;
      }
    } catch (lookupError) {
      console.error(`[IVR] Agent lookup by phone failed (continuing with IVR):`, lookupError);
    }

    // IVR Menu with professional auto-attendant
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Azul Vision. All of our offices are currently closed. If this is a medical emergency, please hang up and dial 9 1 1.</Say>
  <Pause length="1"/>
  <Gather numDigits="1" action="https://${domain}/api/voice/ivr-selection?callSid=${callSid}" method="POST" timeout="10">
    <Say voice="Polly.Joanna">Please listen carefully as our menu options have changed.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna">For appointment related inquiries, including scheduling, rescheduling, cancellations, or medication refill requests, press 1.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna">For urgent medical concerns such as sudden vision loss, flashes of light, floaters, eye injuries, or severe pain, press 2.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna">If you are a healthcare provider, hospital, or calling from a doctor's office, press 3.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Lupe" language="es-US">Para español, oprima el número cuatro.</Say>
  </Gather>
  <Say voice="Polly.Joanna">We did not receive your selection. Please call back and try again. Goodbye.</Say>
  <Hangup/>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
    console.info(`[IVR] ✓ IVR menu sent for call: ${callSid}`);
  });

  // NO-IVR DIRECT ENDPOINT - Bypasses IVR menu entirely
  // Configure this as the Voice URL for a test Twilio number
  // The AI agent will answer immediately and determine caller type/urgency through conversation
  app.post("/api/voice/no-ivr", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[NO-IVR] ✓ Direct call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callToken || !callerIDNumber) {
      console.error('[NO-IVR] ✗ Missing required parameters');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    
    // Store mappings
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // DUAL-WRITE: Persist to PostgreSQL for durability across restarts
    callSessionService.upsertSession(conferenceName, {
      twilioCallSid: callSid,
      callerNumber: callerIDNumber,
      calledNumber: dialedNumber,
      callToken: callToken,
      agentSlug: 'no-ivr',
      state: 'initializing',
    }).catch(err => console.error(`[CALL SESSION] Failed to persist no-ivr call session:`, err));
    
    // Store metadata for no-ivr agent
    // AI agent delivers the full greeting via response.create — no long TwiML greeting
    const noIvrGreeting = WELCOME_GREETING;
    callMetadata.set(conferenceName, {
      agentSlug: 'no-ivr',
      agentGreeting: noIvrGreeting,
      language: 'english',
      ivrSelection: undefined,
    } as any);
    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = 'sage';
      extendedMeta.languageForCall = 'en';
    }

    console.info(`[NO-IVR] Routing directly to no-ivr agent (no IVR menu, voice=sage, lang=en)`);

    // CRITICAL: Create caller-ready promise BEFORE sending TwiML response.
    // Minimal TwiML (~2s) gets caller into conference fast. AI agent delivers greeting.
    const callerReadyPromise = new Promise<void>((resolve) => {
      callerReadyResolvers.set(conferenceName, resolve);
      setTimeout(() => {
        if (callerReadyResolvers.has(conferenceName)) {
          console.warn(`[NO-IVR] Caller-ready timeout (10s) for ${conferenceName} — proceeding anyway`);
          callerReadyResolvers.delete(conferenceName);
          resolve();
        }
      }, 10000);
    });
    callerReadyPromises.set(conferenceName, callerReadyPromise);
    console.info(`[NO-IVR] Caller-ready promise created for: ${conferenceName}`);

    // Minimal TwiML: brief hold message then immediately join conference
    // AI agent delivers the full greeting via response.create once caller is in the conference
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while we connect you.</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
    console.info(`[NO-IVR] ✓ Caller joined conference: ${conferenceName}`);
    
    // Ensure Twilio client is initialized with proper error handling
    try {
      if (!twilioClient) {
        twilioClient = await getTwilioClient();
      }
    } catch (twilioInitError) {
      console.error(`[NO-IVR] ✗ Failed to initialize Twilio client:`, twilioInitError);
      console.error(`[NO-IVR] Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables`);
      return;
    }
    
    // Add AI agent to conference via OpenAI SIP
    // This triggers OpenAI to send the webhook - we MUST accept quickly in the webhook handler
    // CRITICAL: Pass X-conferenceName so webhook can find stored metadata (agentSlug, etc.)
    // Also pass X-CallerPhone since the SIP From header is the Twilio number, not the actual caller
    console.info(`[NO-IVR] Adding no-ivr agent to conference: ${conferenceName}`);
    
    try {
      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=no-ivr`,
          earlyMedia: true,
          callToken: ConferenceNametoCallTokenMapping[conferenceName],
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[NO-IVR] ✓ No-IVR agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[NO-IVR] ✗ Failed to add agent to conference:`, error);
    }
  });

  // DEV NO-IVR ENDPOINT - Development version of no-ivr agent
  // Configure a separate Twilio number to hit this endpoint for dev testing
  // This keeps dev and prod traffic completely separate
  app.post("/api/voice/dev-no-ivr", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[DEV-NO-IVR] ✓ Dev call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callToken || !callerIDNumber) {
      console.error('[DEV-NO-IVR] ✗ Missing required parameters');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    
    // Store mappings
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // Store metadata for dev-no-ivr agent
    const devNoIvrGreeting = "";
    callMetadata.set(conferenceName, {
      agentSlug: 'dev-no-ivr',
      agentGreeting: devNoIvrGreeting,
      language: 'english',
      ivrSelection: undefined,
    } as any);
    
    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = 'sage';
    }

    console.info(`[DEV-NO-IVR] Routing to dev-no-ivr agent (dev testing, voice=sage, lang=auto-detect)`);

    // Same greeting as production
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Development environment. Thank you for calling Azul Vision. All of our offices are currently closed. You have reached the after hours call service.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">If this is a medical emergency, please dial 9 1 1.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">All calls are recorded for quality assurance purposes.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">How can I help you?</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
    console.info(`[DEV-NO-IVR] ✓ Caller joined conference: ${conferenceName}`);
    
    // Ensure Twilio client is initialized
    try {
      if (!twilioClient) {
        twilioClient = await getTwilioClient();
      }
    } catch (twilioInitError) {
      console.error(`[DEV-NO-IVR] ✗ Failed to initialize Twilio client:`, twilioInitError);
      return;
    }
    
    // Add AI agent to conference via OpenAI SIP
    console.info(`[DEV-NO-IVR] Adding dev-no-ivr agent to conference: ${conferenceName}`);
    
    try {
      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=dev-no-ivr`,
          earlyMedia: true,
          callToken: ConferenceNametoCallTokenMapping[conferenceName],
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[DEV-NO-IVR] ✓ Dev-no-ivr agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[DEV-NO-IVR] ✗ Failed to add agent to conference:`, error);
    }
  });

  // ANSWERING SERVICE ENDPOINT - Daytime overflow calls
  // For patients who have been on hold 3+ minutes
  // Routes to Optical, Tech, or Surgery departments
  app.post("/api/voice/answering-service", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[ANSWERING-SERVICE] ✓ Overflow call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callToken || !callerIDNumber) {
      console.error('[ANSWERING-SERVICE] ✗ Missing required parameters');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    
    // Store mappings
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // Store metadata for answering-service agent
    callMetadata.set(conferenceName, {
      agentSlug: 'answering-service',
      agentGreeting: '',
      language: 'english',
      ivrSelection: undefined,
    } as any);
    
    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = 'sage';
      extendedMeta.languageForCall = 'en'; // Use agent config language - prevents auto-detect issues
    }

    console.info(`[ANSWERING-SERVICE] Routing to answering-service agent (overflow, voice=sage, lang=en)`);

    // Overflow greeting - acknowledges the wait
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Azul Vision, we apologize for the wait.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">All of our staff members are currently busy. I can assist by taking a message and creating a ticket for resolution.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">How may I help you today?</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
    console.info(`[ANSWERING-SERVICE] ✓ Caller joined conference: ${conferenceName}`);
    
    try {
      if (!twilioClient) {
        twilioClient = await getTwilioClient();
      }
    } catch (twilioInitError) {
      console.error(`[ANSWERING-SERVICE] ✗ Failed to initialize Twilio client:`, twilioInitError);
      return;
    }
    
    console.info(`[ANSWERING-SERVICE] Adding answering-service agent to conference: ${conferenceName}`);
    
    try {
      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=answering-service`,
          earlyMedia: true,
          callToken: ConferenceNametoCallTokenMapping[conferenceName],
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[ANSWERING-SERVICE] ✓ Answering-service agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[ANSWERING-SERVICE] ✗ Failed to add agent to conference:`, error);
    }
  });

  // APPOINTMENT CONFIRMATION ENDPOINT - Inbound calls for appointment confirmation
  // Point a Twilio phone number to this webhook for the appointment confirmation agent
  // Also handles patient callbacks from voicemails left during outbound campaign
  app.post("/api/voice/appointment-confirmation", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[APPT-CONFIRM] ✓ Inbound call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callToken || !callerIDNumber) {
      console.error('[APPT-CONFIRM] ✗ Missing required parameters');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    
    // Store mappings
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // Try to find matching contact from active campaigns (patient callback)
    let matchedContactId: string | undefined;
    let matchedCampaignId: string | undefined;
    
    try {
      const { storage } = await import('../server/storage');
      const campaigns = await storage.getCampaigns();
      const activeCampaigns = campaigns.filter(c => c.status === 'running' || c.status === 'scheduled');
      
      const normalizedCaller = callerIDNumber.replace(/\D/g, '').slice(-10);
      
      for (const campaign of activeCampaigns) {
        const contacts = await storage.getCampaignContacts(campaign.id);
        const matchedContact = contacts.find(c => {
          const normalizedContact = c.phoneNumber.replace(/\D/g, '').slice(-10);
          return normalizedContact === normalizedCaller;
        });
        
        if (matchedContact) {
          matchedContactId = matchedContact.id;
          matchedCampaignId = campaign.id;
          console.info(`[APPT-CONFIRM] ✓ Matched inbound callback to campaign contact: ${matchedContact.firstName} ${matchedContact.lastName} (contact: ${matchedContactId})`);
          
          // Update contact status to show they called back
          await storage.updateCampaignContact(matchedContact.id, {
            outreachStatus: 'answered',
            lastAttemptAt: new Date(),
          });
          
          // Log this as an inbound attempt
          await storage.createContactAttempt({
            contactId: matchedContact.id,
            campaignId: campaign.id,
            attemptNumber: (matchedContact.attempts || 0) + 1,
            direction: 'inbound',
            status: 'answered',
            answeredBy: 'human',
          });
          
          break;
        }
      }
      
      if (!matchedContactId) {
        console.info(`[APPT-CONFIRM] No matching campaign contact found for ${callerIDNumber}`);
      }
    } catch (error) {
      console.error(`[APPT-CONFIRM] Error looking up campaign contacts:`, error);
    }
    
    // Store metadata for appointment-confirmation agent
    callMetadata.set(conferenceName, {
      agentSlug: 'appointment-confirmation',
      agentGreeting: '',
      language: 'english',
      ivrSelection: undefined,
      campaignId: matchedCampaignId,
      contactId: matchedContactId,
    } as any);
    
    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = 'sage';
    }

    console.info(`[APPT-CONFIRM] Routing to appointment-confirmation agent (voice=sage, contactId=${matchedContactId || 'none'})`);

    // Warm greeting for appointment confirmation calls
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Azul Vision. Please hold while I connect you with our appointment confirmation assistant.</Say>
  <Pause length="1"/>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
    console.info(`[APPT-CONFIRM] ✓ Caller joined conference: ${conferenceName}`);
    
    try {
      if (!twilioClient) {
        twilioClient = await getTwilioClient();
      }
    } catch (twilioInitError) {
      console.error(`[APPT-CONFIRM] ✗ Failed to initialize Twilio client:`, twilioInitError);
      return;
    }
    
    console.info(`[APPT-CONFIRM] Adding appointment-confirmation agent to conference: ${conferenceName}`);
    
    try {
      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=appointment-confirmation`,
          earlyMedia: true,
          callToken: ConferenceNametoCallTokenMapping[conferenceName],
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[APPT-CONFIRM] ✓ Appointment-confirmation agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[APPT-CONFIRM] ✗ Failed to add agent to conference:`, error);
    }
  });

  // IVR Selection Handler - Routes ALL paths to After-Hours Agent with context
  app.post("/api/voice/ivr-selection", webhookRateLimiter, async (req, res) => {
    console.info(`[IVR-SELECTION] *** Endpoint hit! Method: ${req.method}, Query: ${JSON.stringify(req.query)}`);
    
    const rawBody = req.body.toString("utf8");
    console.info(`[IVR-SELECTION] Raw body received (length ${rawBody.length})`);
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const digit = parsedBody.Digits as '1' | '2' | '3' | '4';
    const callSid = req.query.callSid as string || parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    
    console.info(`[IVR] Selection received: digit=${digit}, callSid=${callSid}`);

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    
    // Retrieve stored call token
    const storedCallToken = ConferenceNametoCallTokenMapping[conferenceName] || callToken;

    // All paths route to After-Hours Agent with IVR selection context
    let agentSlug: string = 'after-hours';
    let language: 'english' | 'spanish' = 'english';
    let spanishMenu = false;
    
    // Use the after-hours greeting - TwiML already played the intro
    let agentGreeting: string = '';

    switch (digit) {
      case '1':
        // Non-urgent: Appointments, rescheduling, medication refills
        agentGreeting = "I understand you're calling about appointments or medication. How can I help you today?";
        console.info(`[IVR] Routing to After-Hours Agent (non-urgent context)`);
        break;
      case '2':
        // Urgent medical: Flashes, floaters, vision loss
        agentGreeting = getUrgentTriageGreeting();
        console.info(`[IVR] Routing to After-Hours Agent (urgent context)`);
        break;
      case '3':
        // Provider/Hospital - will handle and transfer to human
        agentGreeting = "I understand you're a healthcare provider. Let me connect you with our on-call staff.";
        console.info(`[IVR] Routing to After-Hours Agent (provider context - will transfer to human)`);
        break;
      case '4':
        // Spanish menu - show Spanish IVR first
        spanishMenu = true;
        agentGreeting = ''; // Will be set in Spanish handler
        console.info(`[IVR] Showing Spanish menu`);
        break;
      default:
        // Invalid selection - replay menu
        console.info(`[IVR] Invalid selection: ${digit}, replaying menu`);
        const replayResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">I'm sorry, that was not a valid selection.</Say>
  <Redirect method="POST">https://${domain}/api/voice/incoming-call</Redirect>
</Response>`;
        res.setHeader("Content-Type", "application/xml");
        res.send(replayResponse);
        return;
    }

    // Handle Spanish menu
    if (spanishMenu) {
      const spanishResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${domain}/api/voice/ivr-selection-spanish?callSid=${callSid}" method="POST" timeout="10">
    <Say voice="Polly.Lupe" language="es-US">Gracias por llamar a Azul Vision. Todas nuestras oficinas están cerradas en este momento. Si esto es una emergencia médica, cuelgue y marque 9 1 1.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Lupe" language="es-US">Para citas, reprogramaciones, cancelaciones o recargas de medicamentos, oprima 1.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Lupe" language="es-US">Para problemas médicos urgentes como pérdida de visión, destellos de luz, flotadores, lesiones oculares o dolor severo, oprima 2.</Say>
    <Pause length="1"/>
    <Say voice="Polly.Lupe" language="es-US">Si usted es un proveedor de salud, hospital u oficina médica, oprima 3.</Say>
  </Gather>
  <Say voice="Polly.Lupe" language="es-US">No recibimos su selección. Por favor llame de nuevo. Adiós.</Say>
  <Hangup/>
</Response>`;
      res.setHeader("Content-Type", "application/xml");
      res.send(spanishResponse);
      return;
    }

    // Store agent selection with IVR context for this call
    callMetadata.set(conferenceName, { 
      agentSlug, 
      agentGreeting,
      language,
      ivrSelection: digit,
    });
    callMetadata.set(callSid, { 
      agentSlug, 
      agentGreeting,
      language,
      ivrSelection: digit,
    });

    // Connect to AI agent via conference
    (async () => {
      try {
        if (!OPENAI_PROJECT_ID) {
          throw new Error('OPENAI_PROJECT_ID not configured');
        }

        const client = await getTwilioClient();
        
        console.info(`[IVR] Adding ${agentSlug} agent to conference: ${conferenceName}`);

        // Build SIP URI with agent routing headers
        const sipUri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=${encodeURIComponent(agentSlug)}`;
        
        // Use resilience utilities for SIP participant creation
        const twilioSipCircuitBreaker = getCircuitBreaker('twilio-sip');
        const sipResult = await withResiliency(
          async () => client.conferences(conferenceName).participants.create({
            from: envConfig.twilio.phoneNumber!,
            label: "virtual agent",
            to: sipUri,
            earlyMedia: true,
            callToken: storedCallToken,
            conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
            conferenceStatusCallbackEvent: ['join']
          }),
          twilioSipCircuitBreaker,
          TWILIO_RETRY_CONFIG,
          `Twilio SIP participant for conference ${conferenceName}`
        );
        
        if (!sipResult.success) {
          throw sipResult.error;
        }
        
        console.info(`[IVR] ✓ ${agentSlug} agent successfully added to conference: ${conferenceName} (${sipResult.attempts} attempts, ${sipResult.totalTimeMs}ms)`);
      } catch (error) {
        console.error('[IVR] ✗ CRITICAL ERROR creating agent participant:', error);
      }
    })();

    // Return TwiML to join conference with transition message
    // The longer message gives the AI agent time to initialize before the caller hears silence
    const conferenceResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">One moment please while I connect you with our virtual assistant.</Say>
  <Dial>
    <Conference 
      startConferenceOnEnter="true"
      participantLabel="customer"
      endConferenceOnExit="true"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
      waitMethod="GET"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(conferenceResponse);
    console.info(`[IVR] ✓ Caller joined conference for ${agentSlug}: ${conferenceName}`);
  });

  // Spanish IVR Selection Handler - Routes ALL Spanish paths to After-Hours Agent
  app.post("/api/voice/ivr-selection-spanish", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const digit = parsedBody.Digits as '1' | '2' | '3';
    const callSid = req.query.callSid as string || parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    
    console.info(`[IVR-ES] Spanish selection received: digit=${digit}, callSid=${callSid}`);

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;
    const storedCallToken = ConferenceNametoCallTokenMapping[conferenceName] || callToken;

    // All Spanish paths route to After-Hours Agent with Spanish language context
    const agentSlug = 'after-hours';
    const language: 'english' | 'spanish' = 'spanish';
    
    let agentGreeting: string;
    let transferToHuman = false;

    switch (digit) {
      case '1':
        agentGreeting = "Entiendo que llama por citas o medicamentos. ¿En qué puedo ayudarle hoy?";
        console.info(`[IVR-ES] Routing to After-Hours Agent (non-urgent, Spanish)`);
        break;
      case '2':
        agentGreeting = "Entiendo que tiene una urgencia médica. Cuénteme qué está pasando.";
        console.info(`[IVR-ES] Routing to After-Hours Agent (urgent, Spanish)`);
        break;
      case '3':
        // Provider line - will handle and transfer to human
        agentGreeting = "Entiendo que es un proveedor de salud. Permítame conectarle con nuestro personal de guardia.";
        console.info(`[IVR-ES] Routing to After-Hours Agent (provider, Spanish - will transfer to human)`);
        break;
      default:
        console.info(`[IVR-ES] Invalid selection: ${digit}`);
        const replayResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lupe" language="es-US">Lo siento, esa selección no es válida.</Say>
  <Redirect method="POST">https://${domain}/api/voice/incoming-call</Redirect>
</Response>`;
        res.setHeader("Content-Type", "application/xml");
        res.send(replayResponse);
        return;
    }

    // Store Spanish preference and agent selection with IVR context
    callMetadata.set(conferenceName, { agentSlug, agentGreeting, language, ivrSelection: digit });
    callMetadata.set(callSid, { agentSlug, agentGreeting, language, ivrSelection: digit });

    // Connect to AI agent
    (async () => {
      try {
        if (!OPENAI_PROJECT_ID) {
          throw new Error('OPENAI_PROJECT_ID not configured');
        }

        const client = await getTwilioClient();
        
        console.info(`[IVR-ES] Adding ${agentSlug} agent to conference: ${conferenceName}`);

        // Build SIP URI with agent routing headers
        const sipUri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=${encodeURIComponent(agentSlug)}`;
        
        await client
          .conferences(conferenceName)
          .participants.create({
            from: envConfig.twilio.phoneNumber!,
            label: "virtual agent",
            to: sipUri,
            earlyMedia: true,
            callToken: storedCallToken,
            conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
            conferenceStatusCallbackEvent: ['join']
          });
        
        console.info(`[IVR-ES] ✓ ${agentSlug} agent added to conference: ${conferenceName}`);
      } catch (error) {
        console.error('[IVR-ES] ✗ ERROR creating agent participant:', error);
      }
    })();

    // Return TwiML with Spanish transition message before conference
    // The longer message gives the AI agent time to initialize before the caller hears silence
    const conferenceResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lupe" language="es-US">Un momento por favor mientras lo conecto con nuestro asistente virtual.</Say>
  <Dial>
    <Conference 
      startConferenceOnEnter="true"
      participantLabel="customer"
      endConferenceOnExit="true"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
      waitMethod="GET"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

    res.setHeader("Content-Type", "application/xml");
    res.send(conferenceResponse);
    console.info(`[IVR-ES] ✓ Caller joined conference for ${agentSlug}: ${conferenceName}`);
  });

  // Transfer status and voicemail handlers
  app.post("/api/voice/transfer-status", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    const callSid = req.query.callSid as string;
    const dialStatus = parsedBody.DialCallStatus;
    
    console.info(`[TRANSFER] Status for ${callSid}: ${dialStatus}`);
    
    // If transfer failed, Twilio continues with fallback in original TwiML
    res.setHeader("Content-Type", "application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  });

  app.post("/api/voice/voicemail", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    const callSid = req.query.callSid as string;
    const recordingUrl = parsedBody.RecordingUrl;
    
    console.info(`[VOICEMAIL] Recording received for ${callSid}: ${recordingUrl}`);
    
    // TODO: Save voicemail to database and notify staff
    
    res.setHeader("Content-Type", "application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you. Your message has been recorded. A member of our team will return your call. Goodbye.</Say>
  <Hangup/>
</Response>`);
  });

  // Handoff status callback - notifies us when human agent answers or call fails
  app.post("/api/voice/handoff-status", webhookRateLimiter, async (req, res) => {
    // Respond immediately to Twilio
    res.sendStatus(200);
    
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callStatus = parsedBody.CallStatus;
    const statusEvent = parsedBody.StatusCallbackEvent;
    
    console.info(`[HANDOFF-STATUS] CallSid: ${callSid}, Status: ${callStatus}, Event: ${statusEvent || 'n/a'}`);
    
    const resolver = handoffReadyResolvers.get(callSid);
    if (!resolver) {
      console.warn(`[HANDOFF-STATUS] No resolver found for CallSid: ${callSid}`);
      return;
    }
    
    // Twilio answered callback may surface as:
    // - StatusCallbackEvent=answered
    // - CallStatus=in-progress
    const humanAnswered = statusEvent === 'answered' || callStatus === 'in-progress';

    if (humanAnswered) {
      // Human answered the call
      console.info(`[HANDOFF-STATUS] ✓ Human agent answered: ${callSid}`);

      // Mark transfer immediately when human answers so stale cleanup logic won't treat this
      // as a non-transferred AI call if session-end events are delayed.
      const callMeta = callMetadataForDB.get(resolver.openAiCallId);
      if (callMeta) {
        callMeta.transferredToHuman = true;
      }
      if (resolver.callLogId) {
        callLifecycleCoordinator.markTransferred(resolver.callLogId);
      }

      resolver.resolve();
      handoffReadyResolvers.delete(callSid);
    } else if (['busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
      // Call failed - don't disconnect AI
      console.warn(`[HANDOFF-STATUS] ✗ Human agent call failed: ${callStatus}`);
      resolver.reject(new Error(`Human agent call ${callStatus}`));
      handoffReadyResolvers.delete(callSid);
    }
    // 'ringing', 'queued', 'initiated' - wait for final status
  });

  // Hold music TwiML endpoint for warm transfer
  // Twilio calls this via GET for holdUrl parameter
  app.get("/api/voice/hold-music", async (req, res) => {
    res.type("text/xml");
    // Use professional hold music - Twilio's default classical hold music
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while I connect you with a staff member.</Say>
  <Play loop="0">http://com.twilio.sounds.music.s3.amazonaws.com/ClockworkWaltz.mp3</Play>
</Response>`);
  });

  // Legacy warm transfer status callback - kept for backwards compatibility but no longer used
  app.post("/api/voice/warm-transfer-status", webhookRateLimiter, async (req, res) => {
    res.sendStatus(200);
    console.info(`[WARM-TRANSFER-STATUS] Received callback (warm transfer disabled)`);
  });

  // Conference events webhook
  app.post("/api/voice/conference-events", webhookRateLimiter, async (req, res) => {
    // Respond to Twilio immediately (before processing)
    res.sendStatus(200);

    // Parse Twilio's URL-encoded body
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

    const event = parsedBody.StatusCallbackEvent;
    const label = parsedBody.ParticipantLabel;
    const friendlyName = parsedBody.FriendlyName;
    const conferenceSid = parsedBody.ConferenceSid;
    const participantCallSid = parsedBody.CallSid;

    console.info(`[CONFERENCE] Event: ${event}, Label: ${label}, FriendlyName: ${friendlyName}, ConferenceSid: ${conferenceSid}`);

    // CRITICAL: Find callId using multiple strategies to ensure reliable cleanup
    // Uses wrapper functions that check both legacy maps and service cache for restart recovery
    let callId: string | undefined;
    
    // Strategy 1: Try FriendlyName (e.g., conf_CA123...) - uses wrapper for restart recovery
    if (friendlyName) {
      callId = getCallIdByConference(friendlyName);
      if (callId) {
        console.info(`[CONFERENCE] Found callId via FriendlyName: ${friendlyName} → ${callId}`);
      }
    }
    
    // Strategy 2: Try ConferenceSid (e.g., CFxxx...) - uses wrapper for restart recovery
    if (!callId && conferenceSid) {
      callId = getCallIdByConference(conferenceSid);
      if (callId) {
        console.info(`[CONFERENCE] Found callId via ConferenceSid: ${conferenceSid} → ${callId}`);
      }
    }
    
    // Strategy 3: Search callIDtoConferenceNameMapping in reverse
    // If friendlyName matches a value in callIDtoConferenceNameMapping, use that key as callId
    // Also check CallSessionService cache for restart recovery
    if (!callId && friendlyName) {
      for (const [openAICallId, confName] of Object.entries(callIDtoConferenceNameMapping)) {
        if (confName === friendlyName) {
          callId = openAICallId;
          console.info(`[CONFERENCE] Found callId via reverse lookup: ${friendlyName} → ${callId}`);
          break;
        }
      }
      // Fall back to service cache if not found in legacy map
      if (!callId) {
        const cachedSession = callSessionService.getByConferenceNameSync(friendlyName);
        if (cachedSession?.openaiCallId) {
          callId = cachedSession.openaiCallId;
          console.info(`[CONFERENCE] Found callId via service cache: ${friendlyName} → ${callId}`);
        }
      }
    }
    
    // Once we have callId, ensure ALL identifiers map to it for future events
    if (callId) {
      let mappingsAdded = false;
      if (friendlyName && !conferenceNameToCallID[friendlyName]) {
        conferenceNameToCallID[friendlyName] = callId;
        console.info(`[CONFERENCE] ✓ Added FriendlyName mapping: ${friendlyName} → ${callId}`);
        mappingsAdded = true;
      }
      if (conferenceSid && !conferenceNameToCallID[conferenceSid]) {
        conferenceNameToCallID[conferenceSid] = callId;
        console.info(`[CONFERENCE] ✓ Added ConferenceSid mapping: ${conferenceSid} → ${callId}`);
        mappingsAdded = true;
        
        // Also map conferenceSid to call log ID for recording URL persistence and coordinator
        // Use coordinator's existing record to get callLogId (more reliable than callMetadataForDB)
        const existingRecord = callLifecycleCoordinator.getCallByAnyId(callId);
        const callLogId = existingRecord?.callLogId || callMetadataForDB.get(callId)?.dbCallLogId;
        if (callLogId) {
          // Add to lifecycle coordinator for reliable termination detection
          callLifecycleCoordinator.addMapping(conferenceSid, callLogId);
          conferenceSidToCallLogId[conferenceSid] = callLogId;
          console.info(`[CONFERENCE] ✓ Added conferenceSid → callLogId mapping: ${conferenceSid} → ${callLogId}`);
          
          // DUAL-WRITE: Persist conference SID and call log ID to PostgreSQL
          callSessionService.upsertSession(friendlyName, {
            conferenceSid: conferenceSid,
            callLogId: callLogId,
          }).catch(err => console.error(`[CALL SESSION] Failed to update session with conferenceSid:`, err));
        } else {
          // Queue the conferenceSid mapping if call isn't registered yet
          // It will be applied when registerCall is called with the openAiCallId
          callLifecycleCoordinator.queuePendingMapping(callId, conferenceSid);
          console.info(`[CONFERENCE] Queued pending conferenceSid mapping: ${conferenceSid} → ${callId} (call not yet registered)`);
        }
      }
      if (mappingsAdded) {
        console.info(`[CONFERENCE] All identifiers now mapped to callId: ${callId}`);
      }
    } else {
      console.warn(`[CONFERENCE] Could not resolve callId for FriendlyName=${friendlyName}, ConferenceSid=${conferenceSid}`);
    }

    // Handle session cleanup when call ends
    // Trigger on participant-leave (caller hangs up) or conference-end (conference terminates)
    if ((event === 'participant-leave' && label === 'customer') || event === 'conference-end') {
      // Notify lifecycle coordinator of termination event
      // Try multiple ID resolution strategies since mappings may be pending
      const resolvedCallLogId = conferenceSidToCallLogId[conferenceSid] 
        || (callId ? callMetadataForDB.get(callId)?.dbCallLogId : undefined)
        || (callId ? callLifecycleCoordinator.getCallByAnyId(callId)?.callLogId : undefined);
      
      if (resolvedCallLogId) {
        if (event === 'conference-end') {
          // Use the resolved callLogId directly
          callLifecycleCoordinator.handleConferenceEndByCallLogId(resolvedCallLogId);
        } else if (label === 'customer') {
          callLifecycleCoordinator.handleParticipantLeftByCallLogId(resolvedCallLogId, label);
        }
      } else if (conferenceSid) {
        // Fallback to conferenceSid lookup
        if (event === 'conference-end') {
          callLifecycleCoordinator.handleConferenceEnd(conferenceSid);
        } else if (label === 'customer') {
          callLifecycleCoordinator.handleParticipantLeft(conferenceSid, label);
        }
      }
      
      // callId should already be set from mapping logic above
      if (callId) {
        const session = activeSessions.get(callId);
        if (session) {
          try {
            console.info(`[CONFERENCE] ${event} event detected, closing session transport: ${callId}`);
            // Close the transport to trigger cleanup and database update
            session.transport.close();
            console.info(`[CONFERENCE] ✓ Session transport closed for call: ${callId}`);
          } catch (error) {
            console.error(`[CONFERENCE] ✗ Error closing session transport ${callId}:`, error);
          }
        } else {
          console.warn(`[CONFERENCE] No active session found for call: ${callId}`);
        }
      } else {
        console.warn(`[CONFERENCE] No callId mapping found for FriendlyName: ${friendlyName}, ConferenceSid: ${conferenceSid}`);
      }
      
      // CRITICAL: Terminate any orphaned SIP calls for this conference
      // This catches cases where caller hangs up before the call was fully registered
      // Without this, the OpenAI SIP connection stays open for 60 minutes
      if (friendlyName) {
        terminateOrphanedSIPCall(friendlyName, event === 'conference-end' ? 'conference_ended' : 'customer_left');
      }
    }

    // CRITICAL: Resolve caller-ready promise when customer joins
    // This unblocks the session handler which is waiting to trigger the greeting
    if (label === 'customer' && event === 'participant-join') {
      console.info(`[CONFERENCE] ✓ Customer joined conference: ${friendlyName}`);
      
      // Resolve the caller-ready promise so the greeting can be triggered
      const resolver = callerReadyResolvers.get(friendlyName);
      if (resolver) {
        console.info(`[CONFERENCE] Resolving caller-ready promise for: ${friendlyName}`);
        resolver();
        callerReadyResolvers.delete(friendlyName);
      } else {
        // This is normal when conferences dissolve before customer joins (ghost/declined calls)
        console.debug(`[CONFERENCE] No caller-ready resolver found for: ${friendlyName}`);
      }
    }

    // Handle human agent joining (for handoff feature)
    if (label === 'human agent' && event === 'participant-join') {
      // Fallback signal: conference join confirms the human answered.
      // This covers cases where /handoff-status callback is delayed or missing.
      if (participantCallSid) {
        const resolver = handoffReadyResolvers.get(participantCallSid);
        if (resolver) {
          console.info(`[CONFERENCE] ✓ Human join resolved handoff for ${participantCallSid}`);
          resolver.resolve();
          handoffReadyResolvers.delete(participantCallSid);
        }
      }

      // Remove virtual agent when human joins
      try {
        const client = await getTwilioClient();
        const participants = await client
          .conferences(parsedBody.ConferenceSid)
          .participants.list({ limit: 20 });

        for (const participant of participants) {
          if (participant.label === 'virtual agent') {
            await client.calls(participant.callSid).update({ status: 'completed' });
            console.info('[CONFERENCE] ✓ Virtual agent removed after human joined');
          }
        }
      } catch (error) {
        console.error('[CONFERENCE] ✗ Error removing virtual agent:', error);
      }
    }
  });

  // Recording status callback - saves recording URL to database
  app.post("/api/voice/recording-status", webhookRateLimiter, async (req, res) => {
    try {
      // Handle both Buffer (raw parser) and object (urlencoded parser) cases
      let parsedBody: Record<string, string>;
      
      if (Buffer.isBuffer(req.body)) {
        const rawBody = req.body.toString("utf8");
        parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
      } else if (typeof req.body === 'object') {
        parsedBody = req.body;
      } else {
        console.error('[RECORDING] Unexpected body format:', typeof req.body);
        return res.status(400).send('Invalid request format');
      }

      const recordingUrl = parsedBody.RecordingUrl;
      const recordingSid = parsedBody.RecordingSid;
      const conferenceSid = parsedBody.ConferenceSid;
      const recordingStatus = parsedBody.RecordingStatus;
      
      console.info(`[RECORDING] Conference ${conferenceSid} recording ${recordingStatus}: ${recordingUrl}`);
      
      // Save recording URL to database when completed
      if (recordingUrl && recordingStatus === 'completed' && conferenceSid) {
        // BACKUP SESSION CLEANUP: Recording completion means call has ended
        // If participant-leave event didn't fire, close the session now
        const callId = conferenceNameToCallID[conferenceSid];
        if (callId) {
          const session = activeSessions.get(callId);
          if (session) {
            try {
              console.info(`[RECORDING] Session still active after recording completed, closing: ${callId}`);
              session.transport.close();
              console.info(`[RECORDING] ✓ Session transport closed for call: ${callId}`);
            } catch (closeError) {
              console.error(`[RECORDING] ✗ Error closing session ${callId}:`, closeError);
            }
          }
        }
        
        // Try local mapping first, then coordinator as fallback
        let callLogId = conferenceSidToCallLogId[conferenceSid];
        
        // Fallback: try to get callLogId from coordinator using conferenceSid
        if (!callLogId) {
          const callRecord = callLifecycleCoordinator.getCallByAnyId(conferenceSid);
          if (callRecord) {
            callLogId = callRecord.callLogId;
            console.info(`[RECORDING] Found callLogId via coordinator: ${conferenceSid} → ${callLogId}`);
          }
        }
        
        if (callLogId) {
          const { storage } = await import('../server/storage');
          
          await storage.updateCallLog(callLogId, {
            recordingUrl: recordingUrl,
          });
          
          console.info(`[RECORDING] ✓ Saved recording URL to call log ${callLogId}`);
          
          // Clean up mapping
          delete conferenceSidToCallLogId[conferenceSid];
        } else {
          console.warn(`[RECORDING] ⚠️ No call log ID found for conference SID ${conferenceSid}`);
        }
      }
      
      res.status(200).send('OK');
    } catch (error) {
      console.error('[RECORDING] Error handling recording status:', error);
      res.status(500).send('Error');
    }
  });

  // AirCall DTMF endpoint - serves TwiML to send digit "1"
  // This is called when AirCall's "Press 1 to accept" prompt is detected
  app.post("/api/voice/aircall-dtmf", webhookRateLimiter, async (req, res) => {
    console.log('[AIRCALL] Serving DTMF TwiML to send digit "1"');
    
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="1"/>
</Response>`;
    
    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
  });

  // Twilio StatusCallback endpoint - comprehensive call outcome tracking
  // Called by Twilio when call status changes (completed, busy, no-answer, failed, etc.)
  // Support both /status and /status-callback for Twilio compatibility
  const statusCallbackHandler = async (req: any, res: any) => {
    try {
      // Handle both Buffer (raw parser) and object (urlencoded parser) cases
      let parsedBody: Record<string, string>;
      
      if (Buffer.isBuffer(req.body)) {
        // Raw body-parser middleware - parse manually
        const rawBody = req.body.toString("utf8");
        parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
      } else if (typeof req.body === 'object') {
        // Already parsed by urlencoded middleware
        parsedBody = req.body;
      } else {
        // Unexpected format
        console.error('[STATUS CALLBACK] Unexpected body format:', typeof req.body);
        return res.status(400).json({ success: false, error: 'Invalid request format' });
      }
      
      const {
        CallSid,
        CallStatus,
        CallDuration,
        AnsweredBy,
        MachineDetectionDuration,
        ErrorCode,
        ErrorMessage,
        Timestamp,
      } = parsedBody;

      // Validate required fields
      if (!CallSid || !CallStatus) {
        console.error('[STATUS CALLBACK] Missing required fields: CallSid or CallStatus');
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }

      console.info(`[STATUS CALLBACK] CallSid: ${CallSid}, Status: ${CallStatus}, AnsweredBy: ${AnsweredBy || 'N/A'}`);

      // Notify lifecycle coordinator of Twilio status callback (most authoritative signal)
      callLifecycleCoordinator.handleTwilioStatusCallback(CallSid, CallStatus);

      // Use singleton storage instance for consistency
      const { storage } = await import('../server/storage');

      // Find the call log by CallSid using direct query (not pagination scan)
      const callLog = await storage.getCallLogBySid(CallSid);

      if (!callLog) {
        console.warn(`[STATUS CALLBACK] No call log found for CallSid: ${CallSid}`);
        return res.json({ success: false, message: 'Call log not found' });
      }

      // Determine call disposition based on comprehensive Twilio data
      let callDisposition = CallStatus;
      let isVoicemail = false;

      // Machine detection results
      if (AnsweredBy === 'machine_start' || AnsweredBy === 'machine_end_beep' || AnsweredBy === 'machine_end_silence') {
        callDisposition = 'voicemail';
        isVoicemail = true;
      } else if (AnsweredBy === 'fax') {
        callDisposition = 'fax_machine';
      }

      // Map Twilio status to our internal status
      let internalStatus: 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer' | 'busy' | 'transferred' = 'completed';
      
      if (CallStatus === 'busy') {
        internalStatus = 'busy';
        callDisposition = 'busy';
      } else if (CallStatus === 'no-answer') {
        internalStatus = 'no_answer';
        callDisposition = 'no_answer';
      } else if (CallStatus === 'failed' || CallStatus === 'canceled') {
        internalStatus = 'failed';
        
        // Parse error codes for detailed disposition
        if (ErrorCode === '21217') callDisposition = 'line_disconnected';
        else if (ErrorCode === '21214') callDisposition = 'wrong_number';
        else if (ErrorCode === '21211') callDisposition = 'out_of_service';
        else callDisposition = 'failed';
      } else if (CallStatus === 'completed') {
        internalStatus = 'completed';
      }

      // Use Twilio's timestamp if provided, otherwise current time
      const endTime = Timestamp ? new Date(Timestamp) : new Date();
      
      // Fetch actual Twilio cost for terminal states
      let actualTwilioCostCents: number | null = null;
      const terminalStates = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
      
      if (terminalStates.includes(CallStatus)) {
        try {
          const twilioClient = await getTwilioClient();
          if (twilioClient) {
            const twilioCallDetails = await twilioClient.calls(CallSid).fetch();
            if (twilioCallDetails.price) {
              // Twilio returns price as negative string like "-0.009"
              const price = parseFloat(twilioCallDetails.price);
              actualTwilioCostCents = Math.round(Math.abs(price) * 100);
              console.info(`[STATUS CALLBACK] Fetched actual Twilio cost: $${Math.abs(price).toFixed(4)} (${actualTwilioCostCents}¢)`);
            }
          }
        } catch (err) {
          console.warn('[STATUS CALLBACK] Could not fetch Twilio cost:', err);
        }
      }
      
      // CRITICAL: Only use Twilio's CallDuration if provided, otherwise leave duration unchanged
      // This prevents overwriting with 0 when Twilio doesn't provide duration
      const hasTwilioDuration = CallDuration && CallDuration !== '0' && CallDuration !== '';
      const twilioProvidedDuration = hasTwilioDuration ? parseInt(CallDuration) : null;
      
      // Calculate costs only if we have authoritative Twilio duration
      const duration = twilioProvidedDuration ?? callLog.duration ?? 0;
      const openaiCostCents = Math.round(duration / 60 * 19); // 19¢/min for realtime
      const twilioCostCents = actualTwilioCostCents ?? callLog.twilioCostCents ?? 0;
      const totalCostCents = twilioCostCents + openaiCostCents;

      // Update call log with comprehensive tracking data
      // ONLY mark as authoritative (costIsEstimated: false) if Twilio provided CallDuration
      // CRITICAL: Preserve transferredToHuman flag - it was set during handoff and must NOT be overwritten
      const updateData: Record<string, any> = {
        status: internalStatus,
        twilioStatus: CallStatus,
        answeredBy: AnsweredBy || null,
        machineDetectionDuration: MachineDetectionDuration ? parseInt(MachineDetectionDuration) : null,
        callDisposition,
        isVoicemail,
        twilioErrorCode: ErrorCode || null,
        endTime,
        twilioCostCents,
        openaiCostCents,
        totalCostCents,
        // PRESERVE EXISTING transferredToHuman FLAG - never overwrite with null/false
        transferredToHuman: callLog.transferredToHuman || false,
      };
      
      // Only update duration and mark as authoritative if Twilio actually provided it
      if (hasTwilioDuration) {
        updateData.duration = twilioProvidedDuration;
        updateData.costIsEstimated = false;  // AUTHORITATIVE: Twilio provided duration
        console.info(`[STATUS CALLBACK] ✓ TWILIO AUTHORITATIVE: Duration=${twilioProvidedDuration}s`);
      } else {
        // Twilio didn't provide duration - keep costIsEstimated true for reconciliation
        console.warn(`[STATUS CALLBACK] ⚠️ Twilio did not provide CallDuration, keeping costIsEstimated=true for reconciliation`);
      }
      
      await storage.updateCallLog(callLog.id, updateData);

      // Update campaign contact if this was a campaign call
      if (callLog.campaignId && callLog.contactId) {
        const successful = internalStatus === 'completed' && !isVoicemail;
        
        await storage.updateCampaignContact(callLog.contactId, {
          contacted: true,
          successful,
          lastAttemptAt: endTime,
        });

        console.info(`[STATUS CALLBACK] ✓ Updated campaign contact: ${callLog.contactId}, Successful: ${successful}`);
      }

      console.info(`[STATUS CALLBACK] ✓ Call log updated: ${callLog.id}, Disposition: ${callDisposition}, Voicemail: ${isVoicemail}, Cost: ${totalCostCents}¢`);
      
      // Notify campaign executor that call has completed (ONLY for terminal states)
      if (callLog.campaignId && callLog.direction === 'outbound' && terminalStates.includes(CallStatus)) {
        try {
          const { campaignExecutor } = await import('../server/services/campaignExecutor');
          campaignExecutor.notifyCallComplete(CallSid);
          console.info(`[STATUS CALLBACK] ✓ Notified campaign executor (terminal state: ${CallStatus}): ${CallSid}`);
        } catch (err) {
          console.error('[STATUS CALLBACK] Error notifying campaign executor:', err);
          // Don't fail the webhook if notification fails
        }
      } else if (callLog.campaignId && callLog.direction === 'outbound') {
        console.info(`[STATUS CALLBACK] Skipping notification - non-terminal state: ${CallStatus}`);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error('[STATUS CALLBACK] Error processing webhook:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
  
  // Register both URL patterns for Twilio status callbacks
  app.post("/api/voice/status-callback", statusCallbackHandler);
  app.post("/api/voice/status", statusCallbackHandler);

  // Fallback complete handler - called when Dial action completes after OpenAI accept failure
  // This logs the outcome of the fallback transfer to human agent
  app.post("/api/voice/fallback-complete", webhookRateLimiter, async (req, res) => {
    // Handle multiple body formats: Buffer (raw), string (URL-encoded), object (parsed by Express)
    let parsedBody: Record<string, string> = {};
    try {
      if (Buffer.isBuffer(req.body)) {
        const rawBody = req.body.toString("utf8");
        parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
      } else if (typeof req.body === 'string') {
        parsedBody = Object.fromEntries(new URLSearchParams(req.body));
      } else if (req.body && typeof req.body === 'object') {
        // Express already parsed it - use directly
        parsedBody = req.body as Record<string, string>;
      }
    } catch (parseError) {
      console.error(`[FALLBACK COMPLETE] Error parsing body:`, parseError);
    }
    
    const callSid = parsedBody.CallSid;
    const dialCallStatus = parsedBody.DialCallStatus || 'unknown'; // 'completed', 'busy', 'no-answer', 'failed', 'canceled'
    const dialCallDuration = parsedBody.DialCallDuration || '0';
    
    // Validate required fields - return 400 if CallSid missing so operators see the failure
    if (!callSid) {
      console.error(`[FALLBACK COMPLETE] Missing CallSid in request body:`, JSON.stringify(parsedBody).substring(0, 200));
      res.status(400).json({ error: 'Missing required field: CallSid' });
      return;
    }
    
    console.info(`[FALLBACK COMPLETE] CallSid: ${callSid}, DialStatus: ${dialCallStatus}, Duration: ${dialCallDuration}s`);
    
    // Return empty TwiML to end the call gracefully
    res.setHeader('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  });

  // Ticketing Sync API endpoints - delegated to modular route registrar
  registerTicketingSyncRoutes(app);

  // Delayed Twilio reconciliation with exponential backoff
  // Twilio data may take 1-2 minutes to finalize after call ends
  const scheduleDelayedTwilioReconciliation = async (
    callLogId: string, 
    twilioCallSid: string, 
    delaysMs: number[]
  ) => {
    const { callCostService } = await import('./services/callCostService');
    
    for (const delayMs of delaysMs) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      try {
        const result = await callCostService.reconcileTwilioCallData(callLogId, twilioCallSid);
        
        if (result.success && !result.skipped && result.actualDuration && result.actualDuration > 0) {
          // Success - recalculate OpenAI cost with correct duration
          await callCostService.recalculateOpenAICostFromDuration(callLogId);
          console.info(`[TWILIO RETRY] ✓ Reconciled ${callLogId} after ${delayMs}ms: ${result.actualDuration}s`);
          return; // Success, stop retrying
        }
        
        console.info(`[TWILIO RETRY] Attempt at ${delayMs}ms - data not ready for ${callLogId}`);
      } catch (error) {
        console.error(`[TWILIO RETRY] Error at ${delayMs}ms for ${callLogId}:`, error);
      }
    }
    
    console.warn(`[TWILIO RETRY] Exhausted retries for ${callLogId} - will be caught by background cleanup`);
  };

  // Set up lifecycle coordinator event listener for reliable post-call processing
  callLifecycleCoordinator.on('call-ended', async (data) => {
    const { callLogId, status, duration, transcript, twilioCallSid, transferredToHuman } = data;
    console.info(`[COORDINATOR EVENT] Call ended: ${callLogId}, Duration: ${duration}s, Transcript: ${transcript?.length || 0} chars`);
    
    // Trigger post-call processing (cost calculation, grading, ticketing)
    try {
      const { callCostService } = await import('./services/callCostService');
      const { callGradingService } = await import('./services/callGradingService');
      const { ticketingApiClient } = await import('../server/services/ticketingApiClient');
      const { storage } = await import('../server/storage');
      
      // Get call log details for context
      const callLog = await storage.getCallLog(callLogId);
      
      // CRITICAL: Fetch authoritative Twilio data FIRST to get accurate duration
      // Twilio is the source of truth for call duration and cost
      let actualDuration = duration;
      let twilioDataReady = false;
      
      // FALLBACK: If twilioCallSid not in event data, check the database
      // This handles timeout cases where the in-memory mapping was lost
      const effectiveTwilioCallSid = twilioCallSid || callLog?.callSid;
      
      if (effectiveTwilioCallSid) {
        // Wait briefly for Twilio to finalize data
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const reconcileResult = await callCostService.reconcileTwilioCallData(callLogId, effectiveTwilioCallSid);
        
        if (reconcileResult.success && !reconcileResult.skipped && reconcileResult.actualDuration) {
          actualDuration = reconcileResult.actualDuration;
          twilioDataReady = true;
          console.info(`[COORDINATOR EVENT] Twilio reconciled: ${duration}s → ${actualDuration}s`);
          
          // Calculate OpenAI cost based on authoritative Twilio duration
          await callCostService.recalculateOpenAICostFromDuration(callLogId);
        } else if (reconcileResult.skipped || !reconcileResult.actualDuration) {
          // Twilio data not ready - DON'T calculate OpenAI cost yet
          // The delayed retry will recalculate costs when Twilio data is available
          console.info(`[COORDINATOR EVENT] Twilio data not ready, deferring cost calculation for ${callLogId}`);
          scheduleDelayedTwilioReconciliation(callLogId, effectiveTwilioCallSid, [15000, 45000, 120000]);
        }
      } else {
        // No Twilio call SID - calculate OpenAI cost based on local duration
        await callCostService.recalculateOpenAICostFromDuration(callLogId);
      }
      
      // Grade the call
      let gradeResult: { qualityScore?: number; patientSentiment?: string; agentOutcome?: string } = {};
      if (transcript && transcript.length > 50) {
        const analysisResult = await callGradingService.gradeCall(callLogId, transcript);
        if (analysisResult) {
          gradeResult = {
            qualityScore: analysisResult.qualityScore,
            patientSentiment: analysisResult.sentiment,
            agentOutcome: analysisResult.agentOutcome,
          };
        }
      }
      
      console.info(`[COORDINATOR EVENT] Cost and grading processed for ${callLogId}`);
      
      // Push to ticketing API for relevant agents - ONLY if a ticket was created
      const agentSlug = callLog?.agentId ? (await storage.getAgent(callLog.agentId))?.slug : null;
      const hasTicket = callLog?.ticketNumber && callLog.ticketNumber.trim().length > 0;
      
      if (effectiveTwilioCallSid && (agentSlug === 'after-hours' || agentSlug === 'no-ivr' || agentSlug === 'answering-service') && hasTicket) {
        try {
          const ticketUpdateResult = await ticketingApiClient.updateTicketCallData({
            callSid: effectiveTwilioCallSid,
            transcript: transcript || undefined,
            callerPhone: callLog?.from || undefined,
            dialedNumber: callLog?.to || undefined,
            agentUsed: agentSlug || undefined,
            callStartTime: callLog?.startTime?.toISOString(),
            callEndTime: callLog?.endTime?.toISOString(),
            callDurationSeconds: actualDuration,
            humanHandoffOccurred: transferredToHuman,
            qualityScore: gradeResult.qualityScore,
            patientSentiment: gradeResult.patientSentiment,
            agentOutcome: gradeResult.agentOutcome,
          });
          
          if (ticketUpdateResult.success) {
            console.info(`[COORDINATOR EVENT] ✓ Ticketing API updated for ${effectiveTwilioCallSid}`);
          } else {
            console.warn(`[COORDINATOR EVENT] Ticketing API failed: ${ticketUpdateResult.error}`);
          }
        } catch (ticketError) {
          console.error(`[COORDINATOR EVENT] Ticketing API error:`, ticketError);
        }
      }
    } catch (error) {
      console.error(`[COORDINATOR EVENT] Post-call processing error:`, error);
    }
  });
  
  // Stale call events are logged by the coordinator itself - no duplicate logging needed

  // Shared conference state is now used directly via import from conferenceState.ts
  // No callback registration needed - both modules import from the same shared state

  // ==================== OUTBOUND CONFIRMATION WEBHOOKS ====================
  
  // Webhook for outbound appointment confirmation calls (Twilio hits this when call connects)
  // No AMD - immediately connect to AI agent who handles voicemail detection conversationally
  app.post("/api/voice/outbound-confirmation", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callStatus = parsedBody.CallStatus;
    const to = parsedBody.To;
    const from = parsedBody.From;
    
    // Extract contact and campaign IDs from query parameters
    const contactId = req.query.contactId as string | undefined;
    const campaignId = req.query.campaignId as string | undefined;

    console.info(`\n[OUTBOUND-CONFIRM] Call answered: ${callSid}, Status: ${callStatus}, ContactId: ${contactId || 'N/A'}`);
    console.info(`[OUTBOUND-CONFIRM] Connecting directly to AI agent (no AMD)`);

    const domain = process.env.DOMAIN || req.get('host');

    // Set up conference for AI agent connection
    const conferenceName = `outbound_conf_${callSid}`;
    
    // Store conference mappings
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = to;
    ConferenceNametoCalledNumberMapping[conferenceName] = from;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    
    // Look up campaign to get assigned agent
    let agentSlugForCall = 'appointment-confirmation';
    if (campaignId) {
      try {
        const campaign = await storage.getCampaign(campaignId);
        if (campaign?.agentId) {
          const agent = await storage.getAgent(campaign.agentId);
          if (agent?.slug) {
            agentSlugForCall = agent.slug;
            console.info(`[OUTBOUND-CONFIRM] Using campaign's agent: ${agentSlugForCall}`);
          }
        }
      } catch (err) {
        console.warn(`[OUTBOUND-CONFIRM] Error looking up campaign agent, using default:`, err);
      }
    }
    
    // Store metadata for campaign agent with contact context
    callMetadata.set(conferenceName, {
      agentSlug: agentSlugForCall,
      agentGreeting: '',
      language: 'english',
      ivrSelection: undefined,
      contactId: contactId,
      campaignId: campaignId,
    } as any);
    
    // Add AI agent to conference after a brief delay
    setTimeout(async () => {
      try {
        if (!twilioClient) {
          twilioClient = await getTwilioClient();
        }
        
        const sipParams = [
          `X-conferenceName=${conferenceName}`,
          `X-CallerPhone=${encodeURIComponent(to)}`,
          `X-agentSlug=${agentSlugForCall}`,
        ];
        if (contactId) sipParams.push(`X-contactId=${encodeURIComponent(contactId)}`);
        if (campaignId) sipParams.push(`X-campaignId=${encodeURIComponent(campaignId)}`);
        
        const sipUri = `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?${sipParams.join('&')}`;
        
        await twilioClient.conferences(conferenceName)
          .participants
          .create({
            from: from,
            label: 'virtual agent',
            to: sipUri,
            earlyMedia: true,
            conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
            conferenceStatusCallbackEvent: ['join']
          });
        console.info(`[OUTBOUND-CONFIRM] AI agent added to conference: ${conferenceName}`);
      } catch (error) {
        console.error(`[OUTBOUND-CONFIRM] Failed to add AI agent:`, error);
      }
    }, 500);

    // Connect caller to conference immediately
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference 
      beep="false"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      participantLabel="customer"
      record="record-from-start"
      recordingStatusCallback="https://${domain}/api/voice/recording-status"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
      statusCallback="https://${domain}/api/voice/conference-events"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
    >
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;
    
    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
  });

  // Voicemail endpoint - called when no keypress received (timeout)
  app.post("/api/voice/outbound-confirmation-voicemail", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const contactId = req.query.contactId as string | undefined;
    const campaignId = req.query.campaignId as string | undefined;

    console.info(`[OUTBOUND-VOICEMAIL] No keypress received, leaving voicemail. CallSid: ${callSid}, ContactId: ${contactId || 'N/A'}`);

    // Get patient name and mark contact for retry
    let patientName = 'there';
    const callbackNumber = '626-222-9400';
    
    try {
      if (contactId && campaignId) {
        const { storage } = await import('../server/storage');
        const { getScheduler } = await import('./services/outboundCampaignScheduler');
        
        const contacts = await storage.getCampaignContacts(campaignId);
        const contact = contacts.find(c => c.id === contactId);
        
        if (contact) {
          if (contact.firstName) {
            patientName = contact.firstName;
          }
          
          const currentAttempts = contact.attempts || 1;
          const maxAttempts = contact.maxAttempts || 3;
          const hasMoreAttempts = currentAttempts < maxAttempts;
          
          const scheduler = getScheduler(campaignId);
          
          const updates: any = {
            outreachStatus: hasMoreAttempts ? 'callback_scheduled' : 'max_attempts',
            voicemailLeft: true,
          };
          
          if (hasMoreAttempts && scheduler) {
            updates.nextAttemptAt = scheduler.scheduleNextAttempt(contact, contact.timezone || undefined);
          }
          
          await storage.updateCampaignContact(contactId, updates);
          console.info(`[OUTBOUND-VOICEMAIL] Contact ${contactId} voicemail left, ${hasMoreAttempts ? 'retry scheduled' : 'max attempts reached'}`);
        }
      }
    } catch (error) {
      console.error(`[OUTBOUND-VOICEMAIL] Error updating contact:`, error);
    }

    // Play voicemail script
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hi ${patientName}, this is Azul Vision calling to confirm your upcoming appointment. Please call us back at ${callbackNumber} at your earliest convenience. Thank you, and we look forward to seeing you soon.</Say>
  <Hangup/>
</Response>`;
    
    res.setHeader("Content-Type", "application/xml");
    res.send(twimlResponse);
  });

  // DEPRECATED: AMD callback endpoint - no longer used since we removed AMD
  // Kept for backwards compatibility in case any old callbacks come through
  app.post("/api/voice/outbound-amd-result", webhookRateLimiter, async (req, res) => {
    console.info(`[AMD-RESULT] DEPRECATED - AMD no longer used, ignoring callback`);
    res.status(200).send('OK');
  });


  // Status callback for outbound confirmation calls
  app.post("/api/voice/outbound-confirmation-status", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    
    const callSid = parsedBody.CallSid;
    const callStatus = parsedBody.CallStatus;
    const answeredBy = parsedBody.AnsweredBy;
    const callDuration = parsedBody.CallDuration;
    
    // Get contactId from query params as backup
    const contactIdFromQuery = req.query.contactId as string | undefined;

    console.info(`[OUTBOUND-CONFIRM-STATUS] CallSid: ${callSid}, Status: ${callStatus}, AnsweredBy: ${answeredBy || 'N/A'}, Duration: ${callDuration || 0}s`);

    try {
      const { getScheduler } = await import('./services/outboundCampaignScheduler');
      const { storage } = await import('../server/storage');
      
      // Find the attempt by callSid
      const attempt = await storage.getContactAttemptByCallSid(callSid);
      
      if (attempt) {
        const scheduler = getScheduler(attempt.campaignId);
        if (scheduler) {
          // Use scheduler's handleCallCompleted for full logic
          await scheduler.handleCallCompleted(
            callSid,
            answeredBy || 'unknown',
            callStatus,
            parseInt(callDuration || '0')
          );
        } else {
          // No active scheduler - update contact status directly to prevent stuck contacts
          console.info(`[OUTBOUND-CONFIRM-STATUS] No active scheduler, updating contact directly`);
          
          // Update attempt status
          await storage.updateContactAttempt(attempt.id, {
            status: callStatus,
            answeredBy: answeredBy || null,
            endedAt: new Date(),
            duration: parseInt(callDuration || '0'),
          });
          
          // Determine new contact status based on call outcome
          // Without machine detection, AnsweredBy is undefined - use duration/status instead
          const isTerminal = ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(callStatus);
          if (isTerminal) {
            const duration = parseInt(callDuration || '0');
            
            let newStatus: string;
            if (callStatus === 'completed' && duration > 0) {
              // Call was answered and had a conversation - agent will set final outcome
              newStatus = 'answered';
            } else {
              // No-answer, busy, failed, or completed with 0 duration - schedule retry
              newStatus = 'callback_scheduled';
            }
            
            await storage.updateCampaignContact(attempt.contactId, {
              outreachStatus: newStatus as any,
              lastAttemptAt: new Date(),
              nextAttemptAt: newStatus === 'callback_scheduled' ? new Date(Date.now() + 60 * 60 * 1000) : undefined,
            });
            console.info(`[OUTBOUND-CONFIRM-STATUS] Updated contact ${attempt.contactId} status to: ${newStatus}`);
          }
        }
      } else if (contactIdFromQuery) {
        // No attempt found but we have contactId from query - update contact directly
        console.info(`[OUTBOUND-CONFIRM-STATUS] No attempt found, using contactId from query: ${contactIdFromQuery}`);
        const isTerminal = ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(callStatus);
        if (isTerminal) {
          await storage.updateCampaignContact(contactIdFromQuery, {
            outreachStatus: 'callback_scheduled' as any,
            lastAttemptAt: new Date(),
            nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          });
          console.info(`[OUTBOUND-CONFIRM-STATUS] Updated contact ${contactIdFromQuery} status to callback_scheduled`);
        }
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error('[OUTBOUND-CONFIRM-STATUS] Error:', error);
      res.json({ success: false });
    }
  });

  // Call diagnostics API endpoint - provides real-time visibility into call health
  app.get("/api/voice/diagnostics", async (req, res) => {
    try {
      const stats = CallDiagnostics.getDailyStats();
      const activeCount = CallDiagnostics.getActiveTraceCount();
      const completedCount = CallDiagnostics.getCompletedTraceCount();
      
      // Use adjusted failure rate that includes orphaned traces
      const adjustedRate = parseFloat(stats.adjustedFailureRate.replace('%', ''));
      
      const healthStatus = adjustedRate < 5 ? 'healthy' 
        : adjustedRate < 15 ? 'degraded' 
        : 'critical';
      
      res.json({
        status: healthStatus,
        timestamp: new Date().toISOString(),
        last24Hours: {
          totalCalls: stats.totalCalls,
          successfulCalls: stats.successfulCalls,
          acceptFailures: stats.acceptFailures,
          dbErrors: stats.dbErrors,
          timeouts: stats.timeouts,
          unaccountedCalls: stats.unaccountedCalls,
          adjustedFailureRate: stats.adjustedFailureRate,
        },
        latency: {
          avgAcceptMs: stats.avgAcceptLatencyMs,
          p95AcceptMs: stats.p95AcceptLatencyMs,
        },
        activeCalls: activeCount,
        potentialOrphans: stats.potentialOrphanCount,
        tracesInMemory: completedCount,
      });
    } catch (error) {
      console.error('[DIAGNOSTICS] Error getting stats:', error);
      res.status(500).json({ error: 'Failed to get diagnostics' });
    }
  });
  
  // Get active call traces - for debugging (redacted for PHI safety)
  app.get("/api/voice/diagnostics/active", async (req, res) => {
    try {
      const disablePhiLogging = process.env.DISABLE_PHI_LOGGING === 'true';
      
      const traces = CallDiagnostics.getAllActiveTraces().map(trace => ({
        traceId: trace.traceId,
        twilioCallSid: disablePhiLogging ? '[REDACTED]' : (trace.twilioCallSid ? `...${trace.twilioCallSid.slice(-8)}` : null),
        openaiCallId: disablePhiLogging ? '[REDACTED]' : (trace.openaiCallId ? `...${trace.openaiCallId.slice(-8)}` : null),
        agentSlug: trace.agentSlug,
        stageCount: trace.stages.length,
        lastStage: trace.stages[trace.stages.length - 1]?.stage,
        elapsedMs: Date.now() - trace.startTime,
      }));
      
      res.json({
        count: traces.length,
        traces,
      });
    } catch (error) {
      console.error('[DIAGNOSTICS] Error getting active traces:', error);
      res.status(500).json({ error: 'Failed to get active traces' });
    }
  });

  // Get recent failures from completed traces - for operations monitoring
  app.get("/api/voice/diagnostics/recent-failures", async (req, res) => {
    try {
      const disablePhiLogging = process.env.DISABLE_PHI_LOGGING === 'true';
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      
      const stats = CallDiagnostics.getDailyStats();
      const allTraces = CallDiagnostics.getCompletedTraces();
      
      const failures = allTraces
        .filter((t: any) => t.outcome === 'accept_failed' || t.outcome === 'db_error' || t.outcome === 'timeout')
        .sort((a: any, b: any) => (b.completedAt || b.startTime) - (a.completedAt || a.startTime))
        .slice(0, limit)
        .map((trace: any) => ({
          traceId: trace.traceId,
          twilioCallSid: disablePhiLogging ? '[REDACTED]' : (trace.twilioCallSid ? `...${trace.twilioCallSid.slice(-8)}` : null),
          agentSlug: trace.agentSlug,
          outcome: trace.outcome,
          failureReason: trace.failureReason || 'Unknown',
          completedAt: trace.completedAt || trace.startTime,
          totalDurationMs: (trace.completedAt || Date.now()) - trace.startTime,
        }));
      
      res.json({
        failures,
        totalFailures24h: stats.acceptFailures + stats.dbErrors + stats.timeouts,
      });
    } catch (error) {
      console.error('[DIAGNOSTICS] Error getting recent failures:', error);
      res.status(500).json({ error: 'Failed to get recent failures' });
    }
  });

  console.log('[VOICE AGENT] Routes configured');
}
