import { z } from 'zod';
import { PCP_CALL_PURPOSE_SLUGS, PCP_DISPOSITIONS, assertPcpDisposition } from './policy';
import { PCP_FACILITY_TYPES } from './director';

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const PcpTicketPayloadSchema = z.object({
  callSid: z.string().trim().min(3).max(120),
  agentSlug: z.literal('pcp'),
  agentVersion: z.string().trim().min(1).max(50),
  callerName: z.string().trim().min(1).max(200),
  callerRole: z.string().trim().min(1).max(160),
  callerOrganization: z.string().trim().min(1).max(255),
  callerFacilityType: z.enum(PCP_FACILITY_TYPES),
  callerCallbackNumber: z.string().trim().min(7).max(40),
  statedRelationship: optionalText(500),
  callPurpose: z.enum(PCP_CALL_PURPOSE_SLUGS),
  disposition: z.enum(PCP_DISPOSITIONS),
  urgency: z.enum(['routine', 'normal', 'high', 'urgent']).default('normal'),
  verificationStatus: z.enum(['not_required', 'pending', 'verified', 'failed']).default('pending'),
  patientFirstName: optionalText(120),
  patientLastName: optionalText(120),
  patientDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  patientMrn: optionalText(100),
  patientPhone: optionalText(40),
  providerRequested: optionalText(255),
  officeLocation: optionalText(255),
  narrative: z.string().trim().min(1).max(12000),
  transcript: optionalText(50000),
  handoff: z.object({
    requested: z.boolean(),
    requestedAt: z.string().datetime().optional(),
    attempted: z.boolean(),
    attemptedAt: z.string().datetime().optional(),
    destination: optionalText(80),
    humanAnswerStatus: optionalText(80),
    connectedAt: z.string().datetime().optional(),
    finalStatus: z.enum(['NOT_REQUESTED', 'REQUESTED', 'HANDOFF_UNAVAILABLE', 'DIALING', 'CONNECTED', 'NO_ANSWER', 'FAILED']),
    failureReason: optionalText(1000),
    fallbackTicketStatus: optionalText(80),
  }).optional(),
  failureInformation: optionalText(2000),
}).strict();

export type PcpTicketPayload = z.infer<typeof PcpTicketPayloadSchema>;
export type PcpTicketResponse = { success: boolean; ticketId?: number; ticketNumber?: string; cached?: boolean; error?: string };

type Client = { createPcpTicket(payload: PcpTicketPayload): Promise<PcpTicketResponse> };

export async function submitPcpTicket(payload: PcpTicketPayload, client?: Client): Promise<PcpTicketResponse> {
  const parsed = PcpTicketPayloadSchema.parse(payload);
  assertPcpDisposition(parsed.callPurpose, parsed.disposition);
  const effectiveClient = client ?? (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
  return effectiveClient.createPcpTicket(parsed);
}
