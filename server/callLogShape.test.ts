/**
 * THE CALL LOG THE API RETURNS CARRIES EVERY TICKET THE CALL CREATED (v223).
 *
 * `normalizeCallLog` is the one shape every call-log route answers with, so
 * the field is proven here and the routes are pinned to it by reading
 * server/routes.ts: the route file opens the database and the session store
 * at import, and a test of the helper alone would stay green with a route
 * that stopped calling it (the sink-not-the-source mistake).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeCallLog } from './callLogShape';

describe('normalizeCallLog', () => {
  it("adds ticketNumbers, the row's own first, and leaves ticketNumber as it was", () => {
    // CAace420201db71490a3e6fe8f00bd4948 (pcp, 2026-11-06): the row held
    // VA-82027 and the call's handoff filed PCP-82028 beside it.
    const out = normalizeCallLog({
      id: 'row-1',
      callSid: 'CAace420201db71490a3e6fe8f00bd4948',
      ticketNumber: 'VA-82027',
      toolTimeline: {
        events: [
          { tool: 'create_pcp_task', outcome: { success: true, ticketNumber: 'VA-82027' } },
          { tool: 'handoff_to_pcp', outcome: { success: false, ticketNumber: 'PCP-82028' } },
        ],
      },
    });
    expect(out.ticketNumber).toBe('VA-82027');
    expect(out.ticketNumbers).toEqual(['VA-82027', 'PCP-82028']);
  });

  it('reads a snake_case row the same way', () => {
    const out = normalizeCallLog({
      ticket_number: 'VA-79083',
      tool_timeline: { events: [{ tool: 'second_ticket_filed', outcome: { success: true, ticket_number: 'VA-79084' } }] },
    });
    expect(out.ticketNumber).toBe('VA-79083');
    expect(out.ticketNumbers).toEqual(['VA-79083', 'VA-79084']);
  });

  it('a call with no ticket answers an empty list, never undefined', () => {
    expect(normalizeCallLog({ id: 'x' }).ticketNumbers).toEqual([]);
  });
});

describe('every call-log route answers through it', () => {
  const routes = readFileSync(path.resolve(__dirname, 'routes.ts'), 'utf8');

  it('routes.ts imports the shape and keeps no copy of its own', () => {
    expect(routes).toContain("import { normalizeCallLog } from './callLogShape';");
    expect(routes).not.toMatch(/function normalizeCallLog\s*\(/);
  });

  it('the list, the urgent list, the voicemail list, one call and the call page', () => {
    expect(routes).toContain('data: result.data.map(normalizeCallLog)');
    expect(routes).toContain('data: urgentCalls.map(normalizeCallLog)');
    expect(routes).toContain('const normalized = urgentCalls.map(normalizeCallLog)');
    expect(routes).toContain('data: voicemails.map(normalizeCallLog)');
    expect(routes).toContain('res.json(normalizeCallLog(callLog))');
    expect(routes).toContain('callLog: normalizeCallLog(callLog)');
  });

  it("the urgent CSV writes every ticket, not the row's alone", () => {
    expect(routes).toContain("csvEscape(call.ticketNumbers.join('; '))");
    expect(routes).not.toContain('csvEscape(call.ticketNumber)');
  });
});
