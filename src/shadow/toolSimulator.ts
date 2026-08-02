/**
 * Tool-simulation layer (Checkpoint 10). Policy source: doc 06.
 *
 * This module can only DESCRIBE tool calls. It holds no HTTP client, no Twilio
 * client, no DB handle, and no import of any production tool executor — the
 * module-graph test (productionIsolation.test.ts) enforces that permanently.
 */
import { z } from 'zod';
import {
  digest,
  type ShadowConversationState,
  type ShadowReasoningResult,
  type SimulatedToolRecord,
} from './contracts';

export interface ToolPolicy {
  tool: string;
  agents: string[];
  mutating: boolean;
  viaN8nGateway: boolean;
  /** n8n workflow ID when the tool traverses the VA Gateway (doc 13). */
  n8nWorkflowId?: string;
  requiredFields: string[];
  confirmationRequired: boolean;
  argsSchema: z.ZodTypeAny;
  replayable: boolean;
  retryLimit: number;
}

const anyRecord = z.record(z.unknown());

const ticketArgs = z.object({
  patientFullName: z.string().min(1).optional(),
  callerName: z.string().min(1).optional(),
  patientPhone: z.string().min(7).optional(),
  callerPhone: z.string().min(7).optional(),
  reasonForCalling: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  idempotencyKey: z.string().optional(),
}).passthrough();

