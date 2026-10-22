/**
 * Stage C, step 3 — the measurement engine. Synthetic fixtures only: call
 * SIDs are invented, no names, no phones. Each describe pins one property the
 * approved plan asks for: the definitions are versioned, the reads follow the
 * written rules, the run is deterministic and transactional, the engine is
 * OFF by default, and the export carries no PHI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONSOLE_BOOKED_SQL,
  DEFINITIONS_HASH,
  FIVESTAR_BOOKINGS_SQL,
  FIVESTAR_CALLS_SQL,
  METHOD_VERSION,
  METRICS,
  REMIX_CALLS_SQL,
  SUPPORT_PROVENANCE_SQL,
  definitionsText,
} from "./definitions";
import { computeFivestar, computeRemix, npxBooked, type Query, type Sources } from "./compute";
import {
  DAY_LOCK_SQL,
  DELETE_VALUES_SQL,
  INSERT_VALUES_SQL,
  TABLES_SQL,
  UPSERT_RUN_SQL,
  outputHash,
  runLearningDay,
  type RunnerDeps,
} from "./runner";
import {
  EXPORT_RUNS_SQL,
  EXPORT_VALUES_SQL,
  _resetLearningSchedulerForTests,
  daysDue,
  learningExportHandler,
  learningTick,
  pacificClock,
  startLearningRunner,
} from "./scheduler";
import { METRIC_SHAPES, detectCandidates, knownShapes, type StoredValue } from "./candidates";

// The Hub pool validates the environment at import; the engine's own tests
// inject every query, so the real pool is never needed here.
vi.mock("../db", () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetLearningSchedulerForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("a definition change is a new method version", () => {
  it("the pinned hash is the hash of the definitions as written", () => {
    const h = createHash("sha256").update(definitionsText()).digest("hex").slice(0, 16);
    // If this fails you changed a definition: bump METHOD_VERSION and pin the new hash beside it.
    expect(h).toBe(DEFINITIONS_HASH);
    expect(METHOD_VERSION).toBe("learning-v1");
  });

  it("every statement and every definition is inside the hashed text", () => {
    const text = definitionsText();
    for (const s of [REMIX_CALLS_SQL, SUPPORT_PROVENANCE_SQL, FIVESTAR_CALLS_SQL, FIVESTAR_BOOKINGS_SQL, CONSOLE_BOOKED_SQL]) {
      expect(text).toContain(s);
    }
    for (const m of METRICS) expect(text).toContain(m.definition);
  });

  it("only the Support Center and mirror readings are marked independent", () => {
    const ind = METRICS.filter((m) => m.independent).map((m) => m.id).sort();
    expect(ind).toEqual(["5star.booked_rate_a", "5star.booked_rate_b", "remix.filed_rate_independent"]);
  });

  it("no metric combines the fleet and 5Star", () => {
    for (const m of METRICS) expect(m.id.startsWith(m.repo === "Remix" ? "remix." : "5star.")).toBe(true);
  });
});

describe("the reads follow the written rules (CLAUDE.md and the Daybook)", () => {
  it("fleet calls: canonical SID, not outbound, duration >= 30, the call's own Pacific day from a UTC timestamp", () => {
    expect(REMIX_CALLS_SQL).toContain("call_sid ~* '^CA[0-9a-f]{32}$'");
    expect(REMIX_CALLS_SQL).not.toMatch(/LIKE 'CA%'/);
    expect(REMIX_CALLS_SQL).toContain("coalesce(direction, 'inbound') <> 'outbound'");
    expect(REMIX_CALLS_SQL).toContain("duration >= 30");
    expect(REMIX_CALLS_SQL).toContain("((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date = $1::date");
  });

  it("provenance reads the creator and agent fields, never a ticket prefix", () => {
    expect(SUPPORT_PROVENANCE_SQL).toContain("bool_or(created_by_id IS NULL AND agent_used IS NOT NULL) AS any_agent");
    expect(SUPPORT_PROVENANCE_SQL).toContain("bool_or(created_by_id IS NULL AND agent_used IS NULL)     AS any_unknown");
    expect(SUPPORT_PROVENANCE_SQL).not.toMatch(/ticket_number|VA-|PCP-/);
  });

  it("5Star calls: the DRS line, not simulated, the UTC-to-Pacific day (82, not the naive 108)", () => {
    expect(FIVESTAR_CALLS_SQL).toContain("to_phone = '+16266998484'");
    expect(FIVESTAR_CALLS_SQL).toContain("coalesce(simulated, false) = false");
    expect(FIVESTAR_CALLS_SQL).toContain("notes LIKE 'DRS voice call%'");
    expect(FIVESTAR_CALLS_SQL).toContain("((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles')::date");
    expect(FIVESTAR_CALLS_SQL).toContain("coalesce(transcript, '') ~ 'CALLER:'");
    // response_excerpt can hold caller words: only the step fields leave the statement.
    expect(FIVESTAR_CALLS_SQL).not.toMatch(/SELECT[^;]*response_excerpt\s*(,|AS|FROM)/);
  });

  it("the booking slot time is HHMM like the mirror's begin_time", () => {
    expect(FIVESTAR_BOOKINGS_SQL).toContain("replace(left(coalesce(b.slot_begintime, ''), 5), ':', '') AS slot_time");
    expect(CONSOLE_BOOKED_SQL).toContain("f.begin_time = b.slot_time");
  });

  it("a moved appointment still counts only while the person holds an uncancelled one", () => {
    expect(CONSOLE_BOOKED_SQL).toContain("coalesce(h.is_rescheduled, false)");
    expect(CONSOLE_BOOKED_SQL).toContain("g.appointment_date >= h.since");
  });
});

function fakeQuery(handler: (text: string, params?: unknown[]) => any[] | Promise<any[]>): Query & { calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const q = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows: await handler(text, params) };
  }) as Query & { calls: typeof calls };
  q.calls = calls;
  return q;
}

const remixRows = [
  { call_sid: sid(1), lane: "tech", runtime_marker: "v111", filed: true },
  { call_sid: sid(2), lane: "tech", runtime_marker: "v111", filed: false },
  { call_sid: sid(3), lane: "tech", runtime_marker: "", filed: true },
  { call_sid: sid(4), lane: "pcp", runtime_marker: "v111", filed: true },
  { call_sid: sid(5), lane: "pcp", runtime_marker: "v111", filed: false },
];

function sources(over: Partial<Sources> = {}): Sources {
  return {
    hub: fakeQuery(() => remixRows),
    hubHasRuntimeMarker: true,
    fivestarHasBuildId: true,
    ...over,
  };
}

describe("the fleet filed rate", () => {
  it("counts per lane and per build, with an unknown build kept apart", async () => {
    const r = await computeRemix("2026-10-20", sources());
    const v = r.values.filter((x) => x.metricId === "remix.filed_rate");
    expect(v).toContainEqual(expect.objectContaining({ lane: "tech", runtimeMarker: "v111", numerator: 1, denominator: 2 }));
    expect(v).toContainEqual(expect.objectContaining({ lane: "tech", runtimeMarker: "", numerator: 1, denominator: 1 }));
    expect(v).toContainEqual(expect.objectContaining({ lane: "pcp", runtimeMarker: "v111", numerator: 1, denominator: 2 }));
  });

  it("reads NULL for the build when the column does not exist yet", async () => {
    const hub = fakeQuery(() => []);
    await computeRemix("2026-10-20", sources({ hub, hubHasRuntimeMarker: false }));
    expect(hub.calls[0].text).toContain("nullif(btrim(NULL::text), '')");
    expect(hub.calls[0].text).not.toContain("btrim(runtime_marker)");
  });

  it("without the Support Center role the independent rate is unavailable, never zero", async () => {
    const r = await computeRemix("2026-10-20", sources());
    expect(r.values.some((x) => x.metricId === "remix.filed_rate_independent")).toBe(false);
    expect(r.unavailable["remix.filed_rate_independent"]).toMatch(/A1/);
  });

  it("folds each call agent > UNKNOWN > staff, and UNKNOWN is reported, not counted either way", async () => {
    const supportCenter = fakeQuery(() => [
      { call_sid: sid(1), any_agent: true, any_unknown: true }, // agent wins
      { call_sid: sid(2), any_agent: false, any_unknown: true }, // UNKNOWN
      { call_sid: sid(3), any_agent: false, any_unknown: false }, // staff only
      { call_sid: sid(4), any_agent: true, any_unknown: false },
      // sid(5): no ticket
    ]);
    const r = await computeRemix("2026-10-20", sources({ supportCenter }));
    const v = r.values.filter((x) => x.metricId === "remix.filed_rate_independent");
    expect(v).toContainEqual(expect.objectContaining({ lane: "tech", runtimeMarker: "v111", numerator: 1, denominator: 2, unknownCount: 1 }));
    expect(v).toContainEqual(expect.objectContaining({ lane: "tech", runtimeMarker: "", numerator: 0, denominator: 1, unknownCount: 0 }));
    expect(v).toContainEqual(expect.objectContaining({ lane: "pcp", runtimeMarker: "v111", numerator: 1, denominator: 2, unknownCount: 0 }));
    expect(supportCenter.calls[0].params?.[0]).toEqual(remixRows.map((r) => r.call_sid));
  });

  it("asks the Support Center in chunks", async () => {
    const many = Array.from({ length: 1201 }, (_, i) => ({ call_sid: sid(i + 10), lane: "tech", runtime_marker: "", filed: false }));
    const supportCenter = fakeQuery(() => []);
    await computeRemix("2026-10-20", sources({ hub: fakeQuery(() => many), supportCenter }));
    expect(supportCenter.calls.map((c) => (c.params?.[0] as string[]).length)).toEqual([500, 500, 201]);
  });

  it("a failing Support Center read makes the independent rate unavailable and keeps the write-back rate", async () => {
    const supportCenter = fakeQuery(() => {
      throw new Error("permission denied");
    });
    const r = await computeRemix("2026-10-20", sources({ supportCenter }));
    expect(r.unavailable["remix.filed_rate_independent"]).toMatch(/permission denied/);
    expect(r.values.some((x) => x.metricId === "remix.filed_rate")).toBe(true);
  });
});

// 5Star: c1 booked by NextGen id, c2 booked by person+slot, c3 submitted but the
// mirror says no, c4 NPX firm, c5 NPX fuzzy, c6 cancelled locally, c7 no ids,
// c8 substantive not asked, c9 not substantive.
const fsCalls = [
  { id: "c1", build: "b1", substantive: true, submitted: true, asked: true },
  { id: "c2", build: "b1", substantive: true, submitted: true, asked: true },
  { id: "c3", build: "b1", substantive: true, submitted: true, asked: true },
  { id: "c4", build: "b2", substantive: true, submitted: true, asked: true },
  { id: "c5", build: "b2", substantive: true, submitted: true, asked: true },
  { id: "c6", build: "b2", substantive: true, submitted: true, asked: true },
  { id: "c7", build: "b2", substantive: true, submitted: true, asked: true },
  { id: "c8", build: "b2", substantive: true, submitted: false, asked: false },
  { id: "c9", build: "b2", substantive: false, submitted: false, asked: false },
];
const booking = (call: string, over: Record<string, unknown>) => ({
  call_log_id: call,
  booking_id: `bk-${call}`,
  status: "manual_import_needed",
  source: "manual",
  nextgen_appointment_id: null,
  person_id: null,
  slot_date: "2026-11-04",
  slot_time: "1500",
  npx_link_method: null,
  partner_link_needs_review: false,
  partner_outcome_status: null,
  ...over,
});
const fsBookings = [
  booking("c1", { nextgen_appointment_id: "11111111-1111-1111-1111-111111111111" }),
  booking("c2", { person_id: "22222222-2222-2222-2222-222222222222" }),
  booking("c2", { booking_id: "bk-c2-second", person_id: "22222222-2222-2222-2222-222222222222" }),
  booking("c3", { person_id: "33333333-3333-3333-3333-333333333333" }),
  booking("c4", { source: "npx", npx_link_method: "coordinator", partner_outcome_status: "in_partner_schedule" }),
  booking("c5", { source: "npx", npx_link_method: "fuzzy_needs_review", partner_outcome_status: "in_partner_schedule" }),
  booking("c6", { status: "cancelled", person_id: "66666666-6666-6666-6666-666666666666" }),
  booking("c7", {}),
];

function fsSources(consoleBooked: string[] | null = ["c1|bk-c1", "c2|bk-c2", "c2|bk-c2-second"]) {
  const fivestar = fakeQuery((text) => (text === FIVESTAR_BOOKINGS_SQL ? fsBookings : fsCalls));
  const consoleQ = consoleBooked ? fakeQuery(() => consoleBooked.map((k) => ({ k }))) : undefined;
  return { fivestar, console: consoleQ, src: sources({ fivestar, console: consoleQ }) };
}

describe("the 5Star booked rates", () => {
  it("submitted A, booked A over substantive and booked B over asked, per build", async () => {
    const { src } = fsSources();
    const r = await computeFivestar("2026-10-20", src);
    const get = (id: string, b: string) => r.values.find((v) => v.metricId === id && v.runtimeMarker === b);
    expect(get("5star.submitted_rate_a", "b1")).toMatchObject({ numerator: 3, denominator: 3, lane: "drs-8484" });
    expect(get("5star.submitted_rate_a", "b2")).toMatchObject({ numerator: 4, denominator: 5 });
    // b1: c1 and c2 booked (c2 once, though two bookings), c3 not.
    expect(get("5star.booked_rate_a", "b1")).toMatchObject({ numerator: 2, denominator: 3 });
    // b2: only c4 (NPX firm). c5 fuzzy, c6 cancelled, c7 uncheckable, c8 not submitted.
    expect(get("5star.booked_rate_a", "b2")).toMatchObject({ numerator: 1, denominator: 5 });
    expect(get("5star.booked_rate_b", "b2")).toMatchObject({ numerator: 1, denominator: 4 });
  });

  it("sends the mirror only checkable, uncancelled, non-NPX bookings", async () => {
    const { console: consoleQ } = fsSources();
    const { src } = fsSources();
    await computeFivestar("2026-10-20", src);
    const sent = JSON.parse((src.console as any).calls[0].params[0] as string).map((x: any) => x.k).sort();
    expect(sent).toEqual(["c1|bk-c1", "c2|bk-c2", "c2|bk-c2-second", "c3|bk-c3"]);
    expect(consoleQ).toBeDefined();
  });

  it("only submitted substantive calls are looked up", async () => {
    const { fivestar, src } = fsSources();
    await computeFivestar("2026-10-20", src);
    const asked = fivestar.calls.find((c) => c.text === FIVESTAR_BOOKINGS_SQL)?.params?.[0];
    expect(asked).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  });

  it("the NPX rule is isFirmPartnerLink plus the booked statuses", () => {
    const b = booking("x", { source: "npx", npx_link_method: "auto_match", partner_outcome_status: "awaiting_outcome" });
    expect(npxBooked(b as any)).toBe(true);
    expect(npxBooked({ ...b, partner_link_needs_review: true } as any)).toBe(false);
    expect(npxBooked({ ...b, partner_outcome_status: "partner_reported_cancelled" } as any)).toBe(false);
    expect(npxBooked({ ...b, status: "cancelled" } as any)).toBe(false);
  });

  it("without the Console the booked rates are unavailable and submitted still reports", async () => {
    const { src } = fsSources(null);
    const r = await computeFivestar("2026-10-20", src);
    expect(r.unavailable["5star.booked_rate_a"]).toMatch(/Console/);
    expect(r.values.some((v) => v.metricId === "5star.booked_rate_a")).toBe(false);
    expect(r.values.some((v) => v.metricId === "5star.submitted_rate_a")).toBe(true);
  });

  it("without 5Star every 5Star metric is unavailable", async () => {
    const r = await computeFivestar("2026-10-20", sources());
    expect(Object.keys(r.unavailable).sort()).toEqual(["5star.booked_rate_a", "5star.booked_rate_b", "5star.submitted_rate_a"]);
  });

  it("reads NULL for the build when 5Star has no build_id column yet", async () => {
    const fivestar = fakeQuery(() => []);
    await computeFivestar("2026-10-20", sources({ fivestar, fivestarHasBuildId: false }));
    expect(fivestar.calls[0].text).toContain("btrim(NULL::text)");
  });
});

function runnerDeps(over: Partial<RunnerDeps> & { tables?: boolean; locked?: boolean } = {}) {
  const tx = fakeQuery((text) => {
    if (text === DAY_LOCK_SQL) return [{ locked: over.locked ?? true }];
    if (text === UPSERT_RUN_SQL) return [{ id: 7 }];
    return [];
  });
  const released = vi.fn();
  const hub = fakeQuery((text) => {
    if (text === TABLES_SQL) return [{ runs: over.tables ?? true, vals: over.tables ?? true }];
    if (text.includes("information_schema.columns")) return [{ n: 1 }];
    if (text.includes("FROM call_logs")) return remixRows;
    return [];
  });
  const deps: RunnerDeps = {
    hub,
    connectHub: vi.fn(async () => ({ query: tx, release: released })),
    now: () => new Date("2026-10-21T11:00:00Z"),
    ...over,
  };
  return { deps, tx, hub, released };
}

describe("the run", () => {
  it("with the tables absent it writes nothing and never opens a transaction", async () => {
    const { deps } = runnerDeps({ tables: false });
    expect(await runLearningDay("2026-10-20", deps)).toEqual({ status: "skipped", reason: expect.stringMatching(/A6/) });
    expect(deps.connectHub).not.toHaveBeenCalled();
  });

  it("writes the run and its values in one transaction under the day's lock", async () => {
    const { deps, tx, released } = runnerDeps();
    const out = await runLearningDay("2026-10-20", deps);
    expect(out.status).toBe("partial"); // no Support Center, no 5Star in this fixture
    expect(tx.calls.map((c) => c.text)).toEqual(["BEGIN", DAY_LOCK_SQL, UPSERT_RUN_SQL, DELETE_VALUES_SQL, INSERT_VALUES_SQL, "COMMIT"]);
    const [day, status, version, notes] = tx.calls[2].params as string[];
    expect([day, status, version]).toEqual(["2026-10-20", "partial", "learning-v1"]);
    const n = JSON.parse(notes);
    expect(n.readAt).toBe("2026-10-21T11:00:00.000Z");
    expect(n.unavailable["remix.filed_rate_independent"]).toBeTruthy();
    const rows = JSON.parse(tx.calls[4].params?.[1] as string);
    expect(rows).toContainEqual({ metric_id: "remix.filed_rate", repo: "Remix", lane: "pcp", runtime_marker: "v111", numerator: 1, denominator: 2, unknown_count: 0 });
    expect(released).toHaveBeenCalledOnce();
  });

  it("another run holding the day writes nothing", async () => {
    const { deps, tx } = runnerDeps({ locked: false });
    expect(await runLearningDay("2026-10-20", deps)).toEqual({ status: "locked" });
    expect(tx.calls.map((c) => c.text)).toEqual(["BEGIN", DAY_LOCK_SQL, "ROLLBACK"]);
  });

  it("a failed write rolls back and releases the connection", async () => {
    const { deps, released } = runnerDeps();
    const failing = fakeQuery((text) => {
      if (text === DAY_LOCK_SQL) return [{ locked: true }];
      if (text === UPSERT_RUN_SQL) throw new Error("boom");
      return [];
    });
    deps.connectHub = async () => ({ query: failing, release: released });
    await expect(runLearningDay("2026-10-20", deps)).rejects.toThrow("boom");
    expect(failing.calls.map((c) => c.text)).toContain("ROLLBACK");
    expect(released).toHaveBeenCalledOnce();
  });

  it("is deterministic: the same inputs in any order give the same hash", async () => {
    const a = await runLearningDay("2026-10-20", runnerDeps().deps);
    const shuffled = runnerDeps();
    shuffled.deps.hub = fakeQuery((text) => {
      if (text === TABLES_SQL) return [{ runs: true, vals: true }];
      if (text.includes("information_schema.columns")) return [{ n: 1 }];
      if (text.includes("FROM call_logs")) return [...remixRows].reverse();
      return [];
    });
    const b = await runLearningDay("2026-10-20", shuffled.deps);
    expect(a.status !== "skipped" && a.status !== "locked" && a.hash).toBe(b.status !== "skipped" && b.status !== "locked" && b.hash);
    expect(outputHash([])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("one fixed insert statement whatever the row count", () => {
    expect(INSERT_VALUES_SQL).toContain("jsonb_to_recordset($2::jsonb)");
  });

  it("refuses a malformed day", async () => {
    await expect(runLearningDay("2026-10-20; drop", runnerDeps().deps)).rejects.toThrow(/not a day/);
  });
});

describe("OFF by default", () => {
  it("does not start without LEARNING_RUNNER_ENABLED=1", () => {
    expect(startLearningRunner({})).toBe(false);
    expect(startLearningRunner({ LEARNING_RUNNER_ENABLED: "true" })).toBe(false);
  });

  it("runs after 03:30 Pacific for the three days before, once a night", () => {
    expect(daysDue(new Date("2026-10-21T10:00:00Z"), null)).toEqual([]); // 03:00 PDT
    expect(daysDue(new Date("2026-10-21T10:45:00Z"), null)).toEqual(["2026-10-20", "2026-10-19", "2026-10-18"]);
    expect(daysDue(new Date("2026-10-21T10:45:00Z"), "2026-10-21")).toEqual([]);
    expect(pacificClock(new Date("2026-11-03T11:40:00Z"))).toEqual({ day: "2026-11-03", minutes: 3 * 60 + 40 }); // PST
  });

  it("a night whose run failed is tried again on the next tick", async () => {
    const { deps } = runnerDeps();
    deps.connectHub = async () => {
      throw new Error("pool exhausted");
    };
    expect(await learningTick(deps, new Date("2026-10-21T10:45:00Z"))).toEqual([]);
    const ok = runnerDeps();
    expect(await learningTick(ok.deps, new Date("2026-10-21T11:15:00Z"))).toHaveLength(3);
    expect(await learningTick(ok.deps, new Date("2026-10-21T11:45:00Z"))).toEqual([]);
  });

  it("the server wires the export always and the runner behind its switch", () => {
    const idx = fs.readFileSync(path.join(__dirname, "../index.ts"), "utf8");
    expect(idx).toContain("registerLearningExport(app);");
    expect(idx).toContain("startLearningRunner();");
    expect(idx.indexOf("registerLearningExport(app);")).toBeLessThan(idx.indexOf("res.sendFile('index.html'"));
  });
});

// ai-bridge learning/schema.py, the PHI guard the register applies.
const FORBIDDEN_KEYS = ["patient_name", "first_name", "last_name", "dob", "date_of_birth", "phone", "phone_number", "transcript", "caller_name", "email"];
const PHONE = /(?<![\w])(\+?1[ -.]?)?\(?\d{3}\)?[ -.]\d{3}[ -.]\d{4}(?!\d)/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const DOB = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19\d\d|200\d)\b/;

function phiProblems(x: unknown, at = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(x)) x.forEach((v, i) => out.push(...phiProblems(v, `${at}[${i}]`)));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) out.push(`${at}.${k}`);
      out.push(...phiProblems(v, `${at}.${k}`));
    }
  } else if (typeof x === "string") {
    if (PHONE.test(x) || EMAIL.test(x) || DOB.test(x)) out.push(at);
    if (/^CA[0-9a-f]{32}$/i.test(x)) out.push(`${at}: a call SID`);
  }
  return out;
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

const storedValues: StoredValue[] = [
  { run_date: "2026-10-20", method_version: "learning-v1", metric_id: "remix.filed_rate", repo: "Remix", lane: "tech", runtime_marker: "voice-runtime-v111-x", numerator: 137, denominator: 150, unknown_count: 0 },
];

describe("the export", () => {
  const hub = fakeQuery((text) => {
    if (text === EXPORT_RUNS_SQL) return [{ id: 1, run_date: "2026-10-20", status: "partial", method_version: "learning-v1", notes: JSON.stringify({ readAt: "2026-10-21T11:00:00Z", unavailable: { "remix.filed_rate_independent": "A1" } }) }];
    if (text === EXPORT_VALUES_SQL) return storedValues;
    return [];
  });
  const now = () => new Date("2026-10-22T18:00:00Z");

  it("answers 503 and serves nothing without a token configured", async () => {
    const res = mockRes();
    await learningExportHandler(hub, {}, now)({ headers: {}, query: {} } as any, res);
    expect(res.statusCode).toBe(503);
  });

  it("refuses a wrong or missing bearer token", async () => {
    for (const authorization of [undefined, "Bearer nope", "secret"]) {
      const res = mockRes();
      await learningExportHandler(hub, { LEARNING_EXPORT_TOKEN: "secret" }, now)({ headers: { authorization }, query: {} } as any, res);
      expect(res.statusCode).toBe(401);
    }
  });

  it("serves runs, values, definitions and candidates, and nothing the PHI guard refuses", async () => {
    const res = mockRes();
    await learningExportHandler(hub, { LEARNING_EXPORT_TOKEN: "secret" }, now)({ headers: { authorization: "Bearer secret" }, query: { since: "2026-10-01" } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.values).toHaveLength(1);
    expect(res.body.metrics.length).toBe(METRICS.length);
    expect(phiProblems(res.body)).toEqual([]);
  });

  it("the PHI guard itself catches what it must", () => {
    expect(phiProblems({ phone: "x" })).not.toEqual([]);
    expect(phiProblems({ a: "call me at 626-699-8484" })).not.toEqual([]);
    expect(phiProblems({ a: sid(1) })).not.toEqual([]);
  });

  it("clamps an old or malformed since", async () => {
    for (const since of ["2020-01-01", "yesterday"]) {
      const res = mockRes();
      await learningExportHandler(hub, { LEARNING_EXPORT_TOKEN: "secret" }, now)({ headers: { authorization: "Bearer secret" }, query: { since } } as any, res);
      expect(res.body.since >= "2026-06-24").toBe(true);
    }
  });

  it("no statement the export runs selects a SID, a name or a phone", () => {
    for (const s of [EXPORT_RUNS_SQL, EXPORT_VALUES_SQL]) expect(s).not.toMatch(/call_sid|name|phone|transcript/);
  });
});

describe("candidates", () => {
  const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
  const series = (rates: number[], d = 100): StoredValue[] =>
    rates.map((r, i) => ({ ...storedValues[0], run_date: day(i + 1), numerator: Math.round(r * d), denominator: d }));

  it("a drop outside its own band is a candidate with the shape the metric plainly reads as", () => {
    const c = detectCandidates(series([0.9, 0.91, 0.89, 0.9, 0.9, 0.91, 0.9, 0.89, 0.6]));
    expect(c).toEqual([expect.objectContaining({ fingerprint: "remix.filed_rate:tech:down", day: "2026-10-09", shape: "lost-request-no-ticket", baselineDays: 8 })]);
  });

  it("nothing inside the band, nothing on thin days, nothing without a baseline", () => {
    expect(detectCandidates(series([0.9, 0.91, 0.89, 0.9, 0.9, 0.91, 0.9, 0.89, 0.87]))).toEqual([]);
    expect(detectCandidates(series([0.9, 0.91, 0.89, 0.9, 0.9, 0.91, 0.9, 0.89, 0.2], 10))).toEqual([]);
    expect(detectCandidates(series([0.9, 0.9, 0.1]))).toEqual([]);
  });

  it("every shape named is in the closed vocabulary", () => {
    for (const s of Object.values(METRIC_SHAPES)) expect(knownShapes()).toContain(s);
  });

  it("the vocabulary mirror names the lanes this engine reports", () => {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "vocab.json"), "utf8"));
    expect(v.lane_groups["5Star"].inbound).toContain("drs-8484");
    expect(Object.values(v.lane_groups.Remix).flat()).toEqual(expect.arrayContaining(["optical", "surgery", "tech", "records", "pcp", "no-ivr"]));
  });
});
