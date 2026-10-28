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
it('create-ticket transport does not reattach a held record after a DOB correction', async () => {
  rememberVerifiedIdentity(sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false, error: 'controlled failure' });
  await api.createTicket({ departmentId: 3, requestTypeId: 1, requestReasonId: 1, patientFirstName: 'Alex', patientLastName: 'Synthetic',
    patientPhone: '5555550100', patientBirthYear: '1980', patientBirthMonth: '02', patientBirthDay: '03', description: 'Synthetic request', callData: { callSid: sid } });
  expect(send.mock.calls[0][2]).toMatchObject({ patientBirthYear: '1980', validatedPatient: undefined });
});

it.each([
  ['Mary Ann', 'Synthetic'],
  ['Mary Ann', 'Synthetic Example'],
])('simplified transport preserves validated name boundaries: %s / %s', async (firstName, lastName) => {
  const nextAppointment = { date: '2099-01-01', location: 'Synthetic Clinic' };
  rememberVerifiedIdentity(sid, { firstName, lastName, dateOfBirth: '1970-01-02', certain: true,
    personId: 'synthetic-person', nextAppointment });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false });
  await api.submitTicket({ patientFullName: `  ${firstName}  ${lastName} `, patientDOB: 'Unknown',
    reasonForCalling: 'Synthetic callback', preferredContactMethod: 'phone', callData: { callSid: sid } });
  expect(send.mock.calls[0][2]).toMatchObject({ patientDOB: '1970-01-02', locationOfLastVisit: 'Synthetic Clinic',
    validatedPatient: { firstName, lastName, personId: 'synthetic-person', nextAppointment } });
});

it.each([
  ['Other Synthetic', 'Unknown'],
  ['Mary Ann Synthetic', '1980-02-03'],
])('simplified transport rejects conflicting name or DOB: %s / %s', async (patientFullName, patientDOB) => {
  rememberVerifiedIdentity(sid, { firstName: 'Mary Ann', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false });
  await api.submitTicket({ patientFullName, patientDOB, reasonForCalling: 'Synthetic callback', preferredContactMethod: 'phone', callData: { callSid: sid } });
  expect((send.mock.calls[0][2] as { validatedPatient?: unknown }).validatedPatient).toBeUndefined();
});

it.each([
  ['Alex', 'Synthetic', 'Q'],
  ['Alex', 'Synthetic', 'Q.'],
  ['Mary Ann', 'Synthetic Example', 'Q.'],
])('simplified transport keeps validated context with a middle initial: %s / %s / %s', async (firstName, lastName, initial) => {
  const nextAppointment = { date: '2099-01-01', location: 'Synthetic Next Clinic' };
  const lastVisit = { date: '2020-01-01', location: 'Synthetic Last Clinic' };
  rememberVerifiedIdentity(sid, { firstName, lastName, dateOfBirth: '1970-01-02', certain: true,
    personId: 'synthetic-person', nextAppointment, lastVisit });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false });

  await api.submitTicket({ patientFullName: `  ${firstName}  ${initial}  ${lastName} `, patientDOB: '1970-01-02',
    reasonForCalling: 'Synthetic callback', preferredContactMethod: 'phone', callData: { callSid: sid } });

  expect(send.mock.calls[0][2]).toMatchObject({ locationOfLastVisit: nextAppointment.location,
    validatedPatient: { status: 'validated', callSid: sid, firstName, lastName,
      personId: 'synthetic-person', nextAppointment, lastVisit } });
});

it.each([
  ['Other Q. Synthetic', '1970-01-02'],
  ['Alex Q. Other', '1970-01-02'],
  ['Alexandra Q. Synthetic', '1970-01-02'],
  ['Alex Quinn Synthetic', '1970-01-02'],
  ['Alex Q. R. Synthetic', '1970-01-02'],
  ['Alex Q. Synthetic Other', '1970-01-02'],
  ['Alex Q. Synthetic', '1980-02-03'],
])('middle-initial tolerance still rejects conflicting identity: %s / %s', async (patientFullName, patientDOB) => {
  rememberVerifiedIdentity(sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true,
    personId: 'synthetic-person', nextAppointment: { date: '2099-01-01', location: 'Synthetic Clinic' } });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false });

  await api.submitTicket({ patientFullName, patientDOB, reasonForCalling: 'Synthetic callback',
    preferredContactMethod: 'phone', callData: { callSid: sid } });

  expect(send.mock.calls[0][2]).not.toHaveProperty('validatedPatient');
  expect(send.mock.calls[0][2]).not.toHaveProperty('locationOfLastVisit');
});

it.each([
  { nextAppointment: { date: '2099-01-01', location: 'Synthetic Next Clinic' },
    lastVisit: { date: '2020-01-01', location: 'Synthetic Last Clinic' }, usualOffice: 'Synthetic Usual Clinic' },
  { lastVisit: { date: '2020-01-01', location: 'Synthetic Last Clinic' }, usualOffice: 'Synthetic Usual Clinic' },
  { usualOffice: 'Synthetic Usual Clinic' },
])('simplified transport preserves an explicit clinic and uses history only as a fallback (%j)', async (history) => {
  rememberVerifiedIdentity(sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02',
    certain: true, ...history });
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: true });
  const ticket = { patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02',
    reasonForCalling: 'Synthetic callback', preferredContactMethod: 'phone' as const, callData: { callSid: sid } };

  await api.submitTicket({ ...ticket, locationOfLastVisit: 'Synthetic Caller Clinic' });
  expect(send.mock.calls[0][2]).toMatchObject({ locationOfLastVisit: 'Synthetic Caller Clinic',
    validatedPatient: { status: 'validated', callSid: sid } });

  const fallback = history.nextAppointment?.location || history.lastVisit?.location || history.usualOffice;
  for (const locationOfLastVisit of [undefined, '']) {
    await api.submitTicket({ ...ticket, locationOfLastVisit });
    expect(send.mock.lastCall?.[2]).toMatchObject({ locationOfLastVisit: fallback });
  }
});
