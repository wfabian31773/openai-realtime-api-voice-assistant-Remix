/**
 * THE AFTER-HOURS ON-CALL ADMIN PAGE (/on-call), its API.
 *
 * Operator, 2026-11-24: "have a fully and completely robust page added to the
 * operations hub so that I can track and swap providers on call and have
 * complete admin control over that screen ... I want to be able to see
 * everything that happens when a call comes in, what we do, what the
 * providers do, as much as possible."
 *
 * Every route is behind the session login AND the admin role, and answers
 * `Cache-Control: no-store` (staff phone numbers ride the providers list).
 *
 * WHO IS ON CALL is answered with the runtime's own `onCallAt` and
 * `planChain` over the same tables the voice agent reads, so the page cannot
 * disagree with what a call would do.
 *
 * WRITES: every change requires a reason, runs in one transaction, and writes
 * its on_call_audit_log row in that transaction. A change cannot land without
 * its audit row: no audit table, no change. The validation mirrors
 * scripts/on-call-change.ts (a provider named must be active and have a
 * number, a week starts on a Tuesday, a region must already have a director
 * unless it is declared new, FINAL is not a region a provider works in).
 *
 * NOTHING HERE TOUCHES src/runtime/**, Twilio, or phone routing.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import { readOnCallConfig, onCallHealth, readFinalFallback, rotationCallerId } from "../src/runtime/onCall/config";
import {
  activeOverride,
  addDays,
  FINAL_REGION,
  onCallAt,
  pacificMinute,
  planChain,
  withOperationsFallback,
  regionKey,
  rotationWeekStart,
  type OnCallAnswer,
  type RotationData,
} from "../src/runtime/onCall/rotation";
import {
  ATTEMPTS_PER_LEVEL,
  LEVEL_RETRY_DEADLINE_MS,
  PROVIDER_RING_SECONDS,
  RETRY_GAP_MS,
  RING_GUARD_MS,
  STALE_ESCALATION_MS,
  TICK_MS,
} from "../src/runtime/onCall/runner";
import { POST_OP_BUDGET_MS, ROTATION_CACHE_MS, ROUTING_BUDGET_MS } from "../src/runtime/onCall/routing";
import {
  goLive,
  isDialable,
  isTuesday,
  last4,
  mergeTimeline,
  normalizePhone,
  outcomeSummary,
  overlapping,
  pacificWallToDate,
  planExtension,
  extensionRefusal,
  planReorder,
  scheduleView,
  weekStartInstant,
  type CallLogLite,
} from "./onCallAdmin/logic";
import type { AdminProvider, AuditEntry, DirectorRow, OnCallAdminStore, OnCallAdminTx, ProviderPatch } from "./onCallAdmin/store";

export interface OnCallAdminDeps {
  authenticate: RequestHandler;
  admin: RequestHandler;
  store: () => OnCallAdminStore | null;
  env: Record<string, string | undefined>;
  /** Who is making the change, for the audit row. */
  actor: (req: Request) => Promise<{ userId: string | null; email: string | null }>;
  now?: () => Date;
}

export const ON_CALL_API = "/api/on-call";

/**
 * A store getter that builds one store per database pool. server/db.ts
 * reassigns its exported `pool` on a pooler failover or a recycle and drains
 * the old one, so a store cached on the first pool would keep using a closed
 * pool until the process restarted. `currentPool` is read on every call.
 */
export function storePerPool<P, S>(currentPool: () => P, create: (pool: P) => S): () => S {
  let cached: { pool: P; store: S } | null = null;
  return () => {
    const pool = currentPool();
    if (!cached || cached.pool !== pool) cached = { pool, store: create(pool) };
    return cached.store;
  };
}

export const TABLES_NOT_APPLIED =
  "The on-call tables are not on the Hub yet. Apply migrations/add_on_call_rotation.sql (and then migrations/add_on_call_admin.sql); until then urgent after-hours calls ring the fixed on-call number.";
export const AUDIT_NOT_APPLIED =
  "The audit table is not on the Hub yet. Apply migrations/add_on_call_admin.sql; every change from this page writes an audit row, so changes are refused until it exists.";

/** A refusal the page shows as is: a 4xx with the reason, never a 500. */
export class AdminRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The open decisions from docs/ON_CALL_ROTATION.md section 8, plus the gaps
 * the operator should know about before go-live. Shown as an info panel.
 */
export const OPEN_DECISIONS = [
  "A surgery not yet marked kept in NextGen still routes to the surgeon (ON_CALL_POST_OP_REQUIRE_KEPT=1 sends it to on-call instead).",
  "On a post-op call the chain is surgeon → surgeon's region director → final director; the week's on-call provider is NOT rung on that call.",
  "A surgeon who is not in the provider pool routes to on-call, and the text says so.",
  "A week nobody is scheduled for rings only the final director.",
  "The fixed fallback number is HUMAN_AGENT_NUMBER (the old core used NO_IVR_HUMAN_AGENT_NUMBER for this line).",
  "A pickup with no key press is logged 'declined' and the chain carries on (voicemail and a provider who hung up look the same).",
  "A closed holiday on a Tuesday: its daytime hours go to the OUTGOING week's provider; use an override if the incoming provider should take them.",
  "CLOSED (operator, 2026-11-24): after the final director the chain calls the operations fallback (Wayne) at ON_CALL_FINAL_FALLBACK_NUMBER, with the same cadence as every level. Unset, an exhausted chain only texts URGENT_NOTIFICATION_NUMBER, as before.",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

export const EXTEND_PLAN_CHANGED = "The schedule changed since your preview; preview again.";

/** The previewed plan the client confirmed equals the plan computed now, week for week. */
export function samePlan(confirmed: unknown, current: Array<{ week: string; providerId: number }>): boolean {
  if (!Array.isArray(confirmed) || confirmed.length !== current.length) return false;
  return current.every((w, i) => {
    const c = confirmed[i] as { week?: unknown; providerId?: unknown } | null;
    return !!c && c.week === w.week && Number(c.providerId) === w.providerId;
  });
}

/**
 * The override ids the admin confirmed overlapping are exactly the overlaps
 * now. A boolean would also approve a conflict added after the warning.
 */
export function sameOverlapIds(confirmed: unknown, current: readonly number[]): boolean {
  if (!Array.isArray(confirmed) || confirmed.length !== current.length) return false;
  const a = confirmed.map(Number).sort((x, y) => x - y);
  const b = [...current].sort((x, y) => x - y);
  return a.every((id, i) => Number.isInteger(id) && id === b[i]);
}

function toRotationData(
  providers: AdminProvider[],
  schedule: Array<{ week: string; providerId: number }>,
  overrides: Array<{ id: number; startsAt: Date; endsAt: Date; providerId: number }>,
  directors: DirectorRow[],
): RotationData {
  return {
    providers,
    schedule: new Map(schedule.map((r) => [r.week, r.providerId])),
    overrides: overrides.map((o) => ({ id: o.id, startsAt: o.startsAt, endsAt: o.endsAt, providerId: o.providerId })),
    directors: new Map(directors.map((d) => [regionKey(d.region), d.providerId])),
  };
}

function reasonOf(body: any): string {
  const r = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!r) throw new AdminRefusal(400, "A reason is required for every change.");
  if (r.length > 1000) throw new AdminRefusal(400, "The reason is longer than 1000 characters.");
  return r;
}

