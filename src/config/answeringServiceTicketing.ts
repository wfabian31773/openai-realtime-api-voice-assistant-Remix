export const ANSWERING_SERVICE_DEPARTMENTS = {
  OPTICAL: 1,
  SURGERY: 2,
  TECH: 3,
  RESEARCH: 11,
  CEC_NETWORKING: 12,
} as const;

export const DEPARTMENT_MAP: Record<string, number> = {
  optical: 1,
  surgery: 2,
  tech: 3,
  research: 11,
  cec_networking: 12,
};

export type AnsweringServiceDepartment = 'optical' | 'surgery' | 'tech' | 'research' | 'cec_networking';

export const DEFAULT_TICKET = {
  departmentId: 3,
  requestTypeId: 8,
  requestReasonId: 212,
} as const;

export const REQUEST_TYPES = {
  FRAME_SELECTION: 1,
  LENS_ISSUES: 2,
  CONTACT_LENSES: 3,
  PRODUCT_PICKUP: 5,
  MEDICATION_REQUESTS: 6,
  PRESCRIPTION_ASSISTANCE: 7,
  PATIENT_ASSISTANCE: 8,
  CATARACT_SURGERY: 10,
  LASIK_REFRACTIVE: 11,
  RETINAL_SURGERY: 12,
  OCULOPLASTIC_SURGERY: 13,
  CLINICAL_TRIAL_INQUIRY: 44,
  STUDY_PARTICIPATION: 45,
  RESEARCH_COORDINATION: 46,
  AUTHORIZATION_REQUEST: 47,
  CONTRACT_INQUIRY: 48,
  PROVIDER_NETWORK: 49,
  NETWORK_OPERATIONS: 50,
} as const;

export const REQUEST_REASONS = {
  NEW_RX_FRAME_SELECTION: 1,
  FRAME_REPAIR_NEEDED: 2,
  FRAME_ADJUSTMENT: 3,
  STYLE_CONSULTATION: 4,
  KIDS_FRAMES: 5,
  SCRATCHED_LENSES: 6,
  WRONG_PRESCRIPTION: 7,
  PROGRESSIVE_LENS_ADAPTATION: 8,
  ANTI_REFLECTIVE_COATING_QUESTION: 9,
  BLUE_LIGHT_FILTER_REQUEST: 10,
  CONTACT_LENS_ORDER: 11,
  FITTING_APPOINTMENT_NEEDED: 12,
  CONTACT_LENS_IRRITATION: 13,
  TRIAL_LENS_REQUEST: 14,
  CONTACT_LENS_EDUCATION: 15,
  GLASSES_READY_PICKUP: 20,
  CONTACT_LENSES_READY: 21,
  REMAKE_READY: 22,
  NEW_CATARACT_CONSULT: 42,
  CATARACT_SURGERY_SCHEDULING: 43,
  IOL_SELECTION_COUNSELING: 44,
  PRE_OP_MEASUREMENTS: 45,
  POST_OP_FOLLOW_UP: 46,
  SECOND_EYE_SURGERY: 47,
  LASIK_CONSULTATION: 48,
  PRK_CONSULTATION: 49,
  REFRACTIVE_SURGERY_SCHEDULING: 50,
  POST_REFRACTIVE_FOLLOW_UP: 51,
  ENHANCEMENT_EVALUATION: 52,
  RETINAL_DETACHMENT_URGENT: 53,
  VITRECTOMY_SCHEDULING: 54,
  MACULAR_HOLE_REPAIR: 55,
  EPIRETINAL_MEMBRANE_PEEL: 56,
  PTOSIS_REPAIR_CONSULT: 57,
  ECTROPION_ENTROPION_REPAIR: 58,
  BLEPHAROPLASTY_CONSULT: 59,
  CHALAZION_REMOVAL: 60,
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
  RETINA_RESEARCH: 300,
  GLAUCOMA_RESEARCH: 301,
  GENERAL_TRIAL_INFORMATION: 302,
  ELIGIBILITY_CHECK: 303,
  SCHEDULE_STUDY_VISIT: 304,
  STUDY_COMPENSATION: 305,
  SIDE_EFFECTS_REPORT: 306,
  STUDY_DOCUMENTS: 307,
  PROTOCOL_QUESTION: 308,
  DATA_REQUEST: 309,
  SPONSOR_COMMUNICATION: 310,
  IRB_INQUIRY: 311,
  NEW_AUTHORIZATION: 400,
  AUTHORIZATION_STATUS: 401,
  AUTHORIZATION_RENEWAL: 402,
  AUTHORIZATION_DENIAL_APPEAL: 403,
  CONTRACT_TERMS: 404,
  RATE_NEGOTIATION: 405,
  CONTRACT_RENEWAL: 406,
  NEW_CONTRACT_REQUEST: 407,
  PROVIDER_ENROLLMENT: 408,
  PROVIDER_STATUS: 409,
  GROUP_AFFILIATION: 410,
  CREDENTIALING: 411,
  REFERRAL_COORDINATION_CEC: 412,
  COVERAGE_VERIFICATION: 413,
  FEE_SCHEDULE: 414,
  GENERAL_INQUIRY: 415,
} as const;

