/**
 * EVERY TICKET A CALL CREATED, as the Observatory's call log shows it (v223).
 *
 * THE CORPUS: the 15 calls in the 14 days to 2026-11-13 that carried two
 * agent tickets under their own call SID (Support Center, agent provenance,
 * canonical SIDs). The SIDs and ticket numbers are real; the tool timelines
 * below are synthetic stand-ins in the shapes the Hub's `tool_timeline`
 * actually held for each (the tools that reported a number, read from the
 * Hub). No PHI is on a timeline: the allow-list keeps tool names and outcome
 * fields only.
 *
 * 12 of the 15 carried the second number in their timeline already (PCP
 * filing tools report it); this helper is what shows it. The other 3 are
 * after-hours ring-out records that only v223's `second_ticket_filed` event
 * puts on the timeline (src/services/aSecondTicketIsOnTheCall.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { ticketNumbersForCall, ticketSearchTerm, TICKET_NUMBER } from './callTicketNumbers';

type Ev = { tool: string; outcome: Record<string, unknown> };
const ev = (tool: string, outcome: Record<string, unknown>): Ev => ({ tool, outcome });
const pcpTask = (n: string) => ev('create_pcp_task', { success: true, ticketNumber: n });
const handoff = (n: string, success = false) => ev('handoff_to_pcp', { success, ticketNumber: n });
const records = (n: string) => ev('handle_patient_medical_records_request', { success: true, ticketNumber: n });
const ringOut = (n: string) => ev('second_ticket_filed', { success: true, ticket_number: n });

/** [sid, row ticket, timeline events, every ticket the call created]. */
const CORPUS: Array<[string, string, Ev[], string[]]> = [
  ['CAd7ac62a663b157493ef7bbb137b0fe43', 'VA-79008', [pcpTask('VA-79007'), pcpTask('VA-79008')], ['VA-79008', 'VA-79007']],
  ['CAea209df12ff11e5c11d5b04bb3fce82d', 'PCP-78998', [pcpTask('PCP-78998'), pcpTask('PCP-78999')], ['PCP-78998', 'PCP-78999']],
  ['CA9d6b496f37a8c318d7b608d8afac0b58', 'PCP-79677', [pcpTask('PCP-79677'), handoff('PCP-79680')], ['PCP-79677', 'PCP-79680']],
  ['CAace420201db71490a3e6fe8f00bd4948', 'VA-82027', [pcpTask('VA-82027'), handoff('PCP-82028')], ['VA-82027', 'PCP-82028']],
  ['CA2b13aabe41c7a684b202f8675f4be1c8', 'PCP-81745', [pcpTask('PCP-81745'), pcpTask('PCP-81747')], ['PCP-81745', 'PCP-81747']],
  ['CAcb5f906a732d4b528274fa079f981d34', 'VA-82412', [pcpTask('VA-82410'), pcpTask('VA-82412')], ['VA-82412', 'VA-82410']],
  ['CAdcbfc920094e35659c6c44210fc1dbbe', 'VA-82577', [pcpTask('VA-82574'), records('VA-82577')], ['VA-82577', 'VA-82574']],
  ['CAc02f70570320a6e40d22a53d848befbe', 'VA-83461', [pcpTask('VA-83461'), handoff('PCP-83463')], ['VA-83461', 'PCP-83463']],
  ['CA058fffa730e6aec5fd51b6f596f493cf', 'VA-83710', [pcpTask('VA-83710'), handoff('PCP-83711')], ['VA-83710', 'PCP-83711']],
  ['CA10e63c67c3fe152f60300007509b7c5b', 'VA-84048', [pcpTask('VA-84048'), pcpTask('PCP-84054')], ['VA-84048', 'PCP-84054']],
  ['CA50d5d9c88dee11f0357e09dd1a96515f', 'VA-83991', [pcpTask('VA-83991'), handoff('PCP-83992')], ['VA-83991', 'PCP-83992']],
  ['CA11263df1d25fc2c78cb94cb1f2800350', 'PCP-84700', [pcpTask('PCP-84700'), pcpTask('PCP-84703')], ['PCP-84700', 'PCP-84703']],
  ['CA5ce9377f5c98d9233e8103b9b6e3f74b', 'VA-79083', [ev('create_ticket', { success: true, ticket_number: 'VA-79083' }), ringOut('VA-79084')], ['VA-79083', 'VA-79084']],
  ['CAac5dac2b9162bb8cdafa6ad1bbbf6c35', 'VA-79087', [ev('escalate_to_human', { success: false }), ringOut('VA-79088')], ['VA-79087', 'VA-79088']],
  ['CAbccc433f0627622f50d32ff4abd7cec8', 'VA-82148', [ev('create_ticket', { success: true, ticket_number: 'VA-82148' }), ringOut('VA-82149')], ['VA-82148', 'VA-82149']],
];

