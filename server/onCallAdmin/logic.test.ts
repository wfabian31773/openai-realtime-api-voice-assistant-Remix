import { describe, expect, it } from "vitest";
import type { OnCallProvider } from "../../src/runtime/onCall/rotation";
import {
  goLive,
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
  scheduleGaps,
  scheduleView,
  weekEndInstant,
  weekStartInstant,
  type CallBundle,
} from "./logic";

const P = (id: number, rotationOrder: number | null, active = true): OnCallProvider => ({
  id,
  fullName: `Dr. Test ${id}`,
  npi: null,
  phone: `+1555555${String(100 + id).padStart(4, "0")}`,
  region: "Inland Empire",
  rotationOrder,
  active,
});

describe("Pacific wall clock", () => {
  it("reads standard and daylight time", () => {
    expect(pacificWallToDate("2026-12-01 17:00")!.toISOString()).toBe("2026-12-02T01:00:00.000Z");
    expect(pacificWallToDate("2026-07-01T09:30")!.toISOString()).toBe("2026-07-01T16:30:00.000Z");
  });
  it("refuses what is not a time", () => {
    for (const bad of ["", "2026-02-30 10:00", "2026-12-01", "2026-12-01 25:00", "tomorrow"]) expect(pacificWallToDate(bad)).toBeNull();
  });
  it("a week runs Tuesday 5 PM to the next Tuesday 8 AM", () => {
    expect(weekStartInstant("2026-12-01").toISOString()).toBe("2026-12-02T01:00:00.000Z");
    expect(weekEndInstant("2026-12-01").toISOString()).toBe("2026-12-08T16:00:00.000Z");
    expect(isTuesday("2026-12-01")).toBe(true);
    expect(isTuesday("2026-12-02")).toBe(false);
  });
  it("counts down to go-live and stops at zero", () => {
    expect(goLive(new Date("2026-12-02T00:00:00Z")).msRemaining).toBe(3_600_000);
    expect(goLive(new Date("2027-01-01T00:00:00Z"))).toMatchObject({ msRemaining: 0, passed: true });
  });
});

describe("phones", () => {
  it("masks to the last four and never returns the whole number", () => {
    expect(last4("+15555550100")).toBe("…0100");
    expect(last4("")).toBeNull();
    expect(last4(null)).toBeNull();
  });
  it("normalizes through the runtime's e164", () => {
    expect(normalizePhone("555-555-0100")).toBe("+15555550100");
    expect(normalizePhone("+1 (555) 555-0100")).toBe("+15555550100");
    expect(normalizePhone("12345")).toBeNull();
  });
});

describe("schedule gaps", () => {
  const now = new Date("2026-12-05T06:00:00Z"); // Fri Dec 4, 10 PM PT: week of Dec 1
  const rows = [
    { week: "2026-12-01", providerId: 1, note: null, updatedAt: null },
    { week: "2026-12-08", providerId: 2, note: null, updatedAt: null },
    { week: "2026-12-22", providerId: 3, note: null, updatedAt: null },
  ];
  it("marks a week with no row as a gap and the current week as current", () => {
    const v = scheduleView({ fromWeek: "2026-12-01", toWeek: "2026-12-29", rows, overrides: [], providers: [P(1, 1), P(2, 2), P(3, 3)], now });
    expect(v.map((w) => w.week)).toEqual(["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"]);
    expect(v.filter((w) => w.gap).map((w) => w.week)).toEqual(["2026-12-15", "2026-12-29"]);
    expect(v.find((w) => w.current)?.week).toBe("2026-12-01");
    expect(scheduleGaps("2026-12-01", "2026-12-29", rows)).toEqual(["2026-12-15", "2026-12-29"]);
  });
  it("overlays an override on the weeks it touches", () => {
    const o = { id: 9, startsAt: pacificWallToDate("2026-12-07 17:00")!, endsAt: pacificWallToDate("2026-12-09 08:00")!, providerId: 3, reason: "cover", createdAt: null };
    const v = scheduleView({ fromWeek: "2026-12-01", toWeek: "2026-12-08", rows, overrides: [o], providers: [P(1, 1), P(2, 2), P(3, 3)], now });
    expect(v.map((w) => w.overrides.map((x) => x.id))).toEqual([[9], [9]]);
  });
  it("refuses a range that does not start on Tuesdays", () => {
    expect(scheduleView({ fromWeek: "2026-12-02", toWeek: "2026-12-29", rows, overrides: [], providers: [], now })).toEqual([]);
  });
});

