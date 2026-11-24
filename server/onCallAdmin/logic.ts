/**
 * THE AFTER-HOURS ON-CALL ADMIN PAGE — the pure half.
 *
 * Everything here is a function of its arguments: the schedule view and its
 * gaps, the extend and reorder plans, the override overlap test, Pacific
 * wall-clock conversion, phone masking, and the per-call timeline merge. The
 * route module (`server/onCallAdmin.ts`) reads the store, calls these, and
 * writes. Who is on call is NOT decided here: that is `onCallAt` / `planChain`
 * in src/runtime/onCall/rotation.ts, imported as is, so the page can never
 * disagree with the voice agent.
 */
import { e164 } from "../../src/runtime/onCall/config";
import {
  addDays,
  pacificMinute,
  rotationWeekStart,
  WEEK_STARTS_AT_MINUTE,
  type OnCallOverride,
  type OnCallProvider,
} from "../../src/runtime/onCall/rotation";
import { ticketNumbersForCall } from "../callTicketNumbers";

// ── Phones ──────────────────────────────────────────────────────────────────

/** "…0100" for any number, or null. Never the whole number. */
export function last4(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").normalize("NFKC").replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : null;
}

/**
 * A typed phone as E.164 through the runtime's own `e164` (the helper the
 * rotation uses for every number it dials). "+1 (555) 010-0100" has its
 * formatting dropped first, because `e164` passes a leading + through as is.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  return e164(t.startsWith("+") ? `+${t.slice(1).replace(/[\s().-]/g, "")}` : t);
}

/** A number the chain could actually dial (the runtime's DIALABLE rule). */
export function isDialable(phone: string | null | undefined): boolean {
  return /^\+\d{10,15}$/.test(phone ?? "");
}

// ── Pacific time ────────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM" read as a Pacific wall clock, to
 * the instant. Null when it is not that shape or not a real time. Matches
 * PostgreSQL's `'<wall>'::timestamp AT TIME ZONE 'America/Los_Angeles'`
 * exactly, so the admin API and the CLI agree: a wall time that does not exist
 * (the spring-forward hour) or that happens twice (the fall-back hour) is read
 * at the STANDARD offset, UTC-8. Only a time that reads in PDT alone is UTC-7.
 */
export function pacificWallToDate(raw: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  const readsAsWanted = (instant: number) => {
    const p = pacificMinute(new Date(instant));
    const [py, pm, pd] = p.date.split("-").map(Number);
    return Date.UTC(py, pm - 1, pd, Math.floor(p.minute / 60), p.minute % 60) === wanted;
  };
  const standard = wanted + 8 * 3_600_000;
  const daylight = wanted + 7 * 3_600_000;
  return new Date(!readsAsWanted(standard) && readsAsWanted(daylight) ? daylight : standard);
}

/** The instant a rotation week starts: its Tuesday at 5:00 PM Pacific. */
export function weekStartInstant(week: string): Date {
  const h = String(Math.floor(WEEK_STARTS_AT_MINUTE / 60)).padStart(2, "0");
  return pacificWallToDate(`${week} ${h}:00`)!;
}

/** The instant a rotation week ends: the next Tuesday at 8:00 AM Pacific. */
export function weekEndInstant(week: string): Date {
  return pacificWallToDate(`${addDays(week, 7)} 08:00`)!;
}

