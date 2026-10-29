import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, RequestHandler } from "express";
import { mountPluginApi } from "./routes";
import { MemoryPluginStore } from "./store";
import { approveContact, prepareContact } from "./approvals";
import { hashPayload } from "./tokens";
import { auditContainsPhi } from "./phi";
import { SendOutcomeError } from "./sendFailure";

const OWNER = "+16265550123";
const OTHER = "+16265550124";
const FROM = "+15555550100";
const INPUT = { to: OWNER, body: "PRIVATE synthetic operator message", idempotency_key: "confirmation:event" };
const SEND = "/operator-line/sms/send";
const NIGHT = new Date("2026-10-29T10:00:00Z"); // 3 AM Pacific

afterEach(() => vi.restoreAllMocks());

/** Real API middleware and stores; injected SMS sender never contacts Twilio. */
function boot() {
  const store = new MemoryPluginStore();
  const sender = { send: vi.fn().mockResolvedValue({ sid: "SM-synthetic" }) };
  const env: Record<string, string | undefined> = {
    PLUGIN_WRITES_ENABLED: "true", OPERATOR_LINE_INBOUND_ENABLED: "true",
    OPERATOR_OWNER_NUMBER: OWNER, OPERATOR_LINE_FROM_NUMBER: FROM,
  };
  const clock = { at: NIGHT };
  const bot = store.mint(["operator:call"]);
  const general = store.mint(["contacts:prepare", "contacts:commit"]);
  const staff = store.mint(["contacts:approve"]);
  const routes: Array<{ method: string; path: string; handlers: RequestHandler[] }> = [];
  const app = Object.fromEntries(["get", "post"].map((method) => [method,
    (path: string, ...handlers: RequestHandler[]) => routes.push({ method, path, handlers }),
  ])) as unknown as Express;
  mountPluginApi(app, { store, agents: { getAllAgents: () => [] }, env, now: () => clock.at, smsSender: sender });
  async function request(body: unknown = INPUT, token: typeof bot | null = bot, path = SEND, method = "post") {
    const fullPath = `/api/plugin/v1${path}`;
    const route = routes.find((candidate) => candidate.method === method &&
      new RegExp(`^${candidate.path.replace(/:[^/]+/g, "([^/]+)")}$`).test(fullPath));
    if (!route) throw new Error("Route not mounted");
    const params: Record<string, string> = {};
    route.path.split("/").forEach((part, index) => {
      if (part.startsWith(":")) params[part.slice(1)] = fullPath.split("/")[index];
    });
    const req = { method: method.toUpperCase(), path: fullPath, route: { path: route.path }, params, body,
      headers: token ? { authorization: `Bearer ${token.plaintext}` } : {} };
    const result = { status: 200, body: {} as Record<string, any>, headers: {} as Record<string, string> };
    const res = {
      status(status: number) { result.status = status; return res; },
      json(value: Record<string, any>) { result.body = value; return res; },
      setHeader(name: string, value: string) { result.headers[name] = value; return res; },
    };
    async function run(index: number): Promise<void> {
      const handler = route!.handlers[index];
      if (!handler) return;
      let next: Promise<void> | undefined;
      await handler(req as any, res as any, () => { next = run(index + 1); });
      await next;
    }
    await run(0);
    return result;
  }
  return { store, sender, env, clock, bot, general, staff, request };
}

