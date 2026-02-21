import { z } from 'zod';

export type IntentType = 
  | 'appointment_confirm'
  | 'appointment_schedule' 
  | 'appointment_reschedule'
  | 'appointment_cancel'
  | 'medication_refill'
  | 'billing_question'
  | 'message_for_doctor'
  | 'general_question'
  | 'urgent_medical'
  | 'provider_call'
  | 'unknown';

export type SlotType = 
  | 'patient_first_name'
  | 'patient_last_name'
  | 'date_of_birth'
  | 'callback_number'
  | 'contact_preference'
  | 'request_summary'
  | 'medication_name'
  | 'pharmacy_name'
  | 'doctor_name'
  | 'location_preference'
  | 'appointment_date'
  | 'caller_name'
  | 'provider_facility'
  | 'urgency_symptoms';

export type WorkflowState = 
  | 'identify_intent'
  | 'collect_identity'
  | 'collect_details'
  | 'confirm_summary'
  | 'execute_action'
  | 'complete'
  | 'escalate';

export type ActionType = 
  | 'create_ticket'
  | 'answer_directly'
  | 'escalate_to_human'
  | 'end_call';

export interface SlotDefinition {
  name: SlotType;
  required: boolean;
  prompt: string;
  validator?: (value: string) => boolean;
  transformer?: (value: string) => string;
}

export interface GuardCondition {
  type: 'keyword_match' | 'slot_check' | 'intent_match' | 'schedule_check';
  config: {
    keywords?: string[];
    slotName?: SlotType;
    slotValue?: string;
    intentTypes?: IntentType[];
    scheduleField?: 'has_upcoming' | 'has_past' | 'patient_found';
  };
  action: 'escalate' | 'block' | 'allow' | 'redirect';
  redirectIntent?: IntentType;
  message?: string;
}

export interface WorkflowStep {
  id: string;
  state: WorkflowState;
  slots: SlotType[];
  guards?: GuardCondition[];
  onComplete: WorkflowState | ActionType;
  prompt?: string;
}

export interface WorkflowDefinition {
  intent: IntentType;
  name: string;
  description: string;
  requiredSlots: SlotType[];
  optionalSlots: SlotType[];
  steps: WorkflowStep[];
  escalationGuards: GuardCondition[];
  completionAction: ActionType;
  requiresTicket: boolean;
  requiresCallback: boolean;
}

export interface ConversationSlots {
  patient_first_name?: string;
  patient_last_name?: string;
  date_of_birth?: string;
  callback_number?: string;
  contact_preference?: 'phone' | 'text' | 'email';
  request_summary?: string;
  medication_name?: string;
  pharmacy_name?: string;
  doctor_name?: string;
  location_preference?: string;
  appointment_date?: string;
  caller_name?: string;
  provider_facility?: string;
  urgency_symptoms?: string;
}

export interface WorkflowContext {
  callId: string;
  currentIntent?: IntentType;
  currentState: WorkflowState;
  slots: ConversationSlots;
  scheduleContext?: {
    patientFound: boolean;
    upcomingAppointments: any[];
    pastAppointments: any[];
    lastProviderSeen?: string;
    lastLocationSeen?: string;
  };
  stateHistory: Array<{
    state: WorkflowState;
    timestamp: Date;
    slots: ConversationSlots;
  }>;
  escalationReason?: string;
  completedAt?: Date;
}

export const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  appointment_confirm: [
    'confirm', 'confirming', 'verify', 'check appointment', 'upcoming appointment',
    'is my appointment', 'do i have an appointment', 'what time is my appointment'
  ],
  appointment_schedule: [
    'schedule', 'make an appointment', 'new appointment', 'book', 'set up',
    'need to see', 'want to see the doctor', 'first available'
  ],
  appointment_reschedule: [
    'reschedule', 'change appointment', 'move appointment', 'different time',
    'different day', 'can\'t make it', 'need to change'
  ],
  appointment_cancel: [
    'cancel', 'canceling', 'cancel appointment', 'don\'t need', 'won\'t be coming'
  ],
  medication_refill: [
    'refill', 'prescription', 'medication', 'medicine', 'drops', 'pharmacy',
    'ran out', 'need more', 'renewal'
  ],
  billing_question: [
    'bill', 'billing', 'payment', 'insurance', 'cost', 'charge', 'pay',
    'statement', 'invoice', 'copay'
  ],
  message_for_doctor: [
    'message', 'tell the doctor', 'let the doctor know', 'speak to doctor',
    'talk to my doctor', 'question for doctor'
  ],
  general_question: [
    'hours', 'open', 'closed', 'address', 'location', 'fax', 'directions',
    'where are you', 'phone number'
  ],
  urgent_medical: [
    'can\'t see', 'blind', 'vision loss', 'losing vision', 'sudden',
    'severe pain', 'injury', 'trauma', 'chemical', 'bleeding', 'blood',
    'flashes and floaters', 'hit my eye', 'something in my eye'
  ],
  provider_call: [
    'doctor calling', 'nurse calling', 'hospital', 'calling from clinic',
    'dr.', 'this is nurse', 'audit', 'records request'
  ],
  unknown: []
};

export const ESCALATION_KEYWORDS = [
  'can\'t see',
  'blind', 
  'vision loss',
  'losing my vision',
  'sudden vision',
  'severe pain',
  'severe eye pain',
  'eye injury',
  'trauma',
  'chemical',
  'acid',
  'bleach',
  'bleeding',
  'blood in eye',
  'hit my eye',
  'scratched my eye',
  'foreign body',
  'flashes and floaters',
  'curtain over vision',
  'shadow in vision'
];
