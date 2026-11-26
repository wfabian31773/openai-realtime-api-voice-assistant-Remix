/**
 * v279: A HELD OPTICAL OR SURGERY REQUEST REFUSED ON ITS REPLAY FOR THE OFFICE
 * OR THE SURGEON BECOMES A TICKET.
 *
 * The 2026-10-30 shape, read from the Hub's `ticket_outbox`: `file_surgery_ticket`
 * persisted its payload, the create-ticket POST did not complete in time, the
 * tool told the model the request was recorded, and the caller heard it was
 * logged. Two minutes later the worker replayed the row, the app answered
 * HTTP 400 "Missing required information: surgeon", and the row went
 * `dead_letter` with nobody on the line to ask. No ticket of any provenance.
 *
 * Every dead letter with a refusal status, to 2026-11-26 (7 rows):
 *   - held, then refused on the replay for the surgeon: 2, the corpus below
 *     (`retry_count` 1 on the POST-first path of 2026-10-02, 2 on the
 *     persist-first path of 2026-10-30), neither with a ticket;
 *   - refused on the call itself and auto-resolved in 1 to 33 s: 5 (one
 *     Surgery, three PCP records requests routed to Optical for the office,
 *     one Medical Records addition for a name). There the refusal is the
 *     tool's own ask (v81), and this build does not touch it.
 *
 * This drives the production chain: the real surgery tool through `runTool`,
 * the real `createTicketDurable`, and the real outbox and its worker. Only the
 * database row and the app's HTTP answer are faked. SIDs are real; every word
 * and name is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
process.env.OPENAI_API_KEY ||= 'test-unused';

// ------------------------------------------------- one outbox row, in memory --
// Drizzle conditions cannot be evaluated here, so the fake keeps the one row a
// test writes and applies every outbox update to it. Statements on any other
// table answer nothing. The guarded statements themselves are pinned in
// ticketOutboxService.test.ts.
type Row = Record<string, unknown>;
const outbox: { row?: Row; statuses: string[] } = { statuses: [] };

vi.mock('../../server/db', async () => {
  const schema = await import('../../shared/schema');
  const thenable = (value: () => unknown) => {
    const self: Record<string, unknown> = {};
    for (const m of ['where', 'limit', 'onConflictDoNothing', 'returning', 'groupBy', 'values', 'set', 'orderBy']) {
      self[m] = () => self;
    }
    self.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve().then(value).then(ok, err);
    return self;
  };
  return {
    db: {
      insert: (table: unknown) => {
        let values: Row = {};
        const self = thenable(() => {
          if (table !== schema.ticketOutbox || outbox.row) return [];
          outbox.row = { id: 'ob-1', retryCount: 0, ...values };
          outbox.statuses.push(String(values.status));
          return [{ id: 'ob-1' }];
        });
        self.values = (v: Row) => { values = v; return self; };
        return self;
      },
      update: (table: unknown) => {
        let patch: Row = {};
        const self = thenable(() => {
          if (table !== schema.ticketOutbox || !outbox.row) return [];
          Object.assign(outbox.row, patch);
          if (patch.status) outbox.statuses.push(String(patch.status));
          return [{ ...outbox.row }];
        });
        self.set = (p: Row) => { patch = p; return self; };
        return self;
      },
      select: () => {
        let table: unknown;
        const self = thenable(() => (table === schema.ticketOutbox && outbox.row ? [{ ...outbox.row }] : []));
        self.from = (t: unknown) => { table = t; return self; };
        return self;
      },
    },
  };
});

vi.mock('../../server/storage', () => ({
  storage: { releaseTicketCreationLock: vi.fn(), updateCallLog: vi.fn() },
}));

// The surgeon ladder reads the schedule only when nothing else resolved; the
// corpus callers had no surgeon on record, which is why the app refused them.
vi.mock('./scheduleLookupService', () => ({
  scheduleLookupService: { lookupByNameAndDOB: async () => ({ patientFound: false }) },
}));

import { runTool } from '../tools/registry';
import '../tools/sharedPatientTools';
import '../tools/surgeryTools';
import { resetGateAttempts } from '../tools/gateAttempts';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { ticketingApiClient } from '../../server/services/ticketingApiClient';
import type { CreateTicketParams } from '../../server/services/ticketingApiClient';
import {
  TicketOutboxService,
  ROUTING_FIELD_BY_DEPARTMENT,
  heldRoutingExitNote,
} from './ticketOutboxService';
import { createTicketDurable } from './durableTicketFiling';
import { TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS } from '../runtime/requestSweep';

// ------------------------------------------------------------------ the app --
// An outage while `down`; then create-ticket's own routing gate: Surgery
// refuses a ticket with no surgeon, Optical one with no office, unless the
// request says the ask is spent (`routingAskExhausted`), when it files it
// unassigned.
const app = { down: true, posts: [] as CreateTicketParams[], refuseWith: undefined as string | undefined };

function theApp(payload: CreateTicketParams) {
  app.posts.push(structuredClone(payload));
  if (app.down) return { success: false, error: 'The operation was aborted due to timeout' };
  if (app.refuseWith) return { success: false, statusCode: 400, error: app.refuseWith };
  if (payload.routingAskExhausted !== true) {
    if (payload.departmentId === 2 && !payload.providerId) {
      return { success: false, statusCode: 400, error: 'Missing required information: surgeon. Surgery tickets are assigned by surgeon.' };
    }
    if (payload.departmentId === 1 && !payload.locationId) {
      return { success: false, statusCode: 400, error: 'Missing required information: office' };
    }
  }
  return { success: true, ticketNumber: `VA-HELD-${app.posts.length}`, ticketId: app.posts.length };
}

/** A surgery caller with no surgeon anywhere, in the corpus calls' shape. */
function surgeryCaller(sid: string) {
  return {
    first_name: 'Testa',
    last_name: 'Lake',
    date_of_birth: '05/22/1948',
    location: 'Synthetic Clinic',
    callback_number: '909-555-0147',
    request_description: 'Wants to know when the cataract surgery is scheduled',
    call_sid: sid,
  };
}

