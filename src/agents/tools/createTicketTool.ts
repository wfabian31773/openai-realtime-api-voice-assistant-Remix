import { tool } from '@openai/agents/realtime';
import { z } from 'zod';

const DEPARTMENTS = {
  OPTICAL: 1,
  SURGERY: 2,
  TECH: 3,
  CEC_NETWORKING: 12,
} as const;

interface ValidationResult {
  valid: boolean;
  error?: string;
  correctedParams?: Record<string, number>;
}

const MEDICATION_KEYWORDS = [
  'refill', 'medication', 'medicine', 'drops', 'eye drops', 'eyedrops',
  'prescription refill', 'rx refill', 'pharmacy', 'cvs', 'walgreens',
  'rite aid', 'costco pharmacy', 'ran out', 'running out', 'running low',
  'glaucoma drops', 'restasis', 'xiidra', 'lumigan', 'latanoprost',
  'timolol', 'combigan', 'steroid', 'antibiotic', 'allergy drops',
  'dry eye', 'artificial tears',
];

function validateTicketParams(params: {
  departmentId: number;
  requestTypeId: number;
  providerId?: number | null;
  lastProviderSeen?: string | null;
  description?: string;
}): ValidationResult {
  if (params.departmentId === DEPARTMENTS.SURGERY) {
    const hasSurgeon = 
      (params.providerId != null && params.providerId > 0) ||
      (params.lastProviderSeen != null && params.lastProviderSeen.trim().length > 0);
    
    if (!hasSurgeon) {
      console.warn('[CREATE_TICKET] ❌ Surgery ticket missing surgeon - rejecting');
      return {
        valid: false,
        error: 'Surgery tickets require a surgeon. Please ask which doctor is performing the surgery or which surgeon the patient is scheduled with.',
      };
    }
  }

  if (params.departmentId === DEPARTMENTS.CEC_NETWORKING && params.description) {
    const lowerDesc = params.description.toLowerCase();
    const isMedication = MEDICATION_KEYWORDS.some(kw => lowerDesc.includes(kw));
    if (isMedication) {
      console.warn(`[CREATE_TICKET] ⚠️ Medication request misrouted to CEC Networking (dept ${params.departmentId}) - auto-correcting to Tech (dept ${DEPARTMENTS.TECH})`);
      return {
        valid: true,
        correctedParams: { departmentId: DEPARTMENTS.TECH, requestTypeId: 6 },
      };
    }
  }

  return { valid: true };
}

const createTicketSchema = z.object({
  departmentId: z.number().describe('Department ID: 1=Optical, 2=Surgery Coordinator, 3=Clinical Tech'),
  requestTypeId: z.number().describe('Type of request being made'),
  requestReasonId: z.number().describe('Specific reason for the request'),
  patientFirstName: z.string().describe('Patient first name'),
  patientLastName: z.string().describe('Patient last name'),
  patientPhone: z.string().describe('Patient phone number in E.164 format (e.g., +15551234567)'),
  patientEmail: z.string().nullable().optional().describe('Patient email address'),
  preferredContactMethod: z.enum(['phone', 'text', 'email']).nullable().optional().describe('How the patient prefers to be contacted'),
  lastProviderSeen: z.string().nullable().optional().describe('Name of the last provider/doctor the patient saw (e.g., "Dr. Smith"). REQUIRED for surgery tickets.'),
  locationOfLastVisit: z.string().nullable().optional().describe('Location/office where patient had their last visit (e.g., "Pasadena Office")'),
  patientBirthMonth: z.string().nullable().optional().describe('Birth month (2 digits, e.g., "03")'),
  patientBirthDay: z.string().nullable().optional().describe('Birth day (2 digits, e.g., "15")'),
  patientBirthYear: z.string().nullable().optional().describe('Birth year (4 digits, e.g., "1985")'),
  locationId: z.number().nullable().optional().describe('Associated location ID'),
  providerId: z.number().nullable().optional().describe('Associated provider ID. REQUIRED for surgery tickets if lastProviderSeen not provided.'),
  description: z.string().describe('Detailed description of the patient request or issue'),
  priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).nullable().optional().describe('Priority level, defaults to medium'),
});

export const createTicketTool = tool({
  name: 'create_ticket',
  description: 'Create a support ticket in the external ticketing system. Returns ONLY the ticket number (e.g., "VA-1700000000000-456") on success, or "ERROR: <message>" on failure. NOTE: Surgery tickets (departmentId=2) REQUIRE a surgeon name in lastProviderSeen or providerId field.',
  parameters: createTicketSchema,
  execute: async (params: z.infer<typeof createTicketSchema>) => {
    const validation = validateTicketParams(params);
    if (!validation.valid) {
      return `ERROR: ${validation.error}`;
    }

    const finalParams = validation.correctedParams
      ? { ...params, ...validation.correctedParams }
      : params;

    const { SyncAgentService } = await import('../../services/syncAgentService');
    const response = await SyncAgentService.createTicket(finalParams);
    
    if (response.success && response.ticketNumber) {
      return response.ticketNumber;
    } else if (response.success && !response.ticketNumber) {
      return response.message;
    } else {
      return `ERROR: ${response.error || 'Unknown error creating ticket'}`;
    }
  },
});
