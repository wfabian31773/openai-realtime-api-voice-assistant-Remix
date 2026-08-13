import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { detectCrossQueue } from '../../tools/queueRouting';

const DEPARTMENTS = {
  OPTICAL: 1,
  SURGERY: 2,
  TECH: 3,
  CEC_NETWORKING: 12,
  MEDICAL_RECORDS: 16,
} as const;

// Operator-approved human review queue (ticket-workflow MASTER §C4): After Hours
// Call Service → General Inquiry → "General Message for Office". Staff watch it,
// and auto-assignment is suppressed there. A request the agent can't complete on
// the call lands here for a human rather than being dropped.
const REVIEW_QUEUE = { departmentId: 8, requestTypeId: 35, requestReasonId: 172 } as const;

interface ValidationResult {
  valid: boolean;
  error?: string;
  // Widened from Record<string, number> so a correction can also carry the
  // rewritten description — a redirected ticket must say how it arrived, or the
  // receiving team sees a request with no idea why it landed with them.
  correctedParams?: Record<string, number | string>;
}

const MEDICATION_KEYWORDS = [
  'refill', 'medication', 'medicine', 'drops', 'eye drops', 'eyedrops',
  'prescription refill', 'rx refill', 'pharmacy', 'cvs', 'walgreens',
  'rite aid', 'costco pharmacy', 'ran out', 'running out', 'running low',
  'glaucoma drops', 'restasis', 'xiidra', 'lumigan', 'latanoprost',
  'timolol', 'combigan', 'steroid', 'antibiotic', 'allergy drops',
  'dry eye', 'artificial tears',
];

const ESCALATE_HINT = ' If the caller genuinely cannot provide this after you ask, call create_ticket again with unresolvedInfo set to what is missing, so the request is routed to a human review queue instead of being lost.';

