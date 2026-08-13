import { describe, expect, it } from 'vitest';
import {
  PCP_CALL_PURPOSES,
  PCP_CALL_PURPOSE_SLUGS,
  classifyPcpToolAccess,
  getPcpCallPurpose,
  resolvePcpHandoffPolicy,
} from './policy';

describe('PCP policy', () => {
  it('defines one deterministic default disposition for every supported purpose', () => {
    // One entry per slug — the actual invariant. A hardcoded count (it was 18)
    // fails on every legitimate addition and says nothing about coherence;
    // `patient_caller` tripped it in 2026-08-13 without anything being wrong.
    expect(PCP_CALL_PURPOSES).toHaveLength(PCP_CALL_PURPOSE_SLUGS.length);
    expect(new Set(PCP_CALL_PURPOSES.map((p) => p.slug))).toEqual(new Set(PCP_CALL_PURPOSE_SLUGS));
    for (const purpose of PCP_CALL_PURPOSES) {
      expect(['AUTOMATE', 'CREATE_TASK', 'HAND_OFF']).toContain(purpose.defaultDisposition);
      expect(purpose.allowedDispositions).toContain(purpose.defaultDisposition);
    }
  });

  it('launches unbacked informational purposes conservatively as tasks', () => {
    for (const slug of ['accessibility_survey', 'new_patient_survey', 'disability_accommodation', 'plan_participation'] as const) {
      expect(getPcpCallPurpose(slug).defaultDisposition).toBe('CREATE_TASK');
    }
  });

  it('permits hotline schedule tools while staff verification remains pending', () => {
    expect(classifyPcpToolAccess('check_patient_scheduled', 'pending')).toEqual({ allowed: true, source: 'scheduling' });
    expect(classifyPcpToolAccess('check_patient_scheduled', 'verified')).toEqual({ allowed: true, source: 'scheduling' });
  });

  it('allows public practice information without a PHI verification gate', () => {
    expect(classifyPcpToolAccess('provider_information', 'pending')).toEqual({ allowed: true, source: 'knowledge_base' });
  });

  it('keeps patient medical-record requests outside PCP automation', () => {
    expect(classifyPcpToolAccess('medical_records_request', 'verified')).toEqual({ allowed: false, reason: 'patient_medical_records_pathway_isolated' });
  });

  it('classifies explicit medical-record requests separately from peer-to-peer', () => {
    expect(getPcpCallPurpose('patient_medical_records_request')).toMatchObject({ defaultDisposition: 'CREATE_TASK' });
    expect(getPcpCallPurpose('peer_to_peer')).toMatchObject({ defaultDisposition: 'HAND_OFF' });
  });

  it('uses a PCP-only destination and never falls back to the clinical line', () => {
    expect(resolvePcpHandoffPolicy('peer_to_peer', '+15551234567')).toEqual({ allowed: true, destination: '+15551234567' });
    expect(resolvePcpHandoffPolicy('peer_to_peer', undefined)).toEqual({ allowed: false, reason: 'pcp_destination_not_configured' });
  });
});
