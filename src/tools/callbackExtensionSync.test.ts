import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceCallRecord } from '../runtime/mediaStreamBridge';

vi.hoisted(() => { process.env.OPENAI_API_KEY ||= 'test-unused'; });
const rows = vi.hoisted(() => [] as any[]);
const createTicket = vi.fn(async (_payload: any): Promise<{ success: boolean; ticketNumber?: string; statusCode?: number }> => ({ success: true, ticketNumber: 'VA-TEST' }));
const updateTicketCallData = vi.fn(async (_payload: any) => ({ success: true }));
vi.mock('../../server/db', () => ({
  db: { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'test' }] }) }) }) },
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  lookupWasUnavailable: () => false,
  ticketingApiClient: {
    createTicket: (...args: any[]) => createTicket(args[0]),
    updateTicketCallData: async (payload: any) => {
      const { syncWithCallbackExtensions } = await import('../services/callbackExtensionNote');
      return syncWithCallbackExtensions(payload, async () => rows, updateTicketCallData);
    },
    lookupProviderAndLocation: async () => ({ success: true, locationId: 1 }),
  },
}));
vi.mock('../services/ticketOutboxService', () => ({
  wrapCreateTicketPayload: (params: unknown) => ({ kind: 'create_ticket_v1', params }),
  TicketOutboxService: {
    writeToOutbox: async (payload: any, sid: string) => {
      const idempotencyKey = `call-${sid}`;
      const existing = rows.find(row => row.idempotencyKey === idempotencyKey);
      if (existing) return { outboxId: existing.id, alreadyExists: true, status: existing.status, ticketNumber: existing.ticketNumber };
      const row = { id: `outbox-${rows.length}`, idempotencyKey, payload, status: 'pending' };
      rows.push(row);
      return { outboxId: row.id, alreadyExists: false };
    },
    attemptSend: async (id: string) => {
      const row = rows.find(row => row.id === id);
      const result = await createTicket(row.payload.params);
      if (result.success) Object.assign(row, { status: 'sent', ticketNumber: result.ticketNumber });
      else if (result.statusCode === 400 || result.statusCode === 422) Object.assign(row, { status: 'dead_letter', refusalStatusCode: result.statusCode });
      else row.status = 'failed';
      return { ...result, outboxId: id, ...(!result.success && (result.statusCode === 400 || result.statusCode === 422) ? { terminal: true } : {}) };
    },
  },
}));

const { runTool } = await import('./registry');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');
const { toCallLogRow } = await import('../runtime/callRecord');
const { TicketingSyncService } = await import('../../server/services/ticketingSyncService');

beforeEach(() => { rows.length = 0; vi.clearAllMocks(); });

