/**
 * OPTICAL NEVER LOOKED AT THE OFFICE ON THE PATIENT'S OWN RECORD.
 *
 * `lookup_patient` computes it, returns it as `usual_office`, and the comment
 * beside that line calls it "the field this queue routes on". It then reached
 * the MODEL and nothing else — the same wire that was missing for the date of
 * birth, one field over.
 *
 * The asymmetry is what makes this a defect rather than an idea: SURGERY has
 * walked the patient's record for its routing field since 2026-08-18
 * (`surgeryTools.ts`, the surgeon ladder). Optical never has. It resolves only
 * what the caller said, and when that does not match it files UNASSIGNED — on
 * the one queue whose assignment IS the location.
 *
 * MEASURED 2026-09-11, optical: 25 calls hit the location gate and 8 ended
 * with no ticket at all. Of the 93 distinct numbers behind that day's
 * ticketless queue calls, 46 resolve to exactly one person in
 * `patients_master` and 43 of those have visit history naming their office.
 *
 * WHAT THESE PIN IS THE NARROWNESS, which is the whole risk. Optical assigns
 * BY location, and a ticket routed to the WRONG office is worse than an
 * unassigned one: unassigned gets triaged by a human who can read the
 * caller's words, wrongly-routed looks correct and nobody re-reads it. That
 * is the department-2 shape (~98% -> 49%) this repo has already paid for
 * once. So the record is consulted ONLY where the caller gave no office at
 * all — never to overrule one they named.
 *
 * Every fixture below is invented. No production caller, name, date or number
 * appears in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from './registry';
import './sharedPatientTools';
import './opticalTools';
import { resetGateAttempts } from './gateAttempts';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';

const SID = 'CA00000000000000000000000000000042';
const ON_RECORD = 'Glendora';
const RECORD_LOCATION_ID = 7701;

/** A complete optical request in which the caller never names an office. */
const NO_OFFICE = {
  first_name: 'Testcaller',
  last_name: 'Optical',
  date_of_birth: '01/01/1950',
  callback_number: '555-555-0147',
  request_description: 'Order new glasses',
  call_sid: SID,
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

/** The office directory answers for the record's office and nothing else. */
function directoryKnowsOnly(api: Awaited<ReturnType<typeof client>>, office: string) {
  return vi.spyOn(api, 'lookupProviderAndLocation').mockImplementation(
    async (args: { locationName?: string }) =>
      args?.locationName === office
        ? ({ success: true, outcome: 'matched', locationId: RECORD_LOCATION_ID } as never)
        : ({ success: true, outcome: 'no_match', locationId: undefined } as never),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('the office on the record is used when the caller named none', () => {
  it('files ROUTED to it instead of unassigned', async () => {
    const api = await client();
    directoryKnowsOnly(api, ON_RECORD);
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99001' } as never);
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', usualOffice: ON_RECORD, certain: true,
    });

    await runTool('file_optical_ticket', NO_OFFICE); // spends the ask
    await runTool('file_optical_ticket', NO_OFFICE);

    expect(create).toHaveBeenCalledTimes(1);
    // The payload the app routes on — not our own log line, and not the
    // tool's return value.
    expect(create.mock.calls[0][0]).toMatchObject({ locationId: RECORD_LOCATION_ID });
  });
});

describe('the narrowness — each guard forced to a POST so the payload can be read', () => {
  it('does NOT overrule an office the caller actually named', async () => {
    // The conflicting-signal case, and the reason this is not a general
    // fallback. "the one off the 60" does not resolve; the record says
    // Glendora. Filing Glendora would look correct and might not be.
    const api = await client();
    directoryKnowsOnly(api, ON_RECORD);
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99002' } as never);
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', usualOffice: ON_RECORD, certain: true,
    });

    const said = { ...NO_OFFICE, location: 'the one off the 60' };
    await runTool('file_optical_ticket', said);
    await runTool('file_optical_ticket', said);

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.locationId).toBeUndefined();
    expect(payload.routingAskExhausted).toBe(true);
    expect(payload.locationOfLastVisit).toBe('the one off the 60');
  });

  it('refuses an AMBIGUOUS match — a shared phone must not trade offices', async () => {
    // An office string cannot be checked against the ticket the way a name
    // can, so `certain` is what stands in for the missing comparison.
    const api = await client();
    directoryKnowsOnly(api, ON_RECORD);
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99003' } as never);
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', usualOffice: ON_RECORD, certain: false,
    });

    await runTool('file_optical_ticket', NO_OFFICE);
    await runTool('file_optical_ticket', NO_OFFICE);

    expect((create.mock.calls[0][0] as unknown as Record<string, unknown>).locationId)
      .toBeUndefined();
  });

  it('refuses when the ticket is for someone other than the person verified', async () => {
    // A daughter ringing about her father is an ordinary call on this line.
    const api = await client();
    directoryKnowsOnly(api, ON_RECORD);
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99004' } as never);
    rememberVerifiedIdentity(SID, {
      firstName: 'Someone', lastName: 'Else',
      dateOfBirth: '01/01/1950', usualOffice: ON_RECORD, certain: true,
    });

    await runTool('file_optical_ticket', NO_OFFICE);
    await runTool('file_optical_ticket', NO_OFFICE);

    expect((create.mock.calls[0][0] as unknown as Record<string, unknown>).locationId)
      .toBeUndefined();
  });

  it('is unchanged when the record holds no office — still the unassigned exit', async () => {
    const api = await client();
    directoryKnowsOnly(api, ON_RECORD);
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99005' } as never);
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', certain: true,
    });

    await runTool('file_optical_ticket', NO_OFFICE);
    await runTool('file_optical_ticket', NO_OFFICE);

    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.locationId).toBeUndefined();
    expect(payload.routingAskExhausted).toBe(true);
  });
});

