import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.TICKETING_SYSTEM_URL ||= 'https://ticketing.test';
process.env.TICKETING_API_KEY ||= 'test-key';
process.env.OBS_CONSOLE_DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const lookupProvider = vi.fn(async (raw: string) => raw === 'Mira Exampl'
  ? { canonical: 'Mira Example, O.D.', key: 'mira example', volume90d: 0 }
  : null);

vi.mock('../../src/services/consoleDirectory', () => ({
  isDirectoryConfigured: () => true,
  lookupProvider: (raw: string) => lookupProvider(raw),
}));

vi.mock('../../server/storage', () => ({
  getCallLogByCallSid: vi.fn(),
  updateCallLog: vi.fn(),
}));

const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const email = `${'A'.repeat(64)}@${'B'.repeat(63)}.${'C'.repeat(63)}.${'D'.repeat(61)}`;
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

beforeEach(() => {
  lookupProvider.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
    (init?.method ?? 'GET') === 'POST'
      ? okJson({ success: true })
      : okJson({}),
  );
});

describe('ticket creation contact fields', () => {
  it('uses the unique roster spelling and sends the complete email unchanged', async () => {
    await ticketingApiClient.createTicket({
      departmentId: 1,
      requestTypeId: 66,
      requestReasonId: 536,
      patientFirstName: 'Alex',
      patientLastName: 'Example',
      patientPhone: '5550100',
      patientEmail: email,
      lastProviderSeen: 'Mira Exampl',
      description: 'Synthetic contact capture test.',
    });

    const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === 'POST');
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as { body: string }).body) as Record<string, unknown>;
    expect(body.lastProviderSeen).toBe('Mira Example');
    expect(body.patientEmail).toBe(email);
    expect(String(body.patientEmail)).toHaveLength(254);
    expect(lookupProvider).toHaveBeenCalledWith('Mira Exampl');
  });
});
