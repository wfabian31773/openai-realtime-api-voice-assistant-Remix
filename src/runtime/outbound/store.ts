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
 *   do_not_contact             NEW: one row per phone that asked not to be
 *                              contacted, phone-wide, every campaign; `source`
 *                              says which channel asked (a voice opt-out wins
 *                              over an SMS `sms_stop` row)
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

import type { OutboundContact, SourceContact } from "./campaign";
import { RUNTIME_OUTBOUND_CAMPAIGN_TYPE } from "./campaign";
import type { CallbackCandidate } from "./callback";
import { nameKey } from "../../tools/verifiedIdentity";

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
  contacted: boolean;
  nextAttemptAt: Date | null;
  customData: Record<string, unknown>;
  /** The source's id for this row (v107), or null for an imported row. */
  externalRef: string | null;
}

/** A source-fed row as the queue holds it now, for the refresh's diff. */
export interface SourceRow {
  id: string;
  externalRef: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  customData: Record<string, unknown>;
  status: ContactStatus;
}

export interface AttemptFinish {
  status: string;
  answeredBy?: string | null;
  outcome?: string | null;
  durationSeconds?: number | null;
  /** False when the call is still on the line: the answer webhook records a
   * machine, a fax or a not-ready verdict while its TwiML is still playing.
   * Only Twilio's terminal status callback ends the attempt, so the
   * concurrency count holds the slot until the call is really over. */
  ended?: boolean;
}

export interface PriorAttempt {
  at: Date;
}

/**
 * The attempt status for a dial Twilio REFUSED before it accepted the call.
 * Nobody was rung, so it is kept for the audit trail and counted against
 * no cap: a Twilio outage, or a caller-ID misconfiguration, must not spend a
 * person's attempts or settle them 'max_attempts' (Codex round 4, #357).
 * Distinct from Twilio's own "failed" status callback, which follows a call
 * Twilio accepted.
 */
export const NOT_PLACED = "not_placed";

export interface SettleOptions {
  nextAttemptAt?: Date | null;
  onlyIfCalling?: boolean;
  onlyIfCurrentAttempt?: string;
  /** A no-op when the row is already in one of these statuses. A returned
   * call's outcome supersedes every earlier one but an opt-out. */
  exceptStatus?: readonly ContactStatus[];
  /** A no-op unless the row is in one of these statuses. */
  onlyIfStatusIn?: readonly ContactStatus[];
  notes?: string;
}

/** The attempt_number written on a returned call: it is not a dial, so it
 * is not one of the person's attempts and no cap counts it. */
