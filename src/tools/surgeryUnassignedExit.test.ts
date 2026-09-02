/**
 * THE SECOND REFUSAL IS NOT A QUESTION — surgery, 2026-09-02.
 *
 * This tool has never had a surgeon gate of its own. It always files; the
 * refusal comes from the ticketing app, which answers HTTP 400 "Missing
 * required information: surgeon" and rejects the ticket. `postFailureToolResult`
 * turns that into a sentence the agent puts to the caller, so the app's refusal
 * IS this queue's ask.
 *
 * Which means the app's SECOND refusal asks nothing. The agent has already put
 * the question, the caller has already failed to answer it, and the call ends
 * with no ticket. Two of the six surgery requests lost on the afternoon of
 * 2026-09-02 died precisely there: one caller had no provider anywhere on their
 * record, the other named a surgeon absent from the providers table entirely.
 *
 * Wayne's ruling that evening, extending to surgery the exit optical already
 * had for its own bounded ask (`gateAttempts.ts`, 2026-09-01): take the request
 * unassigned. `routingAskExhausted` is how this tool says the ask is spent.
 *
 * What these tests pin is the NARROWNESS. The flag is the one thing standing
 * between the ticketing app's gate and no gate at all, and department 2's
 * provider fill has already been driven from ~98% to 49% once by a change that
 * looked smaller than this one.
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

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetGateAttempts();
});

describe('the attempts where the ask still lands are unchanged', () => {
  it('does not claim the ask is spent on a call that has never been refused', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(SURGEON_REFUSAL);

    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    // And the refusal still reaches the agent as a question about the surgeon.
    expect((res as { missingFields?: string[] }).missingFields).toEqual(['surgeon']);
  });

  /**
   * ONE REFUSAL IS NOT PROOF THE CALLER WAS ASKED.
   *
   * CA101be0fe842e77fd83a6024ae06df244, 2026-09-02: file_surgery_ticket
   * refused at 15:25:24.064 and was called again at 15:25:25.270 — 1.2
   * seconds later, identical payload. "And which surgeon are you seeing?"
   * comes AFTER that pair, not between them. The model spent a retry before
   * it asked the caller anything.
   *
   * Attempt 2 is also where 38 of the 196 refused surgery calls in the 14
   * days to 2026-09-02 were RESCUED — the ask worked and a real surgeon
   * arrived. Firing the exit there would file those unassigned instead of
   * routed, which is the provider-fill regression this whole guard exists
   * to avoid.
   */
  it('does not fire on attempt 2, where the ask usually lands', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
  });
});

describe('the third attempt says the ask is spent', () => {
  it('carries routingAskExhausted once the app has refused this call twice', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-1' } as never);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[2][0].routingAskExhausted).toBe(true);
    expect((res as { success: boolean; ticket_number?: string }).ticket_number).toBe('VA-EXIT-1');
  });

  it('never lets one call spend another call’s ask', async () => {
    // The counter is keyed by CallSid. Call A is driven PAST the threshold, so
    // call B staying silent is a fact about the key rather than about the
    // count not being high enough yet.
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValue(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    // Call A has now spent its ask — prove that, or the next line is vacuous.
    expect(create.mock.calls[2][0].routingAskExhausted).toBe(true);

    const OTHER = { ...NO_SURGEON, call_sid: 'CAcf07a0202a54d64eb10fbc2e4525d668' };
    await runTool('file_surgery_ticket', OTHER);
    await runTool('file_surgery_ticket', OTHER);
    await runTool('file_surgery_ticket', OTHER);

    // Three refusals on B, none of them inherited from A: still its own first
    // three, and the third is where B earns its own exit.
    expect(create.mock.calls[3][0].routingAskExhausted).toBeUndefined();
    expect(create.mock.calls[4][0].routingAskExhausted).toBeUndefined();
    expect(create.mock.calls[5][0].routingAskExhausted).toBe(true);
  });

  it('does not spend the ask on a sentinel call_sid', async () => {
    // `call_sid` is a declared property, so a model with no injected value
    // supplies "unknown". A truthiness key would pool every such call into one
    // counter, and the second sentinel-bearing caller would be filed unassigned
    // without ever being asked. gateAttempts validates the key; this proves the
    // surgery path inherits that.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    const SENTINEL = { ...NO_SURGEON, call_sid: 'unknown' };
    await runTool('file_surgery_ticket', SENTINEL);
    await runTool('file_surgery_ticket', SENTINEL);
    await runTool('file_surgery_ticket', SENTINEL);
    await runTool('file_surgery_ticket', SENTINEL);

    // Four refusals. A real SID would have opened the exit on the third; a
    // sentinel never counts at all, so it never opens.
    for (const call of create.mock.calls) {
      expect(call[0].routingAskExhausted).toBeUndefined();
    }
  });

  it('does not spend the ask on a refusal for a DIFFERENT field', async () => {
    // A ticket refused for a missing office has not asked anything about the
    // surgeon, so it must not buy the surgeon exit on the next attempt.
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
    // Two office refusals is where the surgeon threshold would sit if office
    // refusals counted. They do not.
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
      .mockResolvedValueOnce({ success: false, statusCode: 503, error: 'upstream down' } as never)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[2][0].routingAskExhausted).toBeUndefined();
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
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-2' } as never);

    const withSurgeon = { ...NO_SURGEON, surgeon: 'Kweku Grant-Acquah' };
    await runTool('file_surgery_ticket', withSurgeon);
    await runTool('file_surgery_ticket', withSurgeon);
    await runTool('file_surgery_ticket', withSurgeon);

    // Past the threshold, so the flag would be sent but for the providerId.
    expect(create.mock.calls[2][0].providerId).toBe(31);
    expect(create.mock.calls[2][0].routingAskExhausted).toBeUndefined();
  });

  it('is absent on a request redirected off the surgery queue', async () => {
    // detectCrossQueue can file into Optical or the HVA Hub. Those queues are
    // not gated on a surgeon, so an exit from surgery's gate is meaningless
    // there — and would put "needs manual routing" in someone else's view.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-3' } as never);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', {
      ...NO_SURGEON,
      request_description: 'I need to reschedule my regular eye exam appointment',
    });

    const third = create.mock.calls[2][0];
    // The threshold IS met — so the redirect is the only thing suppressing the
    // flag, which is what this test is about.
    expect(third.departmentId).not.toBe(2);
    expect(third.routingAskExhausted).toBeUndefined();
  });
});