export interface RequestTypeInfo {
  id: number;
  name: string;
  department: AnsweringServiceDepartment;
  keywords: string[];
}

export interface RequestReasonInfo {
  id: number;
  name: string;
  requestTypeId: number;
  keywords: string[];
}

export const REQUEST_TYPE_INFO: Record<number, RequestTypeInfo> = {
  1: { id: 1, name: 'Frame Selection', department: 'optical', keywords: ['frame', 'frames', 'glasses', 'eyeglasses', 'pick out', 'choose'] },
  2: { id: 2, name: 'Lens Issues', department: 'optical', keywords: ['lens', 'lenses', 'scratch', 'prescription', 'progressive', 'bifocal', 'coating'] },
  3: { id: 3, name: 'Contact Lenses', department: 'optical', keywords: ['contact', 'contacts', 'contact lens', 'fitting'] },
  5: { id: 5, name: 'Product Pickup', department: 'optical', keywords: ['pickup', 'pick up', 'ready', 'arrived'] },
  6: { id: 6, name: 'Medication Requests', department: 'tech', keywords: ['refill', 'medication', 'medicine', 'drops', 'eye drops', 'ran out', 'running out', 'glaucoma drops', 'restasis', 'xiidra', 'lumigan', 'latanoprost', 'timolol', 'combigan', 'steroid', 'antibiotic'] },
  7: { id: 7, name: 'Prescription Assistance', department: 'tech', keywords: ['prescription', 'rx', 'pharmacy', 'transfer', 'lost prescription', 'expired', 'new rx'] },
  8: { id: 8, name: 'Patient Assistance', department: 'tech', keywords: ['callback', 'call back', 'call me', 'records', 'forms', 'referral', 'general', 'question', 'help', 'message'] },
  10: { id: 10, name: 'Cataract Surgery', department: 'surgery', keywords: ['cataract', 'cataracts', 'cloudy', 'iol', 'lens implant'] },
  11: { id: 11, name: 'LASIK / Refractive', department: 'surgery', keywords: ['lasik', 'prk', 'refractive', 'laser', 'vision correction'] },
  12: { id: 12, name: 'Retinal Surgery', department: 'surgery', keywords: ['retina', 'retinal', 'detachment', 'vitrectomy', 'macular', 'floaters'] },
  13: { id: 13, name: 'Oculoplastic Surgery', department: 'surgery', keywords: ['eyelid', 'ptosis', 'droopy', 'blepharoplasty', 'chalazion', 'bump'] },
  44: { id: 44, name: 'Clinical Trial Inquiry', department: 'research', keywords: ['clinical trial', 'research study', 'trial', 'study'] },
  45: { id: 45, name: 'Study Participation', department: 'research', keywords: ['study visit', 'study compensation', 'participant'] },
  46: { id: 46, name: 'Research Coordination', department: 'research', keywords: ['protocol', 'irb', 'sponsor'] },
  47: { id: 47, name: 'Authorization Request', department: 'cec_networking', keywords: ['authorization', 'prior auth', 'pre-auth', 'approval'] },
  48: { id: 48, name: 'Contract Inquiry', department: 'cec_networking', keywords: ['contract', 'rate', 'negotiation'] },
  49: { id: 49, name: 'Provider Network', department: 'cec_networking', keywords: ['provider enrollment', 'credentialing', 'affiliation'] },
  50: { id: 50, name: 'Network Operations', department: 'cec_networking', keywords: ['referral', 'coverage', 'fee schedule'] },
};

