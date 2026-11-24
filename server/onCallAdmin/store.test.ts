import { describe, expect, it } from "vitest";
import { ADMIN_SQL, createPgOnCallAdminStore, escalationLiteFromRow, type PgPoolLike } from "./store";

function fakePool(fail?: (text: string) => boolean) {
  const log: string[] = [];
  let released = 0;
  const query = async (text: string) => {
    log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    if (fail?.(text)) throw new Error("boom");
    return { rows: [] as any[], rowCount: 1 };
  };
  const pool: PgPoolLike = { query, connect: async () => ({ query, release: () => void released++ }) };
  return { pool, log, released: () => released };
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
    const body = f.log.slice(1, -1);
    expect(body[0]).toBe("update on_call_providers set");
    expect(ADMIN_SQL.clearOrder).toMatch(/rotation_order = null/);
    expect(body).toHaveLength(3);
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
