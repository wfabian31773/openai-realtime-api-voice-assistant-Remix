/**
 * A REFUSED RECORDS FILING IS LOGGED BEFORE THE CALLER IS TOLD IT IS — v127,
 * Codex P2 on #376.
 *
 * The first version of v127 answered a refusal the caller cannot fix with a
 * `fix` telling the model "nothing is lost … will be logged" and persisted
 * nothing. A terminal refusal bypasses the outbox by design, and the teardown
 * sweep is no guarantee: it skips a call where `check_open_tickets` found an
 * existing ticket, a call whose caller said only their name, and every lane
 * but records — and PCP reaches this same tool. So the assurance could reach a
 * caller whose request existed nowhere, which is the v18 shape: a branch
 * speaking the sentence that belongs to the one where the filing worked.
 *
 * Now the tool files a RECOVERY ticket in Medical Records first, and only a
 * recovery the app took — or the outbox holds — earns the assurance.
 *
 * Synthetic names and numbers only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

// A keyed filing is persisted BEFORE it is posted (v132, #390), so both the
// refused filing and its recovery go through the outbox. The fake keeps each
// payload and sends it through the mocked app; a 400/422 is terminal.
const stored = new Map<string, { params: Record<string, unknown> }>();
const writeToOutbox = vi.fn();
const attemptSend = vi.fn();
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox, attemptSend } };
});
function persistAndSend() {
  writeToOutbox.mockImplementation(async (payload: { params: Record<string, unknown> }) => {
    const outboxId = `ob-${stored.size}`;
    stored.set(outboxId, payload);
    return { outboxId, alreadyExists: false };
  });
  attemptSend.mockImplementation(async (outboxId: string) => {
    const payload = stored.get(outboxId);
    if (!payload) throw new Error('not persisted before sending');
    const api = (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
    const res = await api.createTicket(payload.params as never);
    const refused = !res.success && (res.statusCode === 400 || res.statusCode === 422);
    return { ...res, outboxId, ...(refused ? { terminal: true } : {}) };
  });
}

const { runTool } = await import('./registry');
await import('./sharedPatientTools');
const { RECOVERED_AFTER_REFUSAL_FIX, REFUSAL_NOT_LOGGED_FIX } = await import('./medicalRecordsTools');
const { resetGateAttempts } = await import('./gateAttempts');
const { resetVerifiedIdentities } = await import('./verifiedIdentity');
const { otherReasonFor } = await import('./otherReason');
const { SWEPT_TICKET_DESCRIPTION, buildSweptTicket } = await import('../runtime/requestSweep');

type Out = Record<string, unknown>;
type Params = Record<string, unknown>;

const MEDICAL_RECORDS = 16;
const SID = 'CA0123456789abcdef0123456789abcdef';

/** The app's refusal for a field no tool property can carry — not askable. */
const UNASKABLE_400 = { success: false, statusCode: 400, error: 'Missing required information: somethingElse' };
const FILED = (n: string) => ({ success: true, ticketNumber: n });
const OUTAGE = { success: false, error: 'upstream 503' };

/** A provider's office asking for a patient's chart — off the clock, no form ask. */
const THIRD_PARTY = {
  first_name: 'Testpatient',
  last_name: 'Example',
  date_of_birth: '01/02/1950',
  callback_number: '845-555-0142',
  requester: "Dr. Example's office, a referring provider",
  request_description: 'requesting a copy of the chart notes from the last visit',
  call_sid: SID,
};

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

/** The app answers each POST in turn. */
async function app(...answers: Params[]) {
  const api = await client();
  const spy = vi.spyOn(api, 'createTicket');
  for (const a of answers) spy.mockResolvedValueOnce(a as never);
  return { spy, posts: () => spy.mock.calls.map((c) => c[0] as unknown as Params) };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
  resetVerifiedIdentities();
  stored.clear();
  writeToOutbox.mockReset();
  attemptSend.mockReset();
  persistAndSend();
});

