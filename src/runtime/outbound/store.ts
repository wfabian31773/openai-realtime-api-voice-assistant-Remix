/**
 * src/runtime/outbound/store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Every database read and write the outbound layer makes, behind one
 * interface so the dialer, the webhooks and the scheduler are tested against
 * an in-memory fake (./store.fake.ts) and never against the Hub.
 *
 * TABLES (Operations Hub):
 *   campaigns                  one row per campaign, campaign_type =
 *                              'runtime_outbound', found by name
 *   campaign_contacts          one row per person to call; `external_ref`
 *                              (added here) makes an import idempotent
 *   campaign_contact_attempts  one row per dial
 *   do_not_contact             NEW: one row per phone number that asked not
 *                              to be called, phone-wide, every campaign
 *
 * The first three predate this layer (the old core's campaign executor).
 * `external_ref` and `do_not_contact` are created on first use with
 * IF NOT EXISTS, the call_events pattern: this ships as code, and a missing
 * column or table must not silently turn the layer off or, worse, let a
 * do-not-call check pass because the table it reads is absent. Both are also
 * declared in shared/schema.ts so `drizzle-kit push` keeps them.
 *
 * THE CLAIM IS THE SAFETY PROPERTY. `claimContact` is one UPDATE that moves
 * a row from a dialable status to 'calling' and returns it only to the
 * caller that moved it. Two ticks, two processes or a retried tick can race
 * for the same person and exactly one of them gets the row; the others get
 * null and dial nobody. 5Star's dialer learned this the hard way and only
 * its newest path claims atomically.
 *
 * Every bound parameter that meets a typed column or another parameter is
 * cast: node-postgres sends parameters untyped, and `$1 + $2` with nothing
 * to infer from is a parse error (the v52 outage, 3,749 refused writes a day).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { OutboundContact } from "./campaign";
import { RUNTIME_OUTBOUND_CAMPAIGN_TYPE } from "./campaign";

/** Statuses a contact may be dialled from. Everything else is either in
 * progress ('calling') or settled. */
export const DIALABLE_STATUSES = ["pending", "no_answer", "voicemail", "callback_scheduled"] as const;

/** What a contact can settle to. The `contact_outreach_status` enum. */
export type ContactStatus =
  | "pending"
  | "calling"
  | "answered"
  | "voicemail"
  | "no_answer"
  | "callback_scheduled"
  | "confirmed"
  | "declined"
  | "rescheduled"
  | "wrong_number"
  | "do_not_call"
  | "max_attempts"
  | "completed";

export interface ContactRow {
  id: string;
  campaignId: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  customData: Record<string, unknown>;
}

export interface AttemptFinish {
  status: string;
  answeredBy?: string | null;
  outcome?: string | null;
  durationSeconds?: number | null;
}

export interface OutboundStore {
  /** The campaigns row for this key, created on first use. Null when the
   * lane has no agents row to hang it on (the campaign cannot run). */
  ensureCampaign(campaignKey: string, agentSlug: string): Promise<string | null>;
  /** Contacts that could be dialled now, oldest-due first. A read only —
   * nothing is claimed until claimContact. */
  dialableContacts(campaignId: string, now: Date, limit: number): Promise<ContactRow[]>;
  /** Atomic: the row, moved to 'calling', or null if anyone else got it. */
  claimContact(contactId: string, now: Date): Promise<ContactRow | null>;
  /** Hand a claimed row back without having dialled it. */
  releaseContact(contactId: string, status: ContactStatus, nextAttemptAt: Date | null): Promise<void>;
  priorAttemptTimes(contactId: string): Promise<Date[]>;
  startAttempt(contactId: string, campaignId: string, attemptNumber: number): Promise<string>;
  setAttemptCallSid(attemptId: string, callSid: string): Promise<void>;
  finishAttempt(attemptId: string, finish: AttemptFinish): Promise<void>;
  /** The contact for an answered call, only if the attempt belongs to it. */
  loadCallContact(contactId: string, attemptId: string): Promise<OutboundContact | null>;
  /**
   * Settle a contact. `onlyIfCalling` makes it a no-op unless the row is
   * still 'calling', which is how a late status callback leaves alone an
   * outcome the call itself already recorded.
   */
  settleContact(
    contactId: string,
    status: ContactStatus,
    opts?: { nextAttemptAt?: Date | null; onlyIfCalling?: boolean; notes?: string },
  ): Promise<boolean>;
  /** Contacts of this campaign currently 'calling' and claimed after `since`. */
  callsInFlight(campaignId: string, since: Date): Promise<number>;
  /** Rows stuck in 'calling' since before `before` go back to 'no_answer'. */
  reapStaleClaims(campaignId: string, before: Date): Promise<number>;
  isDoNotContact(phone: string): Promise<boolean>;
  stampDoNotContact(phone: string, source: string): Promise<void>;
}

