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
import { createSchedulingLine, type SchedulingLineServices, type AvailabilityOffer } from './schedulingLine';
import { createTicketAgent, type TicketAgentServices } from './ticketAgent';

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

/** Lines answered by the five-step ticket agent (operator spec 2026-08-09). */
const TICKET_AGENT_LINES = new Set(
  (process.env.TICKET_AGENT_LINES ?? '').split(',').map((x) => x.trim()).filter(Boolean),
);

/**
 * The demo line (+1 626-548-2660) exists ONLY to exercise the ticket agent,
 * so it is a ticket-agent line unconditionally — no secret to set, nothing to
 * forget. Its wording is tuned live from the ticket_agent_config 'demo' row,
 * which is the whole point: iterate without a republish.
 */
const DEMO_SLUG = 'demo';
function isTicketAgentLine(slug: string): boolean {
  return slug === DEMO_SLUG || TICKET_AGENT_LINES.has(slug);
}

const modules = new Map<string, LineModule>();

/**
 * The five-step ticket agent for ANY line, regardless of the cutover secrets.
 *
 * The standalone media-stream transport (src/standalone/line.ts) is opted
 * into by pointing a phone number at its URL — that IS the switch, and it is
 * reversible in seconds without a deploy. So a line served there always gets
 * the ticket agent; there is no second lever to forget.
 */
export function ticketAgentFor(slug: string): LineModule {
  const key = `standalone:${slug}`;
  let mod = modules.get(key);
  if (!mod) {
    // The SCHEDULING line is its own machine: it offers real openings from
    // sage_availability and books them by option number through sage_book.
    // Running it here is the only way to answer the question replay could not
    // — does it actually book? — with a real call instead of an inference.
    //
    // transfer() reports false rather than dialling, because this transport
    // has no conference to hand a caller into. That is not a downgrade: the
    // line now files a scheduling callback on exactly that path, so a caller
    // it cannot hand off still leaves a record a human can act on.
    if (slug === 'azul-scheduling') {
      const sd = buildSchedulingProdServices();
      mod = createSchedulingLine({
        ...sd,
        async transfer(callId, reason) {
          console.warn(`[LINE:${slug}] transfer requested (${reason}) — no queue on this transport, filing a callback`);
          return { ok: false };
        },
      });
      modules.set(key, mod);
      return mod;
    }
    mod = createTicketAgent(buildTicketAgentServices(), {
      slug,
      humanLine:
        slug === 'no-ivr' || slug === 'after-hours'
          ? {
              en: "Our offices are closed right now — I'll take your information and make sure the right team member calls you back first thing.",
              es: 'Nuestras oficinas están cerradas — tomaré su información y me aseguraré de que el equipo le devuelva la llamada a primera hora.',
            }
          : undefined,
    });
    modules.set(key, mod);
  }
  return mod;
}

/**
 * THE verification for every line. One source of truth, on purpose.
 *
 * Until now there were three: the scheduling line called the eyecare tool
 * verify_patient_identity, the ticket agent called
 * scheduleLookupService.lookupByNameAndDOB, and the old answering service had
 * its own. Three lines meant three different meanings of "verified", and two
 * of the three were searching the APPOINTMENT book — so a patient with a
 * chart but no upcoming visit could not be verified at all. That is the whole
 * of "verification was always the toughest one".
 *
 * A match is also context: the caller's number, the person id and the person
 * number go into the ledger so the agent stops re-asking and the ticket lands
 * against the right chart, which is what the staff actually work from.
 */
