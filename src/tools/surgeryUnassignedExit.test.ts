/**
 * THE SECOND ATTEMPT SAYS THE ASK IS SPENT — surgery, operator ruling 2026-09-30.
 *
 * This tool has never had a surgeon gate of its own. It always files; the
 * refusal comes from the ticketing app, which answers HTTP 400 "Missing
 * required information: surgeon" and rejects the ticket. `postFailureToolResult`
 * turns that into a sentence the agent puts to the caller, so the app's refusal
 * IS this queue's ask.
 *
 * From 2026-09-02 the exit (`routingAskExhausted`, Wayne's ruling that evening,
 * extending to surgery the exit optical already had) opened only once TWO
 * refusals were noted — the third attempt. Measured on 2026-09-29, seven
 * surgery calls died holding exactly two refusals and never made a third
 * attempt, while the calls that filed were the ones that did; four of the
 * seven were spaced pairs a lower threshold rescues on their last attempt, and
 * three were CONCURRENT pairs no threshold reaches (see the residue block).
 * Wayne, 2026-09-30: "lower the surgeon exit to the second refusal."
 *
 * What these tests pin is still the NARROWNESS. The flag is the one thing
 * standing between the ticketing app's gate and no gate at all, and department
 * 2's provider fill has already been driven from ~98% to 49% once by a change
 * that looked smaller than this one. The first refusal is still the ask; a
 * refusal for another field, an outage, a sentinel CallSid, a resolved surgeon
 * and a redirect all still keep the flag off the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';
vi.mock('../../server/db', () => ({ db: {} }));

import { runTool } from './registry';
import './sharedPatientTools';
import './surgeryTools';
import { resetGateAttempts } from './gateAttempts';

const SID = 'CA747908b5d46b7ed25cffe733fb792738';

/** Linda Sisco's shape: verified caller, real request, no surgeon anywhere. */
const NO_SURGEON = {
  first_name: 'Linda',
  last_name: 'Sisco',
  date_of_birth: '05/22/1948',
  callback_number: '909-555-0147',
  request_description: 'I need to know when my cataract surgery is scheduled',
  call_sid: SID,
};

/** What create-ticket answers a department-2 payload with no surgeon. */
const SURGEON_REFUSAL = {
  success: false,
  statusCode: 400,
  error: 'Missing required information: surgeon. Surgery tickets are assigned by surgeon.',
} as never;

const FILED = { success: true, ticketNumber: 'VA-EXIT-1' } as never;

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
});

describe('the first attempt is still the ask', () => {
  it('does not claim the ask is spent on a call that has never been refused', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(SURGEON_REFUSAL);

    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    // And the refusal still reaches the agent as a question about the surgeon.
    expect((res as { missingFields?: string[] }).missingFields).toEqual(['surgeon']);
  });
});

describe('the second attempt says the ask is spent — operator ruling 2026-09-30', () => {
  it('carries routingAskExhausted once the app has refused this call once', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(FILED);

    await runTool('file_surgery_ticket', NO_SURGEON);
    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[1][0].routingAskExhausted).toBe(true);
    expect((res as { success: boolean; ticket_number?: string }).ticket_number).toBe('VA-EXIT-1');
  });

  /**
   * THE 2026-09-29 CORPUS CHAIN. All seven surgery calls lost on the surgeon
   * gate that day had taken the date-of-birth refusal FIRST: date_of_birth,
   * then surgeon, then surgeon, then nothing. The date-of-birth refusal is
   * this tool's own gate and never reaches the app, so it must not spend the
   * surgeon ask — and the one surgeon refusal that follows must.
   */
  it('a date-of-birth refusal first does not spend it; one surgeon refusal does', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(FILED);

    const { date_of_birth: _omitted, ...noDob } = NO_SURGEON;
    const first = await runTool('file_surgery_ticket', noDob);
    // Refused locally for the date of birth: the app was never asked.
    expect((first as { missingFields?: string[] }).missingFields).toEqual(['date_of_birth']);
    expect(create).not.toHaveBeenCalled();

    await runTool('file_surgery_ticket', NO_SURGEON); // the app's surgeon refusal
    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();

    await runTool('file_surgery_ticket', NO_SURGEON); // one surgeon refusal noted: the exit
    expect(create.mock.calls[1][0].routingAskExhausted).toBe(true);
  });

  it('never lets one call spend another call’s ask', async () => {
    // The counter is keyed by CallSid. Call A is driven PAST the threshold, so
    // call B staying silent on its first attempt is a fact about the key
    // rather than about the count not being high enough yet.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    // Call A has now spent its ask — prove that, or the next line is vacuous.
    expect(create.mock.calls[1][0].routingAskExhausted).toBe(true);

    const OTHER = { ...NO_SURGEON, call_sid: 'CAcf07a0202a54d64eb10fbc2e4525d668' };
    await runTool('file_surgery_ticket', OTHER);
    await runTool('file_surgery_ticket', OTHER);

    // B's first refusal is its own, not inherited from A; its second attempt
    // is where B earns its own exit.
    expect(create.mock.calls[2][0].routingAskExhausted).toBeUndefined();
    expect(create.mock.calls[3][0].routingAskExhausted).toBe(true);
  });

  it('does not spend the ask on a sentinel call_sid', async () => {
    // `call_sid` is a declared property, so a model with no injected value
    // supplies "unknown". A truthiness key would pool every such call into one
    // counter, and the second sentinel-bearing caller would be filed unassigned
    // without ever being asked. gateAttempts validates the key; this proves the
    // surgery path inherits that.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(SURGEON_REFUSAL);

    const SENTINEL = { ...NO_SURGEON, call_sid: 'unknown' };
    await runTool('file_surgery_ticket', SENTINEL);
    await runTool('file_surgery_ticket', SENTINEL);
    await runTool('file_surgery_ticket', SENTINEL);

    // Three refusals. A real SID would have opened the exit on the second; a
    // sentinel never counts at all, so it never opens.
    expect(create).toHaveBeenCalledTimes(3);
    for (const call of create.mock.calls) {
      expect(call[0].routingAskExhausted).toBeUndefined();
    }
  });

  it('does not spend the ask on a refusal for a DIFFERENT field', async () => {
    // A ticket refused for a missing office has not asked anything about the
    // surgeon, so it must not buy the surgeon exit on the next attempt — not
    // even two of them, which is past the threshold if office refusals counted.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({
        success: false,
        statusCode: 400,
        error: 'Missing required information: office.',
      } as never)
      .mockResolvedValueOnce({
        success: false,
        statusCode: 400,
        error: 'Missing required information: office.',
      } as never)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[2][0].routingAskExhausted).toBeUndefined();
  });

  it('does not spend the ask on an OUTAGE, which is not a refusal', async () => {
    // A 503 means nobody read the payload. The caller was never asked
    // anything, so the next attempt must not claim they were — and the outbox
    // will re-send the original payload regardless.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce({ success: false, statusCode: 503, error: 'upstream down' } as never)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
  });
});

