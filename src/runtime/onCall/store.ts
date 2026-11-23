/**
 * The on-call store: reads the rotation and keeps the escalation state and the
 * attempt log, all in the Hub's on_call_* tables
 * (migrations/add_on_call_rotation.sql, applied by Wayne, never by the repo).
 *
 * Until those tables exist the store reports itself unavailable, and every
 * urgent after-hours call keeps today's path (the one fixed on-call number).
 * The check is remembered once the tables are present and re-checked every ten
 * minutes while they are absent, so applying the migration switches the
 * rotation on without a republish (the buildIdentity.ts pattern).
 *
 * Every statement casts its parameters (the v52 lesson: two bare parameters in
 * one expression fail at PARSE). Every write that moves an escalation checks
 * its `version`, so two processes advancing one escalation cannot both win.
 */

import type { EscalationDetails } from "../../services/escalationStore";
import type { ChainPlan, OnCallOverride, OnCallProvider, RotationData } from "./rotation";
import { regionKey } from "./rotation";

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

async function defaultQuery(text: string, params?: unknown[]): Promise<{ rows: any[] }> {
  const { pool } = await import("../../../server/db");
  return pool.query(text, params as any[]);
}

export type OnCallMode = "live" | "test";
export type EscalationStatus = "active" | "accepted" | "exhausted" | "cancelled" | "failed";
export type EscalationPhase = "due" | "ringing";
export type AttemptKind = "warm_transfer" | "call" | "sms" | "nudge_sms";
export type AttemptOutcome =
  | "in_progress"
  | "accepted"
  | "no_answer"
  | "declined"
  | "busy"
  | "failed"
  | "no_status"
  | "sent"
  | "send_failed";

/** The patient details the texts carry: the fields buildUrgentTransferSms reads. */
export type StoredDetails = Pick<
  EscalationDetails,
  | "callerType"
  | "callerName"
  | "patientFirstName"
  | "patientLastName"
  | "patientDob"
  | "callbackNumber"
  | "reason"
  | "symptomsSummary"
  | "providerInfo"
>;