export const REQUEST_REASON_INFO: Record<number, RequestReasonInfo> = {
  1: { id: 1, name: 'New Rx - Frame Selection', requestTypeId: 1, keywords: ['new prescription', 'new rx', 'pick frames', 'new glasses'] },
  2: { id: 2, name: 'Frame Repair Needed', requestTypeId: 1, keywords: ['broken', 'repair', 'fix', 'damaged'] },
  3: { id: 3, name: 'Frame Adjustment', requestTypeId: 1, keywords: ['adjust', 'loose', 'tight', 'fitting', 'uncomfortable'] },
  4: { id: 4, name: 'Style Consultation', requestTypeId: 1, keywords: ['style', 'look', 'fashion', 'recommend'] },
  5: { id: 5, name: 'Kids Frames', requestTypeId: 1, keywords: ['child', 'kid', 'pediatric', 'children'] },
  6: { id: 6, name: 'Scratched Lenses', requestTypeId: 2, keywords: ['scratch', 'scratched', 'scratches'] },
  7: { id: 7, name: 'Wrong Prescription', requestTypeId: 2, keywords: ['wrong', 'incorrect', 'not right', 'cant see', "can't see", 'blurry'] },
  8: { id: 8, name: 'Progressive Lens Adaptation', requestTypeId: 2, keywords: ['progressive', 'adapt', 'getting used to', 'trouble adjusting'] },
  9: { id: 9, name: 'Anti-Reflective Coating Question', requestTypeId: 2, keywords: ['anti-reflective', 'ar coating', 'glare', 'reflection'] },
  10: { id: 10, name: 'Blue Light Filter Request', requestTypeId: 2, keywords: ['blue light', 'computer', 'screen', 'digital'] },
  11: { id: 11, name: 'Contact Lens Order', requestTypeId: 3, keywords: ['order', 'reorder', 'more contacts', 'running out'] },
  12: { id: 12, name: 'Fitting Appointment Needed', requestTypeId: 3, keywords: ['fitting', 'fit', 'new contacts', 'first time'] },
  13: { id: 13, name: 'Contact Lens Irritation', requestTypeId: 3, keywords: ['irritation', 'irritated', 'uncomfortable', 'red', 'dry'] },
  14: { id: 14, name: 'Trial Lens Request', requestTypeId: 3, keywords: ['trial', 'try', 'sample', 'test'] },
  15: { id: 15, name: 'Contact Lens Education', requestTypeId: 3, keywords: ['how to', 'insert', 'remove', 'put in', 'take out'] },
  20: { id: 20, name: 'Glasses Ready - Pickup', requestTypeId: 5, keywords: ['glasses ready', 'pick up glasses', 'glasses arrived'] },
  21: { id: 21, name: 'Contact Lenses Ready', requestTypeId: 5, keywords: ['contacts ready', 'pick up contacts', 'contacts arrived'] },
  22: { id: 22, name: 'Remake Ready', requestTypeId: 5, keywords: ['remake', 'redo', 'replacement ready'] },
  42: { id: 42, name: 'New Cataract Consult', requestTypeId: 10, keywords: ['cataract evaluation', 'cataract consult', 'cataracts evaluation'] },
  43: { id: 43, name: 'Surgery Scheduling', requestTypeId: 10, keywords: ['schedule surgery', 'cataract surgery', 'surgery date'] },
  44: { id: 44, name: 'IOL Selection Counseling', requestTypeId: 10, keywords: ['iol', 'lens implant', 'lens options', 'premium lens'] },
  45: { id: 45, name: 'Pre-Op Measurements', requestTypeId: 10, keywords: ['pre-op', 'measurements', 'biometry'] },
  46: { id: 46, name: 'Post-Op Follow-Up', requestTypeId: 10, keywords: ['post-op', 'after surgery', 'follow up', 'post surgery'] },
  47: { id: 47, name: 'Second Eye Surgery', requestTypeId: 10, keywords: ['second eye', 'other eye', 'next eye'] },
  48: { id: 48, name: 'LASIK Consultation', requestTypeId: 11, keywords: ['lasik', 'lasik consult', 'lasik evaluation'] },
  49: { id: 49, name: 'PRK Consultation', requestTypeId: 11, keywords: ['prk', 'prk consult'] },
  50: { id: 50, name: 'Refractive Surgery Scheduling', requestTypeId: 11, keywords: ['schedule lasik', 'schedule prk', 'laser surgery'] },
  51: { id: 51, name: 'Post-Refractive Follow-Up', requestTypeId: 11, keywords: ['post lasik', 'after lasik', 'lasik follow up'] },
  52: { id: 52, name: 'Enhancement Evaluation', requestTypeId: 11, keywords: ['enhancement', 'touch up', 're-treatment'] },
  53: { id: 53, name: 'Retinal Detachment Urgent', requestTypeId: 12, keywords: ['detachment', 'curtain', 'shadow', 'sudden floaters', 'flashes'] },
  54: { id: 54, name: 'Vitrectomy Scheduling', requestTypeId: 12, keywords: ['vitrectomy', 'vitreous'] },
  55: { id: 55, name: 'Macular Hole Repair', requestTypeId: 12, keywords: ['macular hole', 'hole in macula'] },
  56: { id: 56, name: 'Epiretinal Membrane Peel', requestTypeId: 12, keywords: ['epiretinal', 'membrane', 'macular pucker'] },
  57: { id: 57, name: 'Ptosis Repair Consult', requestTypeId: 13, keywords: ['ptosis', 'droopy eyelid', 'drooping'] },
  58: { id: 58, name: 'Ectropion/Entropion Repair', requestTypeId: 13, keywords: ['ectropion', 'entropion', 'eyelid turning'] },
  59: { id: 59, name: 'Blepharoplasty Consult', requestTypeId: 13, keywords: ['blepharoplasty', 'eyelid surgery', 'cosmetic eyelid'] },
  60: { id: 60, name: 'Chalazion Removal', requestTypeId: 13, keywords: ['chalazion', 'bump on eyelid', 'stye', 'lump'] },
  204: { id: 204, name: 'Refill Request', requestTypeId: 6, keywords: ['refill', 'need more', 'ran out', 'running out', 'running low'] },
  205: { id: 205, name: 'Medication Question', requestTypeId: 6, keywords: ['medication question', 'how to use', 'dosage', 'how many times'] },
  206: { id: 206, name: 'Side Effect Concern', requestTypeId: 6, keywords: ['side effect', 'reaction', 'burning', 'stinging', 'itching'] },
  207: { id: 207, name: 'Prior Authorization', requestTypeId: 6, keywords: ['prior auth', 'authorization', 'insurance denial', 'not covered'] },
  208: { id: 208, name: 'Rx Clarification', requestTypeId: 7, keywords: ['clarify', 'clarification', 'confused', "don't understand"] },
  209: { id: 209, name: 'Pharmacy Transfer', requestTypeId: 7, keywords: ['transfer', 'different pharmacy', 'new pharmacy', 'move prescription'] },
  210: { id: 210, name: 'Lost/Expired Rx', requestTypeId: 7, keywords: ['lost', 'expired', 'old prescription', 'need new'] },
  211: { id: 211, name: 'New Rx Request', requestTypeId: 7, keywords: ['new prescription', 'need prescription', 'write prescription'] },
  212: { id: 212, name: 'Callback Request', requestTypeId: 8, keywords: ['callback', 'call back', 'call me', 'return my call', 'message', 'general'] },
  213: { id: 213, name: 'Medical Records Request', requestTypeId: 8, keywords: ['records', 'medical records', 'copy of', 'documentation'] },
  214: { id: 214, name: 'Forms Completion', requestTypeId: 8, keywords: ['form', 'forms', 'paperwork', 'fill out'] },
  215: { id: 215, name: 'Referral Coordination', requestTypeId: 8, keywords: ['referral', 'refer', 'specialist', 'another doctor'] },
  300: { id: 300, name: 'Retina Research', requestTypeId: 44, keywords: ['retina research', 'retina study', 'retina trial'] },
  301: { id: 301, name: 'Glaucoma Research', requestTypeId: 44, keywords: ['glaucoma research', 'glaucoma study', 'glaucoma trial'] },
  302: { id: 302, name: 'General Trial Information', requestTypeId: 44, keywords: ['trial info', 'study info', 'research info'] },
  303: { id: 303, name: 'Eligibility Check', requestTypeId: 44, keywords: ['eligible', 'eligibility', 'qualify', 'can i join'] },
  304: { id: 304, name: 'Schedule Study Visit', requestTypeId: 45, keywords: ['study visit', 'schedule visit', 'next visit'] },
  305: { id: 305, name: 'Study Compensation', requestTypeId: 45, keywords: ['compensation', 'payment', 'reimbursement', 'stipend'] },
  306: { id: 306, name: 'Side Effects Report', requestTypeId: 45, keywords: ['side effect', 'adverse event', 'reaction', 'problem'] },
  307: { id: 307, name: 'Study Documents', requestTypeId: 45, keywords: ['documents', 'consent', 'paperwork'] },
  308: { id: 308, name: 'Protocol Question', requestTypeId: 46, keywords: ['protocol', 'study design', 'procedure'] },
  309: { id: 309, name: 'Data Request', requestTypeId: 46, keywords: ['data', 'results', 'findings'] },
  310: { id: 310, name: 'Sponsor Communication', requestTypeId: 46, keywords: ['sponsor', 'company', 'manufacturer'] },
  311: { id: 311, name: 'IRB Inquiry', requestTypeId: 46, keywords: ['irb', 'ethics', 'review board'] },
  400: { id: 400, name: 'New Authorization', requestTypeId: 47, keywords: ['new auth', 'need authorization', 'request auth'] },
  401: { id: 401, name: 'Authorization Status', requestTypeId: 47, keywords: ['auth status', 'check authorization', 'where is my auth'] },
  402: { id: 402, name: 'Authorization Renewal', requestTypeId: 47, keywords: ['renew', 'renewal', 'extend'] },
  403: { id: 403, name: 'Authorization Denial Appeal', requestTypeId: 47, keywords: ['denied', 'appeal', 'rejected'] },
  404: { id: 404, name: 'Contract Terms', requestTypeId: 48, keywords: ['terms', 'conditions', 'agreement'] },
  405: { id: 405, name: 'Rate Negotiation', requestTypeId: 48, keywords: ['rate', 'negotiation', 'pricing'] },
  406: { id: 406, name: 'Contract Renewal', requestTypeId: 48, keywords: ['contract renewal', 'renew contract'] },
  407: { id: 407, name: 'New Contract Request', requestTypeId: 48, keywords: ['new contract', 'start contract'] },
  408: { id: 408, name: 'Provider Enrollment', requestTypeId: 49, keywords: ['enroll', 'enrollment', 'join network'] },
  409: { id: 409, name: 'Provider Status', requestTypeId: 49, keywords: ['provider status', 'am i enrolled', 'in network'] },
  410: { id: 410, name: 'Group Affiliation', requestTypeId: 49, keywords: ['group', 'affiliation', 'practice'] },
  411: { id: 411, name: 'Credentialing', requestTypeId: 49, keywords: ['credential', 'credentialing', 'recredential'] },
  412: { id: 412, name: 'Referral Coordination', requestTypeId: 50, keywords: ['referral', 'refer patient'] },
  413: { id: 413, name: 'Coverage Verification', requestTypeId: 50, keywords: ['verify coverage', 'benefits', 'covered'] },
  414: { id: 414, name: 'Fee Schedule', requestTypeId: 50, keywords: ['fee', 'schedule', 'rates'] },
  415: { id: 415, name: 'General Inquiry', requestTypeId: 50, keywords: ['question', 'inquiry', 'information'] },
};

