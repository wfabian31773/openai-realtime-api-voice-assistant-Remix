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
