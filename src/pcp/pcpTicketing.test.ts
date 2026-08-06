import { describe, expect, it, vi } from 'vitest';
import { submitPcpTicket, type PcpTicketPayload } from './pcpTicketing';

const payload: PcpTicketPayload = {
  callSid: 'CA123',
  agentSlug: 'pcp',
  agentVersion: '1.0.0',
  callerName: 'Alex Kim',
  callerRole: 'Referral coordinator',
  callerOrganization: 'North County Medical Group',
  callerFacilityType: 'ipa_medical_group',
  callerCallbackNumber: '+17605550100',
  callPurpose: 'service_inquiry',
  disposition: 'CREATE_TASK',
  urgency: 'normal',
  verificationStatus: 'pending',
  narrative: 'Caller requested staff follow-up about services.',
};

describe('PCP ticketing adapter', () => {
  it('uses the dedicated endpoint contract and preserves agent attribution', async () => {
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-1' });
    const result = await submitPcpTicket(payload, { createPcpTicket });
    expect(result).toEqual({ success: true, ticketNumber: 'PCP-1' });
    expect(createPcpTicket).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'pcp', callSid: 'CA123' }));
  });

  it('refuses a model-selected disposition that policy does not allow', async () => {
    // CONTRACT CHANGE 2026-08-06: this used to REJECT. The invariant the test
    // protects — the ticket is never filed under a forbidden disposition — is
    // unchanged and still asserted below. What changed is the failure SHAPE.
    // A throw reached the model as a raw tool error and it improvised: on
    // 08-06 callers were told "the system is consistently blocking the ticket"
    // and one was told to phone the medical records department. A structured
    // failure lets the agent take the fallback path it already has, and the
    // reason is still logged at error level.
    const createPcpTicket = vi.fn();
    const result = await submitPcpTicket(
      { ...payload, callPurpose: 'grievance_follow_up', disposition: 'AUTOMATE' },
      { createPcpTicket },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disposition_not_allowed/);
    expect(createPcpTicket).not.toHaveBeenCalled();
  });

  it('files the ticket when an optional field arrives EMPTY instead of absent', async () => {
    // optionalText is .min(1).optional(): an absent key is fine, '' is fatal.
    // Losing a whole request over a blank optional is the defect.
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-3' });
    const result = await submitPcpTicket(
      { ...payload, patientFirstName: '', patientMrn: '   ' } as typeof payload,
      { createPcpTicket },
    );
    expect(result.success).toBe(true);
    expect(createPcpTicket.mock.calls[0][0]).not.toHaveProperty('patientFirstName');
    expect(createPcpTicket.mock.calls[0][0]).not.toHaveProperty('patientMrn');
  });

  it('normalises a date of birth the caller spoke in a non-ISO format', async () => {
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-4' });
    await submitPcpTicket({ ...payload, patientDob: '11.11.1977' } as typeof payload, { createPcpTicket });
    expect(createPcpTicket.mock.calls[0][0].patientDob).toBe('1977-11-11');
  });

  it('keeps an unparseable date of birth in the narrative rather than losing the ticket', async () => {
    // The human working the ticket must still see what the caller actually
    // said, even when we cannot store it in the date column.
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-5' });
    const result = await submitPcpTicket(
      { ...payload, patientDob: 'sometime in the sixties' } as typeof payload,
      { createPcpTicket },
    );
    expect(result.success).toBe(true);
    const sent = createPcpTicket.mock.calls[0][0];
    expect(sent).not.toHaveProperty('patientDob');
    expect(sent.narrative).toContain('sometime in the sixties');
  });

  it('still refuses — structurally — when a REQUIRED field is genuinely missing', async () => {
    const createPcpTicket = vi.fn();
    const { callerName, ...withoutName } = payload;
    const result = await submitPcpTicket(withoutName as typeof payload, { createPcpTicket });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid_payload.*callerName/);
    expect(createPcpTicket).not.toHaveBeenCalled();
  });

  it('does not require fabricated patient data for non-patient calls', async () => {
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-2' });
    await submitPcpTicket({ ...payload, callPurpose: 'pharmaceutical_representative' }, { createPcpTicket });
    expect(createPcpTicket.mock.calls[0][0]).not.toHaveProperty('patientFirstName');
  });
});
