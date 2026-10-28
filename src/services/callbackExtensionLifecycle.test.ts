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

it('keeps the extension in the legacy finalized row and call-ended event', async () => {
  const { rememberCallbackExtension } = await import('./callbackExtensionNote');
  const { callLifecycleCoordinator: coordinator } = await import('./callLifecycleCoordinator');
  const callSid = 'CA0123456789abcdef0123456789abcdef';
  rememberCallbackExtension({
    departmentId: 1, patientPhone: '2025550101', description: 'Test',
    callData: { callSid, transcript: 'Callback extension: 0204' },
  });
  const record = coordinator.registerCall({ callLogId: 'test', twilioCallSid: callSid });
  record.transcriptLines.push('CALLER: Please call me back.');
  const ended = vi.fn();
  coordinator.once('call-ended', ended);
  await coordinator.finalizeCall('test', 'completed');
  expect(writes[writes.length - 1]?.transcript).toBe('CALLER: Please call me back.\nCallback extension: 0204');
  expect(ended.mock.calls[0][0].transcript).toBe(writes[writes.length - 1]?.transcript);
});

it('does not attach a later retry’s extension to an earlier idempotent filing', async () => {
  const { rememberCallbackExtension, transcriptWithCallbackExtension } = await import('./callbackExtensionNote');
  const callSid = 'CA00000000000000000000000000000001';
  const params = { departmentId: 1, patientPhone: '2025550101', description: 'Test', callData: { callSid } };
  rememberCallbackExtension(params);
  rememberCallbackExtension({ ...params, callData: { callSid, transcript: 'Callback extension: 204' } });
  expect(transcriptWithCallbackExtension('CALLER: Hello', callSid)).toBe('CALLER: Hello');
});