describe('a refusal the caller cannot fix is logged before anyone is told it is', () => {
  it('files a recovery ticket in Medical Records, then gives the assurance', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-1'));
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;

    const [refused, recovery] = posts();
    expect(posts(), 'the refused filing, then exactly one recovery').toHaveLength(2);

    // The teardown sweep's shape: department 16, its own Other, no name.
    const other = otherReasonFor(MEDICAL_RECORDS)!;
    expect(recovery.departmentId).toBe(MEDICAL_RECORDS);
    expect(recovery.requestTypeId).toBe(other.requestTypeId);
    expect(recovery.requestReasonId).toBe(other.requestReasonId);
    expect(recovery).not.toHaveProperty('patientFirstName');
    expect(recovery).not.toHaveProperty('patientLastName');
    expect(recovery.priority).toBe('high');
    // The description is an SMS body: nothing from the call in it.
    expect(recovery.description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(String(recovery.description)).not.toContain('chart notes');
    // Everything a clerk needs is on the staff side.
    const note = String((recovery.callData as Params).transcript);
    expect(note).toMatch(/^RECOVERED AFTER A REFUSAL/);
    expect(note).toContain('HTTP 400');
    expect(note).toContain('Testpatient Example');
    expect(note).toContain('chart notes from the last visit');
    expect(note).toContain('8455550142');
    expect(note).toContain(SID);
    // The app's own words never reach a ticket or a tool result.
    expect(note).not.toContain('somethingElse');
    expect(JSON.stringify(r)).not.toContain('somethingElse');

    // One key for the refused POST, the recovery and the teardown sweep, so
    // the sweep collapses onto this ticket rather than opening another.
    expect(recovery.idempotencyKey).toBe(refused.idempotencyKey);
    const swept = buildSweptTicket(
      { callSid: SID, slug: 'records', callerPhone: '8455550142', transcript: '', toolEvents: [], ticketAlreadyFiled: false },
      { file: true, callerSaid: '' },
    );
    expect(recovery.idempotencyKey).toBe(swept.idempotencyKey);

    expect(r.success).toBe(true);
    expect(r.ticket_number).toBe('VA-RECOVERED-1');
    expect(r.recovered_after_refusal).toBe(true);
    expect(r.form_applies).toBe(false);
    expect(r.fix).toBe(RECOVERED_AFTER_REFUSAL_FIX);
    expect(String(r.fix)).toMatch(/never tell them to call back/i);
    // v43: the instruction is in `fix`; the message is the readback.
    expect(String(r.message)).toMatch(/^Filed as VA-RECOVERED-1\./);
    expect(String(r.message)).not.toMatch(/general ticket|refus/i);
  });

  it('what the caller gave beyond the request reaches the staff side of the recovery', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-6'));
    await runTool('file_records_ticket', {
      ...THIRD_PARTY,
      location: 'Example Valley',
      provider: 'Dr. Testdoctor',
      email: 'records@example.com',
      deliver_to: 'fax 845-555-0199',
      date_range: 'the last two years',
    });
    const [, recovery] = posts();
    const note = String((recovery.callData as Params).transcript);
    expect(note).toContain('Example Valley');
    expect(note).toContain('Testdoctor');
    expect(note).toContain('records@example.com');
    expect(note).toContain('fax 845-555-0199');
    expect(note).toContain('the last two years');
    // and still none of it in the SMS body
    expect(String(recovery.description)).not.toMatch(/Example Valley|Testdoctor|example\.com/);
  });

  it('a callback extension rides on the staff note, not on the recovery\'s phone (v132)', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-7'));
    await runTool('file_records_ticket', { ...THIRD_PARTY, callback_number: '845-555-0142 ext 22' });
    const [refused, recovery] = posts();
    // The same split the filing itself makes: ten digits on the phone field,
    // the extension where a clerk reads it.
    expect(refused.patientPhone).toBe('8455550142');
    expect(recovery.patientPhone).toBe('8455550142');
    const note = String((recovery.callData as Params).transcript);
    expect(note).toContain('Callback extension: 22');
    expect(note).toContain('Call back on 8455550142.');
  });

  it('a routed request the app refuses says on the staff line where it read as belonging', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-2'));
    const r = (await runTool('file_records_ticket', {
      ...THIRD_PARTY,
      requester: 'I am the patient',
      request_description: 'I need to reschedule my appointment next week',
    })) as Out;
    const [refused, recovery] = posts();
    expect(refused.departmentId, 'the filing went to the Hub').toBe(9);
    expect(recovery.departmentId).toBe(MEDICAL_RECORDS);
    expect(String((recovery.callData as Params).transcript)).toMatch(/read as one for HVA Hub/);
    expect(r.success).toBe(true);
    expect(r.recovered_after_refusal).toBe(true);
  });

  it('a recovery the outbox holds is still an assurance, without a number', async () => {
    const { posts } = await app(UNASKABLE_400, OUTAGE);
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;
    expect(posts()).toHaveLength(2);
    // Both are persisted before they are posted; the second one is what the
    // outbox now holds, and it is the recovery, not the refused filing.
    expect(writeToOutbox).toHaveBeenCalledTimes(2);
    const held = writeToOutbox.mock.calls[1][0].params as Params;
    expect(held.departmentId).toBe(MEDICAL_RECORDS);
    expect(held.description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(r.success).toBe(true);
    expect(r.filed_pending).toBe(true);
    expect(r).not.toHaveProperty('ticket_number');
    expect(String(r.message)).toMatch(/no ticket number yet/i);
    expect(r.fix).toBe(RECOVERED_AFTER_REFUSAL_FIX);
  });

  it('a recovery refused too tells the model the truth: nothing was logged', async () => {
    const { posts } = await app(UNASKABLE_400, UNASKABLE_400);
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;
    expect(posts()).toHaveLength(2);
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.fix).toBe(REFUSAL_NOT_LOGGED_FIX);
    expect(String(r.fix)).toMatch(/NOT logged/);
    expect(String(r.fix)).not.toMatch(/nothing is lost|will follow up with them/i);
    expect(String(r.fix)).toMatch(/never tell them to call back/i);
    expect(r.message).toBeUndefined();
  });

  it('a recovery neither the app nor the outbox could take is not an assurance either', async () => {
    // The refused filing is persisted and refused; the recovery cannot even
    // be persisted, so the app never sees it.
    const persist = writeToOutbox.getMockImplementation()!;
    writeToOutbox.mockReset();
    writeToOutbox
      .mockImplementationOnce(persist)
      .mockRejectedValueOnce(new Error('database unreachable'));
    const { posts } = await app(UNASKABLE_400);
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;
    expect(posts()).toHaveLength(1);
    expect(r.success).toBe(false);
    expect(r.fix).toBe(REFUSAL_NOT_LOGGED_FIX);
    expect(String(r.fix)).toMatch(/NOT logged/);
  });

  it('no link goes out from a recovery, and the caller is not told there is no form', async () => {
    await app(UNASKABLE_400, FILED('VA-RECOVERED-3'));
    // A patient's own request: the records team still sends the form later.
    await runTool('file_records_ticket', {
      ...THIRD_PARTY,
      requester: 'I am the patient',
      form_channel: 'sms',
      request_description: 'copy of my records',
    });
    const api = await client();
    const resend = vi.spyOn(api, 'sendRecordsIntakeLink');
    const r = (await runTool('send_records_form', { channel: 'sms', call_sid: SID })) as Out;
    expect(resend).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(String(r.message)).toMatch(/team will follow up/i);
    expect(String(r.message)).not.toMatch(/no form/i);
    expect(String(r.fix)).toMatch(/do not call send_records_form again/i);
  });

  it('a recovered request has done its job: its name does not carry into the next request on the call', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-5'), FILED('VA-NEXT-1'));
    await runTool('file_records_ticket', THIRD_PARTY);
    const { first_name: _f, last_name: _l, ...nameless } = THIRD_PARTY;
    const next = (await runTool('file_records_ticket', nameless)) as Out;
    expect(next.missingFields, 'asked, not filled from the recovered request').toEqual(['first_name', 'last_name']);
    expect(posts()).toHaveLength(2);
  });

  it('PCP\'s second patient keeps its own key on the recovery', async () => {
    const { posts } = await app(UNASKABLE_400, FILED('VA-RECOVERED-4'));
    await runTool('file_records_ticket', { ...THIRD_PARTY, patient_scope: '-p2' });
    const [refused, recovery] = posts();
    expect(refused.idempotencyKey).toBe(`call-${SID}-p2`);
    expect(recovery.idempotencyKey).toBe(`call-${SID}-p2`);
  });
});

