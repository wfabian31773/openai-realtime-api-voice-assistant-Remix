import { describe, expect, it } from 'vitest';
import { resolveHandoffDestination } from './handoffPolicy';

describe('slug-aware handoff policy', () => {
  it('preserves the existing clinical allowlist', () => {
    expect(resolveHandoffDestination({ agentSlug: 'after-hours', callerType: 'patient_urgent', clinicalNumber: '+15550000001' })).toEqual({ allowed: true, destination: '+15550000001', policy: 'clinical' });
    expect(resolveHandoffDestination({ agentSlug: 'no-ivr', callerType: 'routine', clinicalNumber: '+15550000001' }).allowed).toBe(false);
  });

  it('allows only PCP handoff reasons on the PCP line', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'peer_to_peer', pcpNumber: '+15550000002', clinicalNumber: '+15550000001' })).toEqual({ allowed: true, destination: '+15550000002', policy: 'pcp' });
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'patient_urgent', pcpNumber: '+15550000002' }).allowed).toBe(false);
  });

  it('fails closed when the PCP destination is missing', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'grievance_follow_up', clinicalNumber: '+15550000001' })).toEqual({ allowed: false, reason: 'pcp_destination_not_configured' });
  });
});
