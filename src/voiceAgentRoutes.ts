// Voice Agent Routes - Extracted from src/server.ts for modular integration
// Handles Twilio SIP integration and OpenAI Realtime API voice calls

process.on('unhandledRejection', (reason, promise) => {
  console.error('[PROCESS] Unhandled Promise rejection:', reason);
});

import { Express } from "express";
import OpenAI from "openai";
import { InvalidWebhookSignatureError } from "openai/error";
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
import { azulSchedulingAgentConfig, registerAzulHoldingCallback, unregisterAzulHoldingCallback, registerAzulOfficeTransferCallback, unregisterAzulOfficeTransferCallback, registerAzulTranscriptProvider, unregisterAzulTranscriptProvider } from './agents/azulSchedulingAgent';
import { flushAzulTimeline, getAzulTimeline, recordDirectorAction } from './services/toolTimeline';
import { callLifecycleCoordinator, getMaxDurationMs } from './services/callLifecycleCoordinator';
import { callMetadataForDB } from './services/callMetadataStore';
import { callSessionService } from './services/callSessionService';
import { withRetry, withResiliency, TICKETING_RETRY_CONFIG, TWILIO_RETRY_CONFIG, getCircuitBreaker } from './services/resilienceUtils';
import { getGreeterOpeningGreeting } from './utils/timeAware';
import { resolveConfiguredGreeting, scheduleGreetingCacheWarm } from './services/greetingResolver';
import { seedLedger, renderKnownFacts, releaseLedger } from './services/callFactsLedger';
import { startRamp, onCallerUtterance, rampActive, releaseRamp } from './services/rampEngine';
import { getLedger as getCallFacts } from './services/callFactsLedger';
import { storage } from '../server/storage';
import { registerTicketingSyncRoutes } from './voiceAgent';
import './services/azulRegressionWatch'; // Phase 7: daily grade-regression check (side-effect timers)
import { shadowTap } from './shadow/tap'; // observation-only tap; no-op unless SHADOW_MODE_ENABLED
import { resolveAbAssignment } from './services/abCarriage';
import { director, directorEnabledFor, type DirectorAction } from './director/director';
import { getEnvironmentConfig, resolveAppDomain } from './config/environment';
import { CallDiagnostics } from './services/callDiagnostics';
import { resolveHandoffDestination, resolvePcpDialSequence } from './services/handoffPolicy';
import { pcpAgentConfig } from './agents/pcpAgent';
import { SipConferenceLifecycle } from './services/sipConferenceLifecycle';
import { deadAirWatchdog, isActivityEvent, deadAirTimeoutMs } from './services/deadAirWatchdog';
import { buildTranscriptionConfig, transcriptionModel } from './config/transcription';
import { startProviderRosterRefresh } from './services/providerRoster';
import { recordTurn, flushTurns, releaseTurns } from './services/turnLog';

// Load centralized environment configuration
let envConfig: ReturnType<typeof getEnvironmentConfig>;
try {
  envConfig = getEnvironmentConfig();
} catch (e) {
  console.error('[ENV] Failed to load environment config, using fallback:', e);
  // Resolve the domain the same way the real config does, so this degraded path can't
  // emit `https://undefined/...` callbacks (DOMAIN unset) or reach for a dev host.
  const fallbackDomain = resolveAppDomain({
    domain: process.env.DOMAIN,
    replitDomains: process.env.REPLIT_DOMAINS,
    replitDevDomain: process.env.REPLIT_DEV_DOMAIN,
    isProduction: process.env.APP_ENV === 'production',
  }).domain;
  envConfig = {
    env: (process.env.APP_ENV as 'development' | 'production') || 'development',
    isDevelopment: process.env.APP_ENV !== 'production',
    isProduction: process.env.APP_ENV === 'production',
    domain: fallbackDomain,
    webhookBaseUrl: `https://${fallbackDomain}`,
    database: { url: process.env.DATABASE_URL || '', isSupabase: false },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      projectId: process.env.OPENAI_PROJECT_ID || '',
      webhookSecret: process.env.OPENAI_WEBHOOK_SECRET || '',
      realtimeWebhookUrl: `https://${fallbackDomain}/api/voice/realtime`,
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
      humanAgentNumber: process.env.HUMAN_AGENT_NUMBER,
      pcpHumanAgentNumber: process.env.PCP_HUMAN_AGENT_NUMBER,
      pcpAgentDids: (process.env.PCP_AGENT_DIDS || '').split(',').map((number) => number.trim()).filter(Boolean),
      pcpRoutingMode: process.env.PCP_ROUTING_MODE === 'sequential' ? 'sequential' : 'queue',
      urgentNotificationNumber: process.env.URGENT_NOTIFICATION_NUMBER,
    },
    ticketing: {
      apiKey: process.env.TICKETING_API_KEY,
      systemUrl: process.env.TICKETING_SYSTEM_URL,
      enrichmentUrl: process.env.TICKETING_ENRICHMENT_URL,
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

// Transcription vocabulary comes from the live schedule, refreshed daily. The
// hand-maintained list it replaces had 3 of 13 current providers and hinted a
// 'Thompson' who has not been on the schedule in ninety days.
startProviderRosterRefresh();
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

/**
 * Calls with a model response currently generating: added on `response.created`,
 * removed on `response.done`/`cancelled`.
 *
 * Exists so the director never sends a `response.cancel` with nothing to
 * cancel. That produces a server error, and this file's session error handler
 * treats every error off a three-item allowlist as fatal — so the cancel tore
 * down live calls. See applyDirectorAction for the measurement.
 */
const responseInFlight = new Set<string>();

/**
 * GREETING GUARANTEE. `response.create` is fire-and-forget: when the model is
 * already generating — semantic VAD auto-answers a caller who speaks first,
 * routine on the SD line where the hold TwiML invites a "hello?" — OpenAI
 * rejects the greeting as an async error event and nothing retried it. The
 * scripted opening simply never played and the model improvised from its
 * post-greeting flow (diagnosed on live SD calls 2026-08-06, after the DB
 * greeting rescue shipped and answering-service/pcp went verbatim).
 *
 * Protocol: the greeting is parked here at greeting time. If no response is
 * in flight it is also sent immediately. On every response.done/cancelled we
 * check whether the finished response actually spoke it (transcript prefix
 * match — a barge-in that truncates a started greeting still counts as
 * delivered); if not, resend at the turn boundary — the one moment a
 * response.create cannot collide. Two attempts inside a 20s window: past
 * that, a late greeting is weirder than the miss.
 */
const GREETING_GUARANTEE_WINDOW_MS = 20_000;
interface PendingGreeting {
  instructions: string;
  prefix: string;
  attempts: number;
  expiresAt: number;
  transport: { sendEvent: (e: unknown) => void };
}
const pendingGreetings = new Map<string, PendingGreeting>();

/** CP-4: lines running the deterministic ramp (env override RAMP_AGENTS). */
const RAMP_AGENTS = new Set((process.env.RAMP_AGENTS ?? 'answering-service,pcp,azul-scheduling').split(',').map((x) => x.trim()).filter(Boolean));

/** CP-2: last KNOWN-FACTS block injected per call — re-inject only on change. */
const lastFactsRender = new Map<string, string>();

function normaliseSpoken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function sendPendingGreeting(callId: string, pending: PendingGreeting): void {
  pending.attempts++;
  try {
    pending.transport.sendEvent({
      type: 'response.create',
      response: { instructions: pending.instructions },
    });
  } catch (err) {
    console.error(`[GREETING] Failed to send greeting for ${callId}:`, err);
  }
}

function armGreetingGuarantee(
  callId: string,
  greeting: string,
  instructions: string,
  transport: { sendEvent: (e: unknown) => void },
): void {
  const pending: PendingGreeting = {
    instructions,
    prefix: normaliseSpoken(greeting).slice(0, 15),
    attempts: 0,
    expiresAt: Date.now() + GREETING_GUARANTEE_WINDOW_MS,
    transport,
  };
  pendingGreetings.set(callId, pending);
  if (responseInFlight.has(callId)) {
    console.info(`[GREETING] Response already in flight for ${callId} — greeting parked for the next turn boundary`);
    return;
  }
  sendPendingGreeting(callId, pending);
}

function extractResponseTranscript(event: any): string {
  const parts: string[] = [];
  for (const item of event?.response?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (typeof c?.transcript === 'string') parts.push(c.transcript);
      else if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join(' ');
}

/** Turn-boundary check: did the response that just finished speak the greeting? */
function checkGreetingDelivered(callId: string, event: any): void {
  const pending = pendingGreetings.get(callId);
  if (!pending) return;
  if (Date.now() > pending.expiresAt) {
    pendingGreetings.delete(callId);
    lastFactsRender.delete(callId);
    releaseLedger(callId);
    void import('./services/toolDirection').then(({ releaseDirectionState }) => releaseDirectionState(callId));
    releaseRamp(callId);
    return;
  }
  const spoken = normaliseSpoken(extractResponseTranscript(event));
  if (pending.attempts > 0 && pending.prefix && spoken.startsWith(pending.prefix)) {
    pendingGreetings.delete(callId);
    lastFactsRender.delete(callId);
    releaseLedger(callId);
    void import('./services/toolDirection').then(({ releaseDirectionState }) => releaseDirectionState(callId));
    releaseRamp(callId); // greeting (or its barged-in start) played
    return;
  }
  if (pending.attempts >= 2) {
    console.warn(`[GREETING] Giving up on greeting for ${callId} after ${pending.attempts} attempts (last turn heard: "${spoken.slice(0, 60)}")`);
    pendingGreetings.delete(callId);
    lastFactsRender.delete(callId);
    releaseLedger(callId);
    void import('./services/toolDirection').then(({ releaseDirectionState }) => releaseDirectionState(callId));
    releaseRamp(callId);
    return;
  }
  console.info(`[GREETING] Turn ended without the scripted greeting on ${callId} (heard: "${spoken.slice(0, 60)}") — resending at turn boundary`);
  sendPendingGreeting(callId, pending);
}

const callMetadata = new Map<string, { agentSlug: string; campaignId?: string; contactId?: string; agentGreeting?: string; language?: string; ivrSelection?: '1' | '2' | '3' | '4' }>();
const callIDtoConferenceNameMapping: Record<string, string | undefined> = {};
const ConferenceNametoCallerIDMapping: Record<string, string | undefined> = {};
const ConferenceNametoCalledNumberMapping: Record<string, string | undefined> = {}; // Dialed/To number
const ConferenceNametoCallTokenMapping: Record<string, string | undefined> = {};
const conferenceNameToCallID: Record<string, string | undefined> = {};

// Tracks conferences where the REAL OpenAI realtime.call.incoming webhook has arrived.
// ONLY populated by the /api/voice/realtime handler — NOT by conference join events.
// The emergency fallback timer checks this to decide whether to dial a human.
const openAIWebhookConfirmed = new Set<string>();
const conferenceNameToTwilioCallSid: Record<string, string | undefined> = {}; // Map conference name → Twilio CallSid
const conferenceSidToCallLogId: Record<string, string | undefined> = {}; // Map Twilio conference SID → DB call log ID

// Note: warm transfer functionality has been removed

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
const pcpHandoffProgress = new Map<string, (instructions: string) => void>();

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

// NOTE: the SIP watchdog's max-duration timer uses getMaxDurationMs(agentSlug)
// from callLifecycleCoordinator, NOT a constant here. A hardcoded
// SIP_MAX_DURATION_MS used to live on this line, unreferenced — changing it
// did nothing, which is a trap for anyone trying to adjust call length.
// Call durations are configured in AGENT_MAX_DURATION_MS, one place.
const sipWatchdogs = new Map<string, SIPWatchdog>();
const sipConferenceLifecycle = new SipConferenceLifecycle();

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
  const directSipCallSid = sipConferenceLifecycle.takeSipLegForConference(conferenceName);
  const sipCallSid = watchdog?.sipCallSid ?? directSipCallSid;
  if (!sipCallSid) return;
  
  console.warn(`[WATCHDOG] ⚠️ Terminating orphaned SIP call: ${sipCallSid} (reason: ${reason})`);
  
  // Cancel both watchdog timers
  if (watchdog) {
    clearTimeout(watchdog.timer);
    clearTimeout(watchdog.maxDurationTimer);
    sipWatchdogs.delete(conferenceName);
  }
  
  try {
    const client = await getTwilioClient();
    await client.calls(sipCallSid).update({ status: 'completed' });
    console.info(`[WATCHDOG] ✓ Orphaned SIP call terminated: ${sipCallSid}`);
  } catch (error: any) {
    // Call may already be completed, which is fine
    if (error.code === 20404) {
      console.info(`[WATCHDOG] SIP call already completed: ${sipCallSid}`);
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
    
    // Always use the original Twilio webhook CallToken — it is generated per-call by
    // OpenAI's SIP integration and carries the webhook URL config that routes accept callbacks.
    // A generic client_secret from the sessions API does NOT trigger the webhook callback.
    const effectiveToken = callToken;
    if (retryCount > 0) {
      console.info('[WATCHDOG] Reusing original callToken for retry');
    }
    
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
        callToken: effectiveToken,
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
  
  // CRITICAL: Set up adaptive max-duration safety timer
  // This terminates orphaned SIP calls even if no conference events are received
  // Prevents 60-minute OpenAI sessions from accumulating costs
  const agentMaxDurationMs = getMaxDurationMs(agentSlug);
  const maxDurationTimer = setTimeout(async () => {
    console.warn(`[WATCHDOG] ⚠️ Max duration (${agentMaxDurationMs / 60000}min) reached for ${conferenceName} (agent: ${agentSlug || 'unknown'})`);
    await terminateOrphanedSIPCall(conferenceName, 'max_duration_exceeded');
  }, agentMaxDurationMs);
  
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
  
  console.info(`[WATCHDOG] Started for ${conferenceName} (15s check, ${agentMaxDurationMs / 60000}min max, agent: ${agentSlug || 'default'})`);
}

// Per-agent semantic-VAD eagerness. Tried 'low' for azul-scheduling to
// stop coughs/background noise interrupting the agent (pilot calls 6-7,
// 2026-07-20) — REVERTED same day: 'low' also makes the VAD slow to
// commit the CALLER's turn, so responses lagged, the caller repeated
// themselves and "hello?"-ed into the gap (pilot call 8). Turn-taking
// responsiveness matters more; noise recovery is handled in the prompt
// (resume-mid-sentence rules). Keep the hook for future per-agent tuning.
function vadEagernessFor(_agentSlug?: string | null): 'low' | 'medium' {
  return 'medium';
}

// Session options for consistent configuration
// NOTE: Voice and language are NOT set here - they're configured at call accept time
// This prevents "cannot_update_voice" errors when session connects
// IMPORTANT: SDK 0.3.7 uses toNewSessionConfig() which has two paths:
// - "deprecated" path: triggered by top-level camelCase fields (turnDetection, inputAudioTranscription)
// - "new" path: expects nested audio.input.turnDetection structure
// We use the new nested structure to ensure fields pass through correctly.
// SIP MODE: Audio format MUST be g711_ulaw everywhere — accept payload AND session.update.
// If session.update omits the format, it clobbers the accept payload back to PCM16 defaults.
// OpenAI confirmed: "static is caused by clobbering of audio formats" when tools are present.
const sessionOptions: Partial<RealtimeSessionOptions> = {
  model: 'gpt-realtime',
  config: {
    audio: {
      input: {
        format: 'g711_ulaw',
        transcription: buildTranscriptionConfig(),
        turnDetection: {
          type: 'semantic_vad',
          eagerness: 'medium',
          createResponse: true,
          interruptResponse: true,
        },
      },
      output: {
        format: 'g711_ulaw',
      },
    },
  } as any,
  outputGuardrails: medicalSafetyGuardrails,
};

// Store transcripts by call ID
const callTranscripts = new Map<string, string[]>();

// SEV-1 2026-07-30: server-side re-ask cap. The transcript stream below is
// the only place the whole system sees every agent and caller line live —
// the loop guard rides it, keeps the asked-topic ledger the model doesn't
// have, and injects a SYSTEM item when a threshold trips. ~180 calls/day
// were looping 3+ identity asks with every anti-loop rule living in prompt
// prose only.
import { conversationLoopGuard, type LoopGuardDirective, type LoopGuardStats } from './services/conversationLoopGuard';

// Caller barge-ins truncate the in-flight agent response; counting those
// events is what finally populates interruption/truncation telemetry
// (declared in Phase 7, zero writers until now — the graders reading them
// returned a permanent neutral 0.5 on 100% of calls). The count lives in the
// loop guard's per-call state so it resolves through the same alias table.

/** Persist the loop guard's turn telemetry for whichever teardown path gets
 *  there first. `key` may be the OpenAI callId or any registered alias
 *  (dbCallLogId / twilioCallSid). Returns the stats it wrote, or undefined
 *  when another path already flushed them. */
async function flushLoopTelemetry(key: string, callLogId: string): Promise<LoopGuardStats | undefined> {
  const stats = conversationLoopGuard.endCall(key);
  if (!stats) return undefined;
  try {
    const { storage } = await import('../server/storage');
    await storage.updateCallLog(callLogId, {
      totalTurns: stats.agentLines + stats.callerLines,
      // Both derived from conversation.item.truncated: with semantic VAD +
      // interruptResponse, a barge-in and a truncation are the same event.
      interruptionCount: stats.truncations,
      truncationCount: stats.truncations,
      telemetrySource: 'transport-events',
    } as any);
    if (stats.interventions.length > 0) {
      console.warn(`[LOOP-GUARD] ${callLogId} ended with interventions: ${stats.interventions.join(', ')} (asks: ${JSON.stringify(stats.asksByTopic)})`);
    }
  } catch (err) {
    console.error(`[LOOP-GUARD] telemetry write failed for ${callLogId}:`, err);
  }
  return stats;
}

/** What we dialed for a warm transfer, keyed by the OFFICE leg's CallSid, so
 *  the accept/status webhooks can attribute an outcome to it. */
const officeLegDials = new Map<string, { openAiCallId: string; dialedNumber: string; queueLabel: string; dialedAt: number }>();

/** Persist the office leg's result onto the call log. This is the record that
 *  answers "did the office actually pick up, and which office was it?" — a
 *  question that had NO answer in the database before 2026-07-30, when an
 *  office manager found a routing bug that no dashboard could have shown. */
async function recordTransferOutcome(
  officeCallSid: string,
  outcome: 'accepted' | 'no_answer' | 'busy' | 'failed' | 'canceled' | 'machine' | 'no_keypress',
  extra: { acceptMethod?: 'keypress' | 'stay_on_line' | null; amdVerdict?: string | null } = {},
): Promise<void> {
  const dial = officeLegDials.get(officeCallSid);
  if (!dial) return;
  officeLegDials.delete(officeCallSid);
  const callLogId = callMetadataForDB.get(dial.openAiCallId)?.dbCallLogId;
  if (!callLogId) return;
  try {
    const { storage } = await import('../server/storage');
    await storage.updateCallLog(callLogId, {
      transferOutcome: {
        officeCallSid,
        dialedNumber: dial.dialedNumber,
        queueLabel: dial.queueLabel,
        outcome,
        acceptMethod: extra.acceptMethod ?? null,
        amdVerdict: extra.amdVerdict ?? null,
        ringSeconds: Math.round((Date.now() - dial.dialedAt) / 1000),
        at: new Date().toISOString(),
      },
    } as any);
    console.info(`[WARM-TRANSFER] outcome recorded for ${callLogId}: ${outcome} — ${dial.queueLabel} (${dial.dialedNumber})`);
  } catch (err) {
    console.error(`[WARM-TRANSFER] failed to record outcome for ${callLogId}:`, err);
  }
}

function sendLoopGuardDirective(session: any, callId: string, directive: LoopGuardDirective): void {
  try {
    (session.transport as any).sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: directive.text }] },
    });
    console.warn(`[LOOP-GUARD] ${directive.kind}${directive.topic ? `:${directive.topic}` : ''} injected for ${callId}`);
  } catch (e) {
    console.error(`[LOOP-GUARD] failed to inject directive for ${callId}:`, e);
  }
}