export function isTuesday(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T12:00:00Z`).getUTCDay() === 2;
}

/** Go-live: Tuesday 2026-12-01, 5:00 PM Pacific (docs/ON_CALL_ROTATION.md). */
export const GO_LIVE_PACIFIC = "2026-12-01 17:00";

export function goLive(now: Date): { at: string; pacific: string; msRemaining: number; passed: boolean } {
  const at = pacificWallToDate(GO_LIVE_PACIFIC)!;
  const ms = at.getTime() - now.getTime();
  return { at: at.toISOString(), pacific: "Tue Dec 1, 2026 5:00 PM PT", msRemaining: Math.max(0, ms), passed: ms <= 0 };
}

// ── Schedule view and gaps ──────────────────────────────────────────────────

export interface ScheduleRow {
  week: string;
  providerId: number;
  note: string | null;
  updatedAt: string | null;
}

export interface OverrideRow {
  id: number;
  startsAt: Date;
  endsAt: Date;
  providerId: number;
  reason: string | null;
  createdAt: Date | null;
}

export interface ScheduleWeekView {
  week: string;
  /** ISO instants the week runs between. */
  startsAt: string;
  endsAt: string;
  providerId: number | null;
  providerName: string | null;
  providerActive: boolean | null;
  note: string | null;
  /** No row for this week: only the final director would be rung. */
  gap: boolean;
  current: boolean;
  overrides: Array<{ id: number; startsAt: string; endsAt: string; providerId: number; providerName: string | null; reason: string | null }>;
}

/**
 * Every week from `fromWeek` to `toWeek` (Tuesdays, inclusive), each with its
 * row or marked a gap, and the overrides that touch it.
 */
export function scheduleView(input: {
  fromWeek: string;
  toWeek: string;
  rows: readonly ScheduleRow[];
  overrides: readonly OverrideRow[];
  providers: readonly OnCallProvider[];
  now: Date;
}): ScheduleWeekView[] {
  const byWeek = new Map(input.rows.map((r) => [r.week, r]));
  const byId = new Map(input.providers.map((p) => [p.id, p]));
  const current = rotationWeekStart(input.now);
  const out: ScheduleWeekView[] = [];
  if (!isTuesday(input.fromWeek) || !isTuesday(input.toWeek)) return out;
  for (let w = input.fromWeek, i = 0; w <= input.toWeek && i < 520; w = addDays(w, 7), i++) {
    const row = byWeek.get(w);
    const start = weekStartInstant(w);
    const end = weekEndInstant(w);
    const p = row ? byId.get(row.providerId) : undefined;
    out.push({
      week: w,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      providerId: row?.providerId ?? null,
      providerName: p?.fullName ?? (row ? `(provider #${row.providerId} not on file)` : null),
      providerActive: p ? p.active : row ? false : null,
      note: row?.note ?? null,
      gap: !row,
      current: w === current,
      overrides: input.overrides
        .filter((o) => o.startsAt < end && o.endsAt > start)
        .map((o) => ({
          id: o.id,
          startsAt: o.startsAt.toISOString(),
          endsAt: o.endsAt.toISOString(),
          providerId: o.providerId,
          providerName: byId.get(o.providerId)?.fullName ?? null,
          reason: o.reason,
        })),
    });
  }
  return out;
}

/** The weeks in [from, to] with no row. */
export function scheduleGaps(fromWeek: string, toWeek: string, rows: readonly Pick<ScheduleRow, "week">[]): string[] {
  const have = new Set(rows.map((r) => r.week));
  const gaps: string[] = [];
  if (!isTuesday(fromWeek) || !isTuesday(toWeek)) return gaps;
  for (let w = fromWeek, i = 0; w <= toWeek && i < 520; w = addDays(w, 7), i++) if (!have.has(w)) gaps.push(w);
  return gaps;
}

// ── Extend (scripts/on-call-change.ts `extend`, in TypeScript) ──────────────

/**
 * The same weeks `extendScheduleSql` adds: after the last week on the schedule,
 * continuing the rotation in rotation_order among ACTIVE providers that have a
 * rotation place, starting with the one after the last week's provider (or the
 * first, when that provider has no rotation place).
 */
