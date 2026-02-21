// REMOVED: RECOMMENDED_PROMPT_PREFIX conflicts with proactive greeting - it tells agent to "wait for user input"
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { computerTool, Computer } from '@openai/agents';
import { z } from 'zod';
import { getPacificTimeContext } from '../utils/timeAware';
import { PhreesiaComputer } from '../utils/computer';
import { CampaignAdapter } from '../db/agentAdapters';
import { createPhreesiaSchedulingTool, createSubmitOTPTool } from '../tools/phreesiaSchedulingTool';
import { PHREESIA_CONFIG } from '../config/phreesiaConfig';

const PHREESIA_URL = PHREESIA_CONFIG.schedulingUrl;
const LOCATIONS_LIST = PHREESIA_CONFIG.locations.join(', ');
const OTP_WAIT_SECONDS = String(PHREESIA_CONFIG.otpWaitBeforePromptMs / 1000);

const SYSTEM_PROMPT_TEMPLATE = `You are the DRS Outbound Scheduler for Azul Vision.

{TIME_CONTEXT}

YOUR MISSION:
Proactively call diabetic patients to schedule their diabetic retinopathy screening (DRS) appointments. You will use the schedule_patient_in_phreesia tool to automatically fill out the Phreesia form WHILE talking to the patient, creating a seamless guided experience.

AVAILABLE LOCATIONS:
{LOCATIONS_LIST}

CALL FLOW:
1. **Introduction**:
   "Hi, this is the Azul Vision scheduling assistant calling for [PATIENT_NAME]. We're reaching out to help schedule your diabetic retinopathy screening exam. Is now a good time?"

2. **Verify Patient**:
   - Confirm date of birth
   - Confirm this is a good time to schedule
   - Ask: "Are you a new patient with Azul Vision, or have you visited us before?"

3. **Collect Information** (gather ALL required info before starting form):
   - Full name (first, middle if applicable, last)
   - Date of birth (MM/DD/YYYY)
   - Gender (male/female)
   - Street address, city, state, ZIP code
   - Home phone and mobile phone (mobile is required for verification code)
   - Email (optional)
   - Insurance company (if patient doesn't know or it's not a major one, use "Not Listed")
   - Preferred location from available locations
   - Preferred time (morning or afternoon)

4. **Start Phreesia Form** (use schedule_patient_in_phreesia tool):
   "Great! I have all your information. I'm going to schedule your appointment right now. The system will send a text message to your mobile phone with a 6-digit verification code. Give it about a minute to arrive."

5. **OTP Verification** (CRITICAL - wait about {OTP_WAIT_SECONDS} seconds):
   - After calling schedule_patient_in_phreesia, wait approximately {OTP_WAIT_SECONDS} seconds
   - Say: "You should be receiving a text message shortly with a 6-digit code. Can you read that code to me when it arrives?"
   - Patient reads code (e.g., "5-4-3-2-1-0" or "543210")
   - Use submit_otp_code tool immediately with the code
   - If patient says they haven't received it, wait another 30 seconds and check again

6. **Confirmation**:
   - Read back the appointment details from the tool response
   - "Perfect! You're all set for [DATE] at [TIME] at [LOCATION]. You'll receive a confirmation text message. Is there anything else I can help you with?"

7. **Mark Complete** (use mark_contact_completed tool):
   - Record outcome: scheduled, declined, callback, no_answer, wrong_number, or already_scheduled

CONVERSATION STYLE:
- Warm, professional, and efficient
- Keep responses 3-6 seconds
- Stop speaking immediately when patient talks
- Natural, conversational language
- Acknowledge patient responses warmly

TOOL USAGE:
- Use lookup_patient to get patient details from campaign at start of call
- Use schedule_patient_in_phreesia to fill out the Phreesia form automatically
- Use submit_otp_code when patient provides the verification code
- Use mark_contact_completed at end of call to update campaign status

HANDLING OBJECTIONS:
- "Not interested": "I understand. Would you like me to call back another time, or would you prefer to schedule on your own? I can text you a link."
- "Too busy right now": "No problem! When would be a better time for me to call back?"
- "Already scheduled": "Perfect! Thank you for taking care of that."

FALLBACK:
If the automatic scheduling fails, provide the patient with the manual scheduling link:
"I apologize, but I'm having a technical issue. Let me send you a link so you can complete the scheduling at your convenience. Our team will also follow up to make sure you're taken care of."

Remember: You're doing the tedious work FOR the patient. This is a service, not a sales call.`;

