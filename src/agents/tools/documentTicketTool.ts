import { tool } from '@openai/agents/realtime';
import { z } from 'zod';

const documentTicketSchema = z.object({
  departmentId: z.number().describe('Department ID: 1=Optical, 2=Surgery Coordinator, 3=Clinical Tech'),
  requestTypeId: z.number().describe('Type of request being made'),
  requestReasonId: z.number().describe('Specific reason for the request'),
  patientFirstName: z.string().describe('Patient first name'),
  patientLastName: z.string().describe('Patient last name'),
  patientPhone: z.string().describe('Patient phone number in E.164 format (e.g., +15551234567)'),
  patientEmail: z.string().optional().describe('Patient email address'),
  patientBirthMonth: z.string().optional().describe('Birth month (2 digits, e.g., "03")'),
  patientBirthDay: z.string().optional().describe('Birth day (2 digits, e.g., "15")'),
  patientBirthYear: z.string().optional().describe('Birth year (4 digits, e.g., "1985")'),
  locationId: z.number().optional().describe('Associated location ID'),
  providerId: z.number().optional().describe('Associated provider ID'),
  description: z.string().describe('Detailed description of the patient request or issue'),
  priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).optional().describe('Priority level, defaults to medium'),
});

export const documentTicketTool = tool({
  name: 'document_ticket',
  description: 'Document patient request by creating a ticket in the ticketing system. This hands off to the Sync Agent. Say "One moment while I document this for you" before calling this tool. After receiving the ticket number, confirm it with the patient.',
  parameters: documentTicketSchema,
  execute: async (params: z.infer<typeof documentTicketSchema>) => {
    console.info('[DOCUMENT TICKET] Greeter → Sync Agent handoff');

    try {
      // Lazy import to avoid module initialization during agent bootstrap
      const { SyncAgentService } = await import('../../services/syncAgentService');
      // Invoke Sync Agent service (background worker)
      const syncAgentResponse = await SyncAgentService.createTicket(params);
      
      console.info('[DOCUMENT TICKET] ✓ Sync Agent response:', syncAgentResponse);
      
      // Format patient-facing message based on Sync Agent response
      if (syncAgentResponse.success && syncAgentResponse.ticketNumber) {
        return `I've documented your request as ticket ${syncAgentResponse.ticketNumber}. A member of our team will follow up with you within 24-48 business hours.`;
      } else {
        return `I apologize, but I'm having trouble creating a ticket right now. ${syncAgentResponse.message}`;
      }
    } catch (error) {
      console.error('[DOCUMENT TICKET] ✗ Unexpected error during Sync Agent handoff:', error);
      return `I apologize, but there was an unexpected error documenting your request. Would you like me to take a detailed message instead, and someone will call you back?`;
    }
  },
});
