import { beforeEach, expect, it, vi } from 'vitest';
import { TicketingApiClient } from './ticketingApiClient';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../../src/tools/verifiedIdentity';
const sid = 'CA' + 'd'.repeat(32);
beforeEach(() => resetVerifiedIdentities());
it('67395 / VA-75419: the shared HTTP client carries a captured match for recovery instead of Unknown Caller', async () => {
  rememberVerifiedIdentity(sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true,
    personId: '00000000-0000-4000-8000-000000000001', usualOffice: 'Synthetic Clinic' });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false, error: 'controlled failure' });
  await api.submitTicket({ patientFullName: 'Unknown Caller', patientDOB: 'Unknown', reasonForCalling: 'Transfer failed; callback requested',
    preferredContactMethod: 'phone', patientPhone: '5555550100', callData: { callSid: sid } });
  expect(send.mock.calls[0][2]).toMatchObject({ patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02', patientPhone: '5555550100',
    validatedPatient: { callSid: sid, status: 'validated', personId: '00000000-0000-4000-8000-000000000001' } });
});
