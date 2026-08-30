/**
 * The proving agent — one agent holding every registry capability at once.
 *
 * Wayne, 2026-08-30: "that one super agent, the answering service agent,
 * should be able to do absolutely everything that every other agent can do"
 * — and once it can, the pieces are meted out per agent, so specialization
 * is subtraction, not addition. This is that agent, as a SEPARATE lane: the
 * live answering-service keeps its capability boundary (standing instructions
 * 7 and 9 — no transfer tool, no booking), and this one exists to prove the
 * runtime and the tool layer end to end on a number only the operator dials.
 *
 * It follows the queue-agent pattern exactly — a plain-string prompt and a
 * list of registry tool names — because that pattern IS the architecture
 * being proven: an agent is a prompt plus an assignment of tools.
 *
 * Rollout is the operator's. Nothing routes here until a Twilio number is
 * pointed at /voice/runtime-proof, and the lane is transfer-capable, so the
 * runtime refuses it entirely unless a transfer is configured.
 */
import { RealtimeAgent } from '@openai/agents/realtime';
import { realtimeToolsFor } from '../tools/realtimeAdapter';
// Registration is an import side effect, exactly as the queue agents do it.
import '../tools/sharedPatientTools';
import '../tools/opticalTools';
import '../tools/surgeryTools';
import '../tools/techTools';
import '../tools/medicalRecordsTools';
import '../tools/generalServiceTools';
import '../tools/handoffBroker';
import { registerCallHandoff } from '../tools/handoffBroker';
import type { AzulPrecontext } from './azulSchedulingAgent';

export const runtimeProofAgentConfig = {
  slug: 'runtime-proof',
  name: 'Runtime Proving Agent',
  description:
    'Operator-only proving lane: every registry capability on one agent, for live-testing ' +
    'the voice runtime and the tool layer end to end.',
  version: '1.0.0',
  greeting: 'Thank you for calling Azul Vision. How can I help you today?',
  voice: 'sage',
  language: 'en',
} as const;

/** Every agent-layer capability the registry holds, on one agent. */
export const RUNTIME_PROOF_TOOLS: string[] = [
  // Shared patient library
  'lookup_patient',
  'resolve_location',
  'check_open_tickets',
  // The four queue classify/file pairs
  'classify_optical_request',
  'file_optical_ticket',
  'classify_surgery_request',
  'file_surgery_ticket',
  'classify_tech_request',
  'file_tech_ticket',
  'classify_records_request',
  'file_records_ticket',
  // The answering-service capabilities, registry edition
  'lookup_schedule',
  'classify_request',
  'create_ticket',
  // The transfer — real only when the runtime injected one
  'request_human_handoff',
];

export interface RuntimeProofAgentMetadata {
  callId?: string;
  callSid?: string;
  callerPhone?: string;
  dialedNumber?: string;
  callLogId?: string;
  precontext?: AzulPrecontext;
}

function buildRuntimeProofPrompt(metadata: RuntimeProofAgentMetadata): string {
  const pc = metadata.precontext;
  const known =
    pc?.matched && pc.firstName
      ? `\nThe caller's number matches a record for ${pc.firstName}. Confirm — "Am I speaking ` +
        `with ${pc.firstName}?" — never assume. A phone match is a candidate, not an identity.\n`
      : '';
  return `You are the Azul Vision assistant on the operator's proving line. Real tools, real
systems: everything you file or transfer actually happens, so treat every call
as a real patient call.
${known}
Take one request at a time. First understand what the caller needs, in their
words. Then use the tools:

For any request you can classify, classify it first (the classify tool for its
queue, or classify_request when unsure which queue), then file it with the
matching file tool or create_ticket. Confirm the callback number with the
caller BEFORE filing, never after. Read the whole request back once before you
submit, then submit without going silent — say you are filing it.

Only when a caller genuinely needs a person right now — urgent symptoms, a
distressed or unresponsive caller, a healthcare professional who must speak to
staff — use request_human_handoff. If it fails or is unavailable, say so
plainly and file a ticket for a callback instead. Never tell a caller they are
being transferred unless the tool reported success.

A tool asking for something is not a fault: it hands you the sentence to say —
say it and carry on. Never invent a name, date of birth, office or number.
Never diagnose, never give medication advice, never read a record to an
unverified caller. Everything you say is spoken aloud: no markdown, no lists.`;
}

export function createRuntimeProofAgent(
  handoffToHuman: () => Promise<void>,
  metadata: RuntimeProofAgentMetadata = {},
): RealtimeAgent {
  // The per-call transfer goes into the broker so request_human_handoff can
  // find it by call_sid — released by the runtime at teardown.
  if (metadata.callId) registerCallHandoff(metadata.callId, handoffToHuman);

  return new RealtimeAgent({
    name: runtimeProofAgentConfig.name,
    voice: runtimeProofAgentConfig.voice,
    instructions: buildRuntimeProofPrompt(metadata),
    tools: realtimeToolsFor(
      RUNTIME_PROOF_TOOLS,
      {
        call_sid: metadata.callSid ?? metadata.callId,
        caller_phone: metadata.callerPhone,
        dialed_number: metadata.dialedNumber,
      },
      {
        callId: metadata.callId,
        callSid: metadata.callSid ?? metadata.callId,
        get callLogId() {
          return metadata.callLogId;
        },
        agentSlug: 'runtime-proof',
      },
    ),
  });
}
