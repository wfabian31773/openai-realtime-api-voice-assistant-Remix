import { describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { requireAuth, requireRole } from "./auth";
import { EXTEND_PLAN_CHANGED, maskAuditSnapshot, maskCallPhones, maskPhonesInText, mountOnCallAdmin, ON_CALL_API, samePlan, sameOverlapIds, storePerPool } from "./onCallAdmin";
import { emptyFakeState, FakeOnCallAdminStore, type FakeOptions, type FakeState } from "./onCallAdmin/store.fake";
import { pacificWallToDate } from "./onCallAdmin/logic";

vi.mock("./db", () => ({ db: {} }));

// Fri Dec 4 2026, 10:00 PM Pacific: off hours, rotation week of Tue Dec 1.
const NOW = new Date("2026-12-05T06:00:00Z");
const SID = "CA00000000000000000000000000000001";

function fixture(): FakeState {
  const s = emptyFakeState();
  const prov = (id: number, name: string, region: string, rotationOrder: number | null, extra: Partial<FakeState["providers"][0]> = {}) => ({
    id,
    fullName: name,
    npi: null,
    phone: `+1555555${String(100 + id).padStart(4, "0")}`,
    email: null,
    region,
    rotationOrder,
    active: true,
    createdAt: null,
    updatedAt: null,
    ...extra,
  });
  s.providers = [
    prov(1, "Dr. Test Alpha", "Inland Empire", 1),
    prov(2, "Dr. Test Beta", "Los Angeles", 2),
    prov(3, "Dr. Test Gamma", "Inland Empire", 3),
    prov(4, "Dr. Test Inactive", "Inland Empire", 4, { active: false }),
    prov(5, "Dr. Test NoPhone", "Inland Empire", 5, { phone: "" }),
    prov(6, "Dr. Test Unused", "Inland Empire", null),
    prov(10, "Dr. Test Director", "Inland Empire", null),
    prov(11, "Dr. Test Final", "San Diego", null),
  ];
  s.directors = [
    { region: "Inland Empire", providerId: 10, updatedAt: null },
    { region: "Los Angeles", providerId: 10, updatedAt: null },
    { region: "San Diego", providerId: 11, updatedAt: null },
    { region: "FINAL", providerId: 11, updatedAt: null },
  ];
  s.schedule = [
    { week: "2026-12-01", providerId: 1, note: null, updatedAt: null },
    { week: "2026-12-08", providerId: 2, note: null, updatedAt: null },
    { week: "2026-12-22", providerId: 3, note: null, updatedAt: null },
  ];
  s.escalations = [
    {
      id: 7,
      callSid: SID,
      mode: "test",
      status: "exhausted",
      levelIndex: 1,
      attemptNo: 2,
      routing: { reason: "on_call", window: "off_hours", weekStartsOn: "2026-12-01" },
      plan: { levels: [{ role: "on_call", providerId: 1, name: "Dr. Test Alpha" }, { role: "final", providerId: 11, name: "Dr. Test Final" }], notes: [] },
      acceptedBy: null,
      acceptedAt: null,
      acceptedAttemptId: null,
      createdAt: new Date("2026-12-05T05:01:00Z"),
      updatedAt: new Date("2026-12-05T05:10:00Z"),
    },
  ];
  s.attempts = [
    { id: 1, escalationId: 7, callSid: SID, levelIndex: 0, role: "on_call", providerId: 1, kind: "warm_transfer", attemptNo: 1, mode: "test", dialedTo: "+15555550101", outcome: "no_answer", routingReason: "on_call", startedAt: new Date("2026-12-05T05:00:30Z"), endedAt: new Date("2026-12-05T05:01:00Z") },
  ];
  return s;
}

function boot(opts: FakeOptions = {}, state: FakeState = fixture(), env: Record<string, string> = {}) {
  const store = new FakeOnCallAdminStore(state, opts);
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handlers: RequestHandler[] }> = [];
  const reg = (method: string) => (path: string, ...handlers: RequestHandler[]) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), "([^/]+)"))}$`);
    routes.push({ method, pattern, keys, handlers });
  };
  const app = { get: reg("GET"), post: reg("POST"), put: reg("PUT"), patch: reg("PATCH"), delete: reg("DELETE") } as unknown as Express;
  mountOnCallAdmin(app, {
    authenticate: requireAuth,
    admin: requireRole("admin"),
    store: () => store,
    env,
    now: () => NOW,
    actor: async () => ({ userId: "staff-id", email: "admin@example.test" }),
  });
  async function request(method: string, path: string, role: string | null = "admin", body?: unknown) {
    const [pathname, qs] = path.split("?");
    const chain: RequestHandler[] = [];
    const params: Record<string, string> = {};
    for (const r of routes.filter((x) => x.method === method)) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      chain.push(...r.handlers);
    }
    if (!chain.length) throw new Error(`no route ${method} ${path}`);
    const req = {
      session: role ? { userId: "staff-id", userRole: role } : {},
      body,
      params,
      query: Object.fromEntries(new URLSearchParams(qs ?? "")),
      headers: {},
    };
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
    async function run(i: number): Promise<void> {
      const h = chain[i];
      if (!h) return;
      let next: Promise<void> | undefined;
      await h(req as never, res as never, () => {
        next = run(i + 1);
      });
      await next;
    }
    await run(0);
    return result;
  }
  return { store, routes, request };
}

describe("every on-call route is admin-only and never cached", () => {
  it("refuses an anonymous request and a non-admin role on every route", async () => {
    const h = boot();
    expect(h.routes.length).toBeGreaterThan(15);
    for (const r of h.routes) {
      const path = r.pattern.source.slice(1, -1).replace(/\(\[\^\/\]\+\)/g, "1").replace(/\\\//g, "/");
      expect(r.handlers[0]).toBe(requireAuth);
      for (const role of [null, "user", "manager"]) {
        const res = await h.request(r.method, path, role, { reason: "x" });
        expect(res.status, `${r.method} ${path} as ${role}`).toBe(role ? 403 : 401);
      }
    }
    expect(h.store.transactions).toBe(0);
  });

  it("answers no-store", async () => {
    const h = boot();
    expect((await h.request("GET", `${ON_CALL_API}/now`)).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("tables not applied", () => {
  it("reads and writes say so instead of failing; status still answers", async () => {
    const h = boot({ rotationTables: false, adminTables: false });
    const status = await h.request("GET", `${ON_CALL_API}/status`);
    expect(status.status).toBe(200);
    expect(status.body.tables.rotation).toBe(false);
    expect(status.body.tablesMessage).toMatch(/add_on_call_rotation\.sql/);
    for (const [m, p] of [
      ["GET", `${ON_CALL_API}/now`],
      ["GET", `${ON_CALL_API}/schedule`],
      ["GET", `${ON_CALL_API}/providers`],
      ["GET", `${ON_CALL_API}/calls`],
      ["POST", `${ON_CALL_API}/schedule/assign`],
    ]) {
      const r = await h.request(m, p, "admin", { reason: "r", week: "2026-12-08", providerId: 3 });
      expect(r.status, p).toBe(409);
      expect(r.body.error).toBe("on_call_tables_not_applied");
    }
    expect((await h.request("GET", `${ON_CALL_API}/audit`)).body).toMatchObject({ applied: false, rows: [] });
  });

  it("with the rotation applied but not the audit table, reads work and every write is refused", async () => {
    const h = boot({ adminTables: false });
    expect((await h.request("GET", `${ON_CALL_API}/now`)).status).toBe(200);
    const r = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { reason: "r", week: "2026-12-08", providerId: 3 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("on_call_audit_not_applied");
    expect(h.store.state.schedule.find((w) => w.week === "2026-12-08")!.providerId).toBe(2);
  });
});

describe("who is on call", () => {
  it("is the runtime's own answer and chain, with phones as last-4", async () => {
    const h = boot();
    const r = await h.request("GET", `${ON_CALL_API}/now`);
    expect(r.body.now.provider.fullName).toBe("Dr. Test Alpha");
    expect(r.body.now.window.reason).toBe("off_hours");
    expect(r.body.now.chain.levels.map((l: any) => [l.role, l.name])).toEqual([
      ["on_call", "Dr. Test Alpha"],
      ["region_director", "Dr. Test Director"],
      ["final", "Dr. Test Final"],
    ]);
    expect(r.body.nextWeek.provider.fullName).toBe("Dr. Test Beta");
    expect(JSON.stringify(r.body)).not.toMatch(/5555550\d{3}/);
  });

  it("names the override the runtime picks when two overlap (the later start wins)", async () => {
    const state = fixture();
    const ov = (id: number, start: string, end: string, providerId: number) => ({
      id,
      startsAt: new Date(start),
      endsAt: new Date(end),
      providerId,
      reason: null,
      createdAt: null,
    });
    // Both cover NOW; #8 starts later, so the runtime rings Gamma (#3) under #8.
    // A second, earlier override for the same provider must not be the one shown.
    state.overrides = [
      ov(5, "2026-12-05T01:00:00Z", "2026-12-05T10:00:00Z", 3),
      ov(8, "2026-12-05T04:00:00Z", "2026-12-05T09:00:00Z", 3),
      ov(6, "2026-12-05T02:00:00Z", "2026-12-05T09:00:00Z", 2),
    ];
    const r = await boot({}, state).request("GET", `${ON_CALL_API}/now`);
    expect(r.body.now.source).toBe("override");
    expect(r.body.now.provider.fullName).toBe("Dr. Test Gamma");
    expect(r.body.now.override.id).toBe(8);
  });

  it("previews any moment, and a gap week rings only the final director", async () => {
    const h = boot();
    const r = await h.request("GET", `${ON_CALL_API}/preview?at=2026-12-17T22:00`);
    expect(r.body.preview.note).toBe("no_schedule_for_week");
    expect(r.body.preview.chain.levels.map((l: any) => l.role)).toEqual(["final"]);
    expect((await h.request("GET", `${ON_CALL_API}/preview?at=soon`)).status).toBe(400);
  });

  it("says the operations fallback is not configured when ON_CALL_FINAL_FALLBACK_NUMBER is unset", async () => {
    const h = boot();
    const r = await h.request("GET", `${ON_CALL_API}/now`);
    expect(r.body.now.chain.operationsFallbackConfigured).toBe(false);
    expect(r.body.now.chain.levels.map((l: any) => l.role)).not.toContain("operations_fallback");
    const s = await h.request("GET", `${ON_CALL_API}/status`);
    expect(s.body.config.finalFallbackLast4).toBeNull();
    expect(s.body.config.finalFallback).toEqual({ configured: false });
    const e = await h.request("GET", `${ON_CALL_API}/escalation`);
    expect(e.body.environment.values.ON_CALL_FINAL_FALLBACK_NUMBER).toMatch(/^not configured/);
  });

  it("shows the operations fallback (Wayne) after the final director when configured, as last-4 only", async () => {
    const h = boot({}, fixture(), { TWILIO_PHONE_NUMBER: "+15550000001", ON_CALL_FINAL_FALLBACK_NUMBER: "+15550177777" });
    const r = await h.request("GET", `${ON_CALL_API}/now`);
    expect(r.body.now.chain.levels.map((l: any) => [l.role, l.phoneLast4])).toEqual([
      ["on_call", "…0101"],
      ["region_director", "…0110"],
      ["final", "…0111"],
      ["operations_fallback", "…7777"],
    ]);
    expect(r.body.now.chain.operationsFallbackConfigured).toBe(true);
    const p = await h.request("GET", `${ON_CALL_API}/preview?at=2026-12-17T22:00`);
    expect(p.body.preview.chain.levels.map((l: any) => l.role)).toEqual(["final", "operations_fallback"]);
    const s = await h.request("GET", `${ON_CALL_API}/status`);
    expect(s.body.config.finalFallbackLast4).toBe("…7777");
    const e = await h.request("GET", `${ON_CALL_API}/escalation`);
    expect(e.body.environment.values.ON_CALL_FINAL_FALLBACK_NUMBER).toMatch(/^…7777: operations fallback/);
    for (const body of [r.body, s.body, e.body]) expect(JSON.stringify(body)).not.toContain("5550177777");
  });
});

describe("changes", () => {
  it("require a reason, and write nothing without one", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-08", providerId: 3, reason: "  " });
    expect(r.status).toBe(400);
    expect(h.store.transactions).toBe(0);
  });

  it("a week swap writes its audit row in the same transaction", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-08", providerId: 3, reason: "vacation" });
    expect(r.status).toBe(200);
    expect(h.store.state.schedule.find((w) => w.week === "2026-12-08")!.providerId).toBe(3);
    expect(h.store.state.audit).toHaveLength(1);
    expect(h.store.state.audit[0]).toMatchObject({
      action: "schedule.swap_week",
      entityType: "schedule",
      entityId: "2026-12-08",
      reason: "vacation",
      actorEmail: "admin@example.test",
      before: { providerId: 2 },
    });
  });

  it("a failed audit insert rolls the change back", async () => {
    const h = boot({ failAudit: true });
    const r = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-08", providerId: 3, reason: "x" });
    expect(r.status).toBe(500);
    expect(h.store.state.schedule.find((w) => w.week === "2026-12-08")!.providerId).toBe(2);
    expect(h.store.state.audit).toHaveLength(0);
  });

  it("masks the displayed audit reason and snapshot text without changing stored rows", async () => {
    const state = fixture();
    const note = "call me at 415-555-0199";
    state.schedule.find((w) => w.week === "2026-12-08")!.note = note;
    const h = boot({}, state);
    const reason = "covering, cell 415 555 0142";
    expect((await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-08", providerId: 3, reason })).status).toBe(200);
    const stored = structuredClone(h.store.state.audit);

    const log = await h.request("GET", `${ON_CALL_API}/audit`);
    expect(log.status).toBe(200);
    expect(log.body.rows[0]).toMatchObject({
      reason: "covering, cell …0142",
      before: { note: "call me at …0199" },
      after: { note: "swapped to Dr. Test Gamma: covering, cell …0142" },
    });
    expect(h.store.state.audit).toEqual(stored);
    expect(h.store.state.audit[0]).toMatchObject({ reason, before: { note }, after: { note: expect.stringContaining(reason) } });
  });

  it("fills a gap week, and refuses a non-Tuesday, an inactive provider and one with no phone", async () => {
    const h = boot();
    expect((await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-15", providerId: 1, reason: "gap" })).status).toBe(200);
    expect(h.store.state.audit[0].action).toBe("schedule.fill_week");
    for (const [week, providerId, msg] of [
      ["2026-12-16", 1, /Tuesday/],
      ["2026-12-08", 4, /inactive/],
      ["2026-12-08", 5, /no dialable phone/],
      ["2026-12-08", 99, /not on file/],
    ] as const) {
      const r = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week, providerId, reason: "x" });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    expect(h.store.state.audit).toHaveLength(1);
  });

  it("swaps two weeks between providers", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/schedule/swap-weeks`, "admin", { weekA: "2026-12-08", weekB: "2026-12-22", reason: "trade" });
    expect(r.status).toBe(200);
    const w = (x: string) => h.store.state.schedule.find((s) => s.week === x)!.providerId;
    expect([w("2026-12-08"), w("2026-12-22")]).toEqual([3, 2]);
    expect((await h.request("POST", `${ON_CALL_API}/schedule/swap-weeks`, "admin", { weekA: "2026-12-08", weekB: "2026-12-15", reason: "x" })).status).toBe(400);
  });

  it("refuses to extend when a provider who would get a week has no dialable phone, and adds nothing", async () => {
    const h = boot();
    const dry = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, dryRun: true });
    // Provider 5 is active, in the rotation and has no phone: the preview
    // shows the weeks and the refusal naming them.
    expect(dry.body.weeks.map((w: any) => [w.week, w.providerId])).toEqual([
      ["2026-12-29", 5],
      ["2027-01-05", 1],
    ]);
    expect(dry.body.refusal).toMatch(/^Extend refused: Dr\. Test NoPhone \(week of 2026-12-29\)/);
    expect(h.store.transactions).toBe(0);
    const before = h.store.state.schedule.length;
    const plan = dry.body.weeks.map((w: any) => ({ week: w.week, providerId: w.providerId }));
    const r = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, plan, reason: "more weeks" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Dr\. Test NoPhone/);
    expect(h.store.state.schedule).toHaveLength(before);
    expect(h.store.state.audit).toHaveLength(0);
  });

  it("extends the schedule the way the CLI does when every provider can be rung, and a dry run writes nothing", async () => {
    const state = fixture();
    state.providers = state.providers.map((p) => (p.id === 5 ? { ...p, phone: "+15555550105" } : p));
    const h = boot({}, state);
    const dry = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, dryRun: true });
    expect(dry.body.refusal).toBeNull();
    expect(h.store.transactions).toBe(0);
    const plan = dry.body.weeks.map((w: any) => ({ week: w.week, providerId: w.providerId }));
    const r = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, plan, reason: "more weeks" });
    expect(r.status).toBe(200);
    expect(h.store.state.schedule.map((s) => s.week)).toContain("2027-01-05");
    expect(h.store.state.audit[0].action).toBe("schedule.extend");
  });

  it("refuses an extend whose confirmed plan is missing or no longer matches the schedule, and adds nothing", async () => {
    const state = fixture();
    state.providers = state.providers.map((p) => (p.id === 5 ? { ...p, phone: "+15555550105" } : p));
    const h = boot({}, state);
    const dry = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, dryRun: true });
    const plan = dry.body.weeks.map((w: any) => ({ week: w.week, providerId: w.providerId }));
    const before = h.store.state.schedule.length;

    // No plan sent at all.
    const none = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, reason: "more weeks" });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe(EXTEND_PLAN_CHANGED);
    expect(none.body.planChanged).toBe(true);

    // Someone else extended the schedule by a week since the preview: the same
    // request would now write different dates.
    const last = h.store.state.schedule[h.store.state.schedule.length - 1];
    h.store.state.schedule.push({ ...last, week: plan[0].week, providerId: plan[0].providerId });
    const moved = await h.request("POST", `${ON_CALL_API}/schedule/extend`, "admin", { weeks: 2, plan, reason: "more weeks" });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe(EXTEND_PLAN_CHANGED);
    expect(h.store.state.schedule).toHaveLength(before + 1);
    expect(h.store.state.audit).toHaveLength(0);
  });

  it("samePlan compares week and provider, in order", () => {
    const cur = [{ week: "2027-01-05", providerId: 1 }, { week: "2027-01-12", providerId: 2 }];
    expect(samePlan(cur.map((w) => ({ ...w })), cur)).toBe(true);
    expect(samePlan(undefined, cur)).toBe(false);
    expect(samePlan([cur[0]], cur)).toBe(false);
    expect(samePlan([cur[1], cur[0]], cur)).toBe(false);
    expect(samePlan([cur[0], { week: "2027-01-12", providerId: 3 }], cur)).toBe(false);
    expect(samePlan([cur[0], null], cur)).toBe(false);
  });

  it("an override overlapping another needs confirming; a past or inverted window is refused", async () => {
    const h = boot();
    const body = { startsAt: "2026-12-10T17:00", endsAt: "2026-12-11T08:00", providerId: 3, reason: "cover" };
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", body)).status).toBe(200);
    const again = await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1 });
    expect(again.status).toBe(409);
    expect(again.body.overlap).toHaveLength(1);
    const firstId = again.body.overlap[0].id;
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1, confirmOverlap: true })).status).toBe(409);
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1, confirmedOverlapIds: [firstId] })).status).toBe(200);
    expect(h.store.state.overrides).toHaveLength(2);
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, endsAt: "2026-12-10T16:00" })).status).toBe(400);
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, startsAt: "2026-12-01T17:00", endsAt: "2026-12-02T08:00" })).status).toBe(400);
    expect(h.store.state.overrides[0].startsAt.toISOString()).toBe(pacificWallToDate("2026-12-10 17:00")!.toISOString());
  });

  it("a confirmed overlap does not approve an overlap added after the warning (review of #520)", async () => {
    const h = boot();
    const body = { startsAt: "2026-12-10T17:00", endsAt: "2026-12-11T08:00", providerId: 3, reason: "cover" };
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", body)).status).toBe(200);
    const warned = await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1 });
    const confirmedIds = warned.body.overlap.map((o: { id: number }) => o.id);
    // Another admin adds a cover over the same window before the retry.
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 2, confirmedOverlapIds: confirmedIds })).status).toBe(200);
    const retry = await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1, confirmedOverlapIds: confirmedIds });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/changed since you confirmed/);
    expect(retry.body.overlap).toHaveLength(2);
    expect(h.store.state.overrides).toHaveLength(2);
    const ids = retry.body.overlap.map((o: { id: number }) => o.id).reverse();
    expect((await h.request("POST", `${ON_CALL_API}/overrides`, "admin", { ...body, providerId: 1, confirmedOverlapIds: ids })).status).toBe(200);
    expect(h.store.state.overrides).toHaveLength(3);
  });

  it("sameOverlapIds is set equality on integer ids", () => {
    expect(sameOverlapIds([2, 1], [1, 2])).toBe(true);
    expect(sameOverlapIds([1], [1, 2])).toBe(false);
    expect(sameOverlapIds([1, 3], [1, 2])).toBe(false);
    expect(sameOverlapIds(true, [1])).toBe(false);
    expect(sameOverlapIds(["x"], [1])).toBe(false);
  });

  it("cancelling: an upcoming override is deleted, a running one ends now, a past one is refused", async () => {
    const h = boot();
    const at = (s: string) => pacificWallToDate(s)!;
    h.store.state.overrides = [
      { id: 1, startsAt: at("2026-12-10 17:00"), endsAt: at("2026-12-11 08:00"), providerId: 3, reason: null, createdAt: null },
      { id: 2, startsAt: at("2026-12-04 17:00"), endsAt: at("2026-12-05 08:00"), providerId: 3, reason: null, createdAt: null },
      { id: 3, startsAt: at("2026-12-02 17:00"), endsAt: at("2026-12-03 08:00"), providerId: 3, reason: null, createdAt: null },
    ];
    expect((await h.request("POST", `${ON_CALL_API}/overrides/1/cancel`, "admin", { reason: "x" })).body.cancelled).toBe("deleted");
    expect((await h.request("POST", `${ON_CALL_API}/overrides/2/cancel`, "admin", { reason: "x" })).body.cancelled).toBe("ended_now");
    expect(h.store.state.overrides.find((o) => o.id === 2)!.endsAt).toEqual(NOW);
    expect((await h.request("POST", `${ON_CALL_API}/overrides/3/cancel`, "admin", { reason: "x" })).status).toBe(400);
    expect(h.store.state.audit.map((a) => a.action)).toEqual(["override.cancel", "override.end_now"]);
  });
});

