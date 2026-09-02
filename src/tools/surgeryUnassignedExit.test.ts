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

describe('the first attempt is unchanged — it asks', () => {
  it('does not claim the ask is spent on a call that has never been refused', async () => {
    const api = await client();
    const create = vi.spyOn(api, 'createTicket').mockResolvedValueOnce(SURGEON_REFUSAL);

    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[0][0].routingAskExhausted).toBeUndefined();
    // And the refusal still reaches the agent as a question about the surgeon.
    expect((res as { missingFields?: string[] }).missingFields).toEqual(['surgeon']);
  });
});

describe('the second attempt says the ask is spent', () => {
  it('carries routingAskExhausted after the app has already refused this call', async () => {
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-EXIT-1' } as never);

    await runTool('file_surgery_ticket', NO_SURGEON);
    const res = await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[1][0].routingAskExhausted).toBe(true);
    expect((res as { success: boolean; ticket_number?: string }).ticket_number).toBe('VA-EXIT-1');
  });

  it('never lets one call spend another call’s ask', async () => {
    // The counter is keyed by CallSid. A refusal on one call must not make the
    // NEXT caller look already-asked and skip their question entirely.
    const api = await client();
    const create = vi
      .spyOn(api, 'createTicket')
      .mockResolvedValueOnce(SURGEON_REFUSAL)
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', {
      ...NO_SURGEON,
      call_sid: 'CAcf07a0202a54d64eb10fbc2e4525d668',
    });

    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
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

    await runTool('file_surgery_ticket', { ...NO_SURGEON, call_sid: 'unknown' });
    await runTool('file_surgery_ticket', { ...NO_SURGEON, call_sid: 'unknown' });

    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
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
      .mockResolvedValueOnce(SURGEON_REFUSAL);

    await runTool('file_surgery_ticket', NO_SURGEON);
    await runTool('file_surgery_ticket', NO_SURGEON);

    expect(create.mock.calls[1][0].routingAskExhausted).toBeUndefined();
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
    // Assert the redirect actually happened, or the next line proves nothing.
    expect(second.departmentId).not.toBe(2);
    expect(second.routingAskExhausted).toBeUndefined();
  });
});
