import { 
  type WorkflowDefinition, 
  type IntentType, 
  type SlotDefinition,
  type ConversationSlots,
} from './workflowTypes';

export type { WorkflowDefinition } from './workflowTypes';

export const SLOT_DEFINITIONS: Record<string, SlotDefinition> = {
  patient_first_name: {
    name: 'patient_first_name',
    required: true,
    prompt: 'What is your first name?',
    validator: (v) => v.length >= 2,
  },
  patient_last_name: {
    name: 'patient_last_name', 
    required: true,
    prompt: 'And your last name?',
    validator: (v) => v.length >= 2,
  },
  date_of_birth: {
    name: 'date_of_birth',
    required: true,
    prompt: 'What is your date of birth?',
    validator: (v) => /\d/.test(v),
  },
  callback_number: {
    name: 'callback_number',
    required: true,
    prompt: 'What is the best number to reach you?',
    validator: (v) => v.replace(/\D/g, '').length >= 10,
  },
  contact_preference: {
    name: 'contact_preference',
    required: false,
    prompt: 'Would you prefer we call, text, or email you back?',
  },
  medication_name: {
    name: 'medication_name',
    required: true,
    prompt: 'Which medication do you need refilled?',
  },
  pharmacy_name: {
    name: 'pharmacy_name',
    required: true,
    prompt: 'Which pharmacy should we send it to?',
  },
  doctor_name: {
    name: 'doctor_name',
    required: false,
    prompt: 'Which doctor would you like to see?',
  },
  location_preference: {
    name: 'location_preference',
    required: false,
    prompt: 'Which office location works best for you?',
  },
};