export function planExtension(
  last: { week: string; providerId: number } | null,
  providers: readonly OnCallProvider[],
  weeks: number,
): { ok: true; weeks: Array<{ week: string; providerId: number }> } | { ok: false; error: string } {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) return { ok: false, error: "weeks must be a whole number from 1 to 104" };
  if (!last) return { ok: false, error: "the schedule is empty; load it with scripts/on-call-seed.ts first" };
  const pool = providers
    .filter((p) => p.active && p.rotationOrder !== null)
    .sort((a, b) => (a.rotationOrder as number) - (b.rotationOrder as number));
  if (pool.length === 0) return { ok: false, error: "no active provider has a place in the rotation" };
  const lastOrder = providers.find((p) => p.id === last.providerId)?.rotationOrder ?? null;
  const start = lastOrder === null ? 0 : pool.filter((p) => (p.rotationOrder as number) <= lastOrder).length;
  const out: Array<{ week: string; providerId: number }> = [];
  for (let k = 1; k <= weeks; k++) {
    out.push({ week: addDays(last.week, 7 * k), providerId: pool[(start + k - 1) % pool.length].id });
  }
  return { ok: true, weeks: out };
}

/**
 * Why an extension is refused: a provider who would receive a week has no
 * dialable phone (operator, 2026-11-24: refuse, not warn). Names every such
 * provider and the weeks they would get; null when every one can be rung.
 * scripts/on-call-change.ts `extend` refuses the same way in its SQL.
 */
export function extensionRefusal(
  weeks: readonly { week: string; providerId: number }[],
  providers: readonly Pick<OnCallProvider, "id" | "fullName" | "phone">[],
  /** The rotation's caller ID: a provider whose phone is it cannot be rung either. */
  callerId: string | null = null,
): string | null {
  const bad = new Map<number, string[]>();
  for (const w of weeks) {
    const p = providers.find((x) => x.id === w.providerId);
    if (p && (!isDialable(p.phone) || (callerId && p.phone === callerId))) bad.set(p.id, [...(bad.get(p.id) ?? []), w.week]);
  }
  if (bad.size === 0) return null;
  const who = [...bad].map(([id, ws]) => `${providers.find((p) => p.id === id)!.fullName} (week${ws.length === 1 ? "" : "s"} of ${ws.join(", ")})`);
  return (
    `Extend refused: ${who.join("; ")} would get a week but ${who.length === 1 ? "has" : "have"} no dialable phone number (or it is the rotation's own caller ID). ` +
    `Fix the number on the Providers tab, or deactivate them, then extend again. Nothing was added.`
  );
}

// ── Reorder ─────────────────────────────────────────────────────────────────

/**
 * A new rotation order for the providers already in the rotation. `orderedIds`
 * must be exactly those providers, each once; they get 1..n. Only the rows
 * whose order changes are returned. Rotation membership is changed on the
 * provider itself, not here.
 */
export function planReorder(
  providers: readonly Pick<OnCallProvider, "id" | "rotationOrder">[],
  orderedIds: readonly number[],
): { ok: true; changes: Array<{ id: number; from: number | null; to: number }> } | { ok: false; error: string } {
  const inRotation = providers.filter((p) => p.rotationOrder !== null);
  const ids = new Set(inRotation.map((p) => p.id));
  if (new Set(orderedIds).size !== orderedIds.length) return { ok: false, error: "a provider is listed twice" };
  if (orderedIds.length !== ids.size || orderedIds.some((id) => !ids.has(id))) {
    return { ok: false, error: "the new order must list exactly the providers in the rotation, each once" };
  }
  const byId = new Map(inRotation.map((p) => [p.id, p]));
  const changes = orderedIds
    .map((id, i) => ({ id, from: byId.get(id)!.rotationOrder, to: i + 1 }))
    .filter((c) => c.from !== c.to);
  return { ok: true, changes };
}

// ── Overrides ───────────────────────────────────────────────────────────────

export function overlapping<T extends Pick<OnCallOverride, "id" | "startsAt" | "endsAt">>(overrides: readonly T[], startsAt: Date, endsAt: Date): T[] {
  return overrides.filter((o) => o.startsAt < endsAt && o.endsAt > startsAt);
}

// ── The per-call timeline ───────────────────────────────────────────────────

export type TimelineSource =
  | "call_logs"
  | "transcript"
  | "tool"
  | "call_events"
  | "escalation"
  | "attempt"
  | "ticket"
  | "on_call_call_events";