/** Copy only the text fields; the live map also holds callbacks. */
export function storedDetails(d: EscalationDetails | undefined): StoredDetails | null {
  if (!d) return null;
  const out: StoredDetails = {};
  for (const k of [
    "callerType",
    "callerName",
    "patientFirstName",
    "patientLastName",
    "patientDob",
    "callbackNumber",
    "reason",
    "symptomsSummary",
    "providerInfo",
  ] as const) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** Why the first level is who it is, PHI-free. */
export interface RoutingFacts {
  reason: "on_call" | "post_op_surgeon" | "post_op_uncertain" | "holiday_daytime" | "test_synthetic";
  window: string;
  weekStartsOn: string;
  source: string;
  postOp?: { route: string; reason?: string; surgeryDate?: string; daysAgo?: number; kept?: boolean };
  /** The note the alert text carries, when there is one. */
  note?: string;
  notes: string[];
}

export interface EscalationRow {
  id: number;
  callSid: string;
  mode: OnCallMode;
  status: EscalationStatus;
  levelIndex: number;
  attemptNo: number;
  phase: EscalationPhase;
  nextAt: Date | null;
  levelStartedAt: Date;
  routing: RoutingFacts;
  plan: ChainPlan;
  details: StoredDetails | null;
  callerNumber: string | null;
  acceptedBy: number | null;
  acceptedAt: Date | null;
  version: number;
  createdAt: Date;
}

export interface AttemptRow {
  id: number;
  escalationId: number;
  callSid: string;
  levelIndex: number;
  role: string;
  providerId: number | null;
  kind: AttemptKind;
  attemptNo: number;
  mode: OnCallMode;
  dialedTo: string | null;
  outcome: AttemptOutcome;
  providerCallSid: string | null;
  smsSid: string | null;
  routingReason: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface NewEscalation {
  callSid: string;
  mode: OnCallMode;
  routing: RoutingFacts;
  plan: ChainPlan;
  details: StoredDetails | null;
  callerNumber: string | null;
  /** The first attempt in the background, normally a minute after the transfer failed. */
  nextAt: Date;
  levelStartedAt: Date;
  /** Attempt 1 of level 0 was the in-call transfer, so the background starts at 2. */
  attemptNo: number;
}

export interface NewAttempt {
  escalationId: number;
  callSid: string;
  levelIndex: number;
  role: string;
  providerId: number | null;
  kind: AttemptKind;
  attemptNo: number;
  mode: OnCallMode;
  dialedTo: string | null;
  outcome?: AttemptOutcome;
  providerCallSid?: string | null;
  smsSid?: string | null;
  routingReason?: string | null;
  endedAt?: Date | null;
}

/** The fields the runner moves; `version` must match for the write to land. */
export interface EscalationPatch {
  status?: EscalationStatus;
  levelIndex?: number;
  attemptNo?: number;
  phase?: EscalationPhase;
  nextAt?: Date | null;
  levelStartedAt?: Date;
  acceptedBy?: number | null;
  acceptedAt?: Date | null;
  /** Clear the lease (the runner is done with the row for now). */
  releaseLease?: boolean;
}

export interface OnCallStore {
  /** The six tables exist. False means: take today's path. */
  available(): Promise<boolean>;
  loadRotation(): Promise<RotationData>;
  /** Opens one escalation per call; a second open for the same call returns null. */
  openEscalation(e: NewEscalation): Promise<EscalationRow | null>;
  getEscalation(id: number): Promise<EscalationRow | null>;
  getEscalationByCall(callSid: string): Promise<EscalationRow | null>;
  /** Active rows due now, leased to this caller for `leaseMs`. */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<EscalationRow[]>;
  /** The new row, or null when someone else moved it first. */
  updateEscalation(id: number, version: number, patch: EscalationPatch): Promise<EscalationRow | null>;
  /** Terminal: the patient details and callback number are dropped from the row. */
  closeEscalation(id: number, version: number, patch: EscalationPatch & { status: Exclude<EscalationStatus, "active"> }): Promise<EscalationRow | null>;
  logAttempt(a: NewAttempt): Promise<AttemptRow>;
  setAttemptCallSid(attemptId: number, providerCallSid: string): Promise<void>;
  /** Ends an attempt once; a second end returns null. */
  endAttempt(attemptId: number, outcome: Exclude<AttemptOutcome, "in_progress">, at: Date): Promise<AttemptRow | null>;
  getAttempt(attemptId: number): Promise<AttemptRow | null>;
  attemptsFor(callSid: string): Promise<AttemptRow[]>;
}

// ── Table presence ──────────────────────────────────────────────────────────

export const ON_CALL_TABLES = [
  "on_call_providers",
  "on_call_escalation_directors",
  "on_call_schedule",
  "on_call_overrides",
  "on_call_escalations",
  "on_call_attempts",
] as const;

const TABLES_SQL = `
  select table_name from information_schema.tables
   where table_schema = 'public' and table_name = any($1::text[])`;

const ABSENT_RECHECK_MS = 10 * 60_000;

/** Remembers present; re-checks absent or unreadable every ten minutes. */
export function createTableCheck(
  query: Query,
  now: () => number = Date.now,
  log: (line: string) => void = console.log,
): () => Promise<boolean> {
  let known: boolean | undefined;
  let checkedAt = 0;
  let announced = false;
  let inflight: Promise<boolean> | null = null;
  return async () => {
    if (known === true) return true;
    if (known === false && now() - checkedAt < ABSENT_RECHECK_MS) return false;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { rows } = await query(TABLES_SQL, [ON_CALL_TABLES]);
        const found = new Set(rows.map((r) => String(r.table_name)));
        known = ON_CALL_TABLES.every((t) => found.has(t));
      } catch {
        known = false;
      }
      checkedAt = now();
      if (!known && !announced) {
        announced = true;
        log(
          "[on-call] the on_call_* tables are not on the Hub yet; urgent after-hours calls keep the fixed on-call number until migrations/add_on_call_rotation.sql is applied",
        );
      }
      if (known) log("[on-call] the on_call_* tables are present; the rotation is in use");
      return known;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  };
}

// ── Row mapping ─────────────────────────────────────────────────────────────

function date(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

export function escalationFromRow(r: any): EscalationRow {
  return {
    id: Number(r.id),
    callSid: String(r.call_sid),
    mode: r.mode,
    status: r.status,
    levelIndex: Number(r.level_index),
    attemptNo: Number(r.attempt_no),
    phase: r.phase,
    nextAt: date(r.next_at),
    levelStartedAt: date(r.level_started_at)!,
    routing: json<RoutingFacts>(r.routing),
    plan: json<ChainPlan>(r.plan),
    details: r.details === null || r.details === undefined ? null : json<StoredDetails>(r.details),
    callerNumber: r.caller_number ?? null,
    acceptedBy: r.accepted_by === null || r.accepted_by === undefined ? null : Number(r.accepted_by),
    acceptedAt: date(r.accepted_at),
    version: Number(r.version),
    createdAt: date(r.created_at)!,
  };
}

export function attemptFromRow(r: any): AttemptRow {
  return {
    id: Number(r.id),
    escalationId: Number(r.escalation_id),
    callSid: String(r.call_sid),
    levelIndex: Number(r.level_index),
    role: String(r.role),
    providerId: r.provider_id === null || r.provider_id === undefined ? null : Number(r.provider_id),
    kind: r.kind,
    attemptNo: Number(r.attempt_no),
    mode: r.mode,
    dialedTo: r.dialed_to ?? null,
    outcome: r.outcome,
    providerCallSid: r.provider_call_sid ?? null,
    smsSid: r.sms_sid ?? null,
    routingReason: r.routing_reason ?? null,
    startedAt: date(r.started_at)!,
    endedAt: date(r.ended_at),
  };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

export const SQL = {
  providers: `select id, full_name, npi, phone, email, region, rotation_order, active from on_call_providers`,
  schedule: `select to_char(week_starts_on, 'YYYY-MM-DD') as week, provider_id from on_call_schedule`,
  overrides: `select id, starts_at, ends_at, provider_id from on_call_overrides where ends_at > now() - interval '1 day'`,
  directors: `select region, provider_id from on_call_escalation_directors`,
  open: `
    insert into on_call_escalations
      (call_sid, mode, status, level_index, attempt_no, phase, next_at, level_started_at, routing, plan, details, caller_number)
    values ($1::text, $2::text, 'active', 0, $3::integer, 'due', $4::timestamptz, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::text)
    on conflict (call_sid) do nothing
    returning *`,
  byId: `select * from on_call_escalations where id = $1::integer`,
  byCall: `select * from on_call_escalations where call_sid = $1::text`,
  claimDue: `
    update on_call_escalations set lease_until = $2::timestamptz, version = version + 1, updated_at = now()
     where id in (
       select id from on_call_escalations
        where status = 'active' and next_at <= $1::timestamptz
          and (lease_until is null or lease_until < $1::timestamptz)
        order by next_at
        limit $3::integer
        for update skip locked)
    returning *`,
  update: `
    update on_call_escalations set
      status = coalesce($3::text, status),
      level_index = coalesce($4::integer, level_index),
      attempt_no = coalesce($5::integer, attempt_no),
      phase = coalesce($6::text, phase),
      next_at = case when $7::boolean then $8::timestamptz else next_at end,
      level_started_at = coalesce($9::timestamptz, level_started_at),
      accepted_by = case when $10::boolean then $11::integer else accepted_by end,
      accepted_at = case when $10::boolean then $12::timestamptz else accepted_at end,
      lease_until = case when $13::boolean then null else lease_until end,
      details = case when $14::boolean then null else details end,
      caller_number = case when $14::boolean then null else caller_number end,
      version = version + 1,
      updated_at = now()
    where id = $1::integer and version = $2::integer
    returning *`,
  logAttempt: `
    insert into on_call_attempts
      (escalation_id, call_sid, level_index, role, provider_id, kind, attempt_no, mode, dialed_to, outcome, provider_call_sid, sms_sid, routing_reason, ended_at)
    values ($1::integer, $2::text, $3::integer, $4::text, $5::integer, $6::text, $7::integer, $8::text, $9::text, $10::text, $11::text, $12::text, $13::text, $14::timestamptz)
    returning *`,
  setAttemptCallSid: `update on_call_attempts set provider_call_sid = $2::text where id = $1::integer`,
  endAttempt: `
    update on_call_attempts set outcome = $2::text, ended_at = $3::timestamptz
     where id = $1::integer and outcome = 'in_progress'
    returning *`,
  attempt: `select * from on_call_attempts where id = $1::integer`,
  attemptsFor: `select * from on_call_attempts where call_sid = $1::text order by started_at, id`,
} as const;

function updateParams(id: number, version: number, p: EscalationPatch, terminal: boolean): unknown[] {
  return [
    id,
    version,
    p.status ?? null,
    p.levelIndex ?? null,
    p.attemptNo ?? null,
    p.phase ?? null,
    "nextAt" in p,
    p.nextAt ? p.nextAt.toISOString() : null,
    p.levelStartedAt ? p.levelStartedAt.toISOString() : null,
    "acceptedBy" in p || "acceptedAt" in p,
    p.acceptedBy ?? null,
    p.acceptedAt ? p.acceptedAt.toISOString() : null,
    Boolean(p.releaseLease),
    terminal,
  ];
}

export function providerFromRow(r: any): OnCallProvider {
  return {
    id: Number(r.id),
    fullName: String(r.full_name),
    npi: r.npi ?? null,
    phone: String(r.phone),
    email: r.email ?? null,
    region: String(r.region),
    rotationOrder: r.rotation_order === null || r.rotation_order === undefined ? null : Number(r.rotation_order),
    active: Boolean(r.active),
  };
}

export function createPgOnCallStore(
  query: Query = defaultQuery,
  deps: { now?: () => number; log?: (line: string) => void } = {},
): OnCallStore {
  const available = createTableCheck(query, deps.now, deps.log);
  return {
    available,
    async loadRotation() {
      const [p, s, o, d] = await Promise.all([
        query(SQL.providers),
        query(SQL.schedule),
        query(SQL.overrides),
        query(SQL.directors),
      ]);
      const overrides: OnCallOverride[] = o.rows.map((r) => ({
        id: Number(r.id),
        startsAt: date(r.starts_at)!,
        endsAt: date(r.ends_at)!,
        providerId: Number(r.provider_id),
      }));
      return {
        providers: p.rows.map(providerFromRow),
        schedule: new Map(s.rows.map((r) => [String(r.week), Number(r.provider_id)])),
        overrides,
        directors: new Map(d.rows.map((r) => [regionKey(String(r.region)), Number(r.provider_id)])),
      };
    },
    async openEscalation(e) {
      const { rows } = await query(SQL.open, [
        e.callSid,
        e.mode,
        e.attemptNo,
        e.nextAt.toISOString(),
        e.levelStartedAt.toISOString(),
        JSON.stringify(e.routing),
        JSON.stringify(e.plan),
        e.details ? JSON.stringify(e.details) : null,
        e.callerNumber,
      ]);
      return rows[0] ? escalationFromRow(rows[0]) : null;
    },
    async getEscalation(id) {
      const { rows } = await query(SQL.byId, [id]);
      return rows[0] ? escalationFromRow(rows[0]) : null;
    },
    async getEscalationByCall(callSid) {
      const { rows } = await query(SQL.byCall, [callSid]);
      return rows[0] ? escalationFromRow(rows[0]) : null;
    },
    async claimDue(now, leaseMs, limit) {
      const { rows } = await query(SQL.claimDue, [
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        limit,
      ]);
      return rows.map(escalationFromRow);
    },
    async updateEscalation(id, version, patch) {
      const { rows } = await query(SQL.update, updateParams(id, version, patch, false));
      return rows[0] ? escalationFromRow(rows[0]) : null;
    },
    async closeEscalation(id, version, patch) {
      const { rows } = await query(SQL.update, updateParams(id, version, { ...patch, releaseLease: true }, true));
      return rows[0] ? escalationFromRow(rows[0]) : null;
    },
    async logAttempt(a) {
      const { rows } = await query(SQL.logAttempt, [
        a.escalationId,
        a.callSid,
        a.levelIndex,
        a.role,
        a.providerId,
        a.kind,
        a.attemptNo,
        a.mode,
        a.dialedTo,
        a.outcome ?? "in_progress",
        a.providerCallSid ?? null,
        a.smsSid ?? null,
        a.routingReason ?? null,
        a.endedAt ? a.endedAt.toISOString() : null,
      ]);
      return attemptFromRow(rows[0]);
    },
    async setAttemptCallSid(attemptId, providerCallSid) {
      await query(SQL.setAttemptCallSid, [attemptId, providerCallSid]);
    },
    async endAttempt(attemptId, outcome, at) {
      const { rows } = await query(SQL.endAttempt, [attemptId, outcome, at.toISOString()]);
      return rows[0] ? attemptFromRow(rows[0]) : null;
    },
    async getAttempt(attemptId) {
      const { rows } = await query(SQL.attempt, [attemptId]);
      return rows[0] ? attemptFromRow(rows[0]) : null;
    },
    async attemptsFor(callSid) {
      const { rows } = await query(SQL.attemptsFor, [callSid]);
      return rows.map(attemptFromRow);
    },
  };
}