export const WORKFLOW_DEFINITIONS: Record<IntentType, WorkflowDefinition> = {
  appointment_confirm: {
    intent: 'appointment_confirm',
    name: 'Appointment Confirmation',
    description: 'Caller wants to confirm an existing appointment',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
    optionalSlots: ['callback_number'],
    steps: [
      {
        id: 'confirm_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'execute_action',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'check_schedule',
        state: 'execute_action',
        slots: [],
        onComplete: 'complete',
        guards: [
          {
            type: 'schedule_check',
            config: { scheduleField: 'has_upcoming' },
            action: 'allow',
            message: 'Found upcoming appointment - confirm directly'
          }
        ]
      }
    ],
    escalationGuards: [],
    completionAction: 'answer_directly',
    requiresTicket: false,
    requiresCallback: false,
  },

  appointment_schedule: {
    intent: 'appointment_schedule',
    name: 'New Appointment Request',
    description: 'Caller wants to schedule a new appointment',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number'],
    optionalSlots: ['doctor_name', 'location_preference', 'contact_preference'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_callback',
        state: 'collect_details',
        slots: ['callback_number', 'contact_preference'],
        onComplete: 'confirm_summary',
        prompt: 'What is the best number to reach you, and would you prefer a call, text, or email?'
      },
      {
        id: 'summarize',
        state: 'confirm_summary',
        slots: [],
        onComplete: 'execute_action',
        prompt: 'summary'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },

  appointment_reschedule: {
    intent: 'appointment_reschedule',
    name: 'Reschedule Appointment',
    description: 'Caller wants to change an existing appointment',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number'],
    optionalSlots: ['appointment_date', 'contact_preference'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_details',
        state: 'collect_details',
        slots: ['callback_number'],
        onComplete: 'confirm_summary',
        prompt: 'What number can we reach you at?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },

  appointment_cancel: {
    intent: 'appointment_cancel',
    name: 'Cancel Appointment',
    description: 'Caller wants to cancel an appointment',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
    optionalSlots: ['callback_number'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'execute_action',
        prompt: 'What is your full name and date of birth?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: false,
  },

  medication_refill: {
    intent: 'medication_refill',
    name: 'Medication Refill',
    description: 'Caller needs a prescription refill',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number', 'medication_name', 'pharmacy_name'],
    optionalSlots: ['doctor_name', 'contact_preference'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_medication',
        state: 'collect_details',
        slots: ['medication_name', 'pharmacy_name'],
        onComplete: 'collect_details',
        prompt: 'Which medication do you need refilled, and which pharmacy should we send it to?'
      },
      {
        id: 'collect_callback',
        state: 'collect_details',
        slots: ['callback_number'],
        onComplete: 'confirm_summary',
        prompt: 'What number can we reach you at?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },

  billing_question: {
    intent: 'billing_question',
    name: 'Billing Question',
    description: 'Caller has billing or insurance question',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number', 'request_summary'],
    optionalSlots: ['contact_preference'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_details',
        state: 'collect_details',
        slots: ['request_summary', 'callback_number'],
        onComplete: 'confirm_summary',
        prompt: 'What is your billing question, and what number can we reach you at?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },

  message_for_doctor: {
    intent: 'message_for_doctor',
    name: 'Message for Provider',
    description: 'Caller wants to leave a message for their doctor',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number', 'request_summary'],
    optionalSlots: ['doctor_name', 'contact_preference'],
    steps: [
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_message',
        state: 'collect_details',
        slots: ['doctor_name', 'request_summary'],
        onComplete: 'collect_details',
        prompt: 'Which doctor is this message for, and what would you like me to include?'
      },
      {
        id: 'collect_callback',
        state: 'collect_details',
        slots: ['callback_number'],
        onComplete: 'confirm_summary',
        prompt: 'What number can we reach you at?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },

  general_question: {
    intent: 'general_question',
    name: 'General Question',
    description: 'Caller has a general question (hours, location, etc.)',
    requiredSlots: [],
    optionalSlots: [],
    steps: [
      {
        id: 'answer',
        state: 'execute_action',
        slots: [],
        onComplete: 'complete',
        prompt: 'Answer the question directly from knowledge base'
      }
    ],
    escalationGuards: [],
    completionAction: 'answer_directly',
    requiresTicket: false,
    requiresCallback: false,
  },

  urgent_medical: {
    intent: 'urgent_medical',
    name: 'Urgent Medical',
    description: 'Caller describes urgent medical symptoms - MUST escalate',
    requiredSlots: ['patient_first_name', 'callback_number'],
    optionalSlots: ['patient_last_name', 'date_of_birth', 'urgency_symptoms'],
    steps: [
      {
        id: 'quick_collect',
        state: 'collect_identity',
        slots: ['patient_first_name', 'callback_number'],
        onComplete: 'escalate',
        prompt: 'I need to connect you with our on-call team. What is your name and callback number?'
      }
    ],
    escalationGuards: [
      {
        type: 'intent_match',
        config: { intentTypes: ['urgent_medical'] },
        action: 'escalate',
        message: 'Urgent medical symptoms detected - mandatory escalation'
      }
    ],
    completionAction: 'escalate_to_human',
    requiresTicket: false,
    requiresCallback: false,
  },

  provider_call: {
    intent: 'provider_call',
    name: 'Healthcare Provider Call',
    description: 'Call from another healthcare provider - MUST escalate',
    requiredSlots: ['caller_name', 'provider_facility'],
    optionalSlots: ['patient_first_name', 'patient_last_name'],
    steps: [
      {
        id: 'collect_provider_info',
        state: 'collect_identity',
        slots: ['caller_name', 'provider_facility'],
        onComplete: 'escalate',
        prompt: 'What is your name and which facility are you calling from?'
      }
    ],
    escalationGuards: [
      {
        type: 'intent_match',
        config: { intentTypes: ['provider_call'] },
        action: 'escalate',
        message: 'Healthcare provider call - mandatory escalation'
      }
    ],
    completionAction: 'escalate_to_human',
    requiresTicket: false,
    requiresCallback: false,
  },

  unknown: {
    intent: 'unknown',
    name: 'Unknown Intent',
    description: 'Cannot determine caller intent - collect info and create ticket',
    requiredSlots: ['patient_first_name', 'patient_last_name', 'date_of_birth', 'callback_number', 'request_summary'],
    optionalSlots: ['contact_preference'],
    steps: [
      {
        id: 'clarify',
        state: 'identify_intent',
        slots: [],
        onComplete: 'collect_identity',
        prompt: 'What can I help you with today?'
      },
      {
        id: 'collect_identity',
        state: 'collect_identity',
        slots: ['patient_first_name', 'patient_last_name', 'date_of_birth'],
        onComplete: 'collect_details',
        prompt: 'What is your full name and date of birth?'
      },
      {
        id: 'collect_details',
        state: 'collect_details',
        slots: ['callback_number', 'request_summary'],
        onComplete: 'confirm_summary',
        prompt: 'What number can we reach you at?'
      }
    ],
    escalationGuards: [],
    completionAction: 'create_ticket',
    requiresTicket: true,
    requiresCallback: true,
  },
};

export function getWorkflowForIntent(intent: IntentType): WorkflowDefinition {
  return WORKFLOW_DEFINITIONS[intent] || WORKFLOW_DEFINITIONS.unknown;
}

export function getMissingRequiredSlots(
  workflow: WorkflowDefinition, 
  slots: ConversationSlots
): string[] {
  return workflow.requiredSlots.filter(slotName => {
    const value = (slots as Record<string, string | undefined>)[slotName];
    return !value || value.trim() === '';
  });
}

export function canCompleteWorkflow(
  workflow: WorkflowDefinition,
  slots: ConversationSlots
): boolean {
  const missing = getMissingRequiredSlots(workflow, slots);
  return missing.length === 0;
}
