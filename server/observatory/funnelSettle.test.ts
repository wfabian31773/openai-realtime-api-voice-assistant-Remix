/**
 * The SAGE funnel's "Kept" stage once 5Star stopped settling bookings
 * (2026-10-21): past bookings 5Star left open are settled from the NextGen
 * schedule mirror by their appointment id, partner-clinic bookings from
 * 5Star's own partner fields, and anything neither can answer is counted as
 * unsettled, never as "not kept". The 5Star and Console databases are faked;
 * appointment ids are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fivestarCalls: Array<{ text: string; params: unknown[] }> = [];
const consoleCalls: Array<{ text: string; params: unknown[] }> = [];
let mainRows: Record<string, unknown>[] = [];
let stuckRows: Record<string, unknown>[] = [];
let mirrorRows: Record<string, unknown>[] = [];
let consoleConfigured = true;
let consoleFails: Error | null = null;

vi.mock('../db', () => ({ db: {}, pool: { query: async () => ({ rows: [] }) } }));
vi.mock('./fivestarDb', () => ({
  async fivestarQuery(text: string, params: unknown[] = []) {
    fivestarCalls.push({ text, params });
    if (text.includes('FROM weeks w')) return { rows: mainRows };
    if (text.includes('ib.partner_outcome_status')) return { rows: stuckRows };
    throw new Error('unexpected 5Star statement');
  },
}));
vi.mock('./consoleDb', () => ({
  isConsoleConfigured: () => consoleConfigured,
  async consoleQuery(text: string, params: unknown[] = []) {
    consoleCalls.push({ text, params });
    if (consoleFails) throw consoleFails;
    return { rows: mirrorRows };
  },
}));

import {
  MIRROR_FACTS_SQL,
  SETTLED_STATUSES,
  STUCK_BOOKINGS_SQL,
  mirrorIds,
  mirrorOutcome,
  partnerOutcome,
  settleStuckBookings,
  settleTheStuckBookings,
} from './funnelSettle';
import { sageFunnelWeekly } from './queries';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const E = 'eeeeeeee-0000-4000-8000-000000000005';

const fact = (id: string, isKept: boolean | null, isCancelled = false, isRescheduled = false) => ({
  appointmentId: id,
  isKept,
  isCancelled,
  isRescheduled,
});

beforeEach(() => {
  fivestarCalls.length = 0;
  consoleCalls.length = 0;
  mainRows = [];
  stuckRows = [];
  mirrorRows = [];
  consoleConfigured = true;
  consoleFails = null;
});

describe('one appointment, by the NextGen Bible §2 order', () => {
  it('kept wins over moved and cancelled', () => {
    expect(mirrorOutcome(fact(A, true, true, true))).toBe('kept');
  });
  it('a moved appointment that was not kept is unsettled, not a no-show', () => {
    expect(mirrorOutcome(fact(A, false, false, true))).toBe('unsettled');
  });
  it('a cancelled appointment is cancelled', () => {
    expect(mirrorOutcome(fact(A, false, true, false))).toBe('cancelled');
  });
  it('a past appointment never kept is a no-show', () => {
    expect(mirrorOutcome(fact(A, false))).toBe('no_show');
  });
  it('an unknown kept flag is unsettled', () => {
    expect(mirrorOutcome(fact(A, null))).toBe('unsettled');
  });
  it('an appointment the mirror does not hold is unsettled', () => {
    expect(mirrorOutcome(undefined)).toBe('unsettled');
  });
});

describe('a partner-clinic booking, from 5Star\'s partner fields', () => {
  const p = (partnerOutcome: string | null, partnerVisit: string | null = null) => ({
    weekStart: '2026-10-19',
    appointmentId: null,
    partnerOutcome,
    partnerVisit,
  });
  it('a completed visit or a report is kept', () => {
    expect(partnerOutcome(p('outcome_overdue', 'completed'))).toBe('kept');
    expect(partnerOutcome(p('partner_report_received'))).toBe('kept');
    expect(partnerOutcome(p('partner_reported_showed'))).toBe('kept');
  });
  it('a reported no-show or cancellation is that', () => {
    expect(partnerOutcome(p('partner_reported_no_show'))).toBe('no_show');
    expect(partnerOutcome(p('partner_reported_cancelled'))).toBe('cancelled');
  });
  it('anything still waiting is unsettled', () => {
    expect(partnerOutcome(p('in_partner_schedule'))).toBe('unsettled');
    expect(partnerOutcome(p('awaiting_partner_entry'))).toBe('unsettled');
    expect(partnerOutcome(p(null))).toBe('unsettled');
  });
});

describe('the stuck bookings of a week', () => {
  it('counts each outcome in its own week', () => {
    const out = settleStuckBookings(
      [
        { weekStart: '2026-10-19', appointmentId: A },
        { weekStart: '2026-10-19', appointmentId: B },
        { weekStart: '2026-10-19', appointmentId: C },
        { weekStart: '2026-10-26', appointmentId: D },
        { weekStart: '2026-10-26', appointmentId: null },
      ],
      [fact(A, true), fact(B, false), fact(C, false, true), fact(D, false, false, true)],
    );
    expect(out.get('2026-10-19')).toEqual({ kept: 1, noShow: 1, cancelled: 1, unsettled: 0 });
    expect(out.get('2026-10-26')).toEqual({ kept: 0, noShow: 0, cancelled: 0, unsettled: 2 });
  });
  it('an unread mirror leaves every booking with an id unsettled, never not kept', () => {
    const out = settleStuckBookings([{ weekStart: '2026-10-19', appointmentId: A }], null);
    expect(out.get('2026-10-19')).toEqual({ kept: 0, noShow: 0, cancelled: 0, unsettled: 1 });
  });
  it('matches the id without regard to case, on either side', () => {
    const out = settleStuckBookings([{ weekStart: '2026-10-19', appointmentId: A.toUpperCase() }], [fact(A, true)]);
    expect(out.get('2026-10-19')!.kept).toBe(1);
    const back = settleStuckBookings([{ weekStart: '2026-10-19', appointmentId: B }], [fact(B.toUpperCase(), true)]);
    expect(back.get('2026-10-19')!.kept).toBe(1);
  });
  it('sends only uuid-shaped ids to the mirror, once each', () => {
    expect(
      mirrorIds([
        { weekStart: 'w', appointmentId: A },
        { weekStart: 'w', appointmentId: A.toUpperCase() },
        { weekStart: 'w', appointmentId: 'NG-12345' },
        { weekStart: 'w', appointmentId: null },
      ]),
    ).toEqual([A]);
  });
});

describe('the reads it makes', () => {
  it('asks 5Star for past, open AI-voice bookings in the window', async () => {
    stuckRows = [];
    await settleTheStuckBookings(12, { fivestar: async (t, p) => (fivestarCalls.push({ text: t, params: p ?? [] }), { rows: [] }), console: null });
    expect(fivestarCalls[0].text).toBe(STUCK_BOOKINGS_SQL);
    expect(fivestarCalls[0].params).toEqual([12, [...SETTLED_STATUSES]]);
    expect(STUCK_BOOKINGS_SQL).toMatch(/ib\.slot_date < \(now\(\) AT TIME ZONE 'America\/Los_Angeles'\)::date/);
    expect(STUCK_BOOKINGS_SQL).toMatch(/ib\.status::text <> ALL\(\$2::text\[\]\)/);
    expect(STUCK_BOOKINGS_SQL).toMatch(/booked_by_name LIKE 'AI Voice Agent%'/);
    expect(SETTLED_STATUSES).toEqual(['completed', 'no_show', 'cancelled', 'pending_orphan_review']);
  });
  it('asks the mirror by primary key only, as uuids', () => {
    expect(MIRROR_FACTS_SQL).toMatch(/WHERE f\.appointment_id = ANY\(\$1::uuid\[\]\)/);
  });
  it('does not ask the mirror when no booking has an id', async () => {
    stuckRows = [{ week_start: '2026-10-19', appointment_id: null, partner_outcome: 'partner_report_received' }];
    const out = await settleTheStuckBookings(12, { fivestar: async () => ({ rows: stuckRows }), console: async () => { throw new Error('should not be asked'); } });
    expect(out.mirrorRead).toBe(true);
    expect(out.byWeek.get('2026-10-19')!.kept).toBe(1);
  });
  it('a Console not configured leaves the id bookings unsettled and says so', async () => {
    stuckRows = [{ week_start: '2026-10-19', appointment_id: A }];
    const out = await settleTheStuckBookings(12, { fivestar: async () => ({ rows: stuckRows }), console: null });
    expect(out.mirrorRead).toBe(false);
    expect(out.byWeek.get('2026-10-19')).toEqual({ kept: 0, noShow: 0, cancelled: 0, unsettled: 1 });
  });
  it('a mirror that fails leaves them unsettled, says so, and does not fail', async () => {
    stuckRows = [{ week_start: '2026-10-19', appointment_id: A }];
    const out = await settleTheStuckBookings(12, {
      fivestar: async () => ({ rows: stuckRows }),
      console: async () => {
        throw new Error('timeout');
      },
    });
    expect(out.mirrorRead).toBe(false);
    expect(out.byWeek.get('2026-10-19')!.unsettled).toBe(1);
  });
});

describe('the funnel as the screen reads it', () => {
  const week = (weekStart: string, over: Record<string, unknown> = {}) => ({
    week_start: weekStart,
    reached_calls: 10,
    reached_sms: 0,
    engaged_calls: 8,
    sms_clicks: 0,
    booked: 6,
    entered: 6,
    materialized: 4,
    kept: 0,
    cancelled: 1,
    no_show: 0,
    pending_review: 0,
    upcoming: 0,
    ...over,
  });

  it('adds what the mirror settles to 5Star\'s own counts, week by week', async () => {
    mainRows = [week('2026-10-12', { kept: 2 }), week('2026-10-19')];
    stuckRows = [
      { week_start: '2026-10-19', appointment_id: A },
      { week_start: '2026-10-19', appointment_id: B },
      { week_start: '2026-10-19', appointment_id: C },
      { week_start: '2026-10-19', appointment_id: D },
      { week_start: '2026-10-19', appointment_id: null },
      { week_start: '2026-10-19', appointment_id: null, partner_visit: 'completed' },
    ];
    mirrorRows = [
      { appointment_id: A, is_kept: true, is_cancelled: false, is_rescheduled: false },
      { appointment_id: B, is_kept: false, is_cancelled: false, is_rescheduled: false },
      { appointment_id: C, is_kept: false, is_cancelled: true, is_rescheduled: false },
      { appointment_id: D, is_kept: false, is_cancelled: false, is_rescheduled: true },
    ];
    const out = await sageFunnelWeekly(12);
    expect(out.mirrorRead).toBe(true);
    expect(out.weeks[0]).toMatchObject({ weekStart: '2026-10-12', kept: 2, keptFromSchedule: 0, unsettled: 0 });
    expect(out.weeks[1]).toMatchObject({
      weekStart: '2026-10-19',
      kept: 2,
      keptFromSchedule: 2,
      noShow: 1,
      cancelled: 2,
      unsettled: 2,
    });
    expect(consoleCalls).toHaveLength(1);
    expect(consoleCalls[0].params).toEqual([[A, B, C, D]]);
  });

  it('passes the not-due-yet count through', async () => {
    mainRows = [week('2026-11-23', { upcoming: 5 })];
    const out = await sageFunnelWeekly(12);
    expect(out.weeks[0].upcoming).toBe(5);
    expect(fivestarCalls[0].text).toMatch(
      /slot_date >= \(now\(\) AT TIME ZONE 'America\/Los_Angeles'\)::date[\s\S]*AS upcoming/,
    );
  });

  it('a Console not configured reads every id booking as unsettled', async () => {
    consoleConfigured = false;
    mainRows = [week('2026-10-19')];
    stuckRows = [{ week_start: '2026-10-19', appointment_id: A }];
    const out = await sageFunnelWeekly(12);
    expect(out.mirrorRead).toBe(false);
    expect(out.weeks[0]).toMatchObject({ kept: 0, unsettled: 1 });
    expect(consoleCalls).toHaveLength(0);
  });
});
