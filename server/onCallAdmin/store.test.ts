import { describe, expect, it } from "vitest";
import { ON_CALL_ADMIN_WRITE_LOCK_SQL } from "../../src/runtime/onCall/adminLock";
import { swapWeekSql } from "../../src/runtime/onCall/seed";
import { ADMIN_SQL, createPgOnCallAdminStore, escalationLiteFromRow, type PgPoolLike } from "./store";

function fakePool(fail?: (text: string) => boolean) {
  const log: string[] = [];
  const full: string[] = [];
  let released = 0;
  const releasedWith: Array<Error | undefined> = [];
  const query = async (text: string) => {
    log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    full.push(text);
    if (fail?.(text)) throw new Error("boom");
    return { rows: [] as any[], rowCount: 1 };
  };
  const pool: PgPoolLike = {
    query,
    connect: async () => ({
      query,
      release: (err?: Error) => {
        released++;
        releasedWith.push(err);
      },
    }),
  };
  return { pool, log, full, released: () => released, releasedWith };
}

describe("the Postgres admin store", () => {
  it("wraps a change and its audit row in BEGIN/COMMIT on one client", async () => {
    const f = fakePool();
    const store = createPgOnCallAdminStore(f.pool);
    await store.transaction(async (tx) => {
      await tx.setWeekProvider("2026-12-08", 3, "n");
      await tx.audit({ actorUserId: "u", actorEmail: null, action: "a", entityType: "schedule", entityId: "w", before: null, after: null, reason: "r" });
    });
    expect(f.log[0]).toBe("BEGIN");
    expect(f.log[f.log.length - 1]).toBe("COMMIT");
    expect(f.log.some((l) => l.startsWith("insert into on_call_audit_log"))).toBe(true);
    expect(f.released()).toBe(1);
  });

  it("rolls back when the audit insert fails, and releases the client", async () => {
    const f = fakePool((t) => t.includes("on_call_audit_log"));
    const store = createPgOnCallAdminStore(f.pool);
    await expect(
      store.transaction(async (tx) => {
        await tx.setWeekProvider("2026-12-08", 3, null);
        await tx.audit({ actorUserId: null, actorEmail: null, action: "a", entityType: "schedule", entityId: null, before: null, after: null, reason: "r" });
      }),
    ).rejects.toThrow("boom");
    expect(f.log[f.log.length - 1]).toBe("ROLLBACK");
    expect(f.log).not.toContain("COMMIT");
    expect(f.released()).toBe(1);
  });

  it("clears every moving rotation place before setting any (rotation_order is UNIQUE)", async () => {
    const f = fakePool();
    const store = createPgOnCallAdminStore(f.pool);
    await store.transaction((tx) => tx.setRotationOrders([{ id: 2, to: 3 }, { id: 3, to: 2 }]));
    const body = f.log.slice(2, -1);
    expect(body[0]).toBe("update on_call_providers set");
    expect(ADMIN_SQL.clearOrder).toMatch(/rotation_order = null/);
    expect(body).toHaveLength(3);
  });

  it("serialises admin writes with a transaction-scoped advisory lock, taken right after BEGIN", async () => {
    const f = fakePool();
    const store = createPgOnCallAdminStore(f.pool);
    await store.transaction((tx) => tx.insertWeek("2026-12-08", 3, null));
    expect(f.full[0]).toBe("BEGIN");
    expect(f.full[1]).toBe(ADMIN_SQL.lock);
    // xact-scoped: released at COMMIT/ROLLBACK, safe through PgBouncer's transaction pooler.
    expect(ADMIN_SQL.lock).toMatch(/pg_advisory_xact_lock\(/);
    expect(f.releasedWith).toEqual([undefined]);
  });

  it("takes the same lock statement the CLI's printed SQL takes, from one shared constant", () => {
    expect(ADMIN_SQL.lock).toBe(ON_CALL_ADMIN_WRITE_LOCK_SQL);
    expect(swapWeekSql({ week: "2026-12-08", to: "Ben Ortiz" })).toContain(`BEGIN;\n${ADMIN_SQL.lock};`);
  });

  it("destroys the connection when ROLLBACK itself fails, and reports the original error", async () => {
    const f = fakePool((t) => t.includes("on_call_audit_log") || t === "ROLLBACK");
    const store = createPgOnCallAdminStore(f.pool);
    await expect(
      store.transaction((tx) =>
        tx.audit({ actorUserId: null, actorEmail: null, action: "a", entityType: "schedule", entityId: null, before: null, after: null, reason: "r" }),
      ),
    ).rejects.toThrow("boom");
    expect(f.released()).toBe(1);
    expect(f.releasedWith[0]).toBeInstanceOf(Error);
  });

  it("reads call_logs, call_turns and call_events times as UTC, not the server's local zone", () => {
    expect(ADMIN_SQL.callLogsBySid).toMatch(/\(start_time at time zone 'UTC'\) as start_time/);
    expect(ADMIN_SQL.callLogsBySid).toMatch(/\(end_time at time zone 'UTC'\) as end_time/);
    expect(ADMIN_SQL.callLogsBySid).toMatch(/\(created_at at time zone 'UTC'\) as created_at/);
    expect(ADMIN_SQL.urgentWithoutChain).toMatch(/\(start_time at time zone 'UTC'\)/);
    expect(ADMIN_SQL.turns).toMatch(/\(at at time zone 'UTC'\) as at/);
    expect(ADMIN_SQL.callEvents).toMatch(/\(at at time zone 'UTC'\) as at/);
  });

  it("never returns a chain level's phone", () => {
    const e = escalationLiteFromRow({
      id: 1,
      call_sid: "CA1",
      mode: "test",
      status: "active",
      level_index: 0,
      attempt_no: 1,
      routing: { reason: "on_call" },
      plan: JSON.stringify({ levels: [{ role: "on_call", providerId: 1, name: "Dr. Test", phone: "+15555550100" }], notes: [] }),
      created_at: "2026-12-05T06:00:00Z",
    });
    expect(JSON.stringify(e)).not.toContain("5555550100");
    expect(e.plan?.levels?.[0]).toEqual({ role: "on_call", providerId: 1, name: "Dr. Test" });
  });

  it("never selects the patient details or callback number an escalation holds", () => {
    expect(ADMIN_SQL.escalations).not.toMatch(/details|caller_number|\*/);
    expect(ADMIN_SQL.escalationByCall).not.toMatch(/details|caller_number|\*/);
  });
});
