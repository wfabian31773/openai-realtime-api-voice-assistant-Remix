import { beforeEach, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/callbackExtensionNote', async (original) => ({
  ...await original<typeof import('../../src/services/callbackExtensionNote')>(),
  callbackExtensionFilings: load,
}));
const { ticketingApiClient } = await import('./ticketingApiClient');
const send = vi.spyOn(ticketingApiClient as any, 'makeRequest');
const sid = 'CA0123456789abcdef0123456789abcdef';

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ success: true });
  load.mockResolvedValue([{
    idempotencyKey: `call-${sid}-p2`, status: 'sent', ticketNumber: 'T-2',
    payload: { kind: 'create_ticket_v1', params: { callData: { transcript: 'Callback extension: 222' } } },
  }]);
});

it('routes a call update through durable per-ticket note recovery', async () => {
  const result = await ticketingApiClient.updateTicketCallData({ callSid: sid, ticketNumber: 'T-2', transcript: 'CALLER: Hello' });
  expect(result.success).toBe(true);
  expect(load).toHaveBeenCalledWith(sid);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][2]).toEqual({ ticketNumber: 'T-2', transcript: 'CALLER: Hello\nCallback extension: 222' });
});

it('does not send a transcript when durable filings cannot be read', async () => {
  load.mockRejectedValue(new Error('unavailable'));
  expect(await ticketingApiClient.updateTicketCallData({ callSid: sid, transcript: 'CALLER: Hello' })).toMatchObject({ success: false });
  expect(send).not.toHaveBeenCalled();
});

it('recovers the note by ticket number when the call row has no CallSid', async () => {
  expect(await ticketingApiClient.updateTicketCallData({ ticketNumber: 'T-2', transcript: 'CALLER: Hello' })).toMatchObject({ success: true });
  expect(load).toHaveBeenCalledWith(undefined, 'T-2');
  expect(send.mock.calls[0][2]).toEqual({ ticketNumber: 'T-2', transcript: 'CALLER: Hello\nCallback extension: 222' });
});
