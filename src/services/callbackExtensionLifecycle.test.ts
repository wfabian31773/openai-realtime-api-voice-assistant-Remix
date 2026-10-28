import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../server/db', () => ({ db: {
  update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => { writes.push(value); } }) }),
} }));
vi.mock('./structuredLogger', () => ({ createLogger: () => ({
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(),
  callStarted: vi.fn(), callEnded: vi.fn(), callStateTransition: vi.fn(),
}) }));
vi.mock('./callSessionService', () => ({ callSessionService: {} }));
vi.mock('./twilioInsightsService', () => ({ twilioInsightsService: {} }));
vi.mock('../lib/twilioClient', () => ({ getTwilioClient: vi.fn() }));

beforeAll(() => vi.useFakeTimers());
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('keeps the shared call transcript free of patient-specific extension notes', async () => {
  const { callLifecycleCoordinator: coordinator } = await import('./callLifecycleCoordinator');
  const callSid = 'CA0123456789abcdef0123456789abcdef';
  coordinator.registerCall({ callLogId: 'test', twilioCallSid: callSid });
  await coordinator.appendTranscript('test', 'CALLER: Please call me back.');
  const ended = vi.fn();
  coordinator.once('call-ended', ended);
  await coordinator.finalizeCall('test', 'completed');
  expect(writes[writes.length - 1]?.transcript).toBe('CALLER: Please call me back.');
  expect(ended.mock.calls[0][0].transcript).toBe(writes[writes.length - 1]?.transcript);
});
