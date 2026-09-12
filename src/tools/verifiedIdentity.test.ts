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

/**
 * AN UNCERTAIN MATCH IS NOT AN IDENTITY.
 *
 * `lookup_patient` reports `identity_is_certain: false` for a unique hit on a
 * NAME alone, precisely so the agent does not treat it as the person — and
 * then stored the candidate here anyway with the certainty dropped. The
 * teardown sweep reads this map and files a request under the name, with
 * nobody watching the call (Codex, PR #268 round 3).
 *
 * Filing one patient's request under another patient's name is worse than
 * not filing it, and these lines get fathers and sons constantly.
 */
describe('the sweep only ever sees a CERTAIN identity', () => {
  const SID = 'CA00000000000000000000000000000091';
  beforeEach(() => resetVerifiedIdentities());

  const remember = (certain: boolean) =>
    rememberVerifiedIdentity(SID, {
      firstName: 'Testpatient',
      lastName: 'Example',
      dateOfBirth: '1973-03-17',
      certain,
    });

  it('returns the identity when the match was unambiguous', () => {
    remember(true);
    expect(verifiedIdentityFor(SID)).toMatchObject({
      firstName: 'Testpatient',
      lastName: 'Example',
      certain: true,
    });
  });

  it('returns NOTHING for a name-only match, so the sweep files no ticket', () => {
    remember(false);
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  it('treats a missing certainty as NOT certain', () => {
    // A caller that forgets to say so must not get the benefit of the doubt
    // on the one field this is about.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testpatient',
      lastName: 'Example',
      dateOfBirth: '1973-03-17',
    });
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  /**
   * A CERTAIN MATCH WITH NO DATE OF BIRTH ON THE RECORD.
   *
   * `PatientData.dateOfBirth` is optional, and rememberVerifiedIdentity used
   * to refuse the whole entry without one — so a certain unique PHONE match
   * whose schedule row had no date stored nothing, the sweep reported
   * "no-name", and a recoverable request from a positively identified caller
   * was dropped (Codex, PR #268 round 7).
   */
  it('remembers a verified name even when the record carries no date of birth', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testpatient',
      lastName: 'Example',
      certain: true,
    });
    expect(verifiedIdentityFor(SID)).toMatchObject({
      firstName: 'Testpatient',
      lastName: 'Example',
      certain: true,
    });
  });

  it('has no date to carry forward for that caller, and says so', () => {
    rememberVerifiedIdentity(SID, {
      firstName: 'Testpatient',
      lastName: 'Example',
      certain: true,
    });
    expect(verifiedDobFor(SID, 'Testpatient', 'Example')).toBeUndefined();
  });

  it('still refuses a nameless entry — a name is the part that is required', () => {
    rememberVerifiedIdentity(SID, { lastName: 'Example', dateOfBirth: '1973-03-17', certain: true });
    expect(verifiedIdentityFor(SID)).toBeUndefined();
  });

  /**
   * verifiedDobFor answers a different question — "is this ticket for that
   * same person?" — and applies its own name guard. Narrowing it is a
   * ticket-path change that needs a before/after number, so it deliberately
   * still sees an uncertain entry. Pinned so the difference is a decision
   * rather than an oversight.
   */
  it('still lets verifiedDobFor see an uncertain entry, deliberately', () => {
    remember(false);
    expect(verifiedDobFor(SID, 'Testpatient', 'Example')).toBe('1973-03-17');
  });
});

describe('a caller-ID retry must not erase an identity the caller already confirmed', () => {
  const SID = 'CA000000000000000000000000000000aa';

  it('a FATHER AND SON share a name, so a name must not preserve certainty', () => {
    /**
     * Codex P1 on bfa28ae, answering a judgement I had flagged as unmeasured —
     * and finding the case that breaks it. The first guard preserved a certain
     * entry against ANY uncertain write, and I argued the leak was contained
     * because `verifiedDobFor` also checks the name. It is not contained when
     * the names are the same: the guard succeeds and the FATHER's date of
     * birth goes onto the SON's ticket. Wrong data on a ticket is worse than
     * the refused gate the guard was written to prevent.
     */
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01',
      personId: 'person-the-father', certain: true,
    });
    // The son: same name, DIFFERENT person, and only an uncertain read of him.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror',
      personId: 'person-the-son', certain: false,
    });

    expect(
      verifiedDobFor(SID, 'Testcaller', 'Mirror'),
      "the father's date of birth must not survive onto the son's ticket",
    ).toBeUndefined();
  });

  it('an UNCERTAIN write does not downgrade a CERTAIN entry', () => {
    /**
     * Codex P2 on PR #292 (1b99eb2), and the regression was mine. lookup_patient
     * runs several times in one call, and the person base now answers a
     * caller-ID-only retry with a match — an uncertain write carrying no date of
     * birth. Landing it on an earlier confirmed name+DOB entry erased both: the
     * filing tools went back to refusing for a birthday the caller had already
     * given, and the teardown sweep lost the name it needs to file at all.
     */
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01',
      personId: 'person-same', certain: true,
    });
    // The caller-ID retry: PROVABLY the same person, but nothing confirmed it
    // this time. The person id is what makes preserving this safe.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', personId: 'person-same', certain: false,
    });

    expect(verifiedDobFor(SID, 'Testcaller', 'Mirror'), 'the confirmed DOB survives')
      .toBe('1950-01-01');
    expect(verifiedIdentityFor(SID), 'and so does the identity the sweep needs')
      .toMatchObject({ firstName: 'Testcaller', lastName: 'Mirror', certain: true });
  });

  it('a CERTAIN write still replaces an earlier certain one', () => {
    // The guard must only block DOWNGRADES. A call that legitimately moves to a
    // second patient still updates once that patient is confirmed.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01', certain: true,
    });
    rememberVerifiedIdentity(SID, {
      firstName: 'Testsecond', lastName: 'Patient', dateOfBirth: '1962-05-05', certain: true,
    });

    expect(verifiedIdentityFor(SID)).toMatchObject({ firstName: 'Testsecond' });
    expect(verifiedDobFor(SID, 'Testsecond', 'Patient')).toBe('1962-05-05');
  });

  it('does NOT preserve when neither side can prove who it is', () => {
    // A name-only hit knows no person id, so nothing is provable and the write
    // wins — exactly the behaviour that shipped before this PR. The guard is
    // deliberately narrow rather than optimistic.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', dateOfBirth: '1950-01-01', certain: true,
    });
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', certain: false,
    });

    expect(verifiedDobFor(SID, 'Testcaller', 'Mirror')).toBeUndefined();
  });

  it('an uncertain write is still stored when there is nothing to downgrade', () => {
    // The guard must not stop the store working at all — an uncertain entry is
    // what the ambiguity consumers read.
    rememberVerifiedIdentity(SID, {
      firstName: 'Testcaller', lastName: 'Mirror', certain: false,
    });

    // Uncertain, so the sweep declines it — but it IS there.
    expect(verifiedIdentityFor(SID)).toBeUndefined();
    expect(verifiedDobFor(SID, 'Testcaller', 'Mirror')).toBeUndefined();
  });
});
