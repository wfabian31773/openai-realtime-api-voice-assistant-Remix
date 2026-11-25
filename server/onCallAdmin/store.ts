/**
 * The admin page's data layer over the Hub's on_call_* tables
 * (migrations/add_on_call_rotation.sql and migrations/add_on_call_admin.sql,
 * both applied by Wayne, never by the repo).
 *
 * Reads are plain queries. Every write runs inside `transaction`, on one
 * client, between BEGIN and COMMIT, and the route module writes the audit row
 * through the same `tx` — so a change without its audit row cannot land: if
 * the audit insert fails, the change rolls back with it.
 *
 * Every statement casts its parameters (the v52 lesson). The patient details
 * and callback number an escalation holds while it is paging are never
 * selected, and a plan level's phone is dropped on the way out.
 */
import type { OnCallProvider } from "../../src/runtime/onCall/rotation";
import { ON_CALL_ADMIN_WRITE_LOCK_SQL } from "../../src/runtime/onCall/adminLock";
import { ON_CALL_TABLES } from "../../src/runtime/onCall/store";
import type { AttemptLite, CallLogLite, EscalationLite, OverrideRow, ScheduleRow } from "./logic";

export const ON_CALL_ADMIN_TABLES = ["on_call_audit_log", "on_call_call_events"] as const;