/** Ten digits, the repo's one phone identity (src/utils/phone.ts). The
 * do-not-contact list keys on it so "+17145550100" and "(714) 555-0100"
 * are one person's request. */
export function dncKey(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

/** Pure, so the mapping is tested without a database. */
export function rowToContact(r: Record<string, unknown>): ContactRow {
  const data = r.custom_data;
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    phone: String(r.phone_number ?? ""),
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    status: String(r.outreach_status ?? "pending") as ContactStatus,
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at as string) : null,
    customData: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
  };
}

/** The production store, on the Hub. Imported lazily by the runtime so a
 * unit test never opens a pool by importing the dialer. */
export async function createDbOutboundStore(): Promise<OutboundStore> {
  const { db } = await import("../../../server/db");
  const { sql } = await import("drizzle-orm");

  let ensured: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ensured ??= (async () => {
      await db.execute(sql`ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS external_ref VARCHAR`);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_campaign_external_ref_uidx
          ON campaign_contacts (campaign_id, external_ref) WHERE external_ref IS NOT NULL`);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS do_not_contact (
          phone_key VARCHAR(10) PRIMARY KEY,
          source VARCHAR(64) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    })().catch((error) => {
      ensured = null; // try again next time rather than caching a failure
      throw error;
    });
    return ensured;
  };

  /**
   * The campaign tables are `timestamp WITHOUT time zone`, written by NOW()
   * in the database's UTC session. A JS Date bound straight to them is
   * serialised in the PROCESS's zone, so a host not on UTC would shift every
   * comparison by its offset. Bind the instant as ISO and convert in SQL.
   */
  const utc = (d: Date | null) => sql`(${d ? d.toISOString() : null}::timestamptz AT TIME ZONE 'UTC')`;

  const rows = (result: unknown): Record<string, unknown>[] =>
    ((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];

  return {
    async ensureCampaign(campaignKey, agentSlug) {
      await ensureSchema();
      const found = rows(
        await db.execute(sql`
          SELECT id FROM campaigns
           WHERE name = ${campaignKey}::varchar
             AND campaign_type = ${RUNTIME_OUTBOUND_CAMPAIGN_TYPE}::varchar
             AND deleted_at IS NULL
           ORDER BY created_at LIMIT 1`),
      );
      if (found[0]) return String(found[0].id);
      // The campaign hangs on the lane's `agents` row (campaigns.agent_id is
      // NOT NULL). Seeding agents rows is otherwise a manual step
      // (server/seedAgents.ts); an outbound lane gets its row here instead, so
      // switching a campaign on is not silently blocked by a missing seed. The
      // prompt lives in code, and the row says so.
      await db.execute(sql`
        INSERT INTO agents (name, slug, agent_type, system_prompt, description)
        VALUES (${agentSlug}::varchar, ${agentSlug}::varchar, 'outbound',
                'The prompt for this lane lives in code (src/agents). This row exists so the lane has an id.',
                'Runtime outbound lane (src/runtime/outbound).')
        ON CONFLICT (slug) DO NOTHING`);
      const created = rows(
        await db.execute(sql`
          INSERT INTO campaigns (name, description, agent_id, campaign_type, status)
          SELECT ${campaignKey}::varchar,
                 'Runtime outbound campaign (src/runtime/outbound). Dialled by the voice runtime, never by the campaign executor.',
                 a.id, ${RUNTIME_OUTBOUND_CAMPAIGN_TYPE}::varchar, 'running'
            FROM agents a WHERE a.slug = ${agentSlug}::varchar
          RETURNING id`),
      );
      return created[0] ? String(created[0].id) : null;
    },

    async dialableContacts(campaignId, now, limit) {
      await ensureSchema();
      return rows(
        await db.execute(sql`
          SELECT * FROM campaign_contacts
           WHERE campaign_id = ${campaignId}::varchar
             AND outreach_status::text IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ${utc(now)})
           ORDER BY next_attempt_at NULLS FIRST, created_at
           LIMIT ${limit}::int`),
      ).map(rowToContact);
    },

    async claimContact(contactId, now) {
      const claimed = rows(
        await db.execute(sql`
          UPDATE campaign_contacts
             SET outreach_status = 'calling', updated_at = NOW()
           WHERE id = ${contactId}::varchar
             AND outreach_status::text IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ${utc(now)})
          RETURNING *`),
      );
      return claimed[0] ? rowToContact(claimed[0]) : null;
    },

    async releaseContact(contactId, status, nextAttemptAt) {
      await db.execute(sql`
        UPDATE campaign_contacts
           SET outreach_status = ${status}::contact_outreach_status,
               next_attempt_at = ${utc(nextAttemptAt)},
               updated_at = NOW()
         WHERE id = ${contactId}::varchar AND outreach_status = 'calling'`);
    },

    async priorAttemptTimes(contactId) {
      return rows(
        await db.execute(sql`
          SELECT (attempted_at AT TIME ZONE 'UTC') AS attempted_at FROM campaign_contact_attempts
           WHERE contact_id = ${contactId}::varchar AND direction = 'outbound'`),
      ).map((r) => new Date(r.attempted_at as string));
    },

    async startAttempt(contactId, campaignId, attemptNumber) {
      const inserted = rows(
        await db.execute(sql`
          INSERT INTO campaign_contact_attempts (contact_id, campaign_id, attempt_number, direction, status)
          VALUES (${contactId}::varchar, ${campaignId}::varchar, ${attemptNumber}::int, 'outbound', 'initiated')
          RETURNING id`),
      );
      await db.execute(sql`
        UPDATE campaign_contacts
           SET attempts = COALESCE(attempts, 0) + 1, last_attempt_at = NOW(), contacted = true
         WHERE id = ${contactId}::varchar`);
      return String(inserted[0].id);
    },

    async setAttemptCallSid(attemptId, callSid) {
      await db.execute(sql`
        UPDATE campaign_contact_attempts SET call_sid = ${callSid}::varchar WHERE id = ${attemptId}::varchar`);
      await db.execute(sql`
        UPDATE campaign_contacts SET last_call_sid = ${callSid}::varchar
         WHERE id = (SELECT contact_id FROM campaign_contact_attempts WHERE id = ${attemptId}::varchar)`);
    },

    async finishAttempt(attemptId, f) {
      await db.execute(sql`
        UPDATE campaign_contact_attempts
           -- What the answer webhook decided (a machine, a fax, a process
           -- that could not take the call) is the truer verdict than the
           -- status callback's "completed" that follows it.
           SET status = CASE WHEN status IN ('voicemail', 'fax', 'not_ready') THEN status
                             ELSE ${f.status}::varchar END,
               answered_by = COALESCE(${f.answeredBy ?? null}::varchar, answered_by),
               outcome = COALESCE(${f.outcome ?? null}::varchar, outcome),
               duration = COALESCE(${f.durationSeconds ?? null}::int, duration),
               ended_at = COALESCE(ended_at, NOW())
         WHERE id = ${attemptId}::varchar`);
    },

    async loadCallContact(contactId, attemptId) {
      const found = rows(
        await db.execute(sql`
          SELECT c.*, a.id AS attempt_id
            FROM campaign_contacts c
            JOIN campaign_contact_attempts a ON a.contact_id = c.id
           WHERE c.id = ${contactId}::varchar AND a.id = ${attemptId}::varchar`),
      );
      if (!found[0]) return null;
      const c = rowToContact(found[0]);
      return {
        contactId: c.id,
        campaignId: c.campaignId,
        attemptId,
        phone: c.phone,
        firstName: c.firstName,
        lastName: c.lastName,
        data: c.customData,
      };
    },

    async settleContact(contactId, status, opts = {}) {
      const settled = rows(
        await db.execute(sql`
          UPDATE campaign_contacts
             SET outreach_status = ${status}::contact_outreach_status,
                 next_attempt_at = ${utc(opts.nextAttemptAt ?? null)},
                 successful = ${status === "confirmed" || status === "completed"}::boolean,
                 voicemail_left = voicemail_left OR ${status === "voicemail"}::boolean,
                 agent_notes = COALESCE(${opts.notes ?? null}::text, agent_notes),
                 updated_at = NOW()
           WHERE id = ${contactId}::varchar
             AND (${!opts.onlyIfCalling}::boolean OR outreach_status = 'calling')
          RETURNING id`),
      );
      return settled.length > 0;
    },

    async callsInFlight(campaignId, since) {
      const counted = rows(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM campaign_contacts
           WHERE campaign_id = ${campaignId}::varchar AND outreach_status = 'calling'
             AND updated_at >= ${utc(since)}`),
      );
      return Number(counted[0]?.n ?? 0);
    },

    async reapStaleClaims(campaignId, before) {
      const reaped = rows(
        await db.execute(sql`
          UPDATE campaign_contacts SET outreach_status = 'no_answer', updated_at = NOW()
           WHERE campaign_id = ${campaignId}::varchar AND outreach_status = 'calling'
             AND updated_at < ${utc(before)}
          RETURNING id`),
      );
      return reaped.length;
    },

    async isDoNotContact(phone) {
      const key = dncKey(phone);
      // An unreadable number is refused rather than dialled: a check that
      // cannot be made does not pass.
      if (!key) return true;
      await ensureSchema();
      const found = rows(
        await db.execute(sql`SELECT 1 FROM do_not_contact WHERE phone_key = ${key}::varchar`),
      );
      return found.length > 0;
    },

    async stampDoNotContact(phone, source) {
      const key = dncKey(phone);
      if (!key) return;
      await ensureSchema();
      await db.execute(sql`
        INSERT INTO do_not_contact (phone_key, source) VALUES (${key}::varchar, ${source}::varchar)
        ON CONFLICT (phone_key) DO NOTHING`);
    },
  };
}