function intOf(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new AdminRefusal(400, `${what} must be a whole number.`);
  return n;
}

/**
 * A number the rotation can ring: the runtime's DIALABLE shape, and not the
 * rotation's own caller ID (Twilio refuses a call from a number to itself; the
 * same rule config.ts applies to ON_CALL_FINAL_FALLBACK_NUMBER).
 */
function ringsFrom(phone: string | null | undefined, callerId: string | null): boolean {
  return isDialable(phone) && !(callerId && phone === callerId);
}

const CALLER_ID_REFUSAL = "That number is the rotation's own caller ID (ON_CALL_CALLER_ID or TWILIO_PHONE_NUMBER); the chain cannot call a number from itself. Enter the provider's own phone.";

/** The provider a change names: on file, active, with a number the chain can dial. */
function ringableProvider(providers: AdminProvider[], id: number, callerId: string | null): AdminProvider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new AdminRefusal(400, `Provider #${id} is not on file.`);
  if (!p.active) throw new AdminRefusal(400, `${p.fullName} is inactive; reactivate them first.`);
  if (!isDialable(p.phone)) throw new AdminRefusal(400, `${p.fullName} has no dialable phone number on file.`);
  if (!ringsFrom(p.phone, callerId)) {
    throw new AdminRefusal(400, `${p.fullName}'s phone on file is the rotation's own caller ID; the chain cannot call it. Edit their phone first.`);
  }
  return p;
}

/** Strip a provider to what a non-providers view may show: phone as last-4. */
function publicProvider(p: AdminProvider | null | undefined) {
  if (!p) return null;
  return { id: p.id, fullName: p.fullName, region: p.region, active: p.active, phoneLast4: last4(p.phone), rotationOrder: p.rotationOrder };
}

function auditSnapshot(p: AdminProvider | null | undefined) {
  // The audit log keeps the change, including the phone, because the phone IS
  // what an admin edits. It is staff data, server-role only (RLS on).
  if (!p) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
}

/**
 * An edit body without the fields that read exactly as they are on file, so a
 * resubmitted unchanged field is neither validated nor written. A region kept
 * as it is also drops its newRegion flag.
 */
export function changedFields(body: Record<string, unknown>, before: AdminProvider): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const same = (k: "fullName" | "phone" | "npi" | "email" | "region", norm: (s: string) => string = (s) => s.trim()) =>
    body[k] !== undefined && norm(String(body[k] ?? "")) === norm(String(before[k] ?? ""));
  const spaces = (s: string) => s.trim().replace(/\s+/g, " ");
  if (same("fullName", spaces)) delete out.fullName;
  if (same("phone")) delete out.phone;
  if (same("npi", (s) => s.replace(/\D/g, ""))) delete out.npi;
  if (same("email")) delete out.email;
  if (same("region", spaces)) {
    delete out.region;
    delete out.newRegion;
  }
  return out;
}

function describe(ans: OnCallAnswer, data: RotationData, at: Date, fallbackPhone: string | undefined, callerId: string | null) {
  // The chain the runtime would plan, the operations fallback (Wayne) included
  // when ON_CALL_FINAL_FALLBACK_NUMBER is set.
  const plan = withOperationsFallback(planChain(ans.provider ? { role: "on_call", provider: ans.provider } : null, data), fallbackPhone);
  const byId = new Map(data.providers.map((p) => [p.id, p]));
  return {
    at: at.toISOString(),
    window: ans.window,
    weekStartsOn: ans.weekStartsOn,
    source: ans.source,
    note: ans.note ?? null,
    provider: publicProvider(ans.provider as AdminProvider | null),
    // The runtime's own pick (latest start, then latest id), not the first match.
    override: ans.source === "override" ? activeOverride(at, data.overrides) : null,
    director: publicProvider(ans.director as AdminProvider | null),
    final: publicProvider(ans.final as AdminProvider | null),
    chain: {
      levels: plan.levels.map((l, i) => {
        const p = byId.get(l.providerId);
        return { index: i, role: l.role, providerId: l.providerId, name: l.name, region: p?.region ?? null, phoneLast4: last4(l.phone), dialable: isDialable(l.phone),
          // The runtime does not skip this level; Twilio refuses the call (source = destination).
          isCallerId: isDialable(l.phone) && !ringsFrom(l.phone, callerId) };
      }),
      notes: plan.notes,
      // Whether ON_CALL_FINAL_FALLBACK_NUMBER is set, so the page can say "not
      // configured" when the chain ends at the final director.
      operationsFallbackConfigured: Boolean(fallbackPhone),
    },
  };
}

/** Any `phone` value, at any depth, as its last four digits. */
/**
 * The Calls tab shows phones by their last four only (full phones live on the
 * Providers tab). Masks phone-named keys, and any full E.164 number inside a
 * string anywhere in the response (routing JSON, tool arguments, event data).
 */