export const LOCATIONS: Record<number, { id: number; name: string; city: string }> = {
  2: { id: 2, name: 'Anaheim', city: 'Anaheim' },
  3: { id: 3, name: 'Covina', city: 'Covina' },
  4: { id: 4, name: 'Downey', city: 'Downey' },
  5: { id: 5, name: 'Eastvale', city: 'Eastvale' },
  6: { id: 6, name: 'Encinitas', city: 'Encinitas' },
  7: { id: 7, name: 'Glendale', city: 'Glendale' },
  8: { id: 8, name: 'Glendora', city: 'Glendora' },
  9: { id: 9, name: 'Huntington Beach', city: 'Huntington Beach' },
  10: { id: 10, name: 'Indio', city: 'Indio' },
  11: { id: 11, name: 'Laguna Hills', city: 'Laguna Hills' },
  12: { id: 12, name: 'Long Beach', city: 'Long Beach' },
  13: { id: 13, name: 'Long Beach Willow', city: 'Long Beach' },
  14: { id: 14, name: 'Los Angeles', city: 'Los Angeles' },
  15: { id: 15, name: 'Mission Hills', city: 'Mission Hills' },
  16: { id: 16, name: 'Mission Viejo', city: 'Mission Viejo' },
  17: { id: 17, name: 'Monrovia', city: 'Monrovia' },
  18: { id: 18, name: 'Montebello', city: 'Montebello' },
  19: { id: 19, name: 'Northridge', city: 'Northridge' },
  20: { id: 20, name: 'Oceanside', city: 'Oceanside' },
  21: { id: 21, name: 'Palm Desert', city: 'Palm Desert' },
  22: { id: 22, name: 'Pasadena', city: 'Pasadena' },
  23: { id: 23, name: 'Rancho Cucamonga', city: 'Rancho Cucamonga' },
  24: { id: 24, name: 'Redlands', city: 'Redlands' },
  25: { id: 25, name: 'Riverside', city: 'Riverside' },
  26: { id: 26, name: 'San Bernardino', city: 'San Bernardino' },
  27: { id: 27, name: 'San Gabriel', city: 'San Gabriel' },
  28: { id: 28, name: 'Santa Ana', city: 'Santa Ana' },
  29: { id: 29, name: 'Temecula', city: 'Temecula' },
  30: { id: 30, name: 'Torrance', city: 'Torrance' },
  31: { id: 31, name: 'Tustin', city: 'Tustin' },
  32: { id: 32, name: 'Upland', city: 'Upland' },
  33: { id: 33, name: 'West Covina', city: 'West Covina' },
  34: { id: 34, name: 'Whittier', city: 'Whittier' },
};

