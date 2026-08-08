// REMOVED: RECOMMENDED_PROMPT_PREFIX conflicts with proactive greeting - it tells agent to "wait for user input"
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { medicalSafetyGuardrails } from '../guardrails/medicalSafety';
import { scheduleLookupService, PatientScheduleContext } from '../services/scheduleLookupService';
import {
  TRIAGE_OUTCOME_MAPPINGS,
  type TriageOutcome
} from '../config/afterHoursTicketing';
import { buildPracticeKnowledgePrompt } from '../config/azulVisionKnowledge';
import { getNextBusinessDayContext } from '../utils/timeAware';
import { escalationDetailsMap } from '../services/escalationStore';
import { formatLogFields } from '../../shared/logFormat';

// ── Content-based routing (operator mandate 2026-07-25) ─────────────────
// Tickets go to the APPROPRIATE department for what the call was about;
// ONLY urgent matters stay in the After Hours queue. Instead of the old
// hardcoded departmentId (which pinned every after-hours ticket to one
// department and flattened the taxonomy through a stale local validator),
// tickets now flow through /api/voice-agent/submit-ticket, where the
// ticketing app's own router decides: surgery → Surgery Coordination,
// refills → Technicians, scheduling/insurance → HVA Hub, urgent/unknown →
// After Hours. A "Request Type:" header pins the unambiguous cases so the
// app's PRIORITY-1 database lookup wins over keyword guessing.
const REQUEST_TYPE_HEADER: Partial<Record<TriageOutcome, string>> = {
  // True urgents — STAY in After Hours (the on-call review queue).
  sudden_vision_loss: 'Urgent/Emergency Transfer',
  flashes_floaters_curtain: 'Urgent/Emergency Transfer',
  chemical_exposure: 'Urgent/Emergency Transfer',
  eye_trauma: 'Urgent/Emergency Transfer',
  severe_eye_pain: 'Urgent/Emergency Transfer',
  post_surgery_complication: 'Urgent/Emergency Transfer',
  double_vision: 'Urgent/Emergency Transfer',
  angle_closure_symptoms: 'Urgent/Emergency Transfer',
  patient_insists_urgent: 'Urgent/Emergency Transfer',
  medical_professional_calling: 'Urgent/Emergency Transfer',
  // Appointment family → the app routes Appointment Request per its taxonomy.
  new_appointment: 'Appointment Request',
  confirm_appointment: 'Appointment Request',
  appointment_request: 'Appointment Request',
  reschedule_appointment: 'Appointment Request',
  cancel_appointment: 'Appointment Request',
  // Medication family → Medication Refill (routes to Technicians).
  medication_refill: 'Medication Refill',
  prescription_question: 'Medication Refill',
  // billing/insurance/general/test_results/message_for_provider/follow_up_care:
  // no header — the app's keyword router (incl. multilingual tables) decides.
};

