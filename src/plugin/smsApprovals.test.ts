import { describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { mountPluginApi } from "./routes";
import { MemoryPluginStore } from "./store";
import { approveContact, prepareContact } from "./approvals";
import { hashPayload } from "./tokens";
import { auditContainsPhi } from "./phi";
import { createSqlPluginStore, type SqlExec } from "./sqlStore";
import { SendOutcomeError } from "./sendFailure";

const PHONE = "+16265550123";
const SMS = { phone: PHONE, body: "PRIVATE confirmation" };
const NOW = new Date("2026-10-29T18:00:00Z");

/** Exercise the real API middleware in process, without sandbox TCP listeners. */
function boot(owner: string | undefined = PHONE) {
  const store = new MemoryPluginStore();
  const sender = { send: vi.fn().mockResolvedValue({ sid: "SM-synthetic" }) };
  const env: Record<string, string | undefined> = { PLUGIN_WRITES_ENABLED: "true", OPERATOR_OWNER_NUMBER: owner };
  const bot = store.mint(["contacts:prepare", "contacts:commit"]);
  const routes = new Map<string, RequestHandler[]>();
  const app = {
    get: () => {},
    post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers),
  } as unknown as Express;
  mountPluginApi(app, { store, agents: { getAllAgents: () => [] }, env, now: () => NOW, smsSender: sender });
  async function post(body: unknown, token = bot, path = "/api/plugin/v1/prepare_sms") {
    const req = { method: "POST", path, route: { path }, body, headers: { authorization: `Bearer ${token.plaintext}` } };
    const result = { status: 200, body: {} as Record<string, any> };
    const res = {
      status(status: number) { result.status = status; return res; },
      json(value: Record<string, any>) { result.body = value; return res; },
    };
    async function run(index: number): Promise<void> {
      const handler = routes.get(path)?.[index];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as any, res as any, () => { next = run(index + 1); });
      await next;
    }
    await run(0);
    return result;
  }
  return { store, sender, bot, post, env };
}