const HELD_THEN_REFUSED = [
  { sid: 'CA9f2717c562f8f8d72675faf5e05a52ea', day: '2026-10-30' },
  { sid: 'CAb7e38750f96288150a675729d1de0d57', day: '2026-10-02' },
];

beforeEach(() => {
  vi.restoreAllMocks();
  outbox.row = undefined;
  outbox.statuses = [];
  app.down = true;
  app.posts = [];
  app.refuseWith = undefined;
  vi.spyOn(ticketingApiClient, 'createTicket').mockImplementation(async (p) => theApp(p) as never);
  vi.spyOn(ticketingApiClient, 'lookupProviderAndLocation').mockResolvedValue({
    success: true,
    outcome: 'no_match',
    locationMatches: [],
  } as never);
  resetGateAttempts();
  resetVerifiedIdentities();
});

describe('a surgery request held through a timeout and refused on its replay for the surgeon', () => {
  it.each(HELD_THEN_REFUSED)('$sid ($day) — files unassigned on the replay, on the same key', async ({ sid }) => {
    const told = await runTool('file_surgery_ticket', surgeryCaller(sid));

    // What the caller heard: the request is logged, with no number.
    expect((told as { filed_pending?: boolean }).filed_pending).toBe(true);
    expect(app.posts).toHaveLength(1);
    expect(outbox.row?.status).toBe('failed');

    app.down = false;
    await TicketOutboxService.processRetries();

    const [, refused, filed] = app.posts;
    expect(refused.routingAskExhausted).toBeUndefined();
    expect(filed.routingAskExhausted).toBe(true);
    expect(filed.departmentId).toBe(2);
    expect(filed.idempotencyKey).toBe(`call-${sid}`);
    expect(filed.idempotencyKey).toBe(refused.idempotencyKey);
    // Nothing the caller gave changes on the way to the exit.
    expect(filed.description).toBe(refused.description);
    expect(filed.patientFirstName).toBe(refused.patientFirstName);
    expect(filed.priority).toBe(refused.priority);
    // Staff-only, never the description (an SMS body).
    expect(filed.callData?.transcript).toContain(heldRoutingExitNote('surgeon'));
    expect(filed.description).not.toContain('UNASSIGNED');
    // The fallback rides in the envelope, never on the wire.
    expect(filed).not.toHaveProperty('refusalFallback');

    expect(app.posts).toHaveLength(3);
    expect(outbox.row?.status).toBe('sent');
    expect(outbox.row?.ticketNumber).toBe('VA-HELD-3');
    expect(outbox.statuses).not.toContain('dead_letter');
  });

  it('a staff note already on the payload is kept, with the exit note after it', async () => {
    const res = await createTicketDurable({
      departmentId: 2, requestTypeId: 8, requestReasonId: 18,
      patientFirstName: 'Testa', patientLastName: 'Lake', patientPhone: '9095550147',
      description: 'Wants to know when the cataract surgery is scheduled', priority: 'medium',
      callData: { agentUsed: 'surgery', callSid: HELD_THEN_REFUSED[0].sid, transcript: 'Callback extension: 22' },
      idempotencyKey: `call-${HELD_THEN_REFUSED[0].sid}`,
    });
    expect(res.queued).toBe(true);

    app.down = false;
    await TicketOutboxService.processRetries();

    expect(app.posts[2].callData?.transcript).toBe(`Callback extension: 22\n${heldRoutingExitNote('surgeon')}`);
  });
});

