import { beforeEach, expect, it } from 'vitest';
import { prepareTicketIdentity } from './ticketIdentity';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';

const call_sid = 'CA' + 'f'.repeat(32);
const input = { call_sid, date_of_birth: '1970-01-02', location: 'Synthetic Clinic' };
beforeEach(() => resetVerifiedIdentities());

it.each([
  [{}, 'first_name'],
  [{ first_name: 'Alex' }, 'last_name'],
  [{ first_name: '  ', last_name: 'Synthetic' }, 'first_name'],
  [{ first_name: 'Alex', last_name: '  ' }, 'last_name'],
])('asks for the missing name without a validated identity (%j)', (names, missing) => {
  expect(prepareTicketIdentity({ ...input, ...names })).toMatchObject({ missing, message: expect.any(String) });
});

it('fills both names from the validated identity', () => {
  rememberVerifiedIdentity(call_sid, { firstName: 'Mary Ann', lastName: 'Synthetic', certain: true });
  expect(prepareTicketIdentity(input)).toEqual({ input: { ...input, first_name: 'Mary Ann', last_name: 'Synthetic' } });
});

it('does not fill missing names from an uncertain phone candidate', () => {
  rememberVerifiedIdentity(call_sid, { firstName: 'Alex', lastName: 'Synthetic', certain: false });
  expect(prepareTicketIdentity(input)).toMatchObject({ missing: 'first_name' });
});

it('does not require a clinic in the shared identity gate', () => {
  const prepared = prepareTicketIdentity({ ...input, first_name: 'Alex', last_name: 'Synthetic', location: '' });
  expect(prepared.missing).toBeUndefined();
});

it.each([
  { nextAppointment: { date: '2099-01-01', location: 'Synthetic Next Clinic' },
    lastVisit: { date: '2020-01-01', location: 'Synthetic Last Clinic' }, usualOffice: 'Synthetic Usual Clinic' },
  { lastVisit: { date: '2020-01-01', location: 'Synthetic Last Clinic' }, usualOffice: 'Synthetic Usual Clinic' },
  { usualOffice: 'Synthetic Usual Clinic' },
])('preserves the caller clinic while filling missing identity fields (%j)', (history) => {
  rememberVerifiedIdentity(call_sid, { firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02',
    certain: true, ...history });
  expect(prepareTicketIdentity({ call_sid, location: 'Synthetic Caller Clinic' })).toEqual({
    input: { call_sid, first_name: 'Alex', last_name: 'Synthetic', date_of_birth: '1970-01-02',
      location: 'Synthetic Caller Clinic' },
  });
});

it.each([undefined, '', '   '])('fills an absent clinic from next appointment, last visit, then usual office (%j)', (location) => {
  const history = {
    firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true,
    nextAppointment: { date: '2099-01-01', location: 'Synthetic Next Clinic' },
    lastVisit: { date: '2020-01-01', location: 'Synthetic Last Clinic' }, usualOffice: 'Synthetic Usual Clinic',
  };
  rememberVerifiedIdentity(call_sid, history);
  expect(prepareTicketIdentity({ call_sid, location }).input.location).toBe('Synthetic Next Clinic');
  resetVerifiedIdentities();
  const { nextAppointment, ...withoutNext } = history;
  rememberVerifiedIdentity(call_sid, withoutNext);
  expect(prepareTicketIdentity({ call_sid, location }).input.location).toBe('Synthetic Last Clinic');
  resetVerifiedIdentities();
  const { lastVisit, ...withoutVisits } = withoutNext;
  rememberVerifiedIdentity(call_sid, withoutVisits);
  expect(prepareTicketIdentity({ call_sid, location }).input.location).toBe('Synthetic Usual Clinic');
});
