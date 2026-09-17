/**
 * THE FILED TICKET NUMBER REACHES THE CALL ROW — task #57, item (b).
 *
 * `ticketingApiClient.createTicket` is the one place every queue lane's
 * filing (optical, surgery, tech, records — and PCP's cross-queue path)
 * writes the ticket number back onto `call_logs`: found 2026-08-13, when the
 * grader read `call_logs.ticket_number` and scored 46% of tech's calls
 * ticketless on a day tech filed 106 real tickets. The write reuses
 * `releaseTicketCreationLock`, keyed on the call's SID, fire-and-forget.
 *
 * Every other link in the chain has a test — the binding dispatches
 * (`agentBinding.test.ts`), the tool reaches the durable filer
 * (`opticalTools.production.test.ts`, `durableTicketFiling.test.ts`), the
 * outbox path writes back (`ticketOutboxService.test.ts`) — and this link,
 * the HAPPY path's write-back, had none. Failure mode 10: both ends covered,
 * the link between them not. Behavioural, on the real client with the HTTP
 * layer stubbed, because the four source-slice tests on this file that
 * anchored on the wrong text are why `ticketingApiClientNullBody.test.ts`
 * drives a real call too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.TICKETING_SYSTEM_URL ||= 'https://ticketing.test';
process.env.TICKETING_API_KEY ||= 'test-key';

vi.mock('../../server/storage', () => ({
  storage: {
    releaseTicketCreationLock: vi.fn(async () => {}),
    getCallLogByCallSid: vi.fn(),
    updateCallLog: vi.fn(),
  },
}));

const { storage } = await import('../../server/storage');
const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const SID = 'CA' + 'b'.repeat(32);
const TICKET = 'VA-77001';

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function payload(callData: Record<string, unknown> | undefined) {
  return {
    departmentId: 1,
    requestTypeId: 66,
    requestReasonId: 536,
    patientFirstName: 'Test',
    patientLastName: 'Patient',
    patientPhone: '6265550100',
    description: 'Optical request',
    ...(callData === undefined ? {} : { callData }),
  } as never;
}

/** The write-back is `void import(...).then(...)`: let the dynamic import and
 * its continuation run. Two turns of the macrotask queue is more than it needs. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const lock = storage.releaseTicketCreationLock as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
    (init?.method ?? 'GET') === 'POST'
      ? okJson({ success: true, ticketNumber: TICKET, ticketId: 77001 })
      : okJson({}),
  );
  lock.mockReset();
  lock.mockResolvedValue(undefined);
});

describe('createTicket writes the ticket number back onto the call row', () => {
  it('by the call SID the payload carried, with the number the app gave back', async () => {
    const res = await ticketingApiClient.createTicket(payload({ agentUsed: 'optical', callSid: SID }));
    expect(res.success).toBe(true);
    expect(res.ticketNumber).toBe(TICKET);
    await flush();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(SID, TICKET);
  });

  it('never makes the filing wait on the bookkeeping', async () => {
    // A write that never settles must not hold the ticket back from the
    // caller: the number is read out the moment the app answers.
    lock.mockReturnValue(new Promise(() => {}));
    const res = await ticketingApiClient.createTicket(payload({ agentUsed: 'tech', callSid: SID }));
    expect(res.success).toBe(true);
    expect(res.ticketNumber).toBe(TICKET);
  });

  it('a failed write-back is one warning line, never a failed filing', async () => {
    lock.mockRejectedValue(new Error('pool exhausted'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await ticketingApiClient.createTicket(payload({ agentUsed: 'surgery', callSid: SID }));
      expect(res.success).toBe(true);
      await flush();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('ticket_number writeback failed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('with no SID on the payload there is nothing to key on — no write, and the filing still succeeds', async () => {
    const res = await ticketingApiClient.createTicket(payload(undefined));
    expect(res.success).toBe(true);
    await flush();
    expect(lock).not.toHaveBeenCalled();
  });

  it('is not written when the app answered without a number', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      (init?.method ?? 'GET') === 'POST' ? okJson({ success: true }) : okJson({}),
    );
    await ticketingApiClient.createTicket(payload({ agentUsed: 'optical', callSid: SID }));
    await flush();
    expect(lock).not.toHaveBeenCalled();
  });
});
