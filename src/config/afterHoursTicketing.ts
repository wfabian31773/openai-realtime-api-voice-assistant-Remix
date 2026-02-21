export const AFTER_HOURS_DEPARTMENT_ID = 3;

export const ANSWERING_SERVICE_DEPARTMENTS = {
  OPTICAL: 1,
  SURGERY_COORDINATION: 2,
  TECH_SUPPORT: 3,
} as const;

export type AnsweringServiceDepartment = 'optical' | 'surgery' | 'tech';

export const REQUEST_TYPES = {
  MEDICATION_REQUESTS: 6,
  PRESCRIPTION_ASSISTANCE: 7,
  PATIENT_ASSISTANCE: 8,
  CATARACT_SURGERY: 10,
  LASIK_SURGERY: 11,
  RETINAL_SURGERY: 12,
  GLAUCOMA_SURGERY: 13,
  APPOINTMENT: 8,
  MEDICATION_REFILL: 6,
  URGENT_TRANSFER: 12,
  GENERAL_INQUIRY: 8,
  PROVIDER_MESSAGE: 8,
} as const;

export const REQUEST_REASONS = {
  REFILL_REQUEST: 204,
  MEDICATION_QUESTION: 205,
  SIDE_EFFECT_CONCERN: 206,
  PRIOR_AUTHORIZATION: 207,
  RX_CLARIFICATION: 208,
  PHARMACY_TRANSFER: 209,
  LOST_EXPIRED_RX: 210,
  NEW_RX_REQUEST: 211,
  CALLBACK_REQUEST: 212,
  MEDICAL_RECORDS_REQUEST: 213,
  FORMS_COMPLETION: 214,
  REFERRAL_COORDINATION: 215,

  NEW_APPOINTMENT: 212,
  RESCHEDULE_APPOINTMENT: 212,
  CANCEL_APPOINTMENT: 212,
  APPOINTMENT_CONFIRMATION: 212,
  APPOINTMENT_AVAILABILITY: 212,
  SAME_DAY_APPOINTMENT: 212,
  SPECIALIST_REFERRAL: 215,

  PRESCRIPTION_REFILL: 204,
  EYE_DROP_REFILL: 204,
  GLAUCOMA_MEDICATION: 204,
  POST_SURGERY_MEDICATION: 204,
  CONTACT_LENS_RENEWAL: 204,

  TRANSFERRED_TO_ONCALL: 212,
  POST_SURGERY_COMPLICATION: 46,
  SUDDEN_VISION_LOSS: 53,
  EYE_INJURY_TRAUMA: 212,
  SEVERE_EYE_PAIN: 212,
  CHEMICAL_EXPOSURE: 212,
  RETINAL_DETACHMENT_SYMPTOMS: 53,

  OFFICE_HOURS_LOCATION: 212,
  INSURANCE_QUESTION: 212,
  BILLING_QUESTION: 212,
  TEST_RESULTS: 213,
  PRE_APPOINTMENT_INSTRUCTIONS: 212,
  POST_PROCEDURE_QUESTIONS: 46,
  GENERAL_MESSAGE: 212,

  MESSAGE_FOR_DOCTOR: 212,
  CALLBACK_FROM_PROVIDER: 212,
  MEDICAL_QUESTION: 205,
  FOLLOW_UP_CARE: 46,
  SECOND_OPINION: 212,
} as const;

export type TriageOutcome = 
  | 'sudden_vision_loss'
  | 'flashes_floaters_curtain'
  | 'chemical_exposure'
  | 'eye_trauma'
  | 'severe_eye_pain'
  | 'post_surgery_complication'
  | 'double_vision'
  | 'angle_closure_symptoms'
  | 'patient_insists_urgent'
  | 'medical_professional_calling'
  | 'new_appointment'
  | 'confirm_appointment'
  | 'appointment_request'  // Legacy - maps to new_appointment
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'medication_refill'
  | 'prescription_question'
  | 'billing_question'
  | 'insurance_question'
  | 'office_hours_question'
  | 'general_question'
  | 'message_for_provider'
  | 'test_results'
  | 'follow_up_care';

interface TriageMapping {
  requestTypeId: number;
  requestReasonId: number;
  priority: 'low' | 'normal' | 'medium' | 'high' | 'urgent';
  requiresTransfer: boolean;
}

export const TRIAGE_OUTCOME_MAPPINGS: Record<TriageOutcome, TriageMapping> = {
  sudden_vision_loss: {
    requestTypeId: REQUEST_TYPES.RETINAL_SURGERY,
    requestReasonId: 53,
    priority: 'urgent',
    requiresTransfer: true,
  },
  flashes_floaters_curtain: {
    requestTypeId: REQUEST_TYPES.RETINAL_SURGERY,
    requestReasonId: 53,
    priority: 'urgent',
    requiresTransfer: true,
  },
  chemical_exposure: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },
  eye_trauma: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },
  severe_eye_pain: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },
  post_surgery_complication: {
    requestTypeId: REQUEST_TYPES.CATARACT_SURGERY,
    requestReasonId: 46,
    priority: 'urgent',
    requiresTransfer: true,
  },
  double_vision: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },
  angle_closure_symptoms: {
    requestTypeId: REQUEST_TYPES.GLAUCOMA_SURGERY,
    requestReasonId: 61,
    priority: 'urgent',
    requiresTransfer: true,
  },
  patient_insists_urgent: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },
  medical_professional_calling: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'urgent',
    requiresTransfer: true,
  },

  new_appointment: {
    requestTypeId: REQUEST_TYPES.APPOINTMENT,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  confirm_appointment: {
    requestTypeId: REQUEST_TYPES.APPOINTMENT,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'low',
    requiresTransfer: false,
  },
  appointment_request: {
    requestTypeId: REQUEST_TYPES.APPOINTMENT,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  reschedule_appointment: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  cancel_appointment: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  medication_refill: {
    requestTypeId: REQUEST_TYPES.MEDICATION_REQUESTS,
    requestReasonId: REQUEST_REASONS.REFILL_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  prescription_question: {
    requestTypeId: REQUEST_TYPES.MEDICATION_REQUESTS,
    requestReasonId: REQUEST_REASONS.MEDICATION_QUESTION,
    priority: 'medium',
    requiresTransfer: false,
  },
  billing_question: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'normal',
    requiresTransfer: false,
  },
  insurance_question: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'normal',
    requiresTransfer: false,
  },
  office_hours_question: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'low',
    requiresTransfer: false,
  },
  general_question: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'normal',
    requiresTransfer: false,
  },
  message_for_provider: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.CALLBACK_REQUEST,
    priority: 'medium',
    requiresTransfer: false,
  },
  test_results: {
    requestTypeId: REQUEST_TYPES.PATIENT_ASSISTANCE,
    requestReasonId: REQUEST_REASONS.MEDICAL_RECORDS_REQUEST,
    priority: 'normal',
    requiresTransfer: false,
  },
  follow_up_care: {
    requestTypeId: REQUEST_TYPES.CATARACT_SURGERY,
    requestReasonId: 46,
    priority: 'medium',
    requiresTransfer: false,
  },
};

export function getTriageMapping(outcome: TriageOutcome): TriageMapping {
  return TRIAGE_OUTCOME_MAPPINGS[outcome] || TRIAGE_OUTCOME_MAPPINGS.general_question;
}
