/**
 * `lookup_patient` against a real patient's real history.
 *
 * Wayne asked for the tools to be proven before any agent is connected to
 * them. This file is that proof for the hardest of the three: every value
 * below was read out of production on 2026-08-11, not invented.
 *
 *   Ops Hub `Schedule`, the eight most recent rows for +1 845 531 7471
 *   Console `si_locations`, the `facility_kind` for each place they name
 *   Support Center `locations`, to confirm the name we emit can be received
 *
 * The case that matters: this patient's most recent visit that actually
 * happened is at **Loma Linda Surgery Center LLC** — a building with no
 * optician in it. Optical assigns tickets by location, so an agent that read
 * "where were they last seen" as "which office do they use" would file a
 * glasses ticket that reaches nobody. The tool has to answer both questions
 * separately, and this pins that it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});

/**
 * Console `si_locations`, verbatim. Note the shape mismatch that makes this a
 * real test rather than a tautology: NextGen's schedule says `Eastvale`, the
 * Console roster says `Azul Vision Eastvale`. `consoleDirectory` indexes both
 * the full name and a brand-stripped "bare" key so the two meet.
 */
const FACILITY_KIND: Record<string, string> = {
  'loma linda surgery center llc': 'surgery_center',
  eastvale: 'clinic',
  'rancho cucamonga': 'clinic',
  upland: 'clinic',
  redlands: 'clinic',
  'chevy chase surgery center': 'surgery_center',
  'virtual visits': 'virtual',
};

/**
 * What the Console actually returns as `canonical` — its `nextgen_name`, brand
 * and all. This is the detail that made the live bug invisible in an earlier
 * version of this mock, which echoed the input back and so could never
 * reproduce it. Clinics are brand-prefixed in the mirror; surgery centres and
 * screening sites mostly are not.
 */
const CANONICAL: Record<string, string> = {
  eastvale: 'Azul Vision Eastvale',
  'rancho cucamonga': 'Azul Vision Rancho Cucamonga',
  upland: 'Azul Vision Upland',
  redlands: 'Azul Vision Redlands',
};

vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => true,
  lookupLocation: async (raw: string) => {
    const key = raw.trim().toLowerCase();
    const kind = FACILITY_KIND[key];
    return kind ? { canonical: CANONICAL[key] ?? raw, facilityKind: kind } : null;
  },
}));

/**
 * What `scheduleLookupService.buildContext` produces from the eight most
 * recent rows on file, once cancelled, no-show and cancelled-future rows are
 * excluded. The 2026-12-30 row is Removed, so it is neither upcoming nor a
 * visit — that is the December-30 defect, fixed in 184b2e7 and pinned in
 * scheduleLookupService.test.ts.
 */
const REAL_CONTEXT = {
  patientFound: true,
  patientName: 'Wayne Fabian',
  matchedBy: 'phone' as const,
  upcomingAppointments: [],
  pastAppointments: [
    { location: 'Loma Linda Surgery Center LLC', provider: 'Dwayne Logan, MD' },
    { location: 'Eastvale', provider: 'Kevin Tran, OD' },
    { location: 'Rancho Cucamonga', provider: 'Genesis Atay, OD' },
    { location: 'Upland', provider: 'Sylvia Chang, MD' },
    { location: 'Loma Linda Surgery Center LLC', provider: 'Dwayne Logan, MD' },
  ],
  lastLocationSeen: 'Loma Linda Surgery Center LLC',
  lastProviderSeen: 'Dwayne Logan, MD',
  lastVisitDate: 'Monday, July 13, 2026',
  // What buildContext reports once it has grouped the rows by person. 43 of the
  // 44 rows on this number are Wayne's; the 44th belongs to a John Doe test
  // record and is excluded from the history rather than merged into it.
  identity: {
    unique: true,
    candidateCount: 1,
    candidates: [
      { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '1973-03-17', appointmentCount: 43 },
    ],
  },
  totalAppointmentsFound: 43,
};

vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: { lookupPatient: async () => REAL_CONTEXT },
}));

import { runTool } from './registry';
import './opticalTools';