describe("providers", () => {
  it("adds at the end of the rotation with the phone in E.164 and the region as on file", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/providers`, "admin", {
      fullName: "Dr. Test New",
      phone: "555-555-0199",
      region: "inland  empire",
      reason: "onboarding",
    });
    expect(r.status).toBe(200);
    expect(r.body.provider).toMatchObject({ phone: "+15555550199", region: "Inland Empire", rotationOrder: 6 });
    expect(h.store.state.audit[0].action).toBe("provider.create");
  });

  it("refuses an unknown region unless new, FINAL, a bad phone, a taken name and a bad NPI", async () => {
    const h = boot();
    const base = { fullName: "Dr. Test New", phone: "5555550199", region: "Inland Empire", reason: "x" };
    for (const [patch, msg] of [
      [{ region: "Inland Empyre" }, /no escalation director/],
      [{ region: "FINAL" }, /final escalation rung/],
      [{ phone: "12" }, /not a phone/],
      [{ fullName: "dr. test  alpha" }, /already on file/],
      [{ npi: "123" }, /10 digits/],
    ] as const) {
      const r = await h.request("POST", `${ON_CALL_API}/providers`, "admin", { ...base, ...patch });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const ok = await h.request("POST", `${ON_CALL_API}/providers`, "admin", { ...base, region: "Coachella Valley", newRegion: true, inRotation: false });
    expect(ok.body.provider).toMatchObject({ region: "Coachella Valley", rotationOrder: null });
  });

  it("deactivating warns about the weeks still scheduled", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/providers/2/active`, "admin", { active: false, reason: "leave" });
    expect(r.status).toBe(200);
    expect(r.body.warnings.join(" ")).toMatch(/2026-12-08/);
    expect(h.store.state.providers.find((p) => p.id === 2)!.active).toBe(false);
  });

  it("hard delete only when never referenced", async () => {
    const h = boot();
    expect((await h.request("POST", `${ON_CALL_API}/providers/1/delete`, "admin", { reason: "x" })).status).toBe(409);
    expect((await h.request("POST", `${ON_CALL_API}/providers/6/delete`, "admin", { reason: "typo" })).status).toBe(200);
    expect(h.store.state.providers.some((p) => p.id === 6)).toBe(false);
  });

  it("reorders the rotation without two rows ever sharing a place", async () => {
    const h = boot();
    const r = await h.request("POST", `${ON_CALL_API}/providers/reorder`, "admin", { orderedIds: [3, 1, 2, 4, 5], reason: "new order" });
    expect(r.status).toBe(200);
    const order = Object.fromEntries(h.store.state.providers.filter((p) => p.rotationOrder !== null).map((p) => [p.id, p.rotationOrder]));
    expect(order).toEqual({ 3: 1, 1: 2, 2: 3, 4: 4, 5: 5 });
    expect((await h.request("POST", `${ON_CALL_API}/providers/reorder`, "admin", { orderedIds: [1, 2], reason: "x" })).status).toBe(400);
  });

  it("an edit writes and audits only what changed; an edit that changes nothing is refused", async () => {
    const h = boot();
    const same = { fullName: "Dr. Test Beta", phone: "+15555550102", region: "Los Angeles", email: "", npi: "", reason: "x" };
    expect((await h.request("PATCH", `${ON_CALL_API}/providers/2`, "admin", same)).status).toBe(400);
    const r = await h.request("PATCH", `${ON_CALL_API}/providers/2`, "admin", { ...same, phone: "555-555-0177" });
    expect(r.status).toBe(200);
    expect(h.store.state.audit).toHaveLength(1);
    expect(h.store.state.providers.find((p) => p.id === 2)!.phone).toBe("+15555550177");
    // The log keeps the number; the audit tab shows the last four.
    const log = await h.request("GET", `${ON_CALL_API}/audit`);
    expect(log.body.rows[0].after.phone).toBe("…0177");
    expect(JSON.stringify(log.body)).not.toContain("5555550177");
  });

  it("an edit that resubmits a blank or invalid phone unchanged is not refused for it (review of #520)", async () => {
    const h = boot();
    // Provider 5's phone on file is blank; the dialog sends it back as it was.
    const r = await h.request("PATCH", `${ON_CALL_API}/providers/5`, "admin", {
      fullName: "Dr. Test NoPhone",
      phone: "",
      region: "Inland Empire",
      email: "",
      npi: "",
      inRotation: false,
      reason: "escalation only",
    });
    expect(r.status).toBe(200);
    expect(h.store.state.providers.find((p) => p.id === 5)).toMatchObject({ phone: "", rotationOrder: null });
    expect(h.store.state.audit).toHaveLength(1);
    // A phone the admin did change is still validated.
    const bad = await h.request("PATCH", `${ON_CALL_API}/providers/5`, "admin", { phone: "12", reason: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not a phone/);
  });

  it("an unchanged name another provider shares is not re-checked; a new one is", async () => {
    const s = fixture();
    s.providers.find((p) => p.id === 6)!.fullName = "Dr. Test Alpha";
    const h = boot({}, s);
    const ok = await h.request("PATCH", `${ON_CALL_API}/providers/6`, "admin", { fullName: "Dr. Test Alpha", email: "a@example.test", reason: "x" });
    expect(ok.status).toBe(200);
    const clash = await h.request("PATCH", `${ON_CALL_API}/providers/2`, "admin", { fullName: "Dr. Test Gamma", reason: "x" });
    expect(clash.status).toBe(400);
  });

  it("refuses the rotation's own caller ID as a provider phone, on create and on change (review of #520)", async () => {
    const h = boot({}, fixture(), { TWILIO_PHONE_NUMBER: "+15550000001" });
    const create = await h.request("POST", `${ON_CALL_API}/providers`, "admin", { fullName: "Dr. Test New", phone: "555-000-0001", region: "Inland Empire", reason: "x" });
    expect(create.status).toBe(400);
    expect(create.body.error).toMatch(/caller ID/);
    const change = await h.request("PATCH", `${ON_CALL_API}/providers/2`, "admin", { phone: "+15550000001", reason: "x" });
    expect(change.status).toBe(400);
    expect(change.body.error).toMatch(/caller ID/);
    // ON_CALL_CALLER_ID wins over TWILIO_PHONE_NUMBER, as the runtime resolves it.
    const h2 = boot({}, fixture(), { ON_CALL_CALLER_ID: "+15550000002", TWILIO_PHONE_NUMBER: "+15550000001" });
    expect((await h2.request("PATCH", `${ON_CALL_API}/providers/2`, "admin", { phone: "+15550000001", reason: "x" })).status).toBe(200);
    expect((await h2.request("PATCH", `${ON_CALL_API}/providers/3`, "admin", { phone: "+15550000002", reason: "x" })).status).toBe(400);
  });

  it("a provider whose phone on file is the caller ID cannot be scheduled, covered, made director or extended into", async () => {
    const s = fixture();
    s.providers.find((p) => p.id === 2)!.phone = "+15550000001";
    const h = boot({}, s, { TWILIO_PHONE_NUMBER: "+15550000001" });
    const assign = await h.request("POST", `${ON_CALL_API}/schedule/assign`, "admin", { week: "2026-12-15", providerId: 2, reason: "x" });
    expect(assign.status).toBe(400);
    expect(assign.body.error).toMatch(/caller ID/);
    const director = await h.request("PUT", `${ON_CALL_API}/directors`, "admin", { region: "San Diego", providerId: 2, reason: "x" });
    expect(director.status).toBe(400);
    const list = await h.request("GET", `${ON_CALL_API}/providers`);
    expect(list.body.providers.find((p: { id: number }) => p.id === 2).phoneDialable).toBe(false);
    expect(list.body.providers.find((p: { id: number }) => p.id === 1).phoneDialable).toBe(true);
  });

  it("the providers tab shows full phones; nothing else does", async () => {
    const h = boot();
    expect(JSON.stringify((await h.request("GET", `${ON_CALL_API}/providers`)).body)).toContain("+15555550101");
    expect(JSON.stringify((await h.request("GET", `${ON_CALL_API}/schedule`)).body)).not.toMatch(/5555550\d{3}/);
    expect(JSON.stringify((await h.request("GET", `${ON_CALL_API}/escalation`)).body)).not.toMatch(/5555550\d{3}/);
  });
});

