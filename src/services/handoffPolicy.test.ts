import { describe, expect, it } from 'vitest';
import { resolveHandoffDestination, resolvePcpDialSequence } from './handoffPolicy';
import { PCP_CALL_PURPOSES } from '../pcp/policy';

const QUEUE = '+17149564300';

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

  it('sends every PCP transfer to the queue and nowhere else', () => {
    expect(resolvePcpDialSequence({ mode: 'queue', queueNumber: '+17149564300', agentDids: ['+17143990670'] }))
      .toEqual(['+17149564300']);
  });

  /**
   * The regression that matters operationally: individual agent DIDs were a testing
   * arrangement. A stale `sequential` left in an environment must not quietly divert
   * transfers to personal phones instead of the staffed queue.
   */
  it('ignores a stale sequential mode rather than diverting transfers off the queue', () => {
    expect(resolvePcpDialSequence({
      mode: 'sequential',
      queueNumber: '+17149564300',
      agentDids: ['+17143990670', '+19097291250', '+17143990721', '+17143990681'],
    })).toEqual(['+17149564300']);
  });

  it('yields no destination when the queue is unconfigured, in either mode', () => {
    // resolveHandoffDestination refuses the handoff upstream; never fall back to another phone.
    expect(resolvePcpDialSequence({ mode: 'queue', agentDids: ['+17143990670'] })).toEqual([]);
    expect(resolvePcpDialSequence({ mode: 'sequential', agentDids: ['+17143990670'] })).toEqual([]);
  });
});

/**
 * Operations hands the queue DID over as people write it. An un-normalized number
 * reaches Twilio verbatim and fails the dial mid-call, so normalize at the boundary.
 */
describe('destination normalization', () => {
  it('accepts the PCP queue however it was written', () => {
    for (const written of ['714-956-4300', '(714) 956-4300', '7149564300', '1-714-956-4300', ' +17149564300 ']) {
      expect(resolvePcpDialSequence({ mode: 'queue', queueNumber: written, agentDids: [] }))
        .toEqual(['+17149564300']);
    }
  });

  it('normalizes the destination the handoff actually dials', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'peer_to_peer', pcpNumber: '714-956-4300' }))
      .toEqual({ allowed: true, destination: '+17149564300', policy: 'pcp' });
    expect(resolveHandoffDestination({ agentSlug: 'after-hours', callerType: 'patient_urgent', clinicalNumber: '714-956-4300' }))
      .toEqual({ allowed: true, destination: '+17149564300', policy: 'clinical' });
  });

  it('still fails closed on an unset or empty destination', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'peer_to_peer', pcpNumber: '   ' }))
      .toEqual({ allowed: false, reason: 'pcp_destination_not_configured' });
    expect(resolvePcpDialSequence({ mode: 'queue', queueNumber: '', agentDids: [] })).toEqual([]);
  });

  it('leaves an unrecognized format alone rather than guessing at it', () => {
    // A 4-digit extension or a short code must not be silently turned into a US number.
    expect(resolvePcpDialSequence({ mode: 'queue', queueNumber: '4300', agentDids: [] })).toEqual(['4300']);
  });
});

/**
 * The production failure this guards: scheduling was the dominant PCP purpose (8 of 10
 * tickets in the first 24 hours) and could never reach a human. Two separate tables
 * described transfer eligibility and disagreed, so the dial was refused with
 * `pcp_reason_not_allowed` for purposes the policy table permits.
 */
describe('PCP transfer eligibility tracks the purpose table', () => {
  const eligible = PCP_CALL_PURPOSES.filter((p) => p.allowedDispositions.includes('HAND_OFF')).map((p) => p.slug);
  const ineligible = PCP_CALL_PURPOSES.filter((p) => !p.allowedDispositions.includes('HAND_OFF')).map((p) => p.slug);

  it('accepts every purpose the policy table allows to hand off', () => {
    const refused = eligible.filter(
      (slug) => !resolveHandoffDestination({ agentSlug: 'pcp', callerType: slug, pcpNumber: QUEUE }).allowed,
    );
    expect(refused).toEqual([]);
  });

  it('routes scheduling requests to the PCP queue', () => {
    for (const slug of ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment']) {
      expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: slug, pcpNumber: QUEUE }))
        .toEqual({ allowed: true, destination: QUEUE, policy: 'pcp' });
    }
  });

  it('still refuses purposes the policy table does not allow to hand off', () => {
    // e.g. patient_medical_records_request stays on its isolated manual-review path.
    expect(ineligible).toContain('patient_medical_records_request');
    const wronglyAllowed = ineligible.filter(
      (slug) => resolveHandoffDestination({ agentSlug: 'pcp', callerType: slug, pcpNumber: QUEUE }).allowed,
    );
    expect(wronglyAllowed).toEqual([]);
  });

  it('still fails closed on an unknown caller type', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', callerType: 'not_a_purpose', pcpNumber: QUEUE }))
      .toEqual({ allowed: false, reason: 'pcp_reason_not_allowed' });
  });
});