/**
 * CODEX P2 ON PR #291 — a directory outage on the RECORD rung is still an
 * outage.
 *
 * The rung read only `locationId`, so an `outcome: 'unavailable'` answer was
 * discarded and the synthetic `no_match` survived. That is the collapse the
 * long comment on `lookupRan` warns about — "a lookup that never ran is not a
 * name that did not match" — reintroduced one rung further down, and it is
 * the shape that took optical to zero on 2026-08-31.
 *
 * SCOPE, MEASURED RATHER THAN ASSUMED, because the finding's wording is wider
 * than its effect: the filed payload is BYTE-IDENTICAL either way (both take
 * the unassigned exit at high priority), and the caller is never told the
 * false sentence, because reaching this rung requires `!cleanLocation`, which
 * means the early gate has already asked and set `askedForOfficeAlready`.
 * What the defect actually costs is the DIAGNOSIS: an operator reading the
 * logs during a directory outage is told we do not hold the office. So the
 * assertions here are about the log, deliberately — it is the only thing that
 * differs, and it is the thing being fixed.
 */
describe('the directory is down while we look up the record office', () => {
  it('reports an outage, not an office we do not have', async () => {
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue(
      { success: false, outcome: 'unavailable', locationId: undefined } as never,
    );
    const create = vi.spyOn(api, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-99006' } as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Optical',
      dateOfBirth: '01/01/1950', usualOffice: ON_RECORD, certain: true,
    });

    await runTool('file_optical_ticket', NO_OFFICE); // the early gate asks
    await runTool('file_optical_ticket', NO_OFFICE); // reaches the record rung

    const said = (spy: typeof err) => spy.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(said(err)).toContain('LOCATION LOOKUP UNAVAILABLE');
    expect(said(warn)).not.toContain('still does not resolve');

    // The request is still taken either way — stated so a future reader does
    // not mistake this for a lost-ticket fix.
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as unknown as Record<string, unknown>).routingAskExhausted)
      .toBe(true);
  });
});
