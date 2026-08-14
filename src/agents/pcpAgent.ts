import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { buildPcpPublicKnowledgePrompt } from '../config/azulVisionKnowledge';
import { pcpSafetyGuardrails } from '../guardrails/pcpSafety';
import { escalationDetailsMap } from '../services/escalationStore';
import { markCallConcluded } from '../services/callConclusion';
import { recordingExecute } from '../services/toolTimeline';
import { withToolDirection } from '../services/toolDirection';
import { scheduleLookupService } from '../services/scheduleLookupService';
import {
  PCP_FACILITY_TYPES,
  PROFESSIONAL_FIELDS,
  PATIENT_INTAKE_ORDER,
  PROMPTS as DIRECTOR_PROMPTS,
  pcpDirector,
  type PcpConversationState,
} from '../pcp/director';
import {
  PCP_CALL_PURPOSE_SLUGS,
  assertPcpDisposition,
  classifyPcpToolAccess,
  getPcpCallPurpose,
  type PcpDisposition,
  type PcpVerificationStatus,
} from '../pcp/policy';
import { submitPcpTicket, type PcpTicketPayload } from '../pcp/pcpTicketing';
import { getPacificTimeContext, formatPhoneForSpeech, formatPhoneLast4 } from '../utils/timeAware';

export const pcpAgentConfig = {
  slug: 'pcp',
  name: 'PCP Support Agent',
  description: 'Professional-caller support for PCP offices, referring providers, health plans, facilities, pharmacies, and related healthcare organizations.',
  version: '1.0.0',
  /**
   * THE GREETING CONTRADICTED THE PROMPT — fixed 2026-08-14.
   *
   * The prompt says "Patients ring it too, and that is not their mistake to
   * fix", and there is a whole patient_caller path below it. The greeting then
   * opened with "This line is for healthcare professionals", which tells a
   * patient in the first six seconds that they have got it wrong. 117 of 419
   * callers on this line asked for a person and a large share were patients.
   *
   * Says what the line is FOR without telling anyone they should not have
   * called it.
   */
  greeting: 'Thank you for calling Azul Vision PCP Support. How can I help you today?',
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
  /**
   * WHERE WE ACTUALLY DIALLED, on a handoff that failed.
   *
   * It used to be recorded on success only, and the cost of that shows up in
   * the 90 days to 2026-08-13: 57 PCP handoffs attempted, 11 connected, and
   * every one of the 46 failures has pcp_handoff_destination NULL. So the
   * question that decides whether PCP can go back on — was the queue DID not
   * answering, or were we still dialling the retired PCP_AGENT_DIDS roster? —
   * cannot be answered from the data at all. Every ticket that could have
   * settled it recorded nothing.
   *
   * The failures that DID record a destination tell the opposite story: all 11
   * went to +17149564300 and 9 of them connected.
   */
  destination?: string;
} | void;
type HandoffCallback = () => Promise<HandoffOutcome>;

/**
 * THE PROMPT, rewritten 2026-08-13 to sound like the rest of the fleet.
 *
 * Operator, after calling the line: "this line is completely broken, sounds
 * nothing like the other lines you created... It still has the old prompt and
 * structure and I want it to sound exactly like our other agents."
 *
 * What was wrong was not the policy — the director, the dispositions and the
 * safety rules are all correct and all preserved below. It was that the prompt
 * READ like a specification: SERVER AUTHORITY, DISPOSITIONS, a bulleted table
 * of cover lines. A model given a policy document answers like one.
 *
 * So this is the same content in the shape the queue agents use: what you do,
 * what you cannot do, how a call runs, how you speak. Nothing has been relaxed.
 * Every constraint that was in the old prompt is still here, and the two the
 * operator hit on the queue lines this morning — the callback number before
 * filing, and never going silent while a tool runs — are stated the same way
 * they are on the other four.
 */
