/**
 * PCP's records path files through the LIBRARY, not alongside it.
 *
 * Operator, 2026-08-14: *"I want to go through the process of building the
 * library to its completeness, verified, stable, so our agents can just call
 * it."*
 *
 * THE DRIFT THIS CLOSES, and it had already cost something. PCP filed a
 * patient's records request by calling `ticketingApiClient.createTicket`
 * directly with its own copy of the CAP logic. On 2026-08-13 the operator
 * ruled — *"can we hard gate the records to require the appropriate fields"* —
 * and `file_records_ticket` gained that gate. **PCP's copy did not.**
 *
 * So a right-of-access request arriving through PCP opened an `mr_cases` row
 * with no destination and no date range, starting a statutory clock nobody
 * could work. Two implementations, one of which learned yesterday's lesson.
 *
 * These tests assert the CONTRACT the library owns, against the real
 * `file_records_ticket` handler — the same code PCP now calls. If the gate
 * moves, PCP moves with it, which is the entire point of the migration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const createTicket = vi.fn();
const lookupProviderAndLocation = vi.fn();

vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: {
    createTicket: (...a: unknown[]) => createTicket(...a),
    lookupProviderAndLocation: (...a: unknown[]) => lookupProviderAndLocation(...a),
  },
  // Mirrors the real predicate: 'unavailable' means the lookup never ran, and
  // it is exactly equivalent to success === false. Kept in step with the
  // source rather than stubbed to a constant, or this mock would hide the
  // very distinction the predicate exists to make.
  lookupWasUnavailable: (r: { outcome?: string; success?: boolean } | null | undefined) =>
    r?.outcome === 'unavailable' || r?.success === false,
}));

const { getTool } = await import('../tools/registry');
await import('../tools/medicalRecordsTools');

const fileRecords = getTool('file_records_ticket')!;

/** Exactly what pcpAgent now passes, minus whatever a case is testing. */
const PCP_CALL = {
  first_name: 'Wayne',
  last_name: 'Fabian',
  date_of_birth: '03/17/1973',
  callback_number: '7605551234',
  request_description: 'Patient called the PCP Support line.\n\nI need a copy of my records.',
  requester: 'the patient themselves (Wayne Fabian)',
  call_sid: 'CAtest',
};

beforeEach(() => {
  vi.clearAllMocks();
  createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-52000' });
  lookupProviderAndLocation.mockResolvedValue({ success: true, locationId: null });
});

const run = (extra: Record<string, unknown> = {}) =>
  fileRecords.handler({ ...PCP_CALL, ...extra }) as Promise<any>;

describe('a records case always says where it is going, or that nobody said', () => {
  /**
   * OFF THE CLOCK THERE IS NO GATE, so the note is the only thing standing
   * between a clerk and a chart with no address. Added 2026-09-14, when
   * professional records requests began arriving here from PCP: those are
   * off-clock by definition and PCP can run out of asks. The line used to be
   * written only when the clock applied, on the reasoning that only then does
   * somebody have to act on the absence — true while every off-clock case came
   * from the records lane, which asks, and false the moment this route opened.
   */
  it('writes NOT CAPTURED for a missing destination even off the clock', async () => {
    const r = await run({
      requester: 'Dr Perez — De La Pena Family Medicine',
      requester_type: 'provider',
      date_range: 'the last year',
    });
    expect(r.success, `must file: ${JSON.stringify(r)}`).toBe(true);
    expect(r.cap_clock_applies, 'a provider request is not on the patient clock').toBe(false);
    const body = String((createTicket.mock.calls as any[])[0][0].description);
    expect(body, 'nobody can send a chart to an address nobody captured').toMatch(/Send to: NOT CAPTURED/);
  });
});

describe('the hard gate PCP was bypassing', () => {
  it('refuses to file a patient request without a destination and a date range', async () => {
    // The exact defect: PCP filed this immediately, on the clock, with neither.
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(expect.arrayContaining(['deliver_to', 'date_range']));
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('asks for whichever one is missing, in words the agent can say', async () => {
    const noDates = await run({ deliver_to: 'to me' });
    expect(noDates.missingFields).toEqual(['date_range']);
    expect(noDates.message).toMatch(/which dates/i);

    const noDest = await run({ date_range: 'everything' });
    expect(noDest.missingFields).toEqual(['deliver_to']);
    expect(noDest.message).toMatch(/where should these be sent/i);
  });

  it('accepts vague answers — the gate is on presence, not quality', async () => {
    // "Everything" and "not sure" are real answers from real callers. What is
    // not acceptable is silence in a column the CAP report reads.
    const r = await run({ deliver_to: 'to me', date_range: "I'm not sure, everything" });
    expect(r.success).toBe(true);
    expect(createTicket).toHaveBeenCalledOnce();
  });
});

describe('what the library sends that PCP\'s copy did not', () => {
  it('files into Medical Records with the CAP clock stated, not defaulted', async () => {
    await run({ deliver_to: 'to me', date_range: 'everything' });
    const payload = createTicket.mock.calls[0][0];
    expect(payload.departmentId).toBe(16);
    expect(payload.capClockApplies).toBe(true);
    expect(payload.requestorType).toBe('patient');
    // The name is the evidence a classification was made. Without it an audit
    // cannot tell "confirmed patient" from "defaulted to patient" — all 470
    // existing mr_cases rows are the latter.
    expect(payload.requestorName).toBeTruthy();
  });

  it('gives a records clerk the two facts on their own lines', async () => {
    await run({ deliver_to: 'fax 760-555-9999', date_range: 'last two years' });
    const { description } = createTicket.mock.calls[0][0];
    expect(description).toMatch(/Requested by:/);
    expect(description).toMatch(/Send to:.*fax 760-555-9999/);
    expect(description).toMatch(/Dates needed:.*last two years/);
  });

  it('keeps the PCP origin visible in the ticket', async () => {
    await run({ deliver_to: 'to me', date_range: 'everything' });
    const { description } = createTicket.mock.calls[0][0];
    expect(description).toMatch(/PCP Support line/);
  });
});

describe('the requester is known here, never inferred', () => {
  it('reads a patient calling for themselves as on the clock', async () => {
    // This path exists BECAUSE the director established callPurpose ===
    // 'patient_caller'. It is the one place on the PCP line where the
    // requester is a fact rather than a guess, which is why it is allowed
    // into department 16 at all.
    await run({ deliver_to: 'to me', date_range: 'everything' });
    expect(createTicket.mock.calls[0][0].requestPathway).toBe('roa_patient');
  });

  it('would NOT put a third party on the clock if the wording ever changed', async () => {
    // Guarding the inverse: if someone later passes an organisation here, the
    // library must not silently start a statutory clock for them.
    const r = await run({
      requester: "Anthem, the patient's health plan",
      deliver_to: 'fax 800-555-0000',
      date_range: 'everything',
    });
    expect(r.success).toBe(true);
    expect(createTicket.mock.calls[0][0].capClockApplies).toBe(false);
  });
});

describe('the reason cannot belong to another department', () => {
  it('ignores a reason id this queue does not own', async () => {
    // 153 is Clinical Tech Support's medication-refill reason. Whatever it is
    // handed, the tool files one of department 16's own.
    await run({ request_reason_id: '153', deliver_to: 'to me', date_range: 'everything' });
    const { requestReasonId } = createTicket.mock.calls[0][0];
    expect(requestReasonId).not.toBe(153);
  });
});
