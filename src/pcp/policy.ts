export const PCP_DISPOSITIONS = ['AUTOMATE', 'CREATE_TASK', 'HAND_OFF'] as const;
export type PcpDisposition = (typeof PCP_DISPOSITIONS)[number];

export const PCP_CALL_PURPOSE_SLUGS = [
  'schedule_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'notify_referral_approval',
  'check_patient_scheduled',
  'check_patient_kept_appointment',
  'outside_referral_status',
  'accessibility_survey',
  'new_patient_survey',
  'service_inquiry',
  'disability_accommodation',
  'provider_information',
  'plan_participation',
  'health_plan_visit_inquiry',
  'grievance_follow_up',
  'peer_to_peer',
  'patient_medical_records_request',
  'pharmaceutical_representative',
  'patient_caller',
] as const;

export type PcpCallPurposeSlug = (typeof PCP_CALL_PURPOSE_SLUGS)[number];
export type PcpVerificationStatus = 'not_required' | 'pending' | 'verified' | 'failed';
export type PcpAuthoritativeSource = 'scheduling' | 'knowledge_base' | null;

export type PcpCallPurpose = {
  slug: PcpCallPurposeSlug;
  defaultDisposition: PcpDisposition;
  allowedDispositions: readonly PcpDisposition[];
  patientContextRequired: boolean;
  authoritativeSource: PcpAuthoritativeSource;
  containsPhi: boolean;
};

