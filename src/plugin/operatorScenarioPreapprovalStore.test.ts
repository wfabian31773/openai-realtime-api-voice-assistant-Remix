import { describe, expect, it, vi } from "vitest";
import { prepareContact } from "./approvals";
import { operatorScenarioPreapprovalEnabled } from "./operatorLineSettings";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";
import { MemoryPluginStore } from "./store";

describe("operator scenario pre-approval persistence", () => {
  it("defaults OFF for missing/malformed settings and fails closed on read errors", async () => {
    const exec = vi.fn<SqlExec>().mockResolvedValue([]);
    const store = createSqlPluginStore(exec);
    expect(await operatorScenarioPreapprovalEnabled(store)).toBe(false);
    for (const value of ["false", "TRUE", "1", true, null]) {
      exec.mockResolvedValue([{ value }]);
      expect(await operatorScenarioPreapprovalEnabled(store)).toBe(false);
    }
    exec.mockResolvedValue([{ value: "true" }]);
    expect(await operatorScenarioPreapprovalEnabled(store)).toBe(true);
    exec.mockRejectedValue(new Error("private database error"));
    expect(await operatorScenarioPreapprovalEnabled(store)).toBe(false);
    expect(await operatorScenarioPreapprovalEnabled(null)).toBe(false);
  });

  it("shares the setting between SQL adapters and records the staff actor", async () => {
    let value: unknown;
    const exec = vi.fn<SqlExec>().mockImplementation(async (sql, params) => {
      if (sql.startsWith("SELECT")) return value === undefined ? [] : [{ value }];
      value = params![0];
      return [];
    });
    const first = createSqlPluginStore(exec);
    const second = createSqlPluginStore(exec);
    expect(await first.getOperatorScenarioPreapprovalEnabled()).toBe(false);
    await first.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    expect(await second.getOperatorScenarioPreapprovalEnabled()).toBe(true);
    const [sql, params] = exec.mock.calls[1];
    expect(sql).toContain("'operator_scenario_preapproval_enabled'");
    expect(sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(sql).toContain("updated_by = EXCLUDED.updated_by, updated_at = NOW()");
    expect(params).toEqual(["true", "staff-id"]);
    await second.setOperatorScenarioPreapprovalEnabled(false, "other-staff");
    expect(await first.getOperatorScenarioPreapprovalEnabled()).toBe(false);
  });

  it.each([false, true])("round-trips scenario audit on insert/read/update, with JSON encoded: %s", async (encoded) => {
    const memory = new MemoryPluginStore();
    await memory.setOperatorScenarioPreapprovalEnabled(true, "staff-id");
    const now = new Date("2026-10-29T18:00:00Z");
    const prepared = await prepareContact(memory, "bot", {
      channel: "call", payload: { phone: "+15555550123", scenario_id: "A1" } as any,
    }, now, "operator", {});
    if (!prepared.ok) throw new Error(prepared.error);
    const row = (await memory.getApproval(prepared.approval.id))!;
    const audit = { approvedBy: "scenario_preapproval", approvedAt: now, approvalMetadata: { scenario_id: "A1" } };
    expect(row).toMatchObject(audit);
    const sqlRow = { id: row.id, channel: row.channel, status: row.status, token_jti: row.tokenJti,
      payload: row.payload, payload_hash: row.payloadHash, created_at: now.toISOString(), updated_at: now.toISOString(),
      approved_by: row.approvedBy, approved_at: now.toISOString(),
      approval_metadata: encoded ? JSON.stringify(row.approvalMetadata) : row.approvalMetadata,
    };
    const exec = vi.fn<SqlExec>().mockResolvedValue([sqlRow]);
    const store = createSqlPluginStore(exec);
    expect(await store.insertApproval(row)).toMatchObject(audit);
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toContain("approved_by, approved_at, approval_metadata");
    expect(params?.slice(14, 17)).toEqual(["scenario_preapproval", now.toISOString(), JSON.stringify(row.approvalMetadata)]);
    expect(await store.getApproval(row.id)).toMatchObject(audit);
    expect(await store.updateApproval(row.id, { status: "committed" })).toMatchObject(audit);
    const [update, updateParams] = exec.mock.calls[exec.mock.calls.length - 1];
    // The audit is written once at insert; updates never name the column.
    expect(update).not.toContain("approval_metadata");
    expect(updateParams).toHaveLength(16);
    const plain = { ...row, id: "plain", approvedBy: null, approvedAt: null, approvalMetadata: null };
    await store.insertApproval(plain);
    const [plainSql, plainParams] = exec.mock.calls[exec.mock.calls.length - 1];
    // Unaudited prepares work before the migration adds approval_metadata.
    expect(plainSql).not.toContain("approval_metadata");
    expect(plainParams).toHaveLength(16);
    expect(await memory.updateApproval(row.id, { status: "committed" })).toMatchObject(audit);
  });
});
