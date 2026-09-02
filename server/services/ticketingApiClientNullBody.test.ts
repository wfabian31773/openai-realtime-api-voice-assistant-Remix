/**
 * A 4xx WHOSE BODY IS THE JSON LITERAL `null`.
 *
 * Codex, PR #244 round nine. `response.json()` succeeds and hands back `null`,
 * and then `data.error` throws a TypeError — before `httpError.statusCode` is
 * assigned. That throw lands in the network catch below it, is rewrapped as an
 * unreachable-service error with no status, and so `createTicketDurable`
 * classifies a PAYLOAD REFUSAL as a transport failure: the request is queued to
 * the outbox, the caller is told it was recorded, and the worker re-sends the
 * same bytes to the same "no" until it dead-letters.
 *
 * The optional form was already in use two lines above, in the 404 no-ticket
 * check. This is the same read, written unsafely.
 *
 * Behavioural rather than source-text: four source-slice tests on this branch
 * have anchored on the wrong text and asserted nothing, so where a real call
 * can be driven, it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.TICKETING_SYSTEM_URL ||= 'https://ticketing.test';
process.env.TICKETING_API_KEY ||= 'test-key';

vi.mock('../../server/storage', () => ({
  storage: {
    getCallLogByCallSid: vi.fn(),
    updateCallLog: vi.fn(),
  },
}));

const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/** A response whose body is exactly `null`, as JSON. */
const nullBody = (status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => 'null',
  json: async () => null,
});

const PAYLOAD = {
  departmentId: 1,
  requestTypeId: 66,
  requestReasonId: 536,
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
  patientPhone: '+16265551234',
  description: 'Optical request',
  callData: { agentUsed: 'optical', callSid: 'CA' + 'a'.repeat(32) },
} as never;

beforeEach(() => {
  fetchMock.mockReset();
  // Warm-up probes and any other GET succeed; only the POST answers null.
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') !== 'POST') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    return nullBody(400);
  });
});

describe('a refusal with a null body keeps its status', () => {
  it('reports the 400 rather than losing it to a TypeError', async () => {
    const res = await ticketingApiClient.createTicket(PAYLOAD);

    expect(res.success).toBe(false);
    // The whole point: without the null-safe read this is undefined, and a
    // permanent refusal is queued to the outbox as though the far side were
    // down.
    expect(res.statusCode).toBe(400);
  });

  it('does not describe a refusal as an unreachable service', async () => {
    const res = await ticketingApiClient.createTicket(PAYLOAD);
    expect(String(res.error ?? '')).not.toMatch(/unreachable|unavailable|fetch failed/i);
  });

  it('does the same for 422, the other terminal status', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') !== 'POST') return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
      return nullBody(422);
    });
    const res = await ticketingApiClient.createTicket(PAYLOAD);
    expect(res.statusCode).toBe(422);
  });
});
