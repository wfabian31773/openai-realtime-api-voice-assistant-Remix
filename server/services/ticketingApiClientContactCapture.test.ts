import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { __resetDirectory, type DirectoryProvider } from '../../src/services/consoleDirectory';
import pg from 'pg';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.TICKETING_SYSTEM_URL ||= 'https://ticketing.test';
process.env.TICKETING_API_KEY ||= 'test-key';
process.env.OBS_CONSOLE_DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

vi.mock('../../server/storage', () => ({
  storage: {},
}));

const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
const { SyncAgentService } = await import('../../src/services/syncAgentService');
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const email = `${'A'.repeat(64)}@${'B'.repeat(63)}.${'C'.repeat(63)}.${'D'.repeat(61)}`;
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function seedRoster(providers: DirectoryProvider[]) {
  __resetDirectory({ providers: new Map(providers.map((p) => [p.key, p])), locations: new Map(), loadedAt: Date.now() });
}

beforeEach(() => {
  seedRoster([{ canonical: 'Mira Example, O.D.', key: 'mira example', volume90d: 1 }]);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
    (init?.method ?? 'GET') === 'POST'
      ? okJson({ success: true })
      : okJson({}),
  );
});

afterEach(() => {
  __resetDirectory();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === 'POST');
  expect(post).toBeDefined();
  return JSON.parse((post![1] as { body: string }).body) as Record<string, unknown>;
}

const ticket = {
  departmentId: 1,
  requestTypeId: 66,
  requestReasonId: 536,
  patientFirstName: 'Alex',
  patientLastName: 'Example',
  patientPhone: '+15555550100',
  patientEmail: email,
  lastProviderSeen: 'Mira Exampl',
  description: 'Synthetic contact capture test.',
};

describe('ticket creation contact fields', () => {
  it('uses the unique roster spelling and sends the complete email unchanged', async () => {
    const result = await ticketingApiClient.createTicket(ticket);

    expect(result.success).toBe(true);
    const body = postBody();
    expect(body.lastProviderSeen).toBe('Mira Example');
    expect(body.patientEmail).toBe(email);
    expect(String(body.patientEmail)).toHaveLength(254);
    expect(ticket.lastProviderSeen).toBe('Mira Exampl');
  });

  it('keeps the supplied provider on an ambiguous match', async () => {
    seedRoster([
      { canonical: 'Mira Examplex', key: 'mira examplex', volume90d: 1 },
      { canonical: 'Mira Exampleq', key: 'mira exampleq', volume90d: 1 },
    ]);
    await ticketingApiClient.createTicket({ ...ticket, lastProviderSeen: 'Mira Example' });
    expect(postBody().lastProviderSeen).toBe('Mira Example');
  });

  it('keeps the supplied provider when the directory is unconfigured', async () => {
    vi.stubEnv('OBS_CONSOLE_DATABASE_URL', '');
    await ticketingApiClient.createTicket(ticket);
    expect(postBody().lastProviderSeen).toBe('Mira Exampl');
  });

  it('keeps an unrelated provider rather than inventing a roster match', async () => {
    await ticketingApiClient.createTicket({ ...ticket, lastProviderSeen: 'Rina Fictional' });
    expect(postBody().lastProviderSeen).toBe('Rina Fictional');
  });

  it('still submits the original provider when the configured directory fails', async () => {
    __resetDirectory();
    vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValue(new Error('Synthetic directory outage'));
    const result = await ticketingApiClient.createTicket(ticket);
    expect(result.success).toBe(true);
    expect(postBody().lastProviderSeen).toBe('Mira Exampl');
  });

  it('sends the canonical provider and full email through the after-hours submission path', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      (init?.method ?? 'GET') === 'POST'
        ? okJson({ success: true, ticketNumber: 'VA-SYNTHETIC' })
        : okJson({}),
    );
    const result = await SyncAgentService.submitSimplifiedTicket({
      patientFullName: 'Alex Example',
      patientDOB: '1980-01-15',
      reasonForCalling: 'Synthetic contact capture test.',
      preferredContactMethod: 'email',
      patientPhone: '+15555550100',
      patientEmail: email,
      lastProviderSeen: 'Mira Exampl',
    });
    expect(result.success).toBe(true);
    const body = postBody();
    expect(body.lastProviderSeen).toBe('Mira Example');
    expect(body.patientEmail).toBe(email);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/voice-agent/submit-ticket'))).toBe(true);
  });
});
