/**
 * THE CLOCK IS PINNED ON EVERY PCP CASE BELOW, and it has to be.
 *
 * `resolveHandoffDestination` reads the real Pacific clock for the 12:00-13:00
 * lunch closure unless `lunchClosure` is passed. These tests did not pass it,
 * so six of them failed for one hour a day, every day, and passed the other
 * twenty-three -- which is why nobody noticed. Found on 2026-08-13 at 12:05
 * Pacific, while checking whether an unrelated change had broken them.
 *
 * A test that depends on the wall clock is not a flaky test, it is a test that
 * is wrong at a predictable time. Lunch behaviour has its own file,
 * `lunchClosure.test.ts`, which pins it in both directions.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveClinicalTransferNumber,
  resolveHandoffDestination,
  preferredCallbackNumber,
  resolvePcpDialSequence,
  urgentTransferFailureLine,
} from './handoffPolicy';
import { PCP_CALL_PURPOSES } from '../pcp/policy';

const QUEUE = '+17149564300';

describe('slug-aware handoff policy', () => {
  it('preserves the existing clinical allowlist', () => {
    expect(resolveHandoffDestination({ agentSlug: 'after-hours', callerType: 'patient_urgent', clinicalNumber: '+15550000001' })).toEqual({ allowed: true, destination: '+15550000001', policy: 'clinical' });
    expect(resolveHandoffDestination({ agentSlug: 'no-ivr', callerType: 'routine', clinicalNumber: '+15550000001' }).allowed).toBe(false);
  });

  it('allows only PCP handoff reasons on the PCP line', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'peer_to_peer', pcpNumber: '+15550000002', clinicalNumber: '+15550000001' })).toEqual({ allowed: true, destination: '+15550000002', policy: 'pcp' });
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'patient_urgent', pcpNumber: '+15550000002' }).allowed).toBe(false);
  });

  it('fails closed when the PCP destination is missing', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'grievance_follow_up', clinicalNumber: '+15550000001' })).toEqual({ allowed: false, reason: 'pcp_destination_not_configured' });
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
  it('always selects the dedicated no-IVR destination for the production no-IVR agent', () => {
    expect(resolveClinicalTransferNumber({
      agentSlug: 'no-ivr',
      clinicalNumber: '+15550000001',
      noIvrNumber: '845-531-7471',
    })).toBe('+18455317471');
  });

  it('does not apply the no-IVR destination to another agent or the dev test line', () => {
    for (const agentSlug of ['after-hours', 'azul-scheduling', 'dev-no-ivr']) {
      expect(resolveClinicalTransferNumber({
        agentSlug,
        clinicalNumber: '+15550000001',
        noIvrNumber: '+18455317471',
      })).toBe('+15550000001');
    }
  });

  it('fails closed when the dedicated no-IVR destination is missing', () => {
    expect(resolveClinicalTransferNumber({
      agentSlug: 'no-ivr',
      clinicalNumber: '+15550000001',
    })).toBeUndefined();
  });

  it('accepts the PCP queue however it was written', () => {
    for (const written of ['714-956-4300', '(714) 956-4300', '7149564300', '1-714-956-4300', ' +17149564300 ']) {
      expect(resolvePcpDialSequence({ mode: 'queue', queueNumber: written, agentDids: [] }))
        .toEqual(['+17149564300']);
    }
  });

  it('normalizes the destination the handoff actually dials', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'peer_to_peer', pcpNumber: '714-956-4300' }))
      .toEqual({ allowed: true, destination: '+17149564300', policy: 'pcp' });
    expect(resolveHandoffDestination({ agentSlug: 'after-hours', callerType: 'patient_urgent', clinicalNumber: '714-956-4300' }))
      .toEqual({ allowed: true, destination: '+17149564300', policy: 'clinical' });
  });

  it('still fails closed on an unset or empty destination', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'peer_to_peer', pcpNumber: '   ' }))
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
      (slug) => !resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: slug, pcpNumber: QUEUE }).allowed,
    );
    expect(refused).toEqual([]);
  });

  it('routes scheduling requests to the PCP queue', () => {
    for (const slug of ['schedule_appointment', 'reschedule_appointment', 'cancel_appointment']) {
      expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: slug, pcpNumber: QUEUE }))
        .toEqual({ allowed: true, destination: QUEUE, policy: 'pcp' });
    }
  });

  it('still refuses purposes the policy table does not allow to hand off', () => {
    // e.g. patient_medical_records_request stays on its isolated manual-review path.
    expect(ineligible).toContain('patient_medical_records_request');
    const wronglyAllowed = ineligible.filter(
      (slug) => resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: slug, pcpNumber: QUEUE }).allowed,
    );
    expect(wronglyAllowed).toEqual([]);
  });

  it('still fails closed on an unknown caller type', () => {
    expect(resolveHandoffDestination({ agentSlug: 'pcp', lunchClosure: false, callerType: 'not_a_purpose', pcpNumber: QUEUE }))
      .toEqual({ allowed: false, reason: 'pcp_reason_not_allowed' });
  });
});

describe('what an urgent caller is told when the transfer fails outright', () => {
  it('promises a callback only when a durable follow-up was actually filed', () => {
    expect(urgentTransferFailureLine({ followUpFiled: true })).toMatch(/will call you back/i);
  });

  it('makes no callback promise when nothing was filed', () => {
    // The failure this guards: an SMS that no-ops silently is not somebody
    // being told, so a caller could hang up believing a callback is coming
    // when no record of them exists anywhere.
    const line = urgentTransferFailureLine({ followUpFiled: false });
    expect(line).not.toMatch(/call you back/i);
    expect(line).not.toMatch(/on-call team has your request/i);
  });

  it('never tells the caller to call us, filed or not — standing instruction 10', () => {
    for (const followUpFiled of [true, false]) {
      const line = urgentTransferFailureLine({ followUpFiled });
      expect(line).not.toMatch(/call (us )?back during/i);
      expect(line).not.toMatch(/please call (us|back)/i);
      expect(line).not.toMatch(/try again later/i);
      // The emergency route survives in both branches.
      expect(line).toMatch(/nine one one/);
    }
  });
});

describe('which number a promised callback is filed against', () => {
  const CALLER_ID = '+16265551212';

  it('prefers the number the patient asked to be reached on', () => {
    expect(preferredCallbackNumber({ collected: '714-956-4300', callerId: CALLER_ID }))
      .toBe('+17149564300');
  });

  it('keeps caller ID when the collected number is a fragment', () => {
    // "555-1234" is seven digits: toE164 cannot place it, so it comes back
    // without a '+'. Filing it would replace a dialable number with one that
    // is not, on a path that just promised to call this person back.
    expect(preferredCallbackNumber({ collected: '555-1234', callerId: CALLER_ID }))
      .toBe(CALLER_ID);
  });

  it('keeps caller ID when nothing was collected', () => {
    expect(preferredCallbackNumber({ collected: undefined, callerId: CALLER_ID })).toBe(CALLER_ID);
    expect(preferredCallbackNumber({ collected: '   ', callerId: CALLER_ID })).toBe(CALLER_ID);
  });

  it('returns nothing when neither is usable, rather than a fragment', () => {
    expect(preferredCallbackNumber({ collected: '1234', callerId: null })).toBeUndefined();
  });
});