describe('what is not a refusal the caller cannot fix is answered as before', () => {
  it('a refusal for a field the tool can ask is a question, and nothing else is filed', async () => {
    // `office` is the one server field this tool has a property for.
    const { posts } = await app({ success: false, statusCode: 400, error: 'Missing required information: office' });
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;
    expect(posts(), 'no recovery behind a question').toHaveLength(1);
    expect(r.success).toBe(false);
    expect(r.missingFields).toEqual(['location']);
    expect(r).not.toHaveProperty('recovered_after_refusal');
  });

  it('a filing the outbox holds forgets its name halves, as a filed one does', async () => {
    const { posts } = await app(OUTAGE, FILED('VA-NEXT-2'));
    await runTool('file_records_ticket', THIRD_PARTY);
    // The next patient on the call, with only a first name so far.
    const { last_name: _l, ...firstOnly } = THIRD_PARTY;
    const next = (await runTool('file_records_ticket', { ...firstOnly, first_name: 'Otherpatient' })) as Out;
    expect(next.missingFields, 'the surname is asked for, not filled in').toContain('last_name');
    for (const p of posts().slice(1)) {
      expect(p.patientLastName, 'never the queued patient\'s surname').not.toBe('Example');
    }
  });

  it('an outage the outbox holds files no recovery: it is already persisted', async () => {
    const { posts } = await app(OUTAGE);
    const r = (await runTool('file_records_ticket', THIRD_PARTY)) as Out;
    expect(posts()).toHaveLength(1);
    expect(r.success).toBe(true);
    expect(r.filed_pending).toBe(true);
    expect(r).not.toHaveProperty('recovered_after_refusal');
  });
});