describe('the corpus: every call with two tickets shows both', () => {
  it.each(CORPUS)('%s', (_sid, row, events, expected) => {
    expect(ticketNumbersForCall({ ticketNumber: row, toolTimeline: { events } })).toEqual(expected);
  });

  it('before v223 the log showed one of the two on every one of the 15', () => {
    const shown = CORPUS.map(([, row]) => [row]);
    expect(shown.every((s) => s.length === 1)).toBe(true);
    expect(CORPUS.every(([, , , all]) => all.length === 2)).toBe(true);
  });
});

describe('ticketNumbersForCall', () => {
  it("puts the row's own ticket first, whatever order the timeline holds", () => {
    const tl = { events: [pcpTask('PCP-2'), pcpTask('PCP-1')] };
    expect(ticketNumbersForCall({ ticketNumber: 'PCP-1', toolTimeline: tl })).toEqual(['PCP-1', 'PCP-2']);
  });

  it('keeps each ticket once and the timeline in order', () => {
    const tl = { events: [pcpTask('PCP-3'), pcpTask('PCP-3'), pcpTask('PCP-4'), pcpTask('PCP-3')] };
    expect(ticketNumbersForCall({ toolTimeline: tl })).toEqual(['PCP-3', 'PCP-4']);
  });

  it('reads both outcome spellings, snake and camel', () => {
    const tl = { events: [ev('create_ticket', { ticket_number: 'VA-1' }), ev('create_pcp_task', { ticketNumber: 'PCP-2' })] };
    expect(ticketNumbersForCall({ toolTimeline: tl })).toEqual(['VA-1', 'PCP-2']);
  });

  it('counts a filing that answered success:false with a ticket (a failed transfer that filed)', () => {
    const tl = { events: [handoff('PCP-9', false)] };
    expect(ticketNumbersForCall({ toolTimeline: tl })).toEqual(['PCP-9']);
  });

  it('never counts a ticket check_open_tickets READ', () => {
    const tl = { events: [ev('check_open_tickets', { success: true, ticket_number: 'VA-70001' })] };
    expect(ticketNumbersForCall({ ticketNumber: 'VA-5', toolTimeline: tl })).toEqual(['VA-5']);
  });

  it('ignores a value that is not a ticket number', () => {
    for (const bad of ['unknown', 'pending', 'va-123', 'VA-', '-123', 'VA 123', 'VA-12a', 42, null, true, {}]) {
      expect(ticketNumbersForCall({ toolTimeline: { events: [ev('create_ticket', { ticket_number: bad })] } })).toEqual([]);
    }
  });

  it('trims a ticket number', () => {
    expect(ticketNumbersForCall({ toolTimeline: { events: [pcpTask('  PCP-7 ')] } })).toEqual(['PCP-7']);
  });

  it("shows the row's number as written, as the column always did", () => {
    expect(ticketNumbersForCall({ ticketNumber: 'T-78690' })).toEqual(['T-78690']);
    expect(ticketNumbersForCall({ ticket_number: ' VA-1 ' })).toEqual(['VA-1']);
    expect(ticketNumbersForCall({ ticketNumber: '' })).toEqual([]);
    expect(ticketNumbersForCall({ ticketNumber: '   ' })).toEqual([]);
  });

  it('reads the snake_case row and a timeline stored as JSON text', () => {
    const log = { ticket_number: 'VA-10', tool_timeline: JSON.stringify({ events: [pcpTask('PCP-11')] }) };
    expect(ticketNumbersForCall(log)).toEqual(['VA-10', 'PCP-11']);
  });

  it('is total: no log, no timeline, a broken timeline, odd events', () => {
    expect(ticketNumbersForCall(null)).toEqual([]);
    expect(ticketNumbersForCall(undefined)).toEqual([]);
    expect(ticketNumbersForCall({})).toEqual([]);
    expect(ticketNumbersForCall({ ticketNumber: 'VA-1', toolTimeline: '{not json' })).toEqual(['VA-1']);
    expect(ticketNumbersForCall({ ticketNumber: 'VA-1', toolTimeline: { events: 'nope' } })).toEqual(['VA-1']);
    expect(ticketNumbersForCall({ ticketNumber: 'VA-1', toolTimeline: [pcpTask('PCP-2')] })).toEqual(['VA-1']);
    expect(
      ticketNumbersForCall({ toolTimeline: { events: [null, 7, 'x', { tool: 'create_pcp_task' }, { outcome: { ticketNumber: 'PCP-3' } }] } }),
    ).toEqual(['PCP-3']);
  });
});

describe('ticketSearchTerm', () => {
  it('upper-cases and trims a whole ticket number', () => {
    expect(ticketSearchTerm(' pcp-84703 ')).toBe('PCP-84703');
    expect(ticketSearchTerm('VA-79088')).toBe('VA-79088');
  });

  it('is null for every other search, so those queries do not change', () => {
    for (const t of ['Smith', '5551234567', '(555) 123-4567', 'VA-', 'VA', '84703', 'VA-12 PCP-3', '', '  ', undefined, null]) {
      expect(ticketSearchTerm(t as string)).toBeNull();
    }
  });

  it('uses the same shape the display does', () => {
    expect(TICKET_NUMBER.test('VA-1')).toBe(true);
    expect(TICKET_NUMBER.test('va-1')).toBe(false);
  });
});