describe("extend, as scripts/on-call-change.ts extend does it", () => {
  it("continues after the last week's provider, active rotation providers only", () => {
    const providers = [P(1, 1), P(2, 2, false), P(3, 3), P(4, null), P(5, 4)];
    const plan = planExtension({ week: "2026-12-01", providerId: 3 }, providers, 4);
    expect(plan).toEqual({
      ok: true,
      weeks: [
        { week: "2026-12-08", providerId: 5 },
        { week: "2026-12-15", providerId: 1 },
        { week: "2026-12-22", providerId: 3 },
        { week: "2026-12-29", providerId: 5 },
      ],
    });
  });
  it("starts at the first when the last week's provider has no rotation place", () => {
    const plan = planExtension({ week: "2026-12-01", providerId: 4 }, [P(1, 1), P(3, 3), P(4, null)], 1);
    expect(plan).toEqual({ ok: true, weeks: [{ week: "2026-12-08", providerId: 1 }] });
  });
  it("refuses an empty schedule, an empty pool and a bad count", () => {
    expect(planExtension(null, [P(1, 1)], 1).ok).toBe(false);
    expect(planExtension({ week: "2026-12-01", providerId: 1 }, [P(1, null)], 1).ok).toBe(false);
    expect(planExtension({ week: "2026-12-01", providerId: 1 }, [P(1, 1)], 0).ok).toBe(false);
    expect(planExtension({ week: "2026-12-01", providerId: 1 }, [P(1, 1)], 105).ok).toBe(false);
  });
  it("is refused when a provider who would get a week has the rotation's caller ID as their phone", () => {
    const providers = [{ id: 1, fullName: "Dr. Test Self", phone: "+15550000001" }];
    expect(extensionRefusal([{ week: "2026-12-08", providerId: 1 }], providers)).toBeNull();
    expect(extensionRefusal([{ week: "2026-12-08", providerId: 1 }], providers, "+15550000001")).toMatch(/Dr\. Test Self \(week of 2026-12-08\)/);
  });
  it("is refused, naming each provider and week, when a provider who would get a week has no dialable phone", () => {
    const providers = [
      { id: 1, fullName: "Dr. Test One", phone: "+15555550101" },
      { id: 2, fullName: "Dr. Test NoPhone", phone: "" },
      { id: 3, fullName: "Dr. Test Short", phone: "555" },
    ];
    expect(extensionRefusal([{ week: "2026-12-08", providerId: 1 }], providers)).toBeNull();
    const why = extensionRefusal(
      [
        { week: "2026-12-08", providerId: 2 },
        { week: "2026-12-15", providerId: 1 },
        { week: "2026-12-22", providerId: 2 },
        { week: "2026-12-29", providerId: 3 },
      ],
      providers,
    )!;
    expect(why).toMatch(/^Extend refused: Dr\. Test NoPhone \(weeks of 2026-12-08, 2026-12-22\); Dr\. Test Short \(week of 2026-12-29\)/);
    expect(why).toMatch(/have no dialable phone number/);
    expect(why).not.toContain("Dr. Test One");
  });
});

describe("reorder", () => {
  const providers = [P(1, 1), P(2, 2), P(3, 3), P(4, null)];
  it("returns only the rows that move", () => {
    expect(planReorder(providers, [1, 3, 2])).toEqual({ ok: true, changes: [{ id: 3, from: 3, to: 2 }, { id: 2, from: 2, to: 3 }] });
  });
  it("must list exactly the rotation, each once", () => {
    expect(planReorder(providers, [1, 2]).ok).toBe(false);
    expect(planReorder(providers, [1, 2, 3, 4]).ok).toBe(false);
    expect(planReorder(providers, [1, 1, 2]).ok).toBe(false);
  });
});

describe("override overlap", () => {
  it("finds windows that share any instant, not ones that only touch", () => {
    const at = (s: string) => new Date(s);
    const os = [
      { id: 1, startsAt: at("2026-12-02T01:00Z"), endsAt: at("2026-12-02T16:00Z") },
      { id: 2, startsAt: at("2026-12-03T01:00Z"), endsAt: at("2026-12-03T16:00Z") },
    ];
    expect(overlapping(os, at("2026-12-02T10:00Z"), at("2026-12-02T20:00Z")).map((o) => o.id)).toEqual([1]);
    expect(overlapping(os, at("2026-12-02T16:00Z"), at("2026-12-03T01:00Z"))).toEqual([]);
  });
});

