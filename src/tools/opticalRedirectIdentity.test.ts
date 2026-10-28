import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: { releaseTicketCreationLock: async () => {} } }));
vi.mock('../services/ticketOutboxService', async () => {
  const { queueTicketOutboxMock } = await import('../testUtils/queueTicketOutbox');
  return queueTicketOutboxMock();
});

import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import { runTool } from './registry';
import './sharedPatientTools';
import './surgeryTools';
import './techTools';
import './medicalRecordsTools';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';
import { validatedPatientFor } from './ticketIdentity';
import * as directory from '../services/consoleDirectory';

const sid = 'CA' + 'b'.repeat(32);
const clinic = 'Synthetic Optical Clinic';
const surgery = 'Synthetic Surgery Center';
const virtual = 'Synthetic Virtual Visits';

beforeEach(() => {
  vi.restoreAllMocks();
  resetVerifiedIdentities();
  vi.spyOn(directory, 'isDirectoryConfigured').mockReturnValue(true);
  vi.spyOn(directory, 'lookupLocation').mockImplementation(async (name) => ({
    canonical: name, key: name.toLowerCase(), volume90d: 1,
    facilityKind: name === surgery ? 'surgery_center' : name === virtual ? 'virtual' : 'clinic',
  }));
  vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValue({ success: true, locationId: 31 });
  vi.spyOn(ticketingApiClient as any, 'warmUpIfStale').mockResolvedValue(true);
});

it.each(['file_surgery_ticket', 'file_tech_ticket', 'file_records_ticket'])(
  '%s redirects glasses requests with clinic-safe identity at the HTTP boundary', async (tool) => {
    rememberVerifiedIdentity(sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true,
      personId: '00000000-0000-4000-8000-000000000001', usualOffice: clinic,
      nextAppointment: { date: '2099-01-01', location: surgery },
      lastVisit: { date: '2020-01-01', location: virtual } });
    const held = validatedPatientFor(sid);
    const send = vi.spyOn(ticketingApiClient as any, 'makeRequest')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' });

    expect(await runTool(tool, { call_sid: sid, location: clinic,
      first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02', callback_number: '5555550100',
      request_description: 'When will my glasses be ready for pickup?',
      requester: 'I am the patient', form_channel: 'declined', deliver_to: 'to me', date_range: 'everything',
    })).toMatchObject({ success: true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0].slice(0, 2)).toEqual(['/api/voice-agent/create-ticket', 'POST']);
    expect(send.mock.calls[0][2]).toMatchObject({ departmentId: 1, locationOfLastVisit: clinic,
      validatedPatient: { status: 'validated', callSid: sid, personId: held!.personId,
        firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02',
        nextAppointment: undefined, lastVisit: undefined, confirmedClinic: clinic } });
    expect(validatedPatientFor(sid)).toEqual(held);
  },
);
