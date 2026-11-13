/**
 * server/observatory/npxOutreach.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NPX OUTREACH TRACKING SCREEN, the database half: three READ-ONLY
 * statements against the Hub and one authenticated route.
 *
 *   GET /api/npx-outreach/tracking?campaign=live|demo&day=all|today|yesterday
 *
 * Nothing here writes. No migration: every table read already exists
 * (campaigns, campaign_contacts, campaign_contact_attempts, do_not_contact,
 * call_logs). Measured on the Hub 2026-11-13: 602 live contacts and 864
 * attempts, so the statements read the whole campaign in one pass and need no
 * index.
 *
 * WHAT NEVER LEAVES THE DATABASE: the date of birth (never selected), the full
 * phone number (only its last four digits are selected; the do-not-contact
 * match is made in SQL on the ten digits), the transcript (only whether it
 * holds a CALLER: line), and the link's token and session hashes (only the
 * named outreach_text fields are selected). The booking confirmation's `say`
 * is read so the Azul cancel can be classified, and is not sent on.
 *
 * Every bound parameter is cast (`$1::varchar`): node-postgres sends them
 * untyped, the v52 lesson.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from 'express';
import {
  BOOK_TOOL,
  NPX_CAMPAIGN_NAMES,
  STAFF_TOOL,
  buildTracking,
  type DayKey,
  type NpxCampaignKey,
  type RawAttempt,
  type RawContact,
  type Tracking,
} from './npxOutreach.logic';

/** The one thing the reader needs from a pool. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const CAMPAIGN_SQL = `
SELECT id, name
  FROM campaigns
 WHERE name = $1::varchar
   AND campaign_type = 'runtime_outbound'
   AND deleted_at IS NULL
 ORDER BY created_at
 LIMIT 1`;

/**
 * One row per contact. The timestamps on campaign_contacts are `timestamp
 * WITHOUT time zone` written by NOW() in UTC, so they are read AT TIME ZONE
 * 'UTC' to come back as instants (store.ts does the same).
 */
export const CONTACTS_SQL = `
SELECT c.id,
       c.first_name,
       c.last_name,
       right(regexp_replace(coalesce(c.phone_number, ''), '[^0-9]', '', 'g'), 4) AS phone_last4,
       c.outreach_status::text AS status,
       c.agent_notes,
       (c.next_attempt_at AT TIME ZONE 'UTC') AS next_attempt_at,
       c.custom_data->>'event_name' AS event_name,
       c.custom_data->>'appointment_date' AS appointment_date,
       c.custom_data->>'begin_time' AS begin_time,
       c.custom_data->>'office' AS office,
       c.custom_data->'outreach_text'->>'state' AS text_state,
       c.custom_data->'outreach_text'->>'sent_at' AS text_sent_at,
       c.custom_data->'outreach_text'->>'claimed_at' AS text_claimed_at,
       c.custom_data->'outreach_text'->>'reason' AS text_reason,
       c.custom_data->'outreach_text'->>'dob_tries' AS dob_tries,
       c.custom_data->'outreach_text'->>'verified_at' AS verified_at,
       c.custom_data->'outreach_text'->>'booked_at' AS link_booked_at,
       c.custom_data->'outreach_text'->>'booking_id' AS link_booking_id,
       dnc.sms_stop_at,
       dnc.voice_opt_out_at
  FROM campaign_contacts c
  LEFT JOIN LATERAL (
    SELECT min(d.created_at) FILTER (WHERE d.source = 'sms_stop') AS sms_stop_at,
           min(d.created_at) FILTER (WHERE d.source <> 'sms_stop') AS voice_opt_out_at
      FROM do_not_contact d
     WHERE d.phone_key = right(regexp_replace(coalesce(c.phone_number, ''), '[^0-9]', '', 'g'), 10)
  ) dnc ON true
 WHERE c.campaign_id = $1::varchar`;

/**
 * One row per attempt, with the call it made. A call_logs row exists only
 * for a call that reached the runtime; a voicemail, a no-answer or a busy has
 * none. The timeline is unrolled here so only the two events the screen
 * needs leave the database, not the whole timeline.
 */