describe('an Optical request held and refused on its replay for the office', () => {
  it('files unassigned on the replay, with the office note', async () => {
    const res = await createTicketDurable({
      departmentId: 1, requestTypeId: 66, requestReasonId: 536,
      patientFirstName: 'Testa', patientLastName: 'Lake', patientPhone: '9095550147',
      description: 'Glasses order status', priority: 'medium',
      callData: { agentUsed: 'optical', callSid: 'CA00000000000000000000000000000a01' },
      idempotencyKey: 'call-CA00000000000000000000000000000a01',
    });
    expect(res.queued).toBe(true);

    app.down = false;
    await TicketOutboxService.processRetries();

    const filed = app.posts[2];
    expect(filed.routingAskExhausted).toBe(true);
    expect(filed.departmentId).toBe(1);
    expect(filed.callData?.transcript).toBe(heldRoutingExitNote('office'));
    expect(outbox.row?.status).toBe('sent');
  });
});

describe('what does not take the exit', () => {
  it('a refusal while the caller is on the line is still the ask, and nothing more is sent', async () => {
    // CAcfde08043ccdaea497d9a6b61d30b598 (2026-10-29) is this shape: refused on
    // the call itself, auto-resolved in 2 s. The question goes to the caller.
    app.down = false;
    const told = await runTool('file_surgery_ticket', surgeryCaller('CAcfde08043ccdaea497d9a6b61d30b598'));

    expect((told as { missingFields?: string[] }).missingFields).toEqual(['surgeon']);
    expect(app.posts).toHaveLength(1);
    expect(app.posts[0].routingAskExhausted).toBeUndefined();
    expect(outbox.row?.status).toBe('dead_letter');
  });

  it('a replay refused for anything but the routing field dead-letters after one replay', async () => {
    await runTool('file_surgery_ticket', surgeryCaller(HELD_THEN_REFUSED[0].sid));
    app.down = false;
    app.refuseWith = 'Missing required information: patientFirstName';
    await TicketOutboxService.processRetries();

    expect(app.posts).toHaveLength(2);
    expect(app.posts.some((p) => p.routingAskExhausted)).toBe(false);
    expect(outbox.row?.status).toBe('dead_letter');
  });

  it("a replay refused for the other department's field dead-letters", async () => {
    // Surgery's field is the surgeon. An office refusal on a department-2
    // ticket is not something the surgeon exit answers.
    await runTool('file_surgery_ticket', surgeryCaller(HELD_THEN_REFUSED[0].sid));
    app.down = false;
    app.refuseWith = 'Missing required information: office';
    await TicketOutboxService.processRetries();

    expect(app.posts).toHaveLength(2);
    expect(outbox.row?.status).toBe('dead_letter');
  });

  it('a held request that already took the exit is not sent a third time', async () => {
    await createTicketDurable({
      departmentId: 2, requestTypeId: 8, requestReasonId: 18,
      patientFirstName: 'Testa', patientLastName: 'Lake', patientPhone: '9095550147',
      description: 'Surgery date question', priority: 'medium', routingAskExhausted: true,
      callData: { agentUsed: 'surgery', callSid: HELD_THEN_REFUSED[0].sid },
      idempotencyKey: `call-${HELD_THEN_REFUSED[0].sid}`,
    });
    expect(outbox.row?.payload).not.toHaveProperty('refusalFallback');

    app.down = false;
    app.refuseWith = 'Missing required information: surgeon';
    await TicketOutboxService.processRetries();

    expect(app.posts).toHaveLength(2);
    expect(outbox.row?.status).toBe('dead_letter');
  });

  it('a Technicians request carries no exit, and dead-letters on a refused replay as before', async () => {
    await createTicketDurable({
      departmentId: 3, requestTypeId: 30, requestReasonId: 153,
      patientFirstName: 'Testa', patientLastName: 'Lake', patientPhone: '9095550147',
      description: 'Drop refill', priority: 'medium',
      callData: { agentUsed: 'tech', callSid: 'CA00000000000000000000000000000a03' },
      idempotencyKey: 'call-CA00000000000000000000000000000a03',
    });
    expect(outbox.row?.payload).not.toHaveProperty('refusalFallback');

    app.down = false;
    app.refuseWith = 'Missing required information: surgeon';
    await TicketOutboxService.processRetries();

    expect(app.posts).toHaveLength(2);
    expect(outbox.row?.status).toBe('dead_letter');
  });

  it('a later filing on the call carries no exit: it adds to a ticket that exists', () => {
    const src = readFileSync(new URL('./durableTicketFiling.ts', import.meta.url), 'utf8');
    const repeat = src.slice(src.indexOf('async function forwardRepeatFiling'), src.indexOf('async function heldPriority'));
    expect(repeat).toContain('wrapCreateTicketPayload(params)');
    expect(repeat).not.toMatch(/routingExit/);
  });
});

describe('one list of the queues that route by a field the call supplies', () => {
  it('the outbox exit covers exactly the departments the teardown filers send the flag on', () => {
    expect([...ROUTING_FIELD_BY_DEPARTMENT.keys()].sort()).toEqual([...TEARDOWN_UNASSIGNED_EXIT_DEPARTMENTS].sort());
  });
});