export const CALLBACK_ATTEMPT_NUMBER = 0;

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
  /**
   * Every outbound attempt on this contact's PHONE in this contact's
   * campaign — not only this row's. An import can carry one person on two
   * rows (two appointments, two `external_ref`s), and the caps are per
   * person. A dial Twilio refused (NOT_PLACED) rang nobody and is not
   * counted.
   */
  priorAttempts(contactId: string): Promise<PriorAttempt[]>;
  /**
   * Trailing NOT_PLACED attempts on THIS contact row, newest first, until
   * a placed (or still-open) attempt breaks the streak. Bounded by
   * `since` so the self-referencing NOT EXISTS does not scan the
   * contact's whole history. The short infrastructure retry uses this
   * count: after DEFAULT_MAX_CONSECUTIVE_INFRA_RETRIES the person
   * cooldown applies, so a permanently refused number cannot retry
   * every 15 minutes for the whole calling window.
   */
  consecutiveRefusedAttempts(contactId: string, since: Date): Promise<number>;
  /**
   * Whether a dialled call to this contact's PHONE is still on the line, in
   * ANY campaign. The caps are per campaign; ringing a person twice at once
   * is wrong whichever campaigns the two rows sit in (Codex round 4, #357).
   * Bounded by `since` like callsInFlight, so an attempt whose terminal
   * status never arrived cannot hold the phone past the stale-claim window.
   */
  callOpenOnPhone(contactId: string, since: Date): Promise<boolean>;
  /** Write the attempt row. Does not increment the contact's counter or
   * mark them contacted — that waits until Twilio has accepted the call. */
  startAttempt(contactId: string, campaignId: string, attemptNumber: number): Promise<string>;
  /**
   * After Twilio has accepted the call: increment the contact's attempt
   * counter and mark them contacted. A dial Twilio refused never reaches
   * this, so a call that was never placed is not counted as an attempt
   * and does not show as Failed (Codex round 5, #357).
   */
  markContactDialled(contactId: string): Promise<void>;
  setAttemptCallSid(attemptId: string, callSid: string): Promise<void>;
  finishAttempt(attemptId: string, finish: AttemptFinish): Promise<void>;
  /** The contact for an answered call, only if the attempt belongs to it. */
  loadCallContact(contactId: string, attemptId: string): Promise<OutboundContact | null>;
  /**
   * Settle a contact. `onlyIfCalling` makes it a no-op unless the row is
   * still 'calling', which is how a late status callback leaves alone an
   * outcome the call itself already recorded. `onlyIfCurrentAttempt` makes
   * it a no-op unless that attempt is still the contact's newest: a callback
   * for an old attempt, delayed past the stale-claim reaper, must not settle
   * the newer call that has since put the row back in 'calling'.
   */
  settleContact(contactId: string, status: ContactStatus, opts?: SettleOptions): Promise<boolean>;
  /** This campaign's dialled attempts still on the line (no terminal status
   * yet), started after `since`. */
  callsInFlight(campaignId: string, since: Date): Promise<number>;
  /** Rows stuck in 'calling' since before `before` go back to 'no_answer'
   * with `nextAttemptAt` set, so a claim whose call never existed is not
   * re-dialled on the same tick. */
  reapStaleClaims(campaignId: string, before: Date, nextAttemptAt: Date): Promise<number>;
  isDoNotContact(phone: string): Promise<boolean>;
  stampDoNotContact(phone: string, source: string): Promise<void>;
  /**
   * A RETURNED CALL (./callback.ts): the campaign's id, and every contact on
   * its list whose number reads as the caller's ten digits, each with the
   * newest dial that reached the network. Never creates the campaign — a
   * campaign that has never run has nobody on its list.
   */
  callbackCandidates(
    campaignKey: string,
    phone: string,
  ): Promise<{ campaignId: string | null; candidates: CallbackCandidate[] }>;
  /** This campaign's contacts with this first and last name, folded the way
   * the identity store folds names. For a caller ringing from another phone. */
  contactsByName(campaignId: string, firstName: string, lastName: string): Promise<CallbackCandidate[]>;
  /**
   * The returned call, written as an INBOUND attempt on the contact once the
   * caller is identified: the history says they called back, and
   * callOpenOnPhone sees the call so the dialler does not ring them while
   * they are on the line with us. Spends no cap (CALLBACK_ATTEMPT_NUMBER;
   * priorAttempts reads outbound attempts only).
   */
  openCallbackAttempt(contactId: string, campaignId: string, callSid: string): Promise<string>;
  /** Every source-fed row in this campaign (external_ref set), for the
   * refresh to diff the live list against (v107). */
  sourceRows(campaignId: string): Promise<SourceRow[]>;
  /**
   * Add or refresh source-fed rows by `external_ref`: new people queue as
   * 'pending'; an existing row's phone, name and fields follow the source,
   * and its STATUS is never touched — an outcome is the call's, not the
   * source's. One fixed statement however many rows (a jsonb list), so a
   * refresh never writes a new statement shape to the Hub.
   */
  upsertSourceContacts(campaignId: string, rows: Array<SourceContact & { phone: string }>): Promise<number>;
  /** Rows that left the live list wait until `until` before they are looked
   * at again — dialable rows only, and never brought forward. */
  parkContacts(campaignId: string, externalRefs: string[], until: Date): Promise<number>;
  /** The number the source holds for this person today. */
  updateContactPhone(contactId: string, phone: string): Promise<void>;
}

/**
 * The surname-initial folding the name read applies IN SQL, written to agree
 * with `nameKey` character for character (a test holds them together): a
 * lower-cased initial in FROM becomes the letter at the same place in TO.
 * Without it the prefilter compared a raw "á" against nameKey's folded "a",
 * and a caller named Álvarez ringing from another phone could never be found
 * (Codex P2, #358). Only letters nameKey itself folds are listed — it leaves
 * ø, đ and ł alone, so this does too.
 */
export const SURNAME_INITIAL_FOLD = {
  from: "áàâäãåāăąéèêëēėęěíìîïīįóòôöõōúùûüūůųñńçćčďğľňřśšşťţýÿźžż",
  to: "aaaaaaaaaeeeeeeeeiiiiiioooooouuuuuuunncccdglnrsssttyyzzz",
} as const;

