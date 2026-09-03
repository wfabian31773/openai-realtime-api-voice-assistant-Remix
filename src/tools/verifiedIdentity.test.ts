/**
 * ASKING A PATIENT FOR SOMETHING WE ALREADY HAVE.
 *
 * Operator, 2026-09-01: *"it is very rare that a new patient will call that
 * line so verification should succeed, if we do our job and validate and pass
 * the patient records along, you will not have this issue."*
 *
 * Measured over the 14 days to 2026-09-01, both halves are true:
 *
 *  - `lookup_patient` found the caller on **95%** of the queue calls where it
 *    ran — 997/1,048 tech, 651/698 surgery, 421/442 optical, 18/18 records.
 *  - **45 calls were refused for a date of birth and ended with no ticket, and
 *    on 23 of them `lookup_patient` had already identified the patient.**
 *
 * `scheduleLookupService` returns `patientData.dateOfBirth` with every match
 * and always has. Nothing carried it the twenty lines from the lookup to the
 * filing tool, so the agent asked, and when the caller could not answer the
 * request was lost.
 *
 * These tests are about the two guards that keep the carry from becoming a
 * guess about identity, because that is the only way this change could do
 * harm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const {
  rememberVerifiedIdentity,
  verifiedDobFor,
  verifiedIdentityFor,
  resetVerifiedIdentities,
} = await import('./verifiedIdentity');

const CALL = 'CA00000000000000000000000000000001';
const WAYNE = { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '03/17/1973' };

beforeEach(() => resetVerifiedIdentities());

describe('what the lookup verified is available to the tool that files', () => {
  it('gives back the date of birth for the person it was verified for', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(verifiedDobFor(CALL, 'Wayne', 'Fabian')).toBe('03/17/1973');
  });

  it('does not care about case or stray spacing in the name', () => {
    // The model types the name it heard; the record holds the name it holds.
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(verifiedDobFor(CALL, '  wayne ', 'FABIAN')).toBe('03/17/1973');
  });

  it('hands the hangup sweep the original casing, not the folded match key', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(verifiedIdentityFor(CALL)).toEqual(WAYNE);
  });
});

describe('the two guards, which are the whole reason this is safe', () => {
  it('never hands one caller\'s date of birth to a ticket for someone else', () => {
    // A daughter ringing about her father is an ordinary call on these lines.
    // Filing his request under her date of birth would be worse than asking.
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(verifiedDobFor(CALL, 'Maria', 'Fabian')).toBeUndefined();
    expect(verifiedDobFor(CALL, 'Wayne', 'Nguyen')).toBeUndefined();
  });

  it('never crosses calls', () => {
    rememberVerifiedIdentity(CALL, WAYNE);
    expect(verifiedDobFor('CA00000000000000000000000000000002', 'Wayne', 'Fabian')).toBeUndefined();
    // And with no CallSid there is nothing to key on, so nothing is returned —
    // rather than falling back to "the last patient this process saw".
    expect(verifiedDobFor(undefined, 'Wayne', 'Fabian')).toBeUndefined();
  });

  it('stores nothing it could not match back to a person', () => {
    rememberVerifiedIdentity(CALL, { firstName: 'Wayne', lastName: '', dateOfBirth: '03/17/1973' });
    expect(verifiedDobFor(CALL, 'Wayne', '')).toBeUndefined();

    rememberVerifiedIdentity(CALL, { firstName: 'Wayne', lastName: 'Fabian' });
    expect(verifiedDobFor(CALL, 'Wayne', 'Fabian')).toBeUndefined();

    rememberVerifiedIdentity(undefined, WAYNE);
    expect(verifiedDobFor(undefined, 'Wayne', 'Fabian')).toBeUndefined();
  });
});

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./opticalTools');

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

describe('end to end: the filing tool stops asking twice', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resetVerifiedIdentities();
    const { resetGateAttempts } = await import('./gateAttempts');
    resetGateAttempts();
  });

  const CALLER = {
    first_name: 'Wayne',
    last_name: 'Fabian',
    callback_number: '845-531-7471',
    location: 'Eastvale',
    request_description: 'my glasses broke at the hinge',
    call_sid: CALL,
  };

  it('files with the verified date of birth when the caller never says one', async () => {
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      success: true,
      outcome: 'matched',
      locationId: 12,
      locationMatches: [],
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: true,
      ticketNumber: 'VA-CARRIED',
    } as never);

    // What lookup_patient does on a certain match.
    rememberVerifiedIdentity(CALL, WAYNE);

    const out = await runTool('file_optical_ticket', CALLER);

    expect(out.success).toBe(true);
    const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    // Split the way create-ticket wants it, from the record rather than the ear.
    expect(filed.patientBirthMonth).toBe('03');
    expect(filed.patientBirthDay).toBe('17');
    expect(filed.patientBirthYear).toBe('1973');
  });

  it('still refuses when nothing was verified for this call', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');

    const out = await runTool('file_optical_ticket', CALLER);

    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('date_of_birth');
    expect(create).not.toHaveBeenCalled();
  });

  it('prefers what the caller actually said', async () => {
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      success: true,
      outcome: 'matched',
      locationId: 12,
      locationMatches: [],
    } as never);
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: true,
      ticketNumber: 'VA-SPOKEN',
    } as never);

    rememberVerifiedIdentity(CALL, WAYNE);
    await runTool('file_optical_ticket', { ...CALLER, date_of_birth: 'January 2nd, 1960' });

    // The record fills a gap; it does not overrule a person. If those two
    // disagree the caller may be filing for somebody else, and the ticket
    // should say what they said.
    const filed = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(filed.patientBirthYear).toBe('1960');
  });
});
