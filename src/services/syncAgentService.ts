import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import { storage } from '../../server/storage';
import { 
  AFTER_HOURS_DEPARTMENT_ID, 
  getTriageMapping,
  type TriageOutcome 
} from '../config/afterHoursTicketing';
import { getValidatedTicketIds } from '../config/answeringServiceTicketing';

// Categories that don't require staff callback (ticket created for records only)
const NO_CALLBACK_CATEGORIES: TriageOutcome[] = [
  'confirm_appointment',
];

export interface OpenTicketInfo {
  ticketNumber: string;
  createdAt: Date;
  reason: string;
  daysAgo: number;
}

export interface CallDataParams {
  callSid?: string;
  recordingUrl?: string;
  transcript?: string;
  callerPhone?: string;
  dialedNumber?: string;
  agentUsed?: string;
  callStartTime?: string;
  callEndTime?: string;
  callDurationSeconds?: number;
  humanHandoffOccurred?: boolean;
  qualityScore?: number;
  patientSentiment?: string;
  agentOutcome?: string;
}

export interface SyncAgentTicketParams {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  patientFirstName: string;
  patientMiddleInitial?: string;
  patientLastName: string;
  patientPhone: string;
  patientEmail?: string | null;
  preferredContactMethod?: 'phone' | 'text' | 'email' | null;
  lastProviderSeen?: string | null;
  locationOfLastVisit?: string | null;
  patientBirthMonth?: string | null;
  patientBirthDay?: string | null;
  patientBirthYear?: string | null;
  locationId?: number | null;
  providerId?: number | null;
  description: string;
  priority?: 'low' | 'normal' | 'medium' | 'high' | 'urgent' | null;
  subject?: string;
  callData?: CallDataParams | null;
}

export interface SyncAgentResponse {
  success: boolean;
  ticketNumber?: string;
  error?: string;
  message: string;
  // Lookup warning fields from external API (2026-01-13)
  lookupWarnings?: string[];
  providerMatched?: boolean;
  locationMatched?: boolean;
}

/**
 * Sync Agent Service - Background worker for external ticketing system
 * This is the "Sync Agent" logic that handles all ticketing API communication
 * Keeps the conversational agents (Greeter) free from API concerns
 */
