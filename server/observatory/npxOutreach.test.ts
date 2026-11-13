/**
 * GET /api/npx-outreach/tracking, through the route as production mounts it,
 * with the Hub replaced by a fake pool (vi.mock('../db')): the default reader
 * is the one under test, so the SQL it sends, the parameters and their casts,
 * and the mapping back are all exercised. Synthetic patients only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express, RequestHandler } from 'express';

const calls: Array<{ text: string; params: unknown[] }> = [];
let campaignRows: Record<string, unknown>[] = [];
let contactRows: Record<string, unknown>[] = [];
let attemptRows: Record<string, unknown>[] = [];
let failWith: Error | null = null;

vi.mock('../db', () => ({
  db: {},
  pool: {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (failWith) throw failWith;
      if (text.includes('FROM campaigns')) return { rows: campaignRows };
      if (text.includes('FROM campaign_contacts c')) return { rows: contactRows };
      if (text.includes('FROM campaign_contact_attempts a')) return { rows: attemptRows };
      throw new Error('unexpected statement');
    },
  },
}));

import { requireAuth } from '../auth';
import {
  ATTEMPTS_SQL,
  CAMPAIGN_SQL,
  CONTACTS_SQL,
  mountNpxOutreachTracking,
  readTrackingQuery,
  toRawAttempt,
  toRawContact,
} from './npxOutreach';
import { CANCEL_LANDED_PHRASE } from './npxOutreach.logic';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const PATH = '/api/npx-outreach/tracking';

function boot() {
  const routes: Record<string, RequestHandler[]> = {};
  const app = {
    get: (path: string, ...handlers: RequestHandler[]) => {
      routes[`GET ${path}`] = handlers;
    },
  } as unknown as Express;
  mountNpxOutreachTracking(app, { authenticate: requireAuth as unknown as RequestHandler, now: () => NOW });
  async function request(query: Record<string, string> = {}, signedIn = true) {
    const req = { session: signedIn ? { userId: 'staff-id' } : {}, query, headers: {} };
    const result = { status: 200, body: undefined as any, headers: new Headers() };
    const res = {
      status(code: number) {
        result.status = code;
        return res;
      },
      json(value: unknown) {
        result.body = value;
        return res;
      },
      setHeader(name: string, value: string) {
        result.headers.set(name, value);
      },
    };
    async function run(index: number): Promise<void> {
      const handler = routes[`GET ${PATH}`][index];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as never, res as never, () => {
        next = run(index + 1);
      });
      await next;
    }
    await run(0);
    return result;
  }
  return { request, routes };
}

beforeEach(() => {
  calls.length = 0;
  failWith = null;
  campaignRows = [{ id: 'camp-live', name: 'npx-outreach' }];
  contactRows = [
    {
      id: 'c1',
      first_name: 'Testa',
      last_name: 'Synthetic',
      phone_last4: '5551',
      status: 'completed',
      agent_notes: 'npx_booking:npx-1',
      next_attempt_at: null,
      event_name: 'Comprehensive Exam',
      appointment_date: '2041-02-20',
      begin_time: '0930',
      office: 'Test Office',
      text_state: 'sent',
      text_sent_at: '2026-11-12T17:00:00.000Z',
      text_claimed_at: null,
      text_reason: null,
      dob_tries: '1',
      verified_at: null,
      link_booked_at: null,
      link_booking_id: null,
      sms_stop_at: null,
      voice_opt_out_at: null,
    },
    {
      id: 'c2',
      first_name: 'Testo',
      last_name: 'Synthetic',
      phone_last4: '5552',
      status: 'do_not_call',
      agent_notes: null,
      next_attempt_at: null,
      event_name: 'Dilated Eye Exam',
      appointment_date: '2041-03-01',
      begin_time: '1400',
      office: 'Test Office',
      text_state: null,
      text_sent_at: null,
      text_claimed_at: null,
      text_reason: null,
      dob_tries: null,
      verified_at: null,
      link_booked_at: null,
      link_booking_id: null,
      // node-postgres hands a timestamptz back as a Date
      sms_stop_at: new Date('2026-11-13T16:00:00.000Z'),
      voice_opt_out_at: null,
    },
  ];
  attemptRows = [
    {
      id: 'a1',
      contact_id: 'c1',
      direction: 'outbound',
      status: 'completed',
      answered_by: 'human',
      duration: 140,
      call_sid: 'CA00000000000000000000000000000001',
      attempted_at: new Date('2026-11-13T17:00:00.000Z'),
      call_log_id: 'log-1',
      runtime_outcome: 'agent_ended',
      caller_spoke: true,
      booking_at: '2026-11-13T17:01:30.000Z',
      booking_say: `You're booked. ${CANCEL_LANDED_PHRASE} on Friday.`,
      staff_at: null,
      staff_ticket: null,
    },
  ];
});

describe('the tracking route', () => {
  it('needs a signed-in session', async () => {
    const r = await boot().request({}, false);
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('reads the live campaign by default, then its contacts and attempts, with every parameter cast', async () => {
    const r = await boot().request();
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(calls.map((c) => c.text)).toEqual([CAMPAIGN_SQL, CONTACTS_SQL, ATTEMPTS_SQL]);
    expect(calls[0].params).toEqual(['npx-outreach']);
    expect(calls[1].params).toEqual(['camp-live']);
    expect(calls[2].params).toEqual(['camp-live', 'book_sooner_exam', 'request_staff_callback']);
    for (const { text } of calls) {
      // node-postgres sends parameters untyped; every one is cast (v52).
      expect(text.match(/\$\d(?!::)/g)).toBeNull();
    }
    expect(r.body.campaign).toEqual({ key: 'live', name: 'npx-outreach', found: true });
    expect(r.body.generatedAt).toBe(NOW.toISOString());
    expect(r.body.totals).toMatchObject({
      onList: 2,
      called: 1,
      answeredByPerson: 1,
      textsSent: 1,
      linkDobTried: 1,
      bookedByPhone: 1,
      cancelLanded: 1,
      optedOut: 1,
      optedOutSms: 1,
      // c2 is do_not_call because of its STOP, not a voice opt-out
      optedOutVoice: 0,
    });
    const booked = r.body.contacts.find((c: any) => c.id === 'c1');
    expect(booked.booking).toEqual({ id: 'npx-1', by: 'phone', at: '2026-11-13T17:01:30.000Z', cancel: 'landed', callLogId: 'log-1' });
    expect(booked.attempts[0]).toMatchObject({ callLogId: 'log-1', label: 'Answered', durationSec: 140, booked: true });
  });

  it('reads the demo campaign when asked, and an unknown value is the live one', async () => {
    const h = boot();
    await h.request({ campaign: 'demo' });
    expect(calls[0].params).toEqual(['npx-outreach-demo']);
    calls.length = 0;
    await h.request({ campaign: 'production' });
    expect(calls[0].params).toEqual(['npx-outreach']);
  });

  it('answers an empty screen when the campaign row does not exist yet', async () => {
    campaignRows = [];
    const r = await boot().request({ campaign: 'demo' });
    expect(r.status).toBe(200);
    expect(r.body.campaign).toEqual({ key: 'demo', name: 'npx-outreach-demo', found: false });
    expect(r.body.totals.onList).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('applies the day filter', async () => {
    const r = await boot().request({ day: 'yesterday' });
    expect(r.body.day).toEqual({ key: 'yesterday', date: '2026-11-12' });
    expect(r.body.totals.called).toBe(0);
    expect(r.body.totals.textsSent).toBe(1);
    expect(r.body.contacts.map((c: any) => c.id)).toEqual(['c1']);
  });

  it('fails with a 500 that names no row', async () => {
    failWith = new Error('relation "campaigns" does not exist');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await boot().request();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ message: 'NPX outreach tracking failed' });
    spy.mockRestore();
  });
});

describe('what the statements select', () => {
  it('never selects a date of birth, the full phone, the transcript text or the link hashes', () => {
    const all = `${CONTACTS_SQL}\n${ATTEMPTS_SQL}`;
    expect(all).not.toMatch(/date_of_birth|patient_dob/);
    expect(all).not.toMatch(/token_hash|session_hash/);
    // The phone leaves only as its last four digits; the ten-digit form is
    // used inside the do-not-contact match and selected nowhere.
    const last4 = "right(regexp_replace(coalesce(c.phone_number, ''), '[^0-9]', '', 'g'), 4) AS phone_last4";
    const dncMatch = "d.phone_key = right(regexp_replace(coalesce(c.phone_number, ''), '[^0-9]', '', 'g'), 10)";
    expect(CONTACTS_SQL).toContain(last4);
    expect(CONTACTS_SQL).toContain(dncMatch);
    // Take those two out and the phone number appears nowhere else.
    expect(CONTACTS_SQL.replace(last4, '').replace(dncMatch, '')).not.toContain('phone_number');
    // The transcript is read only to ask whether the caller spoke.
    const spoke = "(position('CALLER:' in coalesce(cl.transcript, '')) > 0) AS caller_spoke";
    expect(ATTEMPTS_SQL).toContain(spoke);
    expect(ATTEMPTS_SQL.replace(spoke, '')).not.toContain('transcript');
  });

  it('reads the campaign tables as UTC instants', () => {
    expect(CONTACTS_SQL).toContain("(c.next_attempt_at AT TIME ZONE 'UTC')");
    expect(ATTEMPTS_SQL).toContain("(a.attempted_at AT TIME ZONE 'UTC')");
  });
});

describe('the wiring', () => {
  it('server/routes.ts mounts the route behind the same session auth as the Observatory', async () => {
    // A route tested only through its own mount function proves the function,
    // not that the app serves it (failure mode 10).
    const { readFileSync } = await import('node:fs');
    const routes = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain("import { mountNpxOutreachTracking } from './observatory/npxOutreach';");
    expect(routes).toContain('mountNpxOutreachTracking(app, { authenticate: isAuthenticated });');
  });
});

describe('the row mapping', () => {
  it('reads strings, Dates, counts and booleans the way node-postgres returns them', () => {
    const c = toRawContact({ id: 7, status: null, dob_tries: '2', sms_stop_at: new Date('2026-11-13T16:00:00Z'), text_sent_at: 'garbage' });
    expect(c).toMatchObject({ id: '7', status: 'pending', dobTries: 2, smsStopAt: '2026-11-13T16:00:00.000Z', textSentAt: null });
    const a = toRawAttempt({ id: 'a', contact_id: 'c', direction: null, status: 'voicemail', caller_spoke: 't', duration: '31' });
    expect(a).toMatchObject({ direction: 'outbound', callerSpoke: true, durationSec: 31 });
    expect(toRawAttempt({ id: 'a', contact_id: 'c', caller_spoke: false }).callerSpoke).toBe(false);
  });

  it('reads the recorded Azul cancel, the confirmation and every ticket on the call', () => {
    const a = toRawAttempt({ id: 'a', contact_id: 'c', booking_azul_cancel: 'not_cancelled', call_ticket: 'VA-1', call_tickets: ['PCP-2', 'VA-1'] });
    expect(a).toMatchObject({ bookingAzulCancel: 'not_cancelled', tickets: ['VA-1', 'PCP-2'] });
    expect(toRawAttempt({ id: 'a', contact_id: 'c' }).tickets).toEqual([]);
    const c = toRawContact({ id: 7, confirmation_booking_id: 'npx-1', confirmation_cancel: 'pending' });
    expect(c).toMatchObject({ confirmationBookingId: 'npx-1', confirmationCancel: 'pending' });
  });

  it('the attempts read pulls the call log ticket and every ticket number in the timeline', () => {
    expect(ATTEMPTS_SQL).toContain('cl.ticket_number AS call_ticket');
    expect(ATTEMPTS_SQL).toContain('AS tickets');
    expect(ATTEMPTS_SQL).toContain("e->'outcome'->>'azul_cancel'");
    expect(CONTACTS_SQL).toContain("->'confirmation'->>'cancel' AS confirmation_cancel");
  });

  it('reads the query strictly', () => {
    expect(readTrackingQuery({})).toEqual({ campaign: 'live', day: 'all' });
    expect(readTrackingQuery({ campaign: 'demo', day: 'today' })).toEqual({ campaign: 'demo', day: 'today' });
    expect(readTrackingQuery({ day: '2026-11-01' })).toEqual({ campaign: 'live', day: 'all' });
  });
});
