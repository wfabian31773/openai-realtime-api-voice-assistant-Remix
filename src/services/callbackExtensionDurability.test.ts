import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as any[], posts: [] as any[], updates: [] as any[] }));
vi.mock('../../server/db', () => ({ db: {
  select: () => ({ from: () => ({ where: async () => state.rows }) }),
} }));
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { createTicket: vi.fn(async (params: any) => {
    expect(state.rows.some(row => row.payload.params === params && row.status === 'pending')).toBe(true);
    state.posts.push(params);
    return { success: true, ticketNumber: `T-${state.posts.length}` };
  }) },
}));
vi.mock('./ticketOutboxService', () => ({
  wrapCreateTicketPayload: (params: any) => ({ kind: 'create_ticket_v1', params }),
  TicketOutboxService: {
    writeToOutbox: vi.fn(async (payload: any, key: string) => {
      const existing = state.rows.find(row => row.idempotencyKey === `call-${key}`);
      if (existing?.status === 'dead_letter') {
        Object.assign(existing, { payload, status: 'pending' });
        return { outboxId: existing.id, alreadyExists: true, status: 'pending', reopened: true };
      }
      if (existing) return { outboxId: existing.id, alreadyExists: true, status: existing.status, ticketNumber: existing.ticketNumber };
      const row = { id: `outbox-${state.rows.length}`, idempotencyKey: `call-${key}`, payload, status: 'pending' };
      state.rows.push(row);
      return { outboxId: row.id, alreadyExists: false };
    }),
    attemptSend: vi.fn(async (id: string) => {
      const row = state.rows.find(row => row.id === id);
      if (row.status === 'failed') return { success: false, outboxId: id, error: 'not due' };
      const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
      const result = await ticketingApiClient.createTicket(row.payload.params);
      Object.assign(row, { status: 'sent', ticketNumber: result.ticketNumber });
      return { ...result, outboxId: id };
    }),
  },
}));

const { createTicketDurable } = await import('./durableTicketFiling');
const { syncWithCallbackExtensions } = await import('./callbackExtensionNote');
const { TicketOutboxService } = await import('./ticketOutboxService');
const sid = 'CA0123456789abcdef0123456789abcdef';
const params = (scope: string, extension?: string) => ({
  departmentId: 1, patientPhone: '2025550101', description: 'Test',
  idempotencyKey: `call-${sid}${scope}`,
  callData: { callSid: sid, transcript: extension ? `Callback extension: ${extension}` : undefined },
});
const sync = (transcript = 'CALLER: Hello') => syncWithCallbackExtensions(
  { callSid: sid, ticketNumber: 'T-1', transcript },
  async () => state.rows,
  async (payload: any) => { state.updates.push(payload); return { success: true, ticketNumber: payload.ticketNumber }; },
);

beforeEach(() => { state.rows = []; state.posts = []; state.updates = []; });

describe('durable, ticket-specific callback extensions', () => {
  it('records the payload before filing and restores the note on sync after a restart', async () => {
    await createTicketDurable(params('', '0204'));
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].payload.params.callData.transcript).toBe('Callback extension: 0204');
    // Only the serialized database payload survives; reload the recovery code
    // before syncing the ordinary transcript persisted by appendTranscript.
    const persisted = JSON.stringify(state.rows);
    vi.resetModules();
    state.rows = JSON.parse(persisted);
    const { callbackExtensionFilings, syncWithCallbackExtensions: recoveredSync } = await import('./callbackExtensionNote');
    await recoveredSync(
      { callSid: sid, ticketNumber: 'T-1', transcript: 'CALLER: Hello' },
      callbackExtensionFilings,
      async (payload) => { state.updates.push(payload); return { success: true }; },
    );
    expect(state.updates).toEqual([{ ticketNumber: 'T-1', transcript: 'CALLER: Hello\nCallback extension: 0204' }]);
  });

  it.each([undefined, '101'])('keeps later patients separate with first extension %s', async (firstExtension) => {
    await createTicketDurable(params('', firstExtension));
    await createTicketDurable(params('-p2', '222'));
    await createTicketDurable(params('-p3', '333'));
    await sync();
    expect(state.updates).toHaveLength(3);
    expect(state.updates).toEqual(expect.arrayContaining([
      { ticketNumber: 'T-1', transcript: `CALLER: Hello${firstExtension ? `\nCallback extension: ${firstExtension}` : ''}` },
      { ticketNumber: 'T-2', transcript: 'CALLER: Hello\nCallback extension: 222' },
      { ticketNumber: 'T-3', transcript: 'CALLER: Hello\nCallback extension: 333' },
    ]));
  });

  it('does not overwrite staff notes while a filing is still pending', async () => {
    state.rows.push({ id: 'pending', idempotencyKey: `call-${sid}-p2`, status: 'pending', payload: { kind: 'create_ticket_v1', params: params('-p2', '222') } });
    expect(await sync()).toMatchObject({ success: false });
    expect(state.updates).toEqual([]);
  });

  it('retains the original note on an idempotent retry, including when it was absent', async () => {
    await createTicketDurable(params(''));
    await createTicketDurable(params('', '999'));
    await createTicketDurable(params('-p2', '222'));
    await sync();
    expect(state.posts).toHaveLength(2);
    expect(state.updates).toEqual(expect.arrayContaining([
      { ticketNumber: 'T-1', transcript: 'CALLER: Hello' },
      { ticketNumber: 'T-2', transcript: 'CALLER: Hello\nCallback extension: 222' },
    ]));
  });

  it('keeps a consolidated contact note without overwriting its parent ticket', async () => {
    await createTicketDurable(params('', '123'));
    state.rows[0].payload.consolidated = true;
    expect(await sync()).toMatchObject({ success: false });
    expect(state.updates).toEqual([]);
  });

  it('does not send a shared transcript when an uncertain dead letter might have filed', async () => {
    state.rows.push({ id: 'pending', idempotencyKey: `call-${sid}`, status: 'dead_letter', refusalStatusCode: null, payload: { kind: 'create_ticket_v1', params: params('', '222') } });
    expect(await sync()).toMatchObject({ success: false });
    expect(state.updates).toEqual([]);
  });

  it('keeps the first queued payload on a retry and uses a corrected reopened payload', async () => {
    await createTicketDurable(params('', '101'));
    state.rows[0].status = 'failed';
    await createTicketDurable(params('', '202'));
    expect(state.rows[0].payload.params.callData.transcript).toBe('Callback extension: 101');
    state.rows[0].status = 'dead_letter';
    await createTicketDurable(params('', '303'));
    await sync();
    expect(state.updates[0].transcript).toBe('CALLER: Hello\nCallback extension: 303');
  });

  it('leaves an interrupted immediate send queued for the worker', async () => {
    vi.mocked(TicketOutboxService.attemptSend).mockRejectedValueOnce(new Error('interrupted'));
    expect(await createTicketDurable(params('', '204'))).toMatchObject({ success: false, queued: true, outboxId: 'outbox-0' });
    expect(state.rows[0].status).toBe('pending');
    expect(state.posts).toHaveLength(0);
  });

  it('does not submit a keyed filing if its payload could not be persisted', async () => {
    vi.mocked(TicketOutboxService.writeToOutbox).mockRejectedValueOnce(new Error('unavailable'));
    expect(await createTicketDurable(params('', '204'))).toMatchObject({ success: false, queued: false });
    expect(state.posts).toHaveLength(0);
  });
});
