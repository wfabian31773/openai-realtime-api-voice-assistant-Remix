/**
 * Per-agent shadow workflow definitions (Checkpoint 9).
 * Grounded in doc 01 (agents/tools) and doc 06 (tool policies).
 * `dev-no-ivr` deliberately shares the no-ivr definition (same domain, V2 wiring).
 */
import type { WorkflowDefinition } from './workflowEngine';

const BASE_STEPS = [
  'start',
  'identify_intent',
  'collect_fields',
  'confirm',
  'validate',
  'simulate_tool',
  'simulate_n8n',
  'await_production_result',
  'interpret_result',
  'respond',
  'transfer',
  'escalate',
  'complete',
];

/** Common forward-flow transitions; every state may also 'escalate' (engine adds it). */
function baseTransitions(): Record<string, string[]> {
  return {
    start: ['identify_intent', 'collect_fields', 'respond', 'complete'],
    identify_intent: ['collect_fields', 'respond', 'confirm', 'transfer', 'complete'],
    collect_fields: ['collect_fields', 'confirm', 'validate', 'respond', 'identify_intent'],
    confirm: ['validate', 'collect_fields', 'simulate_tool', 'respond'],
    validate: ['simulate_tool', 'simulate_n8n', 'collect_fields', 'confirm', 'respond'],
    simulate_tool: ['await_production_result', 'simulate_n8n', 'interpret_result', 'respond'],
    simulate_n8n: ['await_production_result', 'interpret_result', 'respond'],
    await_production_result: ['interpret_result', 'respond', 'complete'],
    interpret_result: ['respond', 'collect_fields', 'confirm', 'simulate_tool', 'complete', 'transfer'],
    respond: ['identify_intent', 'collect_fields', 'confirm', 'complete', 'respond', 'transfer'],
    transfer: ['complete'],
    escalate: ['complete'],
    complete: [],
  };
}

const TICKET_FIELDS = ['callerName', 'callerPhone', 'reason'];

export function buildWorkflowDefinitions(): Map<string, WorkflowDefinition> {
  const defs = new Map<string, WorkflowDefinition>();

  const noIvr: WorkflowDefinition = {
    agentId: 'no-ivr',
    steps: BASE_STEPS,
    transitions: baseTransitions(),
    requiredFields: {
      ticket_request: TICKET_FIELDS,
      prescription_refill: TICKET_FIELDS,
      billing_question: TICKET_FIELDS,
      appointment_request: TICKET_FIELDS,
      callback_request: TICKET_FIELDS,
      hours_question: [],
      location_question: [],
      ticket_status: ['callerPhone'],
      urgent_symptom: ['reason'],
      other: [],
    },
    mutatingTools: ['create_ticket', 'escalate_to_human'],
    confirmationRequired: ['create_ticket'],
    retryLimit: 2,
    informationalIntents: ['hours_question', 'location_question', 'other'],
    escalationUrgency: 'urgent',
  };
  defs.set('no-ivr', noIvr);
  defs.set('dev-no-ivr', { ...noIvr, agentId: 'dev-no-ivr' });

  defs.set('answering-service', {
    ...noIvr,
    agentId: 'answering-service',
    mutatingTools: ['create_ticket'],
    confirmationRequired: ['create_ticket'],
  });

  defs.set('after-hours', {
    agentId: 'after-hours',
    steps: BASE_STEPS,
    transitions: baseTransitions(),
    requiredFields: {
      urgent_symptom: ['reason', 'callerName', 'callerPhone'],
      ticket_request: [...TICKET_FIELDS, 'urgencyAssessment'],
      appointment_request: TICKET_FIELDS,
      hours_question: [],
      other: [],
    },
    mutatingTools: ['create_after_hours_ticket', 'transfer_to_human'],
    confirmationRequired: ['create_after_hours_ticket'],
    retryLimit: 2,
    informationalIntents: ['hours_question', 'other'],
    escalationUrgency: 'urgent',
  });

  defs.set('azul-scheduling', {
    agentId: 'azul-scheduling',
    steps: ['start', 'identify_intent', 'verify_identity', ...BASE_STEPS.slice(2)],
    transitions: {
      ...baseTransitions(),
      start: ['identify_intent', 'verify_identity', 'collect_fields', 'respond', 'complete'],
      identify_intent: ['verify_identity', 'collect_fields', 'respond', 'confirm', 'transfer', 'complete'],
      verify_identity: ['verify_identity', 'collect_fields', 'respond', 'transfer', 'identify_intent'],
      collect_fields: ['collect_fields', 'confirm', 'validate', 'respond', 'identify_intent', 'verify_identity'],
    },
    requiredFields: {
      book_appointment: ['identityVerified', 'appointmentType', 'offerAccepted'],
      reschedule_appointment: ['identityVerified', 'targetAppointment', 'offerAccepted'],
      cancel_appointment: ['identityVerified', 'targetAppointment'],
      confirm_appointment: ['identityVerified', 'targetAppointment'],
      new_patient_intake: ['callerName', 'callerPhone', 'dob'],
      insurance_question: [],
      practice_question: [],
      handoff_request: ['reason'],
      other: [],
    },
    mutatingTools: [
      'sage_book',
      'sage_reschedule',
      'sage_confirm_appointment',
      'cancel_appointment',
      'sage_new_patient_intake',
      'sage_handoff',
      'transfer_to_office',
    ],
    confirmationRequired: ['sage_book', 'sage_reschedule', 'cancel_appointment', 'sage_new_patient_intake'],
    retryLimit: 2,
    informationalIntents: ['insurance_question', 'practice_question', 'other'],
    escalationUrgency: 'urgent',
  });

  defs.set('appointment-confirmation', {
    agentId: 'appointment-confirmation',
    steps: BASE_STEPS,
    transitions: baseTransitions(),
    requiredFields: {
      confirm_appointment: ['patientAssent'],
      reschedule_appointment: ['patientAssent'],
      cancel_appointment: ['patientAssent'],
      voicemail: [],
      other: [],
    },
    mutatingTools: ['confirm_appointment', 'reschedule_request', 'cancel_appointment', 'mark_confirmed', 'mark_voicemail'],
    confirmationRequired: ['confirm_appointment', 'reschedule_request', 'cancel_appointment'],
    retryLimit: 1,
    informationalIntents: ['other', 'voicemail'],
    escalationUrgency: 'urgent',
  });

  defs.set('drs-scheduler', {
    agentId: 'drs-scheduler',
    steps: BASE_STEPS,
    transitions: baseTransitions(),
    requiredFields: {
      drs_booking: ['patientAssent', 'appointmentSlot'],
      other: [],
    },
    mutatingTools: ['mark_contact_completed', 'phreesia_schedule', 'submit_otp'],
    confirmationRequired: ['phreesia_schedule'],
    retryLimit: 1,
    informationalIntents: ['other'],
    escalationUrgency: 'urgent',
  });

  defs.set('fantasy-football', {
    agentId: 'fantasy-football',
    steps: BASE_STEPS,
    transitions: baseTransitions(),
    requiredFields: { player_question: [], comparison_question: [], other: [] },
    mutatingTools: [],
    confirmationRequired: [],
    retryLimit: 2,
    informationalIntents: ['player_question', 'comparison_question', 'other'],
    escalationUrgency: 'emergency', // no medical path; effectively never
  });

  return defs;
}
