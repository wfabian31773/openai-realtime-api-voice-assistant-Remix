import { vi } from 'vitest';
import type { CreateTicketParams } from '../../server/services/ticketingApiClient';

/**
 * Keep tool tests on the real durable filing path while replacing its database
 * boundary. Outbox persistence, retries and deduplication have their own tests;
 * these fixtures exercise the tool's payload and the mocked API response.
 */
export function queueTicketOutboxMock() {
  const payloads = new Map<string, { params: CreateTicketParams }>();

  return {
    wrapCreateTicketPayload: (params: CreateTicketParams) => ({ kind: 'create_ticket_v1', params }),
    TicketOutboxService: {
      writeToOutbox: vi.fn(async (payload: { params: CreateTicketParams }) => {
        const outboxId = `test-outbox-${payloads.size}`;
        payloads.set(outboxId, payload);
        return { outboxId, alreadyExists: false };
      }),
      attemptSend: vi.fn(async (outboxId: string) => {
        const payload = payloads.get(outboxId);
        if (!payload) throw new Error('Test filing was not persisted before sending');
        const { ticketingApiClient } = await import('../../server/services/ticketingApiClient');
        const response = await ticketingApiClient.createTicket(payload.params);
        return {
          ...response,
          outboxId,
          ...(!response.success && (response.statusCode === 400 || response.statusCode === 422)
            ? { terminal: true } : {}),
        };
      }),
    },
  };
}