describe("directors", () => {
  it("sets a region's director, refuses an unknown region unless new, and never deletes FINAL", async () => {
    const h = boot();
    expect((await h.request("PUT", `${ON_CALL_API}/directors`, "admin", { region: "los angeles", providerId: 11, reason: "x" })).status).toBe(200);
    expect(h.store.state.directors.find((d) => d.region === "Los Angeles")!.providerId).toBe(11);
    expect((await h.request("PUT", `${ON_CALL_API}/directors`, "admin", { region: "Orange County", providerId: 11, reason: "x" })).status).toBe(400);
    expect((await h.request("PUT", `${ON_CALL_API}/directors`, "admin", { region: "Orange County", providerId: 11, newRegion: true, reason: "x" })).status).toBe(200);
    expect((await h.request("POST", `${ON_CALL_API}/directors/delete`, "admin", { region: "FINAL", reason: "x" })).status).toBe(400);
    expect((await h.request("POST", `${ON_CALL_API}/directors/delete`, "admin", { region: "Inland Empire", reason: "x" })).status).toBe(409);
    expect((await h.request("POST", `${ON_CALL_API}/directors/delete`, "admin", { region: "Orange County", reason: "x" })).status).toBe(200);
  });
});

describe("calls", () => {
  it("lists the chain with its outcome, and opens a merged timeline", async () => {
    const h = boot();
    const list = await h.request("GET", `${ON_CALL_API}/calls`);
    expect(list.body.calls[0]).toMatchObject({ callSid: SID, chain: { status: "exhausted", exhausted: true, calls: 1 } });
    const one = await h.request("GET", `${ON_CALL_API}/calls/${SID}`);
    expect(one.status).toBe(200);
    expect(one.body.timeline.map((i: any) => i.source)).toEqual(["attempt", "escalation", "escalation"]);
    expect(one.body.sections.extraEvents.wired).toBe(false);
    expect(JSON.stringify(one.body)).not.toContain("5555550101");
    expect((await h.request("GET", `${ON_CALL_API}/calls/not-a-sid`)).status).toBe(400);
  });

  it("lists no chain that placed no call (queued or SMS-only)", async () => {
    const s = fixture();
    const sid2 = "CA" + "b".repeat(32);
    const sid3 = "CA" + "c".repeat(32);
    s.escalations.push(
      { ...s.escalations[0], id: 8, callSid: sid2, status: "active" },
      { ...s.escalations[0], id: 9, callSid: sid3, status: "pending" },
    );
    s.attempts.push({ ...s.attempts[0], id: 2, escalationId: 8, callSid: sid2, kind: "sms", outcome: "sent" });
    const list = await boot({}, s).request("GET", `${ON_CALL_API}/calls`);
    expect(list.body.calls.map((c: any) => c.callSid)).toEqual([SID]);
  });

  // Review of #520, round 3: a background call row the worker wrote and then
  // stopped on (no_status, no Twilio sid) never rang; only the sid proves it.
  it("lists a background call only when it has a provider call sid", async () => {
    const s = fixture();
    const sid2 = "CA" + "b".repeat(32);
    const sid3 = "CA" + "c".repeat(32);
    s.escalations.push(
      { ...s.escalations[0], id: 8, callSid: sid2, status: "exhausted" },
      { ...s.escalations[0], id: 9, callSid: sid3, status: "exhausted" },
    );
    s.attempts.push(
      { ...s.attempts[0], id: 2, escalationId: 8, callSid: sid2, kind: "call", outcome: "no_status", providerCallSid: null },
      { ...s.attempts[0], id: 3, escalationId: 9, callSid: sid3, kind: "call", outcome: "no_status", providerCallSid: "CA" + "d".repeat(32) },
    );
    const list = await boot({}, s).request("GET", `${ON_CALL_API}/calls`);
    expect(list.body.calls.map((c: any) => c.callSid).sort()).toEqual([SID, sid3].sort());
  });

  // Review of #520, round 10: an escalation row with no qualifying attempt
  // must not hide a call whose tool timeline confirms the dial.
  it("lists a timeline-confirmed dial once when its escalation has no qualifying attempt", async () => {
    const s = fixture();
    const sid2 = "CA" + "e".repeat(32);
    s.escalations.push({ ...s.escalations[0], id: 8, callSid: sid2, status: "exhausted" });
    s.attempts.push({ ...s.attempts[0], id: 2, escalationId: 8, callSid: sid2, kind: "call", outcome: "no_status", providerCallSid: null });
    const log = (id: string, callSid: string) => ({
      id, callSid, from: "+15555550177", agentUsed: "no-ivr", voiceProvider: "grok", status: "completed",
      runtimeOutcome: null, agentOutcome: null, summary: null, duration: 60,
      startTime: new Date("2026-12-05T05:00:00Z"), endTime: new Date("2026-12-05T05:01:00Z"), createdAt: new Date("2026-12-05T05:00:00Z"),
      transferredToHuman: false, ticketNumber: null,
      toolTimeline: { events: [{ tool: "escalate_to_human", at: "2026-12-05T05:00:20Z", ms: 10, args: {}, outcome: { dialAttempted: true } }] },
    });
    // SID's escalation qualifies, so its timeline must not list it a second time.
    s.callLogs.push(log("log-1", SID), log("log-2", sid2));
    const list = await boot({}, s).request("GET", `${ON_CALL_API}/calls`);
    const sids = list.body.calls.map((c: any) => c.callSid);
    expect(sids.filter((x: string) => x === sid2)).toHaveLength(1);
    expect(sids.filter((x: string) => x === SID)).toHaveLength(1);
    expect(list.body.calls.find((c: any) => c.callSid === sid2).chain).toBeNull();
  });

  // Review of #520, round 11: an escalation just outside the range is not
  // listed by the escalations query, so it must not hide its call here.
  it("lists a timeline-confirmed dial once when its dialled escalation falls just outside the range", async () => {
    const s = fixture();
    const sid2 = "CA" + "f".repeat(32);
    // days=1 reads from 2026-12-04T06:00Z; the escalation is a minute before.
    s.escalations.push({ ...s.escalations[0], id: 8, callSid: sid2, status: "exhausted", createdAt: new Date("2026-12-04T05:59:00Z") });
    s.attempts.push({ ...s.attempts[0], id: 2, escalationId: 8, callSid: sid2 });
    s.callLogs.push({
      id: "log-3", callSid: sid2, from: "+15555550177", agentUsed: "no-ivr", voiceProvider: "grok", status: "completed",
      runtimeOutcome: null, agentOutcome: null, summary: null, duration: 60,
      startTime: new Date("2026-12-04T06:01:00Z"), endTime: new Date("2026-12-04T06:02:00Z"), createdAt: new Date("2026-12-04T06:01:00Z"),
      transferredToHuman: false, ticketNumber: null,
      toolTimeline: { events: [{ tool: "escalate_to_human", at: "2026-12-04T06:01:20Z", ms: 10, args: {}, outcome: { dialAttempted: true } }] },
    });
    const list = await boot({}, s).request("GET", `${ON_CALL_API}/calls?days=1`);
    const sids = list.body.calls.map((c: any) => c.callSid);
    expect(sids.filter((x: string) => x === sid2)).toHaveLength(1);
  });

  it("sends no escalation plan and no full E.164 number on the calls list or a call's detail", async () => {
    const s = fixture();
    s.escalations[0].plan = { levels: [{ role: "on_call", providerId: 1, name: "Dr. Test Alpha", phone: "+15555550101" } as any], notes: [] };
    s.escalations[0].routing = { reason: "on_call", note: "fallback +15555550199", testPhone: "+15555550198" };
    s.callLogs.push({
      id: "log-1", callSid: SID, from: "+15555550177", agentUsed: "no-ivr", voiceProvider: "grok", status: "completed",
      runtimeOutcome: null, agentOutcome: null, summary: null, duration: 60,
      startTime: new Date("2026-12-05T05:00:00Z"), endTime: new Date("2026-12-05T05:01:00Z"), createdAt: null,
      transferredToHuman: false, ticketNumber: null,
      toolTimeline: { events: [{ tool: "escalate_to_human", at: "2026-12-05T05:00:20Z", ms: 10, args: { to: "+15555550166" }, outcome: { success: true } }] },
    });
    const h = boot({}, s);
    const one = await h.request("GET", `${ON_CALL_API}/calls/${SID}`);
    expect(one.status).toBe(200);
    expect(one.body.escalation).not.toHaveProperty("plan");
    expect(JSON.stringify(one.body)).not.toMatch(/\+\d{10,15}/);
    expect(JSON.stringify((await h.request("GET", `${ON_CALL_API}/calls`)).body)).not.toMatch(/\+\d{10,15}/);
  });

  it("skips malformed tool-timeline entries instead of failing the call detail", async () => {
    const s = fixture();
    s.callLogs.push({
      id: "log-2", callSid: SID, from: null, agentUsed: "no-ivr", voiceProvider: "grok", status: "completed",
      runtimeOutcome: null, agentOutcome: null, summary: null, duration: 60,
      startTime: new Date("2026-12-05T05:00:00Z"), endTime: null, createdAt: null, transferredToHuman: false, ticketNumber: null,
      toolTimeline: { events: [null, 7, "x", [], { tool: "a" }, { tool: "b", at: "not a date" }, { tool: "c", at: "2026-12-05T05:00:20Z", ms: "huge" }, { tool: "lookup_patient", at: "2026-12-05T05:00:10Z", ms: 5 }] },
    });
    const one = await boot({}, s).request("GET", `${ON_CALL_API}/calls/${SID}`);
    expect(one.status).toBe(200);
    expect(one.body.timeline.filter((i: any) => i.source === "tool").map((i: any) => i.kind)).toEqual(["lookup_patient", "c"]);
  });
});