/**
 * THE INTAKE SCRIPT, RENDERED FROM THE DIRECTOR'S OWN LISTS.
 *
 * Operator, 2026-08-14, after a live call: "we should have maybe in the prompt
 * ask these questions in order and get a response and record them in order...
 * if it's a PCP you ask these questions, if it's a patient you do this,
 * because this shit sounds crazy."
 *
 * He is right, and the cause was structural. The prompt told the model to "ask
 * only the single next question record_pcp_intake gives you" and never showed
 * it WHAT the order was. So the model invented a sequence, the director
 * corrected it a turn later, and the caller heard both — on his call the agent
 * asked for his name, then asked for his name again bundled with the medical
 * group, then jumped to the callback number. His words: "the sequencing is
 * off."
 *
 * Generating the script from PROFESSIONAL_FIELDS / PATIENT_INTAKE_ORDER and
 * PROMPTS means the prompt and the director cannot drift apart. Add a field to
 * the director and it appears here; change the wording once and both follow.
 */
function renderIntakeScript(): string {
  const line = (f: keyof PcpConversationState, i: number) =>
    `  ${i + 1}. ${DIRECTOR_PROMPTS[f] ?? String(f)}`;
  return `# THE INTAKE, IN ORDER — DO NOT IMPROVISE THE SEQUENCE

Ask ONE question. Wait for the answer. Record it with record_pcp_intake. Then
ask the next. Never bundle two, never skip ahead, and NEVER re-ask something the
caller has already answered — if you have it, move on.

A HEALTHCARE PROFESSIONAL (a clinic, a plan, a facility, a pharmacy):
${PROFESSIONAL_FIELDS.map(line).join('\n')}

A PATIENT or their family — the moment it is clear you are speaking to one,
switch to this list and never ask the professional questions:
${PATIENT_INTAKE_ORDER.map(line).join('\n')}

record_pcp_intake tells you which field is still missing. That answer is the
authority: if it names a field, ask THAT one. If it stops naming fields, stop
asking and act.

If the caller has already given you something before you asked — a name in
their opening sentence, an organization, why they are calling — record it and
skip that step. Asking for what you were just told is the fastest way to lose a
professional's confidence.`;
}