/**
 * Apply a director decision to the live session.
 *
 * 'inject' is the existing loop-guard mechanism: a system message the model
 * MAY heed. Call afb1e688 proved it may also ignore it — the guard fired on
 * the third date-of-birth ask and the model asked four more times.
 *
 * 'author' and 'force_exit' therefore stop asking and take the turn: cancel
 * whatever the model is saying, state the required words as a system
 * instruction, and drive a fresh response with those instructions. The caller
 * hears one clean sentence instead of the seventh repeat of a question they
 * already answered.
 */
function applyDirectorAction(session: any, callId: string, agentSlug: string, action: DirectorAction): void {
  try {
    const transport = session?.transport as any;
    if (!transport?.sendEvent) return;

    transport.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: action.text }] },
    });

    if (action.enforcement !== 'inject') {
      // Cut the in-flight utterance. Mid-loop this is a mercy: the model is
      // repeating a question the caller has already answered.
      //
      // ONLY when something is actually in flight. The try/catch below looks
      // like it covers the empty case and does not: sendEvent returns as soon
      // as the frame is written, and the "no active response" complaint comes
      // back later as a server `error` event. session.on('error') treats
      // anything off its three-item allowlist as fatal and runs full cleanup —
      // so a cancel with nothing to cancel tore down a LIVE call: coordinator
      // notified of session end, director state released, transcript buffer
      // deleted, call-log mapping dropped, post-call cost/grading/ticketing
      // pipeline started while the caller was still talking.
      //
      // Measured on 2026-08-05, first day the turn table could see it: 41 calls
      // took an author/force_exit action, 15 of them (37%) split into two turn
      // buffers seconds later, the second with no call_log_id. Zero calls split
      // without an authored action. The director rules on
      // response.audio_transcript.done, which fires BEFORE response.done, so
      // whether anything is still in flight is a race — which is exactly why it
      // was intermittent rather than obvious.
      if (responseInFlight.has(callId)) {
        try {
          transport.sendEvent({ type: 'response.cancel' });
        } catch { /* already gone — fine */ }
      }
      // The closing line is the last and most specific thing the model reads,
      // so it is the one it obeys. "Speak ONLY this, then stop" is right when
      // the goal is to stop the model talking — and wrong when the goal is to
      // make it act. The identity ceiling shipped with the system message
      // saying "call create_ticket NOW" and this line saying "then stop": it
      // asked for a ticket and forbade the model to file one in the same
      // breath. When the action names a required tool call, require it here.
      const closing = action.then
        ? `Say this, verbatim, and say nothing else: "${action.speak}"\n` +
          `Then, in this same turn, ${action.then}. ` +
          `Do not ask the caller any further questions — you already have enough to act.`
        : `Speak ONLY this, verbatim, then stop: "${action.speak}"`;
      transport.sendEvent({
        type: 'response.create',
        response: { instructions: `${action.text}\n\n${closing}` },
      });
    }

    console.warn(
      `[DIRECTOR] ${action.enforcement}:${action.code}:${action.topic} applied for ${callId}`,
    );

    // Durable record. Deliberately AFTER the transport writes: the
    // intervention is the product, the telemetry is the receipt, and a
    // telemetry failure must never cost the caller the intervention. Only the
    // verdict is stored — action.text and action.speak quote the caller and
    // never leave the call.
    recordDirectorAction(callId, agentSlug, action);
  } catch (e) {
    // A director failure must never break a call.
    console.error(`[DIRECTOR] failed to apply action for ${callId}:`, e);
  }
}

// Per-call Realtime token accumulation (from response.done usage payloads).
// Flushed to callCostService.updateCallCostsWithTokens at call end so per-call
// OpenAI costs come from REAL token counts + the model pricing registry
// instead of the duration estimate. (The token pipeline existed but was
// never wired to the session events — cost-dashboard audit 2026-07-19.)
interface CallTokenAccumulator {
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  inputCachedTokens: number;
  responses: number;
}
const callTokenUsage = new Map<string, CallTokenAccumulator>();

function accumulateUsage(callId: string, usage: any): void {
  if (!usage) return;
  let acc = callTokenUsage.get(callId);
  if (!acc) {
    acc = { inputAudioTokens: 0, outputAudioTokens: 0, inputTextTokens: 0, outputTextTokens: 0, inputCachedTokens: 0, responses: 0 };
    callTokenUsage.set(callId, acc);
  }
  const inDet = usage.input_token_details ?? {};
  const outDet = usage.output_token_details ?? {};
  acc.inputAudioTokens += Number(inDet.audio_tokens ?? 0);
  acc.inputTextTokens += Number(inDet.text_tokens ?? 0);
  acc.inputCachedTokens += Number(inDet.cached_tokens ?? 0);
  acc.outputAudioTokens += Number(outDet.audio_tokens ?? 0);
  acc.outputTextTokens += Number(outDet.text_tokens ?? 0);
  acc.responses += 1;
}

// Track calls where we've sent AirCall DTMF (avoid sending multiple times)
const aircallDTMFSent = new Set<string>();

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

/**
 * The urgent-escalation safety net: whatever happened to the transfer, the
 * patient ends up as an URGENT ticket somebody has to work.
 *
 * Shared by both failure paths. It used to cover only "the human did not
 * answer"; a dial that THREW — Twilio down, circuit breaker open, an
 * unroutable number — returned silently and left the urgent caller existing
 * nowhere but a console line. Same net under both.
 */
async function fileUrgentHandoffFallbackTicket(
  openAiCallId: string,
  escalationDetails: { reason?: string; symptomsSummary?: string; patientFirstName?: string; patientLastName?: string } | undefined,
  callerID: string | null | undefined,
  ctx: { why: string; dialTarget?: string },
): Promise<void> {
  console.warn(`[HANDOFF] Creating urgent fallback ticket — ${ctx.why}`);
  try {
    const { SyncAgentService } = await import('./services/syncAgentService');
    const { AFTER_HOURS_DEPARTMENT_ID, TRIAGE_OUTCOME_MAPPINGS } = await import('./config/afterHoursTicketing');

    const urgentMapping = TRIAGE_OUTCOME_MAPPINGS['sudden_vision_loss']; // generic urgent
    const patientFirst = escalationDetails?.patientFirstName || 'Unknown';
    const patientLast = escalationDetails?.patientLastName || 'Caller';
    const rawPhone = callerID || '';
    const digits = rawPhone.replace(/\D/g, '');
    const formattedPhone = digits.length === 10
      ? `+1${digits}`
      : rawPhone.startsWith('+') ? rawPhone : `+${digits}`;

    const descParts: string[] = [ctx.why, 'Please call the patient back immediately.'];
    if (ctx.dialTarget) descParts.push(`Attempted transfer to: ${ctx.dialTarget}`);
    if (escalationDetails?.reason) descParts.push(`Reason: ${escalationDetails.reason}`);
    if (escalationDetails?.symptomsSummary) descParts.push(`Symptoms: ${escalationDetails.symptomsSummary}`);

    const conferenceName = getConferenceName(openAiCallId);
    const ticketResult = await SyncAgentService.createTicket({
      departmentId: AFTER_HOURS_DEPARTMENT_ID,
      requestTypeId: urgentMapping.requestTypeId,
      requestReasonId: urgentMapping.requestReasonId,
      patientFirstName: patientFirst,
      patientLastName: patientLast,
      patientPhone: formattedPhone,
      description: descParts.join('\n'),
      priority: 'urgent',
      callData: {
        callSid: conferenceName ? getTwilioCallSid(conferenceName) : undefined,
        callerPhone: callerID || undefined,
        // Label with the agent actually on the call, not a hardcoded slug.
        agentUsed: callMetadataForDB.get(openAiCallId)?.agentSlug || 'after-hours',
      },
    });

    if (ticketResult.success) {
      console.log('[HANDOFF] ✓ Urgent fallback ticket created:', ticketResult.ticketNumber);
    } else {
      console.error('[HANDOFF] ✗ Urgent fallback ticket creation failed:', ticketResult.error);
    }
  } catch (ticketErr) {
    console.error('[HANDOFF] ✗ Exception creating urgent fallback ticket:', ticketErr);
  }
}

// Handle human agent handoff
type HandoffOutcome = { ok: true; destination: string } | { ok: false; status: string; reason: string };

