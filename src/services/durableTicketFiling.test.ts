/**
 * A request that could not be POSTed is not a request that is gone.
 *
 * The gap this closes, measured: on 2026-08-31 the n8n gateway hit its monthly
 * execution cap and answered create-ticket with a 200 and a non-JSON body from
 * 20:16 UTC until the URL was flipped the next morning. 286 filing attempts
 * were rejected. 107 distinct requests had to be reconstructed by hand from
 * call transcripts afterwards, and 24 of them still cannot be filed at all,
 * because the only copy of the payload was a local variable in a tool handler
 * that had already returned.
 *
 * `TicketOutboxService` was written for exactly this and the four queue tools
 * — optical, surgery, tech, records, the lines carrying every live queue call —
 * were never wired into it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const createTicket = vi.fn();
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: { createTicket: (...a: unknown[]) => createTicket(...a) },
}));

const writeToOutbox = vi.fn();
vi.mock('./ticketOutboxService', async (importOriginal) => {
  // The envelope helpers stay REAL. Stubbing `wrapCreateTicketPayload` would
  // make this suite agree with itself about the discriminator while the outbox
  // read a different one, which is the only way this wiring can silently fail.
  const actual = await importOriginal<typeof import('./ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox } };
});

const { createTicketDurable, postFailureToolResult } = await import('./durableTicketFiling');
const { CREATE_TICKET_PAYLOAD_KIND } = await import('./ticketOutboxService');

/**
 * What optical files when the caller's words do not fit any of its eighteen
 * reasons: department 1, type 66, reason 536 — "Other - See Description".
 *
 * Chosen deliberately as the fixture. This triple is what the legacy outbox
 * path would REWRITE (getValidatedTicketIds knows neither type 66 nor reason
 * 536, so it derives 1 / 1 / 1, "New Rx - Frame Selection"), and the round-trip
 * test in ticketOutboxService.test.ts turns that into an assertion.
 */
const OPTICAL_OTHER = {
  departmentId: 1,
  requestTypeId: 66,
  requestReasonId: 536,
  patientFirstName: 'Wayne',
  patientLastName: 'Fabian',
  patientPhone: '7605551234',
  description: 'The arm snapped off my frames and I need to know what to do.',
  priority: 'medium' as const,
  callData: { agentUsed: 'optical', callSid: 'CA00000000000000000000000000000001' },
  idempotencyKey: 'call-CA00000000000000000000000000000001',
};

beforeEach(() => {
  vi.clearAllMocks();
  writeToOutbox.mockResolvedValue({ outboxId: 'ob-1', alreadyExists: false });
});

describe('the happy path is untouched', () => {
  it('returns the ticket and never opens the outbox', async () => {
    createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-52001' });

    const res = await createTicketDurable(OPTICAL_OTHER);

    expect(res.ticketNumber).toBe('VA-52001');
    expect(res.queued).toBeUndefined();
    expect(writeToOutbox).not.toHaveBeenCalled();
  });
});

describe('a failed POST leaves the request somewhere', () => {
  it('persists the payload the API refused, byte for byte', async () => {
    // The outage signature: HTTP 200, body was not JSON.
    createTicket.mockResolvedValue({
      success: false,
      error: 'Invalid JSON response from ticketing API: 200',
    });

    const res = await createTicketDurable(OPTICAL_OTHER);

    expect(res.queued).toBe(true);
    expect(res.outboxId).toBe('ob-1');
    expect(writeToOutbox).toHaveBeenCalledOnce();

    const [payload, callSid] = writeToOutbox.mock.calls[0];
    expect(payload.kind).toBe(CREATE_TICKET_PAYLOAD_KIND);
    // Not "the same department" — the same OBJECT. Everything the tool resolved
    // with the caller on the line (the office, the provider, the catch-all
    // triple, the caller's own words) has to come back out unchanged, and the
    // only way to assert that is on the whole payload.
    expect(payload.params).toEqual(createTicket.mock.calls[0][0]);
    expect(callSid).toBe('CA00000000000000000000000000000001');
  });

  it('does not throw when the database is down too', async () => {
    createTicket.mockResolvedValue({ success: false, error: 'Ticketing system unreachable' });
    writeToOutbox.mockRejectedValue(new Error('ECONNREFUSED'));

    // Both stores unreachable is the one case this genuinely cannot fix. What
    // it must not do is turn it into a thrown error inside a live call.
    const res = await createTicketDurable(OPTICAL_OTHER);
    expect(res.queued).toBe(false);
    expect(res.success).toBe(false);
  });

  it('gives back the ticket number when a retry already filed it', async () => {
    // The worker runs every 60s. A caller repeating themselves can put a second
    // tool call on the far side of a successful retry — that must read the
    // number back, not file a second ticket.
    createTicket.mockResolvedValue({ success: false, error: 'timeout' });
    writeToOutbox.mockResolvedValue({
      outboxId: 'ob-1',
      alreadyExists: true,
      status: 'sent',
      ticketNumber: 'VA-52002',
    });

    const res = await createTicketDurable(OPTICAL_OTHER);
    expect(res.success).toBe(true);
    expect(res.ticketNumber).toBe('VA-52002');
    expect(res.queued).toBeUndefined();
  });
});

describe('de-duplication must not become the loss it prevents', () => {
  it('files unkeyed when the CallSid is a sentinel, so two callers cannot collide', async () => {
    // `call-unknown` is unique across the whole outbox table. Keying on a
    // sentinel would mean the second caller of the day to fail on one hits
    // onConflictDoNothing and their request is dropped — this module's exact
    // failure mode, reintroduced by its own idempotency. The tools already
    // guard the API key with isTwilioCallSid; deriving the outbox key from that
    // same field is what inherits the guard.
    createTicket.mockResolvedValue({ success: false, error: 'timeout' });
    const sentinel = { ...OPTICAL_OTHER, callData: { agentUsed: 'optical', callSid: 'unknown' } };
    delete (sentinel as { idempotencyKey?: string }).idempotencyKey;

    await createTicketDurable(sentinel);
    await createTicketDurable({ ...sentinel, patientLastName: 'Nguyen', patientPhone: '7605559999' });

    expect(writeToOutbox).toHaveBeenCalledTimes(2);
    expect(writeToOutbox.mock.calls[0][1]).toBeUndefined();
    expect(writeToOutbox.mock.calls[1][1]).toBeUndefined();
    // Both requests are held, and they are different requests.
    expect(writeToOutbox.mock.calls[0][0].params.patientLastName).toBe('Fabian');
    expect(writeToOutbox.mock.calls[1][0].params.patientLastName).toBe('Nguyen');
  });
});

describe('what the agent is told to say', () => {
  it('promises follow-up, no ticket number, and never a call back', async () => {
    const out = postFailureToolResult({ success: false, queued: true, outboxId: 'ob-1' });
    expect(out.success).toBe(true);
    expect((out as { filed_pending?: boolean }).filed_pending).toBe(true);
    // Standing instruction 10: nobody is told to call back. The phrase IS in
    // the message — as a prohibition on the model, which is the only place it
    // belongs. Asserting its absence would have failed on the fix itself.
    expect(out.message).toMatch(/do not ask them to call back/i);
    expect(out.message).not.toMatch(/please call|call us back at|try again later/i);
    // A model handed "recorded" with no number will invent one unless told.
    expect(out.message).toMatch(/no ticket number/i);
  });

  it('still refuses when nothing captured the request', async () => {
    const out = postFailureToolResult({ success: false, queued: false, error: 'ECONNREFUSED' });
    expect(out.success).toBe(false);
    expect((out as { error?: string }).error).toBe('ECONNREFUSED');
  });
});
