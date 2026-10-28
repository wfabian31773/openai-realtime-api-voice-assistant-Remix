import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const createTicketDurable = vi.fn(async (_payload: Record<string, unknown>) => ({
  success: true as const,
  ticketNumber: 'VA-TEST-EXT',
}));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../services/durableTicketFiling', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/durableTicketFiling')>(),
  createTicketDurable,
}));

const { runTool } = await import('./registry');
await import('./opticalTools');
await import('./surgeryTools');
await import('./techTools');
await import('./medicalRecordsTools');

const lanes = ['file_optical_ticket', 'file_surgery_ticket', 'file_tech_ticket', 'file_records_ticket'];
let nextSid = 0;
const sid = () => `CA${(++nextSid).toString(16).padStart(32, '0')}`;
const file = (tool: string, callback_number: string, call_sid = sid(), date_of_birth = '01/02/1980') =>
  runTool(tool, {
    first_name: 'Test', last_name: 'Example', date_of_birth,
    callback_number, call_sid, location: 'Northridge', requester: 'patient',
    form_channel: 'declined', deliver_to: 'to me', date_range: 'everything',
    request_description: 'a question about my request',
  });

beforeEach(async () => {
  createTicketDurable.mockClear();
  const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
  vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValue({ success: true, locationId: 1 });
});

describe.each(lanes)('%s callback extension', (tool) => {
  it.each([
    ['202-555-0101 ext 204', '204'],
    ['202-555-0101x0204', '0204'],
    ['+1 (202) 555-0101 extension 204', '204'],
    ['202-555-0101 EXT. 204', '204'],
  ])('files %s with the extension in staff notes', async (number, extension) => {
    const result = await file(tool, number);
    expect(result.success).toBe(true);
    expect(createTicketDurable).toHaveBeenCalledTimes(1);
    const payload = createTicketDurable.mock.calls[0][0] as any;
    expect(payload.patientPhone).toBe('2025550101');
    expect(payload.callData.transcript).toContain(`Callback extension: ${extension}`);
    expect(payload.description).not.toContain('Callback extension:');
  });

  it.each(['202-555-0101 / 303-555-0102', '2-202-555-0101 ext 204', '202-555-01 ext 204', '202-555-0101 text204'])
    ('still refuses invalid base numbers: %s', async (number) => {
      const result = await file(tool, number);
      expect(result.success).toBe(false);
      expect(createTicketDurable).not.toHaveBeenCalled();
    });

  it('keeps existing staff notes alongside the extension', async () => {
    const callSid = sid();
    await file(tool, '202-555-0101 x204', callSid, '');
    await file(tool, '202-555-0101 x204', callSid, '');
    const payload = createTicketDurable.mock.calls[0]?.[0] as any;
    expect(payload.callData.transcript).toContain('Callback extension: 204');
    expect(payload.callData.transcript).toContain('DATE OF BIRTH UNAVAILABLE');
  });
});
