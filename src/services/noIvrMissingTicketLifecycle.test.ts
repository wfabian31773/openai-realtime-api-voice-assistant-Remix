import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  row: {} as Record<string, unknown>,
}));
vi.mock('../../server/db', () => ({ db: {
  update: () => ({ set: () => ({ where: async () => [] }) }),
  select: (fields: Record<string, unknown>) => ({ from: () => ({ where: () => ({
    limit: async () => [Object.fromEntries(Object.keys(fields).map(k => [k, h.row[k]]))],
  }) }) }),
} }));
vi.mock('./structuredLogger', () => ({ createLogger: () => ({
  warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(),
  callStarted: vi.fn(), callEnded: vi.fn(), callStateTransition: vi.fn(),
}) }));
vi.mock('./callSessionService', () => ({ callSessionService: { deleteSession: vi.fn() } }));
vi.mock('./twilioInsightsService', () => ({ twilioInsightsService: {} }));
vi.mock('../lib/twilioClient', () => ({ getTwilioClient: vi.fn() }));

let coordinator: typeof import('./callLifecycleCoordinator').callLifecycleCoordinator;
beforeAll(async () => {
  vi.useFakeTimers();
  coordinator = (await import('./callLifecycleCoordinator')).callLifecycleCoordinator;
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('missing-ticket warning at finalization', () => {
  it('suppresses a fully answered call but warns for an unfiled request', async () => {
    const outcome = { success: true, ticketCreated: false, callbackRequired: false };
    for (const [id, timeline, expectedWarnings] of [
      ['answered', { events: [{ tool: 'create_ticket', outcome }] }, 0],
      ['normal-answered', { events: [{ tool: 'record_answered_question', outcome }] }, 0],
      ['answered-then-hangup', { events: [{ tool: 'record_answered_question', outcome }, { tool: 'terminate_call', outcome: { success: true } }] }, 0],
      ['answered-and-failed', { events: [{ tool: 'create_ticket', outcome }, { tool: 'create_ticket', outcome: { success: false } }] }, 1],
      ['no-disposition', { events: [] }, 1],
      ['unfiled', { events: [{ tool: 'create_ticket', outcome: { success: false } }] }, 1],
    ] as const) {
      h.warn.mockClear();
      h.row = { agentUsed: 'no-ivr', duration: 60, ticketNumber: null, toolTimeline: timeline };
      coordinator.registerCall({ callLogId: id, agentSlug: 'no-ivr' });
      await coordinator.finalizeCall(id, 'completed');
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.warn.mock.calls.filter(([message]) => String(message).includes('[MISSING TICKET]'))).toHaveLength(expectedWarnings);
    }
  });
});
