import { describe, expect, it } from 'vitest';
import { answeredWithoutTicket } from './answeredCallDisposition';

const answered = { success: true, ticketCreated: false, callbackRequired: false };

describe('answeredWithoutTicket', () => {
  it('keeps the disposition when the agent hangs up after recording it', () => {
    expect(answeredWithoutTicket({
      events: [
        { tool: 'lookup_schedule', outcome: {} },
        { tool: 'record_answered_question', outcome: answered },
        { tool: 'emit_decision', outcome: { success: true } },
        { tool: 'terminate_call', outcome: { success: true }, args: { reason: 'completed' } },
      ],
    })).toBe(true);
    expect(answeredWithoutTicket({
      events: [
        { tool: 'create_ticket', outcome: answered },
        { tool: 'set_spoken_language', outcome: { success: true } },
        { tool: 'end_call', outcome: { success: true } },
      ],
    })).toBe(true);
  });

  it('does not waive a later failed filing or a new lookup after the disposition', () => {
    expect(answeredWithoutTicket({
      events: [
        { tool: 'record_answered_question', outcome: answered },
        { tool: 'lookup_schedule', outcome: {} },
      ],
    })).toBe(false);
    expect(answeredWithoutTicket({
      events: [
        { tool: 'create_ticket', outcome: answered },
        { tool: 'create_ticket', outcome: { success: false } },
      ],
    })).toBe(false);
    expect(answeredWithoutTicket({
      events: [
        { tool: 'record_answered_question', outcome: answered },
        { tool: 'escalate_to_human', outcome: {} },
      ],
    })).toBe(false);
  });
});
