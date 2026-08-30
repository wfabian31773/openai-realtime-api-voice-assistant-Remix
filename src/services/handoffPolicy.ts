import { PCP_CALL_PURPOSES } from '../pcp/policy';
import { isLunchClosure } from '../utils/timeAware';

const CLINICAL_CALLER_TYPES = new Set([
  'patient_urgent',
  'patient_urgent_medical',
  'healthcare_provider',
  'patient_unresponsive',
]);

/**
 * Which PCP call purposes may be transferred to a human, DERIVED from the purpose
 * table rather than restated here.
 *
 * This used to be a hand-written list of four slugs, and it silently disagreed with
 * src/pcp/policy.ts: scheduling purposes carry HAND_OFF in `allowedDispositions`, but
 * the list did not include them, so a scheduling caller who reached the transfer would
 * be refused at the dial with `pcp_reason_not_allowed` — after the durable ticket had
 * already been filed. Two tables describing the same rule is the actual defect; one
 * derived set cannot drift.
 */
// Set<string>, not Set<PcpCallPurposeSlug>: callerType arrives as an unvalidated
// string off the call's escalation details, and an unknown value must fail the
// membership check rather than fail to compile.
const PCP_CALLER_TYPES: ReadonlySet<string> = new Set<string>(
  PCP_CALL_PURPOSES
    .filter((purpose) => purpose.allowedDispositions.includes('HAND_OFF'))
    .map((purpose) => purpose.slug),
);

type Params = {
  agentSlug?: string;
  callerType?: string;
  clinicalNumber?: string;
  pcpNumber?: string;
  /**
   * The caller explicitly asked to speak to a person. On the PCP line this
   * always reaches the office queue during business hours, whatever the call
   * is about — operator directive 2026-08-09 after surgery centers were
   * refused: 355 of 457 PCP calls were promised something and 11 transferred,
   * because purposes like service_inquiry and provider_information are not in
   * the HAND_OFF set. An explicit ask outranks the classification.
   */
  callerRequestedHuman?: boolean;
  /** Injected by tests; production reads the Pacific clock. */
  lunchClosure?: boolean;
};

export type HandoffPolicyResult =
  | { allowed: true; destination: string; policy: 'clinical' | 'pcp' }
  | { allowed: false; reason: string };

/**
 * Twilio requires E.164. Operations hands these numbers over the way people write
 * them — "714-956-4300", "(714) 956-4300" — and pasting one of those into
 * PCP_HUMAN_AGENT_NUMBER used to reach Twilio verbatim and fail the dial at
 * handoff time, i.e. mid-call. Normalize at the policy boundary so the queue is
 * reachable however the number was entered.
 *
 * Only unambiguous cases are converted: 10 digits (assumed NANP) and 11 digits
 * starting with 1. Anything already '+'-prefixed is trusted as-is, and anything
 * else is returned untouched rather than guessed at.
 */
export function toE164(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

/**
 * The production no-IVR line has its own fixed handoff destination. Keeping
 * this selection at the policy boundary prevents the global clinical number
 * or office-routing logic from silently diverting an after-hours triage call.
 */
export function resolveClinicalTransferNumber(params: {
  agentSlug?: string;
  clinicalNumber?: string;
  noIvrNumber?: string;
}): string | undefined {
  return toE164(
    params.agentSlug === 'no-ivr'
      ? params.noIvrNumber
      : params.clinicalNumber,
  );
}

/**
 * The PCP queue is the SINGLE recipient of every PCP transfer.
 *
 * `sequential` mode — ringing each PCP_AGENT_DIDS entry one at a time — was a
 * testing arrangement, and it is no longer allowed to change where transfers land:
 * a stale `PCP_ROUTING_MODE=sequential` left in an environment would silently send
 * every PCP handoff to individual agent phones instead of the staffed queue, and
 * nothing in the call would reveal it. The mode is still accepted as configuration
 * so an existing deployment cannot fail validation on boot; it just cannot divert
 * the dial any more.
 *
 * No queue number configured → no destination. The handoff is refused upstream by
 * resolveHandoffDestination ('pcp_destination_not_configured') rather than falling
 * back to some other phone.
 */
export function resolvePcpDialSequence(params: {
  mode: 'queue' | 'sequential';
  queueNumber?: string;
  agentDids?: string[];
}): string[] {
  const queue = toE164(params.queueNumber);
  if (!queue) return [];
  if (params.mode === 'sequential') {
    console.warn(
      '[HANDOFF] PCP_ROUTING_MODE=sequential is a testing mode and no longer changes routing — dialing the PCP queue. Set PCP_ROUTING_MODE=queue to silence this.',
    );
  }
  return [queue];
}

export function resolveHandoffDestination(params: Params): HandoffPolicyResult {
  if (params.agentSlug === 'pcp') {
    const askedForAPerson = params.callerRequestedHuman === true;
    if (!askedForAPerson && (!params.callerType || !PCP_CALLER_TYPES.has(params.callerType))) {
      return { allowed: false, reason: 'pcp_reason_not_allowed' };
    }
    // LUNCH CLOSURE, 12:00-13:00 Pacific (operator directive 2026-08-06).
    // Nobody is at the desk, so a warm transfer can only ring out while the
    // caller holds in silence. Refusing here — at the same boundary that
    // already refuses an unconfigured destination — means the PCP tool takes
    // its existing failure path: the durable ticket it filed BEFORE dialing is
    // updated to CREATE_TASK with the fallback open, so the caller gets a
    // callback instead of a dead transfer.
    //
    // Deliberately NOT applied to the clinical policy below. That path carries
    // patient_urgent, patient_urgent_medical, patient_unresponsive and
    // healthcare_provider — an urgent clinical transfer must not be blocked
    // because it is 12:30. Lunch gates the ADMINISTRATIVE queue only.
    if (params.lunchClosure ?? isLunchClosure()) {
      return { allowed: false, reason: 'pcp_lunch_closure' };
    }
    const pcpDestination = toE164(params.pcpNumber);
    if (!pcpDestination) return { allowed: false, reason: 'pcp_destination_not_configured' };
    return { allowed: true, destination: pcpDestination, policy: 'pcp' };
  }

  if (!params.callerType || !CLINICAL_CALLER_TYPES.has(params.callerType)) {
    return { allowed: false, reason: 'clinical_caller_type_not_allowed' };
  }
  const clinicalDestination = toE164(params.clinicalNumber);
  if (!clinicalDestination) return { allowed: false, reason: 'clinical_destination_not_configured' };
  return { allowed: true, destination: clinicalDestination, policy: 'clinical' };
}
