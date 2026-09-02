/**
 * WHAT THE CALLER HEARS WHEN THE FAR SIDE SAYS NO.
 *
 * Codex, PR #244 round eleven, and a consequence of this branch's own
 * terminal-refusal change two rounds earlier. `attemptSend` dead-letters a
 * 400/422 immediately — nothing retries it — but it returned the same generic
 * failed result as a transport failure, so `SyncAgentService` could not tell
 * them apart and answered both with:
 *
 *     "Your request has been recorded and will be processed shortly."
 *
 * On a terminal refusal that is a promise nothing can keep, said to a caller
 * still on the line, on the path that carries the answering service, no-IVR
 * and after-hours — standing instruction 13's line, the one taking every
 * overnight call.
 *
 * The distinction that matters here: a TRANSPORT failure really is retried and
 * really can be reported as recorded. Only the refusal must not be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  claimTicketCreation: vi.fn(),
  releaseTicketCreationLock: vi.fn(),
  getCallLogBySid: vi.fn(),
  submitTicket: vi.fn(),
  resolveTicketLookupFields: vi.fn(),
  writeToOutbox: vi.fn(),
  attemptSend: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    claimTicketCreation: h.claimTicketCreation,
    releaseTicketCreationLock: h.releaseTicketCreationLock,
    getCallLogBySid: h.getCallLogBySid,
  },
}));

vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { submitTicket: h.submitTicket },
}));

vi.mock('./ticketFieldSanitizers', () => ({
  resolveTicketLookupFields: h.resolveTicketLookupFields,
  sanitizeTicketLookupFields: vi.fn((x: unknown) => x),
}));

vi.mock('./ticketOutboxService', () => ({
  TicketOutboxService: { writeToOutbox: h.writeToOutbox, attemptSend: h.attemptSend },
  wrapCreateTicketPayload: vi.fn((p: unknown) => p),
}));

import { SyncAgentService } from './syncAgentService';

const CALL_SID = 'CA' + 'f'.repeat(32);

const params = {
  patientFirstName: 'Ruth',
  patientLastName: 'Alvarez',
  patientPhone: '9095551234',
  departmentId: 2,
  requestTypeId: 1,
  requestReasonId: 1,
  description: 'Asking about her surgery date',
  callData: { callSid: CALL_SID, agentUsed: 'no-ivr' },
} as never;

beforeEach(() => {
  // resetAllMocks, not clearAllMocks — see the note in syncAgentService.lock.test.ts.
  vi.resetAllMocks();
  h.claimTicketCreation.mockResolvedValue({ claimed: true });
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.getCallLogBySid.mockResolvedValue({ callSid: CALL_SID });
  h.resolveTicketLookupFields.mockResolvedValue({});
  h.writeToOutbox.mockResolvedValue({ outboxId: 'ob-1', alreadyExists: false });
});

describe('a terminal refusal is not reported as recorded', () => {
  it('asks for the field the far side named, instead of promising to follow up', async () => {
    h.attemptSend.mockResolvedValue({
      success: false,
      outboxId: 'ob-1',
      terminal: true,
      statusCode: 400,
      error: 'Missing required information: surgeon',
    });

    const res = await SyncAgentService.createTicket(params);

    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/has been recorded|processed shortly/i);
    // The shape submitSimplifiedTicket already uses on this path, so the agent
    // handles it the way it already handles a missing field.
    expect(res.message).toMatch(/provide/i);
    expect(res.message).toContain('surgeon');
  });

  it('still refuses plainly when the refusal names no field', async () => {
    h.attemptSend.mockResolvedValue({
      success: false,
      outboxId: 'ob-1',
      terminal: true,
      statusCode: 422,
      error: 'patientPhone: Too big: expected <=20 characters',
    });

    const res = await SyncAgentService.createTicket(params);

    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/has been recorded|processed shortly/i);
  });

  it('hands the lock back, so the retry it invites is not blocked', async () => {
    // The failure mode ticket-creation-lock.md was written for: a refusal that
    // asks the caller for more, holding the lease that makes the second attempt
    // impossible for the next minute.
    h.attemptSend.mockResolvedValue({
      success: false, outboxId: 'ob-1', terminal: true, statusCode: 400,
      error: 'Missing required information: surgeon',
    });

    await SyncAgentService.createTicket(params);

    expect(h.releaseTicketCreationLock).toHaveBeenCalledWith(CALL_SID);
  });
});

describe('a transport failure is unchanged', () => {
  it('is still reported as recorded, because it really will be retried', async () => {
    // The 08-31 shape. `terminal` absent: the worker owns it now.
    h.attemptSend.mockResolvedValue({
      success: false,
      outboxId: 'ob-1',
      error: 'Invalid JSON response from ticketing API: 200',
    });

    const res = await SyncAgentService.createTicket(params);

    expect(res.success).toBe(true);
    expect(res.message).toMatch(/has been recorded/i);
  });
});