export function buildPcpPrompt(metadata: PcpAgentMetadata = {} as PcpAgentMetadata): string {
  const time = getPacificTimeContext();
  const phone = metadata.callerPhone || '';

  const callbackLine = phone
    ? `You already have their number: ${formatPhoneForSpeech(phone)} (ending ${formatPhoneLast4(phone)}). It is seeded as the callback number, so do NOT ask for one unless they offer a different line. If they do, use theirs.`
    : `Their number was withheld, so you will have to ask for a callback number.`;

  return `You answer the PCP support line at Azul Vision. ${time}

This number is published for other healthcare organizations — a clinic calling
about a mutual patient, a referral coordinator, a health plan, a peer-to-peer
request. Patients ring it too, and that is not their mistake to fix.

# WHAT YOU DO
Find out who is calling and what they need, and get it to the right team. You
either answer from an approved lookup, file a request, or connect them to the
PCP team. Nothing else.

# THE DIRECTOR DECIDES, NOT YOU
Ask only the single next question record_pcp_intake gives you, and never re-ask
something already stored. It decides which fields are missing, whether a
transfer is available, and what happens at the end of the call. If it stops
asking, stop asking.

${renderIntakeScript()}

Never invent a patient, an organization, a callback number, a verification
result, an appointment, a provider, a plan or a location. If you do not have a
fact, say so.

You do not verify anyone on the call. Take the request and let it be checked
afterwards.

# IF A PATIENT REACHES YOU, TAKE THEIR REQUEST
The moment it is clear you are speaking to a patient or their family rather than
a clinic — they say so, they ask about their own eyes, their own medication,
their own appointment, or they simply cannot answer which organization they are
calling from — record the call purpose as patient_caller.

Then STOP asking professional questions. No role, no organization, no facility
type, no professional relationship. Ask their name, a callback number, and what
they need. File it with create_pcp_task; it routes their request to the right
team and tells you which in routed_to. Use THAT name when you say what happens
next.

You cannot transfer a patient — this queue is staffed to speak with clinics. Say
so plainly: "I'm not able to put you through from this line, but I'll take this
down and the right team will call you back." Then take it.

Never say "wrong number", "wrong extension", "you've reached the provider line"
or "you'll need to call another number". They rang us, and that is enough.

# TWO THINGS ABOUT THE LAST THIRTY SECONDS OF THE CALL

THE NUMBER COMES BEFORE THE TICKET, ALWAYS. Confirming a callback number after
you have filed is not confirming it — the ticket is already a record somebody
will act on. Ask, hear the answer, THEN file. If you have already filed, do not
ask; say the number you used and stop.

NEVER GO SILENT WHILE A TOOL RUNS. The caller cannot tell silence from a dropped
line. Say a short line FIRST, then call the tool, then be quiet while it works:

  intake            "Thank you — one moment while I get that into our system."
  a lookup          "One second while I look that up for you."
  appointments      "One moment while I pull up that patient's appointments."
  filing a task     "Let me get this logged for you — one moment."
  a records request "One moment while I log that records request for you."
  connecting them   "Give me one moment while I connect you with our PCP team —
                     I'll stay right here with you."

One line per chain is enough. Never call a tool cold. If you have been quiet for
more than a few seconds for any reason, say "Still with you — one moment."

# CONNECTING SOMEONE TO A PERSON
Only the director decides whether a transfer is available. When it is, use
handoff_to_pcp — it files the request BEFORE dialling, so nothing is lost if
nobody picks up.

Never promise HOW they are being reached. One person, several, or a queue is a
configuration decision, not yours. Say you are connecting them to the PCP team
and stay on the line. Follow the holding updates; do not talk over them or start
a new question.

If it connects, say nothing further — the staff member has joined. If it does
not, say exactly that and confirm their request is already recorded for
follow-up. Never say somebody answered unless they did.

# MEDICAL RECORDS
Use handle_patient_medical_records_request ONLY when the caller explicitly asks
for copies or release of a patient's medical record. Never for peer-to-peer, a
medical group, a referral, a grievance, or anything else — those stay in their
own purpose.

# SAFETY
No diagnosis, no triage, no treatment, medication or dosage advice. If somebody
describes an emergency, tell them to hang up and dial 911 — this line's transfer
is administrative and is not an emergency path.

Public practice information you may answer from an approved lookup. Plan
participation, accessibility and accommodation questions are filed as a request.

# HOW YOU SPEAK
${callbackLine}
Speak English unless the caller asks for another language. Short sentences. One
question at a time. Do not read lists aloud, do not spell anything unless asked,
and never use markdown or bullet characters — everything you say is spoken out
loud.

Do not end the call until terminate_call confirms the outcome was recorded.

A tool asking you for something is NOT a fault. When one comes back needing a
field, say what it asks for and carry on. Never tell a caller there is a
technical problem unless a tool actually reported an error.`;
}


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
  statedRelationship: 'relationship to the patient',
  patientFirstName: 'patient first name',
  patientLastName: 'patient last name',
  patientDob: 'patient date of birth',
};

/**
 * Fields worth reporting as gaps on the ticket.
 *
 * TWO CLASSES, and missing the second is what made the first pass at this
 * incomplete. The director requires the professional block on every call, and
 * ADDITIONALLY the patient block whenever the purpose has
 * patientContextRequired and does not connect to a human — which includes
 * `patient_medical_records_request`. The live timeline showed one records call
 * burning ELEVEN attempts on `missing_required_field:statedRelationship`.
 *
 * None of these is required by the ticket schema (the patient block is all
 * optionalText), so they never block filing — but "we do not know which patient"
 * is exactly what the staffer needs told, not left to infer from a blank field.
 */
