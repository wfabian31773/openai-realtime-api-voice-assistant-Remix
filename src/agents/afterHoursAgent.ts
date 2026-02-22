// REMOVED: RECOMMENDED_PROMPT_PREFIX conflicts with proactive greeting - it tells agent to "wait for user input"
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { medicalSafetyGuardrails } from '../guardrails/medicalSafety';
import { scheduleLookupService, PatientScheduleContext } from '../services/scheduleLookupService';
import { 
  AFTER_HOURS_DEPARTMENT_ID, 
  TRIAGE_OUTCOME_MAPPINGS,
  type TriageOutcome 
} from '../config/afterHoursTicketing';
import { buildPracticeKnowledgePrompt } from '../config/azulVisionKnowledge';
import { getNextBusinessDayContext } from '../utils/timeAware';

export function getUrgentTriageGreeting(): string {
  return "Hello, thank you for calling Azul Vision, how may I help you today?";
}

export const WELCOME_GREETING = getUrgentTriageGreeting();

function buildSystemPrompt(callerPhone?: string, scheduleContext?: PatientScheduleContext): string {
  const nextBizDay = getNextBusinessDayContext();
  
  let callerContext: string;
  if (callerPhone) {
    callerContext = `The caller's phone number is ${callerPhone}. Use this as the default callback number.`;
  } else {
    callerContext = `Caller ID is not available. You'll need to ask for their callback number.`;
  }

  let scheduleContextPrompt = '';
  if (scheduleContext?.patientFound) {
    const parts: string[] = ['\n===== POSSIBLE PATIENT CONTEXT (USE CAREFULLY) ====='];
    parts.push('You may have patient context for this caller.');
    parts.push('ONLY reference this after verifying identity (name + DOB).');
    parts.push('NEVER explain how you obtained this information.');
    
    if (scheduleContext.upcomingAppointments.length > 0) {
      parts.push('\nUPCOMING APPOINTMENTS (REFERENCE ONLY AFTER IDENTITY VERIFIED):');
      scheduleContext.upcomingAppointments.forEach((apt, i) => {
        parts.push(`  ${i + 1}. ${apt.date} (${apt.timeOfDay}) at ${apt.location} with ${apt.provider}`);
      });
    }
    
    if (scheduleContext.lastLocationSeen) {
      parts.push(`Last location seen: ${scheduleContext.lastLocationSeen}`);
    }
    if (scheduleContext.lastProviderSeen) {
      parts.push(`Last provider seen: ${scheduleContext.lastProviderSeen}`);
    }
    
    parts.push('\nVerify identity FIRST, then use context to personalize.');
    scheduleContextPrompt = parts.join('\n');
  }

  return `You are the urgent after-hours triage agent for Azul Vision Eye Center.
${scheduleContextPrompt}

===== IMPORTANT: GREETING BEHAVIOR =====
The system will send a response.create with your greeting. If the caller has already been greeted, simply wait for them to respond. Your first words after the greeting should be a response to what THEY say.

===== YOUR PURPOSE =====

You assess whether the caller's issue is truly URGENT (requires human transfer) or NOT URGENT (can be handled with a ticket for next business day callback).

You make this determination BASED STRICTLY ON THE PATIENT'S DETAILS - no coaching, no leading questions, no suggesting symptoms.

===== CONVERSATION FLOW =====

1. LISTEN TO THEIR REASON:
   - The caller will state why they are calling
   - Listen carefully before asking follow-up questions

2. COLLECT IDENTITY (after understanding their reason):
   - "May I have your first and last name?"
   - If they only give first name, ask: "And your last name?"
   - "And your date of birth?"

3. ASK ABOUT THEIR ISSUE:
   - "What's going on that brought you to call tonight?"
   - LISTEN carefully to what they describe
   - DO NOT coach or suggest symptoms
   - DO NOT ask leading questions like "Are you seeing flashes?"

3. ASSESS BASED ON WHAT THEY SAY:
   
   TRULY URGENT (transfer to human):
   - They describe sudden vision loss or significant vision change
   - They describe flashes of light with new floaters
   - They describe a curtain or shadow in their vision
   - They describe chemical exposure to the eye
   - They describe eye injury or trauma
   - They describe severe eye pain (not mild discomfort)
   - They mention recent eye surgery with concerning symptoms
   - They describe sudden double vision
   - They are a medical professional calling about a patient
   
   NOT URGENT (route to ticketing):
   - Appointment requests or changes
   - Prescription refills
   - Mild discomfort or irritation
   - Questions about billing or insurance
   - General questions that can wait
   - Anything that doesn't match the urgent criteria above

4. TAKE ACTION:

   IF URGENT:
   - "Based on what you're describing, I want to get you connected with our on-call team right away."
   - Create ticket with urgent priority
   - Transfer to human agent
   
   IF NOT URGENT:
   - "I understand your concern. Based on what you've described, this is something our team can help you with ${nextBizDay.contextPhrase}. Let me make sure your message gets to the right person."
   - Create ticket with normal priority
   - Confirm callback ${nextBizDay.contextPhrase}
   - "Is there anything else I can help with?"

===== CALLER PHONE =====

${callerContext}

===== CRITICAL RULES =====

- NEVER repeat the greeting
- NEVER answer any questions outside of Azul Vision related questions
- NEVER coach the patient ("Are you having flashes? Floaters?")
- NEVER suggest symptoms they haven't mentioned
- NEVER ask "Is this urgent?" - YOU determine that
- Ask open-ended questions: "Tell me more about that" or "What are you experiencing?"
- Base your assessment ONLY on what they actually describe
- Be professional and calm at all times
- One question at a time
- Don't leave dead air - if processing, say "One moment..."`;
}

