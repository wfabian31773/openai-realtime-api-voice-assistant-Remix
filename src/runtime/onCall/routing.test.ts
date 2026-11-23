import { describe, expect, it, vi } from "vitest";
import {
  ROTATION_CACHE_MS,
  createRotationCache,
  decideRoute,
  syntheticTestPlan,
  withTestPhones,
  type RouteInput,
} from "./routing";
import { CONSOLE_UNAVAILABLE_NOTE, NO_IDENTITY_NOTE } from "./postOp";
import type { OnCallConfig } from "./config";
import {
  FINAL_DIRECTOR,
  IE_DIRECTOR,
  LA_DIRECTOR,
  VALLEYS_DIRECTOR,
  provider,
  syntheticRotation,
} from "./testRotation";
import type { RotationData } from "./rotation";

const LIVE: OnCallConfig = { mode: "live", testPhones: [], callerId: "+15550000000", requireKept: false };
const TEST: OnCallConfig = {
  mode: "test",
  testPhones: ["+15550100001", "+15550100002"],
  callerId: "+15550000000",
  requireKept: false,
};
const OFF: OnCallConfig = { mode: "off", testPhones: [], callerId: "", requireKept: false };

// Pacific times as UTC instants (PST is UTC-8 from 2026-11-01).
const WED_NIGHT = new Date("2026-12-03T06:30:00Z"); // Wed 2026-12-02 22:30 PT, week of 12-01
const WED_DAY = new Date("2026-12-02T18:00:00Z"); // Wed 2026-12-02 10:00 PT
const THANKSGIVING_DAY = new Date("2026-11-26T18:00:00Z"); // Thu 11-26 10:00 PT, week of 11-24
const SD_WEEK_NIGHT = new Date("2026-12-24T06:00:00Z"); // Wed 12-23 22:00 PT, week of 12-22

const PERSON = "00000000-0000-4000-8000-000000000001";

function input(over: Partial<RouteInput> & { data?: RotationData } = {}): RouteInput {
  const data = over.data ?? syntheticRotation();
  return {
    at: WED_NIGHT,
    config: LIVE,
    store: { available: async () => true, loadRotation: async () => data },
    rotation: { get: async () => data },
    personId: undefined,
    consoleQuery: null,
    ...over,
  };
}

/** A Console that answers one kept surgery by the given NPI on the given date. */
function consoleWithSurgery(npi: string, date: string) {
  return vi.fn(async () => ({
    rows: [
      {
        date,
        event_name: "Surgery",
        is_kept: true,
        is_cancelled: false,
        is_rescheduled: false,
        npi,
        nextgen_name: "Surgeon, MD",
      },
    ],
  }));
}

const ids = (d: Awaited<ReturnType<typeof decideRoute>>) =>
  d.kind === "rotation" ? d.plan.levels.map((l) => [l.role, l.providerId]) : null;