describe("the admin store follows the database pool", () => {
  it("builds one store per pool and a new one when db.ts swaps the pool", () => {
    const first = { name: "first" };
    const second = { name: "second" };
    let live: object = first;
    const create = vi.fn((p: object) => ({ pool: p }));
    const get = storePerPool(() => live, create);
    const a = get();
    expect(get()).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
    live = second; // a failover or recycle reassigns the exported pool
    const b = get();
    expect(b).not.toBe(a);
    expect(b.pool).toBe(second);
    expect(get()).toBe(b);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("routes.ts reads the live pool on every request, never caching the first one", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    expect(src).toContain("storePerPool(() => pool,");
    expect(src).not.toMatch(/onCallAdminStore\s*\?\?=/);
  });
});

describe("maskAuditSnapshot", () => {
  it("masks phone fields and free text while preserving timestamps and ids", () => {
    expect(maskAuditSnapshot({ phone: "+14155550123", note: "call me at 415-555-0199", startsAt: "2026-11-24T10:00:00Z", id: 12 })).toEqual({
      phone: "…0123", note: "call me at …0199", startsAt: "2026-11-24T10:00:00Z", id: 12,
    });
  });

  it("recurses through objects and arrays without masking keys or numbers", () => {
    expect(maskAuditSnapshot({ nested: [{ "4155550199": { callbackPhone: "+14155550123", note: "call 415-555-0199", id: 123456789, phone: 4155550123, active: true, missing: null } }] })).toEqual({
      nested: [{ "4155550199": { callbackPhone: "…0123", note: "call …0199", id: 123456789, phone: 4155550123, active: true, missing: null } }],
    });
  });
});

describe("calendar dates in free text", () => {
  it.each(["2026-02-30", "2026-04-31", "2025-02-29", "1900-02-29", "2/30/2026"])("masks impossible date %j", (input) => {
    const out = maskPhonesInText(input);
    expect(out).not.toBe(input);
    expect(out).not.toContain(input);
    expect(out).toContain("…");
  });

  it.each(["2024-02-29", "2000-02-29", "2026-11-24", "2026-11-24T10:30:00Z", "11/24/2026", "12/31/2026"])("keeps real date %j verbatim", (input) => {
    expect(maskPhonesInText(input)).toBe(input);
  });
});

// Review of #520: call detail and the call list mask a phone in any common
// written form to its last four, and leave dates, times, ticket numbers and
// SIDs alone.
describe("maskCallPhones in free text", () => {
  it.each([
    ["call me at (415) 555-0123 please", "call me at …0123 please"],
    ["415-555-0123", "…0123"],
    ["5555-12-34", "…1234"],
    ["2026-13-01", "…1301"],
    ["2026-11-32", "…1132"],
    ["0000-00-00", "…0000"],
    ["1899-12-31", "…1231"],
    ["2100-01-01", "…0101"],
    ["2026-11-24T25:00:00Z", "…1124T25:00:00Z"],
    ["2026-11-24T10:60:00Z", "…1124T10:60:00Z"],
    ["2026-11-24T10:30:99Z", "…1124T10:30:99Z"],
    ["2026-11-24T10:30:00+25:00", "…1124T10:30:00+25:00"],
    ["415.555.0123", "…0123"],
    ["415 555 0123", "…0123"],
    ["4155550123", "…0123"],
    ["1-415-555-0123", "…0123"],
    ["+1 (415) 555-0123", "…0123"],
    ["+14155550123.", "…0123."],
    ["call +44 20 7946 0958 now", "call …0958 now"],
    ["+52 55 1234 5678", "…5678"],
    ["+44.20.7946.0958", "…0958"],
    ["+33-1-23-45-67-89", "…6789"],
    ["it is 4 1 5 5 5 5 0 1 2 3 thanks", "it is …0123 thanks"],
    ["4, 1, 5, 5, 5, 5, 0, 1, 2, 3", "…0123"],
    // Review of #520, round 4: the one general rule.
    ["+1 415 555 0123", "…0123"],
    ["0044 20 7946 0958", "…0958"],
    ["call 0044 20 7946 0958 now", "call …0958 now"],
    ["00 52 55 1234 5678", "…5678"],
    ["555-0123", "…0123"],
    ["a+4155550123", "a…0123"],
    // Review of #520, round 10: a run glued to letters or an underscore is masked.
    ["callback_2125550198", "callback_…0198"],
    ["x4155550123", "x…0123"],
    ["4155550123_tail", "…0123_tail"],
    ["phone=4155550123abc", "phone=…0123abc"],
    ["id_415-555-0123", "id_…0123"],
    ["(415)555-0123", "…0123"],
    ["on 2026-11-24 call 415-555-0123", "on 2026-11-24 call …0123"],
    // A time or date joined to a phone by separators is part of the run (round 8).
    ["10:30 555-0123", "10:…0123"],
    ["11/24/2026 4155550123", "11/24/…0123"],
    ["10:30 at 555-0123", "10:30 at …0123"],
    // Review of #520, round 8: a dash-date shape, and separator runs.
    ["44-20-7946 0958", "…0958"],
    ["415  555  0132", "…0132"],
    ["415 - 555 - 0132", "…0132"],
    ["(415)  555--0132", "…0132"],
    ["at 2026-11-24T10:30:00Z (415) 555-0123", "at 2026-11-24T10:30:00Z …0123"],
  ])("masks %j", (input, out) => {
    expect(maskCallPhones(input)).toBe(out);
  });

  it.each([
    "born 03/17/1973",
    "DOB 1973-03-17",
    "2026-11-24",
    "1960-01-02",
    "1900-01-01",
    "2099-12-31",
    "on 2026-11-24",
    "at 2026-11-24T10:30:00Z",
    "at 2026-12-05T06:00:40.000Z",
    "2026-11-24 10:30",
    "at 10:30 PM",
    "11/24/2026",
    "01/02/1960",
    "1/2/60",
    "12/31/99",
    "2026-11-24T23:59:59.123-05:00",
    "ticket VA-84772 and PCP-73679",
    "VA-76222",
    "CA0123456789abcdef0123456789abcdef",
    // Twilio SIDs whose hex is mostly digits, alone and after a word or underscore (round 10).
    "CA01234567890123456789012345678901",
    "SM98765432109876543210987654321098",
    "PN12345678901234567890123456789012",
    "sid_CA01234567890123456789012345678901",
    "callSid=CA01234567890123456789012345678901",
    "550e8400-e29b-41d4-a716-446655440000",
    "id_12345678-1234-1234-1234-123456789012",
    "id 550e8400-e29b-41d4-a716-446655440000",
    "order 12345",
    "1 2 3",
    "555-012",
  ])("leaves %j alone", (input) => {
    expect(maskCallPhones(input)).toBe(input);
  });

  it("a date written with dashes may be masked, but never leaves 7 digits in a row", () => {
    for (const d of ["12-05-2026", "on 12-05-2026 at noon"]) {
      expect((maskCallPhones(d) as string).replace(/\D/g, "")).not.toMatch(/\d{7}/);
    }
  });

  // Fuzz (seeded, deterministic): random phones split into random groups by
  // random runs of any separator, in random text.
  it("never leaves 7 phone digits in a row for random separator runs", () => {
    let seed = 520;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const seps = [" ", " ", " ", " ", " ", "\t", "-", "‐", "–", "—", "−", ".", ",", "(", ")"];
    const words = ["call", "me", "at", "please", "the", "number", "is", "thanks", "ok"];
    for (let i = 0; i < 500; i++) {
      const n = 10 + Math.floor(rnd() * 6);
      let digits = "";
      for (let j = 0; j < n; j++) digits += String(Math.floor(rnd() * 10));
      // Round 11: sometimes written in another script's digits (ASCII,
      // Arabic-Indic, Persian, Devanagari, Bengali), or mixed digit by digit.
      const zeros = [0x30, 0x30, 0x660, 0x6f0, 0x966, 0x9e6];
      const zero = pick(zeros);
      const mixed = rnd() < 0.2;
      const script = (s: string) =>
        s.replace(/\d/g, (d) => String.fromCodePoint((mixed ? pick(zeros) : zero) + Number(d)));
      let phone = "";
      let k = 0;
      while (k < digits.length) {
        const len = 1 + Math.floor(rnd() * 4);
        if (k > 0) for (let r = 1 + Math.floor(rnd() * 3); r > 0; r--) phone += pick(seps);
        phone += script(digits.slice(k, k + len));
        k += len;
      }
      const prefix = pick(["", "", "+", "00"]);
      const before = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(words)).join(" ");
      const after = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(words)).join(" ");
      // Round 10: the phone may be glued to letters or an underscore on either side.
      const glueBefore = pick(["", "", "x", "callback_", "id_", "tel"]);
      const glueAfter = pick(["", "", "x", "_tail", "abc"]);
      const input = `${before} ${glueBefore}${prefix}${phone}${glueAfter} ${after}`;
      const out = maskCallPhones(input) as string;
      const stripped = out.normalize("NFKC").replace(/[\s.,()\p{Pd}−]/gu, "");
      expect(stripped, `${JSON.stringify(input)} -> ${out}`).not.toMatch(/\p{Nd}{7}/u);
      expect(out, JSON.stringify(input)).toContain(`…${digits.slice(-4)}`);
    }
  });

  // Review of #520, round 11: NFKC leaves non-ASCII decimal digits as they are
  // and `\d` is ASCII-only; they are folded to ASCII before the rule runs.
  it.each([
    ["Arabic-Indic", "call ٢١٢٥٥٥٠١٩٨ please", "…0198"],
    ["Persian", "call ۲۱۲-۵۵۵-۰۱۹۸ please", "…0198"],
    ["Devanagari", "call +१ २१२ ५५५ ०१९८", "…0198"],
    ["Bengali", "call ২১২৫৫৫০১৯৮", "…0198"],
    ["mixed scripts", "call 212 ٥٥٥ ०१९८", "…0198"],
  ])("masks a phone written in %s digits", (_name, input, tail) => {
    const out = maskCallPhones(input) as string;
    expect(out).toContain(tail);
    expect(out).not.toMatch(/\p{Nd}{5}/u);
  });

  it("masks a phone-named key written in Arabic-Indic digits to its ASCII last four", () => {
    expect(maskCallPhones({ phone: "٢١٢٥٥٥٠١٩٨" })).toEqual({ phone: "…0198" });
  });

  // Property: whatever phone shape goes in, no 7 consecutive digits (ignoring
  // the separators the rule allows) come out, alone or inside a sentence.
  it("never leaves 7 or more phone digits in a row", () => {
    const phones = [
      "+1 415 555 0123", "+14155550123", "(415) 555-0123", "415-555-0123", "415.555.0123",
      "4155550123", "0044 20 7946 0958", "+44 20 7946 0958", "00 52 55 1234 5678", "555-0123",
      "+1 (415) 555-0123", "1-415-555-0123", "4 1 5 5 5 5 0 1 2 3", "+33-1-23-45-67-89", "415 5550123",
    ];
    const wraps = [(p: string) => p, (p: string) => `call ${p}.`, (p: string) => `(${p})`, (p: string) => `on 2026-11-24, ${p}, 10:30`];
    for (const p of phones) {
      for (const w of wraps) {
        const out = maskCallPhones(w(p)) as string;
        expect(out).not.toContain(p);
        // The wrapping date and time are kept by design; take them out before counting.
        const digitsOnly = out.replace("2026-11-24", "").replace("10:30", "").replace(/[ .,()+-]/g, "");
        expect(digitsOnly, `${w(p)} -> ${out}`).not.toMatch(/\d{7}/);
      }
    }
  });

  // Review of #520, round 7: Unicode separators and full-width digits.
  it.each([
    ["no-break space", "+44 20 7946 0958", "…0958"],
    ["narrow no-break space", "call +44 20 7946 0958 now", "call …0958 now"],
    ["thin space", "415 555 0123", "…0123"],
    ["figure space", "415 555 0123", "…0123"],
    ["en dash", "415–555–0123", "…0123"],
    ["em dash", "415—555—0123", "…0123"],
    ["minus sign", "415−555−0123", "…0123"],
    ["hyphen", "415‐555‐0123", "…0123"],
    ["full-width digits", "４１５５５５０１２３", "…0123"],
    ["full-width plus", "＋1 415 555 0123", "…0123"],
    ["dash after a plus (not a date)", "+44-20-7946-0958", "…0958"],
    ["comma and no-break space","4, 1, 5, 5, 5, 5, 0, 1, 2, 3", "…0123"],
  ])("masks a phone with a %s", (_name, input, out) => {
    expect(maskCallPhones(input)).toBe(out);
    expect(maskCallPhones({ callerPhone: input })).toEqual({ callerPhone: out.slice(out.indexOf("…"), out.indexOf("…") + 5) });
  });

  it("still keeps dates, times and identifiers next to Unicode-separated phones", () => {
    expect(maskCallPhones("on 2026-11-24 call 415 555 0123 at 10:30")).toBe("on 2026-11-24 call …0123 at 10:30");
    expect(maskCallPhones("CA0123456789abcdef0123456789abcdef id 550e8400-e29b-41d4-a716-446655440000")).toBe(
      "CA0123456789abcdef0123456789abcdef id 550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("never leaves 7 or more phone digits in a row across Unicode separators", () => {
    const seps = [" ", " ", " ", " ", " ", "–", "—", "‐", "−", ".", "-"];
    const groups = [["415", "555", "0123"], ["+44", "20", "7946", "0958"], ["00", "52", "55", "1234", "5678"]];
    const wraps = [(p: string) => p, (p: string) => `call ${p}.`, (p: string) => `(${p})`, (p: string) => `on 2026-11-24, ${p}, 10:30`];
    for (const sep of seps) {
      for (const g of groups) {
        for (const w of wraps) {
          const out = maskCallPhones(w(g.join(sep))) as string;
          const digitsOnly = out.replace("2026-11-24", "").replace("10:30", "").replace(/\D/g, "");
          expect(digitsOnly, `${JSON.stringify(w(g.join(sep)))} -> ${out}`).not.toMatch(/\d{7}/);
        }
      }
    }
  });

  it("masks a phone stored as a JSON number, and leaves small numbers alone", () => {
    expect(maskCallPhones({ args: { phone_number: 4155550123, other: 14155550123, durationSec: 312, id: 7 } })).toEqual({
      args: { phone_number: "…0123", other: "…0123", durationSec: 312, id: 7 },
    });
  });

  it("masks every string in a nested call-detail shape", () => {
    expect(
      maskCallPhones({ timeline: [{ text: "my number is (415) 555-0123", data: { message: "dialled 415-555-0199" } }] }),
    ).toEqual({ timeline: [{ text: "my number is …0123", data: { message: "dialled …0199" } }] });
  });

  it("masks phone numbers in object keys and their nested values", () => {
    expect(maskCallPhones({ "+14155550123": { "call 415-555-0199": "+14155550123" }, "4155550199": 1 })).toEqual({
      "…0123": { "call …0199": "…0123" }, "…0199": 1,
    });
  });

  it("keeps all entries when masked keys or their suffixes collide", () => {
    const input = { "+14155550123": 1, "415-555-0123": 2, "1-415-555-0123#2": 3, "(415) 555-0123": 4 };
    const expected = { "…0123": 1, "…0123#2": 2, "…0123#2#2": 3, "…0123#3": 4 };
    expect(maskCallPhones({ nested: [input] })).toEqual({ nested: [expected] });
    expect(maskCallPhones(input)).toEqual(expected);
  });
});
