import { describe, expect, it, vi } from 'vitest';
import type { VoiceCallRecord } from '../runtime/mediaStreamBridge';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

const createTicket = vi.fn(async (_payload: any): Promise<{ success: boolean; ticketNumber?: string; statusCode?: number }> => ({ success: true, ticketNumber: 'VA-TEST' }));
const updateTicketCallData = vi.fn(async (_payload: any) => ({ success: true }));
vi.mock('../../server/db', () => ({
  db: { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'test' }] }) }) }) },
}));
vi.mock('../../server/services/ticketingApiClient', () => ({
  lookupWasUnavailable: () => false,
  ticketingApiClient: {
    createTicket: (...args: any[]) => createTicket(args[0]),
    updateTicketCallData: (...args: any[]) => updateTicketCallData(args[0]),
    lookupProviderAndLocation: async () => ({ success: true, locationId: 1 }),
  },
}));
vi.mock('../services/ticketOutboxService', () => ({
  wrapCreateTicketPayload: (params: unknown) => ({ params }),
  TicketOutboxService: { writeToOutbox: async () => ({ outboxId: 'test', alreadyExists: false }) },
}));

const { runTool } = await import('./registry');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');
const { toCallLogRow } = await import('../runtime/callRecord');
const { TicketingSyncService } = await import('../../server/services/ticketingSyncService');

describe.each(['file_optical_ticket', 'file_surgery_ticket', 'file_tech_ticket', 'file_records_ticket'])('%s post-call sync', (tool) => {
  it('keeps the filed extension when the final transcript replaces the initial one', async () => {
    const callSid = `CA${Buffer.from(tool).toString('hex').padEnd(32, '0').slice(0, 32)}`;
    const result = await runTool(tool, {
      first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
      callback_number: '202-555-0101 ext 0204', call_sid: callSid, location: 'Northridge',
      requester: 'patient', form_channel: 'declined', deliver_to: 'to me', date_range: 'everything',
      request_description: 'a question about my request',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    const initial = createTicket.mock.lastCall![0];
    expect(initial.callData.transcript).toContain('Callback extension: 0204');

    const record: VoiceCallRecord = {
      callSid, streamSid: 'MZ-test', slug: 'optical', callerPhone: '2025550101',
      dialedNumber: '2025550100', outcome: 'caller_hangup',
      transcript: 'CALLER: Please call me back.\nAGENT: Your request was filed.',
      toolEvents: [], agentTurns: 1, interruptions: 0, startedAtMs: 0, endedAtMs: 1000,
    };
    const row = toCallLogRow(record);
    expect(row.transcript).toContain('Callback extension: 0204');
    expect(toCallLogRow({ ...record, callSid: 'CA00000000000000000000000000000000' }).transcript).not.toContain('Callback extension:');
    const sync = new TicketingSyncService();
    // The saved transcript must still carry the note after the in-memory
    // handoff expires, as it would for a later sync retry or restart.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60 * 1000);
    await (sync as any).syncCall({ ...row, id: 'test', ticketNumber: 'VA-TEST' });
    clock.mockRestore();
    expect(updateTicketCallData.mock.lastCall![0].transcript).toContain('Callback extension: 0204');
    expect(updateTicketCallData.mock.lastCall![0].transcript).toContain('CALLER: Please call me back.');
  });
});

it('does not attach a refused filing to the final transcript', async () => {
  const callSid = 'CAffffffffffffffffffffffffffffffff';
  createTicket.mockResolvedValueOnce({ success: false, statusCode: 400 });
  const result = await runTool('file_optical_ticket', {
    first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '202-555-0101 ext 204', call_sid: callSid, location: 'Northridge',
    request_description: 'a question about my request',
  });
  expect(result.success).toBe(false);
  const { transcriptWithCallbackExtension } = await import('../services/callbackExtensionNote');
  expect(transcriptWithCallbackExtension('CALLER: Hello', callSid)).toBe('CALLER: Hello');
});

it('carries the extension when filing is queued for retry', async () => {
  const callSid = 'CAeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  createTicket.mockResolvedValueOnce({ success: false, statusCode: 503 });
  const result = await runTool('file_optical_ticket', {
    first_name: 'Test', last_name: 'Example', date_of_birth: '01/02/1980',
    callback_number: '202-555-0101 ext 0204', call_sid: callSid, location: 'Northridge',
    request_description: 'a question about my request',
  });
  expect(result).toMatchObject({ success: true, filed_pending: true });
  const { transcriptWithCallbackExtension } = await import('../services/callbackExtensionNote');
  expect(transcriptWithCallbackExtension('CALLER: Hello', callSid)).toBe('CALLER: Hello\nCallback extension: 0204');
});