/** A candidate from a contact row plus its newest placed dial. Pure. */
export function rowToCandidate(r: Record<string, unknown>): CallbackCandidate {
  const c = rowToContact(r);
  return {
    contactId: c.id,
    campaignId: c.campaignId,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    status: c.status,
    data: c.customData,
    lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at as string) : null,
    lastAttemptStatus: (r.last_attempt_status as string | null) ?? null,
  };
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
    contacted: Boolean(r.contacted),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at as string) : null,
    customData: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
    externalRef: (r.external_ref as string | null) ?? null,
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
      // One row per phone, keyed on phone_key — the shape the Hub has carried
      // since v105. This only ever CREATES the table; it never alters one.
      // v114 dropped the primary key here on first use, which is a schema
      // change on a live table that no migration covered, and it broke the
      // `ON CONFLICT (phone_key)` write every older build makes (v115).
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

  /** A status list as one comma-joined text, or null for "no condition". */
  const csv = (list: readonly string[] | undefined): string | null =>
    list && list.length > 0 ? list.join(",") : null;

  /** The newest dial on a contact that reached the network, as columns. */
  const lastPlacedDial = sql`
    LEFT JOIN LATERAL (
      SELECT (a.attempted_at AT TIME ZONE 'UTC') AS last_attempt_at, a.status AS last_attempt_status
        FROM campaign_contact_attempts a
       WHERE a.contact_id = c.id AND a.direction = 'outbound'
         AND a.status IS DISTINCT FROM ${NOT_PLACED}::varchar
       ORDER BY a.attempted_at DESC, a.id DESC
       LIMIT 1) la ON true`;

  const campaignIdFor = async (campaignKey: string): Promise<string | null> => {
    const found = rows(
      await db.execute(sql`
        SELECT id FROM campaigns
         WHERE name = ${campaignKey}::varchar
           AND campaign_type = ${RUNTIME_OUTBOUND_CAMPAIGN_TYPE}::varchar
           AND deleted_at IS NULL
         ORDER BY created_at LIMIT 1`),
    );
    return found[0] ? String(found[0].id) : null;
  };

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

    async priorAttempts(contactId) {
      return rows(
        await db.execute(sql`
          -- The phone, not the row: every contact in this campaign whose
          -- number reads as the same ten digits. right(…, 10) agrees with
          -- dncKey on every number that can carry an attempt, because an
          -- unreadable number is refused before it is ever dialled.
          -- A dial Twilio refused rang nobody, so it spends no cap.
          SELECT (a.attempted_at AT TIME ZONE 'UTC') AS attempted_at
            FROM campaign_contacts me
            JOIN campaign_contacts c
              ON c.campaign_id = me.campaign_id
             AND right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10)
               = right(regexp_replace(me.phone_number, '[^0-9]', '', 'g'), 10)
            JOIN campaign_contact_attempts a ON a.contact_id = c.id AND a.direction = 'outbound'
           WHERE me.id = ${contactId}::varchar
             AND a.status IS DISTINCT FROM ${NOT_PLACED}::varchar`),
      ).map((r) => ({ at: new Date(r.attempted_at as string) }));
    },

    async consecutiveRefusedAttempts(contactId, since) {
      const found = rows(
        await db.execute(sql`
          -- Trailing not_placed rows on this contact, newest first, and
          -- only inside the window. A newer attempt that is anything
          -- else (placed, or still initiated after an ambiguous
          -- createCall) breaks the streak.
          SELECT count(*)::int AS n
            FROM campaign_contact_attempts a
           WHERE a.contact_id = ${contactId}::varchar
             AND a.direction = 'outbound'
             AND a.status = ${NOT_PLACED}::varchar
             AND a.attempted_at >= ${utc(since)}
             AND NOT EXISTS (
               SELECT 1
                 FROM campaign_contact_attempts newer
                WHERE newer.contact_id = a.contact_id
                  AND newer.direction = 'outbound'
                  AND newer.attempted_at >= ${utc(since)}
                  AND (newer.attempted_at > a.attempted_at
                       OR (newer.attempted_at = a.attempted_at AND newer.id > a.id))
                  AND newer.status IS DISTINCT FROM ${NOT_PLACED}::varchar
             )`),
      );
      return Number(found[0]?.n ?? 0);
    },

    async callOpenOnPhone(contactId, since) {
      const found = rows(
        await db.execute(sql`
          -- Every campaign, not only this one: the same ten digits on any
          -- contact row, with a call that has not ended — a dial we placed,
          -- or the person calling us back (an inbound attempt, ./callback.ts).
          SELECT EXISTS (
            SELECT 1
              FROM campaign_contacts me
              JOIN campaign_contacts c
                ON right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(me.phone_number, '[^0-9]', '', 'g'), 10)
              JOIN campaign_contact_attempts a
                ON a.contact_id = c.id AND a.direction IN ('outbound', 'inbound')
             WHERE me.id = ${contactId}::varchar
               AND a.ended_at IS NULL
               AND a.attempted_at >= ${utc(since)}
          ) AS open`),
      );
      return found[0]?.open === true;
    },

    async startAttempt(contactId, campaignId, attemptNumber) {
      const inserted = rows(
        await db.execute(sql`
          INSERT INTO campaign_contact_attempts (contact_id, campaign_id, attempt_number, direction, status)
          VALUES (${contactId}::varchar, ${campaignId}::varchar, ${attemptNumber}::int, 'outbound', 'initiated')
          RETURNING id`),
      );
      return String(inserted[0].id);
    },

    async markContactDialled(contactId) {
      await db.execute(sql`
        UPDATE campaign_contacts
           SET attempts = COALESCE(attempts, 0) + 1, last_attempt_at = NOW(), contacted = true
         WHERE id = ${contactId}::varchar`);
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
               ended_at = CASE WHEN ${f.ended ?? true}::boolean THEN COALESCE(ended_at, NOW()) ELSE ended_at END
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
             -- Status lists travel as one comma-joined text and are split in
             -- SQL: a bound JS array is not a portable parameter here.
             AND (${csv(opts.exceptStatus)}::text IS NULL
                  OR NOT (outreach_status::text = ANY (string_to_array(${csv(opts.exceptStatus)}::text, ','))))
             AND (${csv(opts.onlyIfStatusIn)}::text IS NULL
                  OR outreach_status::text = ANY (string_to_array(${csv(opts.onlyIfStatusIn)}::text, ',')))
             AND (${opts.onlyIfCurrentAttempt ?? null}::varchar IS NULL
                  OR ${opts.onlyIfCurrentAttempt ?? null}::varchar = (
                       SELECT x.id FROM campaign_contact_attempts x
                        WHERE x.contact_id = campaign_contacts.id AND x.direction = 'outbound'
                        ORDER BY x.attempted_at DESC, x.id DESC
                        LIMIT 1))
          RETURNING id`),
      );
      return settled.length > 0;
    },

    async callsInFlight(campaignId, since) {
      const counted = rows(
        await db.execute(sql`
          -- The live ATTEMPT, not the contact's status: a tool can settle the
          -- contact (an outcome, an opt-out) while the call is still
          -- connected, and only Twilio's terminal status callback ends the
          -- attempt. Bounded by \`since\` so a lost callback cannot hold a
          -- slot past the stale-claim window.
          SELECT count(*)::int AS n FROM campaign_contact_attempts
           WHERE campaign_id = ${campaignId}::varchar AND direction = 'outbound'
             AND ended_at IS NULL
             AND attempted_at >= ${utc(since)}`),
      );
      return Number(counted[0]?.n ?? 0);
    },

    async reapStaleClaims(campaignId, before, nextAttemptAt) {
      const reaped = rows(
        await db.execute(sql`
          UPDATE campaign_contacts
             SET outreach_status = 'no_answer',
                 next_attempt_at = ${utc(nextAttemptAt)},
                 updated_at = NOW()
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
      // Any row blocks, whatever its source: an SMS STOP blocks calls too.
      const found = rows(
        await db.execute(sql`
          SELECT 1 FROM do_not_contact
           WHERE phone_key = ${key}::varchar
           LIMIT 1`),
      );
      return found.length > 0;
    },

    async callbackCandidates(campaignKey, phone) {
      const campaignId = await campaignIdFor(campaignKey);
      const key = dncKey(phone);
      if (!campaignId || !key) return { campaignId, candidates: [] };
      const found = rows(
        await db.execute(sql`
          SELECT c.*, la.last_attempt_at, la.last_attempt_status
            FROM campaign_contacts c
            ${lastPlacedDial}
           WHERE c.campaign_id = ${campaignId}::varchar
             AND right(regexp_replace(c.phone_number, '[^0-9]', '', 'g'), 10) = ${key}::varchar
           ORDER BY la.last_attempt_at DESC NULLS LAST, c.created_at
           LIMIT 20`),
      );
      return { campaignId, candidates: found.map(rowToCandidate) };
    },

    async contactsByName(campaignId, firstName, lastName) {
      // Narrowed in SQL by the surname's first letter, then matched exactly
      // in JS with the identity store's folding — accents and hyphens are
      // folded there, not in SQL. Bounded, because a common initial is not.
      const initial = nameKey(lastName).charAt(0);
      if (!initial) return [];
      const found = rows(
        await db.execute(sql`
          SELECT c.*, la.last_attempt_at, la.last_attempt_status
            FROM campaign_contacts c
            ${lastPlacedDial}
           WHERE c.campaign_id = ${campaignId}::varchar
             AND translate(lower(left(trim(c.last_name), 1)),
                           ${SURNAME_INITIAL_FOLD.from}::text, ${SURNAME_INITIAL_FOLD.to}::text) = ${initial}::varchar
           LIMIT 500`),
      );
      const first = nameKey(firstName);
      const last = nameKey(lastName);
      return found
        .map(rowToCandidate)
        .filter((c) => nameKey(c.firstName ?? undefined) === first && nameKey(c.lastName ?? undefined) === last);
    },

    async openCallbackAttempt(contactId, campaignId, callSid) {
      const inserted = rows(
        await db.execute(sql`
          INSERT INTO campaign_contact_attempts
            (contact_id, campaign_id, attempt_number, direction, status, call_sid, answered_at, answered_by)
          VALUES (${contactId}::varchar, ${campaignId}::varchar, ${CALLBACK_ATTEMPT_NUMBER}::int,
                  'inbound', 'answered', ${callSid}::varchar, NOW(), 'human')
          RETURNING id`),
      );
      return String(inserted[0].id);
    },

    async sourceRows(campaignId) {
      await ensureSchema();
      return rows(
        await db.execute(sql`
          SELECT id, external_ref, phone_number, first_name, last_name, custom_data, outreach_status
            FROM campaign_contacts
           WHERE campaign_id = ${campaignId}::varchar AND external_ref IS NOT NULL`),
      ).map((r) => {
        const c = rowToContact(r);
        return {
          id: c.id,
          externalRef: String(r.external_ref),
          phone: c.phone,
          firstName: c.firstName,
          lastName: c.lastName,
          customData: c.customData,
          status: c.status,
        };
      });
    },

    async upsertSourceContacts(campaignId, list) {
      if (list.length === 0) return 0;
      await ensureSchema();
      const payload = JSON.stringify(
        list.map((c) => ({
          external_ref: c.externalRef,
          phone_number: c.phone,
          first_name: c.firstName,
          last_name: c.lastName,
          custom_data: c.data,
        })),
      );
      const written = rows(
        await db.execute(sql`
          INSERT INTO campaign_contacts
            (campaign_id, external_ref, phone_number, first_name, last_name, custom_data, outreach_status)
          SELECT ${campaignId}::varchar, x.external_ref, x.phone_number, x.first_name, x.last_name,
                 x.custom_data, 'pending'
            FROM jsonb_to_recordset(${payload}::jsonb)
                 AS x(external_ref varchar, phone_number varchar, first_name varchar, last_name varchar, custom_data jsonb)
          ON CONFLICT (campaign_id, external_ref) WHERE external_ref IS NOT NULL
          DO UPDATE SET phone_number = EXCLUDED.phone_number,
                        first_name = EXCLUDED.first_name,
                        last_name = EXCLUDED.last_name,
                        custom_data = EXCLUDED.custom_data,
                        updated_at = NOW()
          RETURNING id`),
      );
      return written.length;
    },

    async parkContacts(campaignId, externalRefs, until) {
      if (externalRefs.length === 0) return 0;
      const parked = rows(
        await db.execute(sql`
          UPDATE campaign_contacts
             SET next_attempt_at = GREATEST(COALESCE(next_attempt_at, ${utc(until)}), ${utc(until)}),
                 updated_at = NOW()
           WHERE campaign_id = ${campaignId}::varchar
             AND external_ref IN (SELECT jsonb_array_elements_text(${JSON.stringify(externalRefs)}::jsonb))
             AND outreach_status::text IN ('pending', 'no_answer', 'voicemail', 'callback_scheduled')
          RETURNING id`),
      );
      return parked.length;
    },

    async updateContactPhone(contactId, phone) {
      await db.execute(sql`
        UPDATE campaign_contacts SET phone_number = ${phone}::varchar, updated_at = NOW()
         WHERE id = ${contactId}::varchar`);
    },

    async stampDoNotContact(phone, source) {
      const key = dncKey(phone);
      if (!key) return;
      await ensureSchema();
      // One row per phone. A voice opt-out on a phone that only has an SMS
      // STOP takes the row over, so a later START (which deletes only
      // `sms_stop`) cannot erase it; any other existing row stays as it is.
      await db.execute(sql`
        INSERT INTO do_not_contact (phone_key, source) VALUES (${key}::varchar, ${source}::varchar)
        ON CONFLICT (phone_key) DO UPDATE SET source = EXCLUDED.source
          WHERE do_not_contact.source = 'sms_stop'`);
    },
  };
}
