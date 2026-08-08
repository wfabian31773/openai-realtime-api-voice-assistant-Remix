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
    if (!mod) return null; // named but not yet built — old core keeps it
    modules.set(slug, mod);
  }
  return mod;
}

export function newCoreEnabled(slug: string): boolean {
  return NEW_CORE_LINES.has(slug) && (slug === 'answering-service');
}

/** Call teardown: release the call in every instantiated line module. */
export function releaseNewCoreCall(callId: string): void {
  for (const mod of modules.values()) mod.release(callId);
}

/** Test hook: inject a module (simulated services) regardless of env. */
export function _setModuleForTest(slug: string, mod: LineModule | null): void {
  if (mod) modules.set(slug, mod);
  else modules.delete(slug);
}
