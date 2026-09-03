/**
 * Hangup on a live queue lane used to leave the request on the floor.
 *
 * The four Twilio queue agents — optical, surgery, tech, records — have no
 * `terminate_call` tool. The call ends when the caller hangs up. The
 * end-of-call filing sweep that rescues an unfiled call existed only for
 * `azul-scheduling` and `pcp`. Those four lanes fell through to
 * `Promise.resolve()` in voiceAgentRoutes, and the payload was never built
 * because the filing tool never ran. Documented as a separate piece of work
 * at durableTicketFiling.ts:25-27 and never done.
 *
 * These tests are the contract for that sweep. They would have been red
 * against the code that lost the 2026-09-02 requests.
 *
 * PHI: fixtures use the operator's own published test identity, the same
 * one the rest of this suite already uses. No live-caller data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';

const createTicket = vi.fn();
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: {
    createTicket: (...a: unknown[]) => createTicket(...a),
    lookupProviderAndLocation: vi.fn(() => {
      throw new Error('sweep must not re-resolve office or provider');
    }),
  },
  lookupWasUnavailable: () => false,
}));

const writeToOutbox = vi.fn();
vi.mock('./ticketOutboxService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ticketOutboxService')>();
  return { ...actual, TicketOutboxService: { writeToOutbox } };
});

const { callMetadataForDB } = await import('./callMetadataStore');
const { rememberVerifiedIdentity, resetVerifiedIdentities } = await import(
  '../tools/verifiedIdentity'
);
const {
  rememberQueueCall,
  resetQueueCallState,
  QUEUE_LANES,
  isQueueLane,
} = await import('./queueCallState');
const { sweepQueueUnfiledCall } = await import('./queueHangupSweep');
const { CREATE_TICKET_PAYLOAD_KIND } = await import('./ticketOutboxService');

const SID = 'CA00000000000000000000000000000001';
const CALL_ID = 'openai-call-queue-sweep-1';
const WAYNE = { firstName: 'Wayne', lastName: 'Fabian', dateOfBirth: '03/17/1973' };

const STATED: Record<(typeof QUEUE_LANES)[number], string> = {
  optical: 'the arm snapped off my frames',
  surgery: 'my drops never arrived for Monday surgery',
  tech: 'I need a refill of my Latanoprost',
  records: 'I need a copy of my visit notes faxed to my doctor',
};

function seedLiveQueueCall(slug: (typeof QUEUE_LANES)[number], extras: Record<string, unknown> = {}) {
  callMetadataForDB.set(CALL_ID, {
    startTime: new Date(),
    agentSlug: slug,
    twilioCallSid: SID,
    from: '+17605551234',
    transferredToHuman: false,
    audioInputMs: 0,
    audioOutputMs: 0,
  });
  rememberVerifiedIdentity(SID, WAYNE);
  rememberQueueCall(SID, {
    agentSlug: slug,
    requestDescription: STATED[slug],
    ...extras,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVerifiedIdentities();
  resetQueueCallState();
  callMetadataForDB.delete(CALL_ID);
  writeToOutbox.mockResolvedValue({ outboxId: 'ob-sweep-1', alreadyExists: false });
  createTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-61001' });
});

describe('the hole this closes — wiring', () => {
  const routes = readFileSync(join(__dirname, '..', 'voiceAgentRoutes.ts'), 'utf8');

  it('runs the queue sweep on teardown, not Promise.resolve()', () => {
    expect(routes).toMatch(/sweepQueueUnfiledCall/);
    for (const slug of QUEUE_LANES) {
      expect(routes, `${slug} is a live queue lane and must be in the sweep gate`).toMatch(
        new RegExp(`['"]${slug}['"]`),
      );
    }
    const at = routes.indexOf('sweepQueueUnfiledCall');
    expect(at, 'the sweep is not wired').toBeGreaterThan(-1);
    expect(routes.slice(at, at + 400)).toMatch(/25_000/);
  });

  it('is a third narrow sweep — not azul or pcp vocabulary', () => {
    const at = routes.indexOf('sweepQueueUnfiledCall');
    const block = routes.slice(at - 200, at + 400);
    expect(block).not.toMatch(/sweepAzulUnresolvedCall\(callId\)\s*,/);
    expect(routes).toMatch(/sweepAzulUnresolvedCall/);
    expect(routes).toMatch(/sweepPcpUnfiledCall/);
  });

  it('names exactly the four live queue lanes', () => {
    expect([...QUEUE_LANES]).toEqual(['optical', 'surgery', 'tech', 'records']);
    expect(QUEUE_LANES.every(isQueueLane)).toBe(true);
    expect(isQueueLane('answering-service')).toBe(false);
    expect(isQueueLane('azul-scheduling')).toBe(false);
    expect(isQueueLane('pcp')).toBe(false);
  });
});

describe('hangup without terminate_call still files from conversation state', () => {
  it.each(QUEUE_LANES)(
    '%s: caller hangup with a stated request and a verified identity files a ticket',
    async (slug) => {
      seedLiveQueueCall(slug);

      const result = await sweepQueueUnfiledCall({
        callId: CALL_ID,
        agentSlug: slug,
        twilioCallSid: SID,
        from: '+17605551234',
      });

      expect(createTicket).toHaveBeenCalledTimes(1);
      const payload = createTicket.mock.calls[0][0];
      expect(payload.patientFirstName).toBe('Wayne');
      expect(payload.patientLastName).toBe('Fabian');
      expect(payload.patientPhone).toBe('7605551234');
      expect(payload.patientBirthYear).toBe('1973');
      expect(payload.callData.agentUsed).toBe(slug);
      expect(payload.callData.callSid).toBe(SID);
      expect(payload.idempotencyKey).toBe(`call-${SID}`);
      expect(payload.description).toMatch(/HUNG UP BEFORE THE REQUEST WAS COMPLETE/);
      expect(payload.description).toContain(STATED[slug]);
      expect(result.filed).toBe(true);
      expect(result.ticketNumber).toBe('VA-61001');
      expect(result.inventedTicketNumber).not.toBe(true);
    },
  );

  it('does not invent a ticket number when the POST fails — durable-queues instead', async () => {
    seedLiveQueueCall('optical');
    createTicket.mockResolvedValue({ success: false, error: 'gateway timeout', statusCode: 502 });

    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'optical',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    expect(result.ticketNumber).toBeUndefined();
    expect(result.inventedTicketNumber).not.toBe(true);
    expect(result.queued).toBe(true);
    expect(result.outboxId).toBe('ob-sweep-1');
    expect(writeToOutbox).toHaveBeenCalledTimes(1);
    const [wrapped] = writeToOutbox.mock.calls[0];
    expect(wrapped.kind).toBe(CREATE_TICKET_PAYLOAD_KIND);
    expect(wrapped.params.departmentId).toBe(1);
  });

  it('never reports success:true with no ticket number', async () => {
    seedLiveQueueCall('tech');
    createTicket.mockResolvedValue({ success: true }); // far side said ok, no number

    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'tech',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    expect(result.ticketNumber).toBeUndefined();
    expect(result.filed).not.toBe(true);
    expect(result.queued === true || result.filed === false).toBe(true);
  });
});

describe('what the sweep must not do', () => {
  it('does not file a ghost call — no stated request, even with a caller-ID number', async () => {
    callMetadataForDB.set(CALL_ID, {
      startTime: new Date(),
      agentSlug: 'optical',
      twilioCallSid: SID,
      from: '+17605551234',
      transferredToHuman: false,
      audioInputMs: 0,
      audioOutputMs: 0,
    });

    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'optical',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    expect(createTicket).not.toHaveBeenCalled();
    expect(result.filed).toBe(false);
    expect(result.skipped).toBe('no_stated_request');
  });

  it('does not file again when a ticket number is already on the call', async () => {
    seedLiveQueueCall('surgery');
    rememberQueueCall(SID, { filedTicketNumber: 'VA-60999' });

    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'surgery',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    expect(createTicket).not.toHaveBeenCalled();
    expect(result.skipped).toBe('already_filed');
  });

  it('does not file a second ticket when check_open_tickets already found one', async () => {
    seedLiveQueueCall('optical');
    rememberQueueCall(SID, { existingOpenTicket: 'VA-56007' });

    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'optical',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    expect(createTicket).not.toHaveBeenCalled();
    expect(result.skipped).toBe('open_ticket_already');
  });

  it('does not run for scheduling or pcp — they have their own sweeps', async () => {
    const result = await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'azul-scheduling',
      twilioCallSid: SID,
      from: '+17605551234',
    });
    expect(createTicket).not.toHaveBeenCalled();
    expect(result.skipped).toBe('not_a_queue_lane');
  });

  it('carries a verified office already on the call and does not re-resolve it', async () => {
    seedLiveQueueCall('optical', { verifiedLocation: 'Encinitas' });

    await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'optical',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    const payload = createTicket.mock.calls[0][0];
    expect(payload.locationOfLastVisit).toBe('Encinitas');
    expect(payload.locationId).toBeUndefined();
  });

  it('on surgery, tells the app the routing ask is spent so hangup is not a 400', async () => {
    seedLiveQueueCall('surgery', {
      requestDescription: 'my drops never arrived',
      lastProvider: 'Logan',
    });

    await sweepQueueUnfiledCall({
      callId: CALL_ID,
      agentSlug: 'surgery',
      twilioCallSid: SID,
      from: '+17605551234',
    });

    const payload = createTicket.mock.calls[0][0];
    expect(payload.departmentId).toBe(2);
    expect(payload.lastProviderSeen).toBe('Logan');
    expect(payload.providerId).toBeUndefined();
    expect(payload.routingAskExhausted).toBe(true);
  });

  it('never throws — the call is already over', async () => {
    createTicket.mockRejectedValue(new Error('boom'));
    seedLiveQueueCall('records');

    await expect(
      sweepQueueUnfiledCall({
        callId: CALL_ID,
        agentSlug: 'records',
        twilioCallSid: SID,
        from: '+17605551234',
      }),
    ).resolves.toMatchObject({ filed: false });
  });
});
