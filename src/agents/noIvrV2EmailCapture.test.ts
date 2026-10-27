import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveTool } from '../runtime/agentBinding';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
  process.env.OPENAI_API_KEY ||= 'test-unused';
});

vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../services/scheduleLookupService', () => ({
  scheduleLookupService: {
    lookupByNameAndDOB: async () => ({ patientFound: false }),
  },
}));

const { createNoIvrAgentV2 } = await import('./noIvrAgentV2');
const { SyncAgentService } = await import('../services/syncAgentService');

const request = {
  first_name: 'Synthetic',
  last_name: 'Caller',
  date_of_birth: '01/02/1980',
  callback_number: '2025550100',
  request_category: 'reschedule_appointment',
  request_summary: 'Please reschedule the appointment.',
  preferred_contact: 'email',
  email: 'Synthetic.Caller@example.invalid',
};

afterEach(() => vi.restoreAllMocks());

describe('no-ivr-v2 ticket email capture', () => {
  it('carries the complete email from the actual tool to the ticket payload', async () => {
    // Model the ticket service's requirement while exercising the real agent
    // and createTicketFromAgentInput mapping, without making network requests.
    const createTicket = vi.spyOn(SyncAgentService, 'createTicket').mockImplementation(async (payload) =>
      payload.preferredContactMethod === 'email' && !payload.patientEmail
        ? { success: false, error: 'Missing required fields: patientEmail', message: 'Missing email' }
        : { success: true, ticketNumber: 'VA-SYNTHETIC', message: 'VA-SYNTHETIC' },
    );
    const agent = await createNoIvrAgentV2(async () => {}, { callId: 'synthetic-v2-email' });
    const ticketTool = (agent.tools as LiveTool[]).find((tool) => tool.name === 'create_ticket');
    expect(ticketTool).toBeDefined();

    const result = await ticketTool!.invoke!({}, JSON.stringify(request));

    const response = typeof result === 'string' ? JSON.parse(result) : result;
    expect(response).toMatchObject({ success: true, ticket_number: 'VA-SYNTHETIC' });
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({
      preferredContactMethod: 'email',
      patientEmail: request.email,
    }));
  });

  it('continues to file a phone request without an email address', async () => {
    const createTicket = vi.spyOn(SyncAgentService, 'createTicket')
      .mockResolvedValue({ success: true, ticketNumber: 'VA-SYNTHETIC', message: 'VA-SYNTHETIC' });
    const agent = await createNoIvrAgentV2(async () => {}, { callId: 'synthetic-v2-phone' });
    const ticketTool = (agent.tools as LiveTool[]).find((tool) => tool.name === 'create_ticket')!;
    const { email: _email, ...phoneRequest } = request;

    const result = await ticketTool.invoke!({}, JSON.stringify({ ...phoneRequest, preferred_contact: 'phone' }));
    const response = typeof result === 'string' ? JSON.parse(result) : result;
    expect(response).toMatchObject({ success: true });
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({
      preferredContactMethod: 'phone',
      patientEmail: undefined,
    }));
  });

  it('rejects a non-string email at the tool boundary', async () => {
    const createTicket = vi.spyOn(SyncAgentService, 'createTicket');
    const agent = await createNoIvrAgentV2(async () => {}, { callId: 'synthetic-v2-invalid' });
    const ticketTool = (agent.tools as LiveTool[]).find((tool) => tool.name === 'create_ticket')!;

    const result = await ticketTool.invoke!({}, JSON.stringify({ ...request, email: 123 }));
    expect(result).toContain('Invalid JSON input for tool');
    expect(createTicket).not.toHaveBeenCalled();
  });
});
