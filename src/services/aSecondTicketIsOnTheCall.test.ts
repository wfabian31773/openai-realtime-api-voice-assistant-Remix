/**
 * A SECOND TICKET IS ON THE CALL'S TIMELINE (v223) — the write half of
 * "every call on the Observatory log shows every ticket it created"
 * (operator, 2026-11-13). The read half is server/callTicketNumbers.test.ts.
 *
 * THE CORPUS. 15 calls in the 14 days to 2026-11-13 carried two agent
 * tickets under their own call SID (Support Center, agent provenance). 12
 * already had the second number on their tool timeline, because the PCP
 * filing tools report it. The other 3 were after-hours calls whose urgent
 * ring-out record was filed BESIDE the caller's request
 * (`call-<sid>-urgent-ringout`, read from voice_agent_api_logs) — a filing
 * that is not a tool and never writes back, so it was nowhere on the call row:
 *
 *   CA5ce9377f5c98d9233e8103b9b6e3f74b  VA-79083 + VA-79084
 *   CAac5dac2b9162bb8cdafa6ad1bbbf6c35  VA-79087 + VA-79088
 *   CAbccc433f0627622f50d32ff4abd7cec8  VA-82148 + VA-82149
 *
 * The SIDs and ticket numbers are real; every other value here is synthetic.
 *
 * The safety property is the other half: the event must never REPLACE the
 * call's timeline. A flush writes an entry's events as the whole timeline, so
 * an entry opened under the CallSid while the agent's events sit under its own
 * call id would gut the row (the 2026-07-28 shape). These tests drive the REAL
 * submitSimplifiedTicket and the REAL tool timeline, with only the ticketing
 * client, the storage lock and the database replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  claimTicketCreation: vi.fn(),
  releaseTicketCreationLock: vi.fn(),
  getCallLogBySid: vi.fn(),
  submitTicket: vi.fn(),
  resolveTicketLookupFields: vi.fn(),
  /** Every `.set(...)` the code sent to call_logs, in order. */
  sets: [] as Array<Record<string, unknown>>,
  /** Every `.where(...)` that went with them. */
  wheres: [] as unknown[],
  rows: 1,
  updateThrows: false,
}));

vi.mock('../../server/db', () => ({
  db: {
    update: () => {
      if (h.updateThrows) throw new Error('database unavailable (synthetic)');
      return {
        set: (payload: Record<string, unknown>) => {
          h.sets.push(payload);
          return {
            where: (w: unknown) => {
              h.wheres.push(w);
              return { returning: async () => (h.rows > 0 ? [{ id: 'row-1' }] : []) };
            },
          };
        },
      };
    },
    // writeTimeline looks the row id up by CallSid for its grader pass.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'row-1' }] }) }) }),
  },
}));
vi.mock('./callGradingService', () => ({
  callGradingService: { runAndPersistDeterministicGraders: vi.fn(async () => undefined) },
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
import {
  recordToolEvent,
  getAzulTimeline,
  recordSecondTicketOnTheCall,
  SECOND_TICKET_RETRY_MS,
  SECOND_TICKET_TOOL,
} from './toolTimeline';
import { ticketNumbersForCall } from '../../server/callTicketNumbers';

const CORPUS = [
  { sid: 'CA5ce9377f5c98d9233e8103b9b6e3f74b', first: 'VA-79083', second: 'VA-79084' },
  { sid: 'CAac5dac2b9162bb8cdafa6ad1bbbf6c35', first: 'VA-79087', second: 'VA-79088' },
  { sid: 'CAbccc433f0627622f50d32ff4abd7cec8', first: 'VA-82148', second: 'VA-82149' },
];

const besideParams = (callSid: string) => ({
  patientFullName: 'Unnamed Caller',
  patientDOB: 'Unknown',
  reasonForCalling: 'Request Type: Urgent/Emergency Transfer\nURGENT TRANSFER NOT ANSWERED (synthetic)',
  preferredContactMethod: 'phone' as const,
  patientPhone: '5550000000',
  priority: 'urgent' as const,
  departmentId: 8,
  callSid,
  agentUsed: 'no-ivr',
  secondTicketOnThisCall: { keySuffix: 'urgent-ringout' },
});

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);

/** The timeline payload the last flush wrote, as a plain object. */
const lastTimelineWritten = () => {
  const withTimeline = h.sets.filter((s) => s.toolTimeline && !('queryChunks' in (s.toolTimeline as object)));
  return withTimeline[withTimeline.length - 1]?.toolTimeline as { events: Array<Record<string, any>> } | undefined;
};

/** The agent's own events, recorded under ITS call id — not the CallSid. */
function seedAgentTimeline(callId: string, callSid: string, requestTicket = 'VA-00000') {
  recordToolEvent(callId, 'escalate_to_human', { reason: 'synthetic' }, JSON.stringify({ success: true }), 12, {
    callSid,
    agentSlug: 'no-ivr',
  });
  recordToolEvent(
    callId,
    'create_ticket',
    {},
    JSON.stringify({ success: true, ticket_number: requestTicket, ticketCreated: true }),
    40,
    { callSid, agentSlug: 'no-ivr' },
  );
}

let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  h.sets.length = 0;
  h.wheres.length = 0;
  h.rows = 1;
  h.updateThrows = false;
  h.releaseTicketCreationLock.mockResolvedValue(undefined);
  h.resolveTicketLookupFields.mockResolvedValue({});
  n += 1;
});

