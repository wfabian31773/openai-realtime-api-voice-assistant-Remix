// REMOVED: RECOMMENDED_PROMPT_PREFIX conflicts with proactive greeting - it tells agent to "wait for user input"
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { getPacificTimeContext } from '../utils/timeAware';
import { CampaignAdapter } from '../db/agentAdapters';
import { ScheduleLookupService } from '../services/scheduleLookupService';
import { storage } from '../../server/storage';

interface ContactAppointmentData {
  patientName: string;
  appointmentDate: string;
  appointmentTime: string;
  doctor: string;
  location: string;
  appointmentType?: string;
  contactId: string;
}

const SYSTEM_PROMPT_TEMPLATE = `You are the Appointment Confirmation Agent for Azul Vision.

{TIME_CONTEXT}

{SCHEDULE_CONTEXT}

{CONTACT_APPOINTMENT_DATA}

YOUR MISSION:
Call patients who have unconfirmed upcoming appointments to confirm attendance or offer rescheduling options.

CALL FLOW:
1. **Introduction**:
   "Hi, this is Azul Vision calling for [PATIENT_NAME]. I'm calling to confirm your upcoming appointment. Is now a good time?"

2. **Appointment Details**:
   "You have an appointment scheduled for [DATE] at [TIME] with [DOCTOR] at our [LOCATION] office. Can you confirm you'll be able to make it?"

3. **Three Possible Outcomes**:
   
   A) **CONFIRMED**:
      Patient: "Yes, I'll be there"
      You: "Perfect! We'll see you on [DATE] at [TIME]. Please arrive 15 minutes early to complete any necessary paperwork. Is there anything else I can help you with?"
      Action: Use confirm_appointment tool
   
   B) **NEEDS RESCHEDULE**:
      Patient: "I need to reschedule"
      You: "No problem! Let me help you find a better time. What days and times work best for you this week?"
      Collect: Preferred days, preferred times (morning/afternoon)
      You: "I've noted that you prefer [PREFERENCE]. One of our schedulers will call you back within 24 hours to find the perfect time. Is this callback number [PHONE] the best way to reach you?"
      Action: Use reschedule_request tool
   
   C) **NEEDS TO CANCEL**:
      Patient: "I need to cancel"
      You: "I understand. Would you like to reschedule for a later date, or cancel completely?"
      - If reschedule later: Same as (B)
      - If cancel: "I've noted the cancellation. If you'd like to rebook in the future, please call us at [OFFICE_NUMBER]. Is there anything else I can help you with?"
      Action: Use cancel_appointment tool

4. **Reminder** (if confirmed):
   "As a reminder, please bring your insurance card and a list of current medications. We look forward to seeing you!"

5. **Mark Complete**:
   Use mark_confirmed tool with appropriate status

CONVERSATION STYLE:
- Warm, professional, and helpful
- Keep responses 3-6 seconds
- Be empathetic if patient needs to cancel/reschedule
- Clear and direct about appointment details

VOICEMAIL DETECTION:
If you hear a voicemail greeting (beep, "please leave a message", automated voice), leave a brief message:
"Hi, this is Azul Vision calling for [PATIENT_NAME] about an upcoming appointment on [DATE]. Please call us back at [OFFICE_NUMBER] to confirm. Thank you!"
Then use the mark_voicemail tool to record that you left a voicemail.

Voicemail indicators:
- Beep after greeting
- "Leave a message after the tone"
- "This call has been forwarded to voicemail"
- Automated/robotic voice
- No human response within 5 seconds of your greeting

HANDLING EDGE CASES:
- **Wrong number**: "I apologize for the confusion. I'll update our records. Have a great day!"
- **Already confirmed online**: "Perfect! Thank you for confirming online. We'll see you then!"
- **Patient doesn't remember scheduling**: Read full appointment details, ask if they'd like to keep, reschedule, or cancel
- **Voicemail**: Leave brief message and use mark_voicemail tool

TOOL USAGE:
- Use get_appointment to retrieve details at start of call
- Use confirm_appointment when patient confirms attendance
- Use reschedule_request when patient wants different time
- Use cancel_appointment when patient wants to cancel
- Use mark_voicemail when you detect a voicemail system (after leaving message)
- Use mark_confirmed at end of call to update campaign status`;