export const PROVIDERS: Record<number, { id: number; name: string; specialty: string }> = {
  1: { id: 1, name: 'Dr. Dwayne Logan', specialty: 'Ophthalmologist' },
  2: { id: 2, name: 'Dr. Brett Tompkins', specialty: 'DO' },
  3: { id: 3, name: 'Dr. Daniel Choi', specialty: 'MD' },
  4: { id: 4, name: 'Dr. David Choi', specialty: 'MD' },
  5: { id: 5, name: 'Dr. Forrest Murphy', specialty: 'MD' },
  6: { id: 6, name: 'Dr. Francisco Pabalan', specialty: 'MD' },
  7: { id: 7, name: 'Dr. Jacob Khoubian', specialty: 'MD' },
  8: { id: 8, name: 'Dr. Janet Kim', specialty: 'MD' },
  9: { id: 9, name: 'Dr. Jay R. Patel', specialty: 'MD' },
  10: { id: 10, name: 'Dr. Kweku Grant-Acquah', specialty: 'MD' },
  11: { id: 11, name: 'Dr. Myles Brookman', specialty: 'MD' },
  12: { id: 12, name: 'Dr. Olivia Ong', specialty: 'MD' },
  13: { id: 13, name: 'Dr. Richard Casey', specialty: 'MD' },
  14: { id: 14, name: 'Dr. Sylvia Chang', specialty: 'MD' },
  15: { id: 15, name: 'Dr. Zacharia Nayer', specialty: 'MD' },
};

