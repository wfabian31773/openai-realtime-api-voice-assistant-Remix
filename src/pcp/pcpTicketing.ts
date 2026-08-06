import { z } from 'zod';
import { PCP_CALL_PURPOSE_SLUGS, PCP_DISPOSITIONS, assertPcpDisposition } from './policy';
import { PCP_FACILITY_TYPES } from './director';
import { spokenDates } from '../services/identityArgGuard';

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

/**
 * Make a payload filable without losing the request.
 *
 * The schema is strict by design, but on 2026-08-06 that strictness was
 * throwing away whole tickets over ONE optional field. Two triggers seen in
 * production, both on calls where the caller had already given everything:
 *
 *   - an optional field present as '' or '   '. `optionalText` is
 *     .min(1).optional(), so an ABSENT key is fine and an EMPTY one is fatal.
 *   - patientDob carrying what the caller actually said — "11.11.1977",
 *     "November the eleventh, nineteen sixty-seven" — against a schema that
 *     demands YYYY-MM-DD.
 *
 * Either one made .parse() throw, the tool error reached the model, and the
 * caller was told "the system is consistently blocking the ticket" and, on one
 * call, to phone the medical records department themselves.
 *
 * A detail we cannot format is not a reason to drop a request. Blank optionals
 * become absent; an unparseable date of birth is normalised if we can and
 * otherwise moved into the narrative VERBATIM, so the human who works the
 * ticket still sees exactly what the caller said.
 */
export function sanitizePcpPayload(payload: PcpTicketPayload): PcpTicketPayload {
  const out: Record<string, unknown> = { ...payload };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.trim() === '') delete out[k];
  }
  const rawDob = typeof out.patientDob === 'string' ? out.patientDob.trim() : '';
  if (rawDob && !/^\d{4}-\d{2}-\d{2}$/.test(rawDob)) {
    const [iso] = spokenDates(rawDob);
    if (iso) {
      out.patientDob = iso;
    } else {
      delete out.patientDob;
      out.narrative = `${String(out.narrative ?? '')}\n\n[Date of birth as given by caller, not in a storable format: "${rawDob}"]`.trim();
    }
  }
  return out as PcpTicketPayload;
}

export async function submitPcpTicket(payload: PcpTicketPayload, client?: Client): Promise<PcpTicketResponse> {
  // safeParse, not parse. A throw here surfaces to the model as a tool error
  // and it improvises — telling the caller the system is broken. A structured
  // failure lets the agent take the fallback path it already has.
  const parsed = PcpTicketPayloadSchema.safeParse(sanitizePcpPayload(payload));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    console.error(`[PCP-TICKET] payload rejected, ticket NOT filed — fields: ${fields.join(', ')}`);
    return { success: false, error: `invalid_payload: ${fields.join(', ')}` };
  }
  try {
    assertPcpDisposition(parsed.data.callPurpose, parsed.data.disposition);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[PCP-TICKET] disposition rejected for ${parsed.data.callPurpose}: ${detail}`);
    return { success: false, error: `disposition_not_allowed: ${detail}` };
  }
  const effectiveClient = client ?? (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
  return effectiveClient.createPcpTicket(parsed.data);
}