async function addHumanAgent(openAiCallId: string): Promise<HandoffOutcome> {
  // Use wrapper function that checks both legacy maps and service cache
  const conferenceName = getConferenceName(openAiCallId);
  if (!conferenceName) {
    console.error('[HANDOFF] ✗ Conference name not found for call ID:', openAiCallId);
    return { ok: false, status: 'FAILED', reason: 'conference_not_found' };
  }

  // Get escalation details for this call
  const escalationDetails = escalationDetailsMap.get(openAiCallId);
  
  const callerType = escalationDetails?.callerType;
  const policy = resolveHandoffDestination({
    agentSlug: escalationDetails?.agentSlug,
    callerType,
    clinicalNumber: HUMAN_AGENT_NUMBER,
    pcpNumber: envConfig.twilio.pcpHumanAgentNumber,
  });

  if (!policy.allowed) {
    console.warn(`[HANDOFF] ⚠️ BLOCKED - Invalid caller type for handoff: "${callerType || 'none'}"`);
    console.warn(`[HANDOFF]   Reason given: ${escalationDetails?.reason || 'Not specified'}`);
    console.warn(`[HANDOFF]   Policy reason: ${policy.reason}`);
    return { ok: false, status: 'HANDOFF_UNAVAILABLE', reason: policy.reason };
  }
  let handoffDestination = policy.destination;
  
  console.log('\n========================================');
  console.log(`[HANDOFF] ✓ Validated - Transferring to human agent`);
  console.log(`   Conference: ${conferenceName}`);
  console.log(`   Human Number: ${handoffDestination}`);
  if (escalationDetails) {
    console.log(`   Caller Type: ${escalationDetails.callerType || 'Unknown'}`);
    if (policy.policy === 'pcp') {
      console.log(`   PCP context present: reason=${Boolean(escalationDetails.reason)}, organization=${Boolean(escalationDetails.providerInfo)}, patient=${Boolean(escalationDetails.patientFirstName)}`);
    } else {
      console.log(`   Reason: ${escalationDetails.reason || 'Not specified'}`);
      if (escalationDetails.providerInfo) {
        console.log(`   Provider: ${escalationDetails.providerInfo}`);
      }
      if (escalationDetails.patientFirstName) {
        console.log(`   Patient: ${escalationDetails.patientFirstName} ${escalationDetails.patientLastName || ''}`);
      }
    }
  }
  console.log('========================================\n');

  const callerID = getCallerNumber(conferenceName); // Uses wrapper with fallback to service cache

  if (!callerID) {
    console.error('[HANDOFF] ✗ Missing callerID');
    return { ok: false, status: 'FAILED', reason: 'caller_id_missing' };
  }

  // WHERE the urgent call goes. Until 2026-08-03 this was always the global
  // HUMAN_AGENT_NUMBER (the operator's mobile), at any hour, for any location.
  // Operator directive: reach the OFFICE directly during business hours, keep
  // on-call outside them, urgent ticket as the fallback either way. The
  // resolver degrades to HUMAN_AGENT_NUMBER on every failure path, so this is
  // never worse than the behaviour it replaces.
  // Layered ON TOP of resolveHandoffDestination, never instead of it. The
  // policy resolver decides WHICH CONTRACT this call falls under — clinical
  // or PCP — and that decision is not ours to second-guess. A PCP handoff is
  // a professional caller with its own dial sequence and its own ticketing;
  // routing one into an office front desk would be wrong. So the office queue
  // only ever replaces the CLINICAL destination.
  let dialSource = 'policy';
  if (policy.policy !== 'pcp') {
    const { resolveUrgentTransferTarget } = await import('./services/urgentTransfer');
    const target = await resolveUrgentTransferTarget({
      reason: escalationDetails?.reason ?? 'urgent escalation',
      callerPhone: callerID || undefined,
      onCallNumber: handoffDestination,
      // Only an authorized agent may be handed the on-call phone. Without
      // this, an office-less result fell back to it from ANY agent.
      agentSlug: escalationDetails?.agentSlug,
    });
    if (target?.number) {
      handoffDestination = target.number;
      dialSource = target.source + (target.queueLabel ? ` — ${target.queueLabel}` : '');
    }
  }
  console.log(`[HANDOFF] Dialing ${handoffDestination} (${dialSource})`);

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

    const pcpDialSequence = policy.policy === 'pcp'
      ? resolvePcpDialSequence({
          mode: envConfig.twilio.pcpRoutingMode,
          queueNumber: envConfig.twilio.pcpHumanAgentNumber,
          agentDids: envConfig.twilio.pcpAgentDids,
        })
      : [];
    
    // STEP 1: Send SMS notification immediately (fire and forget)
    // Provider gets heads-up while we're dialing them
    // Use centralized config for production compatibility
    const URGENT_NOTIFICATION_NUMBER = envConfig.twilio.urgentNotificationNumber;
    if (URGENT_NOTIFICATION_NUMBER && policy.policy !== 'pcp') {
      (async () => {
        try {
          const callerNumber = callerID || 'Unknown';
          const callTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
          
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
    
    let sequentialPcpAnswered = false;
    if (policy.policy === 'pcp' && envConfig.twilio.pcpRoutingMode === 'sequential') {
      abortedPcpHandoffs.delete(openAiCallId);
      if (pcpDialSequence.length === 0) return { ok: false, status: 'HANDOFF_UNAVAILABLE', reason: 'pcp_agent_dids_not_configured' };
      const briefing = [
        'This is the Azul Vision PCP support assistant with a live professional caller transfer.',
        escalationDetails?.providerInfo ? `Caller organization and role: ${escalationDetails.providerInfo}.` : null,
        escalationDetails?.reason ? `Reason: ${escalationDetails.reason}.` : null,
        'Press any key to accept, or remain on the line to connect.',
      ].filter(Boolean).join(' ');
      for (let index = 0; index < pcpDialSequence.length; index += 1) {
        if (abortedPcpHandoffs.has(openAiCallId)) return { ok: false, status: 'FAILED', reason: 'caller_disconnected' };
        const destination = pcpDialSequence[index];
        console.log(`[HANDOFF] PCP sequential attempt ${index + 1}/${pcpDialSequence.length}`);
        if (index > 0) {
          pcpHandoffProgress.get(openAiCallId)?.(
            `Say exactly: "That team member wasn't available, so I'm trying the next person now. Please stay with me." Say nothing else.`,
          );
        }
        const progress = pcpHandoffProgress.get(openAiCallId);
        let progressInterval: ReturnType<typeof setInterval> | undefined;
        const progressFirst = progress ? setTimeout(() => {
          progress('Say exactly: "I’m still working on the connection for you. Please stay on the line." Say nothing else.');
          progressInterval = setInterval(() => progress('Say exactly: "Thank you for holding. I’m still trying to reach the PCP team." Say nothing else.'), 10_000);
        }, 8_000) : undefined;
        const outcome = await transferConferenceToNumber(openAiCallId, destination, `PCP team member ${index + 1}`, briefing);
        if (progressFirst) clearTimeout(progressFirst);
        if (progressInterval) clearInterval(progressInterval);
        if (outcome.ok) {
          handoffDestination = destination;
          sequentialPcpAnswered = true;
          console.log(`[HANDOFF] ✓ PCP sequential attempt ${index + 1} answered`);
          // BREAK, do not return. Returning here skipped STEP 4 entirely —
          // the block that disconnects the AI from the conference, sets
          // callMeta.transferredToHuman, calls markTransferred() so the
          // lifecycle coordinator cannot overwrite it, and writes the call log
          // as status 'transferred'. `sequentialPcpAnswered = true` on the line
          // above exists precisely so the clinical dial below is skipped and
          // execution reaches STEP 4; the return made that flag dead code.
          //
          // Call 532f09ac (2026-08-06 18:51): a staffer pressed a key at
          // 18:56:39 and the row still reads transferred_to_human=false, with
          // the agent audible on the line afterwards because it was never
          // disconnected from the conference. The transfer itself worked; the
          // completion of it never ran.
          break;
        }
        if (abortedPcpHandoffs.has(openAiCallId)) return { ok: false, status: 'FAILED', reason: 'caller_disconnected' };
        console.warn(`[HANDOFF] PCP sequential attempt ${index + 1} was not accepted: ${outcome.detail || 'unknown'}`);
      }
      // Only when the loop exhausted every destination without an accept —
      // reached by falling out of the for, never by the break above.
      if (!sequentialPcpAnswered) {
        pcpHandoffProgress.get(openAiCallId)?.(
          'Say exactly: "Thanks for holding. I couldn’t reach the team live, but your PCP request has already been recorded for follow-up." Say nothing else and do not claim a transfer occurred.',
        );
        return { ok: false, status: 'NO_ANSWER', reason: 'pcp_sequence_no_answer' };
      }
    }

    if (!sequentialPcpAnswered) {
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
          to: handoffDestination,
          label: dialSource.startsWith('office_queue') ? 'office queue' : 'human agent',
          // Operator-specified UX (2026-07-22, applies to ALL transfers):
          // no pre-answer ringback into the conference — the caller hears
          // the agent, then the human, never the raw ring.
          earlyMedia: false,
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
      // The AI is still connected, so the caller is not stranded mid-air —
      // but this path used to leave NO RECORD AT ALL. A no-answer filed an
      // urgent fallback ticket; a dial that threw (Twilio down, circuit
      // breaker open, bad number) filed nothing, and the urgent caller
      // existed only in a console line. Same net under both.
      //
      // PCP is excluded for the same reason the no-answer path excludes it:
      // it files its own structured ticket before dialing, and a
      // professional-caller failure must never land in the patient
      // after-hours contract.
      if (policy.policy !== 'pcp') {
        void fileUrgentHandoffFallbackTicket(openAiCallId, escalationDetails, callerID, {
          why: `Transfer dial failed: ${dialError instanceof Error ? dialError.message : String(dialError)}`,
          dialTarget: handoffDestination,
        });
      }
      return { ok: false, status: 'FAILED', reason: 'dial_failed' };
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

      // PCP creates its own structured ticket before dialing. Never route a
      // professional-caller failure into the patient/after-hours contract.
      if (policy.policy === 'pcp') {
        return { ok: false, status: 'NO_ANSWER', reason: 'human_no_answer' };
      }
      await fileUrgentHandoffFallbackTicket(openAiCallId, escalationDetails, callerID, {
        why: 'URGENT TRANSFER NOT ANSWERED: The patient was transferred but no one picked up.',
        dialTarget: handoffDestination,
      });

      return { ok: false, status: 'NO_ANSWER', reason: 'human_no_answer' };
    }
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
    
    // Capture patient name from escalation details BEFORE deleting the map entry
    const escalationDetailsBeforeDelete = escalationDetailsMap.get(openAiCallId);
    const capturedFirstName = escalationDetailsBeforeDelete?.patientFirstName;
    const capturedLastName = escalationDetailsBeforeDelete?.patientLastName;
    const capturedCallerType = escalationDetailsBeforeDelete?.callerType;
    
    // Assemble caller name: prefer first+last, fall back to callerType, otherwise leave undefined
    const capturedCallerName = (capturedFirstName || capturedLastName)
      ? [capturedFirstName, capturedLastName].filter(Boolean).join(' ').trim()
      : (capturedCallerType || undefined);

    // Store in callMetadataForDB so post-call async blocks can also access it
    const callMetaForName = callMetadataForDB.get(openAiCallId);
    if (callMetaForName && capturedCallerName) {
      callMetaForName.callerName = capturedCallerName;
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
            humanAgentNumber: handoffDestination,
            costIsEstimated: true,  // Mark as estimated until Twilio confirms
            ...(capturedCallerName ? { callerName: capturedCallerName } : {}),
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
              
              // Only grade substantive calls (skip ghost/short calls to save LLM costs)
              if (transcript.length > 200) {
                await callGradingService.gradeCall(callLogId, transcript);
              }

              console.info(`[POST-CALL] Cost and grading processed for handoff call ${callLogId}`);

              // Twilio Lookup enrichment — run if the AI didn't collect a caller name
              try {
                const { DatabaseStorage } = await import('../server/storage');
                const storageForLookup = new DatabaseStorage();
                const handoffCallLog = await storageForLookup.getCallLog(callLogId);
                if (!handoffCallLog?.callerName && callMeta.from) {
                  const { lookupCallerName } = await import('./lib/twilioClient');
                  const enrichedName = await lookupCallerName(callMeta.from);
                  if (enrichedName) {
                    await storageForLookup.updateCallLog(callLogId, { callerName: enrichedName });
                    console.info(`[LOOKUP] Enriched callerName for handoff call ${callLogId}: ${enrichedName}`);
                  }
                }
              } catch (lookupErr) {
                console.warn('[LOOKUP] Handoff caller-name enrichment step failed (non-fatal):', (lookupErr as Error)?.message ?? lookupErr);
              }

              // QVO event — 20-second delay lets Twilio costs reconcile first
              const callLogIdForQvo = callLogId;
              setTimeout(async () => {
                try {
                  const { qvoEmitterService } = await import('./services/qvoEmitterService');
                  await qvoEmitterService.emitCallCompleted(callLogIdForQvo);
                } catch { /* never propagate */ }
              }, 20_000);
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
    return { ok: true, destination: handoffDestination };
  } catch (error) {
    console.error('[HANDOFF ERROR]', error);
    return { ok: false, status: 'FAILED', reason: error instanceof Error ? error.message : 'handoff_failed' };
  }
}

// WARM TRANSFER (azul-scheduling, ship gate per docs/scheduling-agent/
// ARCHITECTURE.md §2.3): the office is dialed as a SEPARATE outbound call
// whose TwiML plays a briefing built from the handoff packet and requires a
// keypress to accept. Only the keypress joins the staffer into the caller's
// conference — voicemail and IVRs never connect, and the staffer arrives
// already knowing who's calling and why, so the patient repeats nothing.
// The caller hears silence + the agent's periodic cut-ins during the whole
// attempt (earlyMedia is irrelevant here — the office leg isn't in the
// conference until accept). Failure handling remains the agent's job.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function conferenceWasTransferredToHuman(conferenceName: string): boolean {
  const openAiCallId = getCallIdByConference(conferenceName);
  return Boolean(openAiCallId && callMetadataForDB.get(openAiCallId)?.transferredToHuman);
}

/**
 * If the OpenAI/Sage leg disappears while the caller is still connected,
 * replace the stranded conference with the established answering-service
 * fallback. The caller leg is fetched first so a late/duplicate SIP callback
 * cannot resurrect or redirect an already-ended call.
 */
async function recoverCallerAfterSipTermination(conferenceName: string, status: string): Promise<void> {
  if (conferenceWasTransferredToHuman(conferenceName)) {
    console.info(`[SIP-RECOVERY] Skipping ${conferenceName}: human transfer already completed`);
    return;
  }

  const callerCallSid = getTwilioCallSid(conferenceName);
  if (!callerCallSid) {
    console.warn(`[SIP-RECOVERY] No caller CallSid found for ${conferenceName}`);
    return;
  }

  try {
    const client = await getTwilioClient();
    const callerCall = await client.calls(callerCallSid).fetch();
    if (callerCall.status !== 'in-progress') {
      console.info(`[SIP-RECOVERY] Caller ${callerCallSid} already ${callerCall.status}; no fallback needed`);
      return;
    }

    const fallbackNumber = HUMAN_AGENT_NUMBER || '+18186021567';
    const callerIdAttribute = envConfig.twilio.phoneNumber
      ? ` callerId="${escapeXml(envConfig.twilio.phoneNumber)}"`
      : '';
    await client.calls(callerCallSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We apologize, but our assistant was disconnected. Please hold while we transfer you to our answering service.</Say>
  <Dial${callerIdAttribute}>
    <Number>${escapeXml(fallbackNumber)}</Number>
  </Dial>
  <Say voice="Polly.Joanna">We were unable to complete your call. Please try again later or call back during regular business hours. Goodbye.</Say>
  <Hangup/>
</Response>`,
    });
    console.warn(`[SIP-RECOVERY] Caller ${callerCallSid} redirected after Sage leg ${status}`);
  } catch (error: any) {
    if (error?.code === 20404) {
      console.info(`[SIP-RECOVERY] Caller ${callerCallSid} already ended`);
      return;
    }
    console.error(`[SIP-RECOVERY] Failed for ${conferenceName}:`, error?.message ?? error);
  }
}

const warmTransferAccepts = new Map<string, {
  resolve: (info: { acceptMethod: 'keypress' | 'stay_on_line'; amdVerdict: string }) => void;
  reject: (err: Error) => void;
  conferenceName: string;
  openAiCallId: string;
  // Async answering-machine-detection verdict for this office leg, recorded
  // by /api/voice/warm-transfer-amd before the briefing finishes. Only
  // consulted when the office never pressed a key — see the accept handler.
  answeredBy?: string;
}>();
const activeOfficeLegsByCall = new Map<string, Set<string>>();
const abortedPcpHandoffs = new Set<string>();

async function cancelActiveOfficeLegs(openAiCallId: string): Promise<void> {
  const legs = [...(activeOfficeLegsByCall.get(openAiCallId) ?? [])];
  activeOfficeLegsByCall.delete(openAiCallId);
  await Promise.all(legs.map(async (callSid) => {
    warmTransferAccepts.delete(callSid);
    officeLegBridges.delete(callSid);
    try { await twilioClient?.calls(callSid).update({ status: 'completed' }); } catch { /* already terminal */ }
  }));
}

/** Office legs currently bridged (or about to be) into a caller conference,
 *  keyed by the office leg's CallSid.
 *
 *  The conference `<Dial>` that joins the office to the patient was the ONE
 *  bridge in this codebase with no status callback on it — every other
 *  conference wires `/api/voice/conference-events`. So the single event that
 *  proves a transfer physically happened was the one we never recorded, and
 *  `transferred_live` (written when we DECIDE to connect) had to stand in for
 *  it. Join/leave events land in /api/voice/office-leg-events. */
const officeLegBridges = new Map<string, {
  openAiCallId: string;
  label: string;
  joinedAtMs?: number;
}>();

async function transferConferenceToNumber(
  openAiCallId: string,
  toNumber: string,
  label: string,
  briefing: string,
): Promise<{ ok: boolean; detail?: string; acceptMethod?: 'keypress' | 'stay_on_line'; amdVerdict?: string }> {
  const conferenceName = getConferenceName(openAiCallId);
  if (!conferenceName) {
    console.error('[WARM-TRANSFER] ✗ No conference found for call:', openAiCallId);
    return { ok: false, detail: 'no_conference_for_call' };
  }
  if (!twilioClient) {
    twilioClient = await getTwilioClient();
  }
  const twilioPhoneNumber = envConfig.twilio.phoneNumber;
  if (!twilioPhoneNumber) {
    console.error('[WARM-TRANSFER] ✗ TWILIO_PHONE_NUMBER not configured');
    return { ok: false, detail: 'twilio_phone_number_missing' };
  }

  let officeCallSid: string | undefined;
  let acceptInfo: { acceptMethod: 'keypress' | 'stay_on_line'; amdVerdict: string } | undefined;
  let resolveAccepted!: () => void;
  let rejectAccepted!: (err: Error) => void;
  const acceptedPromise = new Promise<void>((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const acceptUrl = `https://${envConfig.domain}/api/voice/warm-transfer-accept`;
    const statusUrl = `https://${envConfig.domain}/api/voice/warm-transfer-status`;
    const amdUrl = `https://${envConfig.domain}/api/voice/warm-transfer-amd`;
    const say = escapeXml(briefing.slice(0, 800));
    // The second Gather uses actionOnEmptyResult so that staff who simply
    // listen to the briefing and say nothing are STILL connected. Previously
    // both Gathers fell through to a "No confirmation received. Goodbye."
    // hangup, so an office that answered but never pressed a key was recorded
    // as an unanswered transfer and the caller — who was holding in silence —
    // was dropped to a callback ticket. A keypress still connects instantly;
    // staying on the line now connects too. Answering machines are filtered
    // by the async AMD verdict in the accept handler rather than by relying
    // on a human to press a digit.
    // A KEYPRESS IS THE ONLY WAY TO ACCEPT, and the briefing says so before and
    // after the details, so silence is never ambiguous.
    //
    // Staying on the line used to connect too, gated on the async AMD verdict. On a
    // staffed queue that inverted: staffers answered, listened, pressed nothing, and
    // AMD — judging the hunt-group greeting on the first audio — labelled the line
    // 'machine', so the accept handler hung up on a live human. Both of the first PCP
    // transfers to +17149564300 came back `machine` this way. A keypress is positive
    // proof of a person and bypasses AMD entirely, so requiring one removes the
    // guesswork instead of tuning it.
    const PRESS_PROMPT = 'Press any key to take this caller.';
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather input="dtmf" numDigits="1" timeout="8" action="${acceptUrl}" method="POST">` +
      `<Say voice="Polly.Joanna">${PRESS_PROMPT}</Say>` +
      `<Say voice="Polly.Joanna">${say}</Say>` +
      `<Say voice="Polly.Joanna">${PRESS_PROMPT}</Say>` +
      `</Gather>` +
      `<Gather input="dtmf" numDigits="1" timeout="10" actionOnEmptyResult="true" action="${acceptUrl}" method="POST">` +
      `<Say voice="Polly.Joanna">Repeating: ${say}</Say>` +
      `<Say voice="Polly.Joanna">${PRESS_PROMPT}</Say>` +
      `</Gather>` +
      `</Response>`;
    const dialResult = await withResiliency(
      async () => twilioClient.calls.create({
        from: twilioPhoneNumber,
        to: toNumber,
        twiml,
        timeout: 15, // test queue: advance promptly when a DID does not answer
        statusCallback: statusUrl,
        statusCallbackEvent: ['completed'],
        statusCallbackMethod: 'POST',
        // Async so detection runs alongside the briefing instead of delaying
        // it. The verdict lands well before the second Gather times out.
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: amdUrl,
        asyncAmdStatusCallbackMethod: 'POST',
      }),
      getCircuitBreaker('twilio-office-transfer'),
      TWILIO_RETRY_CONFIG,
      `Warm transfer for conference ${conferenceName}`,
    );
    if (!dialResult.success) {
      throw dialResult.error;
    }
        const dialedSid: string = dialResult.result!.sid;
    officeCallSid = dialedSid;
    const activeLegs = activeOfficeLegsByCall.get(openAiCallId) ?? new Set<string>();
    activeLegs.add(dialedSid);
    activeOfficeLegsByCall.set(openAiCallId, activeLegs);
    console.log(`[WARM-TRANSFER] Dialing ${label} (${toNumber}) with briefing, CallSid: ${dialedSid}`);

    // Bounded acceptance window (45s) — comfortably longer than the briefing's
    // two Gathers (8s + 10s) plus speech, so a staffer who listens to the whole
    // thing still has room to press a key. Voicemail is NOT rejected by AMD any
    // more (see the AMD handler); it falls out here or at the no-keypress
    // branch of the accept handler, which is the same answer a few seconds
    // later and without hanging up on live people.
    timeoutId = setTimeout(() => {
      warmTransferAccepts.delete(dialedSid);
      rejectAccepted(new Error('Office did not accept the transfer within the window'));
    }, 45_000);

    officeLegBridges.set(dialedSid, { openAiCallId, label });
    // Office-leg telemetry (2026-07-30): remember what we dialed so the
    // accept/status webhooks can record the OUTCOME against it. Without
    // this pair, nothing in the database says whether the office picked up.
    officeLegDials.set(dialedSid, { openAiCallId, dialedNumber: toNumber, queueLabel: label, dialedAt: Date.now() });

    warmTransferAccepts.set(dialedSid, {
      resolve: (info) => {
        if (timeoutId) clearTimeout(timeoutId);
        acceptInfo = info;
        resolveAccepted();
      },
      reject: (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        rejectAccepted(err);
      },
      conferenceName,
      openAiCallId,
    });

    await acceptedPromise;
    // Was "(keypress)" unconditionally — stale since the stay-on-line accept
    // was added, and misleading in exactly the situation where knowing which
    // path ran matters most.
    console.log(
      `[WARM-TRANSFER] ✓ Office ACCEPTED via ${acceptInfo?.acceptMethod ?? 'unknown'}` +
        `${acceptInfo?.acceptMethod === 'stay_on_line' ? ` (AMD: ${acceptInfo.amdVerdict || 'no verdict'})` : ''}` +
        ' — releasing AI leg',
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[WARM-TRANSFER] ✗ Transfer failed:', detail);
    if (timeoutId) clearTimeout(timeoutId);
    if (officeCallSid) {
      warmTransferAccepts.delete(officeCallSid);
      officeLegBridges.delete(officeCallSid);
      activeOfficeLegsByCall.get(openAiCallId)?.delete(officeCallSid);
      try { await twilioClient.calls(officeCallSid).update({ status: 'completed' }); } catch { /* already terminal */ }
    }
    return { ok: false, detail };
  }

  // Mark transferred (same bookkeeping the after-hours path does). Record
  // the ACTUAL office number dialed so the call log doesn't claim the
  // global HUMAN_AGENT_NUMBER was used.
  //
  // The coordinator flag is what exempts a call from the per-agent duration
  // cap — once the office is bridged in, this is a patient talking to a
  // receptionist and our timer has no business ending it. Marking it used to
  // depend on `callMeta.dbCallLogId`, which is filled in by a BACKGROUND
  // database write; if that write had not landed yet, the mark was skipped
  // silently and the call stayed capped. Mark by openAiCallId as well — the
  // coordinator maps it to the same record and it exists from registration,
  // so the exemption no longer races the DB.
  //
  // Bock's first call on 2026-07-27 ended at exactly 1200s — the azul cap to
  // the second — while a receptionist had him on hold. He redialed 45s later,
  // which is precisely the "same patient calling again and we lost the
  // original" the front office reported.
  const { callLifecycleCoordinator } = await import('./services/callLifecycleCoordinator');
  if (officeCallSid) activeOfficeLegsByCall.get(openAiCallId)?.delete(officeCallSid);
  callLifecycleCoordinator.markTransferred(openAiCallId);
  const callMeta = callMetadataForDB.get(openAiCallId);
  if (callMeta) {
    callMeta.transferredToHuman = true;
    callMeta.transferTargetNumber = toNumber;
    callMeta.transferTargetLabel = label;
    if (callMeta.dbCallLogId) {
      callLifecycleCoordinator.markTransferred(callMeta.dbCallLogId);
    }
  }

  try {
    const hangupResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(openAiCallId)}/hangup`,
      { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
    );
    if (!hangupResponse.ok) {
      console.warn('[WARM-TRANSFER] ⚠️ AI hangup returned:', hangupResponse.status);
    }
  } catch (hangupErr) {
    // Staffer is joining the conference either way — caller is fine.
    console.warn('[WARM-TRANSFER] ⚠️ AI hangup failed (staffer joining anyway):', hangupErr);
  }
  return { ok: true, acceptMethod: acceptInfo?.acceptMethod, amdVerdict: acceptInfo?.amdVerdict };
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
  const validAgentSlugs = ['no-ivr', 'dev-no-ivr', 'after-hours', 'answering-service', 'azul-scheduling', 'pcp', 'drs-scheduler', 'appointment-confirmation', 'fantasy-football'];
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

  // Shadow tap (observation only, default off): emit never throws or blocks.
  shadowTap.emit('session_started', callId, effectiveSlug, {
    correlation: {
      twilioCallSid: (metadata as Record<string, unknown> | undefined)?.twilioCallSid
        ?? (metadata as Record<string, unknown> | undefined)?.callSid,
      callLogId: (metadata as Record<string, unknown> | undefined)?.dbCallLogId,
    },
  }, { sensitive: true, component: 'lifecycle' });

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

  // AZUL pre-context: start the person-base lookup NOW and await it with a
  // short residual race at agent creation.
  //
  // The runway is smaller than it looks: this kicks off here, but the race
  // below sits in the agent-factory switch with only a dynamic import in
  // between — the REST accept and session.connect() both happen after it. So
  // the 3s race is effectively in front of the accept, not overlapped with it.
  //
  // That mattered enormously while the lookup was slow. Across 108 production
  // sage_precontext calls the FASTEST was 4,027ms (p50 4,304), so the race
  // could never be won and every match arrived late. This was repeatedly
  // written off as a Vercel cold start; it was pm_find_by_phone doing a
  // sequential scan of 868k rows because patients_master had no statistics
  // for the 0092 phone indexes. ANALYZE + migration 0107 took it to ~17ms,
  // which is what makes the race winnable at all.
  //
  // Left in front of the accept deliberately: at ~17ms the residual wait is
  // noise, and winning it outright is what puts the caller's name in the
  // opening turn. If the lookup ever regresses, the pre-connect write-through
  // below is the safety net rather than the primary path.
  let azulPrecontextPromise: Promise<import('./agents/azulSchedulingAgent').AzulPrecontext | null> | null = null;
  /** Pre-context surname, for the transcription keyword hint. Written by the
   *  resolve hook below and READ WITHOUT AWAITING at the accept payload — if
   *  the lookup has not landed by then, the call proceeds with no hint rather
   *  than waiting on it. The payload starts the call; nothing blocks it. */
  let resolvedPrecontextSurname: string | null = null;
  // Late-arriving pre-context is PARKED here and applied only at a turn
  // boundary (response.done) — operator report 2026-07-24 (live): injecting
  // context while the agent is mid-greeting makes her "lose her speech and
  // thought" (instructions churn during active audio). Never mutate the
  // live prompt while she's talking.
  let pendingAzulPrecontext: import('./agents/azulSchedulingAgent').AzulPrecontext | null = null;
  let azulMetadataRef: { precontext?: import('./agents/azulSchedulingAgent').AzulPrecontext } | null = null;
  // Flipped immediately after session.connect(). Before that point the model
  // has no audio and the prompt has not been read yet, so a late pre-context
  // can be written STRAIGHT into metadata; after it, the parked/turn-boundary
  // path is the only safe one. See the late-resolve handler below.
  let azulSessionConnected = false;
  // Carrier subscriber name, fetched alongside the pre-context and NEVER
  // waited on. It exists to contradict a bad pre-context match: on 817162bf
  // (2026-07-31) the person base tied the number to a "Haberkern" and the
  // agent duly verified against that surname for twelve minutes, while the
  // carrier had the caller's real name — Kolterman — the whole time. Written
  // through pre-connect exactly like a late pre-context; if it misses that
  // window the prompt-side read-back and the identity arg guard still hold.
  let azulCarrierNamePromise: Promise<string | null> | null = null;
  let azulCarrierName: string | null = null;
  // Caller-ID pre-context is fetched for EVERY agent that talks to patients,
  // not just azul (2026-08-01). Evidence: the same caller, from the same
  // number, 39 minutes apart on 08-01 — azul opened "Am I speaking with
  // Wayne?" while answering-service asked "Could you please tell me your
  // first and last name?" and then asked for a date of birth. Two different
  // phone→patient paths, and the working one had been given only to the
  // agent handling 3% of the volume.
  //
  // sage_precontext matches the FULL person base (patients_master, 868k
  // persons incl. chartless) and is NOT pilot-fenced — verified in the
  // service's sage-tools.ts — so it is correct for the practice-wide
  // answering-service and no-ivr lines, not just the SD pilot.
  const PRECONTEXT_SLUGS = new Set(['azul-scheduling', 'answering-service', 'no-ivr', 'dev-no-ivr']);
  if (PRECONTEXT_SLUGS.has(effectiveSlug) && from) {
    azulPrecontextPromise = import('./agents/azulSchedulingAgent')
      .then(({ fetchAzulPrecontext }) => fetchAzulPrecontext(from))
      .catch(() => null);
    // Every agent that gets pre-context gets it from HERE, so this is the one
    // place the director needs to learn which names came from the record
    // rather than from the caller. Speaking one of these before the caller has
    // stated their name and DOB is a disclosure — see director.seedRecordNames.
    void azulPrecontextPromise.then((pc) => {
      if (pc?.matched && directorEnabledFor(effectiveSlug)) {
        director.seedRecordNames(callId, effectiveSlug, [pc.firstName, pc.lastNameOnFile]);
      }
      if (pc?.matched && pc.lastNameOnFile) {
        resolvedPrecontextSurname = String(pc.lastNameOnFile).trim() || null;
      }
    });
    // Carrier lookup stays AZUL-ONLY: its whole job is to contradict a bad
    // pre-context match before verify_patient_identity is called, and azul is
    // the only agent that verifies. Fetching it for the fleet would bill a
    // Twilio Lookup on ~12k calls/month to inform a decision nobody makes.
    if (effectiveSlug === 'azul-scheduling') {
      azulCarrierNamePromise = import('./lib/twilioClient')
        .then(({ lookupCallerName }) => lookupCallerName(from))
        .catch(() => null);
      void azulCarrierNamePromise.then((n) => {
        azulCarrierName = n;
        // The carrier subscriber name is record-sourced too — arguably the
        // least trustworthy source of the three, since it names the account
        // holder, not whoever picked up.
        if (n && directorEnabledFor(effectiveSlug)) {
          director.seedRecordNames(callId, effectiveSlug, [n.replace(/^\[Lookup\]\s*/i, '')]);
        }
      });
    }
  }

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
  
  // callLogId is resolved by backgroundDbOps AFTER the agent factory runs, so a
  // captured value is ALWAYS undefined for the whole call. Every agent that
  // guards a write with `if (callLogId)` therefore skipped it, silently, on
  // every call: 3,571 calls over the 7 days to 2026-08-01 with patient_found
  // = 0 across all three agents, including azul calls whose tool timeline
  // records verified:true. That is why the console shows the carrier's CNAM
  // string ("[Lookup] FABIAN,WAYNE") where the verified patient should be —
  // the very bug stampVerifiedIdentity was written to fix, which never once
  // ran. The tool timeline survived only because its flush falls back to
  // callSid.
  //
  // A getter reads the live value at ACCESS time from the metadata store,
  // which the backfill does update. Agents need no change.
  const liveCallLogId = () => callMetadataForDB.get(callId)?.dbCallLogId;

  // Bounded residual wait for pre-context on the ticket-taking agents. The
  // lookup is ~17ms since migration 0107, so this resolves instantly in
  // practice; the cap exists only so a regressed lookup can never hold the
  // SIP accept open. These factories already spend up to 2s on their own
  // parallel lookups, so the added latency is nil in the normal case.
  const racePrecontext = async () => {
    if (!azulPrecontextPromise) return null;
    try {
      return await Promise.race([
        azulPrecontextPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
    } catch { return null; }
  };

  // Agent factory runs immediately — does NOT wait for DB ops.
  // callLogId is undefined here; it gets backfilled after session.connect().
  // The factory's callerMemory/schedule lookups run in parallel with DB ops.
  
  // Build after-hours specific metadata with caller phone for automatic caller ID recognition
  const afterHoursMetadata = {
    ...metadata,
    callerPhone: from,
    dialedNumber: to,
    callSid: twilioCallSid,
    callId: callId,
    // Tickets carry the conversation up to the moment of filing — the
    // ticketing app generates its staff-facing summary from it.
    getTranscript: () => (callTranscripts.get(callId) ?? []).join('\n'),
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
      
      case 'answering-service': {
        const asPrecontext = await racePrecontext();
        console.log(`[Answering-Service] Pre-context for ...${(from || '').slice(-4)}: ${asPrecontext?.matched ? `matched '${asPrecontext.firstName}'` : 'no unique match'}`);
        factoryResult = agentFactory(
          handoffCallback,
          {
            callId,
            callSid: twilioCallSid,
            callerPhone: from,
            dialedNumber: to,
            get callLogId() { return liveCallLogId(); },
            precontext: asPrecontext ?? undefined,
          }
        );
        break;
      }

      case 'pcp':
        factoryResult = agentFactory(() => addHumanAgent(callId), {
          callId,
          callSid: twilioCallSid,
          callerPhone: from,
          dialedNumber: to,
          getTranscript: () => (callTranscripts.get(callId) ?? []).join('\n'),
        });
        break;

      case 'azul-scheduling': {
        // createAzulSchedulingAgent(handoffCallback?, metadata?) — NextGen
        // scheduling line; all decisions gated by the Eye Care rules engine.
        // CALLER-ID PRE-CONTEXT (operator directive 2026-07-23, same
        // mechanism the after-hours agent has always used): look the caller
        // up by phone in the local schedule mirror BEFORE building the
        // prompt, so the agent starts the call knowing who is likely on the
        // line. Sub-second local read; failure = no pre-context, not a
        // blocked call.
        let azulPrecontext: import('./agents/azulSchedulingAgent').AzulPrecontext | null = null;
        if (azulPrecontextPromise) {
          try {
            // The fetch has been in flight since the top of observeCall —
            // this race only bounds the RESIDUAL wait.
            azulPrecontext = await Promise.race([
              azulPrecontextPromise,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
            ]);
            console.log(`[AZUL-SCHED] Pre-context for ...${(from || '').slice(-4)}: ${azulPrecontext?.matched ? `matched '${azulPrecontext.firstName}'` : 'no unique match'}`);
          } catch (err) {
            console.error('[AZUL-SCHED] Pre-context lookup failed (continuing without):', err);
          }
        }
        // Mutable metadata: instructions() rebuilds the dynamic tail every
        // turn, so a pre-context match that loses the creation race (6.4s
        // cold start on the 16:42 call) still lands BEFORE the identity
        // question (~30s in) via the late-resolve write-through below.
        const azulMetadata: {
          callId: string;
          callSid?: string;
          callerPhone?: string;
          dialedNumber?: string;
          readonly callLogId?: string;
          precontext?: import('./agents/azulSchedulingAgent').AzulPrecontext;
          carrierCallerName?: string;
        } = {
          callId,
          callSid: twilioCallSid,
          callerPhone: from,
          dialedNumber: to,
          get callLogId() { return liveCallLogId(); },
          precontext: azulPrecontext ?? undefined,
        };
        // Never awaited — see the promise's declaration. Landing before
        // connect() is a bonus, not a requirement.
        if (azulCarrierNamePromise) {
          void azulCarrierNamePromise.then((name) => {
            if (!name) return;
            azulMetadata.carrierCallerName = name;
            const meta = callMetadataForDB.get(callId);
            if (meta) meta.carrierCallerName = name;
            if (azulSessionConnected) {
              console.log(`[AZUL-SCHED] Carrier name for ...${(from || '').slice(-4)} arrived after connect — prompt already frozen, arg guard still applies`);
            }
          });
        }
        if (!azulPrecontext && azulPrecontextPromise) {
          void azulPrecontextPromise.then((late) => {
            if (!late?.matched) return;
            // BEFORE connect: write straight through.
            //
            // The comment above claims instructions() rebuilds the dynamic
            // tail every turn. It does not. In the installed SDK
            // getSystemPrompt() — the only thing that evaluates that closure
            // — runs from #getSessionConfig(), reached only by connect(),
            // updateAgent() and handoff. This app calls none of the latter
            // two, so the prompt is frozen at session.connect() and the
            // parked value was never read by anything. Caller-ID familiarity
            // reached the model on ~0% of calls: park-only threw away the
            // single window in which it could still matter.
            //
            // connect() re-evaluates instructions, so anything landing before
            // it does reach the greeting turn. There is no audio yet at that
            // point, so this cannot cause the mid-utterance prompt churn that
            // the parking was introduced to prevent.
            if (!azulSessionConnected && azulMetadataRef) {
              azulMetadataRef.precontext = late;
              console.log(`[AZUL-SCHED] Pre-context arrived LATE for ...${(from || '').slice(-4)} (matched '${late.firstName}') — applied pre-connect, will reach the greeting turn`);
              return;
            }
            // AFTER connect: park it. Applied at the next response.done —
            // operator report 2026-07-24: injecting context while the agent
            // is mid-greeting makes her "lose her speech and thought".
            pendingAzulPrecontext = late;
            console.log(`[AZUL-SCHED] Pre-context arrived LATE for ...${(from || '').slice(-4)} (matched '${late.firstName}') — parked for the next turn boundary`);
          });
        }
        azulMetadataRef = azulMetadata;
        factoryResult = agentFactory(handoffCallback, azulMetadata);
        break;
      }
      
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
      
      case 'no-ivr': {
        const noIvrPrecontext = await racePrecontext();
        console.log(`[No-IVR Agent] Pre-context for ...${(from || '').slice(-4)}: ${noIvrPrecontext?.matched ? `matched '${noIvrPrecontext.firstName}'` : 'no unique match'}`);
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
            get callLogId() { return liveCallLogId(); }, // For patient context updates
            precontext: noIvrPrecontext ?? undefined,
            variant: 'production' as const, // PRODUCTION variant with full features
            // Tickets carry the conversation up to the moment of filing —
            // the ticketing app generates its staff-facing summary from it.
            getTranscript: () => (callTranscripts.get(callId) ?? []).join('\n'),
          }
        );
        break;
      }
      
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
            get callLogId() { return liveCallLogId(); },
            variant: 'development' as const, // DEVELOPMENT variant - testing new features before production
            getTranscript: () => (callTranscripts.get(callId) ?? []).join('\n'),
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

  // ESTABLISHED vs ASSUMED — the distinction the transcription config needs and
  // `languageCode` cannot express, because languageCode always resolves to
  // something (it falls back to agentLanguage, which falls back to 'en').
  // Pinning a transcription language the caller never established does not
  // degrade gracefully: it produces confident nonsense. "Bon tardis" is a
  // Spanish speaker's "buenas tardes" decoded as English.
  //
  // Established = the caller or the routing SAID so: an explicit languageForCall,
  // IVR option 4 / metadata Spanish, or an agent deliberately configured to a
  // non-English language. Plain 'en' from the default chain is an ASSUMPTION, so
  // it is left undefined and the transcriber auto-detects.
  const establishedLanguageCode: string | undefined =
    languageForCall ||
    (isSpanish ? 'es' : undefined) ||
    (agentConfig?.language && agentConfig.language !== 'en' ? agentConfig.language : undefined);

  console.info(
    `[SESSION] Call config: voice=${voiceForCall}, language=${languageCode}, ` +
    `established=${establishedLanguageCode ?? 'auto-detect'}, transcription=${transcriptionModel()}, ` +
    `isSpanish=${isSpanish}, ivrSelection=${metadata?.ivrSelection || 'none'}`,
  );
  
  console.info(`[SESSION] CHECKPOINT C: Creating RealtimeSession... (T+${Date.now() - observeCallStart}ms)`);
  // Phase 7 A/B carriage: AB_MODEL_B names the challenger model and
  // AB_MODEL_B_AGENTS the participating slugs (legacy AZUL_AB_MODEL_B still
  // implies azul-only). Unset = no experiment. Assignment is a deterministic
  // hash of the callSid (~50/50, reproducible); the arm label is written into
  // the callMetadataForDB initializer below (the entry doesn't exist yet
  // here), so the timeline flush persists it for per-arm grading.
  let modelForCall = sessionOptions.model;
  const abAssignment = resolveAbAssignment(
    effectiveSlug,
    twilioCallSid || callId || '',
    String(sessionOptions.model),
  );
  const abArmLabel = abAssignment.armLabel;
  if (abAssignment.challengerModel) {
    modelForCall = abAssignment.challengerModel as typeof sessionOptions.model;
  }
  if (abArmLabel) {
    console.info(`[AB-CARRIAGE] ${effectiveSlug} call ${callId} → arm ${abArmLabel}`);
  }
  const session = new RealtimeSession(sessionAgent, {
    transport: new OpenAIRealtimeSIP(),
    ...sessionOptions,
    model: modelForCall,
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
          format: 'g711_ulaw',
          transcription: buildTranscriptionConfig({ establishedLanguage: establishedLanguageCode }),
          turnDetection: {
            type: 'semantic_vad',
            eagerness: vadEagernessFor(agentConfig?.id),
            createResponse: true,
            interruptResponse: true,
          },
        },
        output: {
          format: 'g711_ulaw',
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

  // DEAD AIR. Once the webhook lands, cancelSIPWatchdog clears the only
  // max-duration timer this call had, and the DB reconciler ignores rows that
  // are not stuck in a transient status. Between those two, a connected session
  // that simply stops talking runs to the per-agent cap — 20 minutes of billed
  // silence on call 438e06f8, while the caller redialled and started a second
  // one. See services/deadAirWatchdog.ts.
  //
  // HANG UP, do not merely close the transport. First live day (2026-08-04)
  // this closed session.transport and a dead-air call still ran 459s: closing
  // our transport tears down OUR end of the OpenAI session, it does not end the
  // CALL, so the caller stayed connected to a line with no agent on it until the
  // per-agent cap. The actual hangup is the same REST call terminate_call makes.
  deadAirWatchdog.arm(callId, (idleMs) => {
    const secs = Math.round(idleMs / 1000);
    console.warn(
      `[DEAD-AIR] No conversational activity for ${secs}s on ${callId} (${effectiveSlug}) — hanging up`,
    );
    void (async () => {
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
          const res = await fetch(
            `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
            { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } },
          );
          console.warn(`[DEAD-AIR] hangup for ${callId} → ${res.status}`);
        } else {
          console.error('[DEAD-AIR] OPENAI_API_KEY missing — cannot hang up');
        }
      } catch (e) {
        console.error(`[DEAD-AIR] hangup failed for ${callId}:`, e);
      } finally {
        // Cleanup only, after the hangup. Harmless if the call is already gone.
        try {
          session.transport.close();
        } catch { /* already closed */ }
      }
    })();
  });
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

    // Proof of life for the dead-air watchdog. Transcript- and tool-shaped
    // events only: audio deltas and keepalives keep flowing on a session that
    // has stopped conversing, so counting those would defeat the whole thing.
    if (isActivityEvent(eventType)) deadAirWatchdog.touch(callId);

    // Is a response actually in flight? See responseInFlight — a `response.cancel`
    // with nothing to cancel comes back as a server error, and this session's
    // error handler treats anything off its three-item allowlist as fatal.
    if (eventType === 'response.created') {
      responseInFlight.add(callId);
    } else if (
      eventType === 'response.done' ||
      eventType === 'response.cancelled' ||
      eventType === 'response.canceled'
    ) {
      responseInFlight.delete(callId);
      // Greeting guarantee: turn boundary is the one collision-free moment
      // to resend a greeting that never played (see pendingGreetings).
      checkGreetingDelivered(callId, event);
    }

    // Accumulate real token usage for cost attribution (see callTokenUsage).
    if (eventType === 'response.done' && event?.response?.usage) {
      accumulateUsage(callId, event.response.usage);
    }

    // Caller barge-in → the SDK truncates the in-flight agent response.
    if (eventType === 'conversation.item.truncated') {
      conversationLoopGuard.onTruncation(callId);
    }

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
          // Fallback: the Twilio CallSid (from the conference name) resolves
          // via the DB even across instances; the openai callId cannot.
          const twilioSid = confName?.replace(/^(test_|outbound_)?conf_/, '');
          callLifecycleCoordinator.appendTranscript(twilioSid || callId, `CALLER: ${transcript}`);
        }
        // Also keep in-memory for backward compatibility
        if (!callTranscripts.has(callId)) {
          callTranscripts.set(callId, []);
        }
        callTranscripts.get(callId)!.push(`CALLER: ${transcript}`);

        // Shadow tap (observation only, default off): emit never throws or blocks.
        shadowTap.emit('user_transcript', callId, effectiveSlug, { text: transcript }, { sensitive: true, component: 'transcript' });

        // CP-4: the ramp state machine owns the opening — parse the answer,
        // force the operator's next line, preempting any improvised reply
        // (the director's cancel-and-direct plumbing, deterministic here).
        if (rampActive(callId)) {
          void (async () => {
            try {
              const { scheduleLookupService } = await import('./services/scheduleLookupService');
              const step = await onCallerUtterance(callId, transcript, async (first, last, dob) => {
                const r = await scheduleLookupService.lookupByNameAndDOB(first, last, dob);
                return Boolean((r as any)?.patientFound);
              });
              if (step.line) {
                if (responseInFlight.has(callId)) {
                  try { (session.transport as any).sendEvent({ type: 'response.cancel' }); } catch { /* fine */ }
                }
                // Same guarantee as greetings: parked, transcript-verified at
                // the turn boundary, resent once if it never played.
                armGreetingGuarantee(
                  callId,
                  step.line,
                  `Say this to the caller word-for-word, without adding, removing, or rephrasing anything: "${step.line}" - Then stop and wait for their response.`,
                  session.transport as any,
                );
                console.info(`[RAMP] ${step.status.state} line forced (guaranteed) for ${callId}`);
              } else if (!step.status.active) {
                console.info(`[RAMP] Exited (${step.status.state}) for ${callId} — model proceeds with locked facts`);
              }
            } catch (rampErr) {
              console.warn(`[RAMP] Error for ${callId} — disengaging:`, rampErr);
              releaseRamp(callId);
            }
          })();
        }

        // Loop guard: a repeated "representative / customer service" demand
        // trips the escalation directive.
        const lgCallerDirective = conversationLoopGuard.onCallerLine(callId, effectiveSlug, transcript);
        if (lgCallerDirective) sendLoopGuardDirective(session, callId, lgCallerDirective);

        // Director: bank what the caller just told us, so re-asking it is
        // detectable on the FIRST repeat rather than the third.
        if (directorEnabledFor(effectiveSlug)) {
          director.observeCaller(callId, effectiveSlug, transcript);
        }

        // The turn table. Recorded for EVERY agent, not only the ones the
        // director watches — the calls hardest to debug are the ones with no
        // director ruling on them at all.
        recordTurn(callId, 'caller', transcript, {
          state: director.stateSnapshot(callId),
          callSid: twilioCallSid,
          callLogId: callMetadataForDB.get(callId)?.dbCallLogId,
          agentSlug: effectiveSlug,
        });

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
          // Fallback: the Twilio CallSid (from the conference name) resolves
          // via the DB even across instances; the openai callId cannot.
          const twilioSid = confName?.replace(/^(test_|outbound_)?conf_/, '');
          callLifecycleCoordinator.appendTranscript(twilioSid || callId, `AGENT: ${transcript}`);
        }
        // Also keep in-memory for backward compatibility
        if (!callTranscripts.has(callId)) {
          callTranscripts.set(callId, []);
        }
        callTranscripts.get(callId)!.push(`AGENT: ${transcript}`);

        // Shadow tap (observation only, default off): emit never throws or blocks.
        shadowTap.emit('assistant_transcript', callId, effectiveSlug, { text: transcript }, { sensitive: true, component: 'transcript' });

        // Loop guard: a third same-topic ask trips the re-ask directive.
        const lgAgentDirective = conversationLoopGuard.onAgentLine(callId, effectiveSlug, transcript);
        if (lgAgentDirective) sendLoopGuardDirective(session, callId, lgAgentDirective);

        // Director: the reasoning layer rules on this turn. Unlike the loop
        // guard it knows what the caller has already ANSWERED, and it escalates
        // past suggestion when the model ignores it (afb1e688).
        let turnDecision: DirectorAction | null = null;
        if (directorEnabledFor(effectiveSlug)) {
          turnDecision = director.observeAgent(callId, effectiveSlug, transcript);
          if (turnDecision) applyDirectorAction(session, callId, effectiveSlug, turnDecision);
        }
        recordTurn(callId, 'agent', transcript, {
          state: director.stateSnapshot(callId),
          // Verdict only — action.text and .speak quote the caller.
          directorDecision: turnDecision
            ? { enforcement: turnDecision.enforcement, code: turnDecision.code, topic: turnDecision.topic }
            : null,
          modelOutput: { tools: (getAzulTimeline(callId) ?? []).map((e) => e.tool) },
          callSid: twilioCallSid,
          callLogId: callMetadataForDB.get(callId)?.dbCallLogId,
          agentSlug: effectiveSlug,
        });
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
                // Loop guard (double-capture safe: verbatim repeats with no
                // caller line between are ignored inside the guard).
                const lgDoneDirective = conversationLoopGuard.onAgentLine(callId, effectiveSlug, content.transcript);
                if (lgDoneDirective) sendLoopGuardDirective(session, callId, lgDoneDirective);

                // DIRECTOR ON THIS PATH TOO. It was wired only to
                // response.output_audio_transcript.done, so any agent line that
                // surfaces ONLY here was invisible to it — while the stored
                // transcript is assembled from both paths, which is why the
                // transcript could show a loop the director's telemetry did not.
                // Call 4511a0a3 (2026-08-05 18:34): replaying its transcript
                // offline produces FIVE actions, including inject+author on the
                // "which office do you visit" loop; the row recorded three, all
                // on name/date of birth. Same double-capture safety as the loop
                // guard — the director drops a line identical to the last one
                // when the caller has not spoken since.
                if (directorEnabledFor(effectiveSlug)) {
                  const doneDecision = director.observeAgent(callId, effectiveSlug, content.transcript);
                  if (doneDecision) applyDirectorAction(session, callId, effectiveSlug, doneDecision);
                }
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
    // Carried so the end-of-call enrichment reuses this lookup instead of
    // billing a second identical one.
    ...(azulCarrierName ? { carrierCallerName: azulCarrierName } : {}),
    // A/B experiment arm (allowlisted agents) — persisted by the timeline flush.
    ...(abArmLabel ? { abArm: abArmLabel } : {}),
  });

  // Let the loop guard's telemetry be flushed by the lifecycle coordinator
  // too — that path only knows callLogId / twilioCallSid.
  conversationLoopGuard.registerAlias(callId, callLogId);
  conversationLoopGuard.registerAlias(callId, twilioCallSid);

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
      // Use the per-call model (A/B challenger when assigned): the accept
      // payload is what actually starts the session on a model — the later
      // session.update cannot change it (Codex P1 on PR #63).
      const buildConfigPromise = OpenAIRealtimeSIP.buildInitialConfig(sessionAgent, { ...sessionOptions, model: modelForCall }, {
        voice: voiceForCall,
        audio: {
          input: {
            format: 'g711_ulaw',
            transcription: buildTranscriptionConfig({ establishedLanguage: establishedLanguageCode }),
            turnDetection: {
              type: 'semantic_vad',
              eagerness: vadEagernessFor(agentConfig?.id),
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
        eagerness: vadEagernessFor(agentConfig?.id),
        create_response: true,
        interrupt_response: true,
      };
    }
    if (!acceptPayload.audio.input.transcription) {
      // NOT `languageCode || 'en'`. This payload starts the session and the
      // later session.update cannot change it, so a wrong pin here decides the
      // whole call — every Spanish speaker who did not press 4 in the IVR was
      // force-decoded as English. buildTranscriptionConfig omits the language
      // unless the call actually established one.
      // The caller's own surname is the highest-value hint on the call and the
      // thing the transcriber mangles most. Read from whatever pre-context has
      // already resolved — never awaited, because this payload starts the call.
      acceptPayload.audio.input.transcription = buildTranscriptionConfig({
        establishedLanguage: establishedLanguageCode,
        callerSurname: resolvedPrecontextSurname,
      });
    }
    // SIP MODE: ALWAYS strip audio format from accept payload.
    // The codec is negotiated at the SIP/SDP transport layer between Twilio and OpenAI.
    // Setting format here conflicts with the SIP-negotiated codec and causes screeching/silence.
    if (acceptPayload.audio?.input?.format) {
      console.info(`[SIP-FIX] Stripping audio.input.format from accept payload: ${JSON.stringify(acceptPayload.audio.input.format)}`);
      delete acceptPayload.audio.input.format;
    }
    if (acceptPayload.audio?.output?.format) {
      console.info(`[SIP-FIX] Stripping audio.output.format from accept payload: ${JSON.stringify(acceptPayload.audio.output.format)}`);
      delete acceptPayload.audio.output.format;
    }
    // Sanitize accept payload for OpenAI GA Realtime validator
    if (acceptPayload.noise_reduction === null) {
      console.info('[SIP-FIX] Removing noise_reduction: null from accept payload');
      delete acceptPayload.noise_reduction;
    }
    if ('output_modalities' in acceptPayload) {
      console.info('[SIP-FIX] Removing output_modalities from accept payload (GA field name is modalities)');
      delete acceptPayload.output_modalities;
    }
    if (acceptPayload.audio?.output?.speed !== undefined) {
      console.info(`[SIP-FIX] Removing audio.output.speed from accept payload: ${acceptPayload.audio.output.speed}`);
      delete acceptPayload.audio.output.speed;
    }
    console.info(`[SESSION] ✓ Final accept payload: ${JSON.stringify(acceptPayload)}`);
    
    // STEP 2: Accept the call via REST API with retry logic for 404 errors
    const MAX_ACCEPT_RETRIES = 8;
    const INITIAL_RETRY_DELAY_MS = 200;
    const MAX_RETRY_DELAY_MS = 3000;
    let lastError: string = '';
    let acceptSucceeded = false;
    
    CallDiagnostics.recordStage(callId, 'accept_started', true);
    const acceptStartTime = Date.now();
    
    const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
    console.info(`\n${'='.repeat(60)}`);
    console.info(`[TRACE-4] CALLING OPENAI ACCEPT ENDPOINT`);
    console.info(`[TRACE-4]   URL:     ${acceptUrl}`);
    console.info(`[TRACE-4]   call_id: ${callId}`);
    console.info(`[TRACE-4]   payload: ${JSON.stringify(acceptPayload)}`);
    console.info(`${'='.repeat(60)}`);
    
    for (let attempt = 0; attempt < MAX_ACCEPT_RETRIES; attempt++) {
      if (attempt > 0) {
        const baseDelay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
        const jitter = Math.random() * 100;
        const delayMs = Math.floor(baseDelay + jitter);
        console.info(`[TRACE-4] Retry ${attempt}/${MAX_ACCEPT_RETRIES - 1} for call ${callId} - waiting ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
      try {
        const acceptResponse = await fetch(acceptUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(acceptPayload),
        });
        
        const responseText = await acceptResponse.text();
        console.info(`[TRACE-4] Attempt ${attempt + 1}: HTTP ${acceptResponse.status}`);
        console.info(`[TRACE-4]   response body: ${responseText.substring(0, 500)}`);
        
        if (acceptResponse.ok) {
          const acceptLatencyMs = Date.now() - acceptStartTime;
          console.info(`[TRACE-4] ✓ ACCEPT SUCCEEDED (${acceptLatencyMs}ms, attempt ${attempt + 1})`);
          CallDiagnostics.recordAcceptAttempt(callId, attempt + 1, MAX_ACCEPT_RETRIES, true, acceptResponse.status);
          CallDiagnostics.recordStage(callId, 'accept_completed', true, { 
            acceptLatencyMs, 
            attempts: attempt + 1 
          });
          acceptSucceeded = true;
          break;
        }
        
        lastError = responseText;
        
        if (acceptResponse.status !== 404) {
          console.error(`[TRACE-4] ✗✗✗ NON-RETRYABLE ERROR ${acceptResponse.status} for call ${callId}`);
          console.error(`[TRACE-4]   OpenAI said: ${lastError}`);
          break;
        }
        
        console.warn(`[TRACE-4] ⚠️ 404 on attempt ${attempt + 1}/${MAX_ACCEPT_RETRIES} — OpenAI call not ready yet`);
        CallDiagnostics.recordAcceptAttempt(callId, attempt + 1, MAX_ACCEPT_RETRIES, false, acceptResponse.status, lastError);
        
      } catch (fetchError) {
        lastError = fetchError instanceof Error ? fetchError.message : String(fetchError);
        console.error(`[TRACE-4] ✗✗✗ NETWORK ERROR on attempt ${attempt + 1}: ${lastError}`);
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
      
      // Use the resolved callback domain, never a hardcoded workspace host. This line
      // used to fall back to a specific old dev URL, so any deployment without DOMAIN
      // pointed its failover TwiML action at a workspace that no longer serves it.
      const domain = envConfig.domain;
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
    
    // ═══════════════════════════════════════════════════════════════════════
    // SIP AUDIO FORMAT FIX: Monkey-patch transport.sendEvent to strip audio
    // format fields from session.update events. In SIP mode, the audio codec
    // is negotiated at the SIP/SDP transport layer between Twilio and OpenAI.
    // The SDK's session.update sends PCM16 format by default which OVERRIDES
    // the SIP-negotiated G.711 codec, causing screeching audio and response failures.
    // ═══════════════════════════════════════════════════════════════════════
    const transport = session.transport as any;
    const originalSendEvent = transport.sendEvent.bind(transport);
    transport.sendEvent = (event: any) => {
      if (event?.type === 'session.update' && event?.session?.audio) {
        if (event.session.audio.input?.format) {
          console.info(`[SIP-FIX] Stripping audio.input.format from session.update: ${JSON.stringify(event.session.audio.input.format)}`);
          delete event.session.audio.input.format;
        }
        if (event.session.audio.output?.format) {
          console.info(`[SIP-FIX] Stripping audio.output.format from session.update: ${JSON.stringify(event.session.audio.output.format)}`);
          delete event.session.audio.output.format;
        }
      }
      return originalSendEvent(event);
    };

    // Listen for raw transport events BEFORE connecting to capture session.created/updated
    let sessionUpdatedResolve: (() => void) | null = null;
    const sessionUpdatedPromise = new Promise<void>((resolve) => {
      sessionUpdatedResolve = resolve;
      setTimeout(() => { resolve(); sessionUpdatedResolve = null; }, 3000);
    });

    transport.on('*', (event: any) => {
      const eventType = event?.type || 'unknown';
      if (eventType === 'session.created' || eventType === 'session.updated') {
        const sess = event?.session || {};
        const audioIn = sess?.audio?.input;
        const audioOut = sess?.audio?.output;
        const td = sess?.audio?.input?.turn_detection;
        console.info(`[SESSION] OpenAI ${eventType}: voice=${audioOut?.voice}, td_type=${td?.type}, td_create_response=${td?.create_response}, audio_in_fmt=${JSON.stringify(audioIn?.format)}, audio_out_fmt=${JSON.stringify(audioOut?.format)}`);
        if (eventType === 'session.updated' && sessionUpdatedResolve) {
          sessionUpdatedResolve();
          sessionUpdatedResolve = null;
        }
      } else if (eventType === 'error') {
        console.error(`[SESSION] OpenAI error for ${callId}:`, JSON.stringify(event).substring(0, 500));
      } else if (eventType === 'response.done') {
        const resp = event?.response;
        const statusDetails = resp?.status_details;
        const errorInfo = statusDetails?.error || resp?.error;
        console.info(`[SESSION] response.done for ${callId}: status=${resp?.status}, outputs=${resp?.output?.length || 0}${errorInfo ? `, ERROR: ${JSON.stringify(errorInfo).substring(0, 300)}` : ''}${statusDetails ? `, details=${JSON.stringify(statusDetails).substring(0, 300)}` : ''}`);
        // Turn boundary: safe moment to let a late pre-context match into
        // the live prompt (see the parked-injection note above).
        if (pendingAzulPrecontext && azulMetadataRef) {
          azulMetadataRef.precontext = pendingAzulPrecontext;
          pendingAzulPrecontext = null;
          console.log(`[AZUL-SCHED] Late pre-context APPLIED at turn boundary for ${callId}`);
        }
        // CP-2: KNOWN-FACTS injection — at the turn boundary (the one safe
        // moment), and only when the ledger actually changed. A system item
        // is read on the next response without triggering speech.
        try {
          const facts = renderKnownFacts(callId);
          if (facts && facts !== lastFactsRender.get(callId)) {
            (session.transport as any).sendEvent({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: facts }] },
            });
            lastFactsRender.set(callId, facts);
            console.info(`[LEDGER] KNOWN FACTS injected for ${callId} (${facts.length} chars)`);
            // CP-7: the call log shows WHO is calling the moment we know.
            const lf = getCallFacts(callId);
            const displayName = `${lf?.firstName ?? lf?.matchedFirstName ?? ''} ${lf?.lastName ?? lf?.matchedLastName ?? ''}`.trim();
            const logId = callMetadataForDB.get(callId)?.dbCallLogId;
            if (displayName) {
              const nameValue = lf?.identityVerified ? `${displayName} ✓` : displayName;
              if (logId) {
                void storage.updateCallLog(logId, { callerName: nameValue })
                  .catch((e) => console.warn(`[LEDGER] callerName update failed for ${callId}:`, e));
              } else {
                // Cross-instance: resolve by Twilio CallSid like the transcript path.
                const nameConf = getConferenceName(callId);
                const nameSid = nameConf?.replace(/^(test_|outbound_)?conf_/, '');
                if (nameSid && /^CA[0-9a-fA-F]{32}$/.test(nameSid)) {
                  void (async () => {
                    try {
                      const { db } = await import('../server/db');
                      const { callLogs: clTable } = await import('../shared/schema');
                      const { eq } = await import('drizzle-orm');
                      await db.update(clTable).set({ callerName: nameValue }).where(eq(clTable.callSid, nameSid));
                    } catch (e) {
                      console.warn(`[LEDGER] callerName sid-update failed for ${callId}:`, e);
                    }
                  })();
                }
              }
            }
          }
        } catch (factsErr) {
          console.warn(`[LEDGER] Facts injection failed for ${callId}:`, factsErr);
        }
      }
    });

    // ─── WS-DIAG: Track every connection state transition before we even connect ───
    transport.on('connection_change', (status: string) => {
      console.info(`[WS-DIAG] connection_change → "${status}" for call ${callId} at ${new Date().toISOString()}`);
    });

    await session.connect({ apiKey: OPENAI_API_KEY!, callId });
    // Instructions have now been read. From here a late pre-context must go
    // through the parked/turn-boundary path, never straight into metadata.
    azulSessionConnected = true;

    const connectDurationMs = Date.now() - sessionConnectStart;
    CallDiagnostics.recordStage(callId, 'session_connected', true, { 
      connectDurationMs,
      agent: effectiveSlug 
    });
    console.info(`[SESSION] ✓ Connected to realtime call ${callId} with agent: ${effectiveSlug}${agentVersion ? ` v${agentVersion}` : ''}`);

    // ─── WS-DIAG: Wire error/close/message directly onto the underlying WebSocket ───
    // transport.connectionState is a public getter that returns { status, websocket }
    // After session.connect() the WebSocket is live and we can attach listeners to it.
    try {
      const rawWs = (transport as any).connectionState?.websocket;
      if (rawWs) {
        rawWs.on('error', (err: any) => {
          console.error(`[WS-DIAG] WebSocket error for call ${callId}: message="${err.message}", code=${err.code}, type=${err.type}`);
        });
        rawWs.on('close', (code: number, reason: Buffer) => {
          console.info(`[WS-DIAG] WebSocket CLOSED for call ${callId}: code=${code}, reason="${reason?.toString() || ''}", time=${new Date().toISOString()}`);
        });
        rawWs.on('message', (data: any) => {
          try {
            const parsed = JSON.parse(data.toString());
            const t = parsed?.type || 'unknown';
            // Skip noisy audio delta events; log everything else in full
            if (t !== 'response.audio.delta' && t !== 'input_audio_buffer.append') {
              console.info(`[WS-DIAG] ← OpenAI msg [${t}] for call ${callId}: ${JSON.stringify(parsed).substring(0, 400)}`);
            }
          } catch {
            console.info(`[WS-DIAG] ← OpenAI raw msg for call ${callId}: ${data.toString().substring(0, 200)}`);
          }
        });
        console.info(`[WS-DIAG] ✓ Raw WebSocket listeners attached for call ${callId}, readyState=${rawWs.readyState}`);
      } else {
        console.warn(`[WS-DIAG] ✗ Could not access underlying WebSocket for call ${callId} (connectionState.websocket is null)`);
      }
    } catch (wsErr: any) {
      console.warn(`[WS-DIAG] ✗ Failed to attach raw WebSocket listeners for call ${callId}:`, wsErr.message);
    }
    
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

    // No-dead-air heartbeat (azul-scheduling only): while any Eye Care tool
    // call is in flight, tracked() fires this every 15s so the agent speaks
    // a brief holding update instead of leaving the caller in silence.
    // Between a function_call and its output there is no active response,
    // so an out-of-band response.create is protocol-safe (same mechanism as
    // the greeting trigger below).
    if ((agentConfig?.id === 'azul-scheduling' || agentConfig?.id === 'pcp') && callId) {
      registerAzulHoldingCallback(callId, (instructionOverride?: string) => {
        try {
          (session.transport as any).sendEvent({
            type: 'response.create',
            response: {
              instructions:
                instructionOverride ??
                "The system lookup you started is still running — that's normal. Say ONE short, warm holding update to the caller (vary the wording each time; never repeat the same sentence twice in a row), e.g. \"Still working on that for you — thanks for hanging with me.\" Say nothing else, ask nothing.",
            },
          });
        } catch (e) {
          console.error(`[SESSION] azul holding update failed for ${callId}:`, e);
        }
      });

      if (agentConfig?.id === 'pcp') {
        pcpHandoffProgress.set(callId, (instructions: string) => {
          try {
            (session.transport as any).sendEvent({ type: 'response.create', response: { instructions } });
          } catch (e) {
            console.error(`[SESSION] PCP handoff update failed for ${callId}:`, e);
          }
        });
      }

      // Tier-2 WARM transfer: lets the agent's transfer_to_office tool dial
      // the sage_handoff packet's office queue number with a briefing +
      // keypress-accept before joining the caller's conference (the number
      // itself never comes from the model).
      registerAzulOfficeTransferCallback(callId, (toNumber, label, briefing) =>
        transferConferenceToNumber(callId, toNumber, label, briefing),
      );

      // Tickets carry the conversation: any azul ticket filed during this
      // call (handoff, failed transfer, or the teardown sweep) reads the
      // live transcript through this getter so the ticketing app can build
      // its staff-facing summary. Unregistered after the timeline flush.
      registerAzulTranscriptProvider(callId, () => (callTranscripts.get(callId) ?? []).join('\n'));
    }

    // STEP 4: Force the agent to speak first by sending response.create
    // ALWAYS send response.create — even when TwiML delivered the greeting audio.
    // Without this, the agent sits in listen-only mode and never speaks.
    // The greeting must agree with the prompt, or the model is handed two
    // contradictory orders on its very first turn.
    //
    // The configured greeting is forced verbatim ("Say exactly this greeting"),
    // while azul's CALLER-ID PRE-CONTEXT block tells it to open with "Am I
    // speaking with <name>?". When a match lands before connect, BOTH apply —
    // and the model starts the generic line, then abandons it mid-phrase for
    // the familiar one. Heard on the 07-29 13:51 call as:
    //     "Thanks for calling" / "Good morning. Am I speaking with Wayne?"
    //
    // That reads as the agent being cut off or losing its place, and it is
    // easy to misdiagnose as a turn-detection or interruption setting. It is
    // neither: it is two instructions in one turn. This was invisible until
    // the pre-context lookup got fast enough to win its race.
    //
    // Fix: when the caller is recognised, the FORCED greeting becomes the
    // familiar one, so there is exactly one instruction to follow.
    // CP-2: seed the call-facts ledger before the first word — caller phone
    // (callback candidate), pre-context match, language (docs/ramp/playbook.md).
    try {
      const seedConf = getConferenceName(callId);
      seedLedger(callId, {
        callerPhone: seedConf ? ConferenceNametoCallerIDMapping[seedConf] : undefined,
        matchedFirstName: azulMetadataRef?.precontext?.matched ? azulMetadataRef.precontext.firstName : undefined,
        matchedLastName: azulMetadataRef?.precontext?.matched ? azulMetadataRef.precontext.lastNameOnFile : undefined,
        language: metadata?.language,
      });
    } catch (ledgerErr) {
      console.warn(`[LEDGER] Seed failed for ${callId}:`, ledgerErr);
    }

    let agentGreeting = metadata?.agentGreeting;
    // The database `agents.welcome_greeting` outranks the hardcoded route/
    // config strings — see greetingResolver. Critically, it also RESCUES the
    // greeting when in-memory call metadata is lost (the webhook can land on
    // a different instance than the one that stored it — the root cause of
    // agents improvising their openings; diagnosed 2026-08-06 on four live
    // SD calls). The slug survives that loss via SIP header / phone lookup,
    // so it — not the metadata — is what the DB lookup keys on.
    //
    // The one case the DB must NOT override: a path that deliberately set an
    // EMPTY greeting (listen-first — TwiML already spoke, or the Spanish IVR
    // handler sets it later). Metadata present + empty means intent; metadata
    // absent means loss, and loss gets the configured greeting.
    const listenFirst = metadata?.agentGreeting !== undefined && metadata.agentGreeting.trim() === '';
    const configuredGreeting = listenFirst ? null : await resolveConfiguredGreeting(agentSlug);
    if (configuredGreeting) {
      if (!agentGreeting || agentGreeting.trim() === '') {
        console.info(`[GREETING] In-memory metadata missing for ${callId} — configured greeting rescued from DB (agent: ${agentSlug})`);
      }
      agentGreeting = configuredGreeting;
    }
    const recognisedFirstName = azulMetadataRef?.precontext?.matched
      ? String(azulMetadataRef.precontext.firstName ?? '').trim()
      : '';
    if (recognisedFirstName && agentGreeting) {
      agentGreeting = `Hello, thank you for calling Azul Vision. Am I speaking with ${recognisedFirstName}?`;
      console.info(`[AZUL-SCHED] Greeting personalised for recognised caller (${recognisedFirstName})`);
    }

    // CP-4 (spine S1): on ramp lines, a caller-ID match personalizes the
    // greeting for ANY agent, and the deterministic ramp takes the opening.
    if (agentSlug && RAMP_AGENTS.has(agentSlug)) {
      const rampFacts = getCallFacts(callId);
      if (!recognisedFirstName && rampFacts?.matchedFirstName && agentGreeting && agentGreeting.trim() !== '') {
        agentGreeting = `Hello, thank you for calling Azul Vision. Am I speaking with ${rampFacts.matchedFirstName}?`;
        console.info(`[RAMP] Greeting personalised from ledger match for ${callId}`);
      }
      startRamp(callId, agentSlug === 'pcp' ? 'professional' : agentSlug === 'azul-scheduling' ? 'sd_front' : 'patient');
      console.info(`[RAMP] Ramp engaged for ${agentSlug} call ${callId}`);
    }

    if (agentGreeting && agentGreeting.trim() !== '') {
      console.info(`[SESSION] Triggering greeting via response.create: "${agentGreeting.substring(0, 50)}..."`);

      armGreetingGuarantee(
        callId,
        agentGreeting,
        `Say this greeting to the caller word-for-word, without adding, removing, or rephrasing anything: "${agentGreeting}" - Then stop and wait for their response.`,
        session.transport as any,
      );
      console.info(`[SESSION] ✓ Greeting triggered for call ${callId}`);
      CallDiagnostics.recordStage(callId, 'first_audio_sent', true, { source: 'agent_greeting' });
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
    abortedPcpHandoffs.add(callId);
    await cancelActiveOfficeLegs(callId);
    setTimeout(() => abortedPcpHandoffs.delete(callId), 10 * 60_000);
    // Azul scheduling: stop the holding heartbeat, drop the transfer hook +
    // persist the pilot tool timeline (all no-ops for other agents)
    unregisterAzulHoldingCallback(callId);
    unregisterAzulOfficeTransferCallback(callId);
    pcpHandoffProgress.delete(callId);
    // Terminal-disposition sweep BEFORE the flush (the sweep reads — and may
    // append a ticket event to — the in-memory timeline the flush deletes).
    // Bounded at 25s: a wedged sweep must never block the flush (2026-07-24
    // 10:53 call ended with tool_timeline never persisted).
    // AZUL ONLY (2026-07-30 incident). It ran for every call and was harmless
    // purely because a zero-event call used to return early; when that
    // exemption was removed the same night, every answering-service call
    // looked like an agent that did nothing, and the sweep filed a "call them
    // back" ticket for each one. ~30 false tickets reached the staff queue
    // between 09:50 and 12:03 PT before this gate.
    //
    // DO NOT REMOVE THIS GATE. Its original justification was "azul is the
    // only agent that writes a timeline" — as of 2026-08-01 (D11) that is no
    // longer true: answering-service and no-ivr record too. The gate survives
    // on the stronger reason, which was always the real one: this sweep
    // REASONS IN AZUL'S VOCABULARY. It asks whether a sage_* booking flow
    // reached a terminal disposition. A fleet timeline full of create_ticket
    // and classify_request events answers a different question entirely, and
    // feeding it to this sweep would re-file the same false tickets from a
    // fresh direction. Fleet timelines are for diagnosis, not for sweeping.
    void (agentConfig?.id === 'azul-scheduling'
      ? import('./agents/azulSchedulingAgent').then(({ sweepAzulUnresolvedCall }) =>
          Promise.race([
            sweepAzulUnresolvedCall(callId),
            new Promise((resolve) => setTimeout(resolve, 25_000)),
          ]),
        )
      : Promise.resolve())
      .catch(() => {})
      .then(() => flushAzulTimeline(callId))
      .catch((err) => console.error(`[AZUL-TIMELINE] teardown flush failed for ${callId}:`, err))
      // After the flush: the sweep (which may file a ticket needing the
      // transcript) has run, so the getter can be released.
      .finally(() => unregisterAzulTranscriptProvider(callId));

    // Flush accumulated Realtime token usage → accurate per-call OpenAI cost
    // (pricing registry path). Falls back to the duration estimate downstream
    // when no usage events were captured. Fire-and-forget — must not delay
    // call teardown.
    {
      const usage = callTokenUsage.get(callId);
      callTokenUsage.delete(callId);
      const usageCallLogId = callMetadataForDB.get(callId)?.dbCallLogId;
      if (usage && usage.responses > 0 && usageCallLogId) {
        void (async () => {
          try {
            const { callCostService } = await import('./services/callCostService');
            await callCostService.updateCallCostsWithTokens(
              usageCallLogId,
              twilioCallSid || null,
              {
                inputAudioTokens: usage.inputAudioTokens,
                outputAudioTokens: usage.outputAudioTokens,
                inputTextTokens: usage.inputTextTokens,
                outputTextTokens: usage.outputTextTokens,
                inputCachedTokens: usage.inputCachedTokens,
              } as any,
              'gpt-realtime',
            );
            console.info(`[COST] Token-based cost saved for ${usageCallLogId}: ${usage.responses} responses, in=${usage.inputAudioTokens}a/${usage.inputTextTokens}t (${usage.inputCachedTokens} cached), out=${usage.outputAudioTokens}a/${usage.outputTextTokens}t`);
          } catch (err) {
            console.error(`[COST] Token-based cost update failed for ${usageCallLogId}:`, err);
          }
        })();
      }
    }

    // Update call log with transcript and final status when call actually ends
    const callMeta = callMetadataForDB.get(callId);
    if (callMeta?.dbCallLogId) {
      try {
        const transcript = callTranscripts.get(callId)?.join('\n') || '';
        const endTime = new Date();
        
        // CRITICAL: DO NOT save duration from OpenAI session - TWILIO IS THE SOURCE OF TRUTH
        // The Twilio status callback will provide the authoritative duration via CallDuration
        // We only save transcript and metadata here - duration comes from Twilio later
        
        // Resolve caller name: prefer what tools wrote to callMeta, then fall back to
        // any escalation details still in the map (populated by triage agents)
        const resolvedCallerName = callMeta.callerName || (() => {
          const esc = escalationDetailsMap.get(callId);
          if (!esc) return undefined;
          if (esc.patientFirstName || esc.patientLastName) {
            return [esc.patientFirstName, esc.patientLastName].filter(Boolean).join(' ').trim();
          }
          return esc.callerType || undefined;
        })();

        // SEV-1 2026-07-30: turn telemetry finally has a writer. The columns
        // existed since Phase 7 with no writer anywhere, so the graders that
        // read them returned a permanent neutral 0.5 on every call and the
        // regression watch was numerically anaesthetised. The write lives in
        // flushLoopTelemetry so the lifecycle coordinator's 'call-ended'
        // handler can do it too — on the 07-30 test calls the coordinator
        // finalized 4 of 5, and this block never ran for them.
        void flushLoopTelemetry(callId, callMeta.dbCallLogId);

        await storage.updateCallLog(callMeta.dbCallLogId, {
          status: 'completed',
          endTime,
          // DO NOT SET DURATION HERE - Twilio status callback will set it
          // Setting it here with session time causes the 600s bug
          transcript,
          transferredToHuman: callMeta.transferredToHuman,
          humanAgentNumber: callMeta.transferredToHuman
            ? (callMeta.transferTargetNumber ?? HUMAN_AGENT_NUMBER)
            : undefined,
          // Mark as estimated until Twilio confirms
          costIsEstimated: true,
          ...(resolvedCallerName ? { callerName: resolvedCallerName } : {}),
        });
        
        console.info(`[DB] Call log updated: ${callMeta.dbCallLogId}, Duration=AWAITING_TWILIO, Transferred: ${callMeta.transferredToHuman}`);
        console.info(`[DB] Transcript saved (${transcript.split('\n').length} lines)`);
        
        // Async: Calculate costs, grade call, and push to ticketing API (don't block call cleanup)
        // Store ALL required data before cleanup deletes the maps
        const asyncCallId = callId;
        const twilioCallSid = callMeta.twilioCallSid;
        const dbCallLogId = callMeta.dbCallLogId;
        const prefetchedCarrierName = callMeta.carrierCallerName ?? null;
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
            
            // Twilio reconciliation is handled by the lifecycle coordinator event listener
            // (avoids duplicate API calls - the coordinator already waits and retries)
            // Calculate OpenAI costs based on current duration in database
            // (will be recalculated when lifecycle coordinator gets final Twilio data)
            await callCostService.recalculateOpenAICostFromDuration(dbCallLogId!);
            
            // Grade the call if we have a substantive transcript (skip ghost/short calls to save LLM costs)
            let gradeResult: { qualityScore?: number; patientSentiment?: string; agentOutcome?: string } = {};
            if (finalTranscript && finalTranscript.length > 200) {
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
            
            if (twilioCallSid && (agentSlug === 'after-hours' || agentSlug === 'no-ivr' || agentSlug === 'answering-service' || agentSlug === 'azul-scheduling' || agentSlug === 'pcp') && hasValidTicket && hasValidTranscript) {
              
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

            // Twilio Lookup enrichment — if no callerName was collected by the agent,
            // attempt a carrier lookup and persist the result (prefixed with [Lookup]).
            try {
              const latestCallLog = await storage.getCallLog(dbCallLogId!);
              if (!latestCallLog?.callerName && callerPhone) {
                // azul already looked this number up at call start to
                // sanity-check the pre-context surname — reuse it rather than
                // paying Twilio twice for the same answer.
                const enrichedName =
                  prefetchedCarrierName ??
                  (await import('./lib/twilioClient').then(({ lookupCallerName }) => lookupCallerName(callerPhone)));
                if (enrichedName) {
                  await storage.updateCallLog(dbCallLogId!, { callerName: enrichedName });
                  console.info(`[LOOKUP] Enriched callerName for ${dbCallLogId}: ${enrichedName}`);
                }
              }
            } catch (lookupErr) {
              console.warn('[LOOKUP] Caller-name enrichment step failed (non-fatal):', (lookupErr as Error)?.message ?? lookupErr);
            }

            // QVO event — fire after a 20-second delay so Twilio costs have time to reconcile
            if (dbCallLogId) {
              const callLogIdForQvo = dbCallLogId;
              setTimeout(async () => {
                try {
                  const { qvoEmitterService } = await import('./services/qvoEmitterService');
                  await qvoEmitterService.emitCallCompleted(callLogIdForQvo);
                } catch { /* never propagate */ }
              }, 20_000);
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
    responseInFlight.delete(callId);
    pendingGreetings.delete(callId);
    lastFactsRender.delete(callId);
    releaseLedger(callId);
    void import('./services/toolDirection').then(({ releaseDirectionState }) => releaseDirectionState(callId));
    releaseRamp(callId);
    callMetadataForDB.delete(callId);
    callTranscripts.delete(callId);
    deadAirWatchdog.release(callId);
    conversationLoopGuard.releaseCall(callId);
    void import('./services/identityArgGuard').then(({ releaseIdentityGuard }) => releaseIdentityGuard(callId));
    void import('./agents/azulSchedulingAgent').then(({ releaseAzulCallState }) => releaseAzulCallState(callId));
    director.release(callId);
    // Turn table: write before releasing, then free. Fire-and-forget — a
    // debugging record must never delay teardown.
    void flushTurns(callId).finally(() => releaseTurns(callId));
    
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
  // Preload every agent's configured greeting so the first calls after a
  // boot don't race a cold database connection (greetingResolver).
  scheduleGreetingCacheWarm();

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

        console.info(`\n${'='.repeat(60)}`);
        console.info(`[TRACE-3] OPENAI WEBHOOK ARRIVED → realtime.call.incoming`);
        console.info(`[TRACE-3]   call_id:      ${callId}`);
        console.info(`[TRACE-3]   sip_headers:  ${sipHeaders ? JSON.stringify(sipHeaders).substring(0, 200) : 'NONE'}`);
        console.info(`[TRACE-3]   full event:   ${JSON.stringify(event).substring(0, 400)}`);
        console.info(`${'='.repeat(60)}`);
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
            // ✅ Mark this conference as confirmed — the REAL OpenAI webhook arrived.
            // The emergency fallback timer checks this Set (not conferenceNameToCallID,
            // which is also populated by conference-join events before the webhook fires).
            openAIWebhookConfirmed.add(conferenceNameFromSIP);
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
        const validInboundAgents = ['no-ivr', 'after-hours', 'answering-service', 'azul-scheduling', 'pcp'];
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
  <Say voice="alice">Please hold while we connect you.</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
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

    console.info(`\n${'='.repeat(60)}`);
    console.info(`[TRACE-1] TWILIO WEBHOOK ARRIVED → /api/voice/no-ivr`);
    console.info(`[TRACE-1]   CallSid:     ${callSid}`);
    console.info(`[TRACE-1]   From:        ${callerIDNumber}`);
    console.info(`[TRACE-1]   To:          ${dialedNumber}`);
    console.info(`[TRACE-1]   CallToken:   ${callToken ? `PRESENT (len=${callToken.length}, prefix="${callToken.substring(0,12)}...")` : 'MISSING ← THIS IS THE PROBLEM'}`);
    console.info(`[TRACE-1]   Raw fields:  ${Object.keys(parsedBody).join(', ')}`);
    console.info(`${'='.repeat(60)}`);

    if (!callSid || !callerIDNumber) {
      console.error('[NO-IVR] ✗ Missing required parameters (callSid or callerIDNumber)');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }
    if (!callToken) {
      console.error('[TRACE-1] ✗✗✗ NO CALLTOKEN — SIP call will be sent with empty callToken, OpenAI WILL reject it');
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
  <Say voice="alice">Please hold while we connect you.</Say>
  <Dial>
    <Conference 
      beep="false"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
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
    console.info(`[TRACE-2] CREATING SIP PARTICIPANT → OpenAI SIP gateway`);

    const sipTo = `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=no-ivr`;
    const webhookToken = ConferenceNametoCallTokenMapping[conferenceName];
    console.info(`[TRACE-2]   from:        ${envConfig.twilio.phoneNumber}`);
    console.info(`[TRACE-2]   to:          ${sipTo.substring(0, 100)}...`);
    console.info(`[TRACE-2]   callToken:   ${webhookToken ? `PRESENT (len=${webhookToken.length}, prefix="${webhookToken.substring(0,15)}...")` : 'OMITTED (testing without token)'}`);
    console.info(`[TRACE-2]   conference:  ${conferenceName}`);
    console.info(`[TRACE-2]   PROJECT_ID:  ${process.env.OPENAI_PROJECT_ID || 'MISSING ← WILL FAIL'}`);

    let sipParticipantCallSid: string | undefined;
    try {
      const participantParams: any = {
        from: envConfig.twilio.phoneNumber!,
        label: 'virtual agent',
        to: sipTo,
        earlyMedia: true,
        // statusCallback fires when the SIP leg changes status (completed/failed/busy/no-answer)
        // This tells us the EXACT SIP response code OpenAI returns on rejection
        statusCallback: `https://${domain}/api/voice/sip-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
        conferenceStatusCallbackEvent: ['join', 'leave'],
      };
      // Pass callToken exactly as Twilio sent it — original working code always passed it
      if (webhookToken) {
        participantParams.callToken = webhookToken;
        console.info(`[TRACE-2]   → Passing callToken (len=${webhookToken.length}, prefix="${webhookToken.substring(0, 20)}...")`);
      } else {
        console.info(`[TRACE-2]   → No callToken available`);
      }

      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create(participantParams);
      sipParticipantCallSid = participant.callSid;
      sipConferenceLifecycle.registerSipLeg(conferenceName, participant.callSid);
      console.info(`[TRACE-2] ✓ SIP PARTICIPANT CREATED`);
      console.info(`[TRACE-2]   participant.callSid: ${participant.callSid}`);
      console.info(`[TRACE-2]   participant.status:  ${(participant as any).status ?? 'not-in-response'}`);
      console.info(`[TRACE-2]   → Now waiting for OpenAI to fire realtime.call.incoming webhook...`);
      console.info(`[TRACE-2]   → If [TRACE-3] never appears, OpenAI rejected the SIP INVITE silently`);
    } catch (error: any) {
      console.error(`[TRACE-2] ✗✗✗ SIP PARTICIPANT CREATION FAILED`);
      console.error(`[TRACE-2]   error.message: ${error?.message}`);
      console.error(`[TRACE-2]   error.status:  ${error?.status}`);
      console.error(`[TRACE-2]   error.code:    ${error?.code}`);
      console.error(`[TRACE-2]   full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      void recoverCallerAfterSipTermination(conferenceName, 'creation_failed');
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
          callToken: ConferenceNametoCallTokenMapping[conferenceName] || (() => { console.warn('[DEV-NO-IVR] ⚠️ No webhook CallToken found — passing empty string'); return ''; })(),
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

    if (!callSid || !callerIDNumber) {
      console.error('[ANSWERING-SERVICE] ✗ Missing required parameters (callSid or callerIDNumber)');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }
    if (!callToken) {
      console.warn('[ANSWERING-SERVICE] ⚠️ No CallToken in webhook body — fresh token will be generated from OpenAI API');
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
      agentGreeting: 'Hello and thank you for calling Azul Vision, all of our agents are currently busy, but I am here to assist, how can I help you?',
      language: 'english',
      ivrSelection: undefined,
    } as any);
    
    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = 'sage';
      extendedMeta.languageForCall = 'en'; // Use agent config language - prevents auto-detect issues
    }

    console.info(`[ANSWERING-SERVICE] Routing to answering-service agent (overflow, voice=sage, lang=en)`);

    // Brief hold bridge while OpenAI SIP participant connects (~1-2s).
    // The AI agent delivers the full greeting once connected via response.create.
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
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
      const webhookToken = ConferenceNametoCallTokenMapping[conferenceName];
      if (!webhookToken) {
        console.warn('[ANSWERING-SERVICE] ⚠️ No webhook CallToken found — passing empty string');
      }
      const effectiveToken = webhookToken || '';
      const participant = await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=answering-service`,
          earlyMedia: true,
          callToken: effectiveToken,
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[ANSWERING-SERVICE] ✓ Answering-service agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[ANSWERING-SERVICE] ✗ Failed to add agent to conference:`, error);
    }
  });

  // Dedicated professional-caller line. This route always stamps X-agentSlug=pcp;
  // it never inherits the after-hours default or patient-facing agent metadata.
  app.post('/api/voice/pcp', webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString('utf8');
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    if (!callSid || !/^CA[0-9A-Za-z]{10,64}$/.test(callSid) || !callerIDNumber) {
      res.status(400).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say></Response>');
      return;
    }

    const domain = envConfig.domain;
    const conferenceName = `conf_${callSid}`;
    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;
    callMetadata.set(conferenceName, {
      agentSlug: 'pcp',
      agentGreeting: pcpAgentConfig.greeting,
      language: 'english',
      ivrSelection: undefined,
    });
    const extendedMeta = callMetadata.get(conferenceName) as typeof callMetadata extends Map<string, infer T> ? T & { voiceForCall?: string; languageForCall?: string } : never;
    if (extendedMeta) {
      extendedMeta.voiceForCall = pcpAgentConfig.voice;
      extendedMeta.languageForCall = pcpAgentConfig.language;
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you to PCP Support.</Say>
  <Dial>
    <Conference beep="false" waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical" startConferenceOnEnter="true" endConferenceOnExit="true" participantLabel="customer" record="record-from-start" recordingStatusCallback="https://${domain}/api/voice/recording-status" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed" statusCallback="https://${domain}/api/voice/conference-events" statusCallbackEvent="start end join leave" statusCallbackMethod="POST">${escapeXml(conferenceName)}</Conference>
  </Dial>
</Response>`;
    res.type('text/xml').send(twimlResponse);

    try {
      if (!twilioClient) twilioClient = await getTwilioClient();
      await twilioClient.conferences(conferenceName).participants.create({
        from: envConfig.twilio.phoneNumber!,
        label: 'virtual agent',
        to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=pcp`,
        earlyMedia: true,
        callToken: callToken || '',
        conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
        conferenceStatusCallbackEvent: ['join'],
      });
      console.info(`[PCP] Agent participant added for call ${callSid.slice(-6)}`);
    } catch (error) {
      console.error('[PCP] Failed to add agent participant:', error instanceof Error ? error.message : 'unknown');
    }
  });

  // AZUL SCHEDULING ENDPOINT - NextGen scheduling line (San Diego pilot)
  // Point the pilot Twilio number's Voice webhook at this endpoint. All
  // scheduling decisions are gated by the Eye Care rules engine (sage_* tools).
  app.post("/api/voice/azul-scheduling", webhookRateLimiter, async (req, res) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

    const callSid = parsedBody.CallSid;
    const callToken = parsedBody.CallToken;
    const callerIDNumber = parsedBody.From;
    const dialedNumber = parsedBody.To;

    console.info(`\n[AZUL-SCHED] ✓ Scheduling call received: ${callSid} from ${callerIDNumber} to ${dialedNumber}`);

    if (!callSid || !callerIDNumber) {
      console.error('[AZUL-SCHED] ✗ Missing required parameters (callSid or callerIDNumber)');
      res.status(400).send('<Response><Say>Invalid request</Say></Response>');
      return;
    }
    if (!callToken) {
      console.warn('[AZUL-SCHED] ⚠️ No CallToken in webhook body — fresh token will be generated from OpenAI API');
    }

    const domain = process.env.DOMAIN || req.get('host');
    const conferenceName = `conf_${callSid}`;

    callIDtoConferenceNameMapping[callSid] = conferenceName;
    ConferenceNametoCallerIDMapping[conferenceName] = callerIDNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = dialedNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = callToken;
    conferenceNameToTwilioCallSid[conferenceName] = callSid;

    callMetadata.set(conferenceName, {
      agentSlug: 'azul-scheduling',
      agentGreeting: azulSchedulingAgentConfig.greeting,
      language: 'english',
      ivrSelection: undefined,
    } as any);

    const extendedMeta = callMetadata.get(conferenceName) as any;
    if (extendedMeta) {
      extendedMeta.voiceForCall = azulSchedulingAgentConfig.voice;
      extendedMeta.languageForCall = azulSchedulingAgentConfig.language;
    }

    console.info(`[AZUL-SCHED] Routing to azul-scheduling agent (voice=${azulSchedulingAgentConfig.voice}, lang=${azulSchedulingAgentConfig.language})`);

    // Caller-ready gate — created BEFORE the TwiML is sent, exactly as the
    // no-IVR route does (see the /api/voice/no-ivr handler).
    //
    // Without it, `callerReadyPromise` is null at the consumer (the lookup by
    // conference name below `observeCall`'s accept), the wait is skipped, and
    // `response.create` fires the greeting as soon as the session is ready —
    // which can be while the caller is still inside the TwiML, before they
    // have joined the conference. The greeting is then spoken into an empty
    // room, and because the prompt forbids repeating it and tells the model
    // to wait a full 5 seconds of silence before re-prompting, the caller's
    // first experience of the line is several seconds of nothing.
    //
    // The consumer side is already agent-agnostic — it keys purely off the
    // conference name — and azul already emits `participant-join` (see the
    // statusCallback below), so the resolver fires today with nothing
    // listening. This is the missing producer, nothing else.
    const callerReadyPromise = new Promise<void>((resolve) => {
      callerReadyResolvers.set(conferenceName, resolve);
      setTimeout(() => {
        if (callerReadyResolvers.has(conferenceName)) {
          console.warn(`[AZUL-SCHED] Caller-ready timeout (10s) for ${conferenceName} — proceeding anyway`);
          callerReadyResolvers.delete(conferenceName);
          resolve();
        }
      }, 10000);
    });
    callerReadyPromises.set(conferenceName, callerReadyPromise);
    console.info(`[AZUL-SCHED] Caller-ready promise created for: ${conferenceName}`);

    // `<Say>` + real hold audio instead of `<Pause length="1"/>` + waitUrl="".
    // Two jobs: the caller hears a human voice immediately rather than dead
    // air, and the ~2-3s of covered audio is genuine runway for the
    // caller-ID pre-context lookup to land before the greeting turn.
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Dial>
    <Conference
      beep="false"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
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
    console.info(`[AZUL-SCHED] ✓ Caller joined conference: ${conferenceName}`);

    try {
      if (!twilioClient) {
        twilioClient = await getTwilioClient();
      }
    } catch (twilioInitError) {
      console.error(`[AZUL-SCHED] ✗ Failed to initialize Twilio client:`, twilioInitError);
      return;
    }

    console.info(`[AZUL-SCHED] Adding azul-scheduling agent to conference: ${conferenceName}`);

    try {
      const webhookToken = ConferenceNametoCallTokenMapping[conferenceName];
      if (!webhookToken) {
        console.warn('[AZUL-SCHED] ⚠️ No webhook CallToken found — passing empty string');
      }
      const effectiveToken = webhookToken || '';
      await twilioClient.conferences(conferenceName)
        .participants
        .create({
          from: envConfig.twilio.phoneNumber!,
          label: 'virtual agent',
          to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}&X-CallerPhone=${encodeURIComponent(callerIDNumber)}&X-agentSlug=azul-scheduling`,
          earlyMedia: true,
          callToken: effectiveToken,
          conferenceStatusCallback: `https://${domain}/api/voice/conference-events`,
          conferenceStatusCallbackEvent: ['join']
        });
      console.info(`[AZUL-SCHED] ✓ Azul scheduling agent successfully added to conference: ${conferenceName}`);
    } catch (error) {
      console.error(`[AZUL-SCHED] ✗ Failed to add agent to conference:`, error);
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
          callToken: ConferenceNametoCallTokenMapping[conferenceName] || (() => { console.warn('[APPT-CONFIRM] ⚠️ No webhook CallToken found — passing empty string'); return ''; })(),
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

  // Warm-transfer accept: the office staffer pressed a key after hearing the
  // briefing. Respond with TwiML joining them into the caller's conference,
  // and resolve the waiting transfer so the AI leg is released.
  app.post("/api/voice/warm-transfer-accept", webhookRateLimiter, async (req: { body: { toString: (enc: string) => string } }, res: { type: (t: string) => void; send: (b: string) => void }) => {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    const callSid = parsedBody.CallSid;
    const pending = callSid ? warmTransferAccepts.get(callSid) : undefined;
    res.type("text/xml");
    if (!pending) {
      console.warn(`[WARM-TRANSFER] Accept from unknown/expired CallSid: ${callSid}`);
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">This transfer has expired. Goodbye.</Say><Hangup/></Response>`);
      return;
    }
    // A KEYPRESS IS THE ONLY ACCEPT. The briefing asks for one before and after the
    // details, so reaching here with no digits means the briefing played out
    // unanswered — an unattended line, a voicemail greeting, or nobody listening.
    // Either way the waiting caller must not be bridged into it.
    //
    // This replaced a silence-accepts rule gated on answering-machine detection.
    // AMD judges from the first audio on the line, so a staffed hunt group with a
    // greeting scored 'machine' and the handler hung up on live people: both of the
    // first PCP transfers to the queue failed exactly that way. A digit is positive
    // proof of a person and needs no verdict, so the AMD verdict is now recorded for
    // diagnosis rather than used to decide.
    const digits = (parsedBody.Digits ?? '').trim();
    const answeredBy = pending.answeredBy ?? '';
    if (!digits) {
      const isMachine = answeredBy.startsWith('machine') || answeredBy === 'fax';
      console.warn(
        `[WARM-TRANSFER] ✗ No keypress on ${callSid} after the briefing (AMD: '${answeredBy || 'no verdict'}') — not bridging the caller`,
      );
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      warmTransferAccepts.delete(callSid);
      void recordTransferOutcome(callSid, isMachine ? 'machine' : 'no_keypress', { amdVerdict: answeredBy || null });
      pending.reject(new Error(isMachine ? `Office leg answered by ${answeredBy}` : 'Office leg did not press a key to accept'));
      return;
    }
    // Only a keypress reaches here now, so acceptMethod is always 'keypress'.
    console.log(
      `[WARM-TRANSFER] ✓ Keypress accept from ${callSid} (AMD: ${answeredBy || 'no verdict'}) → joining conference ${pending.conferenceName}`,
    );
    // join/leave on THIS conference is the only hard evidence that the two
    // legs were actually bridged, and how long for. Every other conference in
    // this file already reports; this one did not, which is why
    // `transferred_live` — a record of our DECISION to connect — was standing
    // in for a measurement of what happened.
    void recordTransferOutcome(callSid, 'accepted', {
      acceptMethod: 'keypress',
      amdVerdict: answeredBy || null,
    });
    const bridgeEvents = `https://${envConfig.domain}/api/voice/office-leg-events`;
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Say voice="Polly.Joanna">Connecting you to the patient now.</Say>` +
      `<Dial><Conference endConferenceOnExit="true"` +
      ` statusCallback="${bridgeEvents}" statusCallbackMethod="POST"` +
      ` statusCallbackEvent="join leave">${escapeXml(pending.conferenceName)}</Conference></Dial>` +
      `</Response>`,
    );
    warmTransferAccepts.delete(callSid);
    pending.resolve({
      acceptMethod: 'keypress',
      amdVerdict: answeredBy,
    });
  });

  // Conference join/leave for a warm-transfer OFFICE leg — the measurement
  // that `outcome = 'transferred_live'` is not.
  //
  // That flag is written when the accept handler decides to connect. It says
  // nothing about whether the legs were actually bridged, for how long, or
  // who ended it. On 2026-07-27 two transfers had to be adjudicated by
  // listening to the audio because no join/leave was ever recorded. With
  // these events the four cases separate themselves in a query: never joined,
  // joined and dropped instantly, joined and held, joined and killed by our
  // own cap (leave absent, call ends on a round number).
  // Office-leg conference join/leave — the measurement that
  // `outcome = 'transferred_live'` is not.
  //
  // WHERE THESE ACTUALLY ARRIVE (fixed 2026-07-29): NOT at a dedicated
  // endpoint. Conference status callbacks belong to the CONFERENCE, and Twilio
  // takes them from the participant that CREATES it — here, the caller, whose
  // TwiML points at /api/voice/conference-events. A `statusCallback` on a
  // later joiner's <Conference> noun is silently ignored. The office leg's
  // events have been landing at conference-events all along, which knew
  // nothing about officeLegBridges, so bridge_seconds recorded on ZERO
  // transfers for two days and failed quietly rather than erroring.
  //
  // Now invoked from the conference-events handler. The dedicated route is
  // kept as a harmless second entry point in case a future Twilio change ever
  // honours the per-participant attribute; the map delete on leave makes a
  // double delivery a no-op.
  async function handleOfficeLegConferenceEvent(event: string, callSid: string | undefined): Promise<void> {
    const bridge = callSid ? officeLegBridges.get(callSid) : undefined;
    if (!bridge) return; // caller leg, SIP agent leg, or an expired transfer

    const { recordAzulTransferBridge } = await import('./agents/azulSchedulingAgent');
    if (event === 'participant-join') {
      bridge.joinedAtMs = Date.now();
      console.log(`[BRIDGE] ✓ office leg JOINED conference for ${bridge.openAiCallId} (${bridge.label})`);
      recordAzulTransferBridge(bridge.openAiCallId, {
        officeJoinedAt: new Date(bridge.joinedAtMs).toISOString(),
      });
      return;
    }
    if (event === 'participant-leave') {
      const leftAtMs = Date.now();
      const seconds = bridge.joinedAtMs
        ? Math.round((leftAtMs - bridge.joinedAtMs) / 1000)
        : undefined;
      console.log(
        `[BRIDGE] office leg LEFT conference for ${bridge.openAiCallId} (${bridge.label})` +
          `${seconds != null ? ` after ${seconds}s` : ''}`,
      );
      recordAzulTransferBridge(bridge.openAiCallId, {
        officeLeftAt: new Date(leftAtMs).toISOString(),
        ...(seconds != null ? { bridgeSeconds: seconds } : {}),
      });
      officeLegBridges.delete(callSid!);
    }
  }

  app.post("/api/voice/office-leg-events", webhookRateLimiter, async (req: { body: { toString: (enc: string) => string } }, res: { sendStatus: (c: number) => void }) => {
    res.sendStatus(200);
    const parsedBody = Object.fromEntries(new URLSearchParams(req.body.toString("utf8")));
    await handleOfficeLegConferenceEvent(parsedBody.StatusCallbackEvent, parsedBody.CallSid);
  });

  // Async answering-machine detection verdict for a warm-transfer office leg.
  // Recorded against the pending transfer so the accept handler can tell a
  // real person who stayed quiet from a voicemail greeting. Fires a few
  // seconds into the briefing, well before the second Gather times out.
  app.post("/api/voice/warm-transfer-amd", webhookRateLimiter, async (req: { body: { toString: (enc: string) => string } }, res: { type: (t: string) => void; send: (b: string) => void }) => {
    const parsedBody = Object.fromEntries(new URLSearchParams(req.body.toString("utf8")));
    const callSid = parsedBody.CallSid;
    const answeredBy = parsedBody.AnsweredBy ?? '';
    const pending = callSid ? warmTransferAccepts.get(callSid) : undefined;
    if (pending) {
      // RECORD THE VERDICT, DO NOT ACT ON IT. This handler used to hang up the
      // office leg the moment AMD said 'machine' — and AMD judges from the
      // first audio, so a staffed queue answering with its own greeting scores
      // machine_start in 4-5 seconds.
      //
      // The accept handler was already rewritten for exactly this reason ("the
      // AMD verdict is now recorded for diagnosis rather than used to decide"),
      // but this half of the change was never made, so the keypress rule could
      // never run: the leg was dead before the briefing finished playing.
      // Every one of the first 32 PCP handoffs to +17149564300 died here —
      // 6 of 6 recorded outcomes read machine / machine_start / ring 4-5s, and
      // transferred_to_human is 0 across all 81 PCP calls.
      //
      // Voicemail is still rejected, just a few seconds later and by positive
      // evidence instead of a guess: a real machine never presses a key, so the
      // briefing plays out, the second Gather fires with no digits, and the
      // accept handler hangs up and records 'machine' using the verdict stored
      // here. A person presses a key and is connected.
      pending.answeredBy = answeredBy;
      console.log(`[WARM-TRANSFER] AMD verdict for ${callSid}: ${answeredBy || 'unknown'} (recorded, not acted on — keypress decides)`);
    } else {
      console.warn(`[WARM-TRANSFER] AMD verdict for unknown/expired CallSid ${callSid}: ${answeredBy}`);
    }
    res.type("text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
  });

  // Warm-transfer status: the office leg ended (no-answer / busy / failed /
  // hung up or voicemail played through without a keypress) → reject the
  // waiting transfer so the agent falls back to callback + ticket.
  app.post("/api/voice/warm-transfer-status", webhookRateLimiter, async (req: { body: { toString: (enc: string) => string } }, res: { sendStatus: (c: number) => void }) => {
    res.sendStatus(200);
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));
    const callSid = parsedBody.CallSid;
    const callStatus = parsedBody.CallStatus;
    const pending = callSid ? warmTransferAccepts.get(callSid) : undefined;
    if (!pending) return;
    if (["completed", "busy", "failed", "no-answer", "canceled"].includes(callStatus)) {
      console.warn(`[WARM-TRANSFER] ✗ Office leg ended without accept: ${callStatus} (${callSid})`);
      warmTransferAccepts.delete(callSid);
      // Record BEFORE rejecting: this is the "the office never picked up"
      // evidence, and it is the case nobody could see until now. A leg that
      // reaches "completed" without ever accepting was answered and hung up
      // (or rang out to voicemail) — for our purposes, nobody took the call.
      const OUTCOME_BY_STATUS: Record<string, 'no_answer' | 'busy' | 'failed' | 'canceled'> = {
        'no-answer': 'no_answer',
        completed: 'no_answer',
        busy: 'busy',
        failed: 'failed',
        canceled: 'canceled',
      };
      void recordTransferOutcome(callSid, OUTCOME_BY_STATUS[callStatus] ?? 'failed');
      pending.reject(new Error(`office_${callStatus}_no_accept`));
    }
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
  app.post("/api/voice/warm-transfer-status", webhookRateLimiter, async (req: { body: { toString: (enc: string) => string } }, res: { sendStatus: (c: number) => void }) => {
    res.sendStatus(200);
    console.info(`[WARM-TRANSFER-STATUS] Received callback (warm transfer disabled)`);
  });

  // SIP participant status callback — fires when the OpenAI SIP leg changes state.
  // This is the ONLY way to see the exact SIP error code OpenAI returns on rejection.
  app.post("/api/voice/sip-status", webhookRateLimiter, async (req, res) => {
    res.sendStatus(200);
    try {
      const rawBody = req.body.toString("utf8");
      const p = Object.fromEntries(new URLSearchParams(rawBody));
      const status    = p.CallStatus;        // failed | completed | busy | no-answer
      const sipCode   = p.SipResponseCode;   // e.g. 403, 404, 503 — THE KEY FIELD
      const callSid   = p.CallSid;
      const to        = p.To;
      const errorCode = p.ErrorCode;         // Twilio error code if any
      const errorMsg  = p.ErrorMessage;
      console.error(`[SIP-STATUS] ▼▼▼ OpenAI SIP leg status: ${status} ▼▼▼`);
      console.error(`[SIP-STATUS]   CallSid:        ${callSid}`);
      console.error(`[SIP-STATUS]   To:             ${to?.substring(0, 80)}`);
      console.error(`[SIP-STATUS]   CallStatus:     ${status}`);
      console.error(`[SIP-STATUS]   SipResponseCode:${sipCode} ← THIS IS THE REJECTION REASON`);
      console.error(`[SIP-STATUS]   ErrorCode:      ${errorCode}`);
      console.error(`[SIP-STATUS]   ErrorMessage:   ${errorMsg}`);
      console.error(`[SIP-STATUS]   Full body:      ${rawBody.substring(0, 500)}`);

      const conferenceName = sipConferenceLifecycle.resolveConferenceName(callSid, to);
      const recoveryPlan = sipConferenceLifecycle.beginCallerRecovery({
        sipCallSid: callSid,
        status,
        to,
        transferredToHuman: conferenceName ? conferenceWasTransferredToHuman(conferenceName) : false,
      });
      if (recoveryPlan) {
        // Callback already received its 200 above. Recovery remains non-blocking
        // and waits briefly for any simultaneous human-join event to land.
        setTimeout(() => {
          const transferredToHuman = conferenceWasTransferredToHuman(recoveryPlan.conferenceName);
          if (sipConferenceLifecycle.canExecuteCallerRecovery(recoveryPlan.conferenceName, transferredToHuman)) {
            void recoverCallerAfterSipTermination(recoveryPlan.conferenceName, status || 'terminal');
          } else {
            console.info(`[SIP-RECOVERY] Transfer won race for ${recoveryPlan.conferenceName}`);
          }
        }, 750);
      }
    } catch (e: any) {
      console.error(`[SIP-STATUS] Failed to parse callback:`, e.message);
    }
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

    const isOfficeLegParticipant = Boolean(participantCallSid && officeLegBridges.has(participantCallSid));
    const isHumanParticipant = label === 'human agent' || isOfficeLegParticipant;
    if (isHumanParticipant && event === 'participant-join') {
      sipConferenceLifecycle.markHumanJoined(friendlyName);
    } else if (isHumanParticipant && event === 'participant-leave') {
      sipConferenceLifecycle.markHumanLeft(friendlyName);
    }

    // Office-leg bridge telemetry. These events arrive HERE, not at
    // /api/voice/office-leg-events — see the note on
    // handleOfficeLegConferenceEvent. No-ops for every non-office participant.
    void handleOfficeLegConferenceEvent(event, participantCallSid);

    // TRACE-5: Full conference event dump — critical for diagnosing SIP participant failures
    const isSipParticipant = label === 'virtual agent';
    if (isSipParticipant) {
      console.info(`\n${'='.repeat(60)}`);
      console.info(`[TRACE-5] CONFERENCE EVENT FOR SIP PARTICIPANT (virtual agent)`);
      console.info(`[TRACE-5]   event:            ${event}`);
      console.info(`[TRACE-5]   label:            ${label}`);
      console.info(`[TRACE-5]   FriendlyName:     ${friendlyName}`);
      console.info(`[TRACE-5]   ConferenceSid:    ${conferenceSid}`);
      console.info(`[TRACE-5]   CallSid:          ${participantCallSid}`);
      console.info(`[TRACE-5]   CallStatus:       ${parsedBody.CallStatus ?? 'N/A'}`);
      console.info(`[TRACE-5]   SipResponseCode:  ${parsedBody.SipResponseCode ?? 'N/A'}`);
      console.info(`[TRACE-5]   ErrorCode:        ${parsedBody.ErrorCode ?? 'N/A'}`);
      console.info(`[TRACE-5]   ErrorMessage:     ${parsedBody.ErrorMessage ?? 'N/A'}`);
      console.info(`[TRACE-5]   ALL FIELDS: ${JSON.stringify(parsedBody)}`);
      console.info(`${'='.repeat(60)}`);
    } else {
      console.info(`[CONFERENCE] Event: ${event}, Label: ${label}, FriendlyName: ${friendlyName}, ConferenceSid: ${conferenceSid}, CallSid: ${participantCallSid}, CallStatus: ${parsedBody.CallStatus ?? 'N/A'}`);
    }

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
        void terminateOrphanedSIPCall(friendlyName, event === 'conference-end' ? 'conference_ended' : 'customer_left');
        if (event === 'conference-end') {
          sipConferenceLifecycle.clearConference(friendlyName);
        }
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

          // PUSH RECORDING URL TO TICKETING SYSTEM immediately
          // The ticketing sync runs every 5 min and marks calls as synced before the
          // recording is ready — so once synced, the recording URL is never re-sent.
          // Fix: push it directly here as soon as Twilio delivers the recording.
          (async () => {
            try {
              const callLog = await storage.getCallLog(callLogId);
              if (!callLog) {
                console.warn(`[RECORDING] ⚠️ Could not fetch call log ${callLogId} for ticketing push`);
                return;
              }
              // Only push if there is something to identify the ticket on the other end
              if (!callLog.ticketNumber && !callLog.callSid) {
                console.info(`[RECORDING] No ticketNumber/callSid on call log ${callLogId} — skipping ticketing push`);
                return;
              }
              const { ticketingApiClient } = await import('../server/services/ticketingApiClient');
              const result = await ticketingApiClient.updateTicketCallData({
                callSid: callLog.callSid || undefined,
                ticketNumber: callLog.ticketNumber || undefined,
                recordingUrl: recordingUrl,
              });
              if (result.success) {
                console.info(`[RECORDING] ✓ Recording URL pushed to ticketing system for ${callLog.ticketNumber || callLog.callSid}`);
              } else {
                console.warn(`[RECORDING] ⚠️ Ticketing push failed for ${callLog.ticketNumber || callLog.callSid}: ${result.error}`);
              }
            } catch (pushErr) {
              console.error('[RECORDING] ✗ Exception pushing recording URL to ticketing system:', pushErr);
            }
          })();
          
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
        const result = await callCostService.reconcileTwilioCallData(callLogId, twilioCallSid, { skipInsights: true });

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

    // Azul scheduling: backstop timeline flush for quorum-finalized calls
    // (no-op when the observeCall finally already flushed, or for other agents)
    if (callLogId) void flushAzulTimeline(callLogId);
    if (twilioCallSid) void flushAzulTimeline(twilioCallSid);

    // Same backstop for the loop guard's turn telemetry: this handler holds
    // only callLogId/twilioCallSid, so it resolves through the guard's alias
    // map. Whichever teardown arrives first writes; the other no-ops.
    if (callLogId) {
      void flushLoopTelemetry(callLogId, callLogId).then((s) => {
        if (!s && twilioCallSid) void flushLoopTelemetry(twilioCallSid, callLogId);
      });
    }
    
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
        
        // skipInsights: lifecycle coordinator fetches insights separately
        const reconcileResult = await callCostService.reconcileTwilioCallData(callLogId, effectiveTwilioCallSid, { skipInsights: true });

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
          scheduleDelayedTwilioReconciliation(callLogId, effectiveTwilioCallSid, [30000, 90000]);
        }
      } else {
        // No Twilio call SID - calculate OpenAI cost based on local duration
        await callCostService.recalculateOpenAICostFromDuration(callLogId);
      }
      
      // Grade the call (skip ghost/short calls to save LLM costs)
      let gradeResult: { qualityScore?: number; patientSentiment?: string; agentOutcome?: string } = {};
      if (transcript && transcript.length > 200 && (actualDuration ?? 0) > 15) {
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
      
      if (effectiveTwilioCallSid && (agentSlug === 'after-hours' || agentSlug === 'no-ivr' || agentSlug === 'answering-service' || agentSlug === 'azul-scheduling' || agentSlug === 'pcp') && hasTicket) {
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
  // SD Pilot: live tool timeline for an in-progress azul-scheduling call.
  // Accepts the OpenAI callId, the Twilio callSid, or the callLogId.
  app.get("/api/voice/azul/tool-timeline/:idOrSid", async (req, res) => {
    try {
      const events = getAzulTimeline(String(req.params.idOrSid || ''));
      if (!events) {
        return res.status(404).json({ events: [], live: false });
      }
      res.json({ events, live: true });
    } catch (error) {
      console.error('[AZUL-TIMELINE] endpoint error:', error);
      res.status(500).json({ error: 'Failed to get tool timeline' });
    }
  });

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

  // SIP call health monitor status endpoint (no auth required — read-only)
  app.get("/api/health/sip", (req, res) => {
    const { getLatestSipHealthStatus } = require('./services/sipHealthMonitor');
    const status = getLatestSipHealthStatus();
    const httpStatus = status.status === 'down' ? 503 : status.status === 'degraded' ? 200 : 200;
    res.status(httpStatus).json(status);
  });

  console.log('[VOICE AGENT] Routes configured');
}
