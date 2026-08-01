import { describe, it, expect, vi } from 'vitest';

// The module imports server/db at load time for the flush path; these tests
// exercise the pure recording/redaction/classification surface only.
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../shared/schema', () => ({ callLogs: {} }));

const mod = await import('./toolTimeline');
const { recordToolEvent, getAzulTimeline, classifyFleetCall, recordingExecute } = mod;

let n = 0;
const freshCall = () => `tt-test-${++n}`;

/**
 * D11 (2026-08-01). Until this change only azul recorded tool events, so on
 * 07-31 sixty answering-service calls promised the caller a callback with no
 * ticket behind it and nothing could say whether create_ticket had even been
 * attempted. These tests pin the two things that make fleet recording safe to
 * turn on: it must never persist PHI, and it must never change or break the
 * tool it wraps.
 */

const TICKET_ARGS = {
  department_id: 2,
  request_type_id: 7,
  request_reason_id: 3,
  priority: 'high',
  first_name: 'Paula',
  last_name: 'Kolterman',
  middle_initial: 'J',
  date_of_birth: '1952-08-29',
  callback_number: '+17605551234',
  email: 'paula@example.com',
  subject: 'Needs a refill on her drops',
  description: 'Caller says she is out of her glaucoma drops and her surgeon is Dr. Logan.',
  unresolved_info: 'caller does not know which office she was seen at',
};

describe('PHI discipline — the allow-list is the safety mechanism', () => {
  it('persists routing fields and NOT one identifier or free-text field', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, JSON.stringify({ success: true, ticket_number: 'T-1234' }), 12, {
      agentSlug: 'answering-service',
    });
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args).toMatchObject({ department_id: 2, request_type_id: 7, request_reason_id: 3, priority: 'high' });
    for (const banned of [
      'first_name', 'last_name', 'middle_initial', 'date_of_birth',
      'callback_number', 'email', 'subject', 'description', 'unresolved_info',
    ]) {
      expect(ev.args).not.toHaveProperty(banned);
    }
    // and nothing leaks through stringification either
    const blob = JSON.stringify(ev);
    for (const secret of ['Paula', 'Kolterman', '1952-08-29', '7605551234', 'glaucoma', 'Logan', 'paula@example.com']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('keeps the diagnostic signal as booleans instead of the caller\'s words', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, '{}', 1, { agentSlug: 'answering-service' });
    const [ev] = getAzulTimeline(callId)!;
    expect(ev.args.hasUnresolvedInfo).toBe(true);
    expect(ev.args.hasPatientName).toBe(true);
    expect(ev.args.hasCallbackNumber).toBe(true);
  });

  it('drops unknown argument keys by default, so a new tool leaks nothing', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'some_future_tool', { ssn: '123-45-6789', freeText: 'anything' }, '{}', 1, {
      agentSlug: 'answering-service',
    });
    expect(JSON.stringify(getAzulTimeline(callId))).not.toContain('123-45-6789');
  });

  it('records the ticket number — the field D11 actually turns on', () => {
    const callId = freshCall();
    recordToolEvent(callId, 'create_ticket', TICKET_ARGS, JSON.stringify({ success: true, ticket_number: 'T-9001' }), 5, {
      agentSlug: 'answering-service',
    });
    expect(getAzulTimeline(callId)![0].outcome).toMatchObject({ success: true, ticket_number: 'T-9001' });
  });

  it('records missing FIELD NAMES on a validation failure, not their values', () => {
    const callId = freshCall();
    recordToolEvent(
      callId, 'create_ticket', TICKET_ARGS,
      JSON.stringify({ success: false, validationError: true, missingFields: ['surgeon name'] }), 5,
      { agentSlug: 'answering-service' },
    );
    expect(getAzulTimeline(callId)![0].outcome.missingFields).toEqual(['surgeon name']);
  });
});

describe('classifyFleetCall — "promised and filed" vs "promised and did not"', () => {
  const ev = (tool: string, outcome: Record<string, unknown> = {}, args: Record<string, unknown> = {}) =>
    ({ at: '', tool, args, outcome, ms: 1 });

  it('reports a filed ticket with its number', () => {
    expect(classifyFleetCall([ev('classify_request'), ev('create_ticket', { success: true, ticket_number: 'T-1' })]))
      .toEqual({ purpose: 'Patient request', result: 'Ticket filed (T-1)' });
  });

  it('distinguishes an ATTEMPTED ticket that failed validation', () => {
    const r = classifyFleetCall([ev('create_ticket', { validationError: true, missingFields: ['surgeon name'] })]);
    expect(r.result).toContain('FAILED');
    expect(r.result).toContain('surgeon name');
  });

  it('flags the D11 shape: classified the request, then never filed', () => {
    expect(classifyFleetCall([ev('lookup_schedule'), ev('classify_request')]))
      .toEqual({ purpose: 'Patient request', result: 'Classified but NO ticket created' });
  });

  it('does not call a lookup-only call a failure', () => {
    expect(classifyFleetCall([ev('lookup_schedule')]).result).toBe('Answered from lookup, no ticket');
  });

  it('reports an escalation', () => {
    expect(classifyFleetCall([ev('escalate_to_human')]).purpose).toBe('Escalation');
  });

  it('reports a terminate reason', () => {
    expect(classifyFleetCall([ev('terminate_call', {}, { reason: 'ghost_call' })]).result).toContain('ghost_call');
  });

  it('says "No tools used" for an empty timeline rather than inventing a failure', () => {
    expect(classifyFleetCall([]).result).toBe('No tools used');
  });
});

describe('recordingExecute — telemetry must never break a call', () => {
  const ctx = (callId: string) => ({ callId, agentSlug: 'answering-service' });

  it('returns the tool\'s value unchanged and records it', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute(ctx(callId), 'create_ticket', async () => ({ success: true, ticket_number: 'T-7' }));
    await expect(wrapped(TICKET_ARGS)).resolves.toEqual({ success: true, ticket_number: 'T-7' });
    expect(getAzulTimeline(callId)![0].outcome).toMatchObject({ ticket_number: 'T-7' });
  });

  it('passes a string result straight through', async () => {
    const callId = freshCall();
    const wrapped = recordingExecute(ctx(callId), 'classify_request', async () => JSON.stringify({ department: 'Optical' }));
    await expect(wrapped({})).resolves.toBe('{"department":"Optical"}');
  });

  it('re-throws the tool\'s error unchanged, and still records the attempt', async () => {
    const callId = freshCall();
    const boom = new Error('ticketing API 500');
    const wrapped = recordingExecute(ctx(callId), 'create_ticket', async () => { throw boom; });
    await expect(wrapped(TICKET_ARGS)).rejects.toBe(boom);
    // The attempt is the point: a promised callback that died in the API is a
    // different D11 story from one the model never attempted.
    expect(getAzulTimeline(callId)![0].outcome.error).toBe('ticketing API 500');
  });

  it('survives an unserializable result rather than failing the tool', async () => {
    const callId = freshCall();
    const circular: any = {};
    circular.self = circular;
    const wrapped = recordingExecute(ctx(callId), 'lookup_schedule', async () => circular);
    await expect(wrapped({})).resolves.toBe(circular);
  });
});
