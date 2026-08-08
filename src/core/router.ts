/**
 * New-core cutover switch (reconstruction-plan.md §4).
 *
 * NEW_CORE_LINES names the lines the new core answers; every other line
 * stays on the old core untouched. Default: empty — nothing cuts over
 * except by explicit operator action, and removing a name rolls that line
 * back instantly on the next publish (the RAMP_AGENTS lever, proven).
 */
import type { LineModule, TicketLineServices } from './types';
import { createAnsweringServiceLine } from './answeringServiceLine';
import { createPcpLine, type ProfessionalLineServices } from './pcpLine';

/**
 * Per-call transport bindings for lines whose actions need the live session
 * (the PCP queue dial). Registered by the transport at session start,
 * released with the call.
 */
export interface PcpTransportBindings {
  callSid: string;
  handoff: () => Promise<{ ok: boolean; status?: string; reason?: string; destination?: string }>;
}
const pcpBindings = new Map<string, PcpTransportBindings>();
export function registerPcpBindings(callId: string, b: PcpTransportBindings): void {
  pcpBindings.set(callId, b);
}

const NEW_CORE_LINES = new Set(
  (process.env.NEW_CORE_LINES ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

const modules = new Map<string, LineModule>();

function buildProdServices(): TicketLineServices {
  return {
    async verifyByLookup(first, last, dob) {
      const { scheduleLookupService } = await import('../services/scheduleLookupService');
      const r = await scheduleLookupService.lookupByNameAndDOB(first, last, dob);
      return Boolean((r as { patientFound?: boolean })?.patientFound);
    },
    async classify(description) {
      const cfg = await import('../config/answeringServiceTicketing');
      const department = cfg.detectDepartment(description);
      const departmentId = cfg.ANSWERING_SERVICE_DEPARTMENTS[
        department.toUpperCase() as keyof typeof cfg.ANSWERING_SERVICE_DEPARTMENTS
      ] as number;
      const requestTypeId = cfg.detectRequestType(description, department);
      return {
        departmentId,
        requestTypeId,
        requestReasonId: cfg.detectRequestReason(description, requestTypeId),
        priority: cfg.detectPriority(description),
        locationId: cfg.findLocationByName(description) ?? null,
        providerId: cfg.findProviderByName(description) ?? null,
      };
    },
    async fileTicket(input) {
      const { SyncAgentService } = await import('../services/syncAgentService');
      const { parseDateOfBirth } = await import('../agents/answeringServiceAgent');
      const dob = parseDateOfBirth(input.dateOfBirth);
      const r = await SyncAgentService.createTicketFromAgentInput({
        firstName: input.firstName,
        lastName: input.lastName,
        birthMonth: String(dob.month ?? ''),
        birthDay: String(dob.day ?? ''),
        birthYear: String(dob.year ?? ''),
        callbackNumber: input.callbackNumber,
        requestCategory: 'general_question',
        requestSummary: input.description,
        departmentId: input.departmentId,
        requestTypeId: input.requestTypeId,
        requestReasonId: input.requestReasonId,
        priority: input.priority,
        subject: input.subject,
        locationId: input.locationId ?? undefined,
        providerId: input.providerId ?? undefined,
        doctorName: input.providerName ?? undefined,
        location: input.locationName ?? undefined,
      });
      return { ok: Boolean(r.success), ticketNumber: r.ticketNumber, error: r.error };
    },
  };
}

/** The line module for a slug, or null when the old core keeps the call. */
export function newCoreFor(slug: string): LineModule | null {
  if (!NEW_CORE_LINES.has(slug)) return null;
  let mod = modules.get(slug);
  if (!mod) {
    if (slug === 'answering-service') mod = createAnsweringServiceLine(buildProdServices());
    else if (slug === 'pcp') mod = createPcpLine(buildPcpProdServices());
    else if (slug === 'no-ivr' || slug === 'after-hours') {
      // After-hours: the same ticket-only machine with the closed-office
      // deflection script (§5). 911-first stays in the enforced greeting.
      mod = createAnsweringServiceLine(buildProdServices(), {
        slug,
        humanBusy: {
          en: "Our offices are closed right now — I'll take your information and make sure the right team member calls you back first thing.",
          es: 'Nuestras oficinas están cerradas en este momento — tomaré su información y me aseguraré de que el equipo le devuelva la llamada a primera hora.',
        },
      });
    }
    if (!mod) return null; // named but not yet built — old core keeps it
    modules.set(slug, mod);
  }
  return mod;
}

const BUILT_LINES = new Set(['answering-service', 'pcp', 'no-ivr', 'after-hours']);

export function newCoreEnabled(slug: string): boolean {
  return NEW_CORE_LINES.has(slug) && BUILT_LINES.has(slug);
}

function buildPcpProdServices(): ProfessionalLineServices {
  const purposeFor = (narrative: string): string => {
    if (/\b(schedul\w*|appointment\w*|book(ing)?)\b/i.test(narrative)) return 'schedule_appointment';
    if (/\b(records?|charts?|notes?|results?)\b/i.test(narrative)) return 'patient_medical_records_request';
    if (/\breferral\b/i.test(narrative)) return 'outside_referral_status';
    return 'service_inquiry';
  };
  const basePayload = async (callId: string, input: { narrative: string; organization?: string; callbackNumber?: string; patientRef?: string }) => {
    const [first, ...rest] = (input.patientRef ?? '').trim().split(/\s+/).filter(Boolean);
    return {
      callSid: pcpBindings.get(callId)?.callSid ?? callId,
      agentSlug: 'pcp' as const,
      agentVersion: 'new-core-1',
      callerName: input.organization ?? 'Professional caller',
      callerRole: 'healthcare professional',
      callerOrganization: input.organization ?? 'Unknown organization',
      callerFacilityType: 'other_healthcare_organization' as const,
      callerCallbackNumber: input.callbackNumber ?? 'unknown',
      callPurpose: purposeFor(input.narrative) as never,
      narrative: input.narrative,
      ...(first ? { patientFirstName: first, patientLastName: rest.join(' ') || undefined } : {}),
    };
  };
  return {
    async routeToQueue(callId, input) {
      const { submitPcpTicket } = await import('../pcp/pcpTicketing');
      const requestedAt = new Date().toISOString();
      const base = await basePayload(callId, input);
      const initial = await submitPcpTicket({
        ...base,
        disposition: 'HAND_OFF',
        urgency: input.urgency,
        handoff: { requested: true, requestedAt, attempted: false, finalStatus: 'REQUESTED' },
      } as never);
      const dial = pcpBindings.get(callId)?.handoff;
      const outcome = dial ? await dial().catch(() => ({ ok: false })) : { ok: false, reason: 'no transport binding' };
      const ok = Boolean(outcome && outcome.ok);
      await submitPcpTicket({
        ...base,
        disposition: ok ? 'HAND_OFF' : 'CREATE_TASK',
        urgency: input.urgency,
        handoff: {
          requested: true,
          requestedAt,
          attempted: true,
          attemptedAt: new Date().toISOString(),
          finalStatus: ok ? 'CONNECTED' : 'FAILED',
          failureReason: !ok && 'reason' in outcome ? (outcome as { reason?: string }).reason : undefined,
          fallbackTicketStatus: ok ? undefined : 'OPEN',
        },
      } as never).catch(() => undefined);
      return { connected: ok, ticketNumber: initial.ticketNumber };
    },
    async fileTask(callId, input) {
      const { submitPcpTicket } = await import('../pcp/pcpTicketing');
      const base = await basePayload(callId, input);
      const narrative = [
        input.narrative,
        input.contactMethod === 'fax' && input.faxNumber ? `FAX RESULTS TO: ${input.faxNumber}` : null,
        input.contactMethod === 'email' && input.email ? `EMAIL RESULTS TO: ${input.email}` : null,
      ].filter(Boolean).join(' — ');
      const r = await submitPcpTicket({ ...base, narrative, disposition: 'CREATE_TASK', urgency: 'normal' } as never);
      return { ok: Boolean(r.success), ticketNumber: r.ticketNumber };
    },
  };
}

/** Call teardown: release the call in every instantiated line module. */
export function releaseNewCoreCall(callId: string): void {
  for (const mod of modules.values()) mod.release(callId);
  pcpBindings.delete(callId);
}

/** Test hook: inject a module (simulated services) regardless of env. */
export function _setModuleForTest(slug: string, mod: LineModule | null): void {
  if (mod) modules.set(slug, mod);
  else modules.delete(slug);
}