async function verifyAgainstMirror(callId: string, name: string, dob: string): Promise<boolean> {
  const { verifyPatient, describeForLog } = await import('../services/patientVerification');
  const { getLedger, updateLedger } = await import('../services/callFactsLedger');
  const parts = name.trim().split(/\s+/).filter(Boolean);
  // Everything after the first token is the surname: "Maria de la Cruz" is a
  // surname of "de la Cruz", and taking only the last token would lose it.
  const first = parts[0] ?? '';
  const last = parts.slice(1).join(' ');

  const r = await verifyPatient({
    firstName: first,
    lastName: last || first, // a single spoken token is more often a surname
    dob,
    callerPhone: callId ? getLedger(callId)?.callerPhone : undefined,
  });
  if (callId) {
    console.info(describeForLog(callId, r));
    // Onto the call record too. The reason lives in a log the operator cannot
    // read, so "not verified" on a transcript was indistinguishable from a
    // missing secret, a misheard name, and a patient we genuinely do not have.
    updateLedger(callId, { verifyReason: r.reason });
  }

  if (r.verified && r.patient && callId) {
    updateLedger(callId, {
      identityVerified: true,
      personId: r.patient.personId,
      personNbr: r.patient.personNbr ?? undefined,
      hasMedicalRecord: r.patient.hasMedicalRecord,
      // The mirror's spelling, not the transcriber's. "Fabian" beats whatever
      // came off the phone line, and it is what staff will read.
      firstName: r.patient.firstName || undefined,
      lastName: r.patient.lastName || undefined,
      matchedFirstName: r.patient.firstName || undefined,
      matchedLastName: r.patient.lastName || undefined,
      matchedDob: r.patient.dob,
      // A hint for whoever picks up the ticket. NOT wired to the voice: the
      // operator's own record reads "Spanish", and driving the agent from it
      // would flip a call mid-verification.
      chartLanguage: r.patient.language ?? undefined,
    });
  }
  return r.verified;
}