export const ATTEMPTS_SQL = `
SELECT a.id,
       a.contact_id,
       a.direction,
       a.status,
       a.answered_by,
       coalesce(a.duration, cl.duration) AS duration,
       a.call_sid,
       (a.attempted_at AT TIME ZONE 'UTC') AS attempted_at,
       cl.id AS call_log_id,
       cl.runtime_outcome,
       (position('CALLER:' in coalesce(cl.transcript, '')) > 0) AS caller_spoke,
       ev.booking_at,
       ev.booking_say,
       ev.staff_at,
       ev.staff_ticket
  FROM campaign_contact_attempts a
  LEFT JOIN call_logs cl ON cl.call_sid = a.call_sid
  LEFT JOIN LATERAL (
    SELECT max(e->>'at') FILTER (WHERE e->>'tool' = $2::text AND e->'outcome'->>'success' = 'true') AS booking_at,
           (array_agg(e->'outcome'->>'say' ORDER BY e->>'at' DESC)
              FILTER (WHERE e->>'tool' = $2::text AND e->'outcome'->>'success' = 'true'))[1] AS booking_say,
           max(e->>'at') FILTER (WHERE e->>'tool' = $3::text AND e->'outcome'->>'success' = 'true'
                                   AND coalesce(e->'outcome'->>'ticket_number', e->'outcome'->>'ticketNumber') IS NOT NULL) AS staff_at,
           (array_agg(coalesce(e->'outcome'->>'ticket_number', e->'outcome'->>'ticketNumber') ORDER BY e->>'at' DESC)
              FILTER (WHERE e->>'tool' = $3::text AND e->'outcome'->>'success' = 'true'
                        AND coalesce(e->'outcome'->>'ticket_number', e->'outcome'->>'ticketNumber') IS NOT NULL))[1] AS staff_ticket
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(cl.tool_timeline->'events') = 'array' THEN cl.tool_timeline->'events' ELSE '[]'::jsonb END
           ) e
  ) ev ON true
 WHERE a.campaign_id = $1::varchar
 ORDER BY a.attempted_at, a.id`;

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const instant = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** A contacts row as the logic reads it. Pure. */
export function toRawContact(r: Record<string, unknown>): RawContact {
  return {
    id: String(r.id),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    phoneLast4: str(r.phone_last4),
    status: String(r.status ?? 'pending'),
    agentNotes: str(r.agent_notes),
    nextAttemptAt: instant(r.next_attempt_at),
    eventName: str(r.event_name),
    appointmentDate: str(r.appointment_date),
    beginTime: str(r.begin_time),
    office: str(r.office),
    textState: str(r.text_state),
    textSentAt: instant(r.text_sent_at),
    textClaimedAt: instant(r.text_claimed_at),
    textReason: str(r.text_reason),
    dobTries: int(r.dob_tries),
    verifiedAt: instant(r.verified_at),
    linkBookedAt: instant(r.link_booked_at),
    linkBookingId: str(r.link_booking_id),
    smsStopAt: instant(r.sms_stop_at),
    voiceOptOutAt: instant(r.voice_opt_out_at),
  };
}

/** An attempts row as the logic reads it. Pure. */
export function toRawAttempt(r: Record<string, unknown>): RawAttempt {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    direction: String(r.direction ?? 'outbound'),
    status: String(r.status ?? ''),
    answeredBy: str(r.answered_by),
    durationSec: int(r.duration),
    callSid: str(r.call_sid),
    attemptedAt: instant(r.attempted_at),
    callLogId: str(r.call_log_id),
    runtimeOutcome: str(r.runtime_outcome),
    callerSpoke: r.caller_spoke === true || r.caller_spoke === 't',
    bookingAt: instant(r.booking_at),
    bookingSay: str(r.booking_say),
    staffAt: instant(r.staff_at),
    staffTicket: str(r.staff_ticket),
  };
}

export interface NpxOutreachReader {
  campaign(name: string): Promise<{ id: string; name: string } | null>;
  contacts(campaignId: string): Promise<RawContact[]>;
  attempts(campaignId: string): Promise<RawAttempt[]>;
}

export function createNpxOutreachReader(pool: Queryable): NpxOutreachReader {
  return {
    async campaign(name) {
      const { rows } = await pool.query(CAMPAIGN_SQL, [name]);
      return rows[0] ? { id: String(rows[0].id), name: String(rows[0].name) } : null;
    },
    async contacts(campaignId) {
      return (await pool.query(CONTACTS_SQL, [campaignId])).rows.map(toRawContact);
    },
    async attempts(campaignId) {
      return (await pool.query(ATTEMPTS_SQL, [campaignId, BOOK_TOOL, STAFF_TOOL])).rows.map(toRawAttempt);
    },
  };
}

export interface TrackingResponse extends Tracking {
  campaign: { key: NpxCampaignKey; name: string; found: boolean };
  generatedAt: string;
}

const DAY_KEYS: readonly DayKey[] = ['all', 'today', 'yesterday'];

/** The query string, read strictly: anything unknown is the default. */
export function readTrackingQuery(q: Record<string, unknown>): { campaign: NpxCampaignKey; day: DayKey } {
  const campaign = q.campaign === 'demo' ? 'demo' : 'live';
  const day = DAY_KEYS.includes(q.day as DayKey) ? (q.day as DayKey) : 'all';
  return { campaign, day };
}

export async function trackingFor(
  reader: NpxOutreachReader,
  query: { campaign: NpxCampaignKey; day: DayKey },
  now: Date,
): Promise<TrackingResponse> {
  const name = NPX_CAMPAIGN_NAMES[query.campaign];
  const found = await reader.campaign(name);
  const generatedAt = now.toISOString();
  if (!found) {
    return {
      campaign: { key: query.campaign, name, found: false },
      generatedAt,
      ...buildTracking({ contacts: [], attempts: [] }, { day: query.day, now }),
    };
  }
  const [contacts, attempts] = await Promise.all([reader.contacts(found.id), reader.attempts(found.id)]);
  return {
    campaign: { key: query.campaign, name: found.name, found: true },
    generatedAt,
    ...buildTracking({ contacts, attempts }, { day: query.day, now }),
  };
}

async function defaultReader(): Promise<NpxOutreachReader> {
  const { pool } = await import('../db');
  return createNpxOutreachReader(pool as unknown as Queryable);
}

/** Mount behind the same session auth as the other Observatory routes. */
export function mountNpxOutreachTracking(
  app: Express,
  deps: { authenticate: RequestHandler; reader?: () => Promise<NpxOutreachReader>; now?: () => Date },
): void {
  const reader = deps.reader ?? defaultReader;
  const now = deps.now ?? (() => new Date());
  app.get('/api/npx-outreach/tracking', deps.authenticate, async (req, res) => {
    // Names and appointments: never cached by a browser or a proxy.
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await trackingFor(await reader(), readTrackingQuery(req.query as Record<string, unknown>), now()));
    } catch (error) {
      // The message only: a Postgres error names the statement, never a row.
      console.error('[npx-outreach] tracking failed:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ message: 'NPX outreach tracking failed' });
    }
  });
}