const triageOutcomeEnum = z.enum([
  'sudden_vision_loss',
  'flashes_floaters_curtain',
  'chemical_exposure',
  'eye_trauma',
  'severe_eye_pain',
  'post_surgery_complication',
  'double_vision',
  'angle_closure_symptoms',
  'patient_insists_urgent',
  'medical_professional_calling',
  'appointment_request',
  'reschedule_appointment',
  'cancel_appointment',
  'medication_refill',
  'prescription_question',
  'billing_question',
  'insurance_question',
  'office_hours_question',
  'general_question',
  'message_for_provider',
  'test_results',
  'follow_up_care',
]);

export async function createAfterHoursAgent(
  handoffCallback?: () => Promise<void>,
  recordPatientInfoCallback?: (info: any) => any,
  metadata?: { 
    campaignId?: string; 
    contactId?: string;
    callerPhone?: string;
    dialedNumber?: string;
    callSid?: string;
  }
): Promise<RealtimeAgent> {
  const actualHandoffCallback = handoffCallback || (async () => {
    console.warn('[HANDOFF] Default agent used - handoff not wired to Twilio');
  });
  
  const actualRecordPatientInfoCallback = recordPatientInfoCallback || ((info: any) => {
    console.warn('[PATIENT INFO] Default callback used');
    return { success: true, message: "Patient information recorded" };
  });
  
  const callerPhone = metadata?.callerPhone;
  console.log('[Urgent Triage Agent] Creating agent:', {
    hasCallerPhone: !!callerPhone,
    hasMetadata: !!metadata,
  });
  
  // Auto-fetch patient schedule context using caller phone (async)
  let scheduleContext: PatientScheduleContext | undefined;
  if (callerPhone) {
    try {
      console.log('[Urgent Triage Agent] Fetching schedule context for:', callerPhone);
      scheduleContext = await scheduleLookupService.lookupByPhone(callerPhone);
      if (scheduleContext?.patientFound) {
        console.log('[Urgent Triage Agent] Schedule context found:', {
          upcomingCount: scheduleContext.upcomingAppointments.length,
          lastVisit: scheduleContext.lastVisitDate,
          lastLocationSeen: scheduleContext.lastLocationSeen,
        });
      } else {
        console.log('[Urgent Triage Agent] No schedule context found for phone');
      }
    } catch (error) {
      console.error('[Urgent Triage Agent] Schedule lookup failed:', error);
    }
  }

  const addHumanAgentTool = tool({
    name: 'transfer_to_human',
    description: 'Transfer call to human on-call agent. Use ONLY for truly urgent conditions.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[TOOL] transfer_to_human - initiating Twilio handoff');
      try {
        await actualHandoffCallback();
        console.log('[TOOL] Human agent added to conference');
        return { success: true, transferred: true };
      } catch (error) {
        console.error('[TOOL ERROR]', error);
        return { success: false, error: 'transfer_failed' };
      }
    },
  });

  const createAfterHoursTicketTool = tool({
    name: 'create_after_hours_ticket',
    description: 'Create a ticket for the call. Required for ALL calls. System determines routing based on triage outcome.',
    parameters: z.object({
      patient_first_name: z.string().describe('Patient first name'),
      patient_last_name: z.string().describe('Patient last name'),
      phone_number: z.string().describe('Callback phone number'),
      triage_outcome: triageOutcomeEnum.describe('Best match for the reason'),
      description: z.string().describe('Summary of the patient concern'),
      patient_birth_month: z.string().nullable().describe('Birth month (2 digits) or null'),
      patient_birth_day: z.string().nullable().describe('Birth day (2 digits) or null'),
      patient_birth_year: z.string().nullable().describe('Birth year (4 digits) or null'),
      patient_email: z.string().nullable().describe('Email if provided'),
      provider_name: z.string().nullable().describe('Doctor name if mentioned'),
      location_name: z.string().nullable().describe('Office location if mentioned'),
      pharmacy_name: z.string().nullable().describe('Pharmacy for prescription issues'),
      medication_name: z.string().nullable().describe('Medication name if relevant'),
    }),
    execute: async (params) => {
      console.log('[TOOL] create_after_hours_ticket:', {
        triage_outcome: params.triage_outcome,
        hasName: !!(params.patient_first_name && params.patient_last_name),
      });

      try {
        // Lazy import to avoid module initialization during agent bootstrap
        const { SyncAgentService } = await import('../services/syncAgentService');
        
        const mapping = TRIAGE_OUTCOME_MAPPINGS[params.triage_outcome as TriageOutcome];
        if (!mapping) {
          console.error('[TICKET] Unknown triage outcome:', params.triage_outcome);
          return { success: false, error: 'unknown_category' };
        }

        let formattedPhone = params.phone_number.replace(/\D/g, '');
        if (formattedPhone.length === 10) {
          formattedPhone = `+1${formattedPhone}`;
        } else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) {
          formattedPhone = `+${formattedPhone}`;
        } else if (!formattedPhone.startsWith('+')) {
          formattedPhone = `+${formattedPhone}`;
        }

        const result = await SyncAgentService.createTicket({
          departmentId: AFTER_HOURS_DEPARTMENT_ID,
          requestTypeId: mapping.requestTypeId,
          requestReasonId: mapping.requestReasonId,
          patientFirstName: params.patient_first_name,
          patientLastName: params.patient_last_name,
          patientPhone: formattedPhone,
          patientEmail: params.patient_email,
          patientBirthMonth: params.patient_birth_month,
          patientBirthDay: params.patient_birth_day,
          patientBirthYear: params.patient_birth_year,
          lastProviderSeen: params.provider_name,
          locationOfLastVisit: params.location_name,
          description: params.description,
          priority: mapping.priority,
          callData: {
            callSid: metadata?.callSid,
            callerPhone: callerPhone,
            dialedNumber: metadata?.dialedNumber,
            agentUsed: 'urgent-triage',
          },
        });

        if (result.success && result.ticketNumber) {
          console.log('[TICKET] Created:', result.ticketNumber, '| Urgent:', mapping.requiresTransfer);
          
          await actualRecordPatientInfoCallback({
            patient_name: `${params.patient_first_name} ${params.patient_last_name}`,
            phone_number: formattedPhone,
            reason: params.description,
            priority: mapping.priority,
            ticketNumber: result.ticketNumber,
            triageOutcome: params.triage_outcome,
            requiresTransfer: mapping.requiresTransfer,
          });

          return { 
            success: true, 
            requiresTransfer: mapping.requiresTransfer,
          };
        } else {
          console.error('[TICKET] Failed:', result.error);
          return { success: false, error: result.error || 'unknown' };
        }
      } catch (error) {
        console.error('[TICKET] Error:', error);
        return { success: false, error: 'system_error' };
      }
    },
  });

  const practiceKnowledge = buildPracticeKnowledgePrompt();
  
  // Default to sage (female) voice for triage
  return new RealtimeAgent({
    name: 'Urgent Triage Agent',
    voice: 'sage',
    handoffDescription: 'Handles after-hours urgent triage calls for Azul Vision',
    instructions: () => {
      const timeContext = require('../utils/timeAware').getPacificTimeContext();
      return buildSystemPrompt(callerPhone, scheduleContext) + 
        `\n\n===== TIME CONTEXT =====\n${timeContext}` +
        `\n\n===== PRACTICE KNOWLEDGE =====\n${practiceKnowledge}`;
    },
    tools: [createAfterHoursTicketTool, addHumanAgentTool],
  });
}

export { medicalSafetyGuardrails };
