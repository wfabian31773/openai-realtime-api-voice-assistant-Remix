import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR_SCENARIO_DIRECTORY } from "./operatorScenarios";
import type { Express, RequestHandler } from "express";
import { MemoryPluginStore } from "./store";
import { mountPluginApi } from "./routes";
import { LiveCallRegistry, LIVE_RETENTION_MS } from "./liveSessions";
import type { LiveCallSender } from "./liveCalls";
import { FakeOutboundStore } from "../runtime/outbound/store.testkit";
import { CONFIRM_TTL_MS } from "./tokens";
import { DEFAULT_PLUGIN_SCOPES, mintScopesCompatible, isWritePluginScope } from "./scopes";
import { createSqlPluginStore } from "./sqlStore";
import { OPERATOR_SLUG } from "./operatorLine";
import { siAssistantNumber } from "./siAssistantConstants";
import { bindPluginStore } from "./bindings";
import { setOutboundToolStoreForTests, OPT_OUT_TOOL_NAME } from "../tools/outboundTools";
import { getTool } from "../tools/registry";
import twilio from "twilio";
import { CallSessionRegistry } from "../runtime/sessionRegistry";
import { handleOutboundAnswer, handleOutboundStatus } from "../runtime/outbound/outboundWebhook";
import { operatorLinePolicy } from "../agents/operatorLineAgent";