export const TOOL_POLICIES: ToolPolicy[] = [
  { tool: 'lookup_schedule', agents: ['no-ivr', 'dev-no-ivr', 'answering-service'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'check_open_tickets', agents: ['no-ivr', 'dev-no-ivr', 'answering-service'], mutating: false, viaN8nGateway: false, requiredFields: ['callerPhone'], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'classify_request', agents: ['answering-service'], mutating: false, viaN8nGateway: false, requiredFields: ['reason'], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'emit_decision', agents: ['no-ivr', 'dev-no-ivr'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'create_ticket', agents: ['no-ivr', 'dev-no-ivr', 'answering-service'], mutating: true, viaN8nGateway: true, n8nWorkflowId: 'yS1ZZG4Dt5uGwuPo', requiredFields: ['callerName', 'callerPhone', 'reason'], confirmationRequired: true, argsSchema: ticketArgs, replayable: true, retryLimit: 1 },
  { tool: 'create_after_hours_ticket', agents: ['after-hours'], mutating: true, viaN8nGateway: true, n8nWorkflowId: 'yS1ZZG4Dt5uGwuPo', requiredFields: ['callerName', 'callerPhone', 'reason'], confirmationRequired: true, argsSchema: ticketArgs, replayable: true, retryLimit: 1 },
  { tool: 'escalate_to_human', agents: ['no-ivr', 'dev-no-ivr'], mutating: true, viaN8nGateway: false, requiredFields: ['reason'], confirmationRequired: false, argsSchema: anyRecord, replayable: false, retryLimit: 1 },
  { tool: 'transfer_to_human', agents: ['after-hours'], mutating: true, viaN8nGateway: false, requiredFields: ['reason'], confirmationRequired: false, argsSchema: anyRecord, replayable: false, retryLimit: 1 },
  { tool: 'terminate_call', agents: ['no-ivr', 'dev-no-ivr', 'answering-service', 'after-hours', 'azul-scheduling', 'appointment-confirmation', 'drs-scheduler', 'fantasy-football'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  // appointment-confirmation (local DB)
  { tool: 'get_appointment', agents: ['appointment-confirmation'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'confirm_appointment', agents: ['appointment-confirmation', 'azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['patientAssent'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'reschedule_request', agents: ['appointment-confirmation'], mutating: true, viaN8nGateway: false, requiredFields: ['patientAssent'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'mark_confirmed', agents: ['appointment-confirmation'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'mark_voicemail', agents: ['appointment-confirmation'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  // drs-scheduler
  { tool: 'lookup_patient', agents: ['drs-scheduler'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 1 },
  { tool: 'mark_contact_completed', agents: ['drs-scheduler'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'phreesia_schedule', agents: ['drs-scheduler'], mutating: true, viaN8nGateway: false, requiredFields: ['patientAssent', 'appointmentSlot'], confirmationRequired: true, argsSchema: anyRecord, replayable: false, retryLimit: 0 },
  { tool: 'submit_otp', agents: ['drs-scheduler'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: true, argsSchema: anyRecord, replayable: false, retryLimit: 0 },
  // fantasy-football (read-only canary)
  { tool: 'getPlayerInfo', agents: ['fantasy-football'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'getPlayerStats', agents: ['fantasy-football'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'comparePlayers', agents: ['fantasy-football'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  { tool: 'getTopPlayers', agents: ['fantasy-football'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2 },
  // azul-scheduling — read-only sage family
  ...['sage_decision', 'sage_precontext', 'sage_patient_context', 'sage_availability', 'sage_info', 'sage_insurance_check', 'sage_practice', 'get_patient_appointments', 'get_appointment_details', 'lookup_location', 'list_locations', 'lookup_provider', 'get_provider_locations'].map((tool) => ({
    tool, agents: ['azul-scheduling'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 2,
  })),
  { tool: 'verify_patient_identity', agents: ['azul-scheduling'], mutating: false, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 3 },
  // azul-scheduling — mutating
  { tool: 'sage_book', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['identityVerified', 'offerAccepted'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'sage_reschedule', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['identityVerified', 'targetAppointment'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'sage_confirm_appointment', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['identityVerified', 'targetAppointment'], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'cancel_appointment', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['identityVerified', 'targetAppointment'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'sage_new_patient_intake', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['callerName', 'callerPhone', 'dob'], confirmationRequired: true, argsSchema: anyRecord, replayable: true, retryLimit: 0 },
  { tool: 'sage_handoff', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: ['reason'], confirmationRequired: false, argsSchema: anyRecord, replayable: true, retryLimit: 1 },
  { tool: 'transfer_to_office', agents: ['azul-scheduling'], mutating: true, viaN8nGateway: false, requiredFields: [], confirmationRequired: false, argsSchema: anyRecord, replayable: false, retryLimit: 1 },
];

const byTool = new Map<string, ToolPolicy>(TOOL_POLICIES.map((p) => [`${p.tool}`, p]));

export function getToolPolicy(tool: string): ToolPolicy | undefined {
  return byTool.get(tool);
}

/**
 * Produce a simulation-only record for a proposed tool call. Never executes.
 */
export function simulateToolCall(
  state: ShadowConversationState,
  reasoning: ShadowReasoningResult,
  tool: string,
  args: Record<string, unknown>,
): SimulatedToolRecord {
  const policy = byTool.get(tool);
  const missing: string[] = [];
  let validationCode = 'ok';
  let allowed = true;

  if (!policy) {
    return {
      tool, args, allowed: false, validationCode: 'unknown_tool', missingFields: [],
      confirmationRequired: false, executionMode: 'simulation-only', mutating: true, atTurn: state.turnCount,
    };
  }
  if (!policy.agents.includes(state.agentId)) {
    allowed = false;
    validationCode = 'tool_not_available_to_agent';
  }
  const parse = policy.argsSchema.safeParse(args);
  if (!parse.success) {
    allowed = false;
    validationCode = 'args_schema_invalid';
  }
  for (const f of policy.requiredFields) {
    if (!state.collectedFields[f] && !(f in (args ?? {})) && !reasoning.extractedFields[f]) {
      missing.push(f);
    }
  }
  if (missing.length > 0 && policy.mutating) {
    allowed = false;
    validationCode = 'missing_required_fields';
  }
  if (policy.mutating && state.completedActions.includes(tool)) {
    allowed = false;
    validationCode = 'duplicate_completed_mutation';
  }
  if ((state.retryCounts[tool] ?? 0) > policy.retryLimit) {
    allowed = false;
    validationCode = 'retry_limit_exceeded';
  }

  // Replay: does a copied production result exist for this tool this session?
  const production = state.productionToolHistory.filter((t) => t.tool === tool);
  const latest = production[production.length - 1];

  return {
    tool,
    args: parse.success ? (parse.data as Record<string, unknown>) : args,
    allowed,
    validationCode,
    missingFields: missing,
    confirmationRequired: policy.confirmationRequired,
    executionMode: 'simulation-only',
    mutating: policy.mutating,
    atTurn: state.turnCount,
    productionReplay: latest
      ? { matched: true, productionResultDigest: latest.resultDigest }
      : { matched: false },
  };
}

export function toolArgDigest(args: Record<string, unknown>): string {
  return digest(args);
}