export type TicketPriority = 'low' | 'normal' | 'medium' | 'high' | 'urgent';
export type ConfirmationType = 'text' | 'email' | 'phone' | 'none';

export const PRIORITY_KEYWORDS: Record<TicketPriority, string[]> = {
  urgent: ['retinal detachment', 'sudden vision loss', 'severe pain', 'post-op complication', 'emergency', 'cant see', "can't see suddenly", 'chemical', 'injury', 'trauma'],
  high: ['same day', 'today', 'asap', 'running out', 'medication refill', 'urgent', 'immediately'],
  medium: ['soon', 'this week', 'next few days'],
  normal: [],
  low: ['whenever', 'no rush', 'just wondering', 'general question'],
};

export function detectPriority(text: string): TicketPriority {
  const lowerText = text.toLowerCase();
  for (const priority of ['urgent', 'high', 'medium', 'low'] as TicketPriority[]) {
    for (const keyword of PRIORITY_KEYWORDS[priority]) {
      if (lowerText.includes(keyword)) {
        return priority;
      }
    }
  }
  return 'medium';
}

export function detectDepartment(text: string): AnsweringServiceDepartment {
  const lowerText = text.toLowerCase();
  
  const surgeryKeywords = ['surgery', 'cataract', 'lasik', 'prk', 'retina', 'vitrectomy', 'pre-op', 'post-op', 'eyelid surgery', 'blepharoplasty', 'ptosis', 'detachment'];
  for (const keyword of surgeryKeywords) {
    if (lowerText.includes(keyword)) return 'surgery';
  }
  
  const researchKeywords = ['clinical trial', 'research', 'study', 'trial', 'participate'];
  for (const keyword of researchKeywords) {
    if (lowerText.includes(keyword)) return 'research';
  }
  
  const techKeywords = [
    'refill', 'medication', 'medicine', 'drops', 'eye drops', 'eyedrops', 'prescription refill',
    'rx refill', 'need drops', 'need medication', 'ran out', 'running out', 'running low',
    'glaucoma drops', 'restasis', 'xiidra', 'lumigan', 'latanoprost', 'timolol', 'combigan',
    'steroid', 'antibiotic', 'allergy drops', 'dry eye', 'artificial tears',
    'callback', 'call back', 'call me', 'records', 'referral', 'forms', 'message', 'question', 'help',
    'prescription', 'pharmacy', 'cvs', 'walgreens', 'rite aid', 'costco pharmacy'
  ];
  for (const keyword of techKeywords) {
    if (lowerText.includes(keyword)) return 'tech';
  }
  
  const cecKeywords = ['authorization', 'prior auth', 'pre-auth', 'contract', 'credentialing', 'network enrollment', 'cec', 'fee schedule'];
  for (const keyword of cecKeywords) {
    if (lowerText.includes(keyword)) return 'cec_networking';
  }
  
  const opticalKeywords = ['glasses', 'frame', 'lens', 'contact', 'pickup', 'pick up'];
  for (const keyword of opticalKeywords) {
    if (lowerText.includes(keyword)) return 'optical';
  }
  
  return 'tech';
}

