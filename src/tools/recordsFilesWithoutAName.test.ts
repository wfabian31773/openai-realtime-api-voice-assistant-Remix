/**
 * THE RECORDS LINE ASKS ONCE, THEN FILES.
 *
 * Operator, 2026-09-27, approving points 2 and 3 of the records-line review
 * (docs/observatory/RECORDS-LINE-REVIEW-20260927.md): *"go ahead and flip
 * records to the runtime and the other 5 points."*
 *
 * Measured over 09-08..09-25 on the records line: 21 real conversations were
 * refused by `file_records_ticket` and never filed — eleven for a NAME, five
 * for the on-clock destination/date-range gate, one for a date of birth.
 * Twenty of the twenty-one lasted ninety seconds or more. The department is
 * under a Corrective Action Plan whose first rule is that every request is
 * LOGGED; a request refused for a name is not logged anywhere.
 *
 * These tests drive the REAL tool through `runTool`, the entry point the model
 * calls, on an invented caller. Each test uses its own canonical CallSid
 * because the ask budget is keyed on the call (`gateAttempts`), and the
 * fixture resets both stores so no test inherits another's spent ask.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTool } from './registry';
import './sharedPatientTools';
import './medicalRecordsTools';
import { NAME_NOT_CAPTURED_NOTE, RECORDS_ASK_LIMIT } from './medicalRecordsTools';
import { resetGateAttempts } from './gateAttempts';
import { rememberVerifiedIdentity, resetVerifiedIdentities } from './verifiedIdentity';

let sidCounter = 0x100;
function freshSid(): string {
  sidCounter += 1;
  return `CA${sidCounter.toString(16).padStart(32, '0')}`;
}

// A complete on-the-clock patient request with NO name. The date of birth is
// here so the date-of-birth gate — which has its own one-ask escape — is not
// what these tests measure.
const NAMELESS = {
  requester: 'I am the patient',
  // v79 asks a patient the form-channel question first; "declined" keeps
  // every path these tests measure exactly as it was.
  form_channel: 'declined',
  deliver_to: 'to me',
  date_range: 'everything',
  date_of_birth: '01/02/1950',
  callback_number: '845-531-7471',
  request_description: 'I need a copy of my records',
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

function ok(n: string) {
  return { success: true, ticketNumber: n } as never;
}

type Out = Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('the patient name: one ask, then the request files without it', () => {
  it('the limit is one — the tool asks, the caller answers or does not, the next call files', () => {
    expect(RECORDS_ASK_LIMIT).toBe(1);
  });

  it('asks for the FIRST name first — one field per question, RULE ZERO 2b', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const r = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: freshSid() })) as Out;

    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['first_name', 'last_name']);
    expect(r.message).toMatch(/patient's first name/i);
    expect(r.message).not.toMatch(/last name/i);
    expect(String(r.fix)).toMatch(/once/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('asks for the last name alone when the first is already in hand', async () => {
    const r = (await runTool('file_records_ticket', {
      ...NAMELESS,
      first_name: 'Testpatient',
      call_sid: freshSid(),
    })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['last_name']);
    expect(r.message).toMatch(/last name/i);
  });

  it('files on the second invocation with NO name and a staff note — the shape that lost eleven requests', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-NAMELESS-1'));
    const sid = freshSid();

    const first = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: sid })) as Out;
    expect(first.success).toBe(false);

    const second = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: sid })) as Out;
    expect(second.success).toBe(true);
    expect(create).toHaveBeenCalledOnce();

    const params = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    // Omitted, not blanked: the app treats a missing name as missing and a
    // blank one as a name.
    expect(params).not.toHaveProperty('patientFirstName');
    expect(params).not.toHaveProperty('patientLastName');
    expect(params.requestorName).toBeUndefined();
    // The note goes where staff read and NOT in the description, which
    // becomes the body of a patient-facing SMS.
    const callData = params.callData as Record<string, unknown>;
    expect(String(callData.transcript)).toContain(NAME_NOT_CAPTURED_NOTE);
    expect(String(params.description)).not.toContain('NOT CAPTURED');
    // It still reaches Medical Records, on the clock, with a callback number.
    expect(params.patientPhone).toBe('8455317471');
    expect(params.capClockApplies).toBe(true);
  });

  it('does not spend one call’s ask on another call', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const a = freshSid();
    const b = freshSid();
    await runTool('file_records_ticket', { ...NAMELESS, call_sid: a });
    const other = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: b })) as Out;
    expect(other.success).toBe(false);
    expect(other.missingFields).toEqual(['first_name', 'last_name']);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps asking every time when the CallSid is a sentinel — a shared counter is worse than a re-ask', async () => {
    // gateAttempts refuses to count against "unknown", "latest", or no SID at
    // all, so a retry landing on someone else's key can never spend their ask.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    for (const sid of ['unknown', undefined, 'latest']) {
      const r1 = (await runTool('file_records_ticket', { ...NAMELESS, ...(sid ? { call_sid: sid } : {}) })) as Out;
      const r2 = (await runTool('file_records_ticket', { ...NAMELESS, ...(sid ? { call_sid: sid } : {}) })) as Out;
      expect(r1.success, `first call, sid=${sid}`).toBe(false);
      expect(r2.success, `second call, sid=${sid}`).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

describe('RULE ZERO: a name the process already holds is never asked for', () => {
  it('takes the name from the CERTAIN identity lookup_patient established on this call', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-KNOWN-1'));
    const sid = freshSid();
    rememberVerifiedIdentity(sid, {
      firstName: 'Testpatient',
      lastName: 'Example',
      dateOfBirth: '1950-01-02',
      certain: true,
    });

    const r = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: sid })) as Out;
    expect(r.success).toBe(true);
    const params = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(params.patientFirstName).toBe('Testpatient');
    expect(params.patientLastName).toBe('Example');
    expect(params.requestorName).toBe('Testpatient Example');
    const callData = (params.callData ?? {}) as Record<string, unknown>;
    expect(String(callData.transcript ?? '')).not.toContain(NAME_NOT_CAPTURED_NOTE);
  });

  it('does NOT take a name from a phone candidate — a match is a candidate to confirm, never an identity', async () => {
    // Standing instruction 6 / RULE ZERO step 2. `verifiedIdentityFor` refuses
    // an uncertain entry, so the tool asks instead of guessing.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const sid = freshSid();
    rememberVerifiedIdentity(sid, {
      firstName: 'Testpatient',
      lastName: 'Example',
      dateOfBirth: '1950-01-02',
      certain: false,
    });

    const r = (await runTool('file_records_ticket', { ...NAMELESS, call_sid: sid })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['first_name', 'last_name']);
    expect(create).not.toHaveBeenCalled();
  });

  it('a name the caller GAVE still wins over the record', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-GIVEN-1'));
    const sid = freshSid();
    rememberVerifiedIdentity(sid, {
      firstName: 'Testpatient',
      lastName: 'Example',
      dateOfBirth: '1950-01-02',
      certain: true,
    });
    await runTool('file_records_ticket', {
      ...NAMELESS,
      first_name: 'Othername',
      last_name: 'Given',
      call_sid: sid,
    });
    const params = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(params.patientFirstName).toBe('Othername');
    expect(params.patientLastName).toBe('Given');
  });
});

describe('the on-clock gate asks once and then files with the gap written on the ticket', () => {
  const NAMED_BARE = {
    requester: 'I am the patient',
    form_channel: 'declined', // v79 — see NAMELESS
    first_name: 'Testpatient',
    last_name: 'Example',
    date_of_birth: '01/02/1950',
    callback_number: '845-531-7471',
    request_description: 'I need my records',
  };

  it('still refuses the first time, in the same words', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const r = (await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: freshSid() })) as Out;
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['deliver_to', 'date_range']);
    expect(r.message).toMatch(/where should these be sent/i);
    expect(String(r.fix)).toMatch(/once/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('files on the second invocation with both gaps marked NOT CAPTURED — five requests died here', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-ONCLOCK-1'));
    const sid = freshSid();

    await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: sid });
    const r = (await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: sid })) as Out;

    expect(r.success).toBe(true);
    const params = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(params.capClockApplies).toBe(true);
    // The same wording the PCP exit uses, so a clerk sees one phrase whichever
    // path filed the case.
    expect(String(params.description)).toContain('Send to: NOT CAPTURED');
    expect(String(params.description)).toContain('Dates needed: NOT CAPTURED');
  });

  it('a gap the caller then FILLED is not marked — the exit files what it has', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(ok('VA-ONCLOCK-2'));
    const sid = freshSid();

    await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: sid });
    const r = (await runTool('file_records_ticket', {
      ...NAMED_BARE,
      deliver_to: 'to me',
      call_sid: sid,
    })) as Out;

    expect(r.success).toBe(true);
    const params = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(params.description)).toContain('Send to: to me');
    expect(String(params.description)).toContain('Dates needed: NOT CAPTURED');
  });

  it('keeps refusing on a sentinel CallSid — the PCP opt-in flag is still the only exit there', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const r1 = (await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: 'unknown' })) as Out;
    const r2 = (await runTool('file_records_ticket', { ...NAMED_BARE, call_sid: 'unknown' })) as Out;
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('the two asks are budgeted separately — spending the name ask does not spend the on-clock ask', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket');
    const sid = freshSid();
    // Nameless AND bare: the name is asked first.
    const bare = { ...NAMED_BARE, first_name: undefined, last_name: undefined };
    const r1 = (await runTool('file_records_ticket', { ...bare, call_sid: sid })) as Out;
    expect(r1.missingFields).toEqual(['first_name', 'last_name']);
    // Second call: the name ask is spent, so the on-clock gate gets ITS one ask.
    const r2 = (await runTool('file_records_ticket', { ...bare, call_sid: sid })) as Out;
    expect(r2.success).toBe(false);
    expect(r2.missingFields).toEqual(['deliver_to', 'date_range']);
    expect(create).not.toHaveBeenCalled();
  });
});