describe('the corpus: an urgent ring-out record filed beside the request reaches the call log', () => {
  for (const c of CORPUS) {
    it(`${c.sid}: ${c.first} and ${c.second} are both on the call`, async () => {
      // The agent's own key is not the CallSid, as on the old core.
      const callId = `rt-${n}-${c.sid}`;
      const callSid = c.sid;
      seedAgentTimeline(callId, callSid, c.first);
      h.submitTicket.mockResolvedValue({ success: true, ticketNumber: c.second });

      const r = await SyncAgentService.submitSimplifiedTicket(besideParams(callSid));
      expect(r).toMatchObject({ success: true, ticketNumber: c.second });

      await vi.waitFor(() => expect(lastTimelineWritten()?.events.some((e) => e.tool === SECOND_TICKET_TOOL)).toBe(true));
      const written = lastTimelineWritten()!;
      // The agent's two events and the second ticket — the row's timeline is
      // the agent's, extended, never replaced by a one-event entry.
      expect(written.events.map((e) => e.tool)).toEqual(['escalate_to_human', 'create_ticket', SECOND_TICKET_TOOL]);
      expect(written.events[2].outcome).toEqual({ success: true, ticket_number: c.second });
      expect(written.events[2].args).toEqual({ reason: 'urgent-ringout' });

      // And the call log now shows both, the row's own first.
      expect(ticketNumbersForCall({ ticketNumber: c.first, toolTimeline: written })).toEqual([c.first, c.second]);
      // The before-arm: the row alone, which is all the log had.
      expect(ticketNumbersForCall({ ticketNumber: c.first, toolTimeline: null })).toEqual([c.first]);
    });
  }
});