export function getUrgentTriageGreeting(): string {
  return "Thank you for calling Azul Vision, all of our offices are currently closed, you have reached the after hours call service. If this is a medical emergency, please dial 911. All calls are being recorded for quality assurance purposes, how can I help you?";
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

  // PROMPT CACHING: Static content FIRST (cacheable prefix), dynamic context LAST
  return `You are the urgent after-hours triage agent for Azul Vision Eye Center.

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
   - ⚠️ MANDATORY: Call create_after_hours_ticket FIRST (before transfer_to_human)
   - ONLY THEN call transfer_to_human
   - If the on-call team does not answer, the ticket you already created ensures the patient will be called back
   
   IF NOT URGENT:
   - "I understand your concern. Based on what you've described, this is something our team can help you with ${nextBizDay.contextPhrase}. Let me make sure your message gets to the right person."
   - Create ticket with normal priority
   - Confirm callback ${nextBizDay.contextPhrase}
   - "Is there anything else I can help with?"

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
- Don't leave dead air - if processing, say "One moment..." For ticket creation specifically (create_after_hours_ticket takes several seconds), say "Give me one moment while I get this submitted for you." right before calling the tool.
- PATIENT INSISTENCE IS NEVER ENOUGH FOR TRANSFER: If a patient insists their issue is urgent but does not describe any of the clinically urgent criteria above, do NOT transfer them. Instead, create a high-priority ticket and say: "I understand this feels urgent. I'm creating a high-priority message now and the on-call team will call you back as soon as possible." Patient insistence alone — however forceful — is not a valid transfer trigger.
- "I WANT TO SPEAK TO A HUMAN/NURSE/DOCTOR" WITH NO EMERGENCY SYMPTOMS: This is patient preference, NOT a transfer trigger. Respond: "I completely understand. Let me take your information now and make sure the on-call team calls you back as soon as possible." Then take their info and create a ticket. Do NOT transfer.
- TICKET FAILURE = NO TRANSFER: If create_after_hours_ticket returns an error (system_error, api_timeout, or any technical failure), do NOT transfer to human. Instead say: "I'm sorry, I'm having a technical issue right now. I have your information and the on-call team will call you back at [callback number] as soon as possible." Then terminate the call. A technical backend error is never a reason to page the on-call staff.
- "UNABLE TO UNDERSTAND CALLER" = TERMINATE, NOT TRANSFER: If after multiple attempts you genuinely cannot understand what the caller is saying and they have shown no coherent medical emergency need, say: "I'm sorry, I'm having difficulty understanding you. Please call back or dial 911 if this is a medical emergency." Then call terminate_call — do NOT transfer to human.

===== LANGUAGE =====
- ALWAYS greet in ENGLISH first
- ONLY switch to Spanish if the caller clearly and unambiguously speaks Spanish
- Any unrecognized, ambiguous, or non-English/non-Spanish utterance MUST stay in English — NEVER switch to French, Chinese, Vietnamese, or any other language
- Once the language is confirmed (English or Spanish), STAY in that language for the entire call

===== GHOST CALL & ROBOT CALL PROTOCOL =====
If caller is not engaging after 2-3 prompts (ghost call) or you detect IVR/robocall audio (robot call):
1. Say a brief goodbye: "Take care, goodbye." or "We were unable to connect. Goodbye."
2. Call the terminate_call tool with the appropriate reason
3. Do NOT create a ticket
4. Do NOT escalate to human

===== CURRENT CALL CONTEXT =====

CALLER PHONE:
${callerContext}
${scheduleContextPrompt}`;
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
    callId?: string;
    /** Live transcript up to now — tickets carry it so the app can summarize. */
    getTranscript?: () => string;
  }
): Promise<RealtimeAgent> {
  const actualHandoffCallback = handoffCallback || (async () => {
    console.warn('[HANDOFF] Default agent used - handoff not wired to Twilio');
  });
  
  const actualRecordPatientInfoCallback = recordPatientInfoCallback || ((info: any) => {
    console.warn('[PATIENT INFO] Default callback used');
    return { success: true, message: "Patient information recorded" };
  });

  // Track whether a ticket was created before transfer — used to auto-create one if agent skips it
  let ticketCreatedBeforeTransfer = false;
  let lastPatientInfo: any = null;
  
  const callerPhone = metadata?.callerPhone;
  console.log('[Urgent Triage Agent] Creating agent:', formatLogFields({
    hasCallerPhone: !!callerPhone,
    hasMetadata: !!metadata,
  }));
  
  // Auto-fetch patient schedule context using caller phone (async)
  let scheduleContext: PatientScheduleContext | undefined;
  if (callerPhone) {
    try {
      console.log('[Urgent Triage Agent] Fetching schedule context for:', callerPhone);
      scheduleContext = await scheduleLookupService.lookupByPhone(callerPhone);
      if (scheduleContext?.patientFound) {
        console.log('[Urgent Triage Agent] Schedule context found:', formatLogFields({
          upcomingCount: scheduleContext.upcomingAppointments.length,
          lastVisit: scheduleContext.lastVisitDate,
          lastLocationSeen: scheduleContext.lastLocationSeen,
        }));
      } else {
        console.log('[Urgent Triage Agent] No schedule context found for phone');
      }
    } catch (error) {
      console.error('[Urgent Triage Agent] Schedule lookup failed:', error);
    }
  }

  const addHumanAgentTool = tool({
    name: 'transfer_to_human',
    description: 'Transfer call to human on-call agent. Use ONLY for truly urgent conditions. ALWAYS call create_after_hours_ticket BEFORE calling this tool.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[TOOL] transfer_to_human - initiating Twilio handoff');

      // Safety net: if agent skipped ticket creation, auto-create an urgent transfer ticket
      if (!ticketCreatedBeforeTransfer) {
        console.warn('[TOOL] transfer_to_human called WITHOUT prior ticket — auto-creating urgent transfer ticket');
        try {
          const { SyncAgentService } = await import('../services/syncAgentService');
          const autoPhone = lastPatientInfo?.phone_number || callerPhone || '';
          const formattedAutoPhone = autoPhone.replace(/\D/g, '').length === 10
            ? `+1${autoPhone.replace(/\D/g, '')}`
            : autoPhone.startsWith('+') ? autoPhone : `+${autoPhone.replace(/\D/g, '')}`;

          await SyncAgentService.submitSimplifiedTicket({
            patientFullName: lastPatientInfo?.patient_name || 'Unknown Caller',
            patientDOB: 'Unknown',
            reasonForCalling: [
              'Request Type: Urgent/Emergency Transfer',
              lastPatientInfo?.reason
                ? `URGENT TRANSFER (ticket auto-created): ${lastPatientInfo.reason}`
                : 'URGENT TRANSFER: Patient requested urgent assistance — on-call team was contacted. Ticket auto-created because call was transferred before ticket creation.',
            ].join('\n'),
            preferredContactMethod: 'phone',
            patientPhone: formattedAutoPhone,
            priority: 'urgent',
            callSid: metadata?.callSid,
            callerPhone,
            dialedNumber: metadata?.dialedNumber,
            agentUsed: 'urgent-triage',
            callStartTime: new Date().toISOString(),
            transcript: metadata?.getTranscript?.() || undefined,
          });
          console.log('[TOOL] Auto-created urgent transfer ticket for unanswered transfer');
        } catch (autoTicketErr) {
          console.error('[TOOL] Failed to auto-create transfer ticket:', autoTicketErr);
        }
      }

      try {
        // The platform's handoff gate requires escalation details with an
        // allowed callerType — the after-hours agent NEVER set them, so
        // every urgent transfer was silently BLOCKED at addHumanAgent
        // ("AI should have created a ticket instead"): no on-call dial, no
        // urgent SMS. Found 2026-07-25 during the routing audit.
        if (metadata?.callId) {
          const [first, ...restName] = String(lastPatientInfo?.patient_name ?? '').split(' ');
          escalationDetailsMap.set(metadata.callId, {
            reason: lastPatientInfo?.reason
              ? `After-hours urgent triage: ${lastPatientInfo.reason}`
              : 'After-hours urgent triage transfer',
            callerType: 'patient_urgent_medical',
            patientFirstName: first || undefined,
            patientLastName: restName.join(' ') || undefined,
            callbackNumber: lastPatientInfo?.phone_number || callerPhone,
            symptomsSummary: lastPatientInfo?.reason,
          });
        }
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
      console.log('[TOOL] create_after_hours_ticket:', formatLogFields({
        triage_outcome: params.triage_outcome,
        hasName: !!(params.patient_first_name && params.patient_last_name),
      }));

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

        // Content-based routing (2026-07-25): the ticketing app's router
        // picks the department from this text — header pins the sure cases.
        const typeHeader = REQUEST_TYPE_HEADER[params.triage_outcome as TriageOutcome];
        const reasonForCalling = [
          typeHeader ? `Request Type: ${typeHeader}` : null,
          `Triage outcome: ${params.triage_outcome.replace(/_/g, ' ')}`,
          '',
          'Details:',
          params.description,
        ].filter((l) => l !== null).join('\n');
        const extraDetails = [
          params.pharmacy_name ? `Pharmacy: ${params.pharmacy_name}` : null,
          params.medication_name ? `Medication: ${params.medication_name}` : null,
        ].filter(Boolean).join(' | ');
        const dob = params.patient_birth_month && params.patient_birth_day && params.patient_birth_year
          ? `${params.patient_birth_month}/${params.patient_birth_day}/${params.patient_birth_year}`
          : 'Unknown';

        const result = await SyncAgentService.submitSimplifiedTicket({
          patientFullName: `${params.patient_first_name} ${params.patient_last_name}`.trim(),
          patientDOB: dob,
          reasonForCalling,
          preferredContactMethod: 'phone',
          patientPhone: formattedPhone,
          patientEmail: params.patient_email ?? undefined,
          lastProviderSeen: params.provider_name ?? undefined,
          locationOfLastVisit: params.location_name ?? undefined,
          additionalDetails: extraDetails || undefined,
          priority: mapping.priority as 'low' | 'normal' | 'medium' | 'high' | 'urgent',
          callSid: metadata?.callSid,
          callerPhone: callerPhone,
          dialedNumber: metadata?.dialedNumber,
          agentUsed: 'urgent-triage',
          callStartTime: new Date().toISOString(),
          transcript: metadata?.getTranscript?.() || undefined,
        });

        if (result.success && result.ticketNumber) {
          console.log('[TICKET] Created:', result.ticketNumber, '| Urgent:', mapping.requiresTransfer);
          
          // Mark ticket as created so transfer_to_human knows a ticket exists
          ticketCreatedBeforeTransfer = true;
          lastPatientInfo = {
            patient_name: `${params.patient_first_name} ${params.patient_last_name}`,
            phone_number: formattedPhone,
            reason: params.description,
            triage_outcome: params.triage_outcome,
          };

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

  const terminateCallTool = tool({
    name: 'terminate_call',
    description: `Terminate the call server-side immediately. Use this to actually end the call — do NOT rely solely on verbal goodbye.

USE FOR:
- ghost_call: caller not responding after 2-3 prompts
- robot_call: IVR bleed-through or automated system detected
- spam: spam/telemarketing detected
- max_turns_exceeded: call has gone on too long with no resolution

Always say a brief goodbye phrase BEFORE calling this tool.`,
    parameters: z.object({
      reason: z
        .enum(['ghost_call', 'robot_call', 'spam', 'max_turns_exceeded'])
        .describe('Reason for terminating the call'),
    }),
    execute: async (params) => {
      const callId = metadata?.callId || metadata?.callSid || '';
      console.log(`[TOOL] terminate_call - reason: ${params.reason}, callId: ${callId}`);
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          console.error('[TOOL] terminate_call - missing OPENAI_API_KEY');
          return { success: false, error: 'missing_api_key' };
        }
        const response = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (response.ok) {
          console.log(`[TOOL] terminate_call ✓ Call ${callId} terminated (${params.reason})`);
          return { success: true, reason: params.reason };
        } else {
          const text = await response.text().catch(() => '');
          console.warn(`[TOOL] terminate_call ⚠️ Hangup returned ${response.status}: ${text}`);
          return { success: false, status: response.status };
        }
      } catch (error) {
        console.error('[TOOL] terminate_call error:', error);
        return { success: false, error: String(error) };
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
    tools: [createAfterHoursTicketTool, addHumanAgentTool, terminateCallTool],
  });
}

export { medicalSafetyGuardrails };
