import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { buildPcpPublicKnowledgePrompt } from '../config/azulVisionKnowledge';
import { pcpSafetyGuardrails } from '../guardrails/pcpSafety';
import { escalationDetailsMap } from '../services/escalationStore';
import { recordingExecute } from '../services/toolTimeline';
import { scheduleLookupService } from '../services/scheduleLookupService';
import { PCP_FACILITY_TYPES, pcpDirector, type PcpConversationState } from '../pcp/director';
import {
  PCP_CALL_PURPOSE_SLUGS,
  assertPcpDisposition,
  classifyPcpToolAccess,
  getPcpCallPurpose,
  type PcpDisposition,
  type PcpVerificationStatus,
} from '../pcp/policy';
import { submitPcpTicket, type PcpTicketPayload } from '../pcp/pcpTicketing';

export const pcpAgentConfig = {
  slug: 'pcp',
  name: 'PCP Support Agent',
  description: 'Professional-caller support for PCP offices, referring providers, health plans, facilities, pharmacies, and related healthcare organizations.',
  version: '1.0.0',
  greeting: 'Thank you for calling Azul Vision PCP Support. This line is for healthcare professionals. How may I help you today?',
  voice: 'sage',
  language: 'en',
} as const;

export interface PcpAgentMetadata {
  callId: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  getTranscript?: () => string;
  /** Audit status maintained by staff after intake; never solicited on the call. */
  professionalVerificationStatus?: PcpVerificationStatus;
}

type PcpHandoffStatus = NonNullable<PcpTicketPayload['handoff']>['finalStatus'];
type HandoffOutcome = { ok: true; destination?: string } | {
  ok: false;
  status?: 'HANDOFF_UNAVAILABLE' | 'NO_ANSWER' | 'FAILED';
  reason?: string;
} | void;
type HandoffCallback = () => Promise<HandoffOutcome>;

const STATIC_PROMPT = `You are the Azul Vision PCP Support phone agent for callers from healthcare organizations.

SERVER AUTHORITY:
- Speak English by default. Change languages only after the caller explicitly requests another language.
- The PCP director and tools, not your judgment, decide missing fields, PHI access, disposition, retries, and handoff eligibility.
- Ask only the single nextQuestion returned by record_pcp_intake. Never re-ask a field already stored.
- Never invent a patient, organization, callback number, verification result, appointment, provider, plan, or location fact.
- Do not attempt verification on the call. Store the request as pending for staff verification after intake.
- Use handle_patient_medical_records_request only when the caller explicitly requests copies or release of a patient's medical record. Never use it for peer-to-peer, medical-group, referral, grievance, or other PCP requests; those remain in their own PCP purpose.

DISPOSITIONS:
- AUTOMATE: answer only from an allowed authoritative tool, then record_automated_resolution.
- CREATE_TASK: use create_pcp_task and read back the ticket number.
- HAND_OFF: use handoff_to_pcp. It creates the durable PCP ticket before dialing and records failure fallback.
NO DEAD AIR — NO EXCEPTIONS:
Before the FIRST tool call of ANY chain — even a quick lookup — SPEAK a short cover line, THEN call the tool. This is what a real coordinator does: the caller cannot tell silence from a dropped line. One cover per chain is enough: speak it, then run the chain quietly; the system adds holding updates if it runs long. Never, ever call a tool cold. The specific lines:
- Before record_pcp_intake: "Thank you — one moment while I get that into our system."
- Before get_public_practice_information: "One second while I look that up for you."
- Before lookup_patient_appointments: "One moment while I pull up that patient's appointments."
- Before create_pcp_task: "Let me get this logged for you — one moment."
- Before record_automated_resolution: "One moment while I record that."
- Before handle_patient_medical_records_request: "One moment while I log that records request for you."
- Before handoff_to_pcp: "Give me one moment while I connect you with our PCP team — I'll stay right here with you."
- Before terminate_call: say a brief goodbye first, then call it.
Applies to re-checks mid-conversation too, and right after collecting or re-collecting details ("Thanks — one second while I pull that up"). If you have been silent more than a few seconds for any reason, say something brief ("Still with you — one moment").
- During a transfer, follow the system's holding updates; do not talk over them or ask new questions.
- Never promise HOW the team is being reached — one person, several people, or a queue is a routing decision made by configuration, not by you. Say you are connecting them to the PCP team and stay on the line.
- If the transfer succeeds, say nothing further because the staff member has joined. If it fails, say exactly what happened and confirm that the existing PCP request will be followed up; never claim someone answered unless the warm-transfer acceptance completed.
- Never end a completed business call until terminate_call says the disposition was durably recorded.

SAFETY:
- No diagnosis, clinical triage, treatment, medication, or dosage advice.
- If a caller reports an emergency, direct them to 911. Do not repurpose the PCP administrative handoff as emergency triage.
- Public practice information may be answered without patient verification. Plan participation, accessibility, and accommodation questions require a task at launch.
- Keep a professional, concise tone and do not read sensitive details unless necessary and authorized.`;