const PHONE = "+19094795435";
const OPEN = "2026-10-22T18:00:00Z";
const INPUT = { phone: PHONE, purpose: "Synthetic family booking test", callerScript: "Call as a synthetic parent. Preserve flashes, but no vision loss." };
const registries: LiveCallRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.clear();
  bindPluginStore(null);
  setOutboundToolStoreForTests(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function boot() {
  const clock = { at: new Date(OPEN) };
  const store = new MemoryPluginStore();
  const outbound = new FakeOutboundStore(() => clock.at);
  outbound.channelDnc = store.channelDnc;
  const sessions = new LiveCallRegistry(() => clock.at);
  registries.push(sessions);
  const env: Record<string, string | undefined> = {
    PLUGIN_WRITES_ENABLED: "true", RUNTIME_OUTBOUND_DIALING: "1", OUTBOUND_CAMPAIGN_SI_ASSISTANT: "1",
    SI_ASSISTANT_NUMBER: "+19092553213", OPERATOR_LINE_FROM_NUMBER: "+15555550100", DOMAIN: "fleet.example", APP_ENV: "production",
  };
  const sender = {
    createCall: vi.fn<LiveCallSender["createCall"]>().mockResolvedValue({ sid: "CA-live" }),
    voiceUrlFor: vi.fn<LiveCallSender["voiceUrlFor"]>().mockResolvedValue("https://fleet.example/voice/si-assistant"),
    endCall: vi.fn<LiveCallSender["endCall"]>().mockResolvedValue({}),
  };
  const sms = { send: vi.fn().mockResolvedValue({ sid: "SM-test" }) };
  const bot = store.mint(["fleet:read", "operator:call"]);
  const other = store.mint(["contacts:commit"]);
  const staff = store.mint(["contacts:approve"]);
  // Run the real middleware/handlers in process: the offline sandbox does
  // not permit TCP listeners, and these routes need no socket behavior.
  const routes: Array<{ method: string; path: string; handlers: RequestHandler[] }> = [];
  const app = Object.fromEntries(["get", "post"].map((method) => [method,
    (path: string, ...handlers: RequestHandler[]) => routes.push({ method: method.toUpperCase(), path, handlers }),
  ])) as unknown as Express;
  mountPluginApi(app, { store, outboundStore: outbound, agents: { getAllAgents: () => [] }, env,
    now: () => clock.at, liveCalls: sessions, liveCallSender: sender, smsSender: sms });
  async function request(path: string, body?: unknown, token = bot, onResponse?: () => void) {
    const url = new URL(path, "https://fleet.example/api/plugin/v1/");
    const pathname = `/api/plugin/v1${url.pathname}`;
    const method = body === undefined ? "GET" : "POST";
    const route = routes.find((candidate) => candidate.method === method &&
      new RegExp(`^${candidate.path.replace(/:[^/]+/g, "[^/]+")}$`).test(pathname));
    if (!route) throw new Error(`Missing route: ${method} ${pathname}`);
    const params: Record<string, string> = {};
    route.path.split("/").forEach((part, index) => { if (part.startsWith(":")) params[part.slice(1)] = pathname.split("/")[index]; });
    const req = { method, route: { path: route.path }, path: pathname, originalUrl: pathname + url.search, params, query: Object.fromEntries(url.searchParams), body,
      headers: { authorization: `Bearer ${token.plaintext}` } };
    const result = { status: 200, body: undefined as any, headers: new Headers() };
    const res = {
      setHeader(name: string, value: string) { result.headers.set(name, value); },
      status(status: number) { result.status = status; return res; },
      json(value: unknown) { result.body = value; onResponse?.(); return res; },
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
  async function approved(payload: Record<string, unknown> = INPUT) {
    const prep = await request("/prepare_operator_call", payload);
    if (prep.status !== 201) throw new Error(JSON.stringify(prep.body));
    const row = (await store.getApproval(prep.body.approval.id))!;
    const approved = await request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash }, staff);
    if (approved.status !== 200) throw new Error(JSON.stringify(approved.body));
    return { id: row.id, confirmToken: approved.body.confirmToken as string };
  }
  return { clock, store, outbound, sessions, env, sender, bot, staff, other, request, approved };
}

describe("approval-gated Wayne operator line", () => {
  it("requires an explicit bot scope, preserves mint defaults and excludes mixed staff tokens", async () => {
    const h = await boot();
    expect(DEFAULT_PLUGIN_SCOPES).toEqual(["fleet:read"]);
    expect(isWritePluginScope("operator:call")).toBe(true);
    expect(mintScopesCompatible(["operator:call", "contacts:approve"]).ok).toBe(false);
    expect(mintScopesCompatible(["operator:call", "fleet:read"]).ok).toBe(true);
    for (const token of [h.staff, h.other, h.store.mint(), h.store.mint(["contacts:prepare", "contacts:commit"]), h.store.mint(["operator:call", "contacts:approve"])]) {
      expect((await h.request("/prepare_operator_call", INPUT, token)).status).toBe(403);
    }
    expect(h.store.approvals.size).toBe(0);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("shows a pending action to the human, disallows bot approval and gives the preparing bot a single handoff", async () => {
    const h = await boot();
    const pending = await h.request("/prepare_operator_call", INPUT);
    expect(pending).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { callKind: "operator", maskedNumber: "***5435" } } });
    expect(JSON.stringify(pending.body)).not.toContain(PHONE);
    expect(pending.body.approval).not.toHaveProperty("payload");
    expect(h.sender.createCall).not.toHaveBeenCalled();
    const row = (await h.store.getApproval(pending.body.approval.id))!;
    expect(row).toMatchObject({ channel: "call", ticketId: null, ticketNumber: null, payload: { callKind: "operator", maxDurationSec: 600 } });
    expect((await h.request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash })).status).toBe(403);
    const mixed = h.store.mint(["operator:call", "contacts:approve"]);
    expect((await h.request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash }, mixed)).status).toBe(403);
    const listed = await h.request("/approvals", undefined, h.staff);
    expect(listed.body.approvals[0]).toMatchObject({ payload: { ...INPUT, callKind: "operator" }, payloadHash: row.payloadHash });
    const approved = await h.request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash }, h.staff);
    expect(approved.status).toBe(200);
    expect(approved.body.confirmToken).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(approved.body.expiresAt) - h.clock.at.getTime()).toBe(CONFIRM_TTL_MS);
    const otherBot = h.store.mint(["operator:call"]);
    expect((await h.request(`/contact_requests/${row.id}/confirm_token`, undefined, otherBot)).status).toBe(404);
    expect((await h.request(`/contact_requests/${row.id}/confirm_token`, undefined, h.staff)).status).toBe(403);
    expect((await h.request(`/contact_requests/${row.id}/confirm_token`)).body.confirmToken).toBe(approved.body.confirmToken);
    expect((await h.request(`/contact_requests/${row.id}/confirm_token`)).status).toBe(409);
    expect((await h.request("/commit_call_live", { confirmToken: approved.body.confirmToken }, h.staff)).status).toBe(403);
    expect((await h.request("/commit_call_live", { confirmToken: approved.body.confirmToken }, otherBot)).status).toBe(404);
    expect((await h.store.getApproval(row.id))!.confirmUsedAt).toBeNull();
  });

  it("places exactly one approved call and uses the existing status, guidance and end endpoints", async () => {
    const h = await boot(); const a = await h.approved();
    const [result, second] = await Promise.all([
      h.request("/commit_call_live", { confirmToken: a.confirmToken }),
      h.request("/commit_call_live", { confirmToken: a.confirmToken }),
    ]);
    expect([result.status, second.status].sort()).toEqual([200, 409]);
    const live = result.status === 200 ? result : second;
    expect(h.sender.createCall).toHaveBeenCalledOnce();
    expect(h.sender.createCall).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE, from: h.env.OPERATOR_LINE_FROM_NUMBER, timeLimit: 600,
      url: expect.stringContaining(`/voice/${OPERATOR_SLUG}?`),
    }));
    expect(h.sender.voiceUrlFor).not.toHaveBeenCalled();
    const session = h.sessions.get(live.body.sessionId)!;
    expect(h.outbound.contacts.get(session.contactId)).toMatchObject({ firstName: null, lastName: null, customData: { plugin_live: true, plugin_operator: true } });
    const instruct = vi.fn(); const end = vi.fn();
    h.sessions.attach(live.body.callSid, { turns: () => [], instruct, end });
    expect((await h.request(`/live_calls/${session.sessionId}`)).status).toBe(200);
    expect((await h.request(`/live_calls/${session.sessionId}/instruct`, { text: "Ask about hours" })).status).toBe(200);
    expect(instruct).toHaveBeenCalledWith("Ask about hours");
    expect((await h.request(`/live_calls/${session.sessionId}`, undefined, h.staff)).status).toBe(403);
    expect((await h.request(`/live_calls/${session.sessionId}/end`, {})).status).toBe(200);
    expect(end).toHaveBeenCalledOnce();
    expect(h.sender.endCall).toHaveBeenCalledWith(live.body.callSid);
    const audit = JSON.stringify(await h.store.listAudit());
    for (const secret of [PHONE, INPUT.purpose, INPUT.callerScript, a.confirmToken, h.bot.plaintext]) expect(audit).not.toContain(secret);
  });

  it("cannot consume an operator approval through commit_contact or with a removed operator scope", async () => {
    const h = await boot(); const a = await h.approved();
    h.store.tokens.get(h.bot.jti)!.scopes = ["contacts:commit"];
    expect((await h.request("/commit_contact", { confirmToken: a.confirmToken })).status).toBe(400);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(403);
    expect((await h.store.getApproval(a.id))!.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("rejects an altered approval hash and altered stored payload before dialing", async () => {
    const h = await boot();
    const pending = await h.request("/prepare_operator_call", INPUT);
    const id = pending.body.approval.id;
    expect((await h.request(`/approvals/${id}/approve`, { payloadHash: "a".repeat(64) }, h.staff)).status).toBe(409);
    const a = await h.approved();
    const row = (await h.store.getApproval(a.id))!;
    await h.store.updateApproval(a.id, { payload: { ...row.payload, maxDurationSec: 1800, callerScript: "tampered" } });
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(409);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("expires confirmations at five minutes", async () => {
    const h = await boot(); const a = await h.approved();
    h.clock.at = new Date(h.clock.at.getTime() + CONFIRM_TTL_MS);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(410);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["voice", "sms", "international"])("blocks %s opt-outs at commit, including opt-outs added after approval", async (kind) => {
    const h = await boot(); const phone = kind === "international" ? "+442079460123" : PHONE;
    const a = await h.approved({ ...INPUT, phone });
    if (kind === "voice") await h.outbound.stampDoNotContact(phone, "voice");
    if (kind === "sms") await h.store.setSmsOptOut(phone.slice(-10), true);
    if (kind === "international") await h.store.setOperatorOptOut(phone);
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken }))).toMatchObject({ status: 409, body: { outcome: "not_sent" } });
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["+442079460123", "+4423456789"])("persists an international voice opt-out for %s before settling and blocks another call", async (phone) => {
    const h = await boot();
    const a = await h.approved({ ...INPUT, phone });
    const live = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(live.status).toBe(200);
    const session = h.sessions.get(live.body.sessionId)!;
    bindPluginStore(h.store); setOutboundToolStoreForTests(h.outbound);
    const outcome = await getTool(OPT_OUT_TOOL_NAME)!.handler({ outbound_phone: phone, outbound_campaign: OPERATOR_SLUG, outbound_contact_id: session.contactId });
    expect(outcome.success).toBe(true);
    expect(await h.store.isOperatorOptedOut(phone)).toBe(true);
    const next = await h.approved({ ...INPUT, phone });
    expect((await h.request("/commit_call_live", { confirmToken: next.confirmToken })).status).toBe(409);
  });

  it.each([undefined, "", "+19092553213", "9092553213"])("fails prepare and commit safely for invalid/missing operator caller ID %j", async (from) => {
    const h = await boot(); const a = await h.approved();
    h.env.OPERATOR_LINE_FROM_NUMBER = from;
    const prep = await h.request("/prepare_operator_call", INPUT);
    expect(prep.status).toBe(503); expect(prep.body.error).toContain("OPERATOR_LINE_FROM_NUMBER");
    const commit = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(commit.status).toBe(503); expect(commit.body.error).toContain("OPERATOR_LINE_FROM_NUMBER");
    expect((await h.store.getApproval(a.id))!.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
    expect(siAssistantNumber(h.env)).toBe("+19092553213");
  });

  it.each([
    { phone: "9094795435" }, { maxDurationSec: 29 }, { maxDurationSec: 1801 }, { maxDurationSec: 30.5 },
    { maxDurationSec: "30" }, { dateOfBirth: "1950-01-01" }, { ticketId: "ticket" }, { firstName: "Synthetic" },
    { callerScript: "" }, { purpose: "" }, { language: "" },
  ])("rejects invalid or patient fields %j", async (fields) => {
    const h = await boot();
    expect((await h.request("/prepare_operator_call", { ...INPUT, ...fields })).status).toBe(400);
    expect(h.store.approvals.size).toBe(0);
  });

  it.each([false, true])("hard-stops with REST hangup even if a model never ends (attached=%s)", async (attached) => {
    vi.useFakeTimers();
    const h = await boot(); const a = await h.approved({ ...INPUT, maxDurationSec: 30 });
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(h.sender.createCall.mock.calls[0][0].timeLimit).toBe(30);
    const end = vi.fn();
    if (attached) h.sessions.attach(result.body.callSid, { turns: () => [], instruct: () => {}, end });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.sender.endCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sender.endCall).toHaveBeenCalledWith(result.body.callSid);
    expect(h.sessions.get(result.body.sessionId)!.endedAt).not.toBeNull();
    if (attached) expect(end).toHaveBeenCalledOnce();
  });

  it("hangs up an initially unknown call when a signed callback binds it after the deadline", async () => {
    vi.useFakeTimers();
    const h = await boot(); const a = await h.approved({ ...INPUT, maxDurationSec: 30 });
    h.sender.createCall.mockRejectedValue(new Error("ambiguous timeout"));
    const result = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(result).toMatchObject({ status: 502, body: { outcome: "unknown", sessionId: expect.any(String) } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sessions.bindCall(result.body.sessionId, "CA-late")).toBe(true);
    await Promise.resolve();
    expect(h.sender.endCall).toHaveBeenCalledWith("CA-late");
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(409);
    expect(h.sender.createCall).toHaveBeenCalledOnce();
  });

  it("does not dial if storage preparation outlives the hard-stop deadline", async () => {
    vi.useFakeTimers();
    const h = await boot(); const a = await h.approved({ ...INPUT, maxDurationSec: 30 });
    const save = h.store.saveOperatorCall.bind(h.store);
    vi.spyOn(h.store, "saveOperatorCall").mockImplementationOnce(async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      await save(record);
    });
    const pending = h.request("/commit_call_live", { confirmToken: a.confirmToken });
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await pending).status).toBe(503);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("returns the complete ordered transcript after memory expiry and restricts retrieval to its bot", async () => {
    vi.useFakeTimers();
    const h = await boot(); const a = await h.approved();
    const live = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    const turns = [{ role: "agent" as const, text: "Hello", atMs: 1000 }, { role: "caller" as const, text: "Flashes, but no vision loss", atMs: 2000 }, { role: "agent" as const, text: "Understood", atMs: 3000 }];
    h.sessions.attach(live.body.callSid, { turns: () => turns, instruct: () => {}, end: () => {} });
    h.sessions.setStatus(live.body.sessionId, "completed");
    h.sessions.finishTranscript(live.body.callSid, [...turns, { role: "agent", text: "Goodbye [interrupted]", atMs: 4000 }]);
    await h.sessions.get(live.body.sessionId)!.persistence;
    await vi.advanceTimersByTimeAsync(LIVE_RETENTION_MS);
    expect(h.sessions.get(live.body.sessionId)).toBeNull();
    const response = await h.request(`/calls/${live.body.sessionId}/transcript`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body.transcript.map((turn: any) => turn.text)).toEqual([...turns.map((turn) => turn.text), "Goodbye [interrupted]"]);
    expect((await h.request(`/calls/${live.body.sessionId}/transcript`, undefined, h.staff)).status).toBe(403);
    expect((await h.request(`/calls/${live.body.sessionId}/transcript`, undefined, h.store.mint(["operator:call"]))).status).toBe(404);
    h.env.PLUGIN_WRITES_ENABLED = "false";
    expect((await h.request(`/calls/${live.body.sessionId}/transcript`)).status).toBe(200);
  });

  it("binds signed early operator webhooks and refuses wrong lanes and unsigned answers", async () => {
    const h = await boot(); const registry = new CallSessionRegistry();
    const env = { ...h.env, TWILIO_AUTH_TOKEN: "synthetic-auth", DATABASE_URL: "postgres://test", XAI_API_KEY: "synthetic-unused" };
    const deps = { env, registry, store: h.outbound, liveCalls: h.sessions, policyFor: () => operatorLinePolicy };
    const body = { CallSid: "CA-operator-early", From: h.env.OPERATOR_LINE_FROM_NUMBER!, To: PHONE, AnsweredBy: "human" };
    function signed(url: string, fields: Record<string, string>) {
      return { originalUrl: new URL(url).pathname + new URL(url).search, body: fields, headers: { host: "fleet.example", "x-forwarded-proto": "https",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, fields) } };
    }
    h.sender.createCall.mockImplementation(async (options) => {
      const invalid = signed(options.url, body); invalid.headers["x-twilio-signature"] = "invalid";
      expect((await handleOutboundAnswer(OPERATOR_SLUG, invalid, deps)).status).toBe(403);
      expect((await handleOutboundAnswer("si-assistant", signed(options.url, body), deps)).body).toContain("<Hangup/>");
      expect((await handleOutboundAnswer(OPERATOR_SLUG, signed(options.url, body), deps)).body).toContain("<Connect><Stream");
      return { sid: body.CallSid };
    });
    const a = await h.approved();
    const live = await h.request("/commit_call_live", { confirmToken: a.confirmToken });
    expect(live.status).toBe(200);
    expect(registry.get(body.CallSid)).toMatchObject({ slug: OPERATOR_SLUG, liveSessionId: live.body.sessionId });
    await handleOutboundStatus(OPERATOR_SLUG, signed(h.sender.createCall.mock.calls[0][0].statusCallback, { ...body, CallStatus: "completed" }), deps);
    expect(h.sessions.get(live.body.sessionId)!.status).toBe("completed");
    expect((await handleOutboundAnswer(OPERATOR_SLUG, signed(h.sender.createCall.mock.calls[0][0].url, body), deps)).body).toContain("<Hangup/>");
  });

  it("fails closed when transcript storage is unavailable", async () => {
    const h = await boot(); const a = await h.approved();
    vi.spyOn(h.store, "saveOperatorCall").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await h.request("/commit_call_live", { confirmToken: a.confirmToken })).status).toBe(503);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("round-trips ordered transcripts with the SQL adapter using parameters", async () => {
    const record = { sessionId: "session", approvalId: "approval", tokenJti: "bot", callSid: "CA-test", status: "completed", startedAt: new Date(1000), endedAt: new Date(3000), turns: [{ role: "caller" as const, text: "synthetic words", atMs: 2000 }] };
    const exec = vi.fn().mockResolvedValue([]);
    const store = createSqlPluginStore(exec);
    await store.saveOperatorCall(record);
    expect(exec.mock.calls[0][0]).toContain("ON CONFLICT (session_id)");
    expect(exec.mock.calls[0][0]).not.toContain(record.turns[0].text);
    exec.mockResolvedValue([{ session_id: record.sessionId, approval_id: record.approvalId, token_jti: record.tokenJti, call_sid: record.callSid,
      status: record.status, started_at: record.startedAt.toISOString(), ended_at: record.endedAt.toISOString(), turns: JSON.stringify(record.turns) }]);
    expect(await store.getOperatorCall("session")).toEqual(record);
  });
});