describe.each(['file_optical_ticket', 'file_surgery_ticket', 'file_tech_ticket', 'file_records_ticket'])('%s post-call sync', (tool) => {
  it('rehydrates the filed extension onto the ticket after the call ends', async () => {
    const callSid = `CA${Buffer.from(tool).toString('hex').padEnd(32, '0').slice(0, 32)}`;
    const result = await runTool(tool, {
      first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '202-555-0101 ext 0204', call_sid: callSid, location: 'Northridge',
      requester: 'patient', form_channel: 'declined', deliver_to: 'to me', date_range: 'everything',
      request_description: 'a question about my request',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(createTicket.mock.lastCall![0].callData.transcript).toContain('Callback extension: 0204');
    expect(rows[0].payload.params.callData.transcript).toContain('Callback extension: 0204');

    const record: VoiceCallRecord = {
      callSid, streamSid: 'MZ-test', slug: 'optical', callerPhone: '2025550101',
      dialedNumber: '2025550100', outcome: 'caller_hangup',
      transcript: 'CALLER: Please call me back.\nAGENT: Your request was filed.',
      toolEvents: [], agentTurns: 1, interruptions: 0, startedAtMs: 0, endedAtMs: 1000,
    };
    const row = toCallLogRow(record);
    expect(row.transcript).not.toContain('Callback extension:');
    await (new TicketingSyncService() as any).syncCall({ ...row, id: 'test', ticketNumber: 'VA-TEST' });
    expect(updateTicketCallData.mock.lastCall![0].transcript).toContain('Callback extension: 0204');
    expect(updateTicketCallData.mock.lastCall![0].transcript).toContain('CALLER: Please call me back.');
    expect(updateTicketCallData.mock.lastCall![0].ticketNumber).toBe('VA-TEST');
  });
});

it('keeps a refused filing out of ticket sync', async () => {
  const callSid = 'CAffffffffffffffffffffffffffffffff';
  createTicket.mockResolvedValueOnce({ success: false, statusCode: 400 });
  const result = await runTool('file_optical_ticket', {
    first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '202-555-0101 ext 204', call_sid: callSid, location: 'Northridge',
    request_description: 'a question about my request',
  });
  expect(result.success).toBe(false);
  expect(rows[0].status).toBe('dead_letter');
  const { syncWithCallbackExtensions } = await import('../services/callbackExtensionNote');
  await syncWithCallbackExtensions({ callSid, transcript: 'CALLER: Hello' }, async () => rows, updateTicketCallData);
  expect(updateTicketCallData.mock.lastCall![0].transcript).toBe('CALLER: Hello');
});

it('holds synchronization while an extension-bearing filing is queued', async () => {
  const callSid = 'CAeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  createTicket.mockResolvedValueOnce({ success: false, statusCode: 503 });
  const result = await runTool('file_optical_ticket', {
    first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '202-555-0101 ext 0204', call_sid: callSid, location: 'Northridge',
    request_description: 'a question about my request',
  });
  expect(result).toMatchObject({ success: true, filed_pending: true });
  const { syncWithCallbackExtensions } = await import('../services/callbackExtensionNote');
  expect(await syncWithCallbackExtensions({ callSid, transcript: 'CALLER: Hello' }, async () => rows, updateTicketCallData)).toMatchObject({ success: false });
  expect(updateTicketCallData).not.toHaveBeenCalled();
});

it('syncs each records patient with their own extension on one call', async () => {
  const callSid = 'CA11111111111111111111111111111111';
  createTicket.mockResolvedValueOnce({ success: true, ticketNumber: 'VA-1' })
    .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-2' })
    .mockResolvedValueOnce({ success: true, ticketNumber: 'VA-3' });
  const base = {
    first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
    call_sid: callSid, location: 'Northridge', requester: 'patient',
    form_channel: 'declined', deliver_to: 'to me', date_range: 'everything',
    request_description: 'a question about my request',
  };
  for (const [patient_scope, callback_number] of [
    ['', '202-555-0101'], ['-p2', '202-555-0101 ext 222'], ['-p3', '202-555-0101 ext 333'],
  ]) {
    expect(await runTool('file_records_ticket', { ...base, patient_scope, callback_number })).toMatchObject({ success: true });
  }
  expect(rows.map(row => row.idempotencyKey)).toEqual([`call-${callSid}`, `call-${callSid}-p2`, `call-${callSid}-p3`]);
  const transcript = 'CALLER: Please call me back about the three records requests.';
  await (new TicketingSyncService() as any).syncCall({ id: 'test', callSid, ticketNumber: 'VA-1', transcript });
  const updates = updateTicketCallData.mock.calls.map(([payload]) => payload);
  expect(updates).toHaveLength(3);
  expect(updates.find(payload => payload.ticketNumber === 'VA-1').transcript).toBe(transcript);
  expect(updates.find(payload => payload.ticketNumber === 'VA-2').transcript).toBe(`${transcript}\nCallback extension: 222`);
  expect(updates.find(payload => payload.ticketNumber === 'VA-3').transcript).toBe(`${transcript}\nCallback extension: 333`);
});