export interface TimelineItem {
  /** ISO. */
  at: string;
  source: TimelineSource;
  kind: string;
  title: string;
  detail?: string;
  status?: "ok" | "fail" | "info" | "warn";
  /** True when `at` is a stand-in (the row has no time of its own). */
  approximateTime?: boolean;
  data?: Record<string, unknown>;
}

export interface CallLogLite {
  id: string;
  callSid: string | null;
  from: string | null;
  agentUsed: string | null;
  voiceProvider: string | null;
  status: string | null;
  runtimeOutcome: string | null;
  agentOutcome: string | null;
  summary: string | null;
  duration: number | null;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date | null;
  transferredToHuman: boolean | null;
  ticketNumber: string | null;
  toolTimeline: unknown;
}

export interface EscalationLite {
  id: number;
  callSid: string;
  mode: string;
  status: string;
  levelIndex: number;
  attemptNo: number;
  routing: Record<string, unknown> | null;
  plan: { levels?: Array<{ role?: string; providerId?: number; name?: string; phone?: string }>; notes?: string[] } | null;
  acceptedBy: number | null;
  acceptedAt: Date | null;
  acceptedAttemptId: number | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface AttemptLite {
  id: number;
  levelIndex: number;
  role: string;
  providerId: number | null;
  kind: string;
  attemptNo: number;
  mode: string;
  dialedTo: string | null;
  outcome: string;
  routingReason: string | null;
  startedAt: Date;
  endedAt: Date | null;
  /** The provider leg's Twilio sid, when Twilio placed one. */
  providerCallSid?: string | null;
}

const RANG_OUTCOMES = new Set(["accepted", "no_answer", "declined", "busy", "taken_elsewhere"]);

/**
 * A call attempt that rang a phone, the rule the Calls list filters on
 * (store.ts ADMIN_SQL.escalations): a background call Twilio gave a sid to,
 * or a warm transfer with a sid or a ringing outcome. A row written before
 * Twilio was asked (no sid, no_status / failed) is not a call. An outcome
 * only a ringing call can have counts too, for rows read without the sid.
 */
export function attemptRang(a: Pick<AttemptLite, "kind" | "outcome" | "providerCallSid">): boolean {
  if (a.kind !== "call" && a.kind !== "warm_transfer") return false;
  if (a.providerCallSid) return true;
  if (a.kind === "warm_transfer" && a.outcome === "no_status") return true;
  return RANG_OUTCOMES.has(a.outcome);
}

/** The plan's levels, or none when the stored JSON is not the shape we wrote. */
function planLevels(esc: EscalationLite | null | undefined): Array<{ role?: string; providerId?: number; name?: string }> {
  const lv = esc?.plan && typeof esc.plan === "object" ? (esc.plan as any).levels : undefined;
  return Array.isArray(lv) ? lv.map((l) => (l && typeof l === "object" && !Array.isArray(l) ? l : {})) : [];
}

export interface CallBundle {
  callSid: string;
  callLog: CallLogLite | null;
  turns: Array<{ at: Date | null; role: string; text: string | null }>;
  callEvents: Array<{ at: Date; level: string | null; category: string | null; message: string | null; data: unknown }>;
  escalation: EscalationLite | null;
  attempts: AttemptLite[];
  extraEvents: Array<{ at: Date; source: string; eventType: string; detail: unknown }>;
  providerNames: ReadonlyMap<number, string>;
}

const TOOL_LABELS: Record<string, string> = {
  escalate_to_human: "Escalation gate",
  lookup_schedule: "Identity / schedule lookup",
  lookup_patient: "Identity lookup",
  create_ticket: "Ticket filed",
  record_answered_question: "Question answered (no ticket)",
  triage_symptoms: "Triage",
  set_spoken_language: "Language switched",
  terminate_call: "Call ended by agent",
};

const ROLE_WORDS: Record<string, string> = {
  on_call: "on-call provider",
  surgeon: "surgeon",
  region_director: "region director",
  final: "final director",
  operations_fallback: "operations fallback, Wayne",
};

const KIND_WORDS: Record<string, string> = {
  warm_transfer: "In-call warm transfer",
  call: "Callback call",
  sms: "Details text",
  nudge_sms: "Reminder text",
};

const SOURCE_RANK: Record<TimelineSource, number> = {
  call_logs: 0,
  transcript: 1,
  tool: 2,
  call_events: 3,
  escalation: 4,
  attempt: 5,
  on_call_call_events: 6,
  ticket: 7,
};

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d as unknown as string).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function attemptStatus(outcome: string): TimelineItem["status"] {
  if (outcome === "accepted" || outcome === "sent") return "ok";
  if (outcome === "in_progress") return "info";
  if (outcome === "taken_elsewhere") return "info";
  if (outcome === "no_answer" || outcome === "declined" || outcome === "busy" || outcome === "no_status") return "warn";
  return "fail";
}