function validateTicketParams(params: {
  departmentId: number;
  requestTypeId: number;
  providerId?: number | null;
  lastProviderSeen?: string | null;
  locationId?: number | null;
  locationOfLastVisit?: string | null;
  patientBirthYear?: string | null;
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
        error: 'Surgery tickets require a surgeon. Please ask which doctor is performing the surgery or which surgeon the patient is scheduled with.' + ESCALATE_HINT,
      };
    }
  }

  // Optical tickets are unassignable without a location — the single biggest
  // source of languishing tickets. Gate it the same way surgery gates a surgeon:
  // bounce back to the agent to ask which office, rather than create a ticket
  // nobody can pick up.
  if (params.departmentId === DEPARTMENTS.OPTICAL) {
    const hasLocation =
      (params.locationId != null && params.locationId > 0) ||
      (params.locationOfLastVisit != null && params.locationOfLastVisit.trim().length > 0);

    if (!hasLocation) {
      console.warn('[CREATE_TICKET] ❌ Optical ticket missing location - rejecting');
      return {
        valid: false,
        error: 'Optical tickets require a location. Please ask which Azul Vision office the patient visits or would like to be seen at, so this reaches the right team.' + ESCALATE_HINT,
      };
    }
  }

  // Medical Records (Right of Access) requests can't be fulfilled without
  // verifying the patient's identity. Capture the date of birth on the call so
  // the records team can verify before releasing anything.
  if (params.departmentId === DEPARTMENTS.MEDICAL_RECORDS) {
    const hasDob = params.patientBirthYear != null && params.patientBirthYear.trim().length > 0;
    if (!hasDob) {
      console.warn('[CREATE_TICKET] ❌ Medical records ticket missing date of birth - rejecting');
      return {
        valid: false,
        error: 'Medical records requests require the patient date of birth to verify identity before records can be released. Please ask for the patient date of birth.' + ESCALATE_HINT,
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

  // CROSS-QUEUE ROUTING, for every agent that files through this tool.
  //
  // Operator ruling 2026-08-13: "if someone calls and they press two for
  // medication refill, and it's an optical question, we can't just tell the
  // patient call back ... anything that's schedule related that comes through
  // any of these should go to the HVA hub." Then: "cross queue routing should
  // be for all agents."
  //
  // This function was already doing exactly this for one case — a medication
  // request landing on CEC Networking — so the concept is not new, only its
  // reach. The answering service, no-IVR and no-IVR v2 all file through here.
  //
  // SCHEDULING IS THE ONE THAT COULD NOT WORK BEFORE. ANSWERING_SERVICE_DEPARTMENTS
  // is {OPTICAL:1, SURGERY:2, TECH:3, RESEARCH:11, CEC_NETWORKING:12} — the HVA
  // Hub is not in it, so no agent using that map could route an appointment
  // request anywhere but into a clinical queue. That is why "request to
  // schedule an eye exam" is sitting in the medication queue today.
  if (params.description) {
    const redirect = detectCrossQueue(params.description, params.departmentId);
    if (redirect) {
      console.warn(
        `[CREATE_TICKET] ⚠️ ${redirect.departmentName} request arrived on dept ` +
          `${params.departmentId} — routing to dept ${redirect.departmentId} ` +
          `(${redirect.requestReason})`,
      );
      return {
        valid: true,
        correctedParams: {
          departmentId: redirect.departmentId,
          requestTypeId: redirect.requestTypeId,
          requestReasonId: redirect.requestReasonId,
          description: `${redirect.note}\n\n${params.description}`,
        },
      };
    }
  }

  return { valid: true };
}

const createTicketSchema = z.object({
  departmentId: z.number().describe('Department ID: 1=Optical, 2=Surgery Coordinator, 3=Clinical Tech, 16=Medical Records'),
  requestTypeId: z.number().describe('Type of request being made'),
  requestReasonId: z.number().describe('Specific reason for the request'),
  patientFirstName: z.string().describe('Patient first name'),
  patientLastName: z.string().describe('Patient last name'),
  patientPhone: z.string().describe('Patient phone number in E.164 format (e.g., +15551234567)'),
  patientEmail: z.string().nullable().optional().describe('Patient email address'),
  preferredContactMethod: z.enum(['phone', 'text', 'email']).nullable().optional().describe('How the patient prefers to be contacted'),
  lastProviderSeen: z.string().nullable().optional().describe('Name of the last provider/doctor the patient saw (e.g., "Dr. Smith"). REQUIRED for surgery tickets.'),
  locationOfLastVisit: z.string().nullable().optional().describe('Location/office where patient had their last visit (e.g., "Pasadena Office"). REQUIRED for optical tickets if locationId not provided.'),
  patientBirthMonth: z.string().nullable().optional().describe('Birth month (2 digits, e.g., "03")'),
  patientBirthDay: z.string().nullable().optional().describe('Birth day (2 digits, e.g., "15")'),
  patientBirthYear: z.string().nullable().optional().describe('Birth year (4 digits, e.g., "1985"). REQUIRED for medical records tickets to verify identity.'),
  locationId: z.number().nullable().optional().describe('Associated location ID. REQUIRED for optical tickets if locationOfLastVisit not provided.'),
  providerId: z.number().nullable().optional().describe('Associated provider ID. REQUIRED for surgery tickets if lastProviderSeen not provided.'),
  description: z.string().describe('Detailed description of the patient request or issue'),
  priority: z.enum(['low', 'normal', 'medium', 'high', 'urgent']).nullable().optional().describe('Priority level, defaults to medium'),
  unresolvedInfo: z.string().nullable().optional().describe('Set this ONLY after you have already asked and the caller genuinely cannot provide a REQUIRED field (a surgeon for surgery, an office/location for optical, a date of birth for medical records). Briefly state what is missing (e.g., "caller does not know which surgeon"). The request is then routed to the human review queue so it is never lost. Do NOT set this on a first attempt — always ask the caller first.'),
});

export const createTicketTool = tool({
  name: 'create_ticket',
  description: 'Create a support ticket in the external ticketing system. Returns ONLY the ticket number (e.g., "VA-1700000000000-456") on success, or "ERROR: <message>" on failure. NOTE: Surgery tickets (departmentId=2) REQUIRE a surgeon name in lastProviderSeen or providerId. Optical tickets (departmentId=1) REQUIRE a location in locationOfLastVisit or locationId. Medical Records tickets (departmentId=16) REQUIRE the patient date of birth (patientBirthYear) to verify identity. If a required field cannot be obtained after asking the caller, pass unresolvedInfo to route the request to human review instead of failing.',
  parameters: createTicketSchema,
  execute: async (params: z.infer<typeof createTicketSchema>) => {
    const { unresolvedInfo, ...rest } = params;
    const validation = validateTicketParams(rest);

    const { SyncAgentService } = await import('../../services/syncAgentService');

    if (!validation.valid) {
      const gaveUp = typeof unresolvedInfo === 'string' && unresolvedInfo.trim().length > 0;
      if (!gaveUp) {
        // Gate: get the missing info first (the message tells the agent how).
        return `ERROR: ${validation.error}`;
      }
      // Never lose the request: the caller couldn't provide the required field,
      // so route to the human review queue rather than dropping it.
      console.warn(`[CREATE_TICKET] ⚠️ Unresolved required info — routing to review queue (dept ${REVIEW_QUEUE.departmentId}). Missing: ${unresolvedInfo}`);
      const reviewParams = {
        ...rest,
        ...REVIEW_QUEUE,
        priority: 'high' as const,
        description: `[NEEDS HUMAN REVIEW] Could not complete on the call. Missing: ${unresolvedInfo.trim()}. Original intent (dept ${rest.departmentId}, type ${rest.requestTypeId}): ${rest.description}`,
      };
      const reviewResponse = await SyncAgentService.createTicket(reviewParams);
      if (reviewResponse.success && reviewResponse.ticketNumber) {
        return reviewResponse.ticketNumber;
      } else if (reviewResponse.success && !reviewResponse.ticketNumber) {
        return reviewResponse.message;
      } else {
        return `ERROR: ${reviewResponse.error || 'Unknown error creating review ticket'}`;
      }
    }

    const finalParams = validation.correctedParams
      ? { ...rest, ...validation.correctedParams }
      : rest;

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