const COMMITTED_SCRIPT = readFileSync(join(OPERATOR_SCENARIO_DIRECTORY, "family-bookings.md"), "utf8");
const TEST_INPUT = { ...INPUT, callerScript: COMMITTED_SCRIPT, scenarioId: "family-bookings" };
async function preapprovalBoot() {
  const h = await boot();
  h.env.OPERATOR_TEST_PREAPPROVAL_ENABLED = "true";
  h.clock.at = new Date("2026-10-24T19:00:00Z"); // Saturday noon PDT
  return h;
}

describe("standing operator-test pre-approval HTTP flow", () => {
  it("auto-approves without granting approve and preserves owner-only confirmation, commit and durable transcripts", async () => {
    const h = await preapprovalBoot();
    const scopes = ["fleet:read", "contacts:prepare", "contacts:commit", "calls:direct", "operator:call"];
    const bot = h.store.mint(scopes);
    expect(mintScopesCompatible(bot.scopes).ok).toBe(true);
    expect(mintScopesCompatible([...bot.scopes, "contacts:approve"]).ok).toBe(false);
    const prep = await h.request("/prepare_operator_call", TEST_INPUT, bot);
    expect(prep).toMatchObject({ status: 201, body: { status: "auto_approved", approval: {
      status: "approved", autoApproved: true, approvedBy: "test-preapproval-rule", scenarioId: "family-bookings", maskedNumber: "***5435",
      approvalReason: "committed-scenario-test",
    } } });
    expect(h.sender.createCall).not.toHaveBeenCalled();
    const id = prep.body.approval.id;
    const row = (await h.store.getApproval(id))!;
    expect(row).toMatchObject({ approvedBy: "test-preapproval-rule", preapprovalRule: {
      scenarioId: "family-bookings", fromNumber: h.env.OPERATOR_LINE_FROM_NUMBER, reason: "committed-scenario-test",
    } });
    expect(row.confirmTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.confirmExpiresAt!.getTime() - h.clock.at.getTime()).toBe(CONFIRM_TTL_MS);
    for (const secret of [PHONE, COMMITTED_SCRIPT.trim(), bot.plaintext, row.confirmTokenPlaintext!]) {
      expect(JSON.stringify(prep.body)).not.toContain(secret);
    }
    expect((await h.request(`/approvals/${id}/approve`, { payloadHash: row.payloadHash }, bot)).status).toBe(403);
    expect((await h.request(`/contact_requests/${id}/confirm_token`)).status).toBe(404);
    const handoff = await h.request(`/contact_requests/${id}/confirm_token`, undefined, bot);
    expect(handoff.status).toBe(200);
    expect((await h.request(`/contact_requests/${id}/confirm_token`, undefined, bot)).status).toBe(409);
    const live = await h.request("/commit_call_live", { confirmToken: handoff.body.confirmToken }, bot);
    expect(live.status).toBe(200);
    expect((await h.request("/commit_call_live", { confirmToken: handoff.body.confirmToken }, bot)).status).toBe(409);
    expect(h.sender.createCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: PHONE, from: h.env.OPERATOR_LINE_FROM_NUMBER, timeLimit: 600 }));
    const turns = [{ role: "agent" as const, text: "Synthetic test complete", atMs: h.clock.at.getTime() }];
    h.sessions.finishTranscript(live.body.callSid, turns);
    await h.sessions.get(live.body.sessionId)!.persistence;
    h.sessions.clear();
    const transcript = await h.request(`/calls/${live.body.sessionId}/transcript`, undefined, bot);
    expect(transcript).toMatchObject({ status: 200, body: { transcript: [{ role: "agent", text: turns[0].text }] } });
    expect((await h.store.getApproval(id))!.preapprovalRule).toEqual(row.preapprovalRule);
    const audit = await h.store.listAudit();
    expect(audit).toContainEqual(expect.objectContaining({ tool: "prepare_operator_call", outcome: "approved", approvalId: id }));
    for (const secret of [PHONE, INPUT.purpose, COMMITTED_SCRIPT.trim(), bot.plaintext, handoff.body.confirmToken, turns[0].text]) {
      expect(JSON.stringify(audit)).not.toContain(secret);
    }
    expect((await h.store.findToken(bot.jti))!.scopes).toEqual(scopes);
    expect(bot.scopes).not.toContain("contacts:approve");
  });

  it.each(["disabled", "free-text", "wrong-scenario", "non-allowlisted", "peak", "cap"])("keeps %s requests pending for normal human approval", async (condition) => {
    const h = await preapprovalBoot(); let input = { ...TEST_INPUT };
    if (condition === "disabled") delete h.env.OPERATOR_TEST_PREAPPROVAL_ENABLED;
    if (condition === "free-text") input.callerScript = INPUT.callerScript;
    if (condition === "wrong-scenario") input.scenarioId = "spanish";
    if (condition === "non-allowlisted") input.phone = "+15555550123";
    if (condition === "peak") h.clock.at = new Date("2026-10-23T19:00:00Z");
    if (condition === "cap") {
      h.env.OPERATOR_TEST_MAX_AUTO_APPROVALS = "1";
      expect((await h.request("/prepare_operator_call", TEST_INPUT)).body.status).toBe("auto_approved");
    }
    const prep = await h.request("/prepare_operator_call", input);
    expect(prep).toMatchObject({ status: 201, body: { status: "pending_approval", approval: { status: "pending" } } });
    expect(prep.body.approval).not.toHaveProperty("autoApproved");
    const row = (await h.store.getApproval(prep.body.approval.id))!;
    expect(row.approvedBy).toBeNull();
    expect(row.confirmTokenHash).toBeNull();
    expect((await h.request(`/contact_requests/${row.id}/confirm_token`)).status).toBe(409);
    expect((await h.request(`/approvals/${row.id}/approve`, { payloadHash: row.payloadHash }, h.staff)).status).toBe(200);
    expect((await h.store.getApproval(row.id))!.approvedBy).toBe(h.staff.jti);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("retains the existing 503 with no request when the caller number is unset", async () => {
    const h = await preapprovalBoot(); delete h.env.OPERATOR_LINE_FROM_NUMBER;
    expect((await h.request("/prepare_operator_call", TEST_INPUT)).status).toBe(503);
    expect(h.store.approvals.size).toBe(0);
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it.each(["kill-switch", "peak", "caller-id", "allowlist"])("rechecks %s before consuming an auto-approved confirmation", async (condition) => {
    const h = await preapprovalBoot();
    h.env.OPERATOR_TEST_ALLOWLIST = "+15555550123";
    const prep = await h.request("/prepare_operator_call", { ...TEST_INPUT, phone: "+15555550123" });
    const id = prep.body.approval.id;
    const handoff = await h.request(`/contact_requests/${id}/confirm_token`);
    if (condition === "kill-switch") h.env.OPERATOR_TEST_PREAPPROVAL_ENABLED = "false";
    if (condition === "peak") h.clock.at = new Date("2026-10-26T19:00:00Z");
    if (condition === "caller-id") h.env.OPERATOR_LINE_FROM_NUMBER = "+15555550101";
    if (condition === "allowlist") delete h.env.OPERATOR_TEST_ALLOWLIST;
    expect((await h.request("/commit_call_live", { confirmToken: handoff.body.confirmToken })).status).toBe(503);
    expect((await h.store.getApproval(id))!.confirmUsedAt).toBeNull();
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("retains opt-out and payload hash validation on auto-approved calls", async () => {
    const h = await preapprovalBoot();
    for (const guard of ["hash", "opt-out"]) {
      const prep = await h.request("/prepare_operator_call", TEST_INPUT);
      const id = prep.body.approval.id;
      const handoff = await h.request(`/contact_requests/${id}/confirm_token`);
      if (guard === "hash") h.store.approvals.get(id)!.payload.callerScript = "tampered";
      if (guard === "opt-out") await h.store.setOperatorOptOut(PHONE);
      expect((await h.request("/commit_call_live", { confirmToken: handoff.body.confirmToken })).status).toBe(guard === "hash" ? 503 : 409);
    }
    expect(h.sender.createCall).not.toHaveBeenCalled();
  });

  it("still rejects mixed human/bot tokens and client-supplied rule overrides", async () => {
    const h = await preapprovalBoot();
    for (const token of [h.staff, h.store.mint(["operator:call", "contacts:approve"])]) {
      expect((await h.request("/prepare_operator_call", TEST_INPUT, token)).status).toBe(403);
    }
    for (const field of ["approvedBy", "preapprovalRule", "allowlist", "fromNumber", "autoApproved"]) {
      expect((await h.request("/prepare_operator_call", { ...TEST_INPUT, [field]: "override" })).status).toBe(400);
    }
    expect(h.store.approvals.size).toBe(0);
  });
});
