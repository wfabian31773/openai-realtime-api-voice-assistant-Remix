/**
 * THE THIRD WAY INTO create-ticket, and until 2026-08-14 the only one that did
 * not live in ticketingApiClient.
 *
 * The scheduling agent routes by OFFICE rather than by department: it posts
 * `queue: 'location'` with a `locationName` and lets the server pick the team.
 * `createTicket` cannot express that — `departmentId` is required there — so
 * `azulSchedulingAgent` carried its own raw `fetch`, and with it its own
 * timeout, its own writeback, its own env check, and NO WARM-UP.
 *
 * That last one is what mattered. Every other caller probes first because the
 * ticketing app is a Replit deployment that sleeps. This path went straight to
 * `fetch`, so a sleeping deployment lost the ticket and left a console line —
 * on the queue that books real appointments and files the failed-transfer
 * callbacks.
 *
 * These tests pin the behaviour that MOVED, because moving working code is
 * exactly where it quietly stops working.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.TICKETING_SYSTEM_URL ||= 'https://ticketing.test';
process.env.TICKETING_API_KEY ||= 'test-key';

const getCallLogByCallSid = vi.fn();
const updateCallLog = vi.fn();

vi.mock('../../server/storage', () => ({
  storage: {
    getCallLogByCallSid: (...a: unknown[]) => getCallLogByCallSid(...a),
    updateCallLog: (...a: unknown[]) => updateCallLog(...a),
  },
}));

const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

/** Anything that is not the create-ticket POST — the warm-up probe. */
const isProbe = (url: string) => !String(url).includes('/api/voice-agent/create-ticket');

const BODY = { queue: 'location', locationName: 'Redlands', description: 'AI scheduling handoff' };

const call = (over: Record<string, unknown> = {}) =>
  ticketingApiClient.createLocationQueueTicket({
    locationName: 'Redlands',
    defaultLocationName: 'Encinitas',
    body: { ...BODY },
    callSid: 'CAtest',
    ...over,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  getCallLogByCallSid.mockResolvedValue({ id: 'log-1', ticketNumber: null });
  updateCallLog.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async (url: string) =>
    isProbe(url) ? res(200, { ok: true }) : res(200, { ticketNumber: 'VA-53000' }),
  );
});

describe('the warm-up this path never had', () => {
  it('probes before posting the ticket', async () => {
    await call();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some(isProbe), 'no warm-up probe was made').toBe(true);
    // And the ticket still goes out.
    expect(urls.some((u) => u.includes('/api/voice-agent/create-ticket'))).toBe(true);
  });

  it('still files when the probe fails — warm-up is advisory, not a gate', async () => {
    // A health probe that cannot answer must never stop a ticket that would
    // otherwise be filed. Same ruling as every other caller.
    fetchMock.mockImplementation(async (url: string) =>
      isProbe(url) ? Promise.reject(new Error('probe down')) : res(200, { ticketNumber: 'VA-53001' }),
    );
    const r = await call();
    expect(r.ok).toBe(true);
    expect(r.ticketNumber).toBe('VA-53001');
  });
});

describe('the 422 re-file, moved intact', () => {
  it('re-files into the default queue when the office has none, naming the real office', async () => {
    // Not every location is onboarded (Redlands was the live example). Losing
    // the ticket would be worse than routing it to the pilot queue.
    let posts = 0;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (isProbe(url)) return res(200, {});
      posts += 1;
      return posts === 1 ? res(422, 'no queue') : res(200, { ticketNumber: 'VA-53002' });
    });

    const r = await call();
    expect(r.ok).toBe(true);
    expect(r.refiled).toBe(true);
    expect(r.ticketNumber).toBe('VA-53002');

    const second = JSON.parse(
      fetchMock.mock.calls.filter((c) => !isProbe(String(c[0])))[1][1].body as string,
    );
    expect(second.locationName).toBe('Encinitas');
    expect(second.description).toMatch(/For office: Redlands/);
    expect(second.description).toMatch(/no queue onboarded yet/);
  });

  it('does NOT re-file when the office already IS the default', async () => {
    // Otherwise a 422 on the default queue posts the same ticket twice.
    let posts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (isProbe(url)) return res(200, {});
      posts += 1;
      return res(422, 'no queue');
    });
    const r = await call({ locationName: 'Encinitas' });
    expect(r.ok).toBe(false);
    expect(r.refiled).toBeFalsy();
    expect(posts).toBe(1);
  });

  it('does not re-file a non-422 failure', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (isProbe(url)) return res(200, {});
      posts += 1;
      return res(500, 'server error');
    });
    const r = await call();
    expect(r.ok).toBe(false);
    expect(posts).toBe(1);
  });
});

describe('the ticket-number writeback', () => {
  it('records the number on the call log so the grader can see it', async () => {
    // The grader reads call_logs.ticket_number. A ticket it cannot see does
    // not exist — that was 46.2% of one queue's "failures" yesterday.
    await call();
    expect(updateCallLog).toHaveBeenCalledWith('log-1', { ticketNumber: 'VA-53000' });
  });

  it('does not overwrite a number already on the log', async () => {
    getCallLogByCallSid.mockResolvedValue({ id: 'log-1', ticketNumber: 'VA-11111' });
    await call();
    expect(updateCallLog).not.toHaveBeenCalled();
  });

  it('survives a writeback failure — the ticket is already filed', async () => {
    updateCallLog.mockRejectedValue(new Error('db down'));
    const r = await call();
    expect(r.ok).toBe(true);
    expect(r.ticketNumber).toBe('VA-53000');
  });

  it('skips the writeback when there is no call sid', async () => {
    await call({ callSid: undefined });
    expect(getCallLogByCallSid).not.toHaveBeenCalled();
  });

  it('treats a non-JSON 200 as a filed ticket', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      isProbe(url) ? res(200, {}) : res(200, 'OK'),
    );
    const r = await call();
    expect(r.ok).toBe(true);
    expect(r.ticketNumber).toBeUndefined();
  });
});
