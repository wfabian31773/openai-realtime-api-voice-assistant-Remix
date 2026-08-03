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

  it('rejects a model-selected disposition that policy does not allow', async () => {
    const createPcpTicket = vi.fn();
    await expect(submitPcpTicket({ ...payload, callPurpose: 'grievance_follow_up', disposition: 'AUTOMATE' }, { createPcpTicket })).rejects.toThrow(/not allowed/);
    expect(createPcpTicket).not.toHaveBeenCalled();
  });

  it('does not require fabricated patient data for non-patient calls', async () => {
    const createPcpTicket = vi.fn().mockResolvedValue({ success: true, ticketNumber: 'PCP-2' });
    await submitPcpTicket({ ...payload, callPurpose: 'pharmaceutical_representative' }, { createPcpTicket });
    expect(createPcpTicket.mock.calls[0][0]).not.toHaveProperty('patientFirstName');
  });
});
