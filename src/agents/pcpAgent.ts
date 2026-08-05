import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { buildPcpPublicKnowledgePrompt } from '../config/azulVisionKnowledge';
import { pcpSafetyGuardrails } from '../guardrails/pcpSafety';
import { escalationDetailsMap } from '../services/escalationStore';
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

function requireState(callId: string): PcpConversationState & Required<Pick<PcpConversationState,
  'callerName' | 'callerRole' | 'callerOrganization' | 'callerFacilityType' | 'callbackNumber' | 'callPurpose'
>> {
  const state = pcpDirector.get(callId);
  const decision = pcpDirector.next(callId);
  if (decision.nextQuestion) throw new Error(`missing_required_field:${String(decision.nextQuestion.field)}`);
  return state as ReturnType<typeof requireState>;
}

function buildPayload(
  metadata: PcpAgentMetadata,
  state: ReturnType<typeof requireState>,
  disposition: PcpDisposition,
  narrative: string,
  urgency: 'routine' | 'normal' | 'high' | 'urgent',
  handoff?: PcpTicketPayload['handoff'],
  failureInformation?: string,
): PcpTicketPayload {
  return {
    callSid: metadata.callSid || metadata.callId,
    agentSlug: 'pcp',
    agentVersion: pcpAgentConfig.version,
    callerName: state.callerName,
    callerRole: state.callerRole,
    callerOrganization: state.callerOrganization,
    callerFacilityType: state.callerFacilityType,
    callerCallbackNumber: state.callbackNumber,
    statedRelationship: state.statedRelationship,
    callPurpose: state.callPurpose,
    disposition,
    urgency,
    verificationStatus: state.verificationStatus,
    patientFirstName: state.patientFirstName,
    patientLastName: state.patientLastName,
    patientDob: state.patientDob,
    patientMrn: state.patientMrn,
    narrative,
    transcript: metadata.getTranscript?.() || undefined,
    handoff,
    failureInformation,
  };
}

export function createPcpAgent(handoffCallback: HandoffCallback, metadata: PcpAgentMetadata): RealtimeAgent {
  const callId = metadata.callId;
  pcpDirector.update(callId, { verificationStatus: metadata.professionalVerificationStatus ?? 'pending' });

  const recordIntake = tool({
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

  const publicKnowledge = tool({
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

  const appointmentLookup = tool({
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

  const createTask = tool({
    name: 'create_pcp_task',
    description: 'Create a durable PCP Support task. Does not send patient or caller SMS.',
    parameters: z.object({
      narrative: z.string().min(1).max(12000),
      urgency: z.enum(['routine', 'normal', 'high', 'urgent']).default('normal'),
      disposition: z.enum(['CREATE_TASK', 'HAND_OFF']).default('CREATE_TASK'),
      failureInformation: z.string().max(2000).optional(),
    }),
    execute: async ({ narrative, urgency, disposition, failureInformation }) => {
      const state = requireState(callId);
      if (pcpDirector.next(callId).disposition !== disposition) {
        return { success: false, error: 'director_disposition_mismatch' };
      }
      assertPcpDisposition(state.callPurpose, disposition);
      const response = await submitPcpTicket(buildPayload(metadata, state, disposition, narrative, urgency, undefined, failureInformation));
      if (response.success) pcpDirector.recordDisposition(callId, disposition);
      return response;
    },
  });

  const recordAutomated = tool({
    name: 'record_automated_resolution',
    description: 'Record a no-ticket automated outcome, but only after an authoritative tool succeeded.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      const state = requireState(callId);
      assertPcpDisposition(state.callPurpose, 'AUTOMATE');
      const source = getPcpCallPurpose(state.callPurpose).authoritativeSource;
      if (!source || !state.completedTools.includes(source)) return { success: false, error: 'authoritative_tool_success_required' };
      const response = await submitPcpTicket(buildPayload(metadata, state, 'AUTOMATE', narrative, 'routine'));
      if (response.success) pcpDirector.recordDisposition(callId, 'AUTOMATE');
      return response;
    },
  });

  const handoff = tool({
    name: 'handoff_to_pcp',
    description: 'Create the required durable PCP ticket, then dial the configured PCP human queue. If transfer fails, update the same ticket as the fallback task.',
    parameters: z.object({ narrative: z.string().min(1).max(12000), urgency: z.enum(['normal', 'high', 'urgent']).default('high') }),
    execute: async ({ narrative, urgency }) => {
      const state = requireState(callId);
      if (!pcpDirector.next(callId).handoffEligible) return { success: false, error: 'handoff_not_eligible' };
      const requestedAt = new Date().toISOString();
      const initial = await submitPcpTicket(buildPayload(metadata, state, 'HAND_OFF', narrative, urgency, {
        requested: true, requestedAt, attempted: false, finalStatus: 'REQUESTED',
      }));
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
      const finalState = requireState(callId);
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
      }, outcome && !outcome.ok ? outcome.reason : undefined));
      if (updated.success) pcpDirector.recordDisposition(callId, finalDisposition);
      return { success: ok, handoffStatus: finalStatus, ticketNumber: initial.ticketNumber, fallbackRecorded: updated.success };
    },
  });

  const patientMedicalRecordsIntake = tool({
    name: 'handle_patient_medical_records_request',
    description: 'Create an isolated PCP manual-review task only for an explicit request for copies or release of a patient medical record. Never use for peer-to-peer or medical-group requests.',
    parameters: z.object({ narrative: z.string().min(1).max(12000) }),
    execute: async ({ narrative }) => {
      pcpDirector.update(callId, { callPurpose: 'patient_medical_records_request' });
      const ready = requireState(callId);
      const response = await submitPcpTicket(buildPayload(metadata, ready, 'CREATE_TASK', narrative, 'high', undefined, 'patient_medical_records_request_isolated'));
      if (response.success) pcpDirector.recordDisposition(callId, 'CREATE_TASK');
      return { ...response, recordsPathwayUsed: false, isolatedFromPcpPurposes: true };
    },
  });

  const terminate = tool({
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