describe("when today's path stands", () => {
  it("does nothing at all when the switch is off", async () => {
    const loadRotation = vi.fn();
    const d = await decideRoute(input({ config: OFF, store: { available: vi.fn(), loadRotation } }));
    expect(d).toEqual({ kind: "legacy", because: "mode_off" });
    expect(loadRotation).not.toHaveBeenCalled();
  });

  it("falls back when the on-call tables are not on the Hub", async () => {
    const d = await decideRoute(input({ store: { available: async () => false, loadRotation: vi.fn() } }));
    expect(d).toEqual({ kind: "legacy", because: "store_unavailable" });
  });

  it("falls back inside its budget when the Hub does not answer", async () => {
    const started = Date.now();
    const d = await decideRoute(
      input({ store: { available: () => new Promise(() => {}), loadRotation: vi.fn() }, budgetMs: 50 }),
    );
    expect(d).toEqual({ kind: "legacy", because: "store_unavailable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("falls back when the rotation cannot be read, never throwing", async () => {
    const d = await decideRoute(
      input({ rotation: { get: async () => Promise.reject(new Error("hub down")) } }),
    );
    expect(d).toEqual({ kind: "legacy", because: "rotation_unreadable" });
  });

  it("falls back on weekday daytime, which is not on call", async () => {
    const d = await decideRoute(input({ at: WED_DAY }));
    expect(d.kind).toBe("legacy");
    expect(d.kind === "legacy" && d.because).toBe("weekday_daytime");
  });

  it("falls back when nobody is entered and there is no final director", async () => {
    const data = syntheticRotation({ schedule: new Map(), directors: new Map() });
    const d = await decideRoute(input({ data }));
    expect(d.kind === "legacy" && d.because).toBe("no_levels");
  });
});

describe("the rotation", () => {
  it("rings the on-call provider, their region director, then the final director", async () => {
    const d = await decideRoute(input());
    expect(ids(d)).toEqual([
      ["on_call", 1],
      ["region_director", IE_DIRECTOR],
      ["final", FINAL_DIRECTOR],
    ]);
    expect(d.kind === "rotation" && d.routing.reason).toBe("on_call");
    expect(d.kind === "rotation" && d.routing.weekStartsOn).toBe("2026-12-01");
  });

  it("goes straight from a San Diego provider to the final director", async () => {
    const d = await decideRoute(input({ at: SD_WEEK_NIGHT }));
    expect(ids(d)).toEqual([
      ["on_call", 3],
      ["final", FINAL_DIRECTOR],
    ]);
  });

  it("is on call through a closed holiday's daytime and says so", async () => {
    const d = await decideRoute(input({ at: THANKSGIVING_DAY }));
    expect(ids(d)).toEqual([
      ["on_call", 6],
      ["region_director", VALLEYS_DIRECTOR],
      ["final", FINAL_DIRECTOR],
    ]);
    expect(d.kind === "rotation" && d.routing.reason).toBe("holiday_daytime");
  });

  it("rings each level's own number in live mode", async () => {
    const d = await decideRoute(input());
    expect(d.kind === "rotation" && d.plan.levels[0].phone).toBe(provider(1, "x").phone);
  });

  it("still rings the final director when nobody is entered for the week", async () => {
    const d = await decideRoute(input({ data: syntheticRotation({ schedule: new Map() }) }));
    expect(ids(d)).toEqual([["final", FINAL_DIRECTOR]]);
    expect(d.kind === "rotation" && d.routing.notes).toEqual(
      expect.arrayContaining(["no_schedule_for_week", "no_first_level"]),
    );
    // The final director is told why they are the first person rung.
    expect(d.kind === "rotation" && d.alertNote).toMatch(/^No on-call provider is entered for this week/);
    expect(d.kind === "rotation" && d.routing.note).toBe(d.kind === "rotation" ? d.alertNote : null);
  });

  it("says so in the alert when the week's provider is marked inactive", async () => {
    const base = syntheticRotation();
    const data = syntheticRotation({
      providers: base.providers.map((p) => (p.id === 1 ? { ...p, active: false } : p)),
    });
    const d = await decideRoute(input({ data }));
    expect(ids(d)).toEqual([["final", FINAL_DIRECTOR]]);
    expect(d.kind === "rotation" && d.alertNote).toMatch(/marked inactive, so the chain went straight to the final director/);
  });

  it("says so in the alert when tonight's cover cannot be rung and the week's provider is called", async () => {
    const base = syntheticRotation();
    const data = syntheticRotation({
      providers: base.providers.map((p) => (p.id === 5 ? { ...p, active: false } : p)),
      overrides: [
        { id: 1, startsAt: new Date("2026-12-03T01:00:00Z"), endsAt: new Date("2026-12-03T16:00:00Z"), providerId: 5 },
      ],
    });
    const d = await decideRoute(input({ data }));
    expect(ids(d)?.[0]).toEqual(["on_call", 1]);
    expect(d.kind === "rotation" && d.alertNote).toMatch(
      /^The cover entered for this time is marked inactive, so this week's scheduled provider is being called\./,
    );
    expect(d.kind === "rotation" && d.routing.note).toBe(d.kind === "rotation" ? d.alertNote : null);
  });

  it("puts the rotation's note before the post-op note when both apply", async () => {
    const data = syntheticRotation({
      overrides: [
        { id: 1, startsAt: new Date("2026-12-03T01:00:00Z"), endsAt: new Date("2026-12-03T16:00:00Z"), providerId: 999 },
      ],
    });
    const d = await decideRoute(input({ data, personId: undefined }));
    expect(d.kind === "rotation" && d.alertNote).toBe(
      `The cover entered for this time is not on file, so this week's scheduled provider is being called. ${NO_IDENTITY_NOTE}`,
    );
  });

  it("carries no rotation note on the surgeon route, where the rotation was not used", async () => {
    const data = syntheticRotation({
      overrides: [
        { id: 1, startsAt: new Date("2026-12-03T01:00:00Z"), endsAt: new Date("2026-12-03T16:00:00Z"), providerId: 999 },
      ],
    });
    const consoleQuery = consoleWithSurgery(provider(2, "x").npi!, "2026-11-29");
    const d = await decideRoute(input({ data, personId: PERSON, consoleQuery }));
    expect(ids(d)?.[0]).toEqual(["surgeon", 2]);
    expect(d.kind === "rotation" && d.alertNote).toBeUndefined();
  });
});

describe("the post-op exception", () => {
  it("routes a patient whose surgery was 3 days ago to their surgeon first", async () => {
    const consoleQuery = consoleWithSurgery(provider(2, "x").npi!, "2026-11-29");
    const d = await decideRoute(input({ personId: PERSON, consoleQuery }));
    expect(ids(d)).toEqual([
      ["surgeon", 2],
      ["region_director", LA_DIRECTOR],
      ["final", FINAL_DIRECTOR],
    ]);
    expect(d.kind === "rotation" && d.routing.reason).toBe("post_op_surgeon");
    expect(d.kind === "rotation" && d.routing.postOp).toMatchObject({ route: "surgeon", daysAgo: 3 });
    expect(consoleQuery).toHaveBeenCalledTimes(1);
  });

  it("holds a surgery later today off the surgeon route by the Pacific clock", async () => {
    // WED_NIGHT is 22:30 Pacific on 2026-12-02 (06:30 UTC on 12-03).
    const today = (begin: string) =>
      vi.fn(async () => ({
        rows: [
          {
            date: "2026-12-02",
            begin_time: begin,
            event_name: "Surgery",
            is_kept: false,
            is_cancelled: false,
            is_rescheduled: false,
            npi: provider(2, "x").npi!,
            nextgen_name: "Surgeon, MD",
          },
        ],
      }));
    const begun = await decideRoute(input({ personId: PERSON, consoleQuery: today("2230") }));
    expect(ids(begun)?.[0]).toEqual(["surgeon", 2]);
    const later = await decideRoute(input({ personId: PERSON, consoleQuery: today("2245") }));
    expect(ids(later)?.[0]).toEqual(["on_call", 1]);
    expect(later.kind === "rotation" && later.alertNote).toContain("is booked for 10:45 PM and has not started");
  });

  it("routes a 7-day post-op to the surgeon and an 8-day one to on-call", async () => {
    const seven = await decideRoute(
      input({ personId: PERSON, consoleQuery: consoleWithSurgery(provider(2, "x").npi!, "2026-11-25") }),
    );
    expect(ids(seven)?.[0]).toEqual(["surgeon", 2]);
    const eight = await decideRoute(
      input({ personId: PERSON, consoleQuery: consoleWithSurgery(provider(2, "x").npi!, "2026-11-24") }),
    );
    expect(ids(eight)?.[0]).toEqual(["on_call", 1]);
    expect(eight.kind === "rotation" && eight.routing.reason).toBe("on_call");
  });

  it("routes to on-call and says so when the patient was not confirmed", async () => {
    const consoleQuery = vi.fn();
    const d = await decideRoute(input({ personId: undefined, consoleQuery }));
    expect(ids(d)?.[0]).toEqual(["on_call", 1]);
    expect(d.kind === "rotation" && d.routing.reason).toBe("on_call");
    expect(d.kind === "rotation" && d.routing.postOp).toMatchObject({ route: "on_call", reason: "no_identity" });
    expect(d.kind === "rotation" && d.alertNote).toBe(NO_IDENTITY_NOTE);
    expect(consoleQuery).not.toHaveBeenCalled();
  });

  it("routes to on-call and says so when the Console does not answer in time", async () => {
    const consoleQuery = vi.fn(() => new Promise<{ rows: any[] }>(() => {}));
    const d = await decideRoute(input({ personId: PERSON, consoleQuery, budgetMs: 60 }));
    expect(ids(d)?.[0]).toEqual(["on_call", 1]);
    expect(d.kind === "rotation" && d.alertNote).toBe(CONSOLE_UNAVAILABLE_NOTE);
    expect(d.kind === "rotation" && d.routing.postOp).toMatchObject({ reason: "console_unavailable" });
  });

  it("routes to on-call as uncertain when a recent surgery's surgeon is not in the pool", async () => {
    const d = await decideRoute(
      input({ personId: PERSON, consoleQuery: consoleWithSurgery("9999999999", "2026-11-30") }),
    );
    expect(ids(d)?.[0]).toEqual(["on_call", 1]);
    expect(d.kind === "rotation" && d.routing.reason).toBe("post_op_uncertain");
    expect(d.kind === "rotation" && d.alertNote).toMatch(/Post-op/);
  });

  it("carries no alert note for a confirmed patient with no recent surgery", async () => {
    const d = await decideRoute(input({ personId: PERSON, consoleQuery: vi.fn(async () => ({ rows: [] })) }));
    expect(d.kind === "rotation" && d.alertNote).toBeUndefined();
    expect(d.kind === "rotation" && d.routing.reason).toBe("on_call");
  });
});

describe("test mode", () => {
  it("rings the test numbers, level by level, never a provider's", async () => {
    const d = await decideRoute(input({ config: TEST }));
    expect(d.kind === "rotation" && d.plan.levels.map((l) => l.phone)).toEqual([
      "+15550100001",
      "+15550100002",
      "+15550100002",
    ]);
    expect(ids(d)?.map((x) => x[1])).toEqual([1, IE_DIRECTOR, FINAL_DIRECTOR]);
  });

  it("keeps a level with no phone empty in test mode, so the chain skips it as live would", async () => {
    const plan = {
      levels: [
        { role: "on_call" as const, providerId: 1, name: "A", phone: "+15550111111" },
        { role: "region_director" as const, providerId: 2, name: "B", phone: "" },
        { role: "final" as const, providerId: 3, name: "C", phone: "not a number" },
        { role: "final" as const, providerId: 4, name: "D", phone: "+15550444444" },
      ],
      notes: [],
    };
    expect(withTestPhones(plan, TEST).levels.map((l) => l.phone)).toEqual([
      "+15550100001",
      "",
      "",
      // The test number is still chosen by the level's place in the chain.
      "+15550100002",
    ]);
    expect(withTestPhones(plan, LIVE)).toBe(plan);
  });

  it("runs a synthetic chain over the test numbers before the rotation is imported", async () => {
    const empty: RotationData = { providers: [], schedule: new Map(), overrides: [], directors: new Map() };
    const d = await decideRoute(input({ config: TEST, data: empty }));
    expect(d.kind).toBe("rotation");
    expect(d.kind === "rotation" && d.routing.reason).toBe("test_synthetic");
    expect(d.kind === "rotation" && d.plan).toEqual(syntheticTestPlan(TEST));
    expect(d.kind === "rotation" && d.plan.levels.map((l) => l.role)).toEqual([
      "on_call",
      "region_director",
      "final",
    ]);
  });

  it("does not run the synthetic chain in live mode", async () => {
    const empty: RotationData = { providers: [], schedule: new Map(), overrides: [], directors: new Map() };
    const d = await decideRoute(input({ data: empty }));
    expect(d.kind === "legacy" && d.because).toBe("no_levels");
  });
});

describe("one deadline for the whole decision", () => {
  /** A promise that resolves with `value` after `ms` of fake time. */
  const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  /** Runs a decision under fake timers and reports when it settled. */
  async function settleTime(build: () => RouteInput, budget: number): Promise<{ at: number; d: Awaited<ReturnType<typeof decideRoute>> }> {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      let at = -1;
      const pending = decideRoute({ ...build(), budgetMs: budget }).then((d) => {
        at = Date.now() - started;
        return d;
      });
      for (let t = 0; t < 4 * budget && at < 0; t += 10) await vi.advanceTimersByTimeAsync(10);
      return { at, d: await pending };
    } finally {
      vi.useRealTimers();
    }
  }

  it("gives the rotation read only what the store check left", async () => {
    const { at, d } = await settleTime(
      () =>
        input({
          store: { available: () => after(400, true), loadRotation: vi.fn() },
          rotation: { get: () => new Promise<RotationData>(() => {}) },
        }),
      500,
    );
    expect(d).toEqual({ kind: "legacy", because: "rotation_unreadable" });
    expect(at).toBeLessThanOrEqual(510);
  });

  it("gives the Console only what the rotation read left, and says so in the alert", async () => {
    const consoleQuery = vi.fn(() => new Promise<{ rows: any[] }>(() => {}));
    const { at, d } = await settleTime(
      () =>
        input({
          personId: PERSON,
          consoleQuery,
          rotation: { get: () => after(450, syntheticRotation()) },
        }),
      500,
    );
    expect(ids(d)?.[0]).toEqual(["on_call", 1]);
    expect(d.kind === "rotation" && d.alertNote).toBe(CONSOLE_UNAVAILABLE_NOTE);
    expect(at).toBeLessThanOrEqual(510);
  });

  it("never waits longer than the budget, however each read is slow", async () => {
    const { at, d } = await settleTime(
      () =>
        input({
          personId: PERSON,
          consoleQuery: vi.fn(() => new Promise<{ rows: any[] }>(() => {})),
          store: { available: () => after(300, true), loadRotation: vi.fn() },
          rotation: { get: () => after(150, syntheticRotation()) },
        }),
      500,
    );
    expect(d.kind).toBe("rotation");
    expect(at).toBeLessThanOrEqual(510);
  });
});

describe("the rotation cache", () => {
  it("reads once a minute, shares a read in flight, and never caches a failure", async () => {
    let now = 0;
    const data = syntheticRotation();
    const loadRotation = vi
      .fn<() => Promise<RotationData>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(data);
    const cache = createRotationCache({ loadRotation }, () => now);
    await expect(cache.get()).rejects.toThrow("blip");
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toBe(data);
    expect(b).toBe(data);
    expect(loadRotation).toHaveBeenCalledTimes(2);
    now += ROTATION_CACHE_MS - 1;
    await cache.get();
    expect(loadRotation).toHaveBeenCalledTimes(2);
    now += 1;
    await cache.get();
    expect(loadRotation).toHaveBeenCalledTimes(3);
  });
});
