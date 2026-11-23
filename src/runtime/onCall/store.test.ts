import { describe, expect, it, vi } from "vitest";
import {
  ON_CALL_TABLES,
  SQL,
  createPgOnCallStore,
  createTableCheck,
  escalationFromRow,
  storedDetails,
  type NewEscalation,
  type Query,
} from "./store";
import { createFakeOnCallStore } from "./store.fake";
import { syntheticRotation } from "./testRotation";
import { regionKey } from "./rotation";

const SID = "CA00000000000000000000000000000001";
const AT = new Date("2026-12-03T06:30:00Z");

function newEscalation(over: Partial<NewEscalation> = {}): NewEscalation {
  return {
    callSid: SID,
    mode: "test",
    routing: { reason: "on_call", window: "off_hours", weekStartsOn: "2026-12-01", source: "schedule", notes: [] },
    plan: { levels: [{ role: "on_call", providerId: 1, name: "Provider 1", phone: "+15550100001" }], notes: [] },
    details: { reason: "Eye pain after surgery", patientFirstName: "Test" },
    callerNumber: "+15550199999",
    nextAt: new Date(AT.getTime() + 60_000),
    levelStartedAt: AT,
    attemptNo: 2,
    ...over,
  };
}

describe("the copy of the patient details", () => {
  it("keeps only the text fields the texts read, and drops the live callbacks", () => {
    const d = storedDetails({
      agentSlug: "no-ivr",
      reason: "Eye pain",
      patientFirstName: "Test",
      patientLastName: "  ",
      onBlindDialSettled: () => {},
      askedBeforeDial: true,
    } as any);
    expect(d).toEqual({ reason: "Eye pain", patientFirstName: "Test" });
    expect(storedDetails(undefined)).toBeNull();
  });
});

describe("the in-memory store keeps the SQL store's rules", () => {
  it("opens one escalation per call", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    expect(await s.openEscalation(newEscalation())).not.toBeNull();
    expect(await s.openEscalation(newEscalation())).toBeNull();
  });

  it("lands a write only on the version it read", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    const e = (await s.openEscalation(newEscalation()))!;
    const moved = await s.updateEscalation(e.id, e.version, { attemptNo: 3 });
    expect(moved?.version).toBe(e.version + 1);
    expect(await s.updateEscalation(e.id, e.version, { attemptNo: 4 })).toBeNull();
    expect((await s.getEscalation(e.id))?.attemptNo).toBe(3);
  });

  it("leases a due row so a second runner cannot take it until the lease runs out", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    await s.openEscalation(newEscalation({ nextAt: AT }));
    expect(await s.claimDue(AT, 30_000, 10)).toHaveLength(1);
    expect(await s.claimDue(AT, 30_000, 10)).toHaveLength(0);
    expect(await s.claimDue(new Date(AT.getTime() + 30_001), 30_000, 10)).toHaveLength(1);
  });

  it("does not claim a row that is not due, or not active", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    const e = (await s.openEscalation(newEscalation({ nextAt: new Date(AT.getTime() + 1) })))!;
    expect(await s.claimDue(AT, 30_000, 10)).toHaveLength(0);
    await s.closeEscalation(e.id, e.version, { status: "accepted" });
    expect(await s.claimDue(new Date(AT.getTime() + 60_000), 30_000, 10)).toHaveLength(0);
  });

  it("drops the patient details and callback number when the escalation ends", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    const e = (await s.openEscalation(newEscalation()))!;
    const closed = await s.closeEscalation(e.id, e.version, { status: "exhausted", nextAt: null });
    expect(closed).toMatchObject({ status: "exhausted", details: null, callerNumber: null, nextAt: null });
  });

  it("ends an attempt once", async () => {
    const s = createFakeOnCallStore(syntheticRotation(), () => AT);
    const e = (await s.openEscalation(newEscalation()))!;
    const a = await s.logAttempt({
      escalationId: e.id,
      callSid: SID,
      levelIndex: 0,
      role: "on_call",
      providerId: 1,
      kind: "call",
      attemptNo: 2,
      mode: "test",
      dialedTo: "+15550100001",
    });
    expect(a.outcome).toBe("in_progress");
    expect(await s.endAttempt(a.id, "no_answer", AT)).toMatchObject({ outcome: "no_answer" });
    expect(await s.endAttempt(a.id, "accepted", AT)).toBeNull();
    expect((await s.getAttempt(a.id))?.outcome).toBe("no_answer");
  });
});