/**
 * Administrative fields we would LIKE on a ticket, and what to write when the
 * call did not produce them.
 *
 * These are placeholders, not defaults: they exist so a request still reaches a
 * human, and they say plainly that the field is missing so nobody mistakes
 * "Not provided" for something the caller said.
 */
const FIELD_PLACEHOLDERS = {
  callerName: 'Not provided by caller',
  callerRole: 'Not provided',
  callerOrganization: 'Not provided',
  callerFacilityType: 'other_healthcare_organization' as const,
  callbackNumber: 'NOT PROVIDED',
};

/** Human-readable names for the intake gap note on the ticket. */
const FIELD_LABELS: Record<string, string> = {
  callerName: 'caller name',
  callerRole: 'caller role',
  callerOrganization: 'organization',
  callerFacilityType: 'organization type',
  callbackNumber: 'callback number',
};

const TICKET_FIELDS = ['callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber'] as const;

/**
 * The state to file a ticket from, and which administrative fields are absent.
 *
 * NEVER THROWS. It used to: `requireState` raised
 * `missing_required_field:<field>` whenever the director still wanted anything,
 * and every ticket tool called it FIRST — so one uncaptured administrative
 * field discarded the entire request. The tool timeline shipped 2026-08-06 and
 * showed the shape within ten minutes of going live:
 *
 *   e0384db1 (253s): record_pcp_intake x5, then create_pcp_task, handoff x3 and
 *                    create_pcp_task again — all ten calls dying on
 *                    missing_required_field:callbackNumber.
 *   e761053a (215s): five attempts, all missing_required_field:callerName.
 *
 * The caller heard "it seems like there was an issue recording" and nothing was
 * filed. On the same day 21 medical-records requests reached this line and left
 * no ticket at all. A caller who will not recite their job title, or who says
 * "that's the number you already have" instead of reading one out, must not
 * lose their request over it — the gap belongs ON the ticket, for staff to
 * close, not in place of it.
 */
function ticketState(callId: string): { state: PcpConversationState; missing: string[] } {
  const state = pcpDirector.get(callId);
  const missing = TICKET_FIELDS.filter((field) => !state[field]).map(String);
  return { state, missing };
}

/** Note the intake gaps on the ticket itself, in the caller's terms, so the
 *  staffer working it knows what to ask for rather than wondering. */
function annotateGaps(narrative: string, missing: string[], callerPhone?: string): string {
  if (!missing.length) return narrative;
  const labels = missing.map((f) => FIELD_LABELS[f] ?? f).join(', ');
  const ani = callerPhone && !missing.includes('callbackNumber')
    ? ''
    : callerPhone
      ? ` Inbound caller ID was ${callerPhone}.`
      : ' Caller ID was withheld on this call.';
  return `${narrative}\n\n[Intake incomplete — not captured on the call: ${labels}.${ani}]`.trim();
}

function buildPayload(
  metadata: PcpAgentMetadata,
  state: PcpConversationState,
  disposition: PcpDisposition,
  narrative: string,
  urgency: 'routine' | 'normal' | 'high' | 'urgent',
  handoff?: PcpTicketPayload['handoff'],
  failureInformation?: string,
  missing: string[] = [],
): PcpTicketPayload {
  return {
    callSid: metadata.callSid || metadata.callId,
    agentSlug: 'pcp',
    agentVersion: pcpAgentConfig.version,
    callerName: state.callerName || FIELD_PLACEHOLDERS.callerName,
    callerRole: state.callerRole || FIELD_PLACEHOLDERS.callerRole,
    callerOrganization: state.callerOrganization || FIELD_PLACEHOLDERS.callerOrganization,
    callerFacilityType: state.callerFacilityType || FIELD_PLACEHOLDERS.callerFacilityType,
    callerCallbackNumber: state.callbackNumber || FIELD_PLACEHOLDERS.callbackNumber,
    statedRelationship: state.statedRelationship,
    callPurpose: state.callPurpose!,
    disposition,
    urgency,
    verificationStatus: state.verificationStatus,
    patientFirstName: state.patientFirstName,
    patientLastName: state.patientLastName,
    patientDob: state.patientDob,
    patientMrn: state.patientMrn,
    narrative: annotateGaps(narrative, missing, metadata.callerPhone),
    transcript: metadata.getTranscript?.() || undefined,
    handoff,
    failureInformation,
  };
}