function nameFor(bundle: CallBundle, providerId: number | null | undefined, levelIndex?: number): string {
  if (providerId !== null && providerId !== undefined) {
    const n = bundle.providerNames.get(providerId);
    if (n) return n;
  }
  const lvl = levelIndex !== undefined ? planLevels(bundle.escalation)[levelIndex] : undefined;
  return (typeof lvl?.name === "string" ? lvl.name : null) ?? (providerId ? `provider #${providerId}` : "unknown");
}

function toolEvents(raw: unknown): Array<Record<string, any>> {
  let tl: any = raw;
  if (typeof tl === "string") {
    try {
      tl = JSON.parse(tl);
    } catch {
      return [];
    }
  }
  // A stored timeline is JSON: skip anything that is not an object, so one
  // malformed entry costs that entry, not the whole call page.
  return Array.isArray(tl?.events) ? tl.events.filter((e: unknown) => e !== null && typeof e === "object" && !Array.isArray(e)) : [];
}

/**
 * Every fact we hold about one urgent call, in time order, each labelled with
 * where it came from. Ties keep a fixed source order (the call, then what was
 * said, then tools, then the chain), then input order.
 */
export function mergeTimeline(bundle: CallBundle): TimelineItem[] {
  const items: Array<TimelineItem & { seq: number }> = [];
  let seq = 0;
  const push = (i: TimelineItem | null) => {
    if (i && !Number.isNaN(new Date(i.at).getTime())) items.push({ ...i, seq: seq++ });
  };
  const cl = bundle.callLog;
  const callStart = iso(cl?.startTime) ?? iso(cl?.createdAt);
  const callEnd = iso(cl?.endTime);

  if (cl && callStart) {
    push({
      at: callStart,
      source: "call_logs",
      kind: "call_started",
      title: "Inbound call started",
      detail: [`caller ${last4(cl.from) ?? "withheld"}`, cl.agentUsed ? `agent ${cl.agentUsed}` : null, cl.voiceProvider ? `pipeline ${cl.voiceProvider}` : "pipeline old core"]
        .filter(Boolean)
        .join(" · "),
      status: "info",
      approximateTime: !cl.startTime,
    });
  }
  if (cl && callEnd) {
    push({
      at: callEnd,
      source: "call_logs",
      kind: "call_ended",
      title: "Call ended",
      detail: [
        cl.duration !== null ? `${cl.duration}s` : null,
        cl.runtimeOutcome ? `outcome ${cl.runtimeOutcome}` : null,
        cl.agentOutcome ? `graded ${cl.agentOutcome}` : null,
        cl.transferredToHuman ? "transferred to a human" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      status: "info",
      data: cl.summary ? { summary: cl.summary } : undefined,
    });
  }

  for (const t of bundle.turns) {
    if (!t || typeof t !== "object") continue;
    const at = iso(t.at);
    if (!at) continue;
    push({ at, source: "transcript", kind: `turn_${t.role}`, title: t.role === "caller" ? "Caller" : "Agent", detail: t.text ?? "", status: "info" });
  }

  for (const e of toolEvents(cl?.toolTimeline)) {
    // The timeline writes ISO with a "Z"; a stamp with no zone is UTC, never the server's local time.
    const end =
      typeof e.at === "string"
        ? new Date(/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(e.at.trim()) ? `${e.at.trim()}Z` : e.at).getTime()
        : NaN;
    if (Number.isNaN(end)) continue;
    const ms = e.ms != null && Number.isFinite(Number(e.ms)) ? Number(e.ms) : 0;
    const tool = String(e.tool ?? e.name ?? "tool");
    if (Number.isNaN(new Date(end - ms).getTime())) continue;
    const ok = e.outcome?.success !== false && e.outcome?.error == null && e.outcome?.cancelled !== true;
    push({
      at: new Date(end - ms).toISOString(),
      source: "tool",
      kind: tool,
      title: TOOL_LABELS[tool] ?? tool,
      detail: [tool, ms ? `${ms}ms` : null, e.outcome?.refused ? `refused: ${e.outcome.refused}` : null].filter(Boolean).join(" · "),
      status: ok ? "ok" : "fail",
      data: { args: e.args ?? null, outcome: e.outcome ?? null },
    });
  }

  for (const e of bundle.callEvents) {
    if (!e || typeof e !== "object") continue;
    const at = iso(e.at);
    if (!at) continue;
    push({
      at,
      source: "call_events",
      kind: `${e.category ?? "event"}`,
      title: `${e.category ?? "event"}: ${e.message ?? ""}`.trim(),
      status: e.level === "error" ? "fail" : e.level === "warn" ? "warn" : "info",
      data: e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : undefined,
    });
  }

  const esc = bundle.escalation;
  if (esc) {
    const routing: Record<string, any> = esc.routing && typeof esc.routing === "object" ? esc.routing : {};
    const levels = planLevels(esc);
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    push({
      at: esc.createdAt.toISOString(),
      source: "escalation",
      kind: "escalation_opened",
      title: `On-call chain opened (${esc.mode})`,
      detail: [
        routing.reason ? `routing: ${routing.reason}` : null,
        routing.window ? `window: ${routing.window}` : null,
        routing.weekStartsOn ? `week of ${routing.weekStartsOn}` : null,
        routing.source ? `from ${routing.source}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      status: "info",
      data: {
        plan: levels.map((l, i) => `${i + 1}. ${l.name ?? "?"} (${ROLE_WORDS[l.role ?? ""] ?? l.role})`),
        notes: [...strings(esc.plan?.notes), ...strings(routing.notes)],
        ...(routing.postOp ? { postOp: routing.postOp } : {}),
        ...(routing.note ? { textNote: routing.note } : {}),
      },
    });
    const firstOfLevel = new Map<number, AttemptLite>();
    for (const a of [...bundle.attempts].sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())) {
      if (!firstOfLevel.has(a.levelIndex)) firstOfLevel.set(a.levelIndex, a);
    }
    for (const [lvl, a] of firstOfLevel) {
      if (lvl === 0) continue;
      push({
        at: a.startedAt.toISOString(),
        source: "escalation",
        kind: "level_started",
        title: `Escalated to level ${lvl + 1}: ${nameFor(bundle, a.providerId, lvl)} (${ROLE_WORDS[a.role] ?? a.role})`,
        status: "warn",
        approximateTime: true,
      });
    }
    if (esc.acceptedAt) {
      const by = esc.acceptedAttemptId ? bundle.attempts.find((a) => a.id === esc.acceptedAttemptId) : undefined;
      push({
        at: esc.acceptedAt.toISOString(),
        source: "escalation",
        kind: "accepted",
        title: `Patient taken by ${by ? nameFor(bundle, by.providerId, by.levelIndex) : nameFor(bundle, esc.acceptedBy)}`,
        status: "ok",
      });
    }
    if (esc.status !== "active" && esc.status !== "accepted" && esc.updatedAt) {
      push({
        at: esc.updatedAt.toISOString(),
        source: "escalation",
        kind: `closed_${esc.status}`,
        title: `Chain closed: ${esc.status}`,
        detail: "time is the row's last update",
        status: esc.status === "cancelled" ? "warn" : "fail",
        approximateTime: true,
      });
    }
  }

  for (const a of bundle.attempts) {
    const dur = a.endedAt ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 1000) : null;
    push({
      at: a.startedAt.toISOString(),
      source: "attempt",
      kind: a.kind,
      title: `${KIND_WORDS[a.kind] ?? a.kind} → ${nameFor(bundle, a.providerId, a.levelIndex)} (${ROLE_WORDS[a.role] ?? a.role}, level ${a.levelIndex + 1}, try ${a.attemptNo})`,
      detail: [
        `to ${last4(a.dialedTo) ?? "no number"}`,
        `outcome ${a.outcome}`,
        dur !== null ? `${dur}s` : null,
        a.mode === "test" ? "TEST MODE" : null,
        a.routingReason ? `routing ${a.routingReason}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      status: attemptStatus(a.outcome),
    });
  }

  for (const e of bundle.extraEvents) {
    if (!e || typeof e !== "object") continue;
    const at = iso(e.at);
    if (!at) continue;
    push({
      at,
      source: "on_call_call_events",
      kind: e.eventType,
      title: `${e.source}: ${e.eventType}`,
      status: "info",
      data: e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : undefined,
    });
  }

  if (cl) {
    const ticketAt = callEnd ?? callStart;
    if (ticketAt) {
      for (const n of ticketNumbersForCall(cl as unknown as Record<string, unknown>)) {
        push({ at: ticketAt, source: "ticket", kind: "ticket", title: `Ticket ${n}`, detail: "shown at the call's end; its filing tool is above", status: "ok", approximateTime: true });
      }
    }
  }

  items.sort((a, b) => {
    const d = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (d !== 0) return d;
    const r = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    return r !== 0 ? r : a.seq - b.seq;
  });
  return items.map(({ seq: _seq, ...rest }) => rest);
}

export interface CallOutcome {
  status: string;
  acceptedByName: string | null;
  acceptedAt: string | null;
  /** From the call's start when we have it, else from when the chain opened. */
  secondsToAccept: number | null;
  calls: number;
  texts: number;
  levelsReached: number;
  exhausted: boolean;
  firstLevel: string | null;
  routingReason: string | null;
}

export function outcomeSummary(bundle: Pick<CallBundle, "escalation" | "attempts" | "callLog" | "providerNames">): CallOutcome {
  const esc = bundle.escalation;
  // Only a call that rang counts (review of #520): the list's own rule.
  const calls = bundle.attempts.filter(attemptRang).length;
  const texts = bundle.attempts.filter((a) => a.kind === "sms" || a.kind === "nudge_sms").length;
  const levelsReached = bundle.attempts.length ? Math.max(...bundle.attempts.map((a) => a.levelIndex)) + 1 : 0;
  const start = bundle.callLog?.startTime ?? bundle.callLog?.createdAt ?? esc?.createdAt ?? null;
  const accAttempt = esc?.acceptedAttemptId ? bundle.attempts.find((a) => a.id === esc.acceptedAttemptId) : undefined;
  const b = { ...bundle, turns: [], callEvents: [], extraEvents: [], callSid: esc?.callSid ?? "" } as CallBundle;
  const first = planLevels(esc)[0];
  return {
    status: esc?.status ?? "no_chain",
    acceptedByName: esc?.acceptedAt ? (accAttempt ? nameFor(b, accAttempt.providerId, accAttempt.levelIndex) : nameFor(b, esc.acceptedBy)) : null,
    acceptedAt: iso(esc?.acceptedAt),
    secondsToAccept: esc?.acceptedAt && start ? Math.round((esc.acceptedAt.getTime() - new Date(start).getTime()) / 1000) : null,
    calls,
    texts,
    levelsReached,
    exhausted: esc?.status === "exhausted",
    firstLevel: first ? `${first.name ?? "?"} (${ROLE_WORDS[first.role ?? ""] ?? first.role})` : null,
    routingReason: (esc?.routing?.reason as string | undefined) ?? null,
  };
}
