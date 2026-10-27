import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './techTools';
import './surgeryTools';
import { resetVerifiedIdentities, verifiedIdentityFor, verifiedDobFor } from './verifiedIdentity';

const { lookup, file, directory } = vi.hoisted(() => ({ lookup: vi.fn(), file: vi.fn(), directory: { configured: false } }));
vi.mock('../services/scheduleLookupService', () => ({ scheduleLookupService: { lookupPatient: lookup } }));
vi.mock('../services/consoleDirectory', () => ({ isDirectoryConfigured: () => directory.configured,
  lookupLocation: async () => ({ canonical: 'Testville', fileAs: 'Testville', facilityKind: 'clinic' }) }));
vi.mock('../services/durableTicketFiling', () => ({ createTicketDurable: file, postFailureToolResult: () => ({ success: false }) }));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { lookupProviderAndLocation: async (input: { providerName?: string }) => ({ success: true, locationId: 31,
    ...(input.providerName === 'Synthetic Surgeon' ? { providerId: 77 } : {}) }) },
  lookupWasUnavailable: () => false,
}));
const sid = 'CA' + 'a'.repeat(32);
const context = {
  patientFound: true, matchedBy: 'name_and_dob', identity: { unique: true, candidateCount: 1, candidates: [] },
  patientData: { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-01', personId: '00000000-0000-4000-8000-000000000001' },
  upcomingAppointments: [{ isoDate: '2099-01-01', location: 'Testville', status: 'Active' }],
  pastAppointments: [{ isoDate: '2026-01-01', location: 'Sampleville', status: 'Active' }],
  totalAppointmentsFound: 2,
};
beforeEach(() => { vi.clearAllMocks(); resetVerifiedIdentities(); directory.configured = false; lookup.mockResolvedValue(context); file.mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC' }); });
async function identify() {
  return runTool('lookup_patient', { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '01/01/1970' });
}
describe('Support Desk #1-4/#12 validated record carry', () => {
  it('surgery uses the validated joined physician without searching by name again', async () => {
    lookup.mockResolvedValue({ ...context, lastPhysicianSeen: 'Synthetic Surgeon', lastProviderSeen: 'Synthetic Optometrist' });
    await identify();
    const out = await runTool('file_surgery_ticket', { call_sid: sid,
      callback_number: '5555550100', request_description: 'Question about my surgery date' });
    expect(out.success).toBe(true);
    expect(file.mock.calls[0][0]).toMatchObject({ providerId: 77, lastProviderSeen: 'Synthetic Surgeon' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('a caller-supplied conflicting DOB never travels with the previous validated identity', async () => {
    await identify();
    const out = await runTool('file_tech_ticket', { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic',
      date_of_birth: '1980-02-03', location: 'Caller Clinic', callback_number: '5555550100', request_description: 'Callback requested' });
    expect(out.success).toBe(true);
    expect(file.mock.calls[0][0]).toMatchObject({ patientBirthYear: '1980', patientBirthMonth: '02', patientBirthDay: '03' });
    expect(file.mock.calls[0][0].validatedPatient).toBeUndefined();
  });

  it('VA-76095: the clinic confirmed earlier in this call survives an omitted filing argument', async () => {
    directory.configured = true;
    expect(await runTool('resolve_location', { call_sid: sid, spoken_location: 'Testville', queue: 'tech' })).toMatchObject({ success: true, verified: true });
    const args = { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '01/01/1970', callback_number: '5555550100', request_description: 'Appointment question' };
    expect((await runTool('file_tech_ticket', args)).success).toBe(true);
    expect(file.mock.calls[0][0]).toMatchObject({ locationOfLastVisit: 'Testville' });
    expect(await runTool('file_tech_ticket', { ...args, call_sid: 'CA' + 'b'.repeat(32) })).toMatchObject({ success: false, missingFields: ['location'] });
  });

  it('a caller-named clinic is still carried when the directory is unavailable', async () => {
    expect(await runTool('resolve_location', { call_sid: sid, spoken_location: 'Caller Clinic', queue: 'tech' }))
      .toMatchObject({ success: true, resolved: false, verified: false });
    const out = await runTool('file_tech_ticket', { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic',
      date_of_birth: '1970-01-01', callback_number: '5555550100', request_description: 'Callback requested' });
    expect(out.success).toBe(true);
    expect(file.mock.calls[0][0]).toMatchObject({ locationOfLastVisit: 'Caller Clinic' });
    expect(file.mock.calls[0][0].validatedPatient).toBeUndefined();
  });

  it('VA-75419: an established match is reused without another lookup', async () => {
    await identify();
    lookup.mockRejectedValue(new Error('Controlled mirror outage'));
    expect(await identify()).toMatchObject({ success: true, identity_is_certain: true, usual_office: 'Testville' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('VA-75419 / VA-75969: actual lookup keeps person, DOB, next/last appointment through filing', async () => {
    await identify();
    expect(verifiedIdentityFor(sid)).toMatchObject({ personId: context.patientData.personId, usualOffice: 'Testville' });
    const out = await runTool('file_tech_ticket', { call_sid: sid, callback_number: '5555550100', request_description: 'Please call about my appointment.' });
    expect(out.success).toBe(true);
    expect(file.mock.calls[0][0]).toMatchObject({ patientFirstName: 'Alex', patientLastName: 'Synthetic', patientBirthYear: '1970', locationOfLastVisit: 'Testville',
      validatedPatient: { callSid: sid, status: 'validated', personId: context.patientData.personId, nextAppointment: { location: 'Testville' }, lastVisit: { location: 'Sampleville' } } });
  });
  it('VA-75719 / 76116 / 76265 / 76697: reachable caller is asked for missing DOB before filing', async () => {
    const args = { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic', callback_number: '5555550100', request_description: 'Appointment question', location: 'Testville' };
    for (let i=0; i<3; i++) expect(await runTool('file_tech_ticket', args)).toMatchObject({ success: false, missingFields: ['date_of_birth'] });
    expect(file).not.toHaveBeenCalled();
  });
  it('VA-76095 / 75989 / 75953 / 75899 / 75838: reachable caller must confirm an office when no history exists', async () => {
    const out = await runTool('file_tech_ticket', { call_sid: sid, first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '01/01/1970', callback_number: '5555550100', request_description: 'Appointment question' });
    expect(out).toMatchObject({ success: false, missingFields: ['location'] });
    expect(file).not.toHaveBeenCalled();
  });
  it('VA-76198 vs VA-76197: another call on the same phone cannot inherit', async () => {
    await identify();
    expect(verifiedIdentityFor('CA' + 'b'.repeat(32))).toBeUndefined();
  });
  it('VA-76205 / 76217: phone-only candidate is never a validated identity or DOB', async () => {
    lookup.mockResolvedValue({ ...context, matchedBy: 'phone', identityUnconfirmed: false });
    const result = await runTool('lookup_patient', { call_sid: sid, phone: '5555550100' });
    expect(verifiedIdentityFor(sid)).toBeUndefined();
    expect(verifiedDobFor(sid, 'Alex', 'Synthetic')).toBeUndefined();
    expect((result as Record<string, unknown>).patient_name).toBeUndefined();
    expect(result).toMatchObject({ usual_office: null, last_visit: null });
  });
});