export function createPcpAgent(handoffCallback: HandoffCallback, metadata: PcpAgentMetadata): RealtimeAgent {
  const callId = metadata.callId;
  pcpDirector.update(callId, { verificationStatus: metadata.professionalVerificationStatus ?? 'pending' });

  // Seed the callback number from caller ID. We are ON A PHONE CALL with this
  // person: their number is the one piece of contact information we never have
  // to ask for, and on 2026-08-06 asking for it anyway was the single most
  // common reason a request was thrown away (`missing_required_field:
  // callbackNumber`). Professional callers routinely answer "that's the number
  // you have" — which is true, and which used to cost them their ticket.
  //
  // Seeded, not pinned: record_pcp_intake overwrites it the moment the caller
  // states a different number (a direct line or extension is better than the
  // main switchboard they happened to dial from).
  if (metadata.callerPhone && /^\+\d{10,15}$/.test(metadata.callerPhone)) {
    pcpDirector.update(callId, { callbackNumber: metadata.callerPhone });
  }

  // Tool timeline. The fleet got this on 2026-08-01; the PCP agent was added
  // on 08-03 and never inherited it, so on 08-06 all 167 PCP calls recorded
  // ZERO tool events while every other agent recorded — which is exactly why
  // "the system is blocking the ticket" could be heard on the call and not
  // explained from the data. Arguments are allow-listed inside the timeline
  // module, so no name, DOB or free text is persisted.
  // No callLogId on PcpAgentMetadata; the flush resolves by callSid, which is
  // the same fallback the other agents rely on when the id arrives late.
  const timelineCtx = { callId, callSid: metadata.callSid, agentSlug: 'pcp' };
  const recordedTool: typeof tool = ((def: any) =>
    tool({ ...def, execute: recordingExecute(timelineCtx, def.name, def.execute) })) as typeof tool;

  const recordIntake = recordedTool({
    name: 'record_pcp_intake',
    description: 'Store professional caller and request facts. Send only facts the caller actually provided. Returns exactly one next question and server policy state.',
    parameters: z.object({
      callerName: z.string().min(1).optional(),
      callerRole: z.string().min(1).optional(),
      callerOrganization: z.string().min(1).optional(),
      callerFacilityType: z.enum(PCP_FACILITY_TYPES).optional(),
      callbackNumber: z.string().min(7).optional(),
      statedRelationship: z.string().min(1).optional(),
      callPurpose: z.enum(PCP_CALL_PURPOSE_SLUGS).optional(),
      patientFirstName: z.string().min(1).optional(),
      patientLastName: z.string().min(1).optional(),
      patientDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      patientMrn: z.string().min(1).optional(),
    }).strict(),
    execute: async (facts) => {
      pcpDirector.update(callId, facts);
      return pcpDirector.next(callId);
    },
  });

  const publicKnowledge = recordedTool({
    name: 'get_public_practice_information',
    description: 'Retrieve authoritative public Azul Vision location, provider, or service information. Never use for patient, insurance participation, accessibility, or accommodation claims.',
    parameters: z.object({ topic: z.enum(['location', 'provider', 'service']) }),
    execute: async () => {
      const state = pcpDirector.get(callId);
      if (!state.callPurpose || !['service_inquiry', 'provider_information'].includes(state.callPurpose)) {
        return { success: false, error: 'public_knowledge_not_allowed_for_purpose' };
      }
      pcpDirector.recordToolSuccess(callId, 'knowledge_base');
      return { success: true, reference: buildPcpPublicKnowledgePrompt() };
    },
  });

  const appointmentLookup = recordedTool({
    name: 'lookup_patient_appointments',
    description: 'Look up schedule/attendance for a patient-specific request after the required caller and patient context is collected.',
    parameters: z.object({
      patientFirstName: z.string().min(1),
      patientLastName: z.string().min(1),
      patientDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    execute: async (patient) => {
      pcpDirector.update(callId, patient);
      const state = pcpDirector.get(callId);
      if (!state.callPurpose) return { success: false, error: 'call_purpose_required' };
      const access = classifyPcpToolAccess(state.callPurpose, state.verificationStatus);
      if (!access.allowed || access.source !== 'scheduling') return { success: false, error: access.allowed ? 'scheduling_not_allowed' : access.reason };
      try {
        const context = await scheduleLookupService.lookupByNameAndDOB(
          patient.patientFirstName,
          patient.patientLastName,
          patient.patientDob,
          { logIdentifiers: false },
        );
        pcpDirector.recordToolSuccess(callId, 'scheduling');
        return {
          success: true,
          patientFound: context.patientFound,
          upcomingAppointments: context.upcomingAppointments,
          pastAppointments: context.pastAppointments,
        };
      } catch {
        pcpDirector.recordToolFailure(callId, 'scheduling');
        return { success: false, error: 'schedule_lookup_failed', retry: pcpDirector.next(callId).authoritativeToolAllowed };
      }
    },
  });

  const createTask = recordedTool({
    name: 'create_pcp_task',
    description: 'Create a durable PCP Support task. Does not send patient or caller SMS.',
    parameters: z.object({
      narrative: z.string().min(1).max(12000),
      urgency: z.enum(['routine', 'normal', 'high', 'urgent']).default('normal'),
      disposition: z.enum(['CREATE_TASK', 'HAND_OFF']).default('CREATE_TASK'),
      failureInformation: z.string().max(2000).optional(),
    }),
    execute: async ({ narrative, urgency, disposition, failureInformation }) => {
      const { state, missing } = ticketState(callId);
      // The purpose is the one thing a ticket cannot be filed without — it is
      // what routes the request to the right desk. Everything else degrades.
      if (!state.callPurpose) return { success: false, error: 'call_purpose_required' };
      // Only the HAND_OFF direction is gated on the director. Filing a task is
      // always a safe floor, and refusing one because the director currently
      // prefers a transfer is how a request ends up as neither.
      if (disposition === 'HAND_OFF' && pcpDirector.next(callId).disposition !== 'HAND_OFF') {
        return { success: false, error: 'director_disposition_mismatch' };
      }
      const response = await submitPcpTicket(
        buildPayload(metadata, state, disposition, narrative, urgency, undefined, failureInformation, missing),
      );
      if (response.success) pcpDirector.recordDisposition(callId, disposition);
      return response;
    },
  });

  const recordAutomated = recordedTool({
    name: 'record_automated_resolution',
    description: 'Record a no-ticket automated outcome, but only after an authoritative tool succeeded.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      const { state, missing } = ticketState(callId);
      if (!state.callPurpose) return { success: false, error: 'call_purpose_required' };
      // The AUTOMATE gate is a real safety property and stays: an automated
      // resolution may only be claimed off an authoritative tool that actually
      // succeeded. It refuses structurally now rather than throwing.
      if (!getPcpCallPurpose(state.callPurpose).allowedDispositions.includes('AUTOMATE')) {
        return { success: false, error: 'automate_not_allowed_for_purpose' };
      }
      const source = getPcpCallPurpose(state.callPurpose).authoritativeSource;
      if (!source || !state.completedTools.includes(source)) return { success: false, error: 'authoritative_tool_success_required' };
      const response = await submitPcpTicket(buildPayload(metadata, state, 'AUTOMATE', narrative, 'routine', undefined, undefined, missing));
      if (response.success) pcpDirector.recordDisposition(callId, 'AUTOMATE');
      return response;
    },
  });

  const handoff = recordedTool({
    name: 'handoff_to_pcp',
    description: 'Create the required durable PCP ticket, then dial the configured PCP human queue. If transfer fails, update the same ticket as the fallback task.',
    parameters: z.object({ narrative: z.string().min(1).max(12000), urgency: z.enum(['normal', 'high', 'urgent']).default('high') }),
    execute: async ({ narrative, urgency }) => {
      const { state, missing } = ticketState(callId);
      if (!state.callPurpose) return { success: false, error: 'call_purpose_required' };
      // Not eligible to DIAL is not a reason to lose the request. Previously
      // this threw before it even reached the eligibility check, so the caller
      // got neither a transfer nor a ticket. Now the request is filed as a task
      // and the agent is told so, in the same shape it already handles for a
      // transfer that fails to connect.
      if (!pcpDirector.next(callId).handoffEligible) {
        const fallback = await submitPcpTicket(
          buildPayload(metadata, state, 'CREATE_TASK', narrative, urgency, undefined, 'handoff_not_eligible', missing),
        );
        if (fallback.success) pcpDirector.recordDisposition(callId, 'CREATE_TASK');
        return {
          success: false,
          handoffStatus: 'HANDOFF_UNAVAILABLE',
          ticketNumber: fallback.ticketNumber,
          fallbackRecorded: fallback.success,
          error: fallback.success ? 'handoff_not_eligible_task_created' : 'handoff_not_eligible',
        };
      }
      const requestedAt = new Date().toISOString();
      const initial = await submitPcpTicket(buildPayload(metadata, state, 'HAND_OFF', narrative, urgency, {
        requested: true, requestedAt, attempted: false, finalStatus: 'REQUESTED',
      }, undefined, missing));
      if (!initial.success) return { success: false, error: 'durable_ticket_required_before_handoff' };

      escalationDetailsMap.set(callId, {
        agentSlug: 'pcp',
        callerType: state.callPurpose,
        reason: narrative,
        patientFirstName: state.patientFirstName,
        patientLastName: state.patientLastName,
        patientDob: state.patientDob,
        callbackNumber: state.callbackNumber,
        providerInfo: `${state.callerRole}, ${state.callerOrganization}`,
      });
      const attemptedAt = new Date().toISOString();
      const outcome = await handoffCallback();
      const ok = Boolean(outcome && outcome.ok);
      const finalStatus: PcpHandoffStatus = ok ? 'CONNECTED' : ((outcome && !outcome.ok && outcome.status) || 'FAILED');
      pcpDirector.recordHandoffResult(callId, { status: finalStatus as PcpConversationState['handoffStatus'], reason: outcome && !outcome.ok ? outcome.reason : undefined });
      const finalDisposition: PcpDisposition = ok ? 'HAND_OFF' : 'CREATE_TASK';
      // Re-read rather than reuse: the caller may have given more during the
      // transfer narration. Non-throwing — this runs AFTER the dial, so a throw
      // here loses the outcome record on a call that really did connect.
      const { state: finalState, missing: finalMissing } = ticketState(callId);
      const updated = await submitPcpTicket(buildPayload(metadata, finalState, finalDisposition, narrative, urgency, {
        requested: true,
        requestedAt,
        attempted: true,
        attemptedAt,
        destination: outcome && outcome.ok ? outcome.destination : undefined,
        humanAnswerStatus: finalStatus,
        connectedAt: ok ? new Date().toISOString() : undefined,
        finalStatus,
        failureReason: outcome && !outcome.ok ? outcome.reason : undefined,
        fallbackTicketStatus: ok ? undefined : 'OPEN',
      }, outcome && !outcome.ok ? outcome.reason : undefined, finalMissing));
      if (updated.success) pcpDirector.recordDisposition(callId, finalDisposition);
      return { success: ok, handoffStatus: finalStatus, ticketNumber: initial.ticketNumber, fallbackRecorded: updated.success };
    },
  });

  const patientMedicalRecordsIntake = recordedTool({
    name: 'handle_patient_medical_records_request',
    description: 'Create an isolated PCP manual-review task only for an explicit request for copies or release of a patient medical record. Never use for peer-to-peer or medical-group requests.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      pcpDirector.update(callId, { callPurpose: 'patient_medical_records_request' });
      // Files with whatever intake produced. On 2026-08-06 this tool threw on a
      // missing administrative field like every other, and 21 records requests
      // reached this line with nothing filed behind them — including patients
      // asking for their own records, and one caller who rang back eight
      // minutes later and got nothing a second time. A records request is not
      // discardable for want of a job title.
      const { state, missing } = ticketState(callId);
      const response = await submitPcpTicket(
        buildPayload(metadata, state, 'CREATE_TASK', narrative, 'high', undefined, 'patient_medical_records_request_isolated', missing),
      );
      if (response.success) pcpDirector.recordDisposition(callId, 'CREATE_TASK');
      return { ...response, recordsPathwayUsed: false, isolatedFromPcpPurposes: true };
    },
  });

  const terminate = recordedTool({
    name: 'terminate_call',
    description: 'End the call only after the PCP director confirms the disposition is durably recorded.',
    parameters: z.object({ reason: z.enum(['completed', 'caller_declined', 'ghost_call', 'spam']) }),
    execute: async ({ reason }) => {
      if (!pcpDirector.next(callId).mayTerminate) return { success: false, error: 'durable_disposition_required' };
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return { success: false, error: 'missing_api_key' };
      const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) pcpDirector.clear(callId);
      return { success: response.ok, reason, status: response.status };
    },
  });

  const agent = new RealtimeAgent({
    name: pcpAgentConfig.name,
    handoffDescription: pcpAgentConfig.description,
    instructions: STATIC_PROMPT,
    tools: [recordIntake, publicKnowledge, appointmentLookup, createTask, recordAutomated, handoff, patientMedicalRecordsIntake, terminate],
  });
  agent.outputGuardrails = pcpSafetyGuardrails;
  return agent;
}