describe('the second ticket never touches call_logs.ticket_number', () => {
  it('no write-back, no lock, no ticket_number in anything written', async () => {
    const callSid = `CA${'b'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(`rt-${n}`, callSid);
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-79084' });
    await SyncAgentService.submitSimplifiedTicket(besideParams(callSid));
    await vi.waitFor(() => expect(h.sets.length).toBeGreaterThan(0));
    expect(h.claimTicketCreation).not.toHaveBeenCalled();
    expect(h.releaseTicketCreationLock).not.toHaveBeenCalled();
    for (const s of h.sets) {
      expect(Object.keys(s)).not.toContain('ticketNumber');
      expect(Object.keys(s)).not.toContain('ticket_number');
    }
  });
});

describe('it can never replace the call timeline', () => {
  it('appends to the entry found by CallSid even when the agent keyed it on its own call id', async () => {
    const callId = `openai-call-${n}`;
    const callSid = `CA${'c'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    const how = await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79088', kind: 'urgent-ringout' });
    expect(how).toBe('appended');
    expect(getAzulTimeline(callId)?.map((e) => e.tool)).toEqual(['escalate_to_human', 'create_ticket', SECOND_TICKET_TOOL]);
    expect(lastTimelineWritten()?.events).toHaveLength(3);
  });

  it('a retry of the same ticket is recorded once', async () => {
    const callId = `openai-call-${n}`;
    const callSid = `CA${'d'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-82149', kind: 'urgent-ringout' })).toBe('appended');
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-82149', kind: 'urgent-ringout' })).toBe('already_there');
    expect(getAzulTimeline(callId)?.filter((e) => e.tool === SECOND_TICKET_TOOL)).toHaveLength(1);
  });

  it('with no entry in this process it APPENDS to the row in SQL, and only where the row lacks it', async () => {
    const callSid = `CA${'e'.repeat(28)}${String(1000 + n)}`;
    const how = await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79088', kind: 'urgent-ringout' });
    expect(how).toBe('appended_to_row');
    // It opened no entry, so a later flush cannot write a one-event timeline.
    expect(getAzulTimeline(callSid)).toBeNull();

    const set = h.sets[h.sets.length - 1];
    const timeline = render(set.toolTimeline);
    expect(timeline.sql).toContain('jsonb_set');
    expect(timeline.sql).toContain('||');
    expect(timeline.sql).toContain(`-> 'events'`);
    const event = JSON.parse(String(timeline.params[0]));
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({ tool: SECOND_TICKET_TOOL, args: { reason: 'urgent-ringout' }, outcome: { success: true, ticket_number: 'VA-79088' } });
    expect(render(set.toolCallCount).sql).toContain('+ 1');

    const where = render(h.wheres[h.wheres.length - 1]);
    expect(where.sql).toContain('"call_sid" = $1');
    expect(where.sql).toMatch(/NOT \(COALESCE\(.*-> 'events', '\[\]'::jsonb\) @> \$2::jsonb\)/);
    expect(where.params[0]).toBe(callSid);
    expect(JSON.parse(String(where.params[1]))).toEqual([{ tool: SECOND_TICKET_TOOL, outcome: { ticket_number: 'VA-79088' } }]);
  });

  it('a row that already holds it, or is not open, answers no_row and writes nothing else', async () => {
    h.rows = 0;
    const callSid = `CA${'f'.repeat(28)}${String(1000 + n)}`;
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79088', kind: 'urgent-ringout' }, { retryDelaysMs: [] })).toBe('no_row');
  });

  // Codex P2 on #473: the filing fires this and forgets it, so a row not open
  // yet lost the only copy of the event. It now tries again while the row opens.
  it('a row that is not open yet is tried again, and the event lands once it opens', async () => {
    h.rows = 0;
    const callSid = `CA${'2'.repeat(28)}${String(1000 + n)}`;
    const waits: number[] = [];
    const before = h.sets.length;
    const how = await recordSecondTicketOnTheCall(
      { callSid, ticketNumber: 'VA-79090', kind: 'urgent-transfer' },
      {
        retryDelaysMs: [5, 7, 11],
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) h.rows = 1; // the row opens during the second wait
        },
      },
    );
    expect(how).toBe('appended_to_row');
    expect(waits).toEqual([5, 7]);
    expect(h.sets.length - before).toBe(3);
  });

  it('stops trying after the last wait and says the event is not on the log', async () => {
    h.rows = 0;
    const callSid = `CA${'3'.repeat(28)}${String(1000 + n)}`;
    const waits: number[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const how = await recordSecondTicketOnTheCall(
      { callSid, ticketNumber: 'VA-79091', kind: 'urgent-ringout' },
      { retryDelaysMs: [1, 2], sleep: async (ms) => void waits.push(ms) },
    );
    expect(how).toBe('no_row');
    expect(waits).toEqual([1, 2]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not on the call log'))).toBe(true);
    warn.mockRestore();
  });

  it('the retry covers about two minutes, and a recorded event is never retried', async () => {
    expect(SECOND_TICKET_RETRY_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(120_000);
    const callSid = `CA${'4'.repeat(28)}${String(1000 + n)}`;
    const waits: number[] = [];
    const how = await recordSecondTicketOnTheCall(
      { callSid, ticketNumber: 'VA-79092', kind: 'urgent-ringout' },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(how).toBe('appended_to_row');
    expect(waits).toEqual([]);
  });
});

describe('a second ticket held in memory is not reported until it is on the row (Codex P2 on #473)', () => {
  it('a flush that touched no row answers no_row, is tried again, and lands once with the row open', async () => {
    const callId = `openai-call-${n}`;
    const callSid = `CA${'5'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    h.rows = 0;
    const waits: number[] = [];
    const how = await recordSecondTicketOnTheCall(
      { callSid, ticketNumber: 'VA-79093', kind: 'urgent-ringout' },
      {
        retryDelaysMs: [5, 7, 11],
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) h.rows = 1; // the row opens during the second wait
        },
      },
    );
    expect(how).toBe('appended');
    expect(waits).toEqual([5, 7]);
    expect(getAzulTimeline(callId)?.filter((e) => e.tool === SECOND_TICKET_TOOL)).toHaveLength(1);
    expect(lastTimelineWritten()?.events.filter((e) => e.tool === SECOND_TICKET_TOOL)).toHaveLength(1);
    // Now on the row, a repeat is already there and writes nothing more.
    const before = h.sets.length;
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79093', kind: 'urgent-ringout' })).toBe('already_there');
    expect(h.sets.length).toBe(before);
  });

  it('a database that throws on the flush is not reported as appended, and the event is held once', async () => {
    const callId = `openai-call-${n}`;
    const callSid = `CA${'6'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    h.updateThrows = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waits: number[] = [];
    const how = await recordSecondTicketOnTheCall(
      { callSid, ticketNumber: 'VA-79094', kind: 'urgent-ringout' },
      { retryDelaysMs: [1, 2], sleep: async (ms) => void waits.push(ms) },
    );
    expect(how).toBe('no_row');
    expect(waits).toEqual([1, 2]);
    expect(getAzulTimeline(callId)?.filter((e) => e.tool === SECOND_TICKET_TOOL)).toHaveLength(1);
    // The database recovers: a later try writes it, still once.
    h.updateThrows = false;
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79094', kind: 'urgent-ringout' }, { retryDelaysMs: [] })).toBe('appended');
    expect(getAzulTimeline(callId)?.filter((e) => e.tool === SECOND_TICKET_TOOL)).toHaveLength(1);
    err.mockRestore();
    warn.mockRestore();
  });
});

describe('it never costs the filing anything', () => {
  it('a database that throws still leaves the second ticket filed and reported', async () => {
    h.updateThrows = true;
    const callSid = `CA${'1'.repeat(28)}${String(1000 + n)}`;
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-79084' });
    const r = await SyncAgentService.submitSimplifiedTicket(besideParams(callSid));
    expect(r).toMatchObject({ success: true, ticketNumber: 'VA-79084' });
    expect(await recordSecondTicketOnTheCall({ callSid, ticketNumber: 'VA-79084', kind: 'urgent-ringout' })).toBe('failed');
  });

  it('control: an ordinary filing puts no second-ticket event anywhere', async () => {
    const callId = `rt-${n}`;
    const callSid = `CA${'2'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    h.claimTicketCreation.mockResolvedValue({ claimed: true });
    h.submitTicket.mockResolvedValue({ success: true, ticketNumber: 'VA-79083' });
    const { secondTicketOnThisCall: _drop, ...ordinary } = besideParams(callSid);
    const r = await SyncAgentService.submitSimplifiedTicket(ordinary);
    expect(r).toMatchObject({ success: true, ticketNumber: 'VA-79083' });
    await new Promise((r) => setTimeout(r, 10));
    expect(getAzulTimeline(callId)?.some((e) => e.tool === SECOND_TICKET_TOOL)).toBe(false);
    expect(h.sets).toHaveLength(0);
  });

  it('control: a second filing the app refused records nothing', async () => {
    const callId = `rt-${n}`;
    const callSid = `CA${'3'.repeat(28)}${String(1000 + n)}`;
    seedAgentTimeline(callId, callSid);
    h.submitTicket.mockResolvedValue({ success: false, error: 'synthetic refusal' });
    const r = await SyncAgentService.submitSimplifiedTicket(besideParams(callSid));
    expect(r.success).toBe(false);
    await new Promise((r2) => setTimeout(r2, 10));
    expect(getAzulTimeline(callId)?.some((e) => e.tool === SECOND_TICKET_TOOL)).toBe(false);
  });
});