describe("owner SMS exemption and prepare idempotency", () => {
  it.each([
    [PHONE, "(626) 555-0123"],
    [" (626) 555-0123 ", PHONE],
  ])("normalizes owner %s and destination %s, commits immediately and audits the exemption", async (owner, phone) => {
    const h = boot(owner);
    const response = await h.post({ ...SMS, phone });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "committed", approval: { status: "committed" }, result: { messageSid: "SM-synthetic" } });
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.sender.send.mock.calls[0][0].to).toBe(PHONE);
    const row = await h.store.getApproval(response.body.approval.id);
    expect(row).toMatchObject({ status: "committed", confirmUsedAt: NOW, committedAt: NOW });
    expect(row!.payloadHash).toBe(hashPayload(row!.payload));
    expect(h.store.audit).toContainEqual(expect.objectContaining({ tool: "prepare_sms", outcome: "committed", httpStatus: 200,
      details: { initiatedBy: "bot", approvalExempt: true, exemptReason: "owner_number" } }));
    expect(h.store.audit.every((entry) => !auditContainsPhi(entry as unknown as Record<string, unknown>))).toBe(true);
    expect(JSON.stringify(h.store.audit)).not.toMatch(/PRIVATE|16265550123|6265550123/);
  });

  it.each([undefined, "", "invalid", "+44206265550123", "6265550123999", "garbage6265550123", "+6265550123"])("requires approval when owner env is unset or invalid (%s)", async (owner) => {
    const h = boot();
    h.env.OPERATOR_OWNER_NUMBER = owner;
    const response = await h.post(SMS);
    expect(response).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { status: "pending" } } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.store.audit[h.store.audit.length - 1]?.outcome).toBe("pending_approval");
  });

  it("keeps the normal approval flow for any other number", async () => {
    const h = boot();
    expect(await h.post({ ...SMS, phone: "+16265550124" })).toMatchObject({ status: 201, body: { status: "pending_approval" } });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("commits a human-approved SMS through the same path and deduplicates subsequent prepares", async () => {
    const h = boot("+16265550999");
    const first = await h.post({ ...SMS, idempotency_key: "human-approved" });
    const row = (await h.store.getApproval(first.body.approval.id))!;
    const approved = await approveContact(h.store, row.id, "human-staff", NOW, row.payloadHash);
    if (!approved.ok) throw new Error(approved.error);
    const committed = await h.post({ confirmToken: approved.confirmToken }, h.bot, "/api/plugin/v1/commit_contact");
    expect(committed).toMatchObject({ status: 200, body: { status: "committed", approval: { id: row.id, status: "committed" } } });
    expect(await h.post({ ...SMS, idempotency_key: "human-approved" })).toMatchObject({ status: 200, body: { status: "committed", deduplicated: true } });
    expect((await h.post({ confirmToken: approved.confirmToken }, h.bot, "/api/plugin/v1/commit_contact")).status).toBe(409);
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it.each(["sms", "voice", "operator"])("blocks an opted-out owner (%s)", async (source) => {
    const h = boot();
    if (source === "sms") await h.store.setSmsOptOut("6265550123", true);
    if (source === "voice") h.store.channelDnc.stamp("6265550123", "voice:wayne-operator");
    if (source === "operator") await h.store.setOperatorOptOut(PHONE);
    expect(await h.post({ ...SMS, phone: "(626) 555-0123" })).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect([...h.store.approvals.values()][0].status).toBe("failed");
  });

  it("fails closed when the operator opt-out check is unavailable", async () => {
    const h = boot();
    vi.spyOn(h.store, "isOperatorOptedOut").mockRejectedValue(new Error("unavailable"));
    expect(await h.post(SMS)).toMatchObject({ status: 503, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("returns the original pending approval even if a replay supplies different words", async () => {
    const h = boot("+16265550999");
    const first = await h.post({ ...SMS, idempotency_key: "confirmation:event" });
    const second = await h.post({ ...SMS, body: "Different confirmation", idempotency_key: "confirmation:event" });
    expect(first.status).toBe(201);
    expect(second).toMatchObject({ status: 200, body: { status: "pending_approval", deduplicated: true, approval: { id: first.body.approval.id } } });
    expect(h.store.approvals.size).toBe(1);
    const row = [...h.store.approvals.values()][0];
    expect(row.idempotencyKey).toBe("confirmation:event");
    expect(row.payload).toEqual(SMS);
    expect(row.payloadHash).toBe(hashPayload(SMS));
    expect(h.store.audit[h.store.audit.length - 1]?.outcome).toBe("deduplicated");
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("returns the sent owner result for the same key without a second send", async () => {
    const h = boot();
    const first = await h.post({ ...SMS, idempotency_key: "owner-confirmation" });
    const second = await h.post({ ...SMS, body: "Different confirmation", idempotency_key: "owner-confirmation" });
    expect(first.body.status).toBe("committed");
    expect(second).toMatchObject({ status: 200, body: { ...first.body, deduplicated: true } });
    expect(h.store.approvals.size).toBe(1);
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.store.audit[h.store.audit.length - 1]?.outcome).toBe("deduplicated");
  });

  it.each(["unexpired", "expired", "handed-off"])("resumes an interrupted automatic owner send exactly once (%s confirm token)", async (state) => {
    const h = boot();
    const prepared = await prepareContact(h.store, h.bot.jti,
      { channel: "sms", payload: { ...SMS, idempotency_key: "interrupted" } },
      new Date(NOW.getTime() - (state === "expired" ? 10 * 60_000 : 0)), undefined, h.env);
    if (!prepared.ok) throw new Error(prepared.error);
    if (state === "expired") await h.store.purgeExpiredConfirmTokens(NOW);
    if (state === "handed-off") await h.store.takeConfirmToken(prepared.approval.id, h.bot.jti, NOW);
    expect((await h.store.getApproval(prepared.approval.id))!.status).toBe("approved");

    const responses = await Promise.all(Array.from({ length: 8 }, () => h.post({
      phone: "+16265550124", body: "Changed replay text", idempotency_key: "interrupted",
    })));
    for (const response of responses) {
      expect(response).toMatchObject({ status: 200, body: { deduplicated: true, approval: { id: prepared.approval.id } } });
    }
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.sender.send.mock.calls[0][0]).toMatchObject({ to: PHONE, body: expect.stringContaining(SMS.body) });
    expect(await h.store.getApproval(prepared.approval.id)).toMatchObject({ status: "committed", confirmUsedAt: NOW });
    expect(await h.post({ ...SMS, idempotency_key: "interrupted" })).toMatchObject({ status: 200, body: { status: "committed", deduplicated: true } });
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it("does not automatically resume a human-approved owner SMS", async () => {
    const h = boot("+16265550999");
    const first = await h.post({ ...SMS, idempotency_key: "human-owner" });
    const row = (await h.store.getApproval(first.body.approval.id))!;
    await approveContact(h.store, row.id, "human-staff", NOW, row.payloadHash);
    h.env.OPERATOR_OWNER_NUMBER = PHONE;
    expect(await h.post({ ...SMS, idempotency_key: "human-owner" })).toMatchObject({
      status: 200, body: { status: "approved", deduplicated: true },
    });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it.each([true, false])("handles racing prepares atomically (owner=%s)", async (owner) => {
    const h = boot(owner ? PHONE : "+16265550999");
    const responses = await Promise.all(Array.from({ length: 8 }, () => h.post({ ...SMS, idempotency_key: "racing" })));
    expect(new Set(responses.map((item) => item.body.approval.id)).size).toBe(1);
    expect(responses.filter((item) => item.body.deduplicated)).toHaveLength(7);
    expect(h.store.approvals.size).toBe(1);
    expect(h.sender.send).toHaveBeenCalledTimes(owner ? 1 : 0);
  });

  it("retains an unknown send under its key instead of sending again", async () => {
    const h = boot();
    h.sender.send.mockRejectedValue(new SendOutcomeError("sms_timeout", true));
    expect(await h.post({ ...SMS, idempotency_key: "unknown-send" })).toMatchObject({ status: 502, body: { outcome: "unknown" } });
    expect(await h.post({ ...SMS, idempotency_key: "unknown-send" })).toMatchObject({ status: 200, body: { status: "unknown", deduplicated: true } });
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it.each([null, 123, "k".repeat(201)])("rejects an invalid idempotency key (%#)", async (idempotency_key) => {
    const h = boot();
    expect((await h.post({ ...SMS, idempotency_key })).status).toBe(400);
    expect(h.store.approvals.size).toBe(0);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("scopes keys to the preparing token", async () => {
    const h = boot("+16265550999");
    const secondBot = h.store.mint(["contacts:prepare"]);
    await h.post({ ...SMS, idempotency_key: "shared" });
    expect((await h.post({ ...SMS, idempotency_key: "shared" }, secondBot)).status).toBe(201);
    expect(h.store.approvals.size).toBe(2);
  });

  it.each(["approved", "sending", "committed", "failed", "unknown"] as const)("returns an existing %s approval without another send", async (status) => {
    const h = boot("+16265550999");
    const first = await h.post({ ...SMS, idempotency_key: "retained" });
    await h.store.updateApproval(first.body.approval.id, { status });
    expect(await h.post({ ...SMS, idempotency_key: "retained" })).toMatchObject({
      status: 200, body: { status, deduplicated: true, approval: { id: first.body.approval.id } },
    });
    expect(h.store.approvals.size).toBe(1);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("accepts a 200-character key, and keeps unkeyed prepares independent", async () => {
    const h = boot("+16265550999");
    expect((await h.post({ ...SMS, idempotency_key: "k".repeat(200) })).status).toBe(201);
    expect((await h.post(SMS)).status).toBe(201);
    expect((await h.post(SMS)).status).toBe(201);
    expect(h.store.approvals.size).toBe(3);
  });

  it.each(["rejected", "cancelled"] as const)("allows a fresh prepare after %s", async (status) => {
    const h = boot("+16265550999");
    const first = await h.post({ ...SMS, idempotency_key: "reusable" });
    await h.store.updateApproval(first.body.approval.id, { status });
    const second = await h.post({ ...SMS, idempotency_key: "reusable" });
    expect(second.status).toBe(201);
    expect(second.body.approval.id).not.toBe(first.body.approval.id);
    expect(h.store.approvals.size).toBe(2);
  });
});

describe("SQL SMS idempotency", () => {
  it("persists the exemption reason alongside the approval ID without private details", async () => {
    const h = boot();
    const sent = await h.post(SMS);
    const exec = vi.fn<SqlExec>().mockResolvedValue([]);
    await createSqlPluginStore(exec).writeAudit(h.store.audit[h.store.audit.length - 1]);
    expect(exec.mock.calls[0][0]).toContain("approval_id, ticket_id");
    expect(exec.mock.calls[0][1]).toContain(sent.body.approval.id);
    expect(exec.mock.calls[0][1]).toContain(JSON.stringify({ initiatedBy: "bot", approvalExempt: true, exemptReason: "owner_number" }));
    expect(JSON.stringify(exec.mock.calls)).not.toMatch(/PRIVATE|16265550123/);
  });

  it("uses an atomic unique-key conflict guard, returns the winner and preserves automatic confirm fields", async () => {
    const memory = new MemoryPluginStore();
    const prepared = await prepareContact(memory, "preparer", { channel: "sms", payload: { ...SMS, idempotency_key: "same-key" } }, NOW, undefined, { OPERATOR_OWNER_NUMBER: PHONE });
    if (!prepared.ok) throw new Error(prepared.error);
    const row = prepared.approval;
    const sqlRow = { id: row.id, channel: row.channel, status: row.status, token_jti: row.tokenJti,
      payload: row.payload, payload_hash: row.payloadHash, idempotency_key: row.idempotencyKey,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(), confirm_token_hash: row.confirmTokenHash,
      confirm_token_plaintext: row.confirmTokenPlaintext, confirm_expires_at: row.confirmExpiresAt!.toISOString() };
    const exec = vi.fn<SqlExec>().mockResolvedValueOnce([]).mockResolvedValueOnce([sqlRow]);
    const store = createSqlPluginStore(exec);
    expect(await store.insertApproval({ ...row, id: "losing-insert" })).toMatchObject({ id: row.id, idempotencyKey: "same-key", confirmTokenHash: row.confirmTokenHash });
    expect(exec.mock.calls[0][0]).toMatch(/ON CONFLICT \(token_jti, idempotency_key\)/);
    expect(exec.mock.calls[0][0]).toContain("status NOT IN ('rejected', 'cancelled') DO NOTHING");
    expect(exec.mock.calls[0][1]).toContain(row.confirmTokenHash);
    expect(exec.mock.calls[0][1]).toContain(row.confirmTokenPlaintext);
    expect(exec.mock.calls[1][1]).toEqual(["preparer", "same-key"]);
    expect(exec.mock.calls[0][0]).not.toContain(SMS.body);
  });
});