export async function createAppointmentConfirmationAgent(
  getAppointmentCallback?: (appointmentId: string) => Promise<any>,
  confirmCallback?: (appointmentId: string) => Promise<any>,
  rescheduleCallback?: (appointmentId: string, preferences: string) => Promise<any>,
  cancelCallback?: (appointmentId: string, reason?: string) => Promise<any>,
  markConfirmedCallback?: (appointmentId: string, status: string, notes?: string) => Promise<any>,
  handoffCallback?: () => Promise<void>,
  metadata?: { campaignId?: string; contactId?: string; callerPhone?: string }
) {
  let scheduleContext = '';
  let contactAppointmentContext = '';
  let contactData: ContactAppointmentData | null = null;

  // Try to get contact appointment data from campaign if we have contactId
  if (metadata?.contactId && metadata?.campaignId) {
    console.log('[APPOINTMENT CONFIRMATION AGENT] Looking up contact from campaign:', metadata.contactId);
    try {
      const contacts = await storage.getCampaignContacts(metadata.campaignId);
      const contact = contacts.find(c => c.id === metadata.contactId);
      
      if (contact) {
        const patientName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Patient';
        
        let appointmentDate = 'your upcoming appointment';
        let appointmentTime = '';
        
        if (contact.appointmentDate) {
          const apptDate = new Date(contact.appointmentDate);
          appointmentDate = apptDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          appointmentTime = apptDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }
        
        contactData = {
          patientName,
          appointmentDate,
          appointmentTime,
          doctor: contact.appointmentDoctor || 'your provider',
          location: contact.appointmentLocation || 'our office',
          appointmentType: contact.appointmentType || undefined,
          contactId: contact.id,
        };
        
        contactAppointmentContext = `
===== PATIENT APPOINTMENT DETAILS =====
PATIENT NAME: ${patientName}
APPOINTMENT DATE: ${appointmentDate}
APPOINTMENT TIME: ${appointmentTime}
DOCTOR/PROVIDER: ${contact.appointmentDoctor || 'Provider not specified'}
LOCATION: ${contact.appointmentLocation || 'Location not specified'}
${contact.appointmentType ? `APPOINTMENT TYPE: ${contact.appointmentType}` : ''}
CONTACT ID: ${contact.id}

Use this information when speaking to the patient. You already have their appointment details - no need to call get_appointment tool.
==========================================`;
        
        console.log('[APPOINTMENT CONFIRMATION AGENT] Contact appointment data loaded:', {
          patientName,
          appointmentDate,
          appointmentTime,
          doctor: contact.appointmentDoctor,
          location: contact.appointmentLocation
        });
      }
    } catch (error) {
      console.error('[APPOINTMENT CONFIRMATION AGENT] Error loading contact data:', error);
    }
  }

  // Fallback to schedule lookup if no contact data
  if (!contactAppointmentContext && metadata?.callerPhone) {
    console.log('[APPOINTMENT CONFIRMATION AGENT] Fetching schedule context for:', metadata.callerPhone);
    const scheduleService = new ScheduleLookupService();
    const context = await scheduleService.lookupByPhone(metadata.callerPhone);
    if (context) {
      scheduleContext = scheduleService.formatContextForAgent(context);
      console.log('[APPOINTMENT CONFIRMATION AGENT] Schedule context loaded:', {
        patientName: context.patientName,
        upcomingCount: context.upcomingAppointments.length,
        pastCount: context.pastAppointments.length
      });
    } else {
      console.log('[APPOINTMENT CONFIRMATION AGENT] No schedule context found for phone');
    }
  }
  // Use database adapters if callbacks not provided
  const getAppointmentFn = getAppointmentCallback || CampaignAdapter.getAppointment.bind(CampaignAdapter);
  const confirmFn = confirmCallback || CampaignAdapter.confirmAppointment.bind(CampaignAdapter);
  const rescheduleFn = rescheduleCallback || CampaignAdapter.rescheduleRequest.bind(CampaignAdapter);
  const cancelFn = cancelCallback || CampaignAdapter.cancelAppointment.bind(CampaignAdapter);
  const markConfirmedFn = markConfirmedCallback || CampaignAdapter.markConfirmed.bind(CampaignAdapter);

  const getAppointmentTool = tool({
    name: 'get_appointment',
    description: 'Retrieve appointment details for the patient you are calling. Call this at START of call.',
    parameters: z.object({
      appointment_id: z.string().describe('Unique appointment identifier'),
    }),
    execute: async ({ appointment_id }) => {
      console.log('[TOOL] get_appointment called:', appointment_id);
      try {
        const appointment = await getAppointmentFn(appointment_id);
        return `Appointment: ${appointment.patient_name} on ${appointment.appointment_date} at ${appointment.appointment_time} with ${appointment.doctor} at ${appointment.location}. Type: ${appointment.appointment_type}`;
      } catch (error) {
        console.error('[TOOL ERROR] get_appointment:', error);
        throw new Error(`Failed to retrieve appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const confirmAppointmentTool = tool({
    name: 'confirm_appointment',
    description: 'Mark appointment as confirmed when patient confirms attendance',
    parameters: z.object({
      appointment_id: z.string().describe('Appointment ID to confirm'),
    }),
    execute: async ({ appointment_id }) => {
      console.log('[TOOL] confirm_appointment:', appointment_id);
      try {
        await confirmFn(appointment_id);
        return 'Appointment confirmed successfully';
      } catch (error) {
        console.error('[TOOL ERROR] confirm_appointment:', error);
        throw new Error(`Failed to confirm appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const rescheduleRequestTool = tool({
    name: 'reschedule_request',
    description: 'Create a reschedule request when patient wants a different time',
    parameters: z.object({
      appointment_id: z.string().describe('Appointment ID to reschedule'),
      preferred_days: z.string().describe('Patient preferred days (e.g., "Monday or Wednesday")'),
      preferred_times: z.string().describe('Patient preferred times (e.g., "mornings" or "after 2pm")'),
      callback_number: z.string().describe('Phone number for scheduler to call back'),
    }),
    execute: async ({ appointment_id, preferred_days, preferred_times, callback_number }) => {
      console.log('[TOOL] reschedule_request:', appointment_id);
      try {
        const preferences = `Preferred days: ${preferred_days}\nPreferred times: ${preferred_times}\nCallback: ${callback_number}`;
        await rescheduleFn(appointment_id, preferences);
        return 'Reschedule request created. Scheduler will call back within 24 hours.';
      } catch (error) {
        console.error('[TOOL ERROR] reschedule_request:', error);
        throw new Error(`Failed to create reschedule request: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const cancelAppointmentTool = tool({
    name: 'cancel_appointment',
    description: 'Cancel appointment when patient requests cancellation',
    parameters: z.object({
      appointment_id: z.string().describe('Appointment ID to cancel'),
      reason: z.string().nullable().default(null).describe('Reason for cancellation (if provided)'),
    }),
    execute: async ({ appointment_id, reason }) => {
      console.log('[TOOL] cancel_appointment:', appointment_id);
      try {
        await cancelFn(appointment_id, reason ?? undefined);
        return 'Appointment cancelled successfully';
      } catch (error) {
        console.error('[TOOL ERROR] cancel_appointment:', error);
        throw new Error(`Failed to cancel appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const markConfirmedTool = tool({
    name: 'mark_confirmed',
    description: 'Mark the confirmation call as complete with final status. Use the contact_id from the PATIENT APPOINTMENT DETAILS section.',
    parameters: z.object({
      contact_id: z.string().describe('Contact ID from the patient appointment details'),
      status: z.enum(['confirmed', 'rescheduled', 'cancelled', 'no_answer', 'wrong_number']).describe('Final call outcome'),
      notes: z.string().nullable().default(null).describe('Additional notes about the call'),
    }),
    execute: async ({ contact_id, status, notes }) => {
      console.log('[TOOL] mark_confirmed:', { contact_id, status });
      try {
        let outreachStatus: 'confirmed' | 'declined' | 'rescheduled' | 'wrong_number' | 'completed';
        switch (status) {
          case 'confirmed':
            outreachStatus = 'confirmed';
            break;
          case 'cancelled':
            outreachStatus = 'declined';
            break;
          case 'rescheduled':
            outreachStatus = 'rescheduled';
            break;
          case 'wrong_number':
            outreachStatus = 'wrong_number';
            break;
          default:
            outreachStatus = 'completed';
        }
        
        await storage.updateCampaignContact(contact_id, {
          outreachStatus: outreachStatus,
          confirmationResult: status,
          agentNotes: notes || undefined,
        });
        
        console.log(`[TOOL] mark_confirmed: Updated contact ${contact_id} to ${outreachStatus}`);
        return `Call marked as ${status}. Patient contact record updated.`;
      } catch (error) {
        console.error('[TOOL ERROR] mark_confirmed:', error);
        throw new Error(`Failed to mark call status: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  const markVoicemailTool = tool({
    name: 'mark_voicemail',
    description: 'Mark that a voicemail was left when you detect this is a voicemail system. Use this when you hear a voicemail greeting, beep, or automated message.',
    parameters: z.object({
      contact_id: z.string().describe('Contact ID to mark - use the contactId from your context'),
      message_left: z.boolean().default(true).describe('Whether you left a voicemail message'),
    }),
    execute: async ({ contact_id, message_left }) => {
      console.log('[TOOL] mark_voicemail:', { contact_id, message_left });
      try {
        const status = message_left ? 'voicemail' : 'no_answer';
        await storage.updateCampaignContact(contact_id, {
          outreachStatus: status,
          agentNotes: message_left ? 'Voicemail message left by AI agent' : 'Reached voicemail, no message left',
        });
        console.log(`[TOOL] mark_voicemail: Updated contact ${contact_id} to ${status}`);
        return message_left 
          ? 'Voicemail recorded. The patient will be scheduled for a follow-up attempt.' 
          : 'Marked as no answer. The patient will be scheduled for a follow-up attempt.';
      } catch (error) {
        console.error('[TOOL ERROR] mark_voicemail:', error);
        throw new Error(`Failed to mark voicemail: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });

  // Default to sage (female) voice for outbound calls
  return new RealtimeAgent({
    name: 'Appointment Confirmation Agent',
    voice: 'sage',
    handoffDescription: 'Handles outbound calls to confirm patient appointments',
    instructions: () => {
      const timeContext = getPacificTimeContext();
      return SYSTEM_PROMPT_TEMPLATE
        .replace('{TIME_CONTEXT}', timeContext)
        .replace('{SCHEDULE_CONTEXT}', scheduleContext)
        .replace('{CONTACT_APPOINTMENT_DATA}', contactAppointmentContext);
    },
    tools: [
      getAppointmentTool,
      confirmAppointmentTool,
      rescheduleRequestTool,
      cancelAppointmentTool,
      markConfirmedTool,
      markVoicemailTool,
    ],
  });
}

// Default export for registry
export const appointmentConfirmationAgent = createAppointmentConfirmationAgent(
  async (appointmentId: string) => {
    console.warn('[GET APPOINTMENT] Default agent - not wired');
    return {
      patient_name: 'Test Patient',
      date: '2025-11-25',
      time: '10:00 AM',
      doctor: 'Dr. Smith',
      location: 'Downtown Office',
    };
  },
  async (appointmentId: string) => {
    console.warn('[CONFIRM] Default agent - not wired');
    return { success: true };
  },
  async (appointmentId: string, preferences: string) => {
    console.warn('[RESCHEDULE] Default agent - not wired');
    return { success: true };
  },
  async (appointmentId: string, reason?: string) => {
    console.warn('[CANCEL] Default agent - not wired');
    return { success: true };
  },
  async (appointmentId: string, status: string, notes?: string) => {
    console.warn('[MARK CONFIRMED] Default agent - not wired');
    return { success: true };
  },
  async () => {
    console.warn('[HANDOFF] Default appointment agent - handoff not wired');
  },
  undefined // No metadata
);