export interface AdminProvider extends OnCallProvider {
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DirectorRow {
  region: string;
  providerId: number;
  updatedAt: string | null;
}

export interface AuditEntry {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: "provider" | "schedule" | "override" | "director";
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  createdAt: string;
}

export interface AuditFilter {
  entityType?: string;
  action?: string;
  actor?: string;
  since?: Date;
  until?: Date;
  limit: number;
}

export interface ProviderPatch {
  fullName?: string;
  npi?: string | null;
  phone?: string;
  email?: string | null;
  region?: string;
  active?: boolean;
  rotationOrder?: number | null;
}

export interface NewProvider {
  fullName: string;
  npi: string | null;
  phone: string;
  email: string | null;
  region: string;
  rotationOrder: number | null;
}

export interface OnCallAdminReads {
  providers(): Promise<AdminProvider[]>;
  directors(): Promise<DirectorRow[]>;
  schedule(): Promise<ScheduleRow[]>;
  /** Every override, past ones included (the page shows history). */
  overrides(): Promise<OverrideRow[]>;
  /** Referenced by any schedule row, override, director, escalation or attempt. */
  providerReferenced(id: number): Promise<boolean>;
}

export interface OnCallAdminTx extends OnCallAdminReads {
  /** False when the week has no row. */
  setWeekProvider(week: string, providerId: number, note: string | null): Promise<boolean>;
  insertWeek(week: string, providerId: number, note: string | null): Promise<void>;
  insertOverride(o: { startsAt: Date; endsAt: Date; providerId: number; reason: string }): Promise<OverrideRow>;
  endOverride(id: number, at: Date): Promise<void>;
  deleteOverride(id: number): Promise<void>;
  insertProvider(p: NewProvider): Promise<AdminProvider>;
  updateProvider(id: number, patch: ProviderPatch): Promise<AdminProvider | null>;
  deleteProvider(id: number): Promise<void>;
  /** Moves rotation places without ever holding one number on two rows (rotation_order is UNIQUE). */
  setRotationOrders(changes: ReadonlyArray<{ id: number; to: number }>): Promise<void>;
  setDirector(region: string, providerId: number): Promise<void>;
  deleteDirector(region: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface CallBundleRaw {
  callLog: CallLogLite | null;
  turns: Array<{ at: Date | null; role: string; text: string | null }>;
  callEvents: Array<{ at: Date; level: string | null; category: string | null; message: string | null; data: unknown }>;
  escalation: EscalationLite | null;
  attempts: AttemptLite[];
  extraEvents: Array<{ at: Date; source: string; eventType: string; detail: unknown }>;
}

export interface OnCallAdminStore extends OnCallAdminReads {
  tables(): Promise<{ rotation: boolean; admin: boolean; missing: string[] }>;
  transaction<T>(fn: (tx: OnCallAdminTx) => Promise<T>): Promise<T>;
  auditLog(filter: AuditFilter): Promise<AuditRow[]>;
  escalations(f: { since: Date; until: Date; limit: number }): Promise<EscalationLite[]>;
  attemptsForEscalations(ids: number[]): Promise<Array<AttemptLite & { escalationId: number }>>;
  callLogsBySid(sids: string[]): Promise<CallLogLite[]>;
  /** After-hours calls that asked for the on-call provider and opened no chain (the rotation off, or refused). */
  urgentCallsWithoutChain(f: { since: Date; until: Date; limit: number }): Promise<CallLogLite[]>;
  callBundle(callSid: string): Promise<CallBundleRaw>;
}

/** The after-hours line's agent slugs as call_logs.agent_used records them. */
export const AFTER_HOURS_AGENTS = ["no-ivr", "no-ivr-v2", "dev-no-ivr"] as const;

// ── Row mapping ─────────────────────────────────────────────────────────────

function d(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const x = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(x.getTime()) ? null : x;
}
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function n(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function j<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export function adminProviderFromRow(r: any): AdminProvider {
  return {
    id: Number(r.id),
    fullName: String(r.full_name),
    npi: s(r.npi),
    phone: String(r.phone),
    email: s(r.email),
    region: String(r.region),
    rotationOrder: n(r.rotation_order),
    active: Boolean(r.active),
    createdAt: d(r.created_at)?.toISOString() ?? null,
    updatedAt: d(r.updated_at)?.toISOString() ?? null,
  };
}

export function overrideFromRow(r: any): OverrideRow {
  return {
    id: Number(r.id),
    startsAt: d(r.starts_at)!,
    endsAt: d(r.ends_at)!,
    providerId: Number(r.provider_id),
    reason: s(r.reason),
    createdAt: d(r.created_at),
  };
}

export function escalationLiteFromRow(r: any): EscalationLite {
  const plan = j<EscalationLite["plan"]>(r.plan);
  return {
    id: Number(r.id),
    callSid: String(r.call_sid),
    mode: String(r.mode),
    status: String(r.status),
    levelIndex: Number(r.level_index),
    attemptNo: Number(r.attempt_no),
    routing: j<Record<string, unknown>>(r.routing),
    // A level's phone is a provider's own number: never leaves the server.
    plan: plan
      ? { ...plan, levels: (plan.levels ?? []).map(({ phone: _phone, ...rest }) => rest) }
      : null,
    acceptedBy: n(r.accepted_by),
    acceptedAt: d(r.accepted_at),
    acceptedAttemptId: n(r.accepted_attempt_id),
    createdAt: d(r.created_at)!,
    updatedAt: d(r.updated_at),
  };
}

export function attemptLiteFromRow(r: any): AttemptLite & { escalationId: number } {
  return {
    id: Number(r.id),
    escalationId: Number(r.escalation_id),
    levelIndex: Number(r.level_index),
    role: String(r.role),
    providerId: n(r.provider_id),
    kind: String(r.kind),
    attemptNo: Number(r.attempt_no),
    mode: String(r.mode),
    dialedTo: s(r.dialed_to),
    outcome: String(r.outcome),
    routingReason: s(r.routing_reason),
    startedAt: d(r.started_at)!,
    endedAt: d(r.ended_at),
    providerCallSid: s(r.provider_call_sid),
  };
}

export function callLogLiteFromRow(r: any): CallLogLite {
  return {
    id: String(r.id),
    callSid: s(r.call_sid),
    from: s(r.from),
    agentUsed: s(r.agent_used),
    voiceProvider: s(r.voice_provider),
    status: s(r.status),
    runtimeOutcome: s(r.runtime_outcome),
    agentOutcome: s(r.agent_outcome),
    summary: s(r.summary),
    duration: n(r.duration),
    startTime: d(r.start_time),
    endTime: d(r.end_time),
    createdAt: d(r.created_at),
    transferredToHuman: r.transferred_to_human === null || r.transferred_to_human === undefined ? null : Boolean(r.transferred_to_human),
    ticketNumber: s(r.ticket_number),
    toolTimeline: r.tool_timeline ?? null,
  };
}

function auditFromRow(r: any): AuditRow {
  return {
    id: Number(r.id),
    actorUserId: s(r.actor_user_id),
    actorEmail: s(r.actor_email),
    action: String(r.action),
    entityType: r.entity_type,
    entityId: s(r.entity_id),
    before: j(r.before),
    after: j(r.after),
    reason: String(r.reason),
    createdAt: d(r.created_at)!.toISOString(),
  };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const ESC_COLS = `id, call_sid, mode, status, level_index, attempt_no, routing, plan,
  accepted_by, accepted_at, accepted_attempt_id, created_at, updated_at`;
// call_logs, call_turns and call_events keep TIMESTAMP WITHOUT TIME ZONE
// holding UTC wall time. Read raw, node-postgres parses those as the server's
// LOCAL time; cast them to timestamptz so the merged timeline orders them
// correctly against the on_call_* timestamptz columns whatever TZ is. The
// same cast goes on every WHERE and ORDER BY that reads one of those columns:
// compared bare against a timestamptz bound, Postgres reads the stored UTC
// wall time in the SESSION time zone, so a non-UTC session shifts the window.
const CALL_COLS = `id, call_sid, "from", agent_used, voice_provider, status, runtime_outcome, agent_outcome,
  summary, duration, (start_time at time zone 'UTC') as start_time, (end_time at time zone 'UTC') as end_time,
  (created_at at time zone 'UTC') as created_at, transferred_to_human, ticket_number, tool_timeline`;

/**
 * A chain that placed a call (review of #520, rounds 2, 3 and 10): an attempt
 * of kind warm_transfer or call that rang. A background call rang only if
 * Twilio gave it a call sid: the runner writes the row before Twilio is asked,
 * and a worker that stops there can leave no_status with no sid. The in-call
 * warm transfer keeps its ringing outcomes. One copy, read by the escalation
 * list and by the no-chain list's exclusion, so the two cannot disagree.
 */
function dialledChain(escalationId: string): string {
  return `exists (select 1 from on_call_attempts a
                    where a.escalation_id = ${escalationId}
                      and a.kind in ('warm_transfer', 'call')
                      and ((a.kind = 'call' and a.provider_call_sid is not null)
                           or (a.kind = 'warm_transfer'
                               and (a.provider_call_sid is not null
                                    or a.outcome in ('accepted', 'no_answer', 'declined', 'busy',
                                                     'no_status', 'taken_elsewhere')))))`;
}

export const ADMIN_SQL = {
  /**
   * One admin change at a time: every write reads, decides and writes in one
   * transaction, so two admins editing at once would otherwise lose an update
   * and audit a stale "before". The same constant opens every transaction
   * scripts/on-call-change.ts prints, so the CLI and the page serialise too.
   */
  lock: ON_CALL_ADMIN_WRITE_LOCK_SQL,
  tables: `select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])`,
  providers: `select id, full_name, npi, phone, email, region, rotation_order, active, created_at, updated_at
                from on_call_providers order by rotation_order nulls last, full_name`,
  directors: `select region, provider_id, updated_at from on_call_escalation_directors order by region`,
  schedule: `select to_char(week_starts_on, 'YYYY-MM-DD') as week, provider_id, note, updated_at
               from on_call_schedule order by week_starts_on`,
  overrides: `select id, starts_at, ends_at, provider_id, reason, created_at from on_call_overrides order by starts_at`,
  referenced: `select (
      exists (select 1 from on_call_schedule where provider_id = $1::integer)
      or exists (select 1 from on_call_overrides where provider_id = $1::integer)
      or exists (select 1 from on_call_escalation_directors where provider_id = $1::integer)
      or exists (select 1 from on_call_attempts where provider_id = $1::integer)
      or exists (select 1 from on_call_escalations where accepted_by = $1::integer
                   or plan->'levels' @> jsonb_build_array(jsonb_build_object('providerId', $1::integer)))
    ) as referenced`,
  setWeek: `update on_call_schedule set provider_id = $2::integer, note = $3::text, updated_at = now()
             where week_starts_on = $1::date`,
  insertWeek: `insert into on_call_schedule (week_starts_on, provider_id, note) values ($1::date, $2::integer, $3::text)`,
  insertOverride: `insert into on_call_overrides (starts_at, ends_at, provider_id, reason)
                    values ($1::timestamptz, $2::timestamptz, $3::integer, $4::text)
                    returning id, starts_at, ends_at, provider_id, reason, created_at`,
  endOverride: `update on_call_overrides set ends_at = $2::timestamptz where id = $1::integer`,
  deleteOverride: `delete from on_call_overrides where id = $1::integer`,
  insertProvider: `insert into on_call_providers (full_name, npi, phone, email, region, rotation_order, active)
                    values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, true)
                    returning id, full_name, npi, phone, email, region, rotation_order, active, created_at, updated_at`,
  updateProvider: `update on_call_providers set
      full_name = case when $2::boolean then $3::text else full_name end,
      npi = case when $4::boolean then $5::text else npi end,
      phone = case when $6::boolean then $7::text else phone end,
      email = case when $8::boolean then $9::text else email end,
      region = case when $10::boolean then $11::text else region end,
      active = case when $12::boolean then $13::boolean else active end,
      rotation_order = case when $14::boolean then $15::integer else rotation_order end,
      updated_at = now()
    where id = $1::integer
    returning id, full_name, npi, phone, email, region, rotation_order, active, created_at, updated_at`,
  deleteProvider: `delete from on_call_providers where id = $1::integer`,
  clearOrder: `update on_call_providers set rotation_order = null, updated_at = now() where id = any($1::integer[])`,
  setOrder: `update on_call_providers set rotation_order = $2::integer, updated_at = now() where id = $1::integer`,
  setDirector: `insert into on_call_escalation_directors (region, provider_id) values ($1::text, $2::integer)
                 on conflict (region) do update set provider_id = excluded.provider_id, updated_at = now()`,
  deleteDirector: `delete from on_call_escalation_directors where region = $1::text`,
  audit: `insert into on_call_audit_log (actor_user_id, actor_email, action, entity_type, entity_id, before, after, reason)
           values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::jsonb, $8::text)`,
  auditLog: `select id, actor_user_id, actor_email, action, entity_type, entity_id, before, after, reason, created_at
               from on_call_audit_log
              where ($1::text is null or entity_type = $1::text)
                and ($2::text is null or action = $2::text)
                and ($3::text is null or actor_email ilike '%' || $3::text || '%' or actor_user_id = $3::text)
                and ($4::timestamptz is null or created_at >= $4::timestamptz)
                and ($5::timestamptz is null or created_at < $5::timestamptz)
              order by created_at desc, id desc
              limit $6::integer`,
  escalations: `select ${ESC_COLS} from on_call_escalations
                 where created_at >= $1::timestamptz and created_at < $2::timestamptz
                   -- Only a chain that placed a call (review of #520): a queued or
                   -- SMS-only escalation is not a dialled call, and it is filtered
                   -- here, before the limit, so it cannot crowd dialled calls out.
                   and ${dialledChain("on_call_escalations.id")}
                 order by created_at desc limit $3::integer`,
  escalationByCall: `select ${ESC_COLS} from on_call_escalations where call_sid = $1::text`,
  attemptsFor: `select id, escalation_id, level_index, role, provider_id, kind, attempt_no, mode, dialed_to, outcome,
                       routing_reason, started_at, ended_at, provider_call_sid
                  from on_call_attempts where escalation_id = any($1::integer[]) order by started_at, id`,
  attemptsByCall: `select id, escalation_id, level_index, role, provider_id, kind, attempt_no, mode, dialed_to, outcome,
                          routing_reason, started_at, ended_at, provider_call_sid
                     from on_call_attempts where call_sid = $1::text order by started_at, id`,
  callLogsBySid: `select ${CALL_COLS} from call_logs where call_sid = any($1::text[])`,
  urgentWithoutChain: `select ${CALL_COLS} from call_logs c
      where c.agent_used = any($1::text[])
        and (c.created_at at time zone 'UTC') >= $2::timestamptz and (c.created_at at time zone 'UTC') < $3::timestamptz
        -- Only an escalation that placed a dial: escalate_to_human records
        -- dialAttempted true (v271 onward). handoffFailed is not enough: it is
        -- also set on UNAVAILABLE, when nobody rang (review of #520). Rows from
        -- before the field existed are excluded; the rotation was not live, so
        -- there is no history worth reading there.
        and c.tool_timeline->'events' @> '[{"tool":"escalate_to_human","outcome":{"dialAttempted":true}}]'::jsonb
        -- Excluded only when the escalation itself qualifies for the Calls list
        -- (review of #520, round 10): a chain row with no dial evidence must not
        -- hide a call whose tool timeline confirms the dial. The same range the
        -- escalations query reads (round 11): an escalation outside it is not
        -- listed there, so it must not hide the call here.
        and not exists (select 1 from on_call_escalations e
                         where e.call_sid = c.call_sid
                           and e.created_at >= $2::timestamptz and e.created_at < $3::timestamptz
                           and ${dialledChain("e.id")})
      order by (c.created_at at time zone 'UTC') desc limit $4::integer`,
  turns: `select (at at time zone 'UTC') as at, role, coalesce(final_transcript, raw_transcript) as text from call_turns
           where call_sid = $1::text order by turn_index limit 1000`,
  callEvents: `select (at at time zone 'UTC') as at, level, category, message, data from call_events
                where call_sid = $1::text order by (call_events.at at time zone 'UTC'), id limit 500`,
  extraEvents: `select at, source, event_type, detail from on_call_call_events
                 where call_sid = $1::text order by at, id limit 500`,
  appendExtraEvent: `insert into on_call_call_events (call_sid, escalation_id, at, source, event_type, detail)
                      values ($1::text, $2::integer, $3::timestamptz, $4::text, $5::text, $6::jsonb)`,
} as const;

// ── Postgres implementation ─────────────────────────────────────────────────

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export interface PgClientLike {
  query: Query;
  /** An error destroys the connection instead of returning it to the pool. */
  release(err?: Error): void;
}
export interface PgPoolLike {
  query: Query;
  connect(): Promise<PgClientLike>;
}

function reads(q: Query): OnCallAdminReads {
  return {
    async providers() {
      return (await q(ADMIN_SQL.providers)).rows.map(adminProviderFromRow);
    },
    async directors() {
      return (await q(ADMIN_SQL.directors)).rows.map((r) => ({
        region: String(r.region),
        providerId: Number(r.provider_id),
        updatedAt: d(r.updated_at)?.toISOString() ?? null,
      }));
    },
    async schedule() {
      return (await q(ADMIN_SQL.schedule)).rows.map((r) => ({
        week: String(r.week),
        providerId: Number(r.provider_id),
        note: s(r.note),
        updatedAt: d(r.updated_at)?.toISOString() ?? null,
      }));
    },
    async overrides() {
      return (await q(ADMIN_SQL.overrides)).rows.map(overrideFromRow);
    },
    async providerReferenced(id) {
      return Boolean((await q(ADMIN_SQL.referenced, [id])).rows[0]?.referenced);
    },
  };
}

/** A table that is not there reads as nothing, never a 500. */
async function optional<T>(f: () => Promise<T[]>): Promise<T[]> {
  try {
    return await f();
  } catch {
    return [];
  }
}

export function createPgOnCallAdminStore(pool: PgPoolLike): OnCallAdminStore {
  const q = pool.query.bind(pool);
  return {
    ...reads(q),
    async tables() {
      const want = [...ON_CALL_TABLES, ...ON_CALL_ADMIN_TABLES];
      const { rows } = await q(ADMIN_SQL.tables, [want]);
      const found = new Set(rows.map((r) => String(r.table_name)));
      const missing = want.filter((t) => !found.has(t));
      return {
        rotation: ON_CALL_TABLES.every((t) => found.has(t)),
        admin: ON_CALL_ADMIN_TABLES.every((t) => found.has(t)),
        missing,
      };
    },
    async transaction(fn) {
      const client = await pool.connect();
      const cq = client.query.bind(client);
      const tx: OnCallAdminTx = {
        ...reads(cq),
        async setWeekProvider(week, providerId, note) {
          const r: any = await cq(ADMIN_SQL.setWeek, [week, providerId, note]);
          return (r.rowCount ?? r.rows?.length ?? 0) > 0;
        },
        async insertWeek(week, providerId, note) {
          await cq(ADMIN_SQL.insertWeek, [week, providerId, note]);
        },
        async insertOverride(o) {
          const { rows } = await cq(ADMIN_SQL.insertOverride, [o.startsAt.toISOString(), o.endsAt.toISOString(), o.providerId, o.reason]);
          return overrideFromRow(rows[0]);
        },
        async endOverride(id, at) {
          await cq(ADMIN_SQL.endOverride, [id, at.toISOString()]);
        },
        async deleteOverride(id) {
          await cq(ADMIN_SQL.deleteOverride, [id]);
        },
        async insertProvider(p) {
          const { rows } = await cq(ADMIN_SQL.insertProvider, [p.fullName, p.npi, p.phone, p.email, p.region, p.rotationOrder]);
          return adminProviderFromRow(rows[0]);
        },
        async updateProvider(id, p) {
          const has = (k: keyof ProviderPatch) => Object.prototype.hasOwnProperty.call(p, k);
          const { rows } = await cq(ADMIN_SQL.updateProvider, [
            id,
            has("fullName"), p.fullName ?? null,
            has("npi"), p.npi ?? null,
            has("phone"), p.phone ?? null,
            has("email"), p.email ?? null,
            has("region"), p.region ?? null,
            has("active"), p.active ?? null,
            has("rotationOrder"), p.rotationOrder ?? null,
          ]);
          return rows[0] ? adminProviderFromRow(rows[0]) : null;
        },
        async deleteProvider(id) {
          await cq(ADMIN_SQL.deleteProvider, [id]);
        },
        async setRotationOrders(changes) {
          if (!changes.length) return;
          // Clear every moving row first (NULLs never collide on a UNIQUE
          // column), then place each: no two rows ever hold one number.
          await cq(ADMIN_SQL.clearOrder, [changes.map((c) => c.id)]);
          for (const c of changes) await cq(ADMIN_SQL.setOrder, [c.id, c.to]);
        },
        async setDirector(region, providerId) {
          await cq(ADMIN_SQL.setDirector, [region, providerId]);
        },
        async deleteDirector(region) {
          await cq(ADMIN_SQL.deleteDirector, [region]);
        },
        async audit(e) {
          await cq(ADMIN_SQL.audit, [
            e.actorUserId,
            e.actorEmail,
            e.action,
            e.entityType,
            e.entityId,
            e.before === undefined ? null : JSON.stringify(e.before),
            e.after === undefined ? null : JSON.stringify(e.after),
            e.reason,
          ]);
        },
      };
      let broken: Error | undefined;
      try {
        await cq("BEGIN");
        await cq(ADMIN_SQL.lock);
        const out = await fn(tx);
        await cq("COMMIT");
        return out;
      } catch (e) {
        try {
          await cq("ROLLBACK");
        } catch (rollbackError) {
          // A connection that could not roll back must not return to the pool
          // still inside a transaction. The original error is the one to report.
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw e;
      } finally {
        client.release(broken);
      }
    },
    async auditLog(f) {
      const { rows } = await q(ADMIN_SQL.auditLog, [
        f.entityType ?? null,
        f.action ?? null,
        f.actor ?? null,
        f.since?.toISOString() ?? null,
        f.until?.toISOString() ?? null,
        f.limit,
      ]);
      return rows.map(auditFromRow);
    },
    async escalations(f) {
      const { rows } = await q(ADMIN_SQL.escalations, [f.since.toISOString(), f.until.toISOString(), f.limit]);
      return rows.map(escalationLiteFromRow);
    },
    async attemptsForEscalations(ids) {
      if (!ids.length) return [];
      return (await q(ADMIN_SQL.attemptsFor, [ids])).rows.map(attemptLiteFromRow);
    },
    async callLogsBySid(sids) {
      if (!sids.length) return [];
      return optional(async () => (await q(ADMIN_SQL.callLogsBySid, [sids])).rows.map(callLogLiteFromRow));
    },
    async urgentCallsWithoutChain(f) {
      return optional(async () =>
        (await q(ADMIN_SQL.urgentWithoutChain, [[...AFTER_HOURS_AGENTS], f.since.toISOString(), f.until.toISOString(), f.limit])).rows.map(
          callLogLiteFromRow,
        ),
      );
    },
    async callBundle(callSid) {
      const [logs, turns, events, escRows, attempts, extra] = await Promise.all([
        optional(async () => (await q(ADMIN_SQL.callLogsBySid, [[callSid]])).rows.map(callLogLiteFromRow)),
        optional(async () =>
          (await q(ADMIN_SQL.turns, [callSid])).rows.map((r) => ({ at: d(r.at), role: String(r.role), text: s(r.text) })),
        ),
        optional(async () =>
          (await q(ADMIN_SQL.callEvents, [callSid])).rows.map((r) => ({
            at: d(r.at)!,
            level: s(r.level),
            category: s(r.category),
            message: s(r.message),
            data: r.data ?? null,
          })),
        ),
        optional(async () => (await q(ADMIN_SQL.escalationByCall, [callSid])).rows.map(escalationLiteFromRow)),
        optional(async () => (await q(ADMIN_SQL.attemptsByCall, [callSid])).rows.map(attemptLiteFromRow)),
        optional(async () =>
          (await q(ADMIN_SQL.extraEvents, [callSid])).rows.map((r) => ({
            at: d(r.at)!,
            source: String(r.source),
            eventType: String(r.event_type),
            detail: r.detail ?? null,
          })),
        ),
      ]);
      return { callLog: logs[0] ?? null, turns, callEvents: events, escalation: escRows[0] ?? null, attempts, extraEvents: extra };
    },
  };
}

/**
 * The write the placeholder table is for. NOT CALLED by the voice runtime in
 * this change (src/runtime/** is untouched): wiring it is a follow-up.
 */
export async function appendOnCallCallEvent(
  query: Query,
  e: { callSid: string; escalationId: number | null; at: Date; source: string; eventType: string; detail: Record<string, unknown> | null },
): Promise<void> {
  await query(ADMIN_SQL.appendExtraEvent, [
    e.callSid,
    e.escalationId,
    e.at.toISOString(),
    e.source,
    e.eventType,
    e.detail ? JSON.stringify(e.detail) : null,
  ]);
}
