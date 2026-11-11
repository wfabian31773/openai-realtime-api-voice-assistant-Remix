/**
 * v205: AN OUTAGE DOES NOT STRAND A SWEPT RECORDS-LINE REQUEST.
 *
 * Operator, 2026-11-11: "during an outage, a records-line appointment with no
 * patient name can get stuck and never filed."
 *
 * The chain, read from `main` (v204):
 *   1. v203 made the sentence read from the recording the description of a
 *      swept Medical Records ticket. When the sentence is about something
 *      else (an appointment), the app's records-line classifier routes it out
 *      of Medical Records, and a nameless routed request is refused HTTP 400:
 *      only Medical Records files without a name.
 *   2. The sweep's default filer answered that refusal by filing again with
 *      the placeholder on the same key. But it only saw a refusal that came
 *      back on its own POST.
 *   3. In an outage the POST fails with no status, `createTicketDurable`
 *      holds it in the outbox and answers `queued`, and the sweep counts the
 *      request as filed. The worker replays the payload verbatim once the app
 *      is back, the app refuses it, and the row dead-letters. No ticket.
 *
 * This drives the whole chain: the production default filer, the real
 * `createTicketDurable` and the real outbox, with only the database row and
 * the app's HTTP answer faked. The two calls are the records-lane calls of
 * 2026-11-10 that were not records requests (v203's corpus), by their real
 * SIDs. Every word is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

// ------------------------------------------------- one outbox row, in memory --
// Drizzle conditions cannot be evaluated here, so the fake keeps the one row
// this call writes and applies every update to it. The guarded statements
// themselves are pinned in ticketOutboxService.test.ts.
type Row = Record<string, unknown>;
const outbox: { row?: Row; statuses: string[] } = { statuses: [] };

vi.mock('../../server/db', async () => {
  const schema = await import('../../shared/schema');
  const thenable = (value: () => unknown) => {
    const self: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'onConflictDoNothing', 'returning', 'groupBy', 'values', 'set']) {
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
          if (table !== schema.ticketOutbox) return [];
          if (outbox.row) return [];
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
      select: () => thenable(() => (outbox.row ? [{ ...outbox.row }] : [])),
    },
  };
});

vi.mock('../../server/storage', () => ({
  storage: { releaseTicketCreationLock: vi.fn(), updateCallLog: vi.fn() },
}));

// The app: an outage while `down`, then its real answer for this shape.
const app = { down: true, posts: [] as Row[] };
vi.mock('../../server/services/ticketingApiClient', () => ({
  ticketingApiClient: {
    createTicket: async (payload: Row) => {
      app.posts.push(payload);
      if (app.down) return { success: false, error: 'fetch failed' };
      const description = String(payload.description);
      if (description !== SWEPT_TICKET_DESCRIPTION && !payload.patientFirstName && recordsLinePurpose(description) !== 'records') {
        return {
          success: false,
          statusCode: 400,
          error: 'Missing required information: patientFirstName, patientLastName (only a Medical Records request may file without a patient name)',
        };
      }
      return { success: true, ticketNumber: `VA-HELD-${app.posts.length}`, ticketId: app.posts.length };
    },
  },
  lookupWasUnavailable: () => false,
}));

import { resetStatedNames } from '../tools/statedName';
import { resetVerifiedIdentities } from '../tools/verifiedIdentity';
import { resetDraftedRequests } from '../tools/draftedRequest';
import { runRequestSweep } from './sweepRunner';
import { SWEPT_TICKET_DESCRIPTION } from './requestSweep';
import { TicketOutboxService } from '../services/ticketOutboxService';
import type { RequestAsker } from './requestFromTheRecording';
import type { VoiceCallRecord } from './mediaStreamBridge';
import { recordsLinePurpose } from '../../shared/records-request-intent';

function record(callSid: string, callerLines: string[]): VoiceCallRecord {
  const lines = ['AGENT: Thank you for calling Azul Vision medical records. How can I help you today?'];
  for (const said of callerLines) {
    lines.push(`CALLER: ${said}`);
    lines.push('AGENT: Thank you. Let me take that down for you. [interrupted]');
  }
  return {
    callSid,
    streamSid: 'MZ0000000000000000000000000000000',
    slug: 'records',
    callerPhone: '+15555550100',
    dialedNumber: '+15555550199',
    outcome: 'caller_hangup',
    transcript: lines.join('\n'),
    toolEvents: [],
    agentTurns: callerLines.length + 1,
    interruptions: 0,
    startedAtMs: 1_000,
    endedAtMs: 76_000,
  } as VoiceCallRecord;
}

const noName = async () => null;
const noNumber = async () => null;
const answers = (request: string): RequestAsker => async () => ({ request });

const NOT_RECORDS = [
  {
    sid: 'CAdd8ebea9bd4608b0a9c72754b932e90b',
    says: ['Sí.', 'Cambio de cita, por favor.'],
    reads: 'Wants to change an upcoming appointment.',
  },
  {
    sid: 'CA9866028a713777fd6870455eeedecb4f',
    says: ['Yes.', 'Is the office going to be open for my appointment, because of the holiday?'],
    reads: 'Asking whether the office will be open for their appointment on the holiday.',
  },
];

beforeEach(() => {
  outbox.row = undefined;
  outbox.statuses = [];
  app.down = true;
  app.posts = [];
  resetStatedNames();
  resetVerifiedIdentities();
  resetDraftedRequests();
});

describe('a nameless records-line appointment request held through an outage', () => {
  it.each(NOT_RECORDS)('$sid — files with the placeholder on the replay, on the same key', async (row) => {
    // The sentence is not a records request, so the recovered app refuses it.
    expect(recordsLinePurpose(row.reads)).not.toBe('records');

    const out = await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, answers(row.reads));
    expect(out.filed).toBe(true);
    // Held, not filed: the only POST was the one the outage swallowed.
    expect(app.posts).toHaveLength(1);
    expect(outbox.row?.status).toBe('failed');

    app.down = false;
    const sent = await TicketOutboxService.attemptSend('ob-1');

    expect(sent.success).toBe(true);
    expect(sent.ticketNumber).toMatch(/^VA-HELD-/);
    expect(outbox.row?.status).toBe('sent');
    expect(outbox.statuses).not.toContain('dead_letter');
    const [, refused, filed] = app.posts;
    expect(refused.description).toBe(row.reads);
    expect(filed.description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(filed.idempotencyKey).toBe(`call-${row.sid}`);
    expect(filed.idempotencyKey).toBe(refused.idempotencyKey);
    expect(filed.departmentId).toBe(16);
    expect(filed).not.toHaveProperty('patientFirstName');
    // The sentence is still on the staff side.
    expect(String((filed.callData as Row).transcript)).toContain(row.reads);
  });

  it('the held payload carries the placeholder beside the sentence, never on the wire', async () => {
    const row = NOT_RECORDS[0];
    await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, answers(row.reads));
    const payload = outbox.row?.payload as { params: Row; refusalFallback?: { description: string } };
    expect(payload.params.description).toBe(row.reads);
    expect(payload.refusalFallback).toEqual({ description: SWEPT_TICKET_DESCRIPTION });
    expect(app.posts[0]).not.toHaveProperty('refusalFallback');
  });

  it('a held placeholder carries no fallback: there is nothing left to try', async () => {
    const row = NOT_RECORDS[0];
    await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, async () => ({ request: null }));
    const payload = outbox.row?.payload as { params: Row; refusalFallback?: unknown };
    expect(payload.params.description).toBe(SWEPT_TICKET_DESCRIPTION);
    expect(payload).not.toHaveProperty('refusalFallback');
  });

  it('with no outage it files the same ticket in one sweep, as v203 did', async () => {
    const row = NOT_RECORDS[1];
    app.down = false;
    const out = await runRequestSweep(record(row.sid, row.says), undefined, noName, noNumber, answers(row.reads));
    expect(out.filed).toBe(true);
    expect(outbox.row?.status).toBe('sent');
    expect(app.posts.map((p) => p.description)).toEqual([row.reads, SWEPT_TICKET_DESCRIPTION]);
    expect(new Set(app.posts.map((p) => p.idempotencyKey)).size).toBe(1);
  });
});