/**
 * A phone number written inside free text (a transcript line, a summary, an
 * event message), in the forms a transcriber or a person writes one:
 * E.164 ("+14155550123") and any formatted "+" number ("+44 20 7946 0958"), US with an optional +1 / 1 and parentheses,
 * spaces, dots or dashes ("(415) 555-0123", "1.415.555.0123"), ten or eleven
 * bare digits, and digits read out one at a time ("4 1 5 5 5 5 0 1 2 3").
 * Bounded by non-word characters, so a digit run inside a SID or a ticket
 * number ("VA-84772") is left alone; dates ("03/17/1973", "2026-12-05"),
 * times and ISO instants have the wrong grouping and do not match.
 * Review of #520: only the bare "+" form was masked before.
 */
const PHONE_IN_TEXT = new RegExp(
  [
    // Any "+" number, 7 to 15 digits, groups split by a space, dot, dash or
    // parenthesis ("+44 20 7946 0958", "+1 (415) 555-0123"); review of #520, round 3.
    String.raw`\+\d(?:[ .()-]{0,2}\d){6,14}`,
    String.raw`(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}`,
    String.raw`(?:\d[ ,.-]{1,2}){9,10}\d`,
  ]
    .map((p) => `(?<![\\w+])${p}(?![\\w])`)
    .join("|"),
  "g",
);

function maskPhonesInText(s: string): string {
  return s.replace(PHONE_IN_TEXT, (m) => {
    const digits = m.replace(/\D/g, "");
    const isPhone = m.startsWith("+") ? digits.length >= 7 && digits.length <= 15 : digits.length === 10 || (digits.length === 11 && digits[0] === "1");
    return isPhone ? last4(digits) ?? m : m;
  });
}

export function maskCallPhones(v: unknown): unknown {
  if (typeof v === "string") return maskPhonesInText(v);
  if (Array.isArray(v)) return v.map(maskCallPhones);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, /phone/i.test(k) && typeof x === "string" ? last4(x) : maskCallPhones(x)]),
  );
}

export function maskPhones(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskPhones);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, /phone/i.test(k) && typeof x === "string" ? last4(x) : maskPhones(x)]),
  );
}

function parseInstant(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const pac = pacificWallToDate(raw);
  if (pac) return pac;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) || !/\d{4}-\d{2}-\d{2}T/.test(raw) ? null : d;
}

// ── Mount ───────────────────────────────────────────────────────────────────

