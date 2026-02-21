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

// Session options for consistent configuration
// CRITICAL: input_audio_transcription.language sets API-level language enforcement
const sessionOptions: Partial<RealtimeSessionOptions> = {
  model: 'gpt-realtime',
  config: {
    audio: {
      output: {
        voice: 'sage',
      },
      input: {
        turnDetection: {
          type: 'semantic_vad',
          eagerness: 'medium', // Balanced - gives callers time to finish speaking
          interruptResponse: true,
        },
      },
    },
    // CRITICAL: Enable audio transcription with language hint
    // Default to English - sessions override this with dynamic language based on IVR
    input_audio_transcription: {
      model: 'gpt-4o-transcribe',
      language: 'en', // Default language for initial call acceptance
    },
  } as any, // Type assertion for snake_case wire protocol fields
  outputGuardrails: medicalSafetyGuardrails,
};

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
    await twilioClient.conferences(conferenceName).participants.create({
      from: callerID,
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

// Observe and manage call session
async function observeCall(callId: string): Promise<void> {
  // Get call details from mappings
  const conferenceName = callIDtoConferenceNameMapping[callId];
  const callerNumber = conferenceName ? ConferenceNametoCallerIDMapping[conferenceName] : undefined;
  const calledNumber = conferenceName ? ConferenceNametoCalledNumberMapping[conferenceName] : undefined;

  // Transcript accumulation
  const transcriptParts: string[] = [];
  
  // GHOST CALL FIX: Only create call log if we have valid caller data
  const hasValidCallerData = !!callerNumber && !!conferenceName;
  
  // Create initial call log in database (only if we have valid data)
  let dbCallLog;
  if (hasValidCallerData) {
    try {
      dbCallLog = await storage.createCallLog({
        callSid: conferenceName,
        agentId: 'after-hours',
        direction: 'inbound',
        from: callerNumber,
        to: calledNumber || 'unknown',
        status: 'initiated',
        startTime: new Date(),
      });
      callIdToDbCallLogId.set(callId, dbCallLog.id);
      console.log(`[DATABASE] ✓ Created call log: ${dbCallLog.id}`);
    } catch (error) {
      console.error('[DATABASE] ✗ Error creating call log:', error);
    }
  } else {
    console.warn(`[DATABASE] Skipping call log creation - missing caller data:`, {
      hasConferenceName: !!conferenceName,
      hasCallerNumber: !!callerNumber,
      callId: callId.slice(-8),
    });
  }

  // Import the factory function to create properly wired agent
  const { createAfterHoursAgent } = await import('./agents/afterHoursAgent');
  
  // Create agent with both callbacks wired to this specific callId
  // Pass caller phone from Twilio for automatic caller ID recognition
  // Note: createAfterHoursAgent is now async to fetch patient schedule context
  const sessionAgent = await createAfterHoursAgent(
    async () => {
      await addHumanAgent(callId);
    },
    createRecordPatientInfoCallback(callId),
    {
      callerPhone: callerNumber,
      dialedNumber: calledNumber,
      callSid: conferenceName || callId,
    }
  );

  // Create session with English language transcription (default for after-hours)
  // CRITICAL: input_audio_transcription.language tells OpenAI what language to expect
  const session = new RealtimeSession(sessionAgent, {
    transport: new OpenAIRealtimeSIP(),
    ...sessionOptions,
    config: {
      ...sessionOptions.config,
      input_audio_transcription: {
        model: 'gpt-4o-transcribe',
        language: 'en', // Default to English for after-hours
      },
    },
  } as any);

  // Event listeners
  session.on('history_added', (rawItem: unknown) => {
    logHistoryItem(rawItem);
    const item = rawItem as any;
    
    // Accumulate transcript
    if (item.type === 'message') {
      if (item.role === 'user') {
        for (const content of item.content) {
          if (content.type === 'input_text' && content.text) {
            transcriptParts.push(`Caller: ${content.text}`);
          } else if (content.type === 'input_audio' && content.transcript) {
            transcriptParts.push(`Caller: ${content.transcript}`);
          }
        }
      } else if (item.role === 'assistant') {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            transcriptParts.push(`Agent: ${content.text}`);
          } else if (content.type === 'output_audio' && content.transcript) {
            transcriptParts.push(`Agent: ${content.transcript}`);
          }
        }
      }
    }
  });
  
  session.on('agent_handoff', (_context, fromAgent, toAgent) => {
    console.info(`[HANDOFF] Agent transition: ${fromAgent.name} → ${toAgent.name}`);
  });

  session.on('error', (event) => {
    console.error('[SESSION ERROR]', event.error);
  });

  const callStartTime = new Date();

  try {
    await session.connect({ apiKey: OPENAI_API_KEY!, callId });
    console.info(`[SESSION] Connected to realtime call ${callId}`);

    // Update status to in_progress
    if (dbCallLog) {
      await storage.updateCallLog(dbCallLog.id, { status: 'in_progress' });
    }

    // Send welcome greeting
    session.transport.sendEvent({
      type: 'response.create',
      response: {
        instructions: `Say exactly '${WELCOME_GREETING}' now before continuing the conversation.`,
      },
    });

    // Wait for disconnect
    await new Promise<void>((resolve) => {
      const handleDisconnect = () => {
        session.transport.off('disconnected', handleDisconnect);
        resolve();
      };
      session.transport.on('disconnected', handleDisconnect);
    });
  } catch (error) {
    console.error(`[SESSION] Error while observing call ${callId}:`, error);
    if (dbCallLog) {
      await storage.updateCallLog(dbCallLog.id, { status: 'failed' });
    }
  } finally {
    session.close();
    console.info(`[CALL] Call ${callId} ended`);
    
    // Calculate call duration
    const callEndTime = new Date();
    const durationSeconds = Math.floor((callEndTime.getTime() - callStartTime.getTime()) / 1000);
    const fullTranscript = transcriptParts.join('\n');
    
    // Update final call log
    if (dbCallLog) {
      try {
        await storage.updateCallLog(dbCallLog.id, {
          status: 'completed',
          endTime: callEndTime,
          duration: durationSeconds,
          transcript: fullTranscript,
        });
        console.log('[DATABASE] ✓ Updated call log with final details');
        
        // Push call data to ticketing system (async, don't block)
        // GUARD: Only try to update if:
        // 1. We have a valid call identifier
        // 2. A ticket was actually created during the call (has ticket number)
        // 3. The call has a meaningful transcript
        const callSidForTicketing = conferenceName || callId;
        const hasValidTicket = dbCallLog.ticketNumber && dbCallLog.ticketNumber.trim().length > 0;
        const hasValidTranscript = fullTranscript && fullTranscript.length > 50;
        
        if (hasValidTicket && hasValidTranscript) {
          ticketingApiClient.updateTicketCallData({
            callSid: callSidForTicketing,
            transcript: fullTranscript,
            callerPhone: callerNumber,
            dialedNumber: calledNumber,
            callStartTime: callStartTime.toISOString(),
            callEndTime: callEndTime.toISOString(),
            callDurationSeconds: durationSeconds,
            humanHandoffOccurred: dbCallLog.transferredToHuman || false,
          }).then(result => {
            if (result.success) {
              console.log(`[TICKETING] ✓ Call data pushed to ticketing system for ${callSidForTicketing}`);
            } else {
              console.warn(`[TICKETING] ⚠️ Failed to push call data: ${result.error}`);
            }
          }).catch(error => {
            console.warn(`[TICKETING] ⚠️ Error pushing call data:`, error);
          });
        } else {
          console.info(`[TICKETING] Skipping ticketing update - no ticket created (ticketNumber: ${dbCallLog.ticketNumber || 'none'}, transcriptLen: ${fullTranscript?.length || 0})`);
        }
        
        // Create callback queue item for non-STAT calls (no human transfer)
        const wasTransferred = callIdToDbCallLogId.get(callId) && dbCallLog.transferredToHuman;
        const patientInfo = patientInfoMap.get(callId);
        
        if (!wasTransferred) {
          if (patientInfo) {
            // Use structured data (preferred) - but validate we have BOTH name AND phone
            if (patientInfo.name && patientInfo.phone && patientInfo.name.trim() && patientInfo.phone.trim()) {
              try {
                const callbackItem = await storage.createCallbackQueueItem({
                  patientName: patientInfo.name,
                  patientPhone: patientInfo.phone,
                  patientDob: patientInfo.dob || null,
                  patientEmail: patientInfo.email || null,
                  reason: patientInfo.reason,
                  priority: patientInfo.priority,
                  notes: `Transcript:\n${fullTranscript.substring(0, 500)}${fullTranscript.length > 500 ? '...' : ''}`,
                  callLogId: dbCallLog.id,
                  status: 'pending',
                });
                console.log(`[CALLBACK QUEUE] ✓ Created from structured data: ${callbackItem.id} (DOB: ${patientInfo.dob ? 'yes' : 'no'}, Email: ${patientInfo.email ? 'yes' : 'no'})`);
                patientInfoMap.delete(callId); // Clean up
              } catch (error) {
                console.error('[DATABASE] ✗ Error creating callback queue item:', error);
              }
            } else {
              console.warn('[CALLBACK QUEUE] ⚠️ Structured data incomplete (missing name or phone), skipping callback creation');
              patientInfoMap.delete(callId);
            }
          } else if (fullTranscript.length > 100) {
            // Fallback to regex extraction for edge cases
            const nameMatch = fullTranscript.match(/(?:my name is|i'm|this is)\s+([a-zA-Z\s]+)/i);
            const reasonMatch = fullTranscript.match(/(?:calling about|reason|problem with)\s+([^.!?]+)/i);
            const extractedName = nameMatch?.[1]?.trim();
            const extractedPhone = callerNumber;
            
            // Normalize callerNumber to E.164 and skip if anonymous/unknown
            const e164Regex = /^\+[1-9]\d{1,14}$/;
            const isValidE164 = extractedPhone && e164Regex.test(extractedPhone);
            
            // HARD REQUIREMENT: Only create callback if we have BOTH valid name AND dialable E.164 phone
            if (extractedName && isValidE164) {
              try {
                const callbackItem = await storage.createCallbackQueueItem({
                  patientName: extractedName,
                  patientPhone: extractedPhone,
                  reason: reasonMatch?.[1]?.trim() || 'See transcript',
                  priority: 'normal',
                  notes: `[FALLBACK] Transcript:\n${fullTranscript.substring(0, 500)}${fullTranscript.length > 500 ? '...' : ''}`,
                  callLogId: dbCallLog.id,
                  status: 'pending',
                });
                console.log(`[CALLBACK QUEUE] ✓ Created from regex fallback: ${callbackItem.id}`);
              } catch (error) {
                console.error('[DATABASE] ✗ Error creating callback queue item from fallback:', error);
              }
            } else {
              console.warn('[CALLBACK QUEUE] ⚠️ Insufficient patient data (missing name or phone), skipping callback creation');
            }
          } else {
            console.warn('[CALLBACK QUEUE] ⚠️ No patient info or transcript available, skipping callback creation');
          }
          
          // Clean up
          patientInfoMap.delete(callId);
        } else {
          console.log('[CALLBACK QUEUE] Skipping - call was transferred to human agent');
          patientInfoMap.delete(callId);
        }
      } catch (error) {
        console.error('[DATABASE] ✗ Error updating final call log:', error);
      }
    }
    
    // Clean up mappings
    callIdToDbCallLogId.delete(callId);
  }
}

// Twilio incoming call webhook
app.post("/incoming-call", async (req: Request, res: Response) => {
  try {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

    const conferenceName = `${parsedBody.CallSid}`;
    const callerNumber = parsedBody.From;
    const calledNumber = parsedBody.To;

    console.log('\n========================================');
    console.log(`[INCOMING CALL] ${new Date().toISOString()}`);
    console.log(`   From: ${callerNumber}`);
    console.log(`   To: ${calledNumber}`);
    console.log(`   Call SID: ${parsedBody.CallSid}`);
    console.log('========================================\n');

    // Store mappings
    ConferenceNametoCallerIDMapping[conferenceName] = callerNumber;
    ConferenceNametoCalledNumberMapping[conferenceName] = calledNumber;
    ConferenceNametoCallTokenMapping[conferenceName] = parsedBody.CallToken;

    // Return TwiML to create conference with recording enabled
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                        <Response>
                            <Dial>
                                <Conference 
                                    startConferenceOnEnter="true"
                                    participantLabel="customer"
                                    endConferenceOnExit="true"
                                    record="record-from-start"
                                    recordingStatusCallback="https://${DOMAIN}/recording-status"
                                    recordingStatusCallbackEvent="completed"
                                    statusCallback="https://${DOMAIN}/conference-events"
                                    statusCallbackEvent="join"
                                >
                                    ${conferenceName}
                                </Conference>
                            </Dial>
                        </Response>`;

    res.type('text/xml').send(twimlResponse);

    // Create virtual agent participant
    async function createParticipant() {
      try {
        console.log('[TWILIO] Creating virtual agent participant in conference...');
        await twilioClient.conferences(conferenceName).participants.create({
          from: parsedBody.From,
          label: "virtual agent",
          to: `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}`,
          earlyMedia: false,
          callToken: parsedBody.CallToken,
          conferenceStatusCallback: `https://${DOMAIN}/conference-events`,
          conferenceStatusCallbackEvent: ['start', 'end', 'join', 'leave']
        });
        console.log('[TWILIO] ✓ Virtual agent participant created successfully\n');
      } catch (error) {
        console.error('[TWILIO] ✗ Error creating participant:', error);
      }
    }
    createParticipant();

  } catch (error) {
    console.error("Error handling incoming call:", error);
    res.status(500).type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>We're sorry, there was an error processing your call. Please try again later.</Say>
      </Response>`);
  }
});

// Recording status callback - saves recording URL to database
app.post("/recording-status", async (req: Request, res: Response) => {
  try {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

    const recordingUrl = parsedBody.RecordingUrl;
    const conferenceSid = parsedBody.ConferenceSid;
    const recordingStatus = parsedBody.RecordingStatus;
    
    console.log(`[RECORDING] Conference ${conferenceSid} recording ${recordingStatus}: ${recordingUrl}`);
    
    // Save recording URL to database when completed
    if (recordingUrl && recordingStatus === 'completed' && conferenceSid) {
      try {
        const callLogId = conferenceSidToDbCallLogId.get(conferenceSid);
        
        if (callLogId) {
          const { DatabaseStorage } = await import('../server/storage');
          const storage = new DatabaseStorage();
          
          await storage.updateCallLog(callLogId, {
            recordingUrl: recordingUrl,
          });
          
          console.log(`[RECORDING] ✓ Saved recording URL to call log ${callLogId}`);
          
          // Clean up mapping
          conferenceSidToDbCallLogId.delete(conferenceSid);
        } else {
          console.warn(`[RECORDING] ⚠️ No call log ID found for conference SID ${conferenceSid}`);
        }
      } catch (error) {
        console.error('[RECORDING] ✗ Error saving recording URL:', error);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('[RECORDING] Error handling recording status:', error);
    res.status(500).send('Error');
  }
});

// Conference events webhook
app.post("/conference-events", async (req: Request, res: Response) => {
  try {
    const rawBody = req.body.toString("utf8");
    const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

    // Store conference SID to call log ID mapping for recording URL persistence
    const conferenceSid = parsedBody.ConferenceSid;
    const friendlyName = parsedBody.FriendlyName; // This is the conferenceName (CallSid)
    
    if (conferenceSid && friendlyName) {
      // Find the call log ID by the conference name (which is the CallSid used to create the log)
      const dbCallLogId = Array.from(callIdToDbCallLogId.entries()).find(([openAiCallId, _]) => {
        return callIDtoConferenceNameMapping[openAiCallId] === friendlyName;
      })?.[1];
      
      if (dbCallLogId) {
        conferenceSidToDbCallLogId.set(conferenceSid, dbCallLogId);
        console.log(`[CONFERENCE] Mapped conference SID ${conferenceSid} to call log ${dbCallLogId}`);
      }
    }

    // When human agent joins, disconnect virtual agent
    if (parsedBody.ParticipantLabel === 'human agent' && parsedBody.StatusCallbackEvent === 'participant-join') {
      async function findVirtualAgentandDisconnect() {
        try {
          const participants = await twilioClient
            .conferences(parsedBody.ConferenceSid)
            .participants.list({ limit: 20 });

          for (const participant of participants) {
            if (participant.label === 'virtual agent') {
              await twilioClient.calls(participant.callSid).update({ status: 'completed' });
              console.log('[HANDOFF] Virtual agent call ended');
            }
          }
        } catch (error) {
          console.error("[HANDOFF] Error disconnecting virtual agent:", error);
        }
      }
      findVirtualAgentandDisconnect();
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error handling conference event:", error);
    res.sendStatus(500);
  }
});

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