describe("the table check", () => {
  const present: Query = async () => ({ rows: ON_CALL_TABLES.map((table_name) => ({ table_name })) });

  it("remembers the tables once they are there", async () => {
    const query = vi.fn(present);
    const check = createTableCheck(query, () => 0, () => {});
    expect(await check()).toBe(true);
    expect(await check()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("treats five of six tables as absent, and checks again after ten minutes", async () => {
    let now = 0;
    const query = vi
      .fn<Query>()
      .mockResolvedValueOnce({ rows: ON_CALL_TABLES.slice(1).map((table_name) => ({ table_name })) })
      .mockImplementation(present);
    const log = vi.fn();
    const check = createTableCheck(query, () => now, log);
    expect(await check()).toBe(false);
    now += 9 * 60_000;
    expect(await check()).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    now += 60_000;
    expect(await check()).toBe(true);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/not on the Hub yet[\s\S]*present/);
  });

  it("reads a Hub that cannot be reached as absent, never throwing", async () => {
    const check = createTableCheck(async () => Promise.reject(new Error("down")), () => 0, () => {});
    expect(await check()).toBe(false);
  });

  it("asks for every table by name", async () => {
    const query = vi.fn(present);
    await createTableCheck(query, () => 0, () => {})();
    expect(query.mock.calls[0][1]).toEqual([ON_CALL_TABLES]);
  });
});

describe("the SQL store", () => {
  it("casts every parameter, so no statement fails at PARSE", () => {
    for (const [name, text] of Object.entries(SQL)) {
      const bare = text.match(/\$\d+(?!\d|::)/g);
      expect(bare, name).toBeNull();
    }
  });

  it("checks the version on every escalation write and an open outcome on every attempt end", () => {
    expect(SQL.update).toMatch(/where id = \$1::integer and version = \$2::integer/);
    expect(SQL.endAttempt).toMatch(/outcome = 'in_progress'/);
    expect(SQL.open).toMatch(/on conflict \(call_sid\) do nothing/);
    expect(SQL.claimDue).toMatch(/for update skip locked/);
    expect(SQL.claimDue).toMatch(/lease_until is null or lease_until < \$1::timestamptz/);
  });

  it("drops the details and callback number only on a terminal write", async () => {
    const query = vi.fn<Query>(async () => ({ rows: [] }));
    const s = createPgOnCallStore(query, { log: () => {} });
    await s.updateEscalation(7, 3, { attemptNo: 3 });
    await s.closeEscalation(7, 4, { status: "accepted", acceptedBy: 2, acceptedAt: AT, acceptedAttemptId: 31 });
    const [update, close] = query.mock.calls.map((c) => c[1] as unknown[]);
    expect(update[13]).toBe(false);
    expect(update[12]).toBe(false);
    expect(close[13]).toBe(true);
    expect(close[12]).toBe(true);
    expect(close.slice(9, 12)).toEqual([true, 2, AT.toISOString()]);
    expect(close[14]).toBe(31);
    expect(update[9]).toBe(false);
    expect(update[14]).toBeNull();
    expect(SQL.update).toMatch(/accepted_attempt_id = case when \$10::boolean then \$15::integer else accepted_attempt_id end/);
  });

  it("clears next_at only when the patch says so", async () => {
    const query = vi.fn<Query>(async () => ({ rows: [] }));
    const s = createPgOnCallStore(query, { log: () => {} });
    await s.updateEscalation(1, 0, { phase: "due" });
    await s.updateEscalation(1, 0, { nextAt: null });
    await s.updateEscalation(1, 0, { nextAt: AT });
    const params = query.mock.calls.map((c) => (c[1] as unknown[]).slice(6, 8));
    expect(params).toEqual([
      [false, null],
      [true, null],
      [true, AT.toISOString()],
    ]);
  });

  it("opens with the details as JSON and leases with the lease's end", async () => {
    const query = vi.fn<Query>(async () => ({ rows: [] }));
    const s = createPgOnCallStore(query, { log: () => {} });
    await s.openEscalation(newEscalation());
    await s.claimDue(AT, 30_000, 5);
    const [open, claim] = query.mock.calls.map((c) => c[1] as unknown[]);
    expect(open[0]).toBe(SID);
    expect(JSON.parse(open[7] as string)).toEqual({ reason: "Eye pain after surgery", patientFirstName: "Test" });
    expect(claim).toEqual([AT.toISOString(), new Date(AT.getTime() + 30_000).toISOString(), 5]);
  });

  it("reads the rotation back into the shape the lookup uses", async () => {
    const query: Query = async (text) => {
      if (text === SQL.providers) {
        return {
          rows: [
            { id: 1, full_name: "Provider 1", npi: "1000000001", phone: "+15555551001", email: null, region: "Inland Empire", rotation_order: 1, active: true },
          ],
        };
      }
      if (text === SQL.schedule) return { rows: [{ week: "2026-12-01", provider_id: "1" }] };
      if (text === SQL.overrides) {
        return { rows: [{ id: 4, starts_at: "2026-12-03T00:00:00Z", ends_at: "2026-12-04T00:00:00Z", provider_id: 1 }] };
      }
      if (text === SQL.directors) return { rows: [{ region: "Inland Empire", provider_id: 91 }] };
      return { rows: [] };
    };
    const r = await createPgOnCallStore(query, { log: () => {} }).loadRotation();
    expect(r.providers[0]).toMatchObject({ id: 1, region: "Inland Empire", rotationOrder: 1, active: true });
    expect(r.schedule.get("2026-12-01")).toBe(1);
    expect(r.overrides[0].startsAt).toEqual(new Date("2026-12-03T00:00:00Z"));
    expect(r.directors.get(regionKey("inland empire"))).toBe(91);
  });

  it("reads a row whose JSON columns arrive as text", () => {
    const e = escalationFromRow({
      id: "3",
      call_sid: SID,
      mode: "live",
      status: "active",
      level_index: "1",
      attempt_no: "2",
      phase: "ringing",
      next_at: "2026-12-03T06:36:00Z",
      level_started_at: "2026-12-03T06:30:00Z",
      routing: '{"reason":"on_call","window":"off_hours","weekStartsOn":"2026-12-01","source":"schedule","notes":[]}',
      plan: '{"levels":[],"notes":[]}',
      details: null,
      caller_number: null,
      accepted_by: null,
      accepted_at: null,
      accepted_attempt_id: "12",
      version: "5",
      created_at: "2026-12-03T06:30:00Z",
    });
    expect(e).toMatchObject({ id: 3, levelIndex: 1, version: 5, details: null, acceptedAttemptId: 12, routing: { reason: "on_call" } });
    expect(e.nextAt).toEqual(new Date("2026-12-03T06:36:00Z"));
  });
});