beforeEach(() => {
  // Spies on the shared ticketing client accumulate across tests otherwise, so
  // `mock.calls[0]` would be some earlier test's call. That is how the
  // omit-the-taxonomy assertion first "failed" against a requestTypeId left
  // behind by the test above it — and how a later one could just as easily pass
  // for the wrong reason.
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('lookup_patient, on a real patient, resolved against the real roster', () => {
  it('does not hand Optical a surgery center', async () => {
    const out = await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' });
    expect(out.success).toBe(true);

    const r = out as Record<string, unknown>;
    // The field Optical routes on. Loma Linda is a surgery_center in the
    // Console, so it is skipped and the next place back — a real clinic — wins.
    expect(r.usual_clinic).toBe('Eastvale');
    // And the raw answer to "where were they last seen" stays available,
    // labelled for what it is, so nothing has to guess which is which.
    expect(r.last_location_any_kind).toBe('Loma Linda Surgery Center LLC');
    expect(r.usual_clinic).not.toBe(r.last_location_any_kind);
  });

  it('still reports the last visit truthfully — July 13, not December 30', async () => {
    const r = (await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' })) as Record<string, unknown>;
    expect(r.last_visit).toBe('Monday, July 13, 2026');
    expect(r.last_provider).toBe('Dwayne Logan, MD');
    expect(String(r.last_visit)).not.toMatch(/December/);
  });

  it('emits a clinic name the ticketing app can actually receive', async () => {
    // Support Center `locations` holds brand-stripped names — `Eastvale`,
    // `Upland`, `Long Beach` — while the Console roster is brand-prefixed.
    // We must emit the form the receiver stores, or the ticket lands unassigned.
    const r = (await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' })) as Record<string, unknown>;
    expect(String(r.usual_clinic)).not.toMatch(/^(Azul Vision|Atlantis Eyecare)\s/i);
  });

  it('tells the agent when the number could be more than one person', async () => {
    // +1 845 531 7471 really does carry two records in production: Wayne Fabian
    // (43 rows) and a John Doe test record (1 row). The service now hands back
    // one person's history and says so; the tool has to pass that on, because
    // an agent that reads a history back to the wrong person has disclosed it.
    const { scheduleLookupService } = await import('../services/scheduleLookupService');
    vi.spyOn(scheduleLookupService, 'lookupPatient').mockResolvedValueOnce({
      ...REAL_CONTEXT,
      identity: {
        unique: false,
        candidateCount: 2,
        candidates: [
          { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '1973-03-17', appointmentCount: 43 },
          { firstName: 'John', lastName: 'Doe', dateOfBirth: '1980-01-01', appointmentCount: 1 },
        ],
      },
    } as never);

    const r = (await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' })) as Record<string, unknown>;
    expect(r.identity_is_certain).toBe(false);
    expect(String(r.identity_warning)).toMatch(/2 different people/);
    expect(String(r.identity_warning)).toMatch(/do not read their history back/i);
  });

  it('says the identity is certain when only one person matched', async () => {
    const r = (await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' })) as Record<string, unknown>;
    expect(r.identity_is_certain).toBe(true);
    expect(r.identity_warning).toBeUndefined();
  });

  it('resolve_location emits the name the ticketing app stores, not the mirror\'s', async () => {
    // Live run against production, 2026-08-12: asked for "Azul Vision Eastvale"
    // this returned location: "Azul Vision Eastvale" — the Console's
    // nextgen_name. The Support Center's locations table stores "Eastvale", and
    // an optical ticket whose location does not match is assigned to nobody.
    const r = (await runTool('resolve_location', {
      spoken_location: 'Azul Vision Eastvale',
    })) as Record<string, unknown>;
    expect(String(r.location)).not.toMatch(/^(Azul Vision|Atlantis Eyecare)\s/i);
    expect(r.location).toBe('Eastvale');
  });

  it('classifies a real optical request into Optical\'s own categories', async () => {
    const r = (await runTool('classify_optical_request', {
      request_description: 'I need to pick up my glasses if they are ready',
    })) as Record<string, unknown>;
    expect(r.classified).toBe(true);
    expect(r.department_id).toBe(1);
    expect(r.request_reason_id).toBe(20); // Glasses Ready - Pickup
    // The value 953 real tickets carry, which belongs to Technicians Support.
    expect(r.request_reason_id).not.toBe(153);
  });

  it('says so rather than forcing a category that nearly fits', async () => {
    const r = (await runTool('classify_optical_request', {
      request_description: 'I have a question about my bill',
    })) as Record<string, unknown>;
    expect(r.classified).toBe(false);
    expect(String(r.message)).toMatch(/Do not pick a category/i);
  });

  it('will not file a ticket that nobody will be assigned', async () => {
    // VA-50803, filed for real on 2026-08-12, landed with location_id NULL and
    // assigned_to_id NULL. It was in the right department with the right
    // classification and it reached nobody, because create-ticket sets the
    // location foreign key from `locationId` and treats `locationOfLastVisit`
    // as text. For a queue whose assignment IS the location, filing without the
    // id is worse than refusing: an unassigned ticket looks filed.
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    const lookup = vi
      .spyOn(ticketingApiClient, 'lookupProviderAndLocation')
      .mockResolvedValueOnce({ success: true, locationId: null });
    const create = vi.spyOn(ticketingApiClient, 'createTicket');

    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      location: 'Somewhere We Do Not Have',
      request_description: 'glasses broke',
    });

    expect(lookup).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect((out as { message: string }).message).toMatch(/which office/i);
  });

  it('sends the numeric location id, not just the name', async () => {
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      locationId: 12,
    });
    const create = vi
      .spyOn(ticketingApiClient, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-TEST' });

    await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      location: 'Eastvale',
      request_description: 'my glasses broke at the hinge',
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      departmentId: 1,
      locationId: 12,
      requestTypeId: 1,
      requestReasonId: 2,
    });
  });

  it('never uses submit-ticket, even when it cannot classify', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong in production.
    //
    // The reasoning it encoded: create-ticket REQUIRES the (type, reason) pair
    // — measured twice on 2026-08-12, requestTypeId 0 is rejected and omitting
    // the fields is rejected identically — so a request fitting none of the
    // eighteen pairs has no route through it, and submit-ticket derives its own
    // taxonomy from free text. Wrong tool when we know the answer, right tool
    // when we do not.
    //
    // What that missed is WHICH field submit-ticket derives. VA-50811 was filed
    // by this exact path, said in its own description "a question about my
    // account that fits no optical category", and landed in department 8 —
    // After Hours Call Service — with assigned_to_id NULL. It re-derives the
    // DEPARTMENT, and defaults to 8 when it cannot. The fallback did not
    // produce a weak category; it produced a ticket no optician would ever see.
    //
    // So: always create-ticket, always department 1, placeholder reason when
    // nothing fits, and the description leads with UNCATEGORISED so the first
    // words a human reads are true.
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      locationId: 8,
    });
    const create = vi
      .spyOn(ticketingApiClient, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-PLACEHOLDER' });
    const submit = vi.spyOn(ticketingApiClient, 'submitTicket');

    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      location: 'Eastvale',
      request_description: 'a question about my account that fits no optical category',
    });

    expect(submit, 'submit-ticket re-derives the department and defaults to 8').not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();

    const sent = create.mock.calls[0][0];
    expect(sent.departmentId, 'the department is never guessed').toBe(1);
    // Department 1 now has a real reason for this: type 66, reason 536,
    // "Other - See Description", added 2026-08-12. No prefix, no borrowed
    // reason, and the description is just what the caller said.
    expect(sent.requestTypeId).toBe(66);
    expect(sent.requestReasonId).toBe(536);
    expect(sent.description).toMatch(/no optical category/);
    expect(sent.description).not.toMatch(/UNCATEGORISED/);

    expect(out).toMatchObject({
      success: true,
      ticket_number: 'VA-PLACEHOLDER',
      classified: false,
    });
  });

  it('uses create-ticket, not the fallback, when it CAN classify', async () => {
    // The fallback must never become the default — that would put this queue
    // straight back into the 42%-no-type / reason-153 population it exists to
    // escape.
    const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
    vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValueOnce({
      success: true,
      locationId: 8,
    });
    const submit = vi.spyOn(ticketingApiClient, 'submitTicket');
    const create = vi
      .spyOn(ticketingApiClient, 'createTicket')
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-CLASSIFIED' });

    await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      location: 'Eastvale',
      request_description: 'my glasses broke at the hinge',
    });

    expect(submit).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it('refuses to file without the office that decides who gets the ticket', async () => {
    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'glasses broke',
      // location deliberately absent
    });
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('location');
    // Spoken to a patient, so it has to read like a sentence a person would say.
    expect((out as { message: string }).message).toMatch(/which of our offices/i);
  });

  it('refuses a half-heard callback number instead of filing it', async () => {
    const out = await runTool('file_optical_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531',
      location: 'Eastvale',
      request_description: 'glasses broke',
    });
    expect(out.success).toBe(false);
    expect((out as { missingFields: string[] }).missingFields).toContain('callback_number');
    expect((out as { message: string }).message).toMatch(/ten digits/i);
  });

  it('asks rather than guesses when every visit is at a surgery center', async () => {
    const { scheduleLookupService } = await import('../services/scheduleLookupService');
    vi.spyOn(scheduleLookupService, 'lookupPatient').mockResolvedValueOnce({
      ...REAL_CONTEXT,
      pastAppointments: [
        { location: 'Loma Linda Surgery Center LLC', provider: 'Dwayne Logan, MD' },
        { location: 'Chevy Chase Surgery Center', provider: 'Dwayne Logan, MD' },
      ],
    } as never);

    const r = (await runTool('lookup_patient', { phone: '845-531-7471', queue: 'optical' })) as Record<string, unknown>;
    expect(r.usual_clinic).toBeNull();
    // A real answer, not a failure — and one the agent can act on out loud.
    expect(String(r.message)).toMatch(/ask which office/i);
  });
});