describe("operator-line SMS send", () => {
  it.each(["2026-10-29T10:00:00Z", "2026-10-31T10:00:00Z", "2026-10-29T18:00:00Z"])(
    "sends to the normalized owner immediately at %s without hours or caps", async (at) => {
      const h = boot();
      h.clock.at = new Date(at);
      h.env.OPERATOR_OWNER_NUMBER = " (626) 555-0123 ";
      const response = await h.request({ ...INPUT, to: "(626) 555-0123" });
      expect(response).toMatchObject({ status: 200, headers: { "Cache-Control": "no-store" }, body: {
        status: "committed", approval: { status: "committed", laneSlug: "wayne-operator",
          maskedNumber: "***0123", maskedFromNumber: "***0100", initiated_by: "bot_initiative" },
        result: { messageSid: "SM-synthetic" },
      } });
      expect(h.sender.send).toHaveBeenCalledExactlyOnceWith({ to: OWNER, from: FROM, body: INPUT.body });
      const row = [...h.store.approvals.values()][0];
      expect(row).toMatchObject({ status: "committed", approvedBy: null, confirmUsedAt: h.clock.at,
        payload: { smsKind: "operator", laneSlug: "wayne-operator", fromNumber: FROM, initiated_by: "bot_initiative" } });
      expect(row.payloadHash).toBe(hashPayload(row.payload));
      expect(h.store.audit).toContainEqual(expect.objectContaining({ tool: "operator_sms_send", outcome: "committed",
        details: { operatorSms: true, initiatedBy: "bot_initiative", maskedNumber: "***0123" } }));
      expect(h.store.audit.every((entry) => !auditContainsPhi(entry as unknown as Record<string, unknown>))).toBe(true);
      expect(JSON.stringify([response.body, h.store.audit])).not.toMatch(/PRIVATE|16265550123|15555550100/);
    });

  it.each(["owner_request", "bot_initiative"])("requires approval for other destinations even with %s provenance, then commits at night", async (initiated_by) => {
    const h = boot();
    const pending = await h.request({ ...INPUT, to: OTHER, initiated_by });
    expect(pending).toMatchObject({ status: 201, body: { status: "pending_approval", approval: {
      status: "pending", maskedNumber: "***0124", initiated_by,
    } } });
    expect(h.sender.send).not.toHaveBeenCalled();
    const row = (await h.store.getApproval(pending.body.approval.id))!;
    expect(row.payload).toMatchObject({ fromNumber: FROM, laneSlug: "wayne-operator", initiated_by });
    const approved = await approveContact(h.store, row.id, h.staff.jti, h.clock.at, row.payloadHash);
    if (!approved.ok) throw new Error(approved.error);
    const handoff = await h.request(undefined, h.bot, `/contact_requests/${row.id}/confirm_token`, "get");
    expect(handoff.status).toBe(200);
    const committed = await h.request({ confirmToken: handoff.body.confirmToken }, h.bot, "/commit_contact");
    expect(committed).toMatchObject({ status: 200, body: { status: "committed" } });
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith({ to: OTHER, from: FROM, body: INPUT.body });
    expect(JSON.stringify([pending.body, committed.body, h.store.audit])).not.toMatch(/PRIVATE|16265550124|15555550100/);
    expect((await h.request({ confirmToken: handoff.body.confirmToken }, h.bot, "/commit_contact")).status).toBe(409);
  });

  it.each([undefined, "", "invalid", "+44206265550123"])("requires approval when the owner setting is absent/invalid/nonmatching (%s)", async (owner) => {
    const h = boot();
    h.env.OPERATOR_OWNER_NUMBER = owner;
    expect(await h.request()).toMatchObject({ status: 201, body: { status: "pending_approval" } });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  for (const to of [OWNER, OTHER]) {
    it.each(["sms", "voice", "operator"])(`blocks ${to === OWNER ? "owner" : "third-party"} opt-outs from %s before approval`, async (source) => {
      const h = boot();
      if (source === "sms") await h.store.setSmsOptOut(to.slice(-10), true);
      if (source === "voice") h.store.channelDnc.stamp(to.slice(-10), "voice:wayne-operator");
      if (source === "operator") await h.store.setOperatorOptOut(to);
      expect(await h.request({ ...INPUT, to })).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
      expect(h.sender.send).not.toHaveBeenCalled();
      expect(h.store.approvals.size).toBe(0);
    });
  }

  it.each(["sms", "voice", "operator"])("rechecks %s opt-out after a third-party approval", async (source) => {
    const h = boot();
    const pending = await h.request({ ...INPUT, to: OTHER });
    const row = (await h.store.getApproval(pending.body.approval.id))!;
    const approved = await approveContact(h.store, row.id, h.staff.jti, h.clock.at, row.payloadHash);
    if (!approved.ok) throw new Error(approved.error);
    if (source === "sms") await h.store.setSmsOptOut(OTHER.slice(-10), true);
    if (source === "voice") h.store.channelDnc.stamp(OTHER.slice(-10), "voice:wayne-operator");
    if (source === "operator") await h.store.setOperatorOptOut(OTHER);
    expect(await h.request({ confirmToken: approved.confirmToken }, h.bot, "/commit_contact"))
      .toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(await h.store.getApproval(row.id)).toMatchObject({ status: "failed" });
  });

  it.each(["isSmsOptedOut", "isOperatorOptedOut"] as const)("fails closed when %s is unavailable", async (method) => {
    const h = boot();
    vi.spyOn(h.store, method).mockRejectedValue(new Error("unavailable"));
    expect(await h.request()).toMatchObject({ status: 503, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("returns the original sent result for a duplicate key with different destination/text", async () => {
    const h = boot();
    const first = await h.request();
    const second = await h.request({ ...INPUT, to: OTHER, body: "Regenerated message" });
    expect(second.body).toEqual({ ...first.body, deduplicated: true });
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.store.approvals.size).toBe(1);
  });

  it.each([OWNER, OTHER])("deduplicates racing requests to %s atomically", async (to) => {
    const h = boot();
    const responses = await Promise.all(Array.from({ length: 8 }, () => h.request({ ...INPUT, to })));
    expect(new Set(responses.map((response) => response.body.approval.id)).size).toBe(1);
    expect(responses.filter((response) => response.body.deduplicated)).toHaveLength(7);
    expect(h.sender.send).toHaveBeenCalledTimes(to === OWNER ? 1 : 0);
    expect(h.store.approvals.size).toBe(1);
    if (to === OTHER) expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  });

  it("resumes an interrupted automatic owner approval using its original payload and rechecks opt-out", async () => {
    const h = boot();
    const prepared = await prepareContact(h.store, h.bot.jti, { channel: "sms", payload: INPUT as never },
      NIGHT, "operator_sms", h.env);
    if (!prepared.ok) throw new Error(prepared.error);
    await h.store.setSmsOptOut(OWNER.slice(-10), true);
    expect(await h.request({ ...INPUT, to: OTHER })).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(await h.store.getApproval(prepared.approval.id)).toMatchObject({ status: "failed" });
  });

  it.each([true, false])("retains a failed/unknown send without retrying (mayHaveSent=%s) and never exposes provider text", async (mayHaveSent) => {
    const h = boot();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.sender.send.mockRejectedValue(new SendOutcomeError(INPUT.body, mayHaveSent));
    const first = await h.request();
    expect(first).toMatchObject({ status: mayHaveSent ? 502 : 409, body: { outcome: mayHaveSent ? "unknown" : "not_sent" } });
    const second = await h.request();
    expect(second).toMatchObject({ status: 200, body: { status: mayHaveSent ? "unknown" : "failed", deduplicated: true } });
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(JSON.stringify([first.body, second.body, h.store.audit, log.mock.calls])).not.toContain(INPUT.body);
  });

  it.each([undefined, null, 123, "", " ", "k".repeat(201)])("requires a nonempty idempotency key of at most 200 chars (%#)", async (idempotency_key) => {
    const h = boot();
    expect((await h.request({ ...INPUT, idempotency_key })).status).toBe(400);
    expect(h.store.approvals.size).toBe(0);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("accepts a 200-character key and scopes keys to the preparing bot", async () => {
    const h = boot();
    const input = { ...INPUT, idempotency_key: "k".repeat(200) };
    expect((await h.request(input)).status).toBe(200);
    expect((await h.request(input, h.store.mint(["operator:call"]))).status).toBe(200);
    expect(h.sender.send).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { ...INPUT, to: "garbage6265550123" }, { ...INPUT, to: "+44206265550123" },
    { ...INPUT, body: " " }, { ...INPUT, from: FROM }, { ...INPUT, initiated_by: "unknown" }])("rejects invalid bodies (%#)", async (body) => {
    const h = boot();
    expect((await h.request(body)).status).toBe(400);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it.each([undefined, "invalid", "+19092553213"])("rejects missing, invalid, or SI operator origins (%s)", async (from) => {
    const h = boot();
    h.env.OPERATOR_LINE_FROM_NUMBER = from;
    expect((await h.request()).status).toBe(503);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("reads the operator origin from configuration and masks it in the response", async () => {
    const h = boot();
    h.env.OPERATOR_LINE_FROM_NUMBER = "+15555550199";
    const response = await h.request({ ...INPUT, to: "+1 (626) 555-0123" });
    expect(response).toMatchObject({ status: 200, body: { approval: { maskedFromNumber: "***0199" } } });
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith({ to: OWNER, from: "+15555550199", body: INPUT.body });
  });

  it.each(["origin", "feature"])("fails closed if operator %s changes between approval and commit", async (setting) => {
    const h = boot();
    const pending = await h.request({ ...INPUT, to: OTHER });
    const row = (await h.store.getApproval(pending.body.approval.id))!;
    const approved = await approveContact(h.store, row.id, h.staff.jti, h.clock.at, row.payloadHash);
    if (!approved.ok) throw new Error(approved.error);
    if (setting === "origin") h.env.OPERATOR_LINE_FROM_NUMBER = "+15555550199";
    else h.env.OPERATOR_LINE_INBOUND_ENABLED = "false";
    expect(await h.request({ confirmToken: approved.confirmToken }, h.bot, "/commit_contact"))
      .toMatchObject({ status: 503, body: { outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("honors auth, operator scope, bot-only, write, and operator feature gates", async () => {
    const h = boot();
    expect((await h.request(INPUT, null)).status).toBe(401);
    for (const token of [h.general, h.staff, h.store.mint(["operator:call", "contacts:approve"])]) {
      expect((await h.request(INPUT, token)).status).toBe(403);
    }
    h.env.PLUGIN_WRITES_ENABLED = "false";
    expect((await h.request()).status).toBe(403);
    h.env.PLUGIN_WRITES_ENABLED = "true";
    h.env.OPERATOR_LINE_INBOUND_ENABLED = "false";
    expect((await h.request()).status).toBe(503);
    h.env.OPERATOR_LINE_INBOUND_ENABLED = "true";
    await h.store.setOperatorLineEnabled(false, h.staff.jti);
    expect((await h.request()).status).toBe(503);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it("allows only the preparing operator bot to retrieve/commit its SMS approval", async () => {
    const h = boot();
    const pending = await h.request({ ...INPUT, to: OTHER });
    const row = (await h.store.getApproval(pending.body.approval.id))!;
    const approved = await approveContact(h.store, row.id, h.staff.jti, h.clock.at, row.payloadHash);
    if (!approved.ok) throw new Error(approved.error);
    for (const token of [h.general, h.staff, h.store.mint(["operator:call"])]) {
      expect((await h.request({ confirmToken: approved.confirmToken }, token, "/commit_contact")).status).toBeGreaterThanOrEqual(400);
    }
    expect((await h.request({ confirmToken: approved.confirmToken }, h.bot, "/commit_contact")).status).toBe(200);
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it("does not reuse idempotency keys across SI and operator SMS lanes", async () => {
    const h = boot();
    const both = h.store.mint(["operator:call", "contacts:prepare", "contacts:commit"]);
    await h.request(INPUT, both);
    expect((await h.request({ phone: OWNER, body: INPUT.body, idempotency_key: INPUT.idempotency_key }, both, "/prepare_sms")).status).toBe(409);
    await h.request({ phone: OTHER, body: INPUT.body, idempotency_key: "si-key" }, both, "/prepare_sms");
    expect((await h.request({ ...INPUT, idempotency_key: "si-key" }, both)).status).toBe(409);
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it("keeps general prepare_sms outside_hours at 3 AM Pacific", async () => {
    const h = boot();
    const general = await h.request({ phone: OWNER, body: INPUT.body, idempotency_key: "general" }, h.general, "/prepare_sms");
    expect(general).toMatchObject({ status: 409, body: { error: "SMS was not sent: outside_hours", outcome: "not_sent" } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect((await h.request()).status).toBe(200);
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith({ to: OWNER, from: FROM, body: INPUT.body });
  });
});