export function detectRequestType(text: string, department: AnsweringServiceDepartment): number {
  const lowerText = text.toLowerCase();
  
  for (const [id, info] of Object.entries(REQUEST_TYPE_INFO)) {
    if (info.department !== department) continue;
    for (const keyword of info.keywords) {
      if (lowerText.includes(keyword)) {
        return parseInt(id);
      }
    }
  }
  
  switch (department) {
    case 'optical': return REQUEST_TYPES.FRAME_SELECTION;
    case 'surgery': return REQUEST_TYPES.CATARACT_SURGERY;
    case 'tech': return REQUEST_TYPES.PATIENT_ASSISTANCE;
    case 'research': return REQUEST_TYPES.CLINICAL_TRIAL_INQUIRY;
    case 'cec_networking': return REQUEST_TYPES.AUTHORIZATION_REQUEST;
  }
}

export function detectRequestReason(text: string, requestTypeId: number): number {
  const lowerText = text.toLowerCase();
  
  for (const [id, info] of Object.entries(REQUEST_REASON_INFO)) {
    if (info.requestTypeId !== requestTypeId) continue;
    for (const keyword of info.keywords) {
      if (lowerText.includes(keyword)) {
        return parseInt(id);
      }
    }
  }
  
  const reasonsForType = Object.entries(REQUEST_REASON_INFO)
    .filter(([_, info]) => info.requestTypeId === requestTypeId);
  
  if (reasonsForType.length > 0) {
    return parseInt(reasonsForType[0][0]);
  }
  
  return DEFAULT_TICKET.requestReasonId;
}

export function findLocationByName(text: string): number | undefined {
  const lowerText = text.toLowerCase();
  
  for (const [id, location] of Object.entries(LOCATIONS)) {
    if (lowerText.includes(location.name.toLowerCase()) || lowerText.includes(location.city.toLowerCase())) {
      return parseInt(id);
    }
  }
  
  return undefined;
}

export function findProviderByName(text: string): number | undefined {
  const lowerText = text.toLowerCase();
  
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const nameParts = provider.name.toLowerCase().replace('dr. ', '').split(' ');
    for (const part of nameParts) {
      if (part.length > 3 && lowerText.includes(part)) {
        return parseInt(id);
      }
    }
  }
  
  return undefined;
}

export function getLocationName(id: number): string {
  return LOCATIONS[id]?.name || 'Unknown Location';
}

export function getProviderName(id: number): string {
  return PROVIDERS[id]?.name || 'Unknown Provider';
}

export function getRequestTypeName(id: number): string {
  return REQUEST_TYPE_INFO[id]?.name || 'General Request';
}

export function getRequestReasonName(id: number): string {
  return REQUEST_REASON_INFO[id]?.name || 'Callback Request';
}

export function getDepartmentName(department: AnsweringServiceDepartment): string {
  switch (department) {
    case 'optical': return 'Optical Support';
    case 'surgery': return 'Surgery Coordination';
    case 'tech': return 'Tech Support';
    case 'research': return 'Research';
    case 'cec_networking': return 'CEC Networking';
  }
}

/**
 * CRITICAL: Validates and coerces department/type/reason IDs to ensure they form a 
 * consistent, FK-safe tuple. The external ticketing system enforces:
 *   - reason → type FK (requestReasonId must belong to requestTypeId)
 *   - type → department FK (requestTypeId must belong to departmentId)
 * 
 * If any ID is invalid or mismatched, we coerce to safe defaults atomically.
 */
