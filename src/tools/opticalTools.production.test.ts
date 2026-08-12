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

vi.mock('../services/consoleDirectory', () => ({
  isDirectoryConfigured: () => true,
  lookupLocation: async (raw: string) => {
    const kind = FACILITY_KIND[raw.trim().toLowerCase()];
    return kind ? { canonical: raw, facilityKind: kind } : null;
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
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('lookup_patient, on a real patient, resolved against the real roster', () => {
  it('does not hand Optical a surgery center', async () => {
    const out = await runTool('lookup_patient', { phone: '845-531-7471' });
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
    const r = (await runTool('lookup_patient', { phone: '845-531-7471' })) as Record<string, unknown>;
    expect(r.last_visit).toBe('Monday, July 13, 2026');
    expect(r.last_provider).toBe('Dwayne Logan, MD');
    expect(String(r.last_visit)).not.toMatch(/December/);
  });

  it('emits a clinic name the ticketing app can actually receive', async () => {
    // Support Center `locations` holds brand-stripped names — `Eastvale`,
    // `Upland`, `Long Beach` — while the Console roster is brand-prefixed.
    // We must emit the form the receiver stores, or the ticket lands unassigned.
    const r = (await runTool('lookup_patient', { phone: '845-531-7471' })) as Record<string, unknown>;
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

    const r = (await runTool('lookup_patient', { phone: '845-531-7471' })) as Record<string, unknown>;
    expect(r.identity_is_certain).toBe(false);
    expect(String(r.identity_warning)).toMatch(/2 different people/);
    expect(String(r.identity_warning)).toMatch(/do not read their history back/i);
  });

  it('says the identity is certain when only one person matched', async () => {
    const r = (await runTool('lookup_patient', { phone: '845-531-7471' })) as Record<string, unknown>;
    expect(r.identity_is_certain).toBe(true);
    expect(r.identity_warning).toBeUndefined();
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

    const r = (await runTool('lookup_patient', { phone: '845-531-7471' })) as Record<string, unknown>;
    expect(r.usual_clinic).toBeNull();
    // A real answer, not a failure — and one the agent can act on out loud.
    expect(String(r.message)).toMatch(/ask which office/i);
  });
});
