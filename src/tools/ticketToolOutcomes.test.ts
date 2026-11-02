/**
 * v166: each ticket-tool call is recorded for one `ticket_tool_summary`
 * call_events row — tool, verdict, field NAMES. Never a value. Synthetic data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
vi.mock('../../server/db', () => ({ db: {} }));

const { runTool, registerTool } = await import('./registry');
const {
  noteTicketToolOutcome,
  takeTicketToolOutcomes,
  ticketToolEvent,
  verdictFor,
  resetTicketToolOutcomes,
} = await import('./ticketToolOutcomes');

const SID = 'CA0123456789abcdef0123456789abcd01';

beforeEach(() => resetTicketToolOutcomes());

describe('verdictFor', () => {
  it('names a refusal by its fields, a filing by its number', () => {
    expect(verdictFor({ success: false, missingFields: ['requester'], message: 'x' })).toEqual({
      verdict: 'validation_error',
      fields: ['requester'],
    });
    expect(verdictFor({ success: true, ticket_number: 'VA-1' })).toEqual({ verdict: 'ok' });
    expect(verdictFor({ success: true, filed_pending: true })).toEqual({ verdict: 'filed_pending' });
    expect(verdictFor({ success: false, error: 'boom' })).toEqual({ verdict: 'failed' });
    expect(verdictFor({ success: false, error: 'x' }, true)).toEqual({ verdict: 'timeout' });
  });
});

describe('the 70298 shape: four requester refusals, then nothing', () => {
  it('records each refusal with the field name and the argument NAMES only', () => {
    const input = {
      call_sid: SID,
      first_name: 'Synthia',
      last_name: 'Example',
      callback_number: '5555550142',
      request_description: 'confirm the time of my appointment',
      requester_type: 'patient',
    };
    for (let i = 0; i < 4; i++) {
      noteTicketToolOutcome('file_records_ticket', input, {
        success: false,
        missingFields: ['requester'],
        message: 'are you the patient yourself?',
      });
    }
    const list = takeTicketToolOutcomes(SID);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({
      tool: 'file_records_ticket',
      verdict: 'validation_error',
      fields: ['requester'],
      args: ['callback_number', 'first_name', 'last_name', 'request_description', 'requester_type'],
      ticket: false,
    });
    // No value anywhere in what would be written.
    const written = JSON.stringify(ticketToolEvent(list));
    for (const value of ['Synthia', 'Example', '5555550142', 'confirm the time', 'patient yourself', SID]) {
      expect(written).not.toContain(value);
    }
    expect(ticketToolEvent(list)).toMatchObject({ level: 'warn', data: { filed: false, refusals: 4 } });
    // Taken once.
    expect(takeTicketToolOutcomes(SID)).toEqual([]);
  });

  it('a filed call is info level', () => {
    noteTicketToolOutcome('file_tech_ticket', { call_sid: SID }, { success: true, ticket_number: 'VA-2' });
    expect(ticketToolEvent(takeTicketToolOutcomes(SID))).toMatchObject({ level: 'info', data: { filed: true } });
  });

  it('ignores other tools and sentinel call ids', () => {
    noteTicketToolOutcome('lookup_patient', { call_sid: SID }, { success: true });
    noteTicketToolOutcome('file_tech_ticket', { call_sid: 'unknown' }, { success: true });
    expect(takeTicketToolOutcomes(SID)).toEqual([]);
    expect(takeTicketToolOutcomes('unknown')).toEqual([]);
  });
});

describe('runTool records the outcome', () => {
  it('a handler refusal and a validateInput refusal are both recorded', async () => {
    registerTool({
      name: 'send_records_form',
      description: 'test double',
      layer: 'agent',
      timeoutMs: 1_000,
      input_schema: {
        type: 'object',
        properties: { channel: { type: 'string', description: 'x' } },
        required: ['channel'],
      },
      handler: async () => ({ success: false, missingFields: ['email'], message: 'which email?' }),
    });
    await runTool('send_records_form', { call_sid: SID });
    await runTool('send_records_form', { call_sid: SID, channel: 'email' });
    const list = takeTicketToolOutcomes(SID);
    expect(list.map((o) => o.verdict)).toEqual(['validation_error', 'validation_error']);
    expect(list.map((o) => o.fields)).toEqual([['channel'], ['email']]);
  });

  it('wiring: the registry notes the outcome on both paths, and the runtime writes the row', () => {
    const registry = readFileSync(join(__dirname, 'registry.ts'), 'utf8');
    const body = registry.slice(registry.indexOf('export async function runTool'));
    expect(body).toMatch(/if \(bad\) \{\s*noteTicketToolOutcome\(name, input, bad\);/);
    expect(body).toContain('noteTicketToolOutcome(name, input, result, { timedOut })');
    const runtime = readFileSync(join(__dirname, '..', 'runtime', 'voiceRuntime.ts'), 'utf8');
    expect(runtime).toContain('options.logTicketTools ?? logTicketToolOutcomes');
    expect(runtime).toMatch(/const ticketToolsWritten = logTicketTools\(/);
  });
});
