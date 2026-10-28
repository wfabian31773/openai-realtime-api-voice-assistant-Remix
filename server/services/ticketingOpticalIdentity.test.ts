import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketingApiClient } from './ticketingApiClient';
import { validatedPatientFor, type ValidatedPatient } from '../../src/tools/ticketIdentity';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from '../../src/tools/verifiedIdentity';
import * as directory from '../../src/services/consoleDirectory';

const sid = 'CA' + 'a'.repeat(32);
const clinic = 'Synthetic Optical Clinic';
const surgery = 'Synthetic Surgery Center';
const virtual = 'Synthetic Virtual Visits';
const unknown = 'Synthetic Unclassified Office';

beforeEach(() => {
  vi.restoreAllMocks();
  resetVerifiedIdentities();
  vi.spyOn(directory, 'isDirectoryConfigured').mockReturnValue(true);
  vi.spyOn(directory, 'lookupLocation').mockImplementation(async (name) => name === unknown ? null : ({
    canonical: name, key: name.toLowerCase(), volume90d: 1,
    facilityKind: name === surgery ? 'surgery_center' : name === virtual ? 'virtual' : 'clinic',
  }));
});

function hold(nextOffice = surgery, lastOffice = clinic, usualOffice = clinic) {
  rememberVerifiedIdentity(sid, {
    firstName: 'Alex', lastName: 'Synthetic', dateOfBirth: '1970-01-02', certain: true,
    personId: '00000000-0000-4000-8000-000000000001', usualOffice,
    nextAppointment: { date: '2099-01-01', location: nextOffice, provider: 'Synthetic Next Provider' },
    lastVisit: { date: '2020-01-01', location: lastOffice, provider: 'Synthetic Last Provider' },
  });
  return validatedPatientFor(sid)!;
}

function client() {
  const api = new TicketingApiClient();
  vi.spyOn(api as any, 'warmUpIfStale').mockResolvedValue(true);
  const send = vi.spyOn(api as any, 'makeRequest').mockResolvedValue({ success: false, error: 'controlled failure' });
  return { api, send };
}

async function file(api: TicketingApiClient, endpoint: 'create' | 'submit', departmentId: number | undefined,
  validatedPatient?: ValidatedPatient, locationOfLastVisit?: string) {
  const identity = { validatedPatient, locationOfLastVisit, callData: { callSid: sid }, departmentId };
  if (endpoint === 'create') {
    await api.createTicket({ ...identity, departmentId: departmentId!, patientFirstName: 'Alex', patientLastName: 'Synthetic',
      patientPhone: '5555550100', description: 'Synthetic glasses question' });
  } else {
    await api.submitTicket({ ...identity, patientFullName: 'Alex Synthetic', patientDOB: '1970-01-02',
      patientPhone: '5555550100', reasonForCalling: 'Synthetic glasses question', preferredContactMethod: 'phone' });
  }
}

describe.each(['create', 'submit'] as const)('%s-ticket Optical identity transport', (endpoint) => {
  it.each([
    [surgery, clinic, clinic],
    [clinic, surgery, virtual],
    [surgery, virtual, clinic],
    [surgery, virtual, surgery],
    [unknown, clinic, unknown],
  ])('filters all carried locations (%s / %s / %s) from explicit and recovered identities', async (next, last, usual) => {
    const patient = hold(next, last, usual);
    const original = structuredClone(patient);
    Object.freeze(patient.nextAppointment);
    Object.freeze(patient.lastVisit);
    Object.freeze(patient);
    const { api, send } = client();

    // Explicit payloads include redirects and persisted outbox retries after
    // teardown clears memory. Missing payloads include floors and recovery.
    for (const carried of [true, false]) {
      resetVerifiedIdentities();
      if (!carried) hold(next, last, usual);
      await file(api, endpoint, 1, carried ? patient : undefined, clinic);
      expect(send.mock.lastCall?.[2]).toMatchObject({ departmentId: 1, locationOfLastVisit: clinic,
        validatedPatient: { ...original,
          nextAppointment: next === surgery || next === virtual ? undefined : original.nextAppointment,
          lastVisit: last === surgery || last === virtual ? undefined : original.lastVisit,
          confirmedClinic: usual === surgery || usual === virtual ? undefined : usual,
        } });
      expect(patient).toEqual(original);
      if (!carried) expect(validatedPatientFor(sid)).toEqual(original);
    }
  });

  it.each([2, 3, 8, 16])('preserves the full identity for an explicit non-Optical department (%i)', async (departmentId) => {
    const patient = hold(surgery, virtual, surgery);
    const { api, send } = client();
    await file(api, endpoint, departmentId);
    expect(send.mock.lastCall?.[2]).toMatchObject({ departmentId, validatedPatient: patient });
    expect(directory.lookupLocation).not.toHaveBeenCalled();
  });

  it('retains unknown facility kinds and the existing directory-unavailable fallback', async () => {
    const patient = hold();
    const { api, send } = client();
    vi.spyOn(directory, 'lookupLocation').mockResolvedValue({ canonical: surgery, key: surgery, volume90d: 1, facilityKind: null });
    await file(api, endpoint, 1);
    expect(send.mock.lastCall?.[2]).toMatchObject({ validatedPatient: patient });
    vi.spyOn(directory, 'lookupLocation').mockRejectedValue(new Error('synthetic directory outage'));
    await file(api, endpoint, 1);
    expect(send.mock.lastCall?.[2]).toMatchObject({ validatedPatient: patient });
    vi.spyOn(directory, 'isDirectoryConfigured').mockReturnValue(false);
    await file(api, endpoint, 1);
    expect(send.mock.lastCall?.[2]).toMatchObject({ validatedPatient: patient });
  });
});

it.each([undefined, 1])('simplified no-IVR/after-hours submissions use filtered fallback history (department: %s)', async (departmentId) => {
  const patient = hold();
  const { api, send } = client();
  await file(api, 'submit', departmentId);
  expect(send.mock.lastCall?.[2]).toMatchObject({ locationOfLastVisit: clinic,
    validatedPatient: { nextAppointment: undefined, lastVisit: patient.lastVisit, confirmedClinic: clinic } });
  expect(validatedPatientFor(sid)).toEqual(patient);

  // A later Surgery request on this same call still has its surgery center.
  await file(api, 'submit', 2);
  expect(send.mock.lastCall?.[2]).toMatchObject({ locationOfLastVisit: surgery, validatedPatient: patient });
});

it('simplified transport does not regenerate an ineligible fallback when all history was filtered', async () => {
  hold(surgery, virtual, surgery);
  const { api, send } = client();
  await file(api, 'submit', undefined);
  expect(send.mock.lastCall?.[2]).toMatchObject({ locationOfLastVisit: undefined,
    validatedPatient: { nextAppointment: undefined, lastVisit: undefined, confirmedClinic: undefined } });
});