export function getValidatedTicketIds(departmentId: number, requestTypeId: number, requestReasonId: number): { departmentId: number; requestTypeId: number; requestReasonId: number } {
  const validDepartments = [1, 2, 3, 11, 12];
  
  // Department → Type → Reason mapping for consistency
  const departmentToDefaultType: Record<number, number> = {
    1: 1,   // optical → Frame Selection
    2: 10,  // surgery → Cataract Surgery
    3: 8,   // tech → Patient Assistance
    11: 44, // research → Clinical Trial Inquiry
    12: 47, // cec_networking → Authorization Request
  };
  
  const typeToDefaultReason: Record<number, number> = {
    1: 1,    // Frame Selection → New Rx - Frame Selection
    2: 6,    // Lens Issues → Scratched Lenses
    3: 11,   // Contact Lenses → Contact Lens Order
    5: 20,   // Product Pickup → Glasses Ready Pickup
    6: 204,  // Medication Requests → Refill Request
    7: 211,  // Prescription Assistance → New RX Request
    8: 212,  // Patient Assistance → Callback Request
    10: 42,  // Cataract Surgery → New Cataract Consult
    11: 48,  // LASIK/Refractive → LASIK Consultation
    12: 53,  // Retinal Surgery → Retinal Detachment Urgent
    13: 57,  // Oculoplastic Surgery → Ptosis Repair Consult
    44: 302, // Clinical Trial Inquiry → General Trial Information
    45: 304, // Study Participation → Schedule Study Visit
    46: 308, // Research Coordination → Protocol Question
    47: 400, // Authorization Request → New Authorization
    48: 404, // Contract Inquiry → Contract Terms
    49: 408, // Provider Network → Provider Enrollment
    50: 412, // Network Operations → Referral Coordination CEC
  };
  
  // Step 1: Validate department
  let validatedDeptId = validDepartments.includes(departmentId) ? departmentId : DEFAULT_TICKET.departmentId;
  
  // Step 2: Validate type - must exist AND belong to the validated department
  const typeInfo = REQUEST_TYPE_INFO[requestTypeId];
  let validatedTypeId: number;
  
  if (typeInfo) {
    // Check if type's department matches our validated department
    const typeDept = DEPARTMENT_MAP[typeInfo.department];
    if (typeDept === validatedDeptId) {
      validatedTypeId = requestTypeId;
    } else {
      // Type exists but belongs to wrong department - use department's default type
      validatedTypeId = departmentToDefaultType[validatedDeptId] || DEFAULT_TICKET.requestTypeId;
      console.warn(`[TICKET VALIDATION] Type ${requestTypeId} belongs to dept ${typeDept}, not ${validatedDeptId} - using default type ${validatedTypeId}`);
    }
  } else {
    // Invalid type - use department's default
    validatedTypeId = departmentToDefaultType[validatedDeptId] || DEFAULT_TICKET.requestTypeId;
  }
  
  // Step 3: Validate reason - must exist AND belong to the validated type
  const reasonInfo = REQUEST_REASON_INFO[requestReasonId];
  let validatedReasonId: number;
  
  if (reasonInfo && reasonInfo.requestTypeId === validatedTypeId) {
    validatedReasonId = requestReasonId;
  } else {
    // Invalid reason or wrong type - use type's default reason
    validatedReasonId = typeToDefaultReason[validatedTypeId] || DEFAULT_TICKET.requestReasonId;
    if (reasonInfo) {
      console.warn(`[TICKET VALIDATION] Reason ${requestReasonId} belongs to type ${reasonInfo.requestTypeId}, not ${validatedTypeId} - using default reason ${validatedReasonId}`);
    }
  }
  
  return {
    departmentId: validatedDeptId,
    requestTypeId: validatedTypeId,
    requestReasonId: validatedReasonId,
  };
}

export interface AnsweringServiceTicketPayload {
  departmentId: number;
  requestTypeId: number;
  requestReasonId: number;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  patientEmail?: string;
  patientBirthMonth?: string;
  patientBirthDay?: string;
  patientBirthYear?: string;
  locationId?: number;
  providerId?: number;
  description: string;
  priority: TicketPriority;
  confirmationType?: ConfirmationType;
  callData?: {
    callSid?: string;
    callerPhone?: string;
    callDurationSeconds?: number;
  };
}