export function mountOnCallAdmin(app: Express, deps: OnCallAdminDeps) {
  const now = deps.now ?? (() => new Date());
  const guard = [deps.authenticate, deps.admin];
  /** The rotation's caller ID as the runtime resolves it, read per request. */
  const callerId = () => rotationCallerId(deps.env);

  type Handler = (req: Request, res: Response, store: OnCallAdminStore) => Promise<unknown>;

  /** Read route: needs the rotation tables. */
  const read = (handler: Handler): RequestHandler => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const store = deps.store();
    if (!store) return void res.status(503).json({ error: "on_call_store_unavailable" });
    try {
      const t = await store.tables();
      if (!t.rotation) return void res.status(409).json({ error: "on_call_tables_not_applied", message: TABLES_NOT_APPLIED, missing: t.missing });
      res.json(await handler(req, res, store));
    } catch (e) {
      if (e instanceof AdminRefusal) return void res.status(e.status).json({ error: e.message, ...e.extra });
      console.error("[on-call admin] read failed:", (e as Error)?.message);
      res.status(500).json({ error: "The on-call data could not be read." });
    }
  };

  /** Write route: needs both migrations, a reason, and runs in one transaction with its audit row. */
  const write = (
    handler: (req: Request, tx: OnCallAdminTx, audit: (e: Omit<AuditEntry, "actorUserId" | "actorEmail" | "reason">) => Promise<void>, reason: string) => Promise<unknown>,
  ): RequestHandler => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const store = deps.store();
    if (!store) return void res.status(503).json({ error: "on_call_store_unavailable" });
    try {
      const t = await store.tables();
      if (!t.rotation) return void res.status(409).json({ error: "on_call_tables_not_applied", message: TABLES_NOT_APPLIED, missing: t.missing });
      if (!t.admin) return void res.status(409).json({ error: "on_call_audit_not_applied", message: AUDIT_NOT_APPLIED, missing: t.missing });
      const reason = reasonOf(req.body);
      const actor = await deps.actor(req);
      let audited = 0;
      const result = await store.transaction(async (tx) => {
        const audit = async (e: Omit<AuditEntry, "actorUserId" | "actorEmail" | "reason">) => {
          await tx.audit({ ...e, reason, actorUserId: actor.userId, actorEmail: actor.email });
          audited++;
        };
        const out = await handler(req, tx, audit, reason);
        // A change that wrote no audit row must not land.
        if (audited === 0) throw new Error("no audit row was written for this change");
        return out;
      });
      res.json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
    } catch (e) {
      if (e instanceof AdminRefusal) return void res.status(e.status).json({ error: e.message, ...e.extra });
      console.error("[on-call admin] write failed, nothing changed:", (e as Error)?.message);
      res.status(500).json({ error: "The change could not be saved; nothing was changed." });
    }
  };

  const loadAll = async (s: Pick<OnCallAdminStore, "providers" | "schedule" | "overrides" | "directors">) => {
    const [providers, schedule, overrides, directors] = await Promise.all([s.providers(), s.schedule(), s.overrides(), s.directors()]);
    return { providers, schedule, overrides, directors, data: toRotationData(providers, schedule, overrides, directors) };
  };

  // ── Status ────────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/status`, ...guard, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const env = deps.env;
    const cfg = readOnCallConfig(env);
    const store = deps.store();
    let tables: { rotation: boolean; admin: boolean; missing: string[] } | null = null;
    try {
      tables = store ? await store.tables() : null;
    } catch {
      tables = null;
    }
    const configured = (env.ON_CALL_TEST_PHONES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    res.json({
      now: now().toISOString(),
      tables: tables ?? { rotation: false, admin: false, missing: [], unreadable: true },
      tablesMessage: !tables?.rotation ? TABLES_NOT_APPLIED : !tables.admin ? AUDIT_NOT_APPLIED : null,
      config: {
        ...onCallHealth(cfg),
        rawMode: (env.ON_CALL_ROTATION_MODE ?? "").trim() || "(unset)",
        testPhonesLast4: configured.map((p) => last4(p)),
        callerIdLast4: last4(cfg.callerId || rotationCallerId(env) || ""),
        urgentNotificationLast4: last4(env.URGENT_NOTIFICATION_NUMBER),
        fallbackNumberLast4: last4(env.HUMAN_AGENT_NUMBER),
        // The operations fallback level (Wayne), read whatever the mode, so the
        // page can say "not configured" or show the last four digits.
        finalFallbackLast4: last4(readFinalFallback(env).finalFallbackPhone ?? ""),
        finalFallbackProblem: readFinalFallback(env).finalFallbackProblem ?? null,
        transferMode: (env.RUNTIME_TRANSFER_MODE ?? "").trim() || "(default)",
      },
      goLive: goLive(now()),
    });
  });

  // ── Who is on call ────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/now`, ...guard, read(async (_req, _res, store) => {
    const { data } = await loadAll(store);
    const t = now();
    const current = onCallAt(t, data);
    const nextWeekAt = weekStartInstant(addDays(rotationWeekStart(t), 7));
    const p = pacificMinute(t);
    const nextWindowAt = current.window.onCall ? null : pacificWallToDate(`${p.date} 17:00`);
    const fb = readFinalFallback(deps.env).finalFallbackPhone;
    const cid = callerId();
    return {
      now: describe(current, data, t, fb, cid),
      nextWindow: nextWindowAt ? describe(onCallAt(nextWindowAt, data), data, nextWindowAt, fb, cid) : null,
      nextWeek: describe(onCallAt(nextWeekAt, data), data, nextWeekAt, fb, cid),
    };
  }));

  app.get(`${ON_CALL_API}/preview`, ...guard, read(async (req, _res, store) => {
    const at = parseInstant(req.query.at);
    if (!at) throw new AdminRefusal(400, "at must be a Pacific date and time (YYYY-MM-DDTHH:MM).");
    const { data } = await loadAll(store);
    return { preview: describe(onCallAt(at, data), data, at, readFinalFallback(deps.env).finalFallbackPhone, callerId()) };
  }));

  // ── Schedule ──────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/schedule`, ...guard, read(async (req, _res, store) => {
    const { providers, schedule, overrides } = await loadAll(store);
    const t = now();
    const current = rotationWeekStart(t);
    const lastWeek = schedule.length ? schedule[schedule.length - 1].week : current;
    const from = typeof req.query.from === "string" && isTuesday(req.query.from) ? req.query.from : addDays(current, -28);
    const defaultTo = lastWeek > addDays(current, 12 * 7) ? lastWeek : addDays(current, 12 * 7);
    const to = typeof req.query.to === "string" && isTuesday(req.query.to) ? req.query.to : defaultTo;
    if (to < from) throw new AdminRefusal(400, "to is before from.");
    const weeks = scheduleView({ fromWeek: from, toWeek: to, rows: schedule, overrides, providers, now: t });
    return {
      from,
      to,
      currentWeek: current,
      firstScheduledWeek: schedule[0]?.week ?? null,
      lastScheduledWeek: schedule.length ? lastWeek : null,
      weeks,
      gaps: weeks.filter((w) => w.gap).map((w) => w.week),
      providers: providers.map(publicProvider),
    };
  }));

  /** A whole week to a provider: swaps an existing week, or fills a gap. */
  app.post(`${ON_CALL_API}/schedule/assign`, ...guard, write(async (req, tx, audit, reason) => {
    const week = String(req.body?.week ?? "");
    if (!isTuesday(week)) throw new AdminRefusal(400, `${week || "The week"} is not a Tuesday (a week starts on Tuesday at 5:00 PM).`);
    const providerId = intOf(req.body?.providerId, "providerId");
    const providers = await tx.providers();
    const p = ringableProvider(providers, providerId, callerId());
    const before = (await tx.schedule()).find((r) => r.week === week) ?? null;
    if (before?.providerId === providerId) throw new AdminRefusal(400, `${p.fullName} already has the week of ${week}.`);
    const note = `${before ? "swapped" : "assigned"} to ${p.fullName}: ${reason}`.slice(0, 500);
    if (before) await tx.setWeekProvider(week, providerId, note);
    else await tx.insertWeek(week, providerId, note);
    await audit({
      action: before ? "schedule.swap_week" : "schedule.fill_week",
      entityType: "schedule",
      entityId: week,
      before,
      after: { week, providerId, providerName: p.fullName, note },
    });
    return { week, providerId };
  }));

  app.post(`${ON_CALL_API}/schedule/swap-weeks`, ...guard, write(async (req, tx, audit) => {
    const a = String(req.body?.weekA ?? "");
    const b = String(req.body?.weekB ?? "");
    if (!isTuesday(a) || !isTuesday(b)) throw new AdminRefusal(400, "Both weeks must be Tuesdays.");
    if (a === b) throw new AdminRefusal(400, "Pick two different weeks.");
    const rows = await tx.schedule();
    const ra = rows.find((r) => r.week === a);
    const rb = rows.find((r) => r.week === b);
    if (!ra || !rb) throw new AdminRefusal(400, `The week of ${!ra ? a : b} is not on the schedule.`);
    if (ra.providerId === rb.providerId) throw new AdminRefusal(400, "Both weeks already have the same provider.");
    const providers = await tx.providers();
    const pa = ringableProvider(providers, rb.providerId, callerId());
    const pb = ringableProvider(providers, ra.providerId, callerId());
    await tx.setWeekProvider(a, rb.providerId, `swapped with ${b} (${pa.fullName})`);
    await tx.setWeekProvider(b, ra.providerId, `swapped with ${a} (${pb.fullName})`);
    await audit({
      action: "schedule.swap_two_weeks",
      entityType: "schedule",
      entityId: `${a},${b}`,
      before: { [a]: ra.providerId, [b]: rb.providerId },
      after: { [a]: rb.providerId, [b]: ra.providerId },
    });
    return { weeks: [a, b] };
  }));

  /** The same weeks scripts/on-call-change.ts `extend` adds. `dryRun` shows them without writing. */
  app.post(`${ON_CALL_API}/schedule/extend`, ...guard, async (req, res, next) => {
    if (req.body?.dryRun !== true) return next();
    res.setHeader("Cache-Control", "no-store");
    const store = deps.store();
    if (!store) return void res.status(503).json({ error: "on_call_store_unavailable" });
    try {
      const t = await store.tables();
      if (!t.rotation) return void res.status(409).json({ error: "on_call_tables_not_applied", message: TABLES_NOT_APPLIED });
      const [providers, schedule] = await Promise.all([store.providers(), store.schedule()]);
      const plan = planExtension(schedule[schedule.length - 1] ?? null, providers, Number(req.body?.weeks));
      if (!plan.ok) return void res.status(400).json({ error: plan.error });
      // The weeks are shown even when the extension would be refused, so the
      // admin can see which week needs a fixed number.
      res.json({
        ok: true,
        dryRun: true,
        weeks: plan.weeks.map((w) => ({ ...w, providerName: providers.find((p) => p.id === w.providerId)?.fullName ?? null })),
        refusal: extensionRefusal(plan.weeks, providers, callerId()),
      });
    } catch {
      res.status(500).json({ error: "The on-call data could not be read." });
    }
  });
  app.post(`${ON_CALL_API}/schedule/extend`, ...guard, write(async (req, tx, audit) => {
    const [providers, schedule] = await Promise.all([tx.providers(), tx.schedule()]);
    const plan = planExtension(schedule[schedule.length - 1] ?? null, providers, Number(req.body?.weeks));
    if (!plan.ok) throw new AdminRefusal(400, plan.error);
    const refusal = extensionRefusal(plan.weeks, providers, callerId());
    if (refusal) throw new AdminRefusal(400, refusal);
    // The weeks the admin approved in the preview, compared under the write
    // lock with what would be written now: another admin or the CLI may have
    // extended the schedule or reordered providers since.
    if (!samePlan(req.body?.plan, plan.weeks)) throw new AdminRefusal(409, EXTEND_PLAN_CHANGED, { planChanged: true });
    for (const w of plan.weeks) await tx.insertWeek(w.week, w.providerId, "added by the on-call admin page (extend)");
    await audit({
      action: "schedule.extend",
      entityType: "schedule",
      entityId: `${plan.weeks[0].week}..${plan.weeks[plan.weeks.length - 1].week}`,
      before: null,
      after: plan.weeks,
    });
    return { weeks: plan.weeks };
  }));

  // ── Overrides ─────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/overrides`, ...guard, read(async (_req, _res, store) => {
    const [overrides, providers] = await Promise.all([store.overrides(), store.providers()]);
    const t = now();
    return {
      overrides: overrides
        .map((o) => ({
          ...o,
          startsAt: o.startsAt.toISOString(),
          endsAt: o.endsAt.toISOString(),
          createdAt: o.createdAt?.toISOString() ?? null,
          providerName: providers.find((p) => p.id === o.providerId)?.fullName ?? null,
          state: o.endsAt <= t ? "past" : o.startsAt <= t ? "active" : "upcoming",
        }))
        .reverse(),
    };
  }));

  app.post(`${ON_CALL_API}/overrides`, ...guard, write(async (req, tx, audit, reason) => {
    const startsAt = pacificWallToDate(String(req.body?.startsAt ?? ""));
    const endsAt = pacificWallToDate(String(req.body?.endsAt ?? ""));
    if (!startsAt || !endsAt) throw new AdminRefusal(400, "Start and end must be Pacific dates and times (YYYY-MM-DDTHH:MM).");
    if (endsAt <= startsAt) throw new AdminRefusal(400, "The end must be after the start.");
    if (endsAt <= now()) throw new AdminRefusal(400, "That window is already over.");
    const providerId = intOf(req.body?.providerId, "providerId");
    const p = ringableProvider(await tx.providers(), providerId, callerId());
    const clash = overlapping(await tx.overrides(), startsAt, endsAt);
    const confirmed = req.body?.confirmedOverlapIds;
    if (clash.length && !sameOverlapIds(confirmed, clash.map((o) => o.id))) {
      const changed = Array.isArray(confirmed) && confirmed.length > 0;
      throw new AdminRefusal(409, changed
        ? "The overlapping overrides changed since you confirmed; review them and confirm again."
        : "This window overlaps other overrides; the one that starts latest wins. Confirm to save anyway.", {
        overlap: clash.map((o) => ({ id: o.id, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), providerId: o.providerId })),
      });
    }
    const row = await tx.insertOverride({ startsAt, endsAt, providerId, reason });
    await audit({
      action: "override.create",
      entityType: "override",
      entityId: String(row.id),
      before: null,
      after: { ...row, providerName: p.fullName, overlapped: clash.map((o) => o.id) },
    });
    return { override: { ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() } };
  }));

  /** Upcoming: deleted. Running now: ended now. Over: refused (it is history). */
  app.post(`${ON_CALL_API}/overrides/:id/cancel`, ...guard, write(async (req, tx, audit) => {
    const id = intOf(req.params.id, "id");
    const o = (await tx.overrides()).find((x) => x.id === id);
    if (!o) throw new AdminRefusal(404, `Override #${id} is not on file.`);
    const t = now();
    if (o.endsAt <= t) throw new AdminRefusal(400, "That override is already over; it stays as history.");
    if (o.startsAt > t) {
      await tx.deleteOverride(id);
      await audit({ action: "override.cancel", entityType: "override", entityId: String(id), before: o, after: null });
      return { cancelled: "deleted" };
    }
    await tx.endOverride(id, t);
    await audit({ action: "override.end_now", entityType: "override", entityId: String(id), before: o, after: { ...o, endsAt: t } });
    return { cancelled: "ended_now" };
  }));

  // ── Providers ─────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/providers`, ...guard, read(async (_req, _res, store) => {
    const { providers, schedule, overrides, directors } = await loadAll(store);
    const t = now();
    const current = rotationWeekStart(t);
    return {
      // Full phones: the providers tab is where an admin edits them.
      providers: providers.map((p) => ({
        ...p,
        upcomingWeeks: schedule.filter((r) => r.providerId === p.id && r.week >= current).map((r) => r.week),
        upcomingOverrides: overrides.filter((o) => o.providerId === p.id && o.endsAt > t).length,
        directsRegions: directors.filter((d) => d.providerId === p.id).map((d) => d.region),
        phoneDialable: ringsFrom(p.phone, callerId()),
      })),
      regions: directors.map((d) => d.region),
    };
  }));

  /** Region as on file (a director row's spelling), or a refusal. */
  const regionFor = async (tx: OnCallAdminTx, raw: unknown, newRegion: boolean): Promise<string> => {
    const region = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (!region) throw new AdminRefusal(400, "A region is required.");
    if (regionKey(region) === regionKey(FINAL_REGION)) {
      throw new AdminRefusal(400, `${FINAL_REGION} is the final escalation rung, not a region a provider works in.`);
    }
    const known = (await tx.directors()).find((d) => regionKey(d.region) === regionKey(region));
    if (known) return known.region;
    if (!newRegion) throw new AdminRefusal(400, `Region "${region}" has no escalation director. Check the spelling, or mark it as a new region.`);
    return region;
  };

  const providerFields = async (tx: OnCallAdminTx, body: any, selfId: number | null): Promise<ProviderPatch> => {
    const patch: ProviderPatch = {};
    const providers = await tx.providers();
    const others = providers.filter((p) => p.id !== selfId);
    if (body.fullName !== undefined) {
      const name = String(body.fullName ?? "").trim().replace(/\s+/g, " ");
      if (!name) throw new AdminRefusal(400, "A name is required.");
      if (others.some((p) => p.fullName.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase())) {
        throw new AdminRefusal(400, `A provider named ${name} is already on file.`);
      }
      patch.fullName = name;
    }
    if (body.phone !== undefined) {
      const phone = normalizePhone(String(body.phone ?? ""));
      if (!phone) throw new AdminRefusal(400, "The phone is not a phone number.");
      const cid = callerId();
      if (cid && phone === cid) throw new AdminRefusal(400, CALLER_ID_REFUSAL);
      patch.phone = phone;
    }
    if (body.npi !== undefined) {
      const npi = String(body.npi ?? "").replace(/\D/g, "");
      if (npi && npi.length !== 10) throw new AdminRefusal(400, "The NPI is not 10 digits.");
      if (npi && others.some((p) => p.npi === npi)) throw new AdminRefusal(400, "Another provider already has that NPI.");
      patch.npi = npi || null;
    }
    if (body.email !== undefined) {
      const email = String(body.email ?? "").trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminRefusal(400, "The email is not an email address.");
      patch.email = email || null;
    }
    if (body.region !== undefined) patch.region = await regionFor(tx, body.region, body.newRegion === true);
    return patch;
  };

  app.post(`${ON_CALL_API}/providers`, ...guard, write(async (req, tx, audit) => {
    const body = req.body ?? {};
    for (const k of ["fullName", "phone", "region"]) {
      if (body[k] === undefined || String(body[k]).trim() === "") throw new AdminRefusal(400, `${k} is required.`);
    }
    const f = await providerFields(tx, body, null);
    const providers = await tx.providers();
    const inRotation = body.inRotation !== false;
    const rotationOrder = inRotation ? Math.max(0, ...providers.map((p) => p.rotationOrder ?? 0)) + 1 : null;
    const row = await tx.insertProvider({
      fullName: f.fullName!,
      phone: f.phone!,
      region: f.region!,
      npi: f.npi ?? null,
      email: f.email ?? null,
      rotationOrder,
    });
    await audit({ action: "provider.create", entityType: "provider", entityId: String(row.id), before: null, after: auditSnapshot(row) });
    return { provider: row };
  }));

  app.patch(`${ON_CALL_API}/providers/:id`, ...guard, write(async (req, tx, audit) => {
    const id = intOf(req.params.id, "id");
    const providers = await tx.providers();
    const before = providers.find((p) => p.id === id);
    if (!before) throw new AdminRefusal(404, `Provider #${id} is not on file.`);
    // Only the fields the edit CHANGES are validated: an edit that resubmits a
    // field as it is on file (a blank or legacy phone, say) must not be refused
    // for that field when the admin only meant to change something else.
    const patch = await providerFields(tx, changedFields(req.body ?? {}, before), id);
    if (typeof req.body?.inRotation === "boolean") {
      const inNow = before.rotationOrder !== null;
      if (req.body.inRotation && !inNow) patch.rotationOrder = Math.max(0, ...providers.map((p) => p.rotationOrder ?? 0)) + 1;
      if (!req.body.inRotation && inNow) patch.rotationOrder = null;
    }
    // Only what actually changes is written and audited.
    for (const k of Object.keys(patch) as Array<keyof ProviderPatch>) {
      if ((patch[k] ?? null) === ((before as unknown as Record<string, unknown>)[k] ?? null)) delete patch[k];
    }
    if (Object.keys(patch).length === 0) throw new AdminRefusal(400, "Nothing to change.");
    const after = await tx.updateProvider(id, patch);
    await audit({ action: "provider.update", entityType: "provider", entityId: String(id), before: auditSnapshot(before), after: auditSnapshot(after) });
    return { provider: after };
  }));

  app.post(`${ON_CALL_API}/providers/:id/active`, ...guard, write(async (req, tx, audit) => {
    const id = intOf(req.params.id, "id");
    if (typeof req.body?.active !== "boolean") throw new AdminRefusal(400, "active must be true or false.");
    const { providers, schedule, overrides, directors } = await loadAll(tx);
    const before = providers.find((p) => p.id === id);
    if (!before) throw new AdminRefusal(404, `Provider #${id} is not on file.`);
    if (before.active === req.body.active) throw new AdminRefusal(400, `${before.fullName} is already ${before.active ? "active" : "inactive"}.`);
    const after = await tx.updateProvider(id, { active: req.body.active });
    await audit({
      action: req.body.active ? "provider.activate" : "provider.deactivate",
      entityType: "provider",
      entityId: String(id),
      before: auditSnapshot(before),
      after: auditSnapshot(after),
    });
    const t = now();
    const current = rotationWeekStart(t);
    return {
      provider: after,
      // What still points at someone just taken off: swap these.
      warnings: req.body.active
        ? []
        : [
            ...schedule.filter((r) => r.providerId === id && r.week >= current).map((r) => `Still scheduled for the week of ${r.week}; that week rings only the directors until swapped.`),
            ...overrides.filter((o) => o.providerId === id && o.endsAt > t).map((o) => `Override #${o.id} names them; it falls back to the week's provider.`),
            ...directors.filter((d) => d.providerId === id).map((d) => `Director for ${d.region}; that level is skipped until a new director is set.`),
          ],
    };
  }));

  app.post(`${ON_CALL_API}/providers/:id/delete`, ...guard, write(async (req, tx, audit) => {
    const id = intOf(req.params.id, "id");
    const before = (await tx.providers()).find((p) => p.id === id);
    if (!before) throw new AdminRefusal(404, `Provider #${id} is not on file.`);
    if (await tx.providerReferenced(id)) {
      throw new AdminRefusal(409, `${before.fullName} is referenced by the schedule, an override, a director row or a past call; deactivate them instead.`);
    }
    await tx.deleteProvider(id);
    await audit({ action: "provider.delete", entityType: "provider", entityId: String(id), before: auditSnapshot(before), after: null });
    return { deleted: id };
  }));

  app.post(`${ON_CALL_API}/providers/reorder`, ...guard, write(async (req, tx, audit) => {
    const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map((x: unknown) => intOf(x, "orderedIds")) : null;
    if (!ids) throw new AdminRefusal(400, "orderedIds must be a list of provider ids.");
    const providers = await tx.providers();
    const plan = planReorder(providers, ids);
    if (!plan.ok) throw new AdminRefusal(400, plan.error);
    if (plan.changes.length === 0) throw new AdminRefusal(400, "The order did not change.");
    await tx.setRotationOrders(plan.changes);
    await audit({
      action: "provider.reorder",
      entityType: "provider",
      entityId: null,
      before: plan.changes.map((c) => ({ id: c.id, rotationOrder: c.from })),
      after: plan.changes.map((c) => ({ id: c.id, rotationOrder: c.to })),
    });
    return { changes: plan.changes };
  }));

  // ── Escalation settings ───────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/escalation`, ...guard, read(async (_req, _res, store) => {
    const [directors, providers] = await Promise.all([store.directors(), store.providers()]);
    const env = deps.env;
    return {
      directors: directors.map((d) => ({ ...d, isFinal: regionKey(d.region) === regionKey(FINAL_REGION), provider: publicProvider(providers.find((p) => p.id === d.providerId)) })),
      providerRegions: [...new Set(providers.map((p) => p.region))],
      environment: {
        label: "Set in environment; change requires redeploy.",
        values: {
          ON_CALL_ROTATION_MODE: (env.ON_CALL_ROTATION_MODE ?? "").trim() || "(unset = off)",
          ON_CALL_POST_OP_REQUIRE_KEPT: (env.ON_CALL_POST_OP_REQUIRE_KEPT ?? "").trim() || "(unset)",
          ON_CALL_TEST_PHONES: `${(env.ON_CALL_TEST_PHONES ?? "").split(",").filter((x) => x.trim()).length} number(s)`,
          ON_CALL_CALLER_ID: last4(env.ON_CALL_CALLER_ID) ?? "(unset: TWILIO_PHONE_NUMBER)",
          URGENT_NOTIFICATION_NUMBER: last4(env.URGENT_NOTIFICATION_NUMBER) ?? "(unset)",
          ON_CALL_FINAL_FALLBACK_NUMBER: (() => {
            const fb = readFinalFallback(env);
            if (fb.finalFallbackPhone) return `${last4(fb.finalFallbackPhone)}: operations fallback (Wayne), rung after the final director`;
            return fb.finalFallbackProblem ? `not configured: ${fb.finalFallbackProblem}` : "not configured: an exhausted chain only texts URGENT_NOTIFICATION_NUMBER";
          })(),
          RUNTIME_TRANSFER_MODE: (env.RUNTIME_TRANSFER_MODE ?? "").trim() || "(default)",
        },
      },
      cadence: {
        label: "Set in code (src/runtime/onCall/); change requires a code change and redeploy.",
        values: {
          "Provider callback rings for": `${PROVIDER_RING_SECONDS}s`,
          "Calls per level": String(ATTEMPTS_PER_LEVEL),
          "Gap before the second call": `${RETRY_GAP_MS / 1000}s after the ring-out`,
          "Second call no later than": `${LEVEL_RETRY_DEADLINE_MS / 1000}s after the level started`,
          "A call with no status is given up after": `${RING_GUARD_MS / 1000}s`,
          "A chain older than this is stopped": `${STALE_ESCALATION_MS / 3_600_000}h`,
          "Chain step interval": `${TICK_MS / 1000}s`,
          "Routing decision budget per call": `${ROUTING_BUDGET_MS}ms`,
          "Post-op (Console) check budget": `${POST_OP_BUDGET_MS}ms`,
          "Rotation re-read at most every": `${ROTATION_CACHE_MS / 1000}s`,
        },
      },
      openDecisions: OPEN_DECISIONS,
    };
  }));

  app.put(`${ON_CALL_API}/directors`, ...guard, write(async (req, tx, audit) => {
    const region = typeof req.body?.region === "string" ? req.body.region.trim().replace(/\s+/g, " ") : "";
    if (!region) throw new AdminRefusal(400, "A region is required.");
    const providerId = intOf(req.body?.providerId, "providerId");
    const p = ringableProvider(await tx.providers(), providerId, callerId());
    const directors = await tx.directors();
    const existing = directors.find((d) => regionKey(d.region) === regionKey(region));
    if (!existing && req.body?.newRegion !== true) {
      throw new AdminRefusal(400, `Region "${region}" is not on file. Check the spelling, or mark it as a new region.`);
    }
    if (existing?.providerId === providerId) throw new AdminRefusal(400, `${p.fullName} already directs ${existing.region}.`);
    const name = existing?.region ?? (regionKey(region) === regionKey(FINAL_REGION) ? FINAL_REGION : region);
    await tx.setDirector(name, providerId);
    await audit({
      action: "director.set",
      entityType: "director",
      entityId: name,
      before: existing ?? null,
      after: { region: name, providerId, providerName: p.fullName },
    });
    return { region: name, providerId };
  }));

  app.post(`${ON_CALL_API}/directors/delete`, ...guard, write(async (req, tx, audit) => {
    const region = typeof req.body?.region === "string" ? req.body.region.trim() : "";
    const existing = (await tx.directors()).find((d) => regionKey(d.region) === regionKey(region));
    if (!existing) throw new AdminRefusal(404, `Region "${region}" is not on file.`);
    if (regionKey(existing.region) === regionKey(FINAL_REGION)) throw new AdminRefusal(400, "The FINAL director cannot be removed; set a new one instead.");
    const users = (await tx.providers()).filter((p) => regionKey(p.region) === regionKey(existing.region));
    if (users.length) throw new AdminRefusal(409, `${users.length} provider(s) still work in ${existing.region}; move them first.`);
    await tx.deleteDirector(existing.region);
    await audit({ action: "director.delete", entityType: "director", entityId: existing.region, before: existing, after: null });
    return { deleted: existing.region };
  }));

  // ── Audit ─────────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/audit`, ...guard, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const store = deps.store();
    if (!store) return void res.status(503).json({ error: "on_call_store_unavailable" });
    try {
      const t = await store.tables();
      if (!t.admin) return void res.json({ applied: false, message: AUDIT_NOT_APPLIED, rows: [] });
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      const date = (v: unknown) => {
        const s = str(v);
        if (!s) return undefined;
        const x = new Date(s);
        return Number.isNaN(x.getTime()) ? undefined : x;
      };
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const rows = await store.auditLog({
        entityType: str(req.query.entityType),
        action: str(req.query.action),
        actor: str(req.query.actor),
        since: date(req.query.since),
        until: date(req.query.until),
        limit,
      });
      // The log keeps full phones (they are what was changed); the page shows the last four.
      res.json({ applied: true, rows: rows.map((r) => ({ ...r, before: maskPhones(r.before), after: maskPhones(r.after) })) });
    } catch (e) {
      console.error("[on-call admin] audit read failed:", (e as Error)?.message);
      res.status(500).json({ error: "The audit log could not be read." });
    }
  });

  // ── Calls ─────────────────────────────────────────────────────────────────

  app.get(`${ON_CALL_API}/calls`, ...guard, read(async (req, _res, store) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const until = now();
    const since = new Date(until.getTime() - days * 86_400_000);
    const [escalations, providers, withoutChain] = await Promise.all([
      store.escalations({ since, until, limit: 300 }),
      store.providers(),
      store.urgentCallsWithoutChain({ since, until, limit: 300 }),
    ]);
    const [attempts, logs] = await Promise.all([
      store.attemptsForEscalations(escalations.map((e) => e.id)),
      store.callLogsBySid(escalations.map((e) => e.callSid)),
    ]);
    const names = new Map(providers.map((p) => [p.id, p.fullName]));
    const logBySid = new Map(logs.map((l) => [l.callSid, l]));
    const row = (log: CallLogLite | null, callSid: string) => ({
      callSid,
      callLogId: log?.id ?? null,
      startedAt: (log?.startTime ?? log?.createdAt)?.toISOString() ?? null,
      callerLast4: last4(log?.from),
      agent: log?.agentUsed ?? null,
      runtimeOutcome: log?.runtimeOutcome ?? null,
      durationSec: log?.duration ?? null,
    });
    return maskCallPhones({
      days,
      calls: [
        ...escalations.map((e) => {
          const log = logBySid.get(e.callSid) ?? null;
          const mine = attempts.filter((a) => a.escalationId === e.id);
          return {
            ...row(log, e.callSid),
            startedAt: (log?.startTime ?? log?.createdAt ?? e.createdAt).toISOString(),
            chain: { mode: e.mode, ...outcomeSummary({ escalation: e, attempts: mine, callLog: log, providerNames: names }) },
          };
        }),
        ...withoutChain.map((l) => ({ ...row(l, l.callSid ?? ""), chain: null })),
      ].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    });
  }));

  app.get(`${ON_CALL_API}/calls/:callSid`, ...guard, read(async (req, _res, store) => {
    const callSid = String(req.params.callSid ?? "");
    if (!/^CA[0-9a-f]{32}$/i.test(callSid)) throw new AdminRefusal(400, "Not a call SID.");
    const [raw, providers] = await Promise.all([store.callBundle(callSid), store.providers()]);
    if (!raw.callLog && !raw.escalation) throw new AdminRefusal(404, "No call or on-call chain on file for that SID.");
    const bundle = { ...raw, callSid, providerNames: new Map(providers.map((p) => [p.id, p.fullName])) };
    const tl = raw.callLog?.toolTimeline as any;
    // The plan (every level's full phone) is not sent: the Calls tab does not read it.
    return maskCallPhones({
      callSid,
      callLogId: raw.callLog?.id ?? null,
      caller: last4(raw.callLog?.from),
      agent: raw.callLog?.agentUsed ?? null,
      escalation: raw.escalation
        ? { id: raw.escalation.id, mode: raw.escalation.mode, status: raw.escalation.status, routing: raw.escalation.routing }
        : null,
      outcome: outcomeSummary(bundle),
      timeline: mergeTimeline(bundle),
      sections: {
        callLog: { wired: true, present: Boolean(raw.callLog) },
        transcriptTurns: { wired: true, present: raw.turns.length > 0 },
        toolCalls: { wired: true, present: Array.isArray(tl?.events) && tl.events.length > 0 },
        callEvents: { wired: true, present: raw.callEvents.length > 0 },
        escalation: { wired: true, present: Boolean(raw.escalation) },
        attempts: { wired: true, present: raw.attempts.length > 0 },
        extraEvents: { wired: false, present: raw.extraEvents.length > 0 },
      },
      notCapturedYet: [
        "Twilio SMS delivery status (delivered / undelivered) for each text: only the send result is recorded.",
        "Which key the provider pressed, and how long into the call: only the attempt's outcome is recorded.",
        "A provider's post-call note (what they did with the patient).",
        "Each change of the chain's status: only the current status and the row's last update are kept.",
      ],
    });
  }));
}