export const PCP_CALL_PURPOSES: readonly PcpCallPurpose[] = [
  // Scheduling requests hand off to the PCP queue. These carried HAND_OFF in
  // allowedDispositions but defaulted to CREATE_TASK, and the director only offers a
  // transfer when the DEFAULT is HAND_OFF (see director.next) — so a scheduling caller
  // could never be connected to anyone. It was also the dominant purpose in
  // production: 8 of 10 PCP tickets in the first 24 hours were schedule_appointment,
  // every one filed as a task with handoff status NOT_REQUESTED. A failed transfer
  // still degrades to CREATE_TASK via the handoffFailed path, so the task-filing
  // behavior remains the floor rather than the ceiling.
  // The PCP line CANNOT schedule. Scheduling is only set up for San Diego and PCPs
  // call from everywhere, so a scheduling request must reach a human in the PCP queue.
  // AUTOMATE is therefore not permitted on these purposes: with it allowed, the agent
  // could call record_automated_resolution off a read-only appointment lookup and
  // represent a booking that never happened. HAND_OFF is the default; CREATE_TASK
  // remains only as the fallback when the transfer does not connect.
  { slug: 'schedule_appointment', defaultDisposition: 'HAND_OFF', allowedDispositions: ['CREATE_TASK', 'HAND_OFF'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'reschedule_appointment', defaultDisposition: 'HAND_OFF', allowedDispositions: ['CREATE_TASK', 'HAND_OFF'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'cancel_appointment', defaultDisposition: 'HAND_OFF', allowedDispositions: ['CREATE_TASK', 'HAND_OFF'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'notify_referral_approval', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'check_patient_scheduled', defaultDisposition: 'AUTOMATE', allowedDispositions: ['AUTOMATE', 'CREATE_TASK'], patientContextRequired: true, authoritativeSource: 'scheduling', containsPhi: true },
  { slug: 'check_patient_kept_appointment', defaultDisposition: 'AUTOMATE', allowedDispositions: ['AUTOMATE', 'CREATE_TASK'], patientContextRequired: true, authoritativeSource: 'scheduling', containsPhi: true },
  { slug: 'outside_referral_status', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'accessibility_survey', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: false, authoritativeSource: null, containsPhi: false },
  { slug: 'new_patient_survey', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: false, authoritativeSource: null, containsPhi: false },
  { slug: 'service_inquiry', defaultDisposition: 'AUTOMATE', allowedDispositions: ['AUTOMATE', 'CREATE_TASK'], patientContextRequired: false, authoritativeSource: 'knowledge_base', containsPhi: false },
  { slug: 'disability_accommodation', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: false, authoritativeSource: null, containsPhi: false },
  { slug: 'provider_information', defaultDisposition: 'AUTOMATE', allowedDispositions: ['AUTOMATE', 'CREATE_TASK'], patientContextRequired: false, authoritativeSource: 'knowledge_base', containsPhi: false },
  { slug: 'plan_participation', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: false, authoritativeSource: null, containsPhi: false },
  { slug: 'health_plan_visit_inquiry', defaultDisposition: 'HAND_OFF', allowedDispositions: ['HAND_OFF', 'CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'grievance_follow_up', defaultDisposition: 'HAND_OFF', allowedDispositions: ['HAND_OFF', 'CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'peer_to_peer', defaultDisposition: 'HAND_OFF', allowedDispositions: ['HAND_OFF', 'CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  { slug: 'patient_medical_records_request', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: true, authoritativeSource: null, containsPhi: true },
  // A PATIENT REACHED THE PROFESSIONAL LINE, which happens constantly.
  //
  // Measured over PCP's only two full days (2026-08-06/07, 419 calls): 117
  // callers asked for a person or an operator, and the transcripts are full of
  // patients — "I want to call the doctor office and I want the refer some my
  // eye doctor medicine", "My doctor requested a pharmacy". The prompt opens
  // "this line is for healthcare professionals", the intake asks for a role and
  // an organisation, and handoffPolicy refuses a transfer for any caller type
  // that is not a PCP one. So a patient on this line had no path at all.
  //
  // CREATE_TASK ONLY, and that is load-bearing twice over. PCP_CALLER_TYPES in
  // handoffPolicy is DERIVED from the purposes that allow HAND_OFF, so leaving
  // it off this list is what stops a patient being dialled into the PCP
  // queue — a queue staffed to talk to clinics, not to patients. The derived
  // set means nobody has to remember to add an exclusion.
  //
  // The ticket does not stay in department 18 either: create_pcp_task files a
  // patient's request through the same cross-queue routing every other line
  // uses, so a refill reaches Clinical Tech Support and an appointment reaches
  // the scheduling hub. Nobody is told to call back — the operator's ruling.
  { slug: 'patient_caller', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK'], patientContextRequired: false, authoritativeSource: null, containsPhi: true },
  { slug: 'pharmaceutical_representative', defaultDisposition: 'CREATE_TASK', allowedDispositions: ['CREATE_TASK', 'HAND_OFF'], patientContextRequired: false, authoritativeSource: null, containsPhi: false },
];

const PURPOSES = new Map(PCP_CALL_PURPOSES.map((purpose) => [purpose.slug, purpose]));

export function getPcpCallPurpose(slug: PcpCallPurposeSlug): PcpCallPurpose {
  const purpose = PURPOSES.get(slug);
  if (!purpose) throw new Error(`Unknown PCP call purpose: ${slug}`);
  return purpose;
}

export function assertPcpDisposition(slug: PcpCallPurposeSlug, disposition: PcpDisposition): PcpDisposition {
  if (!getPcpCallPurpose(slug).allowedDispositions.includes(disposition)) {
    throw new Error(`Disposition ${disposition} is not allowed for PCP purpose ${slug}`);
  }
  return disposition;
}

export function classifyPcpToolAccess(
  slug: PcpCallPurposeSlug | 'medical_records_request',
  verificationStatus: PcpVerificationStatus,
): { allowed: true; source: Exclude<PcpAuthoritativeSource, null> } | { allowed: false; reason: string } {
  if (slug === 'medical_records_request') {
    return { allowed: false, reason: 'patient_medical_records_pathway_isolated' };
  }
  const purpose = getPcpCallPurpose(slug);
  if (!purpose.authoritativeSource) return { allowed: false, reason: 'no_authoritative_source' };
  // This dedicated hotline establishes the professional-caller context. The
  // request remains `pending` for staff verification after intake; verification
  // is deliberately not performed or represented as completed on the call.
  if (purpose.containsPhi && verificationStatus === 'failed') return { allowed: false, reason: 'staff_verification_failed' };
  return { allowed: true, source: purpose.authoritativeSource };
}

/**
 * Eligibility keys off `allowedDispositions`, not `defaultDisposition`. The previous
 * rule ("default must be HAND_OFF, plus a hardcoded pharma exception") described the
 * same policy a third time and disagreed with the other two: it refused every purpose
 * that merely PERMITS a transfer. Purposes that permit HAND_OFF are eligible; the
 * director decides whether to take it on a given call.
 */
export function resolvePcpHandoffPolicy(
  slug: PcpCallPurposeSlug,
  pcpNumber: string | undefined,
): { allowed: true; destination: string } | { allowed: false; reason: string } {
  if (!getPcpCallPurpose(slug).allowedDispositions.includes('HAND_OFF')) {
    return { allowed: false, reason: 'purpose_not_handoff_eligible' };
  }
  if (!pcpNumber) return { allowed: false, reason: 'pcp_destination_not_configured' };
  return { allowed: true, destination: pcpNumber };
}