export class SyncAgentService {
  static async createTicket(params: SyncAgentTicketParams): Promise<SyncAgentResponse> {
    console.info('[SYNC AGENT] Processing ticket creation:', {
      patient: `${params.patientFirstName} ${params.patientLastName}`,
      phone: params.patientPhone,
      departmentId: params.departmentId,
      priority: params.priority || 'medium',
      preferredContactMethod: params.preferredContactMethod,
      lastProviderSeen: params.lastProviderSeen,
      locationOfLastVisit: params.locationOfLastVisit,
      hasCallData: !!params.callData,
      callSid: params.callData?.callSid,
      hasRecording: !!params.callData?.recordingUrl,
      hasTranscript: !!params.callData?.transcript,
      callDuration: params.callData?.callDurationSeconds,
    });

    const callSid = params.callData?.callSid;
    if (callSid) {
      try {
        const claimResult = await storage.claimTicketCreation(callSid, 60000);
        
        if (claimResult.existingTicket) {
          console.info(`[SYNC AGENT] ⚠️  Ticket already exists for this call: ${claimResult.existingTicket} - skipping duplicate creation`);
          return {
            success: true,
            ticketNumber: claimResult.existingTicket,
            message: claimResult.existingTicket,
          };
        }
        
        if (!claimResult.claimed) {
          console.info(`[SYNC AGENT] ⚠️  Another process is creating ticket - waiting 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const recheckLog = await storage.getCallLogBySid(callSid);
          if (recheckLog?.ticketNumber) {
            console.info(`[SYNC AGENT] ✓ Ticket was created by another process: ${recheckLog.ticketNumber}`);
            return {
              success: true,
              ticketNumber: recheckLog.ticketNumber,
              message: recheckLog.ticketNumber,
            };
          }
          
          console.warn(`[SYNC AGENT] ⚠️  Lock held by another process - aborting to prevent duplicate`);
          return {
            success: false,
            error: 'Ticket creation in progress by another process',
            message: 'Another process is already creating a ticket for this call',
          };
        }
        
        console.info(`[SYNC AGENT] 🔒 Acquired atomic ticket creation lock for call ${callSid}`);
      } catch (err) {
        console.warn('[SYNC AGENT] Could not acquire ticket lock:', err);
      }
    }

    if (!params.preferredContactMethod) {
      console.warn('[SYNC AGENT] ⚠️  Missing preferredContactMethod - ticket system may not know how to contact patient');
    }
    if (!params.lastProviderSeen) {
      console.warn('[SYNC AGENT] ⚠️  Missing lastProviderSeen - ticket may not be routed to correct provider');
    }
    if (!params.locationOfLastVisit) {
      console.warn('[SYNC AGENT] ⚠️  Missing locationOfLastVisit - ticket may not be routed to correct office');
    }

    const { TicketOutboxService } = await import('./ticketOutboxService');

    let outboxId: string | undefined;
    try {
      const outboxResult = await TicketOutboxService.writeToOutbox(params, callSid || undefined);
      outboxId = outboxResult.outboxId;
      console.info(`[SYNC AGENT] ✓ Ticket payload persisted to outbox: ${outboxId}`);
    } catch (outboxErr) {
      console.error('[SYNC AGENT] ✗ Failed to write to outbox - falling back to direct API call:', outboxErr);
    }

    try {
      if (outboxId) {
        const sendResult = await TicketOutboxService.attemptSend(outboxId);

        if (sendResult.success && sendResult.ticketNumber) {
          console.info(`[SYNC AGENT] ✓ Ticket created via outbox: ${sendResult.ticketNumber}`);
          if (callSid) {
            try {
              await storage.releaseTicketCreationLock(callSid, sendResult.ticketNumber);
            } catch (err) {
              console.warn('[SYNC AGENT] ⚠️  Could not release lock:', err);
            }
          }
          return {
            success: true,
            ticketNumber: sendResult.ticketNumber,
            message: sendResult.ticketNumber,
          };
        }

        console.warn(`[SYNC AGENT] ⚠️  Immediate send failed (outbox ${outboxId}): ${sendResult.error} - background retry will handle it`);
        if (callSid) {
          try { await storage.releaseTicketCreationLock(callSid); } catch {}
        }
        return {
          success: true,
          ticketNumber: undefined,
          message: 'Your request has been recorded and will be processed shortly. A team member will follow up with you.',
        };
      }

      const validatedIds = getValidatedTicketIds(
        params.departmentId,
        params.requestTypeId,
        params.requestReasonId
      );

      let resolvedProviderId: number | undefined = undefined;
      let resolvedLocationId: number | undefined = undefined;
      
      if (params.lastProviderSeen || params.locationOfLastVisit) {
        const lookupResult = await ticketingApiClient.lookupProviderAndLocation({
          providerName: params.lastProviderSeen || undefined,
          locationName: params.locationOfLastVisit || undefined,
        });
        
        if (lookupResult.success) {
          if (lookupResult.providerId) resolvedProviderId = lookupResult.providerId;
          if (lookupResult.locationId) resolvedLocationId = lookupResult.locationId;
        }
      }

      const response = await ticketingApiClient.createTicket({
        departmentId: validatedIds.departmentId,
        requestTypeId: validatedIds.requestTypeId,
        requestReasonId: validatedIds.requestReasonId,
        patientFirstName: params.patientFirstName,
        patientLastName: params.patientLastName,
        patientPhone: params.patientPhone,
        patientEmail: params.patientEmail ?? undefined,
        preferredContactMethod: params.preferredContactMethod ?? undefined,
        lastProviderSeen: params.lastProviderSeen ?? undefined,
        locationOfLastVisit: params.locationOfLastVisit ?? undefined,
        patientBirthMonth: params.patientBirthMonth ?? undefined,
        patientBirthDay: params.patientBirthDay ?? undefined,
        patientBirthYear: params.patientBirthYear ?? undefined,
        locationId: resolvedLocationId ?? undefined,
        providerId: resolvedProviderId ?? undefined,
        description: params.description,
        priority: params.priority ?? 'medium',
        callData: params.callData ? {
          callSid: params.callData.callSid,
          recordingUrl: params.callData.recordingUrl,
          transcript: params.callData.transcript,
          callerPhone: params.callData.callerPhone,
          dialedNumber: params.callData.dialedNumber,
          agentUsed: params.callData.agentUsed,
          callStartTime: params.callData.callStartTime,
          callEndTime: params.callData.callEndTime,
          callDurationSeconds: params.callData.callDurationSeconds,
          humanHandoffOccurred: params.callData.humanHandoffOccurred,
          qualityScore: params.callData.qualityScore,
          patientSentiment: params.callData.patientSentiment,
          agentOutcome: params.callData.agentOutcome,
        } : undefined,
      });

      if (response.success && response.ticketNumber) {
        console.info(`[SYNC AGENT] ✓ Ticket created (direct fallback): ${response.ticketNumber}`);
        if (callSid) {
          try {
            await storage.releaseTicketCreationLock(callSid, response.ticketNumber);
          } catch (err) {
            console.warn('[SYNC AGENT] ⚠️  Could not release lock:', err);
          }
        }
        return {
          success: true,
          ticketNumber: response.ticketNumber,
          message: response.ticketNumber,
          lookupWarnings: response.lookupWarnings,
          providerMatched: response.providerMatched,
          locationMatched: response.locationMatched,
        };
      }
      
      console.error('[SYNC AGENT] ✗ Ticket creation failed:', response.error);
      if (callSid) {
        await storage.releaseTicketCreationLock(callSid);
      }
      return {
        success: false,
        error: response.error || 'Unknown error from ticketing API',
        message: response.error || 'Unknown error from ticketing API',
      };
    } catch (error) {
      console.error('[SYNC AGENT] ✗ Unexpected error:', error);
      if (callSid) {
        try { await storage.releaseTicketCreationLock(callSid); } catch {}
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (outboxId) {
        console.info(`[SYNC AGENT] ✓ Data safe in outbox ${outboxId} - background retry will deliver`);
        return {
          success: true,
          ticketNumber: undefined,
          message: 'Your request has been recorded and will be processed shortly. A team member will follow up with you.',
        };
      }
      return {
        success: false,
        error: errorMessage,
        message: errorMessage,
      };
    }
  }

  /**
   * Create ticket from raw agent input - handles all business logic:
   * - Required field validation
   * - Phone number normalization
   * - Triage category → request ID mapping
   * - Description construction
   * 
   * This keeps the agent tool simple (just pass raw values) and centralizes business logic here.
   */
  static async createTicketFromAgentInput(params: {
    firstName: string;
    middleInitial?: string;
    lastName: string;
    birthMonth: string;
    birthDay: string;
    birthYear: string;
    callbackNumber: string;
    requestCategory: TriageOutcome;
    requestSummary: string;
    preferredContact?: 'phone' | 'text' | 'email' | null;
    email?: string | null;
    doctorName?: string | null;
    location?: string | null;
    appointmentTime?: string | null;
    departmentId?: number;
    requestTypeId?: number;
    requestReasonId?: number;
    locationId?: number;
    providerId?: number;
    priority?: 'low' | 'normal' | 'medium' | 'high' | 'urgent';
    subject?: string;
    callData?: {
      callSid?: string;
      callerPhone?: string;
      dialedNumber?: string;
      agentUsed?: string;
    };
  }): Promise<{
    success: boolean;
    ticketNumber?: string;
    validationErrors?: string[];
    error?: string;
  }> {
    console.log('[SYNC AGENT] createTicketFromAgentInput called:', {
      name: `${params.firstName} ${params.lastName}`,
      dob: `${params.birthMonth}/${params.birthDay}/${params.birthYear}`,
      phone: params.callbackNumber,
      category: params.requestCategory,
    });

    // 1. VALIDATE REQUIRED FIELDS
    const errors: string[] = [];
    if (!params.firstName || params.firstName.trim().length < 2) {
      errors.push('first name');
    }
    if (!params.lastName || params.lastName.trim().length < 2) {
      errors.push('last name');
    }
    if (!params.birthMonth || !params.birthDay || !params.birthYear) {
      errors.push('complete date of birth');
    }
    
    // 2. NORMALIZE PHONE NUMBER - with fallback to callerPhone for partial numbers
    let phoneDigits = params.callbackNumber.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      console.warn(`[SYNC AGENT] ⚠️  Partial phone number detected: "${params.callbackNumber}" (${phoneDigits.length} digits)`);
      // Try caller phone as fallback
      if (params.callData?.callerPhone) {
        const callerDigits = params.callData.callerPhone.replace(/\D/g, '');
        if (callerDigits.length >= 10) {
          console.info(`[SYNC AGENT] ✓ Using callerPhone fallback: ${params.callData.callerPhone}`);
          phoneDigits = callerDigits;
        } else {
          console.error(`[SYNC AGENT] ✗ CallerPhone also invalid: ${params.callData.callerPhone}`);
          errors.push('callback phone number (need full 10-digit number)');
        }
      } else {
        console.error(`[SYNC AGENT] ✗ No callerPhone available for fallback`);
        errors.push('callback phone number (need full 10-digit number)');
      }
    } else {
      console.info(`[SYNC AGENT] ✓ Valid phone number: ${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`);
    }
    
    if (!params.requestSummary || params.requestSummary.length < 5) {
      errors.push('reason for calling');
    }

    if (errors.length > 0) {
      console.log('[SYNC AGENT] VALIDATION FAILED:', errors);
      return { success: false, validationErrors: errors };
    }

    // Format phone to E.164
    let formattedPhone = phoneDigits;
    if (formattedPhone.length === 10) {
      formattedPhone = `+1${formattedPhone}`;
    } else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) {
      formattedPhone = `+${formattedPhone}`;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = `+${formattedPhone}`;
    }

    // 3. MAP TRIAGE CATEGORY TO REQUEST IDs (use explicit IDs if provided, otherwise fallback to triage mapping)
    const triageMapping = getTriageMapping(params.requestCategory);
    const finalRequestTypeId = params.requestTypeId || triageMapping.requestTypeId;
    const finalRequestReasonId = params.requestReasonId || triageMapping.requestReasonId;
    const finalPriority = params.priority || triageMapping.priority;

    // 4. BUILD DESCRIPTION - use subject if available
    const patientFullName = params.middleInitial 
      ? `${params.firstName} ${params.middleInitial}. ${params.lastName}`
      : `${params.firstName} ${params.lastName}`;
    
    const description = 
      `${params.subject ? `Subject: ${params.subject}\n\n` : ''}` +
      `CALLBACK REQUEST\n` +
      `Patient: ${patientFullName}\n` +
      `DOB: ${params.birthMonth}/${params.birthDay}/${params.birthYear}\n` +
      `Phone: ${formattedPhone}\n` +
      `Preferred Contact: ${params.preferredContact || 'phone'}\n` +
      `${params.email ? `Email: ${params.email}\n` : ''}` +
      `${params.doctorName ? `Doctor: ${params.doctorName}\n` : ''}` +
      `${params.location ? `Location: ${params.location}\n` : ''}` +
      `${params.appointmentTime ? `Appointment Time: ${params.appointmentTime}\n` : ''}` +
      `\nRequest: ${params.requestSummary}`;

    // 5. CREATE TICKET VIA EXISTING METHOD
    return this.createTicket({
      departmentId: params.departmentId || AFTER_HOURS_DEPARTMENT_ID,
      requestTypeId: finalRequestTypeId,
      requestReasonId: finalRequestReasonId,
      patientFirstName: params.firstName.trim(),
      patientMiddleInitial: params.middleInitial?.trim(),
      patientLastName: params.lastName.trim(),
      patientPhone: formattedPhone,
      patientEmail: params.email || undefined,
      preferredContactMethod: params.preferredContact || undefined,
      lastProviderSeen: params.doctorName || undefined,
      locationOfLastVisit: params.location || undefined,
      locationId: params.locationId,
      providerId: params.providerId,
      patientBirthMonth: params.birthMonth,
      patientBirthDay: params.birthDay,
      patientBirthYear: params.birthYear,
      description: description,
      priority: finalPriority,
      subject: params.subject,
      callData: params.callData ? {
        callSid: params.callData.callSid,
        callerPhone: params.callData.callerPhone,
        dialedNumber: params.callData.dialedNumber,
        agentUsed: params.callData.agentUsed,
      } : undefined,
    });
  }

  /**
   * Check for open tickets by caller phone number
   * Returns list of recent open tickets for the caller (tickets without ticketingSyncedAt)
   */
  static async checkOpenTickets(callerPhone: string): Promise<OpenTicketInfo[]> {
    if (!callerPhone) {
      return [];
    }

    try {
      // Normalize phone for lookup
      const digits = callerPhone.replace(/\D/g, '');
      const normalized = digits.length === 10 ? `+1${digits}` : 
                         digits.length === 11 && digits.startsWith('1') ? `+${digits}` : 
                         callerPhone;

      console.log(`[SYNC AGENT] Checking open tickets for: ${normalized.slice(-4)}`);

      // Get recent calls with tickets that haven't been synced (indicating open status)
      const callHistory = await storage.getCallHistoryByPhone(normalized, 10);
      
      const openTickets: OpenTicketInfo[] = [];
      const now = new Date();
      
      for (const call of callHistory) {
        // A ticket is "open" if it exists but hasn't been fully synced/closed
        if (call.ticketNumber && !call.ticketingSyncedAt) {
          const createdAt = call.createdAt ? new Date(call.createdAt) : now;
          const daysAgo = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
          
          // Only include tickets from last 7 days
          if (daysAgo <= 7) {
            openTickets.push({
              ticketNumber: call.ticketNumber,
              createdAt,
              reason: call.summary || 'Unknown reason',
              daysAgo,
            });
          }
        }
      }

      console.log(`[SYNC AGENT] Found ${openTickets.length} open ticket(s) for caller`);
      return openTickets;
    } catch (error) {
      console.error('[SYNC AGENT] Error checking open tickets:', error);
      return [];
    }
  }

  /**
   * Determine if a ticket category requires staff callback
   */
  static requiresCallback(category: TriageOutcome): boolean {
    return !NO_CALLBACK_CATEGORIES.includes(category);
  }

  /**
   * NEW SIMPLIFIED TICKET SUBMISSION
   * Accepts conversational data directly - all mapping done by external API
   * This is the preferred method for voice agents - more reliable than legacy createTicket
   */
  static async submitSimplifiedTicket(params: {
    patientFullName: string;
    patientDOB: string;
    reasonForCalling: string;
    preferredContactMethod: 'phone' | 'sms' | 'email';
    patientPhone?: string;
    patientEmail?: string;
    lastProviderSeen?: string;
    locationOfLastVisit?: string;
    additionalDetails?: string;
    callSid?: string;
    callerPhone?: string;
    dialedNumber?: string;
    agentUsed?: string;
    callStartTime?: string;
    callDurationSeconds?: number;
    transcript?: string;
  }): Promise<SyncAgentResponse> {
    const { callSid } = params;
    
    console.info('[SYNC AGENT] Processing simplified ticket submission:', {
      patientName: params.patientFullName,
      hasPhone: !!params.patientPhone,
      preferredContact: params.preferredContactMethod,
      lastProvider: params.lastProviderSeen,
      lastLocation: params.locationOfLastVisit,
      callSid,
    });

    // DEDUPLICATION: Atomic lock to prevent race conditions
    if (callSid) {
      try {
        const claimResult = await storage.claimTicketCreation(callSid, 60000);
        
        if (claimResult.existingTicket) {
          console.info(`[SYNC AGENT] ⚠️  Ticket already exists for this call: ${claimResult.existingTicket}`);
          return {
            success: true,
            ticketNumber: claimResult.existingTicket,
            message: claimResult.existingTicket,
          };
        }
        
        if (!claimResult.claimed) {
          // Check if call log even exists - if not, proceed (no race condition possible)
          const callLog = await storage.getCallLogBySid(callSid);
          if (!callLog) {
            console.info(`[SYNC AGENT] No call log for ${callSid} - proceeding without lock (no race condition)`);
            // Fall through to ticket creation - no log means no race condition
          } else {
            // Call log exists but we couldn't get lock - another process is working on it
            console.info(`[SYNC AGENT] ⚠️  Another process is creating ticket - waiting 3s...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const recheckLog = await storage.getCallLogBySid(callSid);
            if (recheckLog?.ticketNumber) {
              console.info(`[SYNC AGENT] ✓ Ticket was created by another process: ${recheckLog.ticketNumber}`);
              return {
                success: true,
                ticketNumber: recheckLog.ticketNumber,
                message: recheckLog.ticketNumber,
              };
            }
            
            // Another process has the lock but no ticket yet - abort to prevent duplicate
            // The external API has idempotencyKey as backup, but local lock is primary defense
            console.warn(`[SYNC AGENT] ⚠️  Lock not obtained and no ticket found after wait - aborting to prevent duplicate`);
            return {
              success: false,
              error: 'Concurrent ticket creation in progress',
              message: 'Please wait a moment and try again.',
            };
          }
        }
      } catch (error) {
        console.error('[SYNC AGENT] Lock acquisition error (proceeding anyway):', error);
      }
    }

    // Phone validation - use callerPhone as fallback if patientPhone is partial (< 10 digits)
    let validatedPhone = params.patientPhone;
    if (params.patientPhone) {
      const phoneDigits = params.patientPhone.replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        console.warn(`[SYNC AGENT] ⚠️  Partial patientPhone detected: "${params.patientPhone}" (${phoneDigits.length} digits)`);
        if (params.callerPhone) {
          const callerDigits = params.callerPhone.replace(/\D/g, '');
          if (callerDigits.length >= 10) {
            validatedPhone = params.callerPhone;
            console.info(`[SYNC AGENT] ✓ Using callerPhone fallback for partial number`);
          }
        }
      }
    } else if (params.callerPhone) {
      // No patientPhone provided, use callerPhone
      validatedPhone = params.callerPhone;
      console.info(`[SYNC AGENT] ✓ Using callerPhone as patientPhone not provided`);
    }

    try {
      // Use the new simplified endpoint
      const response = await ticketingApiClient.submitTicket({
        patientFullName: params.patientFullName,
        patientDOB: params.patientDOB,
        reasonForCalling: params.reasonForCalling,
        preferredContactMethod: params.preferredContactMethod,
        patientPhone: validatedPhone,
        patientEmail: params.patientEmail,
        lastProviderSeen: params.lastProviderSeen,
        locationOfLastVisit: params.locationOfLastVisit,
        additionalDetails: params.additionalDetails,
        callData: callSid ? {
          callSid,
          callerPhone: params.callerPhone,
          dialedNumber: params.dialedNumber,
          agentUsed: params.agentUsed,
          callStartTime: params.callStartTime,
          callDurationSeconds: params.callDurationSeconds,
          transcript: params.transcript,
        } : undefined,
        idempotencyKey: callSid ? `call-${callSid}` : undefined,
      });

      if (response.success && response.ticketNumber) {
        console.info(`[SYNC AGENT] ✓ Ticket created via simplified endpoint: ${response.ticketNumber}`);
        
        // Update local database with ticket number
        if (callSid) {
          try {
            const callLog = await storage.getCallLogBySid(callSid);
            if (callLog) {
              await storage.updateCallLog(callLog.id, {
                ticketNumber: response.ticketNumber,
              });
            }
          } catch (e) {
            console.warn(`[SYNC AGENT] Could not update local call log for ${callSid}:`, e);
          }
        }

        return {
          success: true,
          ticketNumber: response.ticketNumber,
          message: response.ticketNumber,
          lookupWarnings: response.lookupWarnings,
          providerMatched: response.providerMatched,
          locationMatched: response.locationMatched,
        };
      } else {
        const errorMsg = response.error || 'Unknown error creating ticket';
        console.error(`[SYNC AGENT] ✗ Simplified ticket creation failed: ${errorMsg}`);
        
        // If missing fields, return helpful message for agent
        if (response.missingFields && response.missingFields.length > 0) {
          return {
            success: false,
            error: `Missing required information: ${response.missingFields.join(', ')}`,
            message: `I need to collect more information. Please provide: ${response.missingFields.join(', ')}`,
          };
        }
        
        return {
          success: false,
          error: errorMsg,
          message: 'There was a problem creating your request. Please try again.',
        };
      }
    } catch (error) {
      console.error('[SYNC AGENT] ✗ Simplified ticket submission exception:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        message: 'There was a technical issue. Please try again.',
      };
    }
  }
}
