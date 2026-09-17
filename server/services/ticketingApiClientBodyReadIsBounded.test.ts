/**
 * THE 15 s TIMEOUT COVERS THE BODY, NOT JUST THE HEADERS — Codex, #321 round 20.
 *
 * `makeRequest` cleared its abort timer the moment `fetch` resolved — i.e.
 * when the HEADERS arrived — and then awaited `response.json()` with no
 * bound at all. A server that answered its status promptly and its body
 * slowly could hold a filing tool open indefinitely: the gate-attempt
 * claim's floor (`gateAttempts.ts`) rests on a refusal arriving inside the
 * client's timeout or not at all, and the runtime's 45 s tool watchdog rests
 * on the tool returning. Driven on the real client with the HTTP layer
 * stubbed, the pattern of `createTicketWritesTheNumberBack.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(body),
  json: async () => body,
});

/** Headers at once, a body that never comes — until the request's own signal aborts it. */
function headersThenHangingBody(signal: AbortSignal | undefined) {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: () => new Promise<string>(() => {}),
    json: () =>
      new Promise<unknown>((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (!signal) return; // no signal: hangs forever, which is the defect
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
      }),
  };
}

const payload = {
  departmentId: 2,
  requestTypeId: 66,
  requestReasonId: 536,
  patientFirstName: 'Test',
  patientLastName: 'Patient',
  patientPhone: '6265550100',
  description: 'Surgery request',
  callData: { agentUsed: 'surgery', callSid: 'CA' + 'c'.repeat(32) },
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string; signal?: AbortSignal }) =>
    (init?.method ?? 'GET') === 'POST' ? headersThenHangingBody(init?.signal) : okJson({ status: 'ok' }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the ticketing client bounds the body read on the same timer as the headers', () => {
  it('a 400 whose headers arrive at once and whose body never does is answered as a timeout at the request bound, not held forever', async () => {
    let settled: unknown;
    const p = ticketingApiClient.createTicket(payload).then(
      (r) => { settled = r; },
      (e) => { settled = e; },
    );
    // Warm-up (bounded probes) then the POST: walk the clock well past the 15 s
    // request bound plus the 6.5 s warm-up worst case, in steps so every timer fires.
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (settled !== undefined) break;
    }
    await p;
    expect(settled).toBeDefined();
    const text = settled instanceof Error ? settled.message : JSON.stringify(settled);
    expect(text).toMatch(/timeout/i);
  });
});