const TICKET_FIELDS = [
  'callerName', 'callerRole', 'callerOrganization', 'callerFacilityType', 'callbackNumber',
  'statedRelationship', 'patientFirstName', 'patientLastName', 'patientDob',
] as const;

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
    // The director's explicit-ask grant travels WITH the ticket, so the one
    // sanctioned exception to allowedDispositions is visible to whoever reads
    // it later rather than inferred. See PcpTicketPayloadSchema.
    ...(disposition === 'HAND_OFF' && state.callerRequestedHuman
      ? { dispositionGrantedByExplicitAsk: true }
      : {}),
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
    tool({
      ...def,
      // CP-3: the approved next line rides inside the tool result (script-listing §6).
      execute: withToolDirection('pcp', callId, def.name, recordingExecute(timelineCtx, def.name, def.execute)),
    })) as typeof tool;

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
      // A PATIENT'S REQUEST DOES NOT BELONG IN DEPARTMENT 18.
      //
      // The PCP endpoint files a professional-caller record — caller role,
      // organisation, facility type, the CAP-adjacent records pathway. None of
      // that describes a patient ringing about their own eye drops, and a
      // ticket sitting in PCP Support is one a person has to move by hand.
      //
      // So a patient files through the SAME create-ticket path and the SAME
      // cross-queue routing every other line uses: a refill reaches Clinical
      // Tech Support, glasses reach Optical, an appointment reaches the
      // scheduling hub. Nothing new was built for this — it is the machinery
      // that is already live on four queues.
      //
      // When the words match nothing, it lands on department 18's own
      // "Other - See Description" rather than being guessed at.
      if (state.callPurpose === 'patient_caller') {
        const [{ detectCrossQueue }, { otherReasonFor }, { ticketingApiClient }, { sanitizeForSms }] =
          await Promise.all([
            import('../tools/queueRouting'),
            import('../tools/otherReason'),
            import('../../server/services/ticketingApiClient'),
            import('../services/gsm7'),
          ]);

        const PCP_DEPARTMENT_ID = 18;

        // A PATIENT ASKING FOR THEIR OWN RECORDS GOES TO MEDICAL RECORDS, AND
        // ON THE CLOCK. Operator ruling, 2026-08-13.
        //
        // Nothing else routes INTO department 16 — a records team is not
        // somewhere to send a call on a keyword, and a request arriving there
        // without a known requester would let the ticketing app default the
        // `mr_cases` pathway to `roa_patient`, which is the defect that put all
        // 470 existing cases on a 15-day statutory clock.
        //
        // This path is the exception because it is the one place we KNOW: the
        // purpose IS patient_caller. So the requester is not inferred, and the
        // CAP fields go with it stated rather than defaulted. Left in
        // department 18 instead, a patient's right-of-access request is
        // invisible to the report the CAP exists to produce.
        const { classifyRecords } = await import('../tools/medicalRecordsTaxonomy');
        const recordsHit = classifyRecords(narrative);
        if (recordsHit) {
          /**
           * FILE THROUGH THE LIBRARY, NOT ALONGSIDE IT — migrated 2026-08-14.
           *
           * This block used to call `ticketingApiClient.createTicket` directly
           * with its own copy of the CAP logic. It worked, and it had already
           * drifted: `file_records_ticket` gained the operator's hard gate on
           * 2026-08-13 — "can we hard gate the records to require the
           * appropriate fields" — and this copy never did.
           *
           * So a patient's right-of-access request arriving through PCP opened
           * an `mr_cases` row with no destination and no date range, starting a
           * statutory clock nobody could actually work. That is precisely what
           * the gate exists to prevent, and it was being bypassed by the one
           * path where we KNOW the requester.
           *
           * It also missed the department-16 reason ownership guard and the
           * structured body a records clerk reads (Requested by / Send to /
           * Dates needed, each on its own line).
           *
           * One library, one records contract. A missing-field refusal comes
           * straight back to the model as a question to ask — the same envelope
           * every queue agent already answers.
           */
          const { getTool } = await import('../tools/registry');
          await import('../tools/medicalRecordsTools');
          const fileRecords = getTool('file_records_ticket');
          if (!fileRecords) {
            return { success: false, error: 'records_tool_unavailable', retryable: true };
          }

          const nameBits = String(state.callerName ?? '').trim().split(/\s+/).filter(Boolean);
          const recordsResult = (await fileRecords.handler({
            first_name: state.patientFirstName || nameBits[0] || 'Unknown',
            last_name: state.patientLastName || nameBits.slice(1).join(' ') || 'Caller',
            date_of_birth: state.patientDob ?? '',
            callback_number: String(state.callbackNumber ?? metadata.callerPhone ?? ''),
            request_description: `Patient called the PCP Support line.\n\n${narrative}`,
            request_reason_id: String(recordsHit.requestReasonId),
            // NOT inferred. The director established callPurpose ===
            // 'patient_caller', which is the one place on this line where the
            // requester is known rather than guessed — the whole reason this
            // path is allowed into department 16 at all.
            requester: `the patient themselves${state.callerName ? ` (${state.callerName})` : ''}`,
            ...(metadata.callSid ? { call_sid: metadata.callSid } : {}),
            ...(metadata.callerPhone ? { caller_phone: metadata.callerPhone } : {}),
          })) as Record<string, any>;

          // A refusal here is a question for the caller, not a fault. Hand it
          // back verbatim so the model speaks the tool's own askAs.
          if (recordsResult?.success === false) {
            return recordsResult as never;
          }

          pcpDirector.recordDisposition(callId, 'CREATE_TASK');
          console.info(
            `[PCP] patient records request filed to Medical Records as ${recordsResult.ticketNumber} ` +
              `(${recordsHit.requestReason}, via the shared library)`,
          );
          return {
            success: true,
            ticketNumber: recordsResult.ticketNumber,
            routed_to: 'Medical Records',
            message: `Filed as ${recordsResult.ticketNumber} with our medical records team. Read the ticket number back and say that team will follow up. Do not promise a date.`,
          };
        }

        const redirect = detectCrossQueue(narrative, PCP_DEPARTMENT_ID);
        // Never null for 18, but handled rather than asserted: a missing
        // catch-all must not silently file into another department's Other.
        const home = otherReasonFor(PCP_DEPARTMENT_ID);
        if (!redirect && !home) return { success: false, error: 'no_catchall_for_pcp' };
        const body = sanitizeForSms(
          [
            'Patient called the PCP Support line.',
            redirect ? redirect.note : null,
            '',
            narrative,
          ].filter((l) => l !== null).join('\n'),
        ).value;

        const nameParts = String(state.callerName ?? '').trim().split(/\s+/);
        const patientResult = await ticketingApiClient.createTicket({
          departmentId: redirect?.departmentId ?? PCP_DEPARTMENT_ID,
          requestTypeId: redirect?.requestTypeId ?? home!.requestTypeId,
          requestReasonId: redirect?.requestReasonId ?? home!.requestReasonId,
          patientFirstName: nameParts[0] || 'Unknown',
          patientLastName: nameParts.slice(1).join(' ') || 'Caller',
          patientPhone: String(state.callbackNumber ?? metadata.callerPhone ?? ''),
          preferredContactMethod: 'phone',
          description: body,
          priority: urgency === 'urgent' || urgency === 'high' ? 'high' : 'medium',
          callData: { agentUsed: 'pcp', ...(metadata.callSid ? { callSid: metadata.callSid } : {}) },
        });

        if (!patientResult.success || !patientResult.ticketNumber) {
          return { success: false, error: patientResult.error ?? 'ticket_creation_failed', retryable: true };
        }
        pcpDirector.recordDisposition(callId, 'CREATE_TASK');
        console.info(
          `[PCP] patient caller filed to ${redirect ? redirect.departmentName : 'PCP Support'} ` +
            `(dept ${redirect?.departmentId ?? PCP_DEPARTMENT_ID}) as ${patientResult.ticketNumber}`,
        );
        return {
          success: true,
          ticketNumber: patientResult.ticketNumber,
          ...(redirect ? { routed_to: redirect.departmentName } : {}),
          message: redirect
            ? `Filed as ${patientResult.ticketNumber} with our ${redirect.departmentName} team. Read the ticket number back and say that team will follow up.`
            : `Filed as ${patientResult.ticketNumber}. Read the ticket number back to the caller.`,
        };
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
      // An explicit request to be CONNECTED to a person. Deliberately narrow:
      // "caller from the front desk asking about a referral" is not a request
      // to be transferred, and dialing the queue on it would be worse than
      // the bug being fixed (review 2026-08-09).
      const askedForAPerson =
        /\b(speak|talk)\b\s+(?:to|with)\b[^.]{0,25}\b(person|human|someone|somebody|rep|representative|agent|front desk|receptionist)\b/i.test(narrative) ||
        /\b(connect|transfer|put me through|put me|get me)\b[^.]{0,25}\b(person|human|someone|somebody|rep|representative|agent|front desk|office|team)\b/i.test(narrative) ||
        /\b(live person|real person|actual person|human being)\b/i.test(narrative);
      if (askedForAPerson) pcpDirector.markCallerRequestedHuman(callId);
      // A professional who asked for a person is not blocked by a missing
      // classification (operator 2026-08-09). The purpose is still recorded
      // on the ticket; it just no longer decides whether the phone rings.
      if (!state.callPurpose && !askedForAPerson) return { success: false, error: 'call_purpose_required' };
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
      // The ticket contract requires a purpose. When the caller simply asked
      // for a person before saying why, record the generic inquiry so the
      // durable ticket validates — the staffer who picks up learns the rest
      // from the caller. Without this the payload is rejected and the dial is
      // never reached (review 2026-08-09).
      const handoffState = state.callPurpose
        ? state
        : { ...state, callPurpose: 'service_inquiry' as const };
      const initial = await submitPcpTicket(buildPayload(metadata, handoffState, 'HAND_OFF', narrative, urgency, {
        requested: true, requestedAt, attempted: false, finalStatus: 'REQUESTED',
      }, undefined, missing));
      if (!initial.success) return { success: false, error: 'durable_ticket_required_before_handoff' };

      escalationDetailsMap.set(callId, {
        agentSlug: 'pcp',
        callerRequestedHuman: askedForAPerson,
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
      const { state: rawFinalState, missing: finalMissing } = ticketState(callId);
      const finalState = rawFinalState.callPurpose
        ? rawFinalState
        : { ...rawFinalState, callPurpose: 'service_inquiry' as const };
      const updated = await submitPcpTicket(buildPayload(metadata, finalState, finalDisposition, narrative, urgency, {
        requested: true,
        requestedAt,
        attempted: true,
        attemptedAt,
        // Recorded whether or not it connected. A failed transfer with no
        // destination is an unanswerable question later; see HandoffOutcome.
        destination: outcome ? outcome.destination : undefined,
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
      if (response.ok) {
        pcpDirector.clear(callId);
        // Deliberate, successful hangup — SIP recovery must not transfer
        // this finished call.
        markCallConcluded(callId, `terminate_call:${reason}`);
      }
      return { success: response.ok, reason, status: response.status };
    },
  });

  const agent = new RealtimeAgent({
    name: pcpAgentConfig.name,
    handoffDescription: pcpAgentConfig.description,
    instructions: buildPcpPrompt(metadata),
    tools: [recordIntake, publicKnowledge, appointmentLookup, createTask, recordAutomated, handoff, patientMedicalRecordsIntake, terminate],
  });
  agent.outputGuardrails = pcpSafetyGuardrails;
  return agent;
}