describe("the per-call timeline", () => {
  const sid = "CA00000000000000000000000000000001";
  const bundle: CallBundle = {
    callSid: sid,
    callLog: {
      id: "log-1",
      callSid: sid,
      from: "+15555550199",
      agentUsed: "no-ivr",
      voiceProvider: "grok",
      status: "completed",
      runtimeOutcome: "caller_hangup",
      agentOutcome: null,
      summary: null,
      duration: 120,
      startTime: new Date("2026-12-05T06:00:00Z"),
      endTime: new Date("2026-12-05T06:02:00Z"),
      createdAt: null,
      transferredToHuman: false,
      ticketNumber: "VA-1",
      toolTimeline: {
        events: [
          { at: "2026-12-05T06:00:40.000Z", ms: 1000, tool: "escalate_to_human", outcome: { success: true }, args: {} },
        ],
      },
    },
    turns: [{ at: new Date("2026-12-05T06:00:10Z"), role: "caller", text: "synthetic" }],
    callEvents: [],
    escalation: {
      id: 7,
      callSid: sid,
      mode: "test",
      status: "accepted",
      levelIndex: 1,
      attemptNo: 1,
      routing: { reason: "on_call", window: "off_hours", weekStartsOn: "2026-12-01" },
      plan: { levels: [{ role: "on_call", providerId: 1, name: "Dr. Test 1" }, { role: "final", providerId: 2, name: "Dr. Test 2" }], notes: [] },
      acceptedBy: 2,
      acceptedAt: new Date("2026-12-05T06:05:00Z"),
      acceptedAttemptId: 4,
      createdAt: new Date("2026-12-05T06:01:00Z"),
      updatedAt: new Date("2026-12-05T06:05:00Z"),
    },
    attempts: [
      { id: 1, levelIndex: 0, role: "on_call", providerId: 1, kind: "warm_transfer", attemptNo: 1, mode: "test", dialedTo: "+15555550101", outcome: "no_answer", routingReason: "on_call", startedAt: new Date("2026-12-05T06:00:45Z"), endedAt: new Date("2026-12-05T06:01:00Z") },
      { id: 4, levelIndex: 1, role: "final", providerId: 2, kind: "call", attemptNo: 1, mode: "test", dialedTo: "+15555550102", outcome: "accepted", routingReason: null, startedAt: new Date("2026-12-05T06:04:00Z"), endedAt: new Date("2026-12-05T06:05:00Z") },
      { id: 3, levelIndex: 1, role: "final", providerId: 2, kind: "sms", attemptNo: 1, mode: "test", dialedTo: "+15555550102", outcome: "sent", routingReason: null, startedAt: new Date("2026-12-05T06:04:00Z"), endedAt: null },
    ],
    extraEvents: [],
    providerNames: new Map([[1, "Dr. Test 1"], [2, "Dr. Test 2"]]),
  };

  it("merges every source in time order, ties by source then input order", () => {
    const t = mergeTimeline(bundle);
    const at = t.map((i) => i.at);
    expect([...at].sort()).toEqual(at);
    expect(t.map((i) => i.source)).toEqual([
      "call_logs", // started
      "transcript",
      "tool", // escalate_to_human started at :39
      "attempt", // warm transfer :45
      "escalation", // opened :01:00
      "call_logs", // ended 06:02
      "ticket",
      "escalation", // level 2 started 06:04
      "attempt", // call
      "attempt", // sms
      "escalation", // accepted
    ]);
    expect(t.find((i) => i.kind === "escalate_to_human")?.at).toBe("2026-12-05T06:00:39.000Z");
  });

  it("never shows a whole phone number", () => {
    const json = JSON.stringify(mergeTimeline(bundle));
    expect(json).not.toContain("5555550101");
    expect(json).not.toContain("5555550199");
    expect(json).toContain("…0101");
  });

  it("summarises who took the patient and how long it took", () => {
    expect(outcomeSummary(bundle)).toMatchObject({
      status: "accepted",
      acceptedByName: "Dr. Test 2",
      secondsToAccept: 300,
      calls: 2,
      texts: 1,
      levelsReached: 2,
      exhausted: false,
      routingReason: "on_call",
    });
  });
});
