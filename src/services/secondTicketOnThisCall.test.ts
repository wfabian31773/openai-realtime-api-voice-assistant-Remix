/**
 * A SECOND TICKET ON A CALL THAT ALREADY HOLDS ONE — the sink's half of the
 * urgent transfer record beside a refused-escalation ticket (Codex P1 on
 * #339, 2026-09-29; the agent's half is noIvrRefusedEscalationFiles.test.ts).
 *
 * The ordinary filing claims the call (`claimTicketCreation`), keys the POST
 * on `call-<sid>` and writes the ticket number back onto `call_logs`. All
 * three are what make ONE ticket per call — and all three are what would have
 * turned the urgent record into the refusal's ticket: the claim hands back
 * the existing number without posting. `secondTicketOnThisCall` skips the
 * claim, keys on `call-<sid>-<suffix>` and writes nothing back, so the
 * caller's request ticket stays the call's ticket for the post-call sync.
 *
 * Same mock preamble as syncAgentService.lock.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  claimTicketCreation: vi.fn(),
  releaseTicketCreationLock: vi.fn(),
  getCallLogBySid: vi.fn(),
  submitTicket: vi.fn(),
  resolveTicketLookupFields: vi.fn(),
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

import { SyncAgentService } from './syncAgentService';

const CALL_SID = 'CA-overnight-0003';
const params = {
  patientFullName: 'Test Caller',
  patientDOB: 'Unknown',
  reasonForCalling: 'Request Type: Urgent/Emergency Transfer\nURGENT TRANSFER (record ticket)',
  preferredContactMethod: 'phone' as const,
  patientPhone: '5551234567',
  priority: 'urgent' as const,
  callSid: CALL_SID,
};

beforeEach(() => {
  vi.resetAllMocks();
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.resolveTicketLookupFields.mockResolvedValue({});
});

describe('secondTicketOnThisCall', () => {
  it('skips the per-call claim, posts under its own key, and never writes the number back', async () => {
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-RECORD' });
    const r = await SyncAgentService.submitSimplifiedTicket({
      ...params,
      secondTicketOnThisCall: { keySuffix: 'urgent-transfer' },
    });
    expect(r).toMatchObject({ success: true, ticketNumber: 'VA-RECORD' });
    expect(h.claimTicketCreation).not.toHaveBeenCalled();
    expect(h.submitTicket).toHaveBeenCalledTimes(1);
    expect(h.submitTicket.mock.calls[0][0].idempotencyKey).toBe(`call-${CALL_SID}-urgent-transfer`);
    expect(h.submitTicket.mock.calls[0][0].priority).toBe('urgent');
    expect(h.releaseTicketCreationLock).not.toHaveBeenCalled();
  });

  it('control: an ordinary filing still claims the call, keys on the call, and writes the number back', async () => {
    h.claimTicketCreation.mockResolvedValue({ claimed: true });
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-1' });
    const r = await SyncAgentService.submitSimplifiedTicket(params);
    expect(r).toMatchObject({ success: true, ticketNumber: 'VA-1' });
    expect(h.claimTicketCreation).toHaveBeenCalledWith(CALL_SID, expect.any(Number));
    expect(h.submitTicket.mock.calls[0][0].idempotencyKey).toBe(`call-${CALL_SID}`);
    expect(h.releaseTicketCreationLock).toHaveBeenCalledWith(CALL_SID, 'VA-1');
  });

  it('the defect, as a control: an ordinary filing on a call that already holds a ticket posts NOTHING and hands the old number back', async () => {
    h.claimTicketCreation.mockResolvedValue({ claimed: false, existingTicket: 'VA-EARLIER' });
    const r = await SyncAgentService.submitSimplifiedTicket(params);
    expect(r).toMatchObject({ success: true, ticketNumber: 'VA-EARLIER' });
    expect(h.submitTicket).not.toHaveBeenCalled();
  });

  it('a second ticket with no CallSid carries no key at all, like any other filing without one', async () => {
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-3' });
    const { callSid: _drop, ...noSid } = params;
    await SyncAgentService.submitSimplifiedTicket({ ...noSid, secondTicketOnThisCall: { keySuffix: 'urgent-transfer' } });
    expect(h.submitTicket.mock.calls[0][0].idempotencyKey).toBeUndefined();
    expect(h.claimTicketCreation).not.toHaveBeenCalled();
  });
});
