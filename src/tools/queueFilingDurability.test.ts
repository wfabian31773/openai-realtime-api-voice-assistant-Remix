/**
 * THE WIRING, not the mechanism.
 *
 * `durableTicketFiling.test.ts` proves that a failed POST is captured. This
 * proves the four tools that take every live queue call actually go through it
 * — which is the half that rots. The four filing tools were written at
 * different times from a copy of each other, and the block being replaced here
 * (`const res = await ticketingApiClient.createTicket({...})` followed by a
 * bare `retryable: true`) is duplicated in all four. A fifth queue is coming.
 *
 * Read as text on purpose, in the idiom of agentWiring.test.ts: the thing being
 * checked is whether one file still calls what another file provides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const writeToOutbox = vi.fn();
vi.mock('../services/ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox } };
});

const QUEUE_TOOL_FILES = [
  'opticalTools.ts',
  'surgeryTools.ts',
  'techTools.ts',
  'medicalRecordsTools.ts',
];

describe('every queue filing tool files durably', () => {
  for (const file of QUEUE_TOOL_FILES) {
    const src = readFileSync(join(__dirname, file), 'utf8');

    it(`${file} files through createTicketDurable`, () => {
      expect(src).toMatch(/await createTicketDurable\(\{/);
    });

    it(`${file} does not POST a ticket around it`, () => {
      // The lookup calls on this client are fine and expected; only the create
      // is routed, because only the create carries a request that can be lost.
      expect(src).not.toMatch(/ticketingApiClient\.createTicket\(/);
    });

    it(`${file} answers a failed POST with postFailureToolResult`, () => {
      expect(src).toMatch(/return postFailureToolResult\(res\);/);
    });
  }
});

// Clinical Tech Support: 9,288 tickets in 90 days, 103 a day, and it is the
// medication queue.
const { runTool } = await import('./registry');
await import('./sharedPatientTools');
await import('./techTools');

async function client() {
  return (await import('../../server/services/ticketingApiClient')).ticketingApiClient;
}

describe('the largest queue, end to end', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    writeToOutbox.mockReset();
    writeToOutbox.mockResolvedValue({ outboxId: 'ob-tech-1', alreadyExists: false });
  });

  it('captures the request when create-ticket fails, and says so without a number', async () => {
    const api = await client();
    // The 2026-08-31 signature: HTTP 200, body was not JSON.
    vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: false,
      error: 'Invalid JSON response from ticketing API: 200',
    } as never);

    const res = (await runTool('file_tech_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
      call_sid: 'CA00000000000000000000000000000009',
    })) as Record<string, unknown>;

    // Before this wiring the caller's refill request existed only in a local
    // variable that had already gone out of scope.
    expect(writeToOutbox).toHaveBeenCalledOnce();
    const [payload, callSid] = writeToOutbox.mock.calls[0];
    expect(payload.params.departmentId).toBe(3);
    expect(payload.params.description).toMatch(/Latanoprost/);
    expect(payload.params.callData.agentUsed).toBe('tech');
    expect(callSid).toBe('CA00000000000000000000000000000009');

    expect(res.success).toBe(true);
    expect(res.filed_pending).toBe(true);
    expect(res.ticket_number).toBeUndefined();
  });

  it('does not touch the outbox on a normal filing', async () => {
    const api = await client();
    vi.spyOn(api, 'createTicket').mockResolvedValue({
      success: true,
      ticketNumber: 'VA-52200',
    } as never);

    const res = (await runTool('file_tech_ticket', {
      first_name: 'Wayne',
      last_name: 'Fabian',
      date_of_birth: '03/17/1973',
      callback_number: '845-531-7471',
      request_description: 'I need a refill of my Latanoprost',
    })) as Record<string, unknown>;

    expect(res.ticket_number).toBe('VA-52200');
    expect(writeToOutbox).not.toHaveBeenCalled();
  });
});