function buildProdServices(): TicketLineServices {
  return {
    async verifyByLookup(first, last, dob) {
      return verifyAgainstMirror('', `${first} ${last}`, dob);
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
  if (!NEW_CORE_LINES.has(slug) && !isTicketAgentLine(slug)) return null;
  let mod = modules.get(slug);
  if (!mod) {
    // TICKET_AGENT_LINES puts the five-step ticket agent on a line, ahead of
    // every other module. One job, one file (src/core/ticketAgent.ts).
    if (isTicketAgentLine(slug)) {
      mod = createTicketAgent(buildTicketAgentServices(), {
        slug,
        humanLine:
          slug === 'no-ivr' || slug === 'after-hours'
            ? {
                en: "Our offices are closed right now — I'll take your information and make sure the right team member calls you back first thing.",
                es: 'Nuestras oficinas están cerradas — tomaré su información y me aseguraré de que el equipo le devuelva la llamada a primera hora.',
              }
            : undefined,
      });
    } else if (slug === 'answering-service') mod = createAnsweringServiceLine(buildProdServices());
    else if (slug === 'pcp') mod = createPcpLine(buildPcpProdServices());
    else if (slug === 'azul-scheduling') mod = createSchedulingLine(buildSchedulingProdServices());
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

const BUILT_LINES = new Set(['answering-service', 'pcp', 'no-ivr', 'after-hours', 'azul-scheduling']);

export function newCoreEnabled(slug: string): boolean {
  return isTicketAgentLine(slug) || (NEW_CORE_LINES.has(slug) && BUILT_LINES.has(slug));
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

function buildSchedulingProdServices(): SchedulingLineServices {
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { callEyecareTool } = await import('../agents/azulSchedulingAgent');
    const raw = await callEyecareTool(name, args);
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { error: 'unparsable tool response' };
    }
  };
  /** "next tuesday"/"tuesday" → the next such date, YYYY-MM-DD. */
  const resolveDate = (pref?: string): string | undefined => {
    if (!pref) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(pref)) return pref;
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const idx = days.indexOf(pref.toLowerCase());
    if (idx < 0) return undefined;
    const now = new Date();
    const delta = (idx - now.getDay() + 7) % 7 || 7;
    const d = new Date(now.getTime() + delta * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  return {
    async verifyIdentity(callId, first, last, dob) {
      const r = await call('verify_patient_identity', { firstName: first, lastName: last, dateOfBirth: dob, callId });
      const viaTool = Boolean(
        (r as { verified?: boolean; patientFound?: boolean }).verified ??
          (r as { patientFound?: boolean }).patientFound,
      );
      if (viaTool) return true;

      // The vendor tool said no. Before telling a patient we cannot find
      // them, check OUR OWN schedule — the same lookup the ticket agent uses,
      // and the one that finds Wayne Fabian / 1973-03-17 with 43 appointments
      // while this tool returned not-verified on four consecutive live calls.
      // Two verification paths existed and only one of them worked; a patient
      // hears "I'm not finding a match on my end" either way.
      try {
        const { scheduleLookupService } = await import('../services/scheduleLookupService');
        const ctx = await scheduleLookupService.lookupByNameAndDOB(first, last, dob);
        const viaSchedule = Boolean((ctx as { patientFound?: boolean })?.patientFound);
        if (viaSchedule) {
          console.warn(
            `[NEW-CORE][sd] verify_patient_identity said NO but our schedule found them — trusting the schedule (${callId})`,
          );
        }
        return viaSchedule;
      } catch (e) {
        console.error(`[NEW-CORE][sd] schedule fallback lookup failed for ${callId}:`, e);
        return false;
      }
    },
    async availability(callId, pref): Promise<AvailabilityOffer> {
      const r = await call('sage_availability', {
        eventName: 'Eye Exam',
        preferredDate: resolveDate(pref.preferredDate),
        timeOfDay: pref.timeOfDay,
        preferredTime: pref.preferredTime,
        providerName: pref.providerName,
        locationName: pref.locationName,
        callId,
      });
      const say = String((r as { say?: string }).say ?? '');
      if (!say) throw new Error('availability returned no directive');
      const options = ((r as { options?: Array<{ time?: string; start?: string }> }).options ?? []);
      const optionTimes = options
        .map((o) => String(o.time ?? o.start ?? ''))
        .map((x) => (x.match(/\d{2}:\d{2}/) ?? [''])[0])
        .filter(Boolean);
      return { say, optionTimes, empty: optionTimes.length === 0 };
    },
    async book(callId, input) {
      const r = await call('sage_book', { ...input, callId });
      const status = String((r as { booking_status?: string }).booking_status ?? 'failed');
      return {
        status: status === 'confirmed' ? 'confirmed' : status === 'unknown' ? 'unknown' : 'failed',
        say: (r as { say?: string }).say,
        patientScript: (r as { patient_script?: string }).patient_script,
      };
    },
    async transfer(callId, reason) {
      const binding = pcpBindings.get(callId); // same per-call dial binding
      if (!binding) return { ok: false };
      const r = await binding.handoff().catch(() => ({ ok: false }));
      if (!r.ok) console.warn(`[NEW-CORE][sd] transfer failed for ${callId}: ${reason}`);
      return { ok: Boolean(r.ok) };
    },
    /**
     * Only reachable after a promised transfer failed to connect. Files a
     * scheduling callback so "someone will call you back" is a fact rather
     * than a sentence.
     */
    async fileCallback(callId, input) {
      const { SyncAgentService } = await import('../services/syncAgentService');
      const { parseDateOfBirth } = await import('../agents/answeringServiceAgent');
      const [first, ...rest] = (input.patientName ?? 'Unknown Caller').trim().split(/\s+/);
      const dob = parseDateOfBirth(input.patientDob ?? '');
      const r = await SyncAgentService.createTicketFromAgentInput({
        firstName: first || 'Unknown',
        lastName: rest.join(' ') || 'Caller',
        birthMonth: String(dob.month ?? ''),
        birthDay: String(dob.day ?? ''),
        birthYear: String(dob.year ?? ''),
        callbackNumber: input.callbackNumber ?? '',
        requestCategory: 'general_question',
        requestSummary: input.narrative,
        departmentId: 1, // scheduling
        priority: 'medium',
        subject: 'Scheduling callback — transfer did not connect',
      });
      if (!r.success) console.error(`[NEW-CORE][sd] callback ticket FAILED for ${callId}: ${r.error ?? 'unknown'}`);
      return { ok: Boolean(r.success), ticketNumber: r.ticketNumber };
    },
  };
}

/**
 * The ticket agent's two hooks: verify, and submit. Nothing else — the whole
 * point is that this agent cannot reach anything it does not need.
 */
function buildTicketAgentServices(): TicketAgentServices {
  return {
    async classifyIntent(text) {
      const { extractIntent } = await import('./intentExtractor');
      return extractIntent(text);
    },
    async verify(callId, name, dob) {
      return verifyAgainstMirror(callId, name, dob);
    },
    async appointmentsFor(personId) {
      const { appointmentsForPerson } = await import('../services/appointmentAnswers');
      return appointmentsForPerson(personId);
    },
    async submit(_callId: string, ticket) {
      const { SyncAgentService } = await import('../services/syncAgentService');
      const { parseDateOfBirth } = await import('../agents/answeringServiceAgent');
      const f = ticket.fields;
      const [first, ...rest] = (f.patient_name ?? 'Unknown Caller').split(/\s+/);
      const dob = parseDateOfBirth(f.patient_dob ?? '');
      const description = [
        ticket.label,
        f.details ? `Request: ${f.details}` : null,
        f.fax_number ? `FAX TO: ${f.fax_number}` : null,
        f.email_address ? `EMAIL TO: ${f.email_address}` : null,
        f.office_location ? `Office: ${f.office_location}` : null,
        f.provider_name ? `Doctor: ${f.provider_name}` : null,
      ].filter(Boolean).join(' — ');
      // The phone field is a PHONE. A fax line recorded there sends staff to
      // a fax machine; an email request has no phone at all and the ticket is
      // rejected outright (review 2026-08-09). Fax and email are delivery
      // addresses for the ANSWER — they belong in their own fields, and the
      // caller's own number stays the callback.
      const { getLedger } = await import('../services/callFactsLedger');
      const facts = getLedger(_callId);
      const callerPhone = facts?.callbackNumber ?? facts?.callerPhone;
      // The association the staff work from. When verification matched a
      // person in the mirror we use THAT spelling and carry the person number
      // onto the ticket, so it opens the right chart instead of being a note
      // about a name someone tried to spell over a phone line.
      const r = await SyncAgentService.createTicketFromAgentInput({
        firstName: facts?.personId ? (facts.firstName ?? first ?? 'Unknown') : (first ?? 'Unknown'),
        lastName: facts?.personId ? (facts.lastName ?? rest.join(' ')) : (rest.join(' ') || 'Caller'),
        birthMonth: String(dob.month ?? ''),
        birthDay: String(dob.day ?? ''),
        birthYear: String(dob.year ?? ''),
        callbackNumber: f.callback_number ?? callerPhone ?? '',
        email: f.email_address ?? null,
        preferredContact: f.email_address ? 'email' : 'phone',
        requestCategory: 'general_question',
        requestSummary:
          ticket.identityVerified === true
            ? [
                description,
                '— IDENTITY VERIFIED against the patient mirror',
                facts?.personNbr ? `(patient #${facts.personNbr})` : null,
                facts?.hasMedicalRecord === false ? '(no chart on file)' : null,
                facts?.chartLanguage ? `(chart language: ${facts.chartLanguage})` : null,
              ].filter(Boolean).join(' ')
            : ticket.identityVerified === false
              ? `${description} — CALLER'S NAME/DOB NOT FOUND in the patient mirror`
              : description,
        departmentId: ticket.department,
        priority: ticket.urgent ? 'urgent' : 'medium',
        subject: ticket.label,
      });
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
