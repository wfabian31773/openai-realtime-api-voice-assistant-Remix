/**
 * A PCP CALL MUST ALWAYS HAVE AN EXIT.
 *
 * From the operator's own test call on 2026-08-14, CA62a1245d — 188 seconds
 * that ended with no ticket, no transfer, and an agent that could not hang up.
 * The tool timeline is the whole story:
 *
 *   handoff_to_pcp  -> durable_ticket_required_before_handoff
 *   create_pcp_task -> disposition_not_allowed: HAND_OFF is not allowed for
 *                      PCP purpose check_patient_scheduled
 *   terminate_call  -> durable_disposition_required   (x4)
 *
 * The caller said "I need to speak with someone about a mutual patient", so
 * the director forced HAND_OFF — the operator's 2026-08-09 ruling. The purpose
 * had classified as `check_patient_scheduled`, which allows only AUTOMATE and
 * CREATE_TASK. Every exit was then locked by a guard that was, on its own,
 * correct:
 *
 *   - the ticket refused the disposition the director had just granted;
 *   - the handoff refused because it files that ticket FIRST;
 *   - terminate refused because nothing had been recorded.
 *
 * Two independent floors now. Either alone would have saved that call; both is
 * deliberate, because this is a caller stuck on a line with no way out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PcpDirector } from './director';
import { getPcpCallPurpose } from './policy';

const noLunch = () => false;

describe('the exact deadlock, reproduced', () => {
  it('grants the handoff on an explicit ask even where the purpose forbids it', () => {
    // The operator ruling, unchanged: a professional who asks for a person
    // gets one, whatever the call turned out to be about.
    const purpose = getPcpCallPurpose('check_patient_scheduled');
    expect(purpose.allowedDispositions).not.toContain('HAND_OFF');

    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('deadlock', { callPurpose: 'check_patient_scheduled' });
    d.markCallerRequestedHuman('deadlock');

    const decision = d.next('deadlock');
    expect(decision.handoffEligible).toBe(true);
    expect(decision.disposition).toBe('HAND_OFF');
  });

  it('lets the call END once anything durable has been recorded', () => {
    /**
     * THE FLOOR. `mayTerminate` used to require the recorded disposition to
     * still EQUAL the freshly computed one. `disposition` is recomputed every
     * turn from live state, so a late "can I speak to someone" retroactively
     * invalidated a record that was already durable — and terminate_call
     * refused forever.
     */
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('t1', { callPurpose: 'check_patient_scheduled' });
    d.recordDisposition('t1', 'AUTOMATE');
    expect(d.next('t1').mayTerminate).toBe(true);

    // Now the caller asks for a person: the computed disposition moves to
    // HAND_OFF while AUTOMATE stays recorded. The call must still be endable.
    d.markCallerRequestedHuman('t1');
    const after = d.next('t1');
    expect(after.disposition).toBe('HAND_OFF');
    expect(after.mayTerminate, 'a recorded disposition must always permit hangup').toBe(true);
  });

  it('still refuses to end a call where NOTHING was recorded', () => {
    // The guarantee this check exists for is intact: no PCP call ends without
    // a durable record of what happened.
    const d = new PcpDirector({ lunchClosure: noLunch });
    d.update('t2', { callPurpose: 'check_patient_scheduled' });
    expect(d.next('t2').mayTerminate).toBe(false);
  });
});

describe('the ticket accepts the disposition the director granted', () => {
  const submit = async (over: Record<string, unknown> = {}) => {
    vi.resetModules();
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'VA-60000' });
    const { submitPcpTicket } = await import('./pcpTicketing');
    const res = await submitPcpTicket(
      {
        callSid: 'CAdeadlock',
        agentSlug: 'pcp',
        agentVersion: '1.0.0',
        callerName: "Dr Chen's office",
        callerRole: 'referring coordinator',
        callerOrganization: 'Chen Family Medicine',
        callerFacilityType: 'referring_provider',
        callerCallbackNumber: '9515551234',
        callPurpose: 'check_patient_scheduled',
        disposition: 'HAND_OFF',
        narrative: 'Calling about a mutual patient, asked to speak with someone.',
        handoff: { requested: true, attempted: false, finalStatus: 'REQUESTED' },
        ...over,
      } as never,
      { createPcpTicket } as never,
    );
    return { res, createPcpTicket };
  };

  it('files when the explicit-ask grant is present', async () => {
    const { res, createPcpTicket } = await submit({ dispositionGrantedByExplicitAsk: true });
    expect(res.success, `refused: ${(res as any).error}`).toBe(true);
    expect(createPcpTicket).toHaveBeenCalledOnce();
  });

  it('still refuses an unsanctioned disposition without the grant', async () => {
    // The flag is the ONE exception. Nothing else may quietly widen what a
    // purpose allows.
    const { res, createPcpTicket } = await submit();
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/disposition_not_allowed/);
    expect(createPcpTicket).not.toHaveBeenCalled();
  });

  it('does not let the grant widen anything other than HAND_OFF', async () => {
    const { res } = await submit({
      dispositionGrantedByExplicitAsk: true,
      disposition: 'AUTOMATE',
      callPurpose: 'patient_caller',
    });
    // patient_caller allows CREATE_TASK only; AUTOMATE must still be refused.
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/disposition_not_allowed/);
  });
});
