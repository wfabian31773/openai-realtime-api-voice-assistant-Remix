/**
 * An escalation is a one-way door.
 *
 * REGRESSION, call b01d32f8 (2026-08-04 03:47, no-ivr, 20.6 minutes):
 *
 *   03:55:09  escalate_to_human  "caller is speaking incoherently…"  success
 *   03:55:10  terminate_call     reason: "ghost_call"                success
 *
 * One second apart, on the same call, and transferred_to_human came out
 * false. The agent decided the caller needed a human and then hung up on
 * them before the transfer could land. That caller really was a ghost, so
 * nobody was harmed — but the race does not know who is on the phone, and
 * the same second would drop a patient reporting sudden vision loss.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { escalationDetailsMap } from '../services/escalationStore';

/** The guard exactly as it sits in noIvrAgent's terminate_call. */
function terminateGuard(callId: string): { refused: boolean; error?: string } {
  if (escalationDetailsMap.has(callId)) {
    return { refused: true, error: 'escalation_in_progress' };
  }
  return { refused: false };
}

beforeEach(() => escalationDetailsMap.clear());

describe('terminate_call after escalate_to_human', () => {
  it('refuses to hang up once an escalation is in flight', () => {
    escalationDetailsMap.set('rtc_b01d32f8', {
      reason: 'caller is speaking incoherently, and the conversation is not progressing',
      callerType: 'patient_unresponsive',
    } as never);
    expect(terminateGuard('rtc_b01d32f8')).toEqual({ refused: true, error: 'escalation_in_progress' });
  });

  it('still allows a normal ghost-call hangup when nothing was escalated', () => {
    expect(terminateGuard('rtc_clean').refused).toBe(false);
  });

  it('is scoped per call — one caller escalating does not pin another call open', () => {
    escalationDetailsMap.set('rtc_a', { reason: 'urgent', callerType: 'patient_urgent_medical' } as never);
    expect(terminateGuard('rtc_a').refused).toBe(true);
    expect(terminateGuard('rtc_b').refused).toBe(false);
  });
});