export function createDRSSchedulerAgent(
  lookupPatientCallback?: (campaignId: string, contactId: string) => Promise<any>,
  markCompletedCallback?: (contactId: string, outcome: string, notes?: string) => Promise<any>,
  computer?: Computer,
  handoffCallback?: () => Promise<void>,
  metadata?: { campaignId?: string; contactId?: string; callLogId?: string; agentId?: string }
) {
  // Extract metadata for use in tools
  const campaignId = metadata?.campaignId;
  const contactId = metadata?.contactId;
  const callLogId = metadata?.callLogId;
  const agentId = metadata?.agentId;
  
  console.log('[DRS AGENT] Creating agent with metadata:', { campaignId, contactId, callLogId, agentId });
  // Use database adapters if callbacks not provided
  const lookupFn = lookupPatientCallback || CampaignAdapter.lookupPatient.bind(CampaignAdapter);
  const markCompletedFn = markCompletedCallback || CampaignAdapter.markContactCompleted.bind(CampaignAdapter);
  
  const lookupPatientTool = tool({
    name: 'lookup_patient',
    description: 'Look up patient details from the current outbound campaign. Call this at the START of the call.',
    parameters: z.object({
      campaign_id: z.string().describe('Campaign ID for this call'),
      contact_id: z.string().describe('Contact ID for this patient'),
    }),
    execute: async ({ campaign_id, contact_id }) => {
      console.log('[TOOL] lookup_patient called:', { campaign_id, contact_id });
      try {
        const patient = await lookupFn(campaign_id, contact_id);
        return `Patient found: ${patient.first_name} ${patient.last_name}, Phone: ${patient.phone}, Email: ${patient.email || 'not provided'}`;
      } catch (error) {
        console.error('[TOOL ERROR] lookup_patient:', error);
        throw new Error(`Failed to lookup patient: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const markContactCompletedTool = tool({
    name: 'mark_contact_completed',
    description: 'Mark the campaign contact as completed with outcome',
    parameters: z.object({
      contact_id: z.string().describe('Contact ID to mark complete'),
      outcome: z.enum(['scheduled', 'declined', 'callback', 'no_answer', 'wrong_number', 'already_scheduled']).describe('Call outcome'),
      appointment_date: z.string().nullable().default(null).describe('Scheduled appointment date (if applicable)'),
      notes: z.string().nullable().default(null).describe('Additional notes about the call'),
    }),
    execute: async ({ contact_id, outcome, appointment_date, notes }) => {
      console.log('[TOOL] mark_contact_completed:', { contact_id, outcome });
      try {
        // Preserve full outcome details in notes for analytics
        const outcomeDetails = `Outcome: ${outcome}`;
        const fullNotes = [
          outcomeDetails,
          appointment_date ? `Appointment: ${appointment_date}` : null,
          notes || null
        ].filter(Boolean).join('\n');
        
        // Map to database outcome
        const dbOutcome = outcome === 'scheduled' ? 'success' : 
                          (outcome === 'no_answer' || outcome === 'wrong_number') ? 'no_answer' : 
                          'failed';
        
        await markCompletedFn(contact_id, dbOutcome, fullNotes);
        return `Contact marked as ${outcome}${appointment_date ? ` for ${appointment_date}` : ''}`;
      } catch (error) {
        console.error('[TOOL ERROR] mark_contact_completed:', error);
        throw new Error(`Failed to mark contact complete: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  // Build tools array - include computer tool if computer instance provided
  const tools: any[] = [lookupPatientTool, markContactCompletedTool];
  
  // Add Phreesia scheduling tools if we have the required context
  if (callLogId && agentId) {
    console.log('[DRS Agent] Adding Phreesia scheduling tools');
    const phreesiaContext = {
      callLogId,
      campaignId,
      contactId,
      agentId,
    };
    tools.push(createPhreesiaSchedulingTool(phreesiaContext));
    tools.push(createSubmitOTPTool(phreesiaContext));
  } else {
    console.log('[DRS Agent] Missing callLogId or agentId - Phreesia tools not available');
  }
  
  if (computer) {
    console.log('[DRS Agent] Computer instance provided - adding computerTool');
    tools.push(computerTool({ computer }));
  } else {
    console.log('[DRS Agent] No computer instance - Computer Use unavailable for this session');
  }

  // Default to sage (female) voice for outbound calls
  return new RealtimeAgent({
    name: 'DRS Outbound Scheduler',
    voice: 'sage',
    handoffDescription: 'Handles outbound diabetic retinopathy screening appointment scheduling calls',
    instructions: () => {
      const timeContext = getPacificTimeContext();
      const computerInstructions = computer 
        ? `\n\nCOMPUTER USE ENABLED: You have access to the computer tool to navigate ${PHREESIA_URL} in real-time during calls. Use screenshot(), click(), type(), and other computer actions to fill out the Phreesia form while guiding the patient.`
        : `\n\nPHREESIA SCHEDULING TOOLS AVAILABLE: Use schedule_patient_in_phreesia to automatically fill out the Phreesia form. The tool handles navigation, form filling, and returns appointment confirmation.`;
      
      const metadataInstructions = (campaignId && contactId) 
        ? `\n\nCAMPAIGN CONTEXT:\nYou are calling as part of campaign ID: ${campaignId}\nContact ID for this patient: ${contactId}\n\nIMPORTANT: When using the lookup_patient tool, use these exact values:\n- campaign_id: "${campaignId}"\n- contact_id: "${contactId}"`
        : '';
      
      const prompt = SYSTEM_PROMPT_TEMPLATE
        .replace('{TIME_CONTEXT}', timeContext)
        .replace('{PHREESIA_URL}', PHREESIA_URL)
        .replace('{LOCATIONS_LIST}', LOCATIONS_LIST)
        .replace(/{OTP_WAIT_SECONDS}/g, OTP_WAIT_SECONDS);
      
      return `${prompt}${computerInstructions}${metadataInstructions}`;
    },
    tools,
  });
}

// Default export for registry
export const drsSchedulerAgent = createDRSSchedulerAgent(
  async (campaignId: string, contactId: string) => {
    console.warn('[LOOKUP] Default agent - patient lookup not wired');
    return { first_name: 'Test', last_name: 'Patient', phone: '555-1234' };
  },
  async (contactId: string, outcome: string, notes?: string) => {
    console.warn('[MARK COMPLETE] Default agent - mark completed not wired');
    return { success: true };
  },
  undefined, // computer
  async () => {
    console.warn('[HANDOFF] Default DRS agent used - handoff not wired to Twilio');
  },
  undefined // No metadata for default instance
);
