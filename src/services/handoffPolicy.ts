const CLINICAL_CALLER_TYPES = new Set([
  'patient_urgent',
  'patient_urgent_medical',
  'healthcare_provider',
  'patient_unresponsive',
]);

const PCP_CALLER_TYPES = new Set([
  'peer_to_peer',
  'health_plan_visit_inquiry',
  'grievance_follow_up',
  'pharmaceutical_representative',
]);

type Params = {
  agentSlug?: string;
  callerType?: string;
  clinicalNumber?: string;
  pcpNumber?: string;
};

export type HandoffPolicyResult =
  | { allowed: true; destination: string; policy: 'clinical' | 'pcp' }
  | { allowed: false; reason: string };

export function resolvePcpDialSequence(params: {
  mode: 'queue' | 'sequential';
  queueNumber?: string;
  agentDids: string[];
}): string[] {
  if (params.mode === 'sequential') return params.agentDids.filter(Boolean);
  return params.queueNumber ? [params.queueNumber] : [];
}

export function resolveHandoffDestination(params: Params): HandoffPolicyResult {
  if (params.agentSlug === 'pcp') {
    if (!params.callerType || !PCP_CALLER_TYPES.has(params.callerType)) {
      return { allowed: false, reason: 'pcp_reason_not_allowed' };
    }
    if (!params.pcpNumber) return { allowed: false, reason: 'pcp_destination_not_configured' };
    return { allowed: true, destination: params.pcpNumber, policy: 'pcp' };
  }

  if (!params.callerType || !CLINICAL_CALLER_TYPES.has(params.callerType)) {
    return { allowed: false, reason: 'clinical_caller_type_not_allowed' };
  }
  if (!params.clinicalNumber) return { allowed: false, reason: 'clinical_destination_not_configured' };
  return { allowed: true, destination: params.clinicalNumber, policy: 'clinical' };
}