describe('the residue the threshold cannot reach — recorded, not hidden', () => {
  /**
   * THE CONCURRENT PAIR. On 2026-09-29 three of the seven surgery calls lost
   * on this gate had their two surgeon-refused attempts IN FLIGHT AT ONCE: the
   * model emitted two identical filing calls in one response, the second
   * started 0.9–1.1 s before the first refusal returned, and both read a
   * count of zero. The counter is written where the app's refusal is handled,
   * so no threshold can see a refusal that has not come back yet. That is the
   * v57 shape (CLAUDE.md, THE SURGEON CLAIM), and serialising the attempts to
   * close it drew six review rounds before it was withdrawn.
   *
   * This asserts the behaviour as it is, so the residue is visible in the
   * suite rather than implied by a green run. A sequential third attempt then
   * reads both refusals and opens the exit, exactly as before.
   */
  it('two attempts in flight at once both read the count before either refusal lands', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(SURGEON_REFUSAL), 25)),
      );

    await Promise.all([
      runTool('file_surgery_ticket', NO_SURGEON),
      runTool('file_surgery_ticket', NO_SURGEON),
    ]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();

    // Both refusals are noted now; a third attempt made after them is the exit.
    create.mockResolvedValueOnce(FILED);
    const res = await runTool('file_surgery_ticket', NO_SURGEON);
    expect(create.mock.calls[2][0].routingAskExhausted).toBe(true);
    expect((res as { ticket_number?: string }).ticket_number).toBe('VA-EXIT-1');
  });
});

describe('the flag never travels where it would do harm', () => {
  it('is absent once a surgeon actually resolved', async () => {
    // The exit says "nobody could route this". A ticket that DID resolve a
    // surgeon must never ask for manual routing it does not need.
    const api = await client();
    vi.spyOn(api, 'lookupProviderAndLocation').mockResolvedValue({
      success: true,
      outcome: 'matched',
      providerId: 31,
      locationId: undefined,
      locationMatches: [],
    } as never);
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-2' } as never);

    const withSurgeon = { ...NO_SURGEON, surgeon: 'Kweku Grant-Acquah' };
    await runTool('file_surgery_ticket', withSurgeon);
    await runTool('file_surgery_ticket', withSurgeon);

    // Past the threshold, so the flag would be sent but for the providerId.
    expect(create.mock.calls[1][0].providerId).toBe(31);
    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
  });

  it('is absent on a request redirected off the surgery queue', async () => {
    // detectCrossQueue can file into Optical or the HVA Hub. Those queues are
    // not gated on a surgeon, so an exit from surgery's gate is meaningless
    // there — and would put "needs manual routing" in someone else's view.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-3' } as never);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', {
      ...NO_SURGEON,
      request_description: 'I need to reschedule my regular eye exam appointment',
    });

    const second = create.mock.calls[1][0];
    // The threshold IS met — so the redirect is the only thing suppressing the
    // flag, which is what this test is about.
    expect(second.departmentId).not.toBe(2);
    expect(second.routingAskExhausted).toBeUndefined();
  });
});
